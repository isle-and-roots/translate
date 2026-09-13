import {
  createIdleSnapshot,
  type CommandReply,
  type LocalSettings,
  type MeetingSnapshot,
  type RuntimeEvent,
} from "../../shared/protocol.js";
import { toAppError } from "../../shared/errors.js";
import { MeetingController } from "./meeting-controller.js";

const controller = new MeetingController({
  getSettings: async () => {
    // Settings are injected with commands; keep last known via closure below.
    if (!cachedSettings) {
      throw new Error("settings missing");
    }
    return cachedSettings;
  },
  getPairingToken: async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "OFFSCREEN_GET_PAIRING",
    })) as { ok: boolean; pairingToken?: string | null };
    return response.pairingToken ?? null;
  },
  requestTabStreamId: async (tabId: number) => {
    const response = (await chrome.runtime.sendMessage({
      type: "OFFSCREEN_NEED_STREAM_ID",
      requestId: crypto.randomUUID(),
      tabId,
    })) as { ok: boolean; streamId?: string; error?: unknown };
    if (!response.ok || !response.streamId) {
      throw toAppError(response.error ?? new Error("streamId取得失敗"), "PERMISSION_DENIED");
    }
    return response.streamId;
  },
  onState: (state) => {
    latest = state;
    const event: RuntimeEvent = {
      type: "STATE_CHANGED",
      version: state.version,
      state,
    };
    void chrome.runtime.sendMessage(event).catch(() => undefined);
  },
});

let cachedSettings: LocalSettings | null = null;
let latest: MeetingSnapshot = createIdleSnapshot();
let stopping = false;

function reply(
  requestId: string,
  ok: boolean,
  extra: Partial<CommandReply> = {},
): CommandReply {
  return {
    requestId,
    ok,
    state: latest,
    ...extra,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if ((message as { channel?: string }).channel !== "offscreen") return false;

  const requestId = String((message as { requestId?: string }).requestId ?? "");
  const type = String((message as { type?: string }).type ?? "");

  void (async () => {
    try {
      if ((message as { settings?: LocalSettings }).settings) {
        cachedSettings = (message as { settings: LocalSettings }).settings;
      }

      switch (type) {
        case "GET_STATE":
          latest = controller.getSnapshot();
          sendResponse(reply(requestId, true));
          return;
        case "START_RX": {
          const tabId = Number((message as { tabId: number }).tabId);
          const tabTitle =
            ((message as { tabTitle?: string | null }).tabTitle as string | null) ??
            null;
          latest = await controller.startRx(tabId, tabTitle);
          sendResponse(reply(requestId, true));
          return;
        }
        case "ENABLE_TX":
          latest = await controller.enableTx();
          sendResponse(reply(requestId, true));
          return;
        case "DISABLE_TX":
          latest = await controller.disableTx();
          sendResponse(reply(requestId, true));
          return;
        case "DISABLE_RX":
          latest = await controller.disableRx();
          sendResponse(reply(requestId, true));
          return;
        case "SET_GAINS": {
          const original = Number((message as { original: number }).original);
          const translation = Number(
            (message as { translation: number }).translation,
          );
          latest = await controller.setGains(original, translation);
          // Persist gains via background
          if (cachedSettings) {
            cachedSettings = {
              ...cachedSettings,
              originalGain: latest.originalGain,
              translationGain: latest.translationGain,
            };
            void chrome.runtime.sendMessage({
              type: "SAVE_SETTINGS",
              requestId: crypto.randomUUID(),
              settings: cachedSettings,
            });
          }
          sendResponse(reply(requestId, true));
          return;
        }
        case "LISTEN_ORIGINAL": {
          const enabled = Boolean((message as { enabled: boolean }).enabled);
          latest = await controller.listenOriginal(enabled);
          sendResponse(reply(requestId, true));
          return;
        }
        case "RENEW_SESSIONS":
          latest = await controller.renewSessions();
          sendResponse(reply(requestId, true));
          return;
        case "STOP_ALL": {
          if (stopping) {
            sendResponse(reply(requestId, true));
            return;
          }
          stopping = true;
          try {
            latest = await controller.stopAll();
            void chrome.runtime.sendMessage({ type: "OFFSCREEN_CLOSED_ACK" });
            sendResponse(reply(requestId, true));
          } finally {
            stopping = false;
          }
          return;
        }
        default:
          sendResponse(
            reply(requestId, false, {
              error: {
                code: "INVALID_MESSAGE",
                message: `未対応コマンド: ${type}`,
              },
            }),
          );
      }
    } catch (error) {
      latest = controller.getSnapshot();
      sendResponse(
        reply(requestId, false, {
          error: toAppError(error),
        }),
      );
    }
  })();

  return true;
});
