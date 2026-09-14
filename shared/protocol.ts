/** Shared message, settings, and state contracts for Meet Interpreter V1. */

import {
  isCaptureRequest,
  isCaptureSource,
  type CaptureMode,
  type CaptureRequest,
  type CaptureSource,
  type MeetingPlatform,
} from "./platform.js";

export type {
  CaptureMode,
  CaptureRequest,
  CaptureSource,
  MeetingPlatform,
} from "./platform.js";

export const SCHEMA_VERSION = 1 as const;
export const MODEL_ID = "gpt-realtime-translate" as const;
export const COST_PER_MINUTE_USD = 0.034;
export const BUDGET_WARN_USD = 5;
export const BUDGET_STOP_USD = 10;
export const SESSION_RENEW_WARN_MS = 45 * 60 * 1000;
export const SESSION_RENEW_STOP_MS = 50 * 60 * 1000;
export const IDLE_WARN_MS = 5 * 60 * 1000;
export const IDLE_STOP_MS = 10 * 60 * 1000;
export const DEFAULT_ORIGINAL_GAIN = 0.2;
export const DEFAULT_TRANSLATION_GAIN = 1.0;
export const TRANSCRIPT_MAX_CHARS = 2000;
export const OFFSCREEN_STOP_ACK_MS = 5000;
export const BROKER_TIMEOUT_MS = 10_000;
export const WEBRTC_READY_TIMEOUT_MS = 15_000;

export type Direction = "rx" | "tx";

export type DirectionState =
  | "off"
  | "connecting"
  | "active"
  | "reconnecting"
  | "error";

export type MeetingState =
  | "IDLE"
  | "PREFLIGHT"
  | "CAPTURING"
  | "CONNECTING_RX"
  | "ACTIVE_RX"
  | "CONNECTING_TX"
  | "ACTIVE_BOTH"
  | "DEGRADED"
  | "STOPPING";

export type ErrorCode =
  | "INVALID_MESSAGE"
  | "NOT_MEETING_TAB"
  | "ALREADY_RUNNING"
  | "MISSING_SETTINGS"
  | "ROUTING_CONFLICT"
  | "MISSING_PAIRING"
  | "PERMISSION_DENIED"
  | "DEVICE_MISSING"
  | "SINK_UNSUPPORTED"
  | "SINK_FAILED"
  | "BROKER_UNAUTHORIZED"
  | "BROKER_FORBIDDEN"
  | "BROKER_BAD_REQUEST"
  | "BROKER_RATE_LIMITED"
  | "BROKER_UPSTREAM"
  | "BROKER_TIMEOUT"
  | "BROKER_NETWORK"
  | "SESSION_MISMATCH"
  | "WEBRTC_FAILED"
  | "WEBRTC_TIMEOUT"
  | "TAB_CLOSED"
  | "BUDGET_EXCEEDED"
  | "SESSION_EXPIRED"
  | "GENERATION_STALE"
  | "UNKNOWN";

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: string;
}

export interface DeviceLabels {
  physicalMic?: string;
  headphoneOutput?: string;
  virtualOutput?: string;
  remoteCaptureInput?: string;
}

export interface LocalSettings {
  schemaVersion: typeof SCHEMA_VERSION;
  physicalMicId: string;
  headphoneOutputId: string;
  virtualOutputId: string;
  /**
   * Zoom desktop app only: the virtual *input* (e.g. BlackHole 16ch) that the
   * Zoom app's speaker is routed to. Empty when only tab capture is used.
   */
  remoteCaptureInputId: string;
  originalGain: number;
  translationGain: number;
  deviceLabels: DeviceLabels;
  brokerBaseUrl: string;
}

export interface SessionSecrets {
  pairingToken?: string;
}

export interface DirectionSnapshot {
  state: DirectionState;
  generation: number;
  connectedAtMs: number | null;
  billedMs: number;
  lastError: AppError | null;
  transcriptTail: string;
  levelDbFs: number | null;
}

export interface DeviceSnapshot {
  physicalMicId: string | null;
  headphoneOutputId: string | null;
  virtualOutputId: string | null;
  remoteCaptureInputId: string | null;
  physicalMicLabel: string | null;
  headphoneOutputLabel: string | null;
  virtualOutputLabel: string | null;
  remoteCaptureInputLabel: string | null;
  sinkReadyRx: boolean;
  sinkReadyTx: boolean;
}

export interface CostSnapshot {
  estimatedUsd: number;
  warnUsd: number;
  stopUsd: number;
  budgetWarned: boolean;
  budgetStopped: boolean;
}

export interface MeetingSnapshot {
  version: number;
  meetingState: MeetingState;
  meetingStartedAtMs: number | null;
  elapsedMs: number;
  renewWarn: boolean;
  renewRequired: boolean;
  idleWarned: boolean;
  originalGain: number;
  translationGain: number;
  listeningOriginalOnly: boolean;
  platform: MeetingPlatform | null;
  captureMode: CaptureMode | null;
  tabId: number | null;
  tabTitle: string | null;
  rx: DirectionSnapshot;
  tx: DirectionSnapshot;
  devices: DeviceSnapshot;
  cost: CostSnapshot;
  lastError: AppError | null;
  message: string | null;
}

