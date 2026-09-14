import {
  createDefaultSettings,
  createIdleSnapshot,
  isCommand,
  validateRouting,
  type CaptureRequest,
  type CaptureSource,
  type Command,
  type CommandReply,
  type LocalSettings,
  type MeetingSnapshot,
  type OffscreenStartMessage,
  type RuntimeEvent,
} from "../../shared/protocol.js";
import { detectTabPlatform } from "../../shared/platform.js";
import { appError, toAppError } from "../../shared/errors.js";

const OFFSCREEN_URL = "offscreen.html";
const SETTINGS_KEY = "meetInterpreterSettings";
const PAIRING_KEY = "pairingToken";

let creatingOffscreen: Promise<void> | null = null;
let latestState: MeetingSnapshot = createIdleSnapshot();
let controlWindowId: number | null = null;

async function getSettings(): Promise<LocalSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as LocalSettings | undefined;
  if (!stored) return createDefaultSettings();
  return {
    ...createDefaultSettings(stored.brokerBaseUrl),
    ...stored,
    deviceLabels: stored.deviceLabels ?? {},
  };
}

async function saveSettings(settings: LocalSettings): Promise<LocalSettings> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function getPairingToken(): Promise<string | null> {
  const result = await chrome.storage.session.get(PAIRING_KEY);
  const token = result[PAIRING_KEY];
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function savePairingToken(token: string): Promise<void> {
  await chrome.storage.session.set({ [PAIRING_KEY]: token });
}

async function clearPairingToken(): Promise<void> {
  await chrome.storage.session.remove(PAIRING_KEY);
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [
      chrome.offscreen.Reason.USER_MEDIA,
      chrome.offscreen.Reason.WEB_RTC,
    ],
    justification:
      "Capture meeting audio (Meet/Zoom tab or virtual device) and maintain bidirectional WebRTC translation sessions.",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length === 0) return;
  await chrome.offscreen.closeDocument();
}

function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return Boolean(sender.id && sender.id === chrome.runtime.id);
}

async function sendToOffscreen<T>(message: unknown): Promise<T> {
  await ensureOffscreen();
  return (await chrome.runtime.sendMessage(message)) as T;
}

function notMeetingTabError(
  reason: "not_meeting" | "zoom_not_web_client",
  selected: boolean,
): ReturnType<typeof appError> {
  if (reason === "zoom_not_web_client") {
    return appError(
      "NOT_MEETING_TAB",
      "Zoomのタブですがブラウザ版（/wc/）ではありません。Zoomの「ブラウザから参加」を選ぶか、Zoomアプリモードで開始してください",
    );
  }
  return appError(
    "NOT_MEETING_TAB",
    selected
      ? "選択タブがGoogle Meet / Zoom（ブラウザ）ではありません"
      : "Google Meet または Zoom（ブラウザ）のタブを前面にしてから開始してください。Zoomアプリの場合はZoomアプリモードを選んでください",
  );
}

async function resolveTabSource(
  preferredTabId?: number,
): Promise<Extract<CaptureSource, { kind: "tab" }>> {
  let tab: chrome.tabs.Tab | undefined;
  if (preferredTabId !== undefined) {
    tab = await chrome.tabs.get(preferredTabId);
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) {
    throw appError("NOT_MEETING_TAB", "タブIDを取得できません");
  }
  const detected = detectTabPlatform(tab.url);
  if (!detected.platform) {
    throw notMeetingTabError(detected.reason, preferredTabId !== undefined);
  }
  return {
    kind: "tab",
    platform: detected.platform,
    tabId: tab.id,
    tabTitle: tab.title ?? null,
  };
}

async function resolveCaptureSource(
  capture: CaptureRequest,
  settings: LocalSettings,
): Promise<CaptureSource> {
  if (capture.mode === "device") {
    const routing = validateRouting(settings, "device");
    if (routing) throw routing;
    return { kind: "device", platform: "zoom-app" };
  }
  return resolveTabSource(capture.tabId);
}

