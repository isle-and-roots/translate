import {
  clampGain,
  DEFAULT_ORIGINAL_GAIN,
  DEFAULT_TRANSLATION_GAIN,
} from "../../shared/protocol.js";
import { appError } from "../../shared/errors.js";

type AudioContextWithSinkId = AudioContext & {
  setSinkId(deviceId: string): Promise<void>;
};

export type LevelListener = (levels: {
  tabDbFs: number | null;
  micDbFs: number | null;
}) => void;

export interface AudioRouterSettings {
  headphoneOutputId: string;
  virtualOutputId: string;
  originalGain?: number;
  translationGain?: number;
}

type ChromeMediaTrackConstraints = MediaTrackConstraints & {
  mandatory?: {
    chromeMediaSource: string;
    chromeMediaSourceId: string;
  };
};

function createLimiter(context: AudioContext): DynamicsCompressorNode {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.05;
  return limiter;
}

function rampGain(
  context: AudioContext,
  param: AudioParam,
  value: number,
  ms = 15,
): void {
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(clampGain(value), now + ms / 1000);
}

function dbFromRms(rms: number): number {
  if (rms <= 1e-8) return -100;
  return 20 * Math.log10(rms);
}

export class AudioRouter {
  private rxContext: AudioContextWithSinkId | null = null;
  private txContext: AudioContextWithSinkId | null = null;
  private originalGain: GainNode | null = null;
  private translationGain: GainNode | null = null;
  private txGate: GainNode | null = null;
  private txGain: GainNode | null = null;
  private tabSource: MediaStreamAudioSourceNode | null = null;
  private rxRemoteSource: MediaStreamAudioSourceNode | null = null;
  private txRemoteSource: MediaStreamAudioSourceNode | null = null;
  private tabAnalyser: AnalyserNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private meterTimer: number | null = null;
  private levelListener: LevelListener | null = null;
  private savedOriginal = DEFAULT_ORIGINAL_GAIN;
  private savedTranslation = DEFAULT_TRANSLATION_GAIN;
  private listeningOriginalOnly = false;
  private deviceChangeHandler: (() => void) | null = null;
  private onDeviceLost:
    | ((kind: "headphone" | "virtual" | "mic") => void)
    | null = null;
  private headphoneOutputId = "";
  private virtualOutputId = "";
  private physicalMicId = "";

  async initialize(settings: AudioRouterSettings): Promise<void> {
    await this.dispose();

    this.headphoneOutputId = settings.headphoneOutputId;
    this.virtualOutputId = settings.virtualOutputId;
    this.savedOriginal = clampGain(
      settings.originalGain ?? DEFAULT_ORIGINAL_GAIN,
    );
    this.savedTranslation = clampGain(
      settings.translationGain ?? DEFAULT_TRANSLATION_GAIN,
    );

    const rxContext = new AudioContext({
      latencyHint: "interactive",
    }) as AudioContextWithSinkId;
    const txContext = new AudioContext({
      latencyHint: "interactive",
    }) as AudioContextWithSinkId;

    if (typeof rxContext.setSinkId !== "function" || typeof txContext.setSinkId !== "function") {
      await rxContext.close();
      await txContext.close();
      throw appError(
        "SINK_UNSUPPORTED",
        "このChromeでは出力デバイス固定(setSinkId)に未対応です。",
      );
    }

    try {
      await rxContext.setSinkId(settings.headphoneOutputId);
      await txContext.setSinkId(settings.virtualOutputId);
    } catch (error) {
      await rxContext.close();
      await txContext.close();
      throw appError(
        "SINK_FAILED",
        "指定したイヤホンまたはBlackHoleへ出力できません。既定出力へは迂回しません。",
        error instanceof Error ? error.message : String(error),
      );
    }

    const originalGain = rxContext.createGain();
    const translationGain = rxContext.createGain();
    const rxLimiter = createLimiter(rxContext);
    const rxSilent = rxContext.createGain();
    rxSilent.gain.value = 0;

    originalGain.gain.value = this.savedOriginal;
    translationGain.gain.value = this.savedTranslation;
    originalGain.connect(rxLimiter);
    translationGain.connect(rxLimiter);
    rxLimiter.connect(rxContext.destination);

    const txGate = txContext.createGain();
    const txGain = txContext.createGain();
    const txLimiter = createLimiter(txContext);
    txGate.gain.value = 0;
    txGain.gain.value = 1;
    txGate.connect(txGain);
    txGain.connect(txLimiter);
    txLimiter.connect(txContext.destination);

    this.rxContext = rxContext;
    this.txContext = txContext;
    this.originalGain = originalGain;
    this.translationGain = translationGain;
    this.txGate = txGate;
    this.txGain = txGain;

    await Promise.all([rxContext.resume(), txContext.resume()]);
    this.watchDevices();
  }