export type Command =
  | { type: "START_RX"; requestId: string; capture: CaptureRequest }
  | { type: "DISABLE_RX"; requestId: string }
  | { type: "ENABLE_TX"; requestId: string }
  | { type: "DISABLE_TX"; requestId: string }
  | { type: "STOP_ALL"; requestId: string }
  | { type: "RENEW_SESSIONS"; requestId: string }
  | {
      type: "SET_GAINS";
      requestId: string;
      original: number;
      translation: number;
    }
  | { type: "LISTEN_ORIGINAL"; requestId: string; enabled: boolean }
  | { type: "GET_STATE"; requestId: string }
  | { type: "OPEN_SETUP"; requestId: string }
  | { type: "OPEN_CONTROL"; requestId: string }
  | { type: "SAVE_SETTINGS"; requestId: string; settings: LocalSettings }
  | {
      type: "SAVE_PAIRING";
      requestId: string;
      pairingToken: string;
    }
  | { type: "CLEAR_PAIRING"; requestId: string }
  | { type: "GET_SETTINGS"; requestId: string };

export type CommandReply = {
  requestId: string;
  ok: boolean;
  state?: MeetingSnapshot;
  settings?: LocalSettings;
  hasPairing?: boolean;
  error?: AppError;
};

/** Background → offscreen START_RX payload (source already resolved). */
export interface OffscreenStartMessage {
  channel: "offscreen";
  type: "START_RX";
  requestId: string;
  source: CaptureSource;
  settings: LocalSettings;
  hasPairing: boolean;
}

export function isOffscreenStartMessage(
  value: unknown,
): value is OffscreenStartMessage {
  if (!value || typeof value !== "object") return false;
  const maybe = value as {
    channel?: unknown;
    type?: unknown;
    source?: unknown;
    settings?: unknown;
  };
  return (
    maybe.channel === "offscreen" &&
    maybe.type === "START_RX" &&
    isCaptureSource(maybe.source) &&
    Boolean(maybe.settings)
  );
}

export type RuntimeEvent =
  | {
      type: "STATE_CHANGED";
      version: number;
      state: MeetingSnapshot;
    }
  | {
      type: "SETTINGS_CHANGED";
      settings: LocalSettings;
      hasPairing: boolean;
    };

export interface TokenIssueRequest {
  direction: Direction;
}

export interface TokenIssueResponse {
  clientSecret: string;
  expiresAt: string | null;
  direction: Direction;
  targetLanguage: "ja" | "en";
  requestId: string;
}

export function createDefaultSettings(
  brokerBaseUrl = "https://YOUR-BROKER.workers.dev",
): LocalSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    physicalMicId: "",
    headphoneOutputId: "",
    virtualOutputId: "",
    remoteCaptureInputId: "",
    originalGain: DEFAULT_ORIGINAL_GAIN,
    translationGain: DEFAULT_TRANSLATION_GAIN,
    deviceLabels: {},
    brokerBaseUrl,
  };
}

export function createIdleSnapshot(): MeetingSnapshot {
  const direction = (): DirectionSnapshot => ({
    state: "off",
    generation: 0,
    connectedAtMs: null,
    billedMs: 0,
    lastError: null,
    transcriptTail: "",
    levelDbFs: null,
  });

  return {
    version: 0,
    meetingState: "IDLE",
    meetingStartedAtMs: null,
    elapsedMs: 0,
    renewWarn: false,
    renewRequired: false,
    idleWarned: false,
    originalGain: DEFAULT_ORIGINAL_GAIN,
    translationGain: DEFAULT_TRANSLATION_GAIN,
    listeningOriginalOnly: false,
    platform: null,
    captureMode: null,
    tabId: null,
    tabTitle: null,
    rx: direction(),
    tx: direction(),
    devices: {
      physicalMicId: null,
      headphoneOutputId: null,
      virtualOutputId: null,
      remoteCaptureInputId: null,
      physicalMicLabel: null,
      headphoneOutputLabel: null,
      virtualOutputLabel: null,
      remoteCaptureInputLabel: null,
      sinkReadyRx: false,
      sinkReadyTx: false,
    },
    cost: {
      estimatedUsd: 0,
      warnUsd: BUDGET_WARN_USD,
      stopUsd: BUDGET_STOP_USD,
      budgetWarned: false,
      budgetStopped: false,
    },
    lastError: null,
    message: null,
  };
}

export function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { type?: unknown; requestId?: unknown };
  if (typeof maybe.type !== "string" || typeof maybe.requestId !== "string") {
    return false;
  }
  switch (maybe.type) {
    case "START_RX":
      return isCaptureRequest((value as { capture?: unknown }).capture);
    case "SET_GAINS": {
      const g = value as { original?: unknown; translation?: unknown };
      return typeof g.original === "number" && typeof g.translation === "number";
    }
    case "LISTEN_ORIGINAL":
      return typeof (value as { enabled?: unknown }).enabled === "boolean";
    case "SAVE_SETTINGS":
      return Boolean((value as { settings?: unknown }).settings);
    case "SAVE_PAIRING":
      return typeof (value as { pairingToken?: unknown }).pairingToken === "string";
    case "DISABLE_RX":
    case "ENABLE_TX":
    case "DISABLE_TX":
    case "STOP_ALL":
    case "RENEW_SESSIONS":
    case "GET_STATE":
    case "OPEN_SETUP":
    case "OPEN_CONTROL":
    case "CLEAR_PAIRING":
    case "GET_SETTINGS":
      return true;
    default:
      return false;
  }
}

export function clampGain(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function estimateCostUsd(rxBilledMs: number, txBilledMs: number): number {
  const minutes = (rxBilledMs + txBilledMs) / 60_000;
  return Math.round(minutes * COST_PER_MINUTE_USD * 1000) / 1000;
}

export function targetLanguageFor(direction: Direction): "ja" | "en" {
  return direction === "rx" ? "ja" : "en";
}

export function isBlackHoleLabel(label: string): boolean {
  return /blackhole/i.test(label);
}

export function isLikelyVirtualInput(label: string): boolean {
  return (
    isBlackHoleLabel(label) ||
    /vb-?audio|cable|virtual|loopback|soundflower/i.test(label)
  );
}

function normalizeLabel(label: string | undefined): string {
  return (label ?? "").trim().toLowerCase();
}

/**
 * Validate device routing for a capture mode. Returns null when OK.
 *
 * Device mode (Zoom desktop app) requires a *second* virtual device: Zoom's
 * speaker goes to `remoteCaptureInput` (e.g. BlackHole 16ch) while our TX
 * output goes to `virtualOutput` (BlackHole 2ch = Zoom mic). If both were the
 * same device, Zoom's own output would be fed straight back into its mic and
 * our translation would loop.
 */
export function validateRouting(
  settings: LocalSettings,
  mode: CaptureMode,
): AppError | null {
  if (
    !settings.physicalMicId ||
    !settings.headphoneOutputId ||
    !settings.virtualOutputId
  ) {
    return {
      code: "MISSING_SETTINGS",
      message: "物理マイク・イヤホン・BlackHoleをsetupで設定してください",
    };
  }
  if (!settings.brokerBaseUrl || settings.brokerBaseUrl.includes("YOUR-BROKER")) {
    return {
      code: "MISSING_SETTINGS",
      message:
        "Broker URLが未設定です。setupでCloudflare WorkerのURLを入力してください",
    };
  }
  if (mode !== "device") return null;

  if (!settings.remoteCaptureInputId) {
    return {
      code: "MISSING_SETTINGS",
      message:
        "Zoomアプリ用の「会議音声入力（BlackHole 16chなど）」をsetupで設定してください",
    };
  }
  if (settings.remoteCaptureInputId === settings.physicalMicId) {
    return {
      code: "ROUTING_CONFLICT",
      message: "会議音声入力と物理マイクに同じデバイスは指定できません",
    };
  }
  const remoteLabel = normalizeLabel(settings.deviceLabels.remoteCaptureInput);
  const virtualLabel = normalizeLabel(settings.deviceLabels.virtualOutput);
  if (remoteLabel && remoteLabel === virtualLabel) {
    return {
      code: "ROUTING_CONFLICT",
      message:
        "会議音声入力と仮想マイク出力が同じ仮想デバイスです。ループを防ぐため、Zoomのスピーカーには別のBlackHole（例: 16ch）を使ってください",
    };
  }
  return null;
}

export function classifyHttpError(
  status: number,
  fallbackMessage: string,
): AppError {
  switch (status) {
    case 400:
      return { code: "BROKER_BAD_REQUEST", message: fallbackMessage };
    case 401:
      return {
        code: "BROKER_UNAUTHORIZED",
        message: "接続コードが無効です。setupで再入力してください。",
      };
    case 403:
      return {
        code: "BROKER_FORBIDDEN",
        message: "この拡張からの接続は許可されていません。",
      };
    case 429:
      return {
        code: "BROKER_RATE_LIMITED",
        message: "トークン発行の頻度制限に達しました。少し待ってから再試行してください。",
      };
    case 502:
      return {
        code: "BROKER_UPSTREAM",
        message: "翻訳トークンの発行に失敗しました。",
      };
    case 504:
      return {
        code: "BROKER_TIMEOUT",
        message: "トークン発行がタイムアウトしました。",
      };
    default:
      return { code: "BROKER_NETWORK", message: fallbackMessage };
  }
}
