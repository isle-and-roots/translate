import {
  createDefaultSettings,
  isBlackHoleLabel,
  isLikelyVirtualInput,
  type LocalSettings,
} from "../../shared/protocol.js";
import { loadSettings, requestId, sendCommand } from "./ui-common.js";

function qs<T extends Element = Element>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el as T;
}

async function ensureMicPermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  for (const track of stream.getTracks()) track.stop();
}

function option(
  device: MediaDeviceInfo,
  selectedId: string,
): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = device.deviceId;
  el.textContent = device.label || `${device.kind} (${device.deviceId.slice(0, 8)})`;
  if (device.deviceId === selectedId) el.selected = true;
  return el;
}

async function populateDevices(settings: LocalSettings): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const micSelect = qs<HTMLSelectElement>("#physical-mic");
  const headphoneSelect = qs<HTMLSelectElement>("#headphone-output");
  const virtualSelect = qs<HTMLSelectElement>("#virtual-output");

  micSelect.innerHTML = "";
  headphoneSelect.innerHTML = "";
  virtualSelect.innerHTML = "";

  for (const device of devices) {
    if (device.kind === "audioinput") {
      if (isLikelyVirtualInput(device.label)) continue;
      micSelect.append(option(device, settings.physicalMicId));
    }
    if (device.kind === "audiooutput") {
      headphoneSelect.append(option(device, settings.headphoneOutputId));
      if (isBlackHoleLabel(device.label) || /cable input|vb-audio/i.test(device.label)) {
        virtualSelect.append(option(device, settings.virtualOutputId));
      }
    }
  }

  // Always allow manual selection of any output for virtual if BlackHole not detected yet
  if (virtualSelect.options.length === 0) {
    for (const device of devices.filter((d) => d.kind === "audiooutput")) {
      virtualSelect.append(option(device, settings.virtualOutputId));
    }
  }
}

function selectedLabel(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.textContent ?? "";
}

async function init(): Promise<void> {
  const status = qs("#status");
  let { settings, hasPairing } = await loadSettings();

  qs<HTMLInputElement>("#broker-url").value = settings.brokerBaseUrl;
  qs("#pairing-status").textContent = hasPairing
    ? "接続コードは現在のブラウザセッションに保持されています"
    : "未設定（Chrome再起動後は再入力が必要）";

  qs<HTMLButtonElement>("#btn-permission").addEventListener("click", async () => {
    try {
      await ensureMicPermission();
      await populateDevices(settings);
      status.textContent = "マイク権限を取得し、デバイス一覧を更新しました。";
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? `権限が拒否されました: ${error.message}`
          : "権限が拒否されました";
    }
  });

  qs<HTMLButtonElement>("#btn-refresh-devices").addEventListener(
    "click",
    async () => {
      try {
        await populateDevices(settings);
        status.textContent = "デバイス一覧を更新しました。";
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : "デバイス列挙に失敗しました";
      }
    },
  );

  qs<HTMLButtonElement>("#btn-save").addEventListener("click", async () => {
    const micSelect = qs<HTMLSelectElement>("#physical-mic");
    const headphoneSelect = qs<HTMLSelectElement>("#headphone-output");
    const virtualSelect = qs<HTMLSelectElement>("#virtual-output");
    const brokerBaseUrl = qs<HTMLInputElement>("#broker-url").value.trim();
    const pairingToken = qs<HTMLInputElement>("#pairing-token").value.trim();

    if (!micSelect.value || !headphoneSelect.value || !virtualSelect.value) {
      status.textContent = "3つのデバイスをすべて選択してください。";
      return;
    }
    if (micSelect.value === virtualSelect.value) {
      status.textContent =
        "物理マイクとBlackHole出力に同じIDを指定しないでください。";
      return;
    }
    if (!brokerBaseUrl.startsWith("https://")) {
      status.textContent = "Broker URLは https:// で始まる必要があります。";
      return;
    }

    const next: LocalSettings = {
      ...createDefaultSettings(brokerBaseUrl),
      ...settings,
      physicalMicId: micSelect.value,
      headphoneOutputId: headphoneSelect.value,
      virtualOutputId: virtualSelect.value,
      brokerBaseUrl,
      deviceLabels: {
        physicalMic: selectedLabel(micSelect),
        headphoneOutput: selectedLabel(headphoneSelect),
        virtualOutput: selectedLabel(virtualSelect),
      },
    };

    const saveReply = await sendCommand({
      type: "SAVE_SETTINGS",
      requestId: requestId(),
      settings: next,
    });
    if (!saveReply.ok) {
      status.textContent = saveReply.error?.message ?? "設定の保存に失敗しました";
      return;
    }
    settings = next;

    if (pairingToken) {
      const pairReply = await sendCommand({
        type: "SAVE_PAIRING",
        requestId: requestId(),
        pairingToken,
      });
      if (!pairReply.ok) {
        status.textContent =
          pairReply.error?.message ?? "接続コードの保存に失敗しました";
        return;
      }
      qs<HTMLInputElement>("#pairing-token").value = "";
      qs("#pairing-status").textContent =
        "接続コードは現在のブラウザセッションに保持されています";
    }

    status.textContent =
      "設定を保存しました。MeetではマイクをBlackHole、スピーカーをイヤホンにしてください。";
  });

  qs<HTMLButtonElement>("#btn-clear-pairing").addEventListener("click", async () => {
    await sendCommand({ type: "CLEAR_PAIRING", requestId: requestId() });
    qs("#pairing-status").textContent = "接続コードをクリアしました";
  });

  try {
    await populateDevices(settings);
  } catch {
    status.textContent =
      "デバイス一覧を表示するには、先に「マイク権限を許可」を押してください。";
  }
}

void init();