  setLevelListener(listener: LevelListener | null): void {
    this.levelListener = listener;
  }

  setDeviceLostHandler(
    handler: ((kind: "headphone" | "virtual" | "mic") => void) | null,
  ): void {
    this.onDeviceLost = handler;
  }

  setPhysicalMicId(deviceId: string): void {
    this.physicalMicId = deviceId;
  }

  attachTabMonitor(tabStream: MediaStream): void {
    if (!this.rxContext || !this.originalGain) {
      throw appError("UNKNOWN", "AudioRouterが未初期化です");
    }
    this.detachTabMonitor();
    this.tabSource = this.rxContext.createMediaStreamSource(tabStream);
    this.tabAnalyser = this.rxContext.createAnalyser();
    this.tabAnalyser.fftSize = 2048;
    const silent = this.rxContext.createGain();
    silent.gain.value = 0;
    this.tabSource.connect(this.originalGain);
    this.tabSource.connect(this.tabAnalyser);
    this.tabAnalyser.connect(silent);
    silent.connect(this.rxContext.destination);
    this.startMeter();
  }

  detachTabMonitor(): void {
    this.tabSource?.disconnect();
    this.tabAnalyser?.disconnect();
    this.tabSource = null;
    this.tabAnalyser = null;
  }

  attachMicMeter(micStream: MediaStream): void {
    if (!this.txContext) {
      throw appError("UNKNOWN", "AudioRouterが未初期化です");
    }
    this.detachMicMeter();
    this.micSource = this.txContext.createMediaStreamSource(micStream);
    this.micAnalyser = this.txContext.createAnalyser();
    this.micAnalyser.fftSize = 2048;
    const silent = this.txContext.createGain();
    silent.gain.value = 0;
    this.micSource.connect(this.micAnalyser);
    this.micAnalyser.connect(silent);
    silent.connect(this.txContext.destination);
    this.startMeter();
  }

  detachMicMeter(): void {
    this.micSource?.disconnect();
    this.micAnalyser?.disconnect();
    this.micSource = null;
    this.micAnalyser = null;
  }

  attachRxRemote(stream: MediaStream): void {
    if (!this.rxContext || !this.translationGain) {
      throw appError("UNKNOWN", "AudioRouterが未初期化です");
    }
    this.detachRxRemote();
    this.rxRemoteSource = this.rxContext.createMediaStreamSource(stream);
    this.rxRemoteSource.connect(this.translationGain);
  }

  detachRxRemote(): void {
    this.rxRemoteSource?.disconnect();
    this.rxRemoteSource = null;
  }

  attachTxRemote(stream: MediaStream): void {
    if (!this.txContext || !this.txGate) {
      throw appError("UNKNOWN", "AudioRouterが未初期化です");
    }
    this.detachTxRemote();
    this.txRemoteSource = this.txContext.createMediaStreamSource(stream);
    this.txRemoteSource.connect(this.txGate);
  }

  detachTxRemote(): void {
    this.txRemoteSource?.disconnect();
    this.txRemoteSource = null;
  }

  setGains(original: number, translation: number): void {
    this.savedOriginal = clampGain(original);
    this.savedTranslation = clampGain(translation);
    if (!this.listeningOriginalOnly) {
      if (this.originalGain && this.rxContext) {
        rampGain(this.rxContext, this.originalGain.gain, this.savedOriginal);
      }
      if (this.translationGain && this.rxContext) {
        rampGain(
          this.rxContext,
          this.translationGain.gain,
          this.savedTranslation,
        );
      }
    }
  }

  setListeningOriginalOnly(enabled: boolean): void {
    this.listeningOriginalOnly = enabled;
    if (!this.originalGain || !this.translationGain || !this.rxContext) return;
    if (enabled) {
      rampGain(this.rxContext, this.originalGain.gain, 1);
      rampGain(this.rxContext, this.translationGain.gain, 0);
    } else {
      rampGain(this.rxContext, this.originalGain.gain, this.savedOriginal);
      rampGain(
        this.rxContext,
        this.translationGain.gain,
        this.savedTranslation,
      );
    }
  }

