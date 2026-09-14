import {
  BUDGET_STOP_USD,
  BUDGET_WARN_USD,
  createIdleSnapshot,
  estimateCostUsd,
  IDLE_STOP_MS,
  IDLE_WARN_MS,
  SESSION_RENEW_STOP_MS,
  SESSION_RENEW_WARN_MS,
  validateRouting,
  type AppError,
  type CaptureSource,
  type DirectionState,
  type LocalSettings,
  type MeetingSnapshot,
  type MeetingState,
} from "../../shared/protocol.js";
import { platformLabel } from "../../shared/platform.js";
import { appError, toAppError } from "../../shared/errors.js";
import {
  acquireDeviceLoopback,
  acquirePhysicalMic,
  acquireTabStream,
  AudioRouter,
  cloneAudioTrack,
  stopStream,
  type LostDeviceKind,
} from "./audio-router.js";
import { createBrokerClient } from "./broker-client.js";
import {
  mergeTranscript,
  openDirection,
  type TranslationHandle,
} from "./translation-session.js";

export type StateListener = (state: MeetingSnapshot) => void;

export interface MeetingControllerDeps {
  getSettings: () => Promise<LocalSettings>;
  getPairingToken: () => Promise<string | null>;
  requestTabStreamId: (tabId: number) => Promise<string>;
  onState: StateListener;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MeetingController {
  private readonly audio = new AudioRouter();
  private readonly onState: StateListener;
  private readonly getSettings: MeetingControllerDeps["getSettings"];
  private readonly getPairingToken: MeetingControllerDeps["getPairingToken"];
  private readonly requestTabStreamId: MeetingControllerDeps["requestTabStreamId"];

  private snapshot = createIdleSnapshot();
  private settings: LocalSettings | null = null;
  /** Remote-party audio: tab capture (Meet / Zoom web) or virtual-device loopback (Zoom app). */
  private remoteStream: MediaStream | null = null;
  private rxSendStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private rxHandle: TranslationHandle | null = null;
  private txHandle: TranslationHandle | null = null;
  private stopRequested = false;
  private tickTimer: number | null = null;
  private lastActivityMs = Date.now();
  private meetingWallStartedAt: number | null = null;
  private cumulativeRxMs = 0;
  private cumulativeTxMs = 0;
  private rxSegmentStartedAt: number | null = null;
  private txSegmentStartedAt: number | null = null;
  private rxRetryCount = 0;
  private closingPromise: Promise<void> | null = null;

  constructor(deps: MeetingControllerDeps) {
    this.getSettings = deps.getSettings;
    this.getPairingToken = deps.getPairingToken;
    this.requestTabStreamId = deps.requestTabStreamId;
    this.onState = deps.onState;

    this.audio.setLevelListener(({ tabDbFs, micDbFs }) => {
      this.snapshot.rx.levelDbFs = tabDbFs;
      this.snapshot.tx.levelDbFs = micDbFs;
      const active =
        (tabDbFs !== null && tabDbFs > -50) ||
        (micDbFs !== null && micDbFs > -50);
      if (active) {
        this.lastActivityMs = Date.now();
        this.snapshot.idleWarned = false;
      }
      this.emit();
    });

    this.audio.setDeviceLostHandler((kind) => {
      void this.handleDeviceLost(kind);
    });
  }

  getSnapshot(): MeetingSnapshot {
    return structuredClone(this.snapshot);
  }

  async startRx(source: CaptureSource): Promise<MeetingSnapshot> {
    if (this.snapshot.meetingState !== "IDLE") {
      throw appError("ALREADY_RUNNING", "すでに会議セッションが動作中です");
    }

    const captureMode = source.kind;
    this.stopRequested = false;
    this.setMeetingState("PREFLIGHT");
    this.snapshot.platform = source.platform;
    this.snapshot.captureMode = captureMode;
    this.snapshot.tabId = source.kind === "tab" ? source.tabId : null;
    this.snapshot.tabTitle = source.kind === "tab" ? source.tabTitle : null;
    this.snapshot.lastError = null;
    this.snapshot.message = "準備中…";
    this.emit();

    try {
      const settings = await this.getSettings();
      const routingError = validateRouting(settings, captureMode);
      if (routingError) throw routingError;
      this.settings = settings;
      this.snapshot.originalGain = settings.originalGain;
      this.snapshot.translationGain = settings.translationGain;
      const usesRemoteDevice = captureMode === "device";
      this.snapshot.devices = {
        physicalMicId: settings.physicalMicId,
        headphoneOutputId: settings.headphoneOutputId,
        virtualOutputId: settings.virtualOutputId,
        remoteCaptureInputId: usesRemoteDevice ? settings.remoteCaptureInputId : null,
        physicalMicLabel: settings.deviceLabels.physicalMic ?? null,
        headphoneOutputLabel: settings.deviceLabels.headphoneOutput ?? null,
        virtualOutputLabel: settings.deviceLabels.virtualOutput ?? null,
        remoteCaptureInputLabel: usesRemoteDevice
          ? (settings.deviceLabels.remoteCaptureInput ?? null)
          : null,
        sinkReadyRx: false,
        sinkReadyTx: false,
      };

      const pairing = await this.getPairingToken();
      if (!pairing) {
        throw appError("MISSING_PAIRING", "接続コードが未設定です");
      }

      await this.audio.initialize({
        headphoneOutputId: settings.headphoneOutputId,
        virtualOutputId: settings.virtualOutputId,
        originalGain: settings.originalGain,
        translationGain: settings.translationGain,
      });
      this.audio.setPhysicalMicId(settings.physicalMicId);
      this.audio.setRemoteCaptureInputId(
        usesRemoteDevice ? settings.remoteCaptureInputId : "",
      );
      const sinks = await this.audio.verifySinks();
      this.snapshot.devices.sinkReadyRx = sinks.rx;
      this.snapshot.devices.sinkReadyTx = sinks.tx;
      if (!sinks.rx) {
        throw appError("SINK_FAILED", "イヤホン出力の確認に失敗しました");
      }

      this.setMeetingState("CAPTURING");
      this.snapshot.message =
        source.kind === "tab"
          ? `${platformLabel(source.platform)}のタブ音声を取得中…`
          : "Zoomアプリの音声（仮想デバイス）を取得中…";
      this.emit();

      if (source.kind === "tab") {
        const streamId = await this.requestTabStreamId(source.tabId);
        this.remoteStream = await acquireTabStream(streamId);
      } else {
        this.remoteStream = await acquireDeviceLoopback(
          settings.remoteCaptureInputId,
        );
      }
      this.rxSendStream = cloneAudioTrack(this.remoteStream);
      this.audio.attachTabMonitor(this.remoteStream);

      this.meetingWallStartedAt = Date.now();
      this.snapshot.meetingStartedAtMs = this.meetingWallStartedAt;
      this.lastActivityMs = Date.now();
      this.startTicker();

      this.setMeetingState("CONNECTING_RX");
      this.snapshot.message = "相手音声の日本語訳を接続中…";
      this.emit();

      await this.connectRx();
      this.setMeetingState("ACTIVE_RX");
      this.snapshot.message = "受信OK。続けて自分の声の英訳送信を開始します…";
      this.emit();

      // UX: one-click start enables both directions immediately.
      try {
        await this.enableTx();
        this.snapshot.message = `双方向通訳中。相手の英語→日本語、自分の声→英語で${platformLabel(source.platform)}へ。`;
        this.emit();
      } catch (txError) {
        // Keep RX so the user can at least listen; TX emergency button retries.
        this.snapshot.tx.lastError = toAppError(txError);
        this.snapshot.message =
          "受信は開始済み。送信の開始に失敗したので「送信を再開（緊急）」から再試行できます。";
        this.composeMeetingState();
        this.emit();
      }
      return this.getSnapshot();
    } catch (error) {
      const appErr = toAppError(error);
      this.snapshot.lastError = appErr;
      await this.stopAllInternal("開始に失敗したため停止しました");
      throw appErr;
    }
  }

  async enableTx(): Promise<MeetingSnapshot> {
    if (
      this.snapshot.meetingState !== "ACTIVE_RX" &&
      this.snapshot.meetingState !== "DEGRADED"
    ) {
      throw appError("UNKNOWN", "受信が有効な状態でのみ送信を開始できます");
    }
    if (this.snapshot.tx.state === "active" || this.snapshot.tx.state === "connecting") {
      return this.getSnapshot();
    }
    if (!this.settings) {
      throw appError("MISSING_SETTINGS", "設定がありません");
    }

    this.setMeetingState("CONNECTING_TX");
    this.setDirection("tx", "connecting");
    this.snapshot.message = "準備中、まだ話さないでください";
    this.snapshot.tx.lastError = null;
    this.emit();

    try {
      const sinks = await this.audio.verifySinks();
      this.snapshot.devices.sinkReadyTx = sinks.tx;
      if (!sinks.tx) {
        throw appError(
          "SINK_FAILED",
          "BlackHole出力を確認できません。既定出力への代替はしません。",
        );
      }

      this.micStream = await acquirePhysicalMic(this.settings.physicalMicId);
      this.audio.attachMicMeter(this.micStream);
      this.audio.setPhysicalMicId(this.settings.physicalMicId);

      const generation = this.snapshot.tx.generation + 1;
      this.snapshot.tx.generation = generation;

      const broker = createBrokerClient({
        baseUrl: this.settings.brokerBaseUrl,
        getPairingToken: this.getPairingToken,
      });

      this.txHandle = await openDirection({
        direction: "tx",
        inputStream: this.micStream,
        generation,
        broker,
        getCurrentGeneration: () => this.snapshot.tx.generation,
        enableOutput: () => {
          // Gate stays closed until explicit open after ready.
        },
        hooks: {
          onRemoteTrack: (stream) => {
            this.audio.attachTxRemote(stream);
          },
          onTranscriptDelta: (delta) => {
            this.snapshot.tx.transcriptTail = mergeTranscript(
              this.snapshot.tx.transcriptTail,
              delta,
            );
            this.emit();
          },
          onState: (state) => {
            void this.handlePeerState("tx", state);
          },
          onError: (error) => {
            this.snapshot.tx.lastError = error;
            void this.disableTx("翻訳エラーのため送信を停止しました");
          },
          onSessionReady: () => {
            // readiness tracked inside openDirection
          },
        },
      });

      // Only open gate after connection is ready (openDirection already waited).
      this.audio.openTxGate();
      this.setDirection("tx", "active");
      this.txSegmentStartedAt = Date.now();
      this.snapshot.tx.connectedAtMs = this.txSegmentStartedAt;
      this.setMeetingState("ACTIVE_BOTH");
      this.snapshot.message =
        "双方向通訳中。相手には英訳だけが届きます（緊急時は送信だけ停止可）。";
      this.emit();
      return this.getSnapshot();
    } catch (error) {
      const appErr = toAppError(error);
      this.snapshot.tx.lastError = appErr;
      await this.disableTxInternal();
      this.composeMeetingState();
      this.snapshot.message = "送信の開始に失敗しました";
      this.emit();
      throw appErr;
    }
  }

  async disableTx(message = "送信だけ停止しました（受信は継続）"): Promise<MeetingSnapshot> {
    await this.disableTxInternal();
    this.composeMeetingState();
    this.snapshot.message = message;
    this.emit();
    return this.getSnapshot();
  }

  async disableRx(): Promise<MeetingSnapshot> {
    await this.teardownRx(false);
    // Keep tab monitor if still capturing
    this.composeMeetingState();
    this.snapshot.message = "受信翻訳を停止しました。原音モニターは継続します。";
    this.emit();
    return this.getSnapshot();
  }

  async setGains(original: number, translation: number): Promise<MeetingSnapshot> {
    this.audio.setGains(original, translation);
    const gains = this.audio.getGains();
    this.snapshot.originalGain = gains.original;
    this.snapshot.translationGain = gains.translation;
    this.emit();
    return this.getSnapshot();
  }

  async listenOriginal(enabled: boolean): Promise<MeetingSnapshot> {
    this.audio.setListeningOriginalOnly(enabled);
    this.snapshot.listeningOriginalOnly = enabled;
    this.snapshot.message = enabled
      ? "原音を聞くモードです"
      : "通常の原音/訳音バランスに戻しました";
    this.emit();
    return this.getSnapshot();
  }

  async renewSessions(): Promise<MeetingSnapshot> {
    if (this.snapshot.meetingState === "IDLE") {
      throw appError("UNKNOWN", "動作中のセッションがありません");
    }
    const wantTx = this.snapshot.tx.state === "active";
    this.snapshot.message = "セッションを更新しています…";
    this.emit();

    await this.teardownRx(false);
    await this.disableTxInternal();

    this.snapshot.renewWarn = false;
    this.snapshot.renewRequired = false;
    await this.connectRx();
    if (wantTx) {
      try {
        await this.enableTx();
        this.snapshot.message = "双方向セッションを更新しました";
      } catch {
        this.snapshot.message =
          "受信を更新しました。送信は「送信を再開（緊急）」から再有効化してください。";
      }
    } else {
      this.snapshot.message = "受信セッションを更新しました";
    }
    this.composeMeetingState();
    this.emit();
    return this.getSnapshot();
  }

  async stopAll(message = "すべて停止しました"): Promise<MeetingSnapshot> {
    await this.stopAllInternal(message);
    return this.getSnapshot();
  }

  private async stopAllInternal(message: string): Promise<void> {
    if (this.closingPromise) {
      await this.closingPromise;
      return;
    }
    this.closingPromise = (async () => {
      this.stopRequested = true;
      this.setMeetingState("STOPPING");
      this.snapshot.message = "停止処理中…";
      this.emit();

      this.audio.closeTxGate();
      this.audio.closeRxTranslation();

      // Bump generations to invalidate in-flight work
      this.snapshot.rx.generation += 1;
      this.snapshot.tx.generation += 1;

      this.rxHandle?.close();
      this.txHandle?.close();
      this.rxHandle = null;
      this.txHandle = null;

      this.audio.detachRxRemote();
      this.audio.detachTxRemote();
      this.audio.detachMicMeter();
      this.audio.detachTabMonitor();

      stopStream(this.micStream);
      stopStream(this.rxSendStream);
      stopStream(this.remoteStream);
      this.micStream = null;
      this.rxSendStream = null;
      this.remoteStream = null;

      await this.audio.dispose();
      this.stopTicker();
      this.finalizeBilling();

      const preservedCost = this.snapshot.cost;
      const preservedElapsed = this.meetingWallStartedAt
        ? Date.now() - this.meetingWallStartedAt
        : this.snapshot.elapsedMs;

      this.snapshot = createIdleSnapshot();
      this.snapshot.cost = preservedCost;
      this.snapshot.elapsedMs = preservedElapsed;
      this.snapshot.message = message;
      this.meetingWallStartedAt = null;
      this.rxSegmentStartedAt = null;
      this.txSegmentStartedAt = null;
      this.settings = null;
      this.rxRetryCount = 0;
      this.emit();
    })();

    try {
      await this.closingPromise;
    } finally {
      this.closingPromise = null;
    }
  }

  private async connectRx(): Promise<void> {
    if (!this.settings || !this.rxSendStream) {
      throw appError("UNKNOWN", "受信接続の前提が不足しています");
    }

    this.setDirection("rx", "connecting");
    this.snapshot.rx.lastError = null;
    this.snapshot.rx.transcriptTail = "";
    const generation = this.snapshot.rx.generation + 1;
    this.snapshot.rx.generation = generation;
    this.emit();

    const broker = createBrokerClient({
      baseUrl: this.settings.brokerBaseUrl,
      getPairingToken: this.getPairingToken,
    });

    this.rxHandle = await openDirection({
      direction: "rx",
      inputStream: this.rxSendStream,
      generation,
      broker,
      getCurrentGeneration: () => this.snapshot.rx.generation,
      enableOutput: () => {
        this.audio.openRxTranslation();
      },
      hooks: {
        onRemoteTrack: (stream) => {
          this.audio.attachRxRemote(stream);
        },
        onTranscriptDelta: (delta) => {
          this.snapshot.rx.transcriptTail = mergeTranscript(
            this.snapshot.rx.transcriptTail,
            delta,
          );
          this.emit();
        },
        onState: (state) => {
          void this.handlePeerState("rx", state);
        },
        onError: (error) => {
          this.snapshot.rx.lastError = error;
          this.audio.closeRxTranslation();
          this.setDirection("rx", "error");
          this.composeMeetingState();
          this.snapshot.message = "原音を聞くモードへ切り替えてください";
          this.emit();
        },
        onSessionReady: () => undefined,
      },
    });

    this.setDirection("rx", "active");
    this.rxSegmentStartedAt = Date.now();
    this.snapshot.rx.connectedAtMs = this.rxSegmentStartedAt;
    this.rxRetryCount = 0;
    this.composeMeetingState();
    this.emit();
  }

  private async teardownRx(keepMonitor: boolean): Promise<void> {
    this.snapshot.rx.generation += 1;
    this.audio.closeRxTranslation();
    this.audio.detachRxRemote();
    this.rxHandle?.close();
    this.rxHandle = null;
    if (this.rxSegmentStartedAt) {
      this.cumulativeRxMs += Date.now() - this.rxSegmentStartedAt;
      this.rxSegmentStartedAt = null;
    }
    this.snapshot.rx.connectedAtMs = null;
    this.snapshot.rx.billedMs = this.cumulativeRxMs;
    this.snapshot.rx.transcriptTail = "";
    this.setDirection("rx", "off");
    if (!keepMonitor) {
      // monitor remains attached by default
    }
    this.updateCost();
  }

  private async disableTxInternal(): Promise<void> {
    // Close output first to discard unplayed translation audio
    this.audio.closeTxGate();
    this.snapshot.tx.generation += 1;
    this.audio.detachTxRemote();
    this.txHandle?.close();
    this.txHandle = null;
    this.audio.detachMicMeter();
    stopStream(this.micStream);
    this.micStream = null;
    if (this.txSegmentStartedAt) {
      this.cumulativeTxMs += Date.now() - this.txSegmentStartedAt;
      this.txSegmentStartedAt = null;
    }
    this.snapshot.tx.connectedAtMs = null;
    this.snapshot.tx.billedMs = this.cumulativeTxMs;
    this.snapshot.tx.transcriptTail = "";
    this.setDirection("tx", "off");
    this.updateCost();
  }

  private async handlePeerState(
    direction: "rx" | "tx",
    state: RTCPeerConnectionState,
  ): Promise<void> {
    if (this.stopRequested) return;

    if (direction === "tx") {
      if (state === "failed" || state === "disconnected" || state === "closed") {
        await this.disableTx("送信接続が切れたため停止しました。手動で再開してください。");
      }
      return;
    }

    // RX recovery rules
    if (state === "disconnected") {
      this.setDirection("rx", "reconnecting");
      this.composeMeetingState();
      this.snapshot.message = "受信接続が一時切断。原音は継続します。";
      this.emit();
      await sleep(3000);
      if (this.stopRequested) return;
      if (this.rxHandle?.pc.connectionState === "connected") {
        this.setDirection("rx", "active");
        this.composeMeetingState();
        this.emit();
        return;
      }
      await this.recoverRx();
      return;
    }

    if (state === "failed") {
      await this.recoverRx();
    }
  }

  private async recoverRx(): Promise<void> {
    if (this.stopRequested) return;
    if (this.rxRetryCount >= 3) {
      this.setDirection("rx", "error");
      this.snapshot.rx.lastError = appError(
        "WEBRTC_FAILED",
        "受信の自動復旧に失敗しました。手動で再開してください。",
      );
      this.composeMeetingState();
      this.snapshot.message = "原音を聞く / 手動復旧待ち";
      this.emit();
      return;
    }

    const delays = [1000, 2000, 4000];
    const delay = delays[this.rxRetryCount] ?? 4000;
    const jitter = Math.floor(Math.random() * 250);
    this.rxRetryCount += 1;
    this.setDirection("rx", "reconnecting");
    this.composeMeetingState();
    this.snapshot.message = `受信を再接続しています (${this.rxRetryCount}/3)…`;
    this.emit();

    await this.teardownRx(true);
    await sleep(delay + jitter);
    if (this.stopRequested) return;

    try {
      // Recreate send stream clone if needed
      if (!this.rxSendStream && this.remoteStream) {
        this.rxSendStream = cloneAudioTrack(this.remoteStream);
      }
      await this.connectRx();
      this.snapshot.message = "受信を復旧しました";
      this.emit();
    } catch (error) {
      this.snapshot.rx.lastError = toAppError(error);
      await this.recoverRx();
    }
  }

  private async handleDeviceLost(kind: LostDeviceKind): Promise<void> {
    if (this.stopRequested || this.snapshot.meetingState === "IDLE") return;
    if (kind === "headphone") {
      await this.stopAllInternal(
        "イヤホンが切断されたため、ループ回避のため全停止しました",
      );
      return;
    }
    if (kind === "remote") {
      await this.stopAllInternal(
        "Zoomアプリの会議音声入力（仮想デバイス）が消失したため全停止しました",
      );
      return;
    }
    if (kind === "virtual") {
      await this.disableTx(
        "BlackHoleが消失したため送信を停止しました。自動代替はしません。",
      );
      return;
    }
    await this.disableTx(
      "物理マイクが消失したため送信を停止しました。既定入力への代替はしません。",
    );
  }

  private setMeetingState(state: MeetingState): void {
    this.snapshot.meetingState = state;
  }

  private setDirection(direction: "rx" | "tx", state: DirectionState): void {
    this.snapshot[direction].state = state;
  }

  private composeMeetingState(): void {
    if (this.stopRequested && this.snapshot.meetingState === "STOPPING") return;
    const rx = this.snapshot.rx.state;
    const tx = this.snapshot.tx.state;
    if (rx === "error" || tx === "error" || rx === "reconnecting") {
      this.setMeetingState("DEGRADED");
      return;
    }
    if (rx === "active" && tx === "active") {
      this.setMeetingState("ACTIVE_BOTH");
      return;
    }
    if (rx === "active") {
      this.setMeetingState("ACTIVE_RX");
      return;
    }
    if (rx === "connecting" || tx === "connecting") {
      this.setMeetingState(tx === "connecting" ? "CONNECTING_TX" : "CONNECTING_RX");
      return;
    }
    if (this.remoteStream) {
      this.setMeetingState("CAPTURING");
      return;
    }
    this.setMeetingState("IDLE");
  }

  private finalizeBilling(): void {
    if (this.rxSegmentStartedAt) {
      this.cumulativeRxMs += Date.now() - this.rxSegmentStartedAt;
      this.rxSegmentStartedAt = null;
    }
    if (this.txSegmentStartedAt) {
      this.cumulativeTxMs += Date.now() - this.txSegmentStartedAt;
      this.txSegmentStartedAt = null;
    }
    this.snapshot.rx.billedMs = this.cumulativeRxMs;
    this.snapshot.tx.billedMs = this.cumulativeTxMs;
    this.updateCost();
  }

  private updateCost(): void {
    const rxMs =
      this.cumulativeRxMs +
      (this.rxSegmentStartedAt ? Date.now() - this.rxSegmentStartedAt : 0);
    const txMs =
      this.cumulativeTxMs +
      (this.txSegmentStartedAt ? Date.now() - this.txSegmentStartedAt : 0);
    this.snapshot.rx.billedMs = rxMs;
    this.snapshot.tx.billedMs = txMs;
    const estimated = estimateCostUsd(rxMs, txMs);
    this.snapshot.cost.estimatedUsd = estimated;
    this.snapshot.cost.warnUsd = BUDGET_WARN_USD;
    this.snapshot.cost.stopUsd = BUDGET_STOP_USD;
    if (estimated >= BUDGET_WARN_USD) {
      this.snapshot.cost.budgetWarned = true;
    }
    if (estimated >= BUDGET_STOP_USD && !this.snapshot.cost.budgetStopped) {
      this.snapshot.cost.budgetStopped = true;
      void this.stopAllInternal(
        `概算費用が$${BUDGET_STOP_USD}に達したため停止しました（請求確定値ではありません）`,
      );
    }
  }

  private startTicker(): void {
    this.stopTicker();
    const tick = () => {
      if (this.meetingWallStartedAt) {
        this.snapshot.elapsedMs = Date.now() - this.meetingWallStartedAt;
        if (this.snapshot.elapsedMs >= SESSION_RENEW_WARN_MS) {
          this.snapshot.renewWarn = true;
        }
        if (this.snapshot.elapsedMs >= SESSION_RENEW_STOP_MS) {
          this.snapshot.renewRequired = true;
          void this.stopAllInternal(
            "暫定50分上限のため計画停止しました。切れ目で再開してください。",
          );
          return;
        }
      }
      const idleFor = Date.now() - this.lastActivityMs;
      if (idleFor >= IDLE_WARN_MS) {
        this.snapshot.idleWarned = true;
      }
      if (idleFor >= IDLE_STOP_MS) {
        void this.stopAllInternal("無活動が続いたため停止しました");
        return;
      }
      this.updateCost();
      this.emit();
      this.tickTimer = window.setTimeout(tick, 1000) as unknown as number;
    };
    tick();
  }

  private stopTicker(): void {
    if (this.tickTimer !== null) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private emit(): void {
    this.snapshot.version += 1;
    this.onState(this.getSnapshot());
  }
}