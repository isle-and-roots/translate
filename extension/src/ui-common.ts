import type {
  Command,
  CommandReply,
  LocalSettings,
  MeetingSnapshot,
  RuntimeEvent,
} from "../../shared/protocol.js";
import { createIdleSnapshot } from "../../shared/protocol.js";

export async function sendCommand<T extends Command>(
  command: T,
): Promise<CommandReply> {
  return (await chrome.runtime.sendMessage(command)) as CommandReply;
}

export function requestId(): string {
  return crypto.randomUUID();
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function stateLabel(state: MeetingSnapshot["meetingState"]): string {
  switch (state) {
    case "IDLE":
      return "停止";
    case "PREFLIGHT":
      return "準備中";
    case "CAPTURING":
      return "取得中";
    case "CONNECTING_RX":
    case "CONNECTING_TX":
      return "準備中";
    case "ACTIVE_RX":
      return "受信のみ";
    case "ACTIVE_BOTH":
      return "双方向";
    case "DEGRADED":
      return "復旧待ち";
    case "STOPPING":
      return "停止処理中";
    default:
      return state;
  }
}

export function directionLabel(state: string): string {
  switch (state) {
    case "off":
      return "OFF";
    case "connecting":
      return "接続中";
    case "active":
      return "ON";
    case "reconnecting":
      return "再接続中";
    case "error":
      return "エラー";
    default:
      return state;
  }
}

export function bindStateUi(options: {
  root: HTMLElement;
  onRefresh?: (state: MeetingSnapshot) => void;
}): {
  render: (state: MeetingSnapshot) => void;
  getState: () => MeetingSnapshot;
} {
  let current = createIdleSnapshot();

  const render = (state: MeetingSnapshot) => {
    current = state;
    const meetingEl = options.root.querySelector("[data-meeting-label]");
    const messageEl = options.root.querySelector("[data-message]");
    const rxEl = options.root.querySelector("[data-rx-state]");
    const txEl = options.root.querySelector("[data-tx-state]");
    const elapsedEl = options.root.querySelector("[data-elapsed]");
    const costEl = options.root.querySelector("[data-cost]");
    const errorEl = options.root.querySelector("[data-error]");

    if (meetingEl) meetingEl.textContent = stateLabel(state.meetingState);
    if (messageEl) messageEl.textContent = state.message ?? "";
    if (rxEl) rxEl.textContent = directionLabel(state.rx.state);
    if (txEl) txEl.textContent = directionLabel(state.tx.state);
    if (elapsedEl) elapsedEl.textContent = formatDuration(state.elapsedMs);
    if (costEl) {
      costEl.textContent = `${formatUsd(state.cost.estimatedUsd)}（概算）`;
    }
    if (errorEl) {
      const err = state.lastError ?? state.rx.lastError ?? state.tx.lastError;
      errorEl.textContent = err ? `${err.message}` : "";
    }

    options.root.dataset.meetingState = state.meetingState;
    options.onRefresh?.(state);
  };

  chrome.runtime.onMessage.addListener((message: RuntimeEvent) => {
    if (message?.type === "STATE_CHANGED") {
      render(message.state);
    }
  });

  return {
    render,
    getState: () => current,
  };
}

export async function loadSettings(): Promise<{
  settings: LocalSettings;
  hasPairing: boolean;
  state: MeetingSnapshot;
}> {
  const reply = await sendCommand({
    type: "GET_SETTINGS",
    requestId: requestId(),
  });
  if (!reply.ok || !reply.settings) {
    throw new Error(reply.error?.message ?? "設定の読み込みに失敗しました");
  }
  return {
    settings: reply.settings,
    hasPairing: Boolean(reply.hasPairing),
    state: reply.state ?? createIdleSnapshot(),
  };
}
