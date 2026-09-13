import {
  bindStateUi,
  loadSettings,
  requestId,
  sendCommand,
} from "./ui-common.js";

const root = document.body;
const ui = bindStateUi({
  root,
  onRefresh: (state) => {
    const startBtn = qs<HTMLButtonElement>("#btn-start");
    const stopBtn = qs<HTMLButtonElement>("#btn-stop");
    const txBtn = qs<HTMLButtonElement>("#btn-tx");
    const listenBtn = qs<HTMLButtonElement>("#btn-listen");
    const renewBtn = qs<HTMLButtonElement>("#btn-renew");

    const running = state.meetingState !== "IDLE" && state.meetingState !== "STOPPING";
    startBtn.disabled = running;
    stopBtn.disabled = !running && state.meetingState === "IDLE";
    txBtn.disabled = !(
      state.meetingState === "ACTIVE_RX" ||
      state.meetingState === "ACTIVE_BOTH" ||
      state.meetingState === "DEGRADED"
    );
    txBtn.textContent =
      state.tx.state === "active" || state.tx.state === "connecting"
        ? "相手への英訳を停止"
        : "自分の声を英語で送る";
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

async function refresh(): Promise<void> {
  const reply = await sendCommand({ type: "GET_STATE", requestId: requestId() });
  if (reply.state) ui.render(reply.state);
}

async function init(): Promise<void> {
  const { settings, hasPairing, state } = await loadSettings();
  ui.render(state);
  qs("#pairing-status").textContent = hasPairing
    ? "接続コード: セッション内で設定済み"
    : "接続コード未設定（setupへ）";
  qs("#broker-url").textContent = settings.brokerBaseUrl;

  qs<HTMLButtonElement>("#btn-start").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const reply = await sendCommand({
      type: "START_RX",
      requestId: requestId(),
      tabId: tab.id,
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
