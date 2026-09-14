import {
  detectTabPlatform,
  platformLabel,
  type CaptureMode,
  type CaptureRequest,
  type TabPlatformResult,
} from "../../shared/platform.js";
import type { LocalSettings } from "../../shared/protocol.js";
import {
  bindStateUi,
  loadSettings,
  requestId,
  sendCommand,
} from "./ui-common.js";

interface ActiveTabInfo {
  tabId: number | null;
  detected: TabPlatformResult;
}

let activeTab: ActiveTabInfo = {
  tabId: null,
  detected: { platform: null, reason: "not_meeting" },
};
let currentSettings: LocalSettings | null = null;

const root = document.body;
const ui = bindStateUi({
  root,
  onRefresh: (state) => {
    const startBtn = qs<HTMLButtonElement>("#btn-start");
    const stopBtn = qs<HTMLButtonElement>("#btn-stop");
    const txBtn = qs<HTMLButtonElement>("#btn-tx");
    const listenBtn = qs<HTMLButtonElement>("#btn-listen");
    const renewBtn = qs<HTMLButtonElement>("#btn-renew");
    const sourceSelect = qs<HTMLSelectElement>("#source-mode");

    const running = state.meetingState !== "IDLE" && state.meetingState !== "STOPPING";
    startBtn.disabled = running;
    stopBtn.disabled = !running && state.meetingState === "IDLE";
    sourceSelect.disabled = running;

    qs("[data-platform]").textContent = running
      ? platformLabel(state.platform)
      : platformLabel(previewPlatform(sourceSelect.value as CaptureMode));
    qs<HTMLElement>("#device-remote-row").hidden =
      !(running ? state.captureMode === "device" : sourceSelect.value === "device");
    qs("#device-remote").textContent = running
      ? (state.devices.remoteCaptureInputLabel ?? "未設定")
      : (currentSettings?.deviceLabels.remoteCaptureInput ?? "未設定");
    txBtn.disabled = !(
      state.meetingState === "ACTIVE_RX" ||
      state.meetingState === "ACTIVE_BOTH" ||
      state.meetingState === "DEGRADED"
    );
    txBtn.textContent =
      state.tx.state === "active" || state.tx.state === "connecting"
        ? "送信だけ停止（緊急）"
        : "送信を再開（緊急）";
    listenBtn.textContent = state.listeningOriginalOnly
      ? "訳音バランスへ戻す"
      : "原音を聞く";
    renewBtn.disabled = !running;
    renewBtn.hidden = !state.renewWarn;

    qs<HTMLInputElement>("#gain-original").value = String(
      Math.round(state.originalGain * 100),
    );
    qs<HTMLInputElement>("#gain-translation").value = String(
      Math.round(state.translationGain * 100),
    );
    qs("#gain-original-value").textContent = `${Math.round(state.originalGain * 100)}%`;
    qs("#gain-translation-value").textContent = `${Math.round(state.translationGain * 100)}%`;

    qs("#device-mic").textContent =
      state.devices.physicalMicLabel ?? "未設定";
    qs("#device-headphone").textContent =
      state.devices.headphoneOutputLabel ?? "未設定";
    qs("#device-virtual").textContent =
      state.devices.virtualOutputLabel ?? "未設定";

    qs("#rx-transcript").textContent = state.rx.transcriptTail || "—";
    qs("#tx-transcript").textContent = state.tx.transcriptTail || "—";
  },
});

function qs<T extends Element = Element>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el as T;
}

function previewPlatform(mode: CaptureMode) {
  return mode === "device" ? "zoom-app" : activeTab.detected.platform;
}

async function readActiveTab(): Promise<ActiveTabInfo> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return {
    tabId: tab?.id ?? null,
    detected: detectTabPlatform(tab?.url),
  };
}

/** Prefer the front tab when it is a meeting; otherwise fall back to the Zoom app if configured. */
function defaultCaptureMode(settings: LocalSettings): CaptureMode {
  if (activeTab.detected.platform) return "tab";
  return settings.remoteCaptureInputId ? "device" : "tab";
}

function sourceHint(mode: CaptureMode): string {
  if (mode === "device") {
    return currentSettings?.remoteCaptureInputId
      ? "Zoomアプリ: スピーカー=会議音声入力のデバイス、マイク=BlackHole 2ch に設定してください"
      : "Zoomアプリ用の会議音声入力が未設定です。設定（2b）で BlackHole 16ch などを選んでください";
  }
  const { platform, reason } = activeTab.detected;
  if (platform === "meet") return "前面タブ: Google Meet を検出しました";
  if (platform === "zoom-web") return "前面タブ: Zoom（ブラウザ版）を検出しました";
  if (reason === "zoom_not_web_client") {
    return "Zoomのページですがブラウザ版ではありません。「ブラウザから参加」を選ぶか、接続先を Zoom アプリに切り替えてください";
  }
  return "Google Meet または Zoom（ブラウザ版）のタブを前面にしてください";
}

function refreshSourceUi(): void {
  const sourceSelect = qs<HTMLSelectElement>("#source-mode");
  qs("#source-hint").textContent = sourceHint(sourceSelect.value as CaptureMode);
  ui.render(ui.getState());
}

async function refresh(): Promise<void> {
  const reply = await sendCommand({ type: "GET_STATE", requestId: requestId() });
  if (reply.state) ui.render(reply.state);
}

async function init(): Promise<void> {
  const { settings, hasPairing, state } = await loadSettings();
  currentSettings = settings;
  activeTab = await readActiveTab();

  const sourceSelect = qs<HTMLSelectElement>("#source-mode");
  sourceSelect.value =
    state.meetingState !== "IDLE" && state.captureMode
      ? state.captureMode
      : defaultCaptureMode(settings);
  sourceSelect.addEventListener("change", refreshSourceUi);

  ui.render(state);
  refreshSourceUi();
  qs("#pairing-status").textContent = hasPairing
    ? "接続コード: セッション内で設定済み"
    : "接続コード未設定（setupへ）";
  qs("#broker-url").textContent = settings.brokerBaseUrl;

  qs<HTMLButtonElement>("#btn-start").addEventListener("click", async () => {
    qs("[data-error]").textContent = "";
    let capture: CaptureRequest;
    if (sourceSelect.value === "device") {
      capture = { mode: "device" };
    } else {
      activeTab = await readActiveTab();
      refreshSourceUi();
      if (activeTab.tabId === null) {
        qs("[data-error]").textContent = "前面タブを取得できませんでした";
        return;
      }
      capture = { mode: "tab", tabId: activeTab.tabId };
    }
    const reply = await sendCommand({
      type: "START_RX",
      requestId: requestId(),
      capture,
    });
    if (reply.state) ui.render(reply.state);
    if (!reply.ok && reply.error) {
      qs("[data-error]").textContent = reply.error.message;
    }
  });

  qs<HTMLButtonElement>("#btn-stop").addEventListener("click", async () => {
    const reply = await sendCommand({
      type: "STOP_ALL",
      requestId: requestId(),
    });
    if (reply.state) ui.render(reply.state);
  });

  qs<HTMLButtonElement>("#btn-tx").addEventListener("click", async () => {
    const state = ui.getState();
    const type =
      state.tx.state === "active" || state.tx.state === "connecting"
        ? "DISABLE_TX"
        : "ENABLE_TX";
    const reply = await sendCommand({ type, requestId: requestId() });
    if (reply.state) ui.render(reply.state);
    if (!reply.ok && reply.error) {
      qs("[data-error]").textContent = reply.error.message;
    }
  });

  qs<HTMLButtonElement>("#btn-listen").addEventListener("click", async () => {
    const enabled = !ui.getState().listeningOriginalOnly;
    const reply = await sendCommand({
      type: "LISTEN_ORIGINAL",
      requestId: requestId(),
      enabled,
    });
    if (reply.state) ui.render(reply.state);
  });

  qs<HTMLButtonElement>("#btn-renew").addEventListener("click", async () => {
    const reply = await sendCommand({
      type: "RENEW_SESSIONS",
      requestId: requestId(),
    });
    if (reply.state) ui.render(reply.state);
  });

  const sendGains = async () => {
    const original =
      Number(qs<HTMLInputElement>("#gain-original").value) / 100;
    const translation =
      Number(qs<HTMLInputElement>("#gain-translation").value) / 100;
    const reply = await sendCommand({
      type: "SET_GAINS",
      requestId: requestId(),
      original,
      translation,
    });
    if (reply.state) ui.render(reply.state);
  };

  qs<HTMLInputElement>("#gain-original").addEventListener("input", () => {
    qs("#gain-original-value").textContent = `${qs<HTMLInputElement>("#gain-original").value}%`;
  });
  qs<HTMLInputElement>("#gain-translation").addEventListener("input", () => {
    qs("#gain-translation-value").textContent = `${qs<HTMLInputElement>("#gain-translation").value}%`;
  });
  qs<HTMLInputElement>("#gain-original").addEventListener("change", () => {
    void sendGains();
  });
  qs<HTMLInputElement>("#gain-translation").addEventListener("change", () => {
    void sendGains();
  });

  qs<HTMLButtonElement>("#btn-setup").addEventListener("click", () => {
    void sendCommand({ type: "OPEN_SETUP", requestId: requestId() });
  });
  qs<HTMLButtonElement>("#btn-control").addEventListener("click", () => {
    void sendCommand({ type: "OPEN_CONTROL", requestId: requestId() });
  });

  void refresh();
}

void init();
