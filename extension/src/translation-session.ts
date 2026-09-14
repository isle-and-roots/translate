import {
  BROKER_TIMEOUT_MS,
  TRANSCRIPT_MAX_CHARS,
  WEBRTC_READY_TIMEOUT_MS,
  type Direction,
  type TokenIssueResponse,
  targetLanguageFor,
} from "../../shared/protocol.js";
import { appError, assertGeneration, GenerationStaleError } from "../../shared/errors.js";

export interface BrokerClient {
  issue(direction: Direction): Promise<TokenIssueResponse>;
}

export interface TranslationSessionHooks {
  onRemoteTrack: (stream: MediaStream) => void;
  onTranscriptDelta: (delta: string) => void;
  onState: (state: RTCPeerConnectionState) => void;
  onError: (error: ReturnType<typeof appError>) => void;
  onSessionReady: () => void;
}

export interface OpenDirectionArgs {
  direction: Direction;
  inputStream: MediaStream;
  generation: number;
  broker: BrokerClient;
  hooks: TranslationSessionHooks;
  getCurrentGeneration: () => number;
  enableOutput: () => void;
}

export interface TranslationHandle {
  direction: Direction;
  generation: number;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  inputTrack: MediaStreamTrack;
  close: () => void;
}

function appendTranscript(current: string, delta: string): string {
  const next = `${current}${delta}`;
  return next.length > TRANSCRIPT_MAX_CHARS
    ? next.slice(next.length - TRANSCRIPT_MAX_CHARS)
    : next;
}

export function mergeTranscript(current: string, delta: string): string {
  return appendTranscript(current, delta);
}

async function postTranslationSdp(
  clientSecret: string,
  offerSdp: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/translations/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offerSdp,
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw appError(
        "WEBRTC_FAILED",
        `翻訳通話の確立に失敗しました (${response.status})`,
      );
    }
    return await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw appError("BROKER_TIMEOUT", "翻訳SDP交換がタイムアウトしました");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function waitReady(
  pc: RTCPeerConnection,
  dc: RTCDataChannel,
  sessionReady: () => boolean,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const hasRemoteAudio = pc
        .getReceivers()
        .some((r) => r.track && r.track.kind === "audio");
      if (
        pc.connectionState === "connected" &&
        dc.readyState === "open" &&
        sessionReady() &&
        hasRemoteAudio
      ) {
        cleanup();
        resolve();
        return;
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(appError("WEBRTC_FAILED", "WebRTC接続に失敗しました"));
      }
    };

    const onTimeout = () => {
      cleanup();
      reject(
        appError(
          "WEBRTC_TIMEOUT",
          `接続準備が${Math.round(timeoutMs / 1000)}秒以内に完了しませんでした`,
        ),
      );
    };

    const timer = setTimeout(onTimeout, timeoutMs);
    const onState = () => check();
    const onDc = () => check();

    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", onState);
      dc.removeEventListener("open", onDc);
      clearInterval(poll);
    };

    pc.addEventListener("connectionstatechange", onState);
    dc.addEventListener("open", onDc);
    const poll = setInterval(() => {
      if (Date.now() - started > timeoutMs) return;
      check();
    }, 200);
    check();
  });
}

export async function openDirection(
  args: OpenDirectionArgs,
): Promise<TranslationHandle> {
  const {
    direction,
    inputStream,
    generation,
    broker,
    hooks,
    getCurrentGeneration,
    enableOutput,
  } = args;

  const track = inputStream.getAudioTracks()[0];
  if (!track) {
    throw appError("UNKNOWN", "入力音声トラックがありません");
  }
  track.enabled = false;

  const token = await broker.issue(direction);
  assertGeneration(generation, getCurrentGeneration(), `${direction}-token`);

  const expectedLanguage = targetLanguageFor(direction);
  let sessionReady = false;
  let transcript = "";

  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("oai-events");

  const close = () => {
    try {
      track.enabled = false;
    } catch {
      // ignore
    }
    try {
      dc.close();
    } catch {
      // ignore
    }
    try {
      pc.close();
    } catch {
      // ignore
    }
  };

  dc.addEventListener("message", (event) => {
    if (generation !== getCurrentGeneration()) return;
    try {
      const payload = JSON.parse(String(event.data)) as {
        type?: string;
        delta?: string;
        session?: {
          id?: string;
          audio?: { output?: { language?: string } };
        };
        error?: { type?: string; code?: string; message?: string };
      };

      if (payload.type === "session.created" || payload.type === "session.updated") {
        const language = payload.session?.audio?.output?.language;
        if (language && language !== expectedLanguage) {
          hooks.onError(
            appError(
              "SESSION_MISMATCH",
              `出力言語が想定と異なります (${language})`,
            ),
          );
          close();
          return;
        }
        if (payload.type === "session.created") {
          sessionReady = true;
          hooks.onSessionReady();
        }
        return;
      }

      if (payload.type === "session.output_transcript.delta" && payload.delta) {
        transcript = appendTranscript(transcript, payload.delta);
        hooks.onTranscriptDelta(payload.delta);
        return;
      }

      if (payload.type === "error") {
        hooks.onError(
          appError(
            "WEBRTC_FAILED",
            payload.error?.message ?? "翻訳セッションエラー",
            payload.error?.code,
          ),
        );
        if (direction === "tx") {
          // TX: close output on any serious unknown error
        }
      }
    } catch {
      // ignore malformed events
    }
  });

  pc.ontrack = (event) => {
    if (generation !== getCurrentGeneration()) return;
    const stream =
      event.streams[0] ?? (event.track ? new MediaStream([event.track]) : null);
    if (!stream) return;
    hooks.onRemoteTrack(stream);
  };

  pc.onconnectionstatechange = () => {
    if (generation !== getCurrentGeneration()) return;
    hooks.onState(pc.connectionState);
  };

  pc.addTrack(track, inputStream);

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    assertGeneration(generation, getCurrentGeneration(), `${direction}-offer`);

    const answerSdp = await postTranslationSdp(
      token.clientSecret,
      pc.localDescription?.sdp ?? offer.sdp ?? "",
    );
    assertGeneration(generation, getCurrentGeneration(), `${direction}-answer`);

    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await waitReady(pc, dc, () => sessionReady, WEBRTC_READY_TIMEOUT_MS);
    assertGeneration(generation, getCurrentGeneration(), `${direction}-ready`);

    // Output device must already be verified by MeetingController before enable.
    track.enabled = true;
    enableOutput();

    return { direction, generation, pc, dc, inputTrack: track, close };
  } catch (error) {
    close();
    if (error instanceof GenerationStaleError) {
      throw error;
    }
    throw error;
  } finally {
    token.clientSecret = "";
  }
}

export type { TranslationHandle as DirectionHandle };