  openRxTranslation(): void {
    if (!this.translationGain || !this.rxContext || this.listeningOriginalOnly) {
      return;
    }
    rampGain(this.rxContext, this.translationGain.gain, this.savedTranslation);
  }

  closeRxTranslation(): void {
    if (!this.translationGain || !this.rxContext) return;
    rampGain(this.rxContext, this.translationGain.gain, 0, 10);
  }

  openTxGate(): void {
    if (!this.txGate || !this.txContext) return;
    rampGain(this.txContext, this.txGate.gain, 1, 10);
  }

  closeTxGate(): void {
    if (!this.txGate || !this.txContext) return;
    rampGain(this.txContext, this.txGate.gain, 0, 10);
  }

  getListeningOriginalOnly(): boolean {
    return this.listeningOriginalOnly;
  }

  getGains(): { original: number; translation: number } {
    return {
      original: this.savedOriginal,
      translation: this.savedTranslation,
    };
  }

  async verifySinks(): Promise<{ rx: boolean; tx: boolean }> {
    if (!this.rxContext || !this.txContext) {
      return { rx: false, tx: false };
    }
    try {
      await this.rxContext.setSinkId(this.headphoneOutputId);
      await this.txContext.setSinkId(this.virtualOutputId);
      return { rx: true, tx: true };
    } catch {
      return { rx: false, tx: false };
    }
  }

  async dispose(): Promise<void> {
    this.stopMeter();
    if (this.deviceChangeHandler) {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        this.deviceChangeHandler,
      );
      this.deviceChangeHandler = null;
    }
    this.detachTabMonitor();
    this.detachMicMeter();
    this.detachRxRemote();
    this.detachTxRemote();
    this.originalGain?.disconnect();
    this.translationGain?.disconnect();
    this.txGate?.disconnect();
    this.txGain?.disconnect();
    this.originalGain = null;
    this.translationGain = null;
    this.txGate = null;
    this.txGain = null;
    const closes: Promise<void>[] = [];
    if (this.rxContext) closes.push(this.rxContext.close());
    if (this.txContext) closes.push(this.txContext.close());
    this.rxContext = null;
    this.txContext = null;
    await Promise.allSettled(closes);
  }

  private startMeter(): void {
    if (this.meterTimer !== null) return;
    const tick = () => {
      const tabDbFs = this.readDb(this.tabAnalyser);
      const micDbFs = this.readDb(this.micAnalyser);
      this.levelListener?.({ tabDbFs, micDbFs });
      this.meterTimer = window.setTimeout(tick, 250) as unknown as number;
    };
    tick();
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) {
      clearTimeout(this.meterTimer);
      this.meterTimer = null;
    }
  }

  private readDb(analyser: AnalyserNode | null): number | null {
    if (!analyser) return null;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    return dbFromRms(Math.sqrt(sum / data.length));
  }

  private watchDevices(): void {
    this.deviceChangeHandler = () => {
      void this.checkDevices();
    };
    navigator.mediaDevices.addEventListener(
      "devicechange",
      this.deviceChangeHandler,
    );
  }

  private async checkDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = new Set(
        devices.filter((d) => d.kind === "audiooutput").map((d) => d.deviceId),
      );
      const inputs = new Set(
        devices.filter((d) => d.kind === "audioinput").map((d) => d.deviceId),
      );
      if (this.headphoneOutputId && !outputs.has(this.headphoneOutputId)) {
        this.onDeviceLost?.("headphone");
      } else if (this.virtualOutputId && !outputs.has(this.virtualOutputId)) {
        this.onDeviceLost?.("virtual");
      } else if (this.physicalMicId && !inputs.has(this.physicalMicId)) {
        this.onDeviceLost?.("mic");
      }
    } catch {
      // ignore enumeration failures during teardown
    }
  }
}

export async function acquireTabStream(streamId: string): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as ChromeMediaTrackConstraints,
    video: false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

export async function acquirePhysicalMic(
  deviceId: string,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: { ideal: 1 },
    },
    video: false,
  });
}

export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}

export function cloneAudioTrack(stream: MediaStream): MediaStream {
  const track = stream.getAudioTracks()[0];
  if (!track) {
    throw appError("UNKNOWN", "音声トラックがありません");
  }
  return new MediaStream([track.clone()]);
}