async function handleCommand(
  command: Command,
  sender: chrome.runtime.MessageSender,
): Promise<CommandReply> {
  try {
    switch (command.type) {
      case "GET_STATE": {
        if (latestState.meetingState !== "IDLE") {
          const reply = await sendToOffscreen<CommandReply>({
            channel: "offscreen",
            ...command,
          });
          if (reply.state) latestState = reply.state;
          return reply;
        }
        return { requestId: command.requestId, ok: true, state: latestState };
      }
      case "GET_SETTINGS": {
        const settings = await getSettings();
        const pairing = await getPairingToken();
        return {
          requestId: command.requestId,
          ok: true,
          settings,
          hasPairing: Boolean(pairing),
          state: latestState,
        };
      }
      case "SAVE_SETTINGS": {
        const saved = await saveSettings(command.settings);
        const hasPairing = Boolean(await getPairingToken());
        const event: RuntimeEvent = {
          type: "SETTINGS_CHANGED",
          settings: saved,
          hasPairing,
        };
        void chrome.runtime.sendMessage(event).catch(() => undefined);
        return {
          requestId: command.requestId,
          ok: true,
          settings: saved,
          hasPairing,
        };
      }
      case "SAVE_PAIRING": {
        if (command.pairingToken.length < 32) {
          throw appError("INVALID_MESSAGE", "接続コードが短すぎます");
        }
        await savePairingToken(command.pairingToken);
        return {
          requestId: command.requestId,
          ok: true,
          hasPairing: true,
        };
      }
      case "CLEAR_PAIRING": {
        await clearPairingToken();
        return { requestId: command.requestId, ok: true, hasPairing: false };
      }
      case "OPEN_SETUP": {
        await chrome.runtime.openOptionsPage();
        return { requestId: command.requestId, ok: true };
      }
      case "OPEN_CONTROL": {
        if (controlWindowId !== null) {
          try {
            await chrome.windows.update(controlWindowId, { focused: true });
            return { requestId: command.requestId, ok: true };
          } catch {
            controlWindowId = null;
          }
        }
        const win = await chrome.windows.create({
          url: chrome.runtime.getURL("control.html"),
          type: "popup",
          width: 420,
          height: 720,
        });
        controlWindowId = win.id ?? null;
        return { requestId: command.requestId, ok: true };
      }
      case "START_RX": {
        const settings = await getSettings();
        const source = await resolveCaptureSource(command.capture, settings);
        const pairing = await getPairingToken();
        const message: OffscreenStartMessage = {
          channel: "offscreen",
          type: "START_RX",
          requestId: command.requestId,
          source,
          settings,
          hasPairing: Boolean(pairing),
        };
        const reply = await sendToOffscreen<CommandReply>(message);
        if (reply.state) latestState = reply.state;
        return reply;
      }
      case "STOP_ALL": {
        let reply: CommandReply = {
          requestId: command.requestId,
          ok: true,
          state: createIdleSnapshot(),
        };
        try {
          reply = await sendToOffscreen<CommandReply>({
            channel: "offscreen",
            ...command,
          });
        } catch {
          // offscreen may already be gone
        }
        if (reply.state) latestState = reply.state;
        // Design: ACK then close; force-close after 5s if needed.
        const forceClose = setTimeout(() => {
          void closeOffscreen();
        }, 5000);
        try {
          await closeOffscreen();
        } catch {
          // ignore
        } finally {
          clearTimeout(forceClose);
        }
        return reply;
      }
      default: {
        const reply = await sendToOffscreen<CommandReply>({
          channel: "offscreen",
          ...command,
          settings: await getSettings(),
        });
        if (reply.state) latestState = reply.state;
        return reply;
      }
    }
  } catch (error) {
    return {
      requestId: command.requestId,
      ok: false,
      error: toAppError(error),
      state: latestState,
    };
  } finally {
    void sender;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionSender(sender)) {
    sendResponse({
      ok: false,
      error: appError("INVALID_MESSAGE", "外部メッセージは拒否しました"),
    });
    return false;
  }

  // Internal offscreen events
  if (message && typeof message === "object" && "type" in message) {
    const typed = message as RuntimeEvent | { type: string };
    if (typed.type === "STATE_CHANGED") {
      const event = typed as RuntimeEvent & { state: MeetingSnapshot };
      latestState = event.state;
      return false;
    }
    if (typed.type === "OFFSCREEN_NEED_STREAM_ID") {
      const req = message as {
        requestId: string;
        tabId: number;
      };
      void (async () => {
        try {
          const streamId = await new Promise<string>((resolve, reject) => {
            try {
              chrome.tabCapture.getMediaStreamId(
                { targetTabId: req.tabId },
                (id) => {
                  const err = chrome.runtime.lastError;
                  if (err || !id) {
                    reject(new Error(err?.message ?? "streamId取得失敗"));
                    return;
                  }
                  resolve(id);
                },
              );
            } catch (error) {
              reject(error);
            }
          });
          sendResponse({ ok: true, requestId: req.requestId, streamId });
        } catch (error) {
          sendResponse({
            ok: false,
            requestId: req.requestId,
            error: toAppError(error, "PERMISSION_DENIED"),
          });
        }
      })();
      return true;
    }
    if (typed.type === "OFFSCREEN_GET_PAIRING") {
      void (async () => {
        const pairingToken = await getPairingToken();
        sendResponse({ ok: true, pairingToken });
      })();
      return true;
    }
    if (typed.type === "OFFSCREEN_CLOSED_ACK") {
      void closeOffscreen();
      sendResponse({ ok: true });
      return false;
    }
  }

  if (!isCommand(message)) {
    sendResponse({
      requestId: (message as { requestId?: string })?.requestId ?? "unknown",
      ok: false,
      error: appError("INVALID_MESSAGE", "未知のコマンドです"),
    });
    return false;
  }

  void handleCommand(message, sender).then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (latestState.tabId === tabId && latestState.meetingState !== "IDLE") {
    void sendToOffscreen({
      channel: "offscreen",
      type: "STOP_ALL",
      requestId: crypto.randomUUID(),
      reason: "TAB_CLOSED",
    }).catch(() => undefined);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    latestState.tabId === tabId &&
    changeInfo.status === "loading" &&
    latestState.meetingState !== "IDLE"
  ) {
    void sendToOffscreen({
      channel: "offscreen",
      type: "STOP_ALL",
      requestId: crypto.randomUUID(),
      reason: "TAB_RELOADED",
    }).catch(() => undefined);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === controlWindowId) {
    controlWindowId = null;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void getSettings();
});
