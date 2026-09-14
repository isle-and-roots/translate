/**
 * Meeting platform detection and capture-source contracts.
 *
 * - Google Meet and the Zoom Web Client run in a Chrome tab, so their audio is
 *   captured with `chrome.tabCapture` ("tab" mode).
 * - The Zoom desktop app is not a tab. Its speaker output is routed by the user
 *   to a dedicated virtual device (e.g. BlackHole 16ch) that the extension
 *   captures with `getUserMedia` ("device" mode).
 */

export type MeetingPlatform = "meet" | "zoom-web" | "zoom-app";
export type TabPlatform = Extract<MeetingPlatform, "meet" | "zoom-web">;
export type CaptureMode = "tab" | "device";

/** What the UI asks the background to start. */
export type CaptureRequest =
  | { mode: "tab"; tabId: number }
  | { mode: "device" };

/** What the background resolved and hands to the offscreen controller. */
export type CaptureSource =
  | {
      kind: "tab";
      platform: TabPlatform;
      tabId: number;
      tabTitle: string | null;
    }
  | { kind: "device"; platform: "zoom-app" };

export type TabPlatformResult =
  | { platform: TabPlatform; reason: null }
  | { platform: null; reason: "not_meeting" | "zoom_not_web_client" };

export const MEET_URL_PREFIX = "https://meet.google.com/";

/** zoom.us / zoom.com / zoomgov.com and any subdomain (app., us02web., pwa., ...). */
const ZOOM_HOST_RE = /^(?:[a-z0-9-]+\.)*zoom(?:\.us|\.com|gov\.com)$/i;

/** The Zoom Web Client (and PWA) always lives under `/wc/`. */
const ZOOM_WEB_CLIENT_PATH_RE = /^\/wc(?:\/|$)/;

export function isZoomHost(hostname: string): boolean {
  return ZOOM_HOST_RE.test(hostname);
}

export function detectTabPlatform(
  url: string | null | undefined,
): TabPlatformResult {
  if (!url) return { platform: null, reason: "not_meeting" };
  if (url.startsWith(MEET_URL_PREFIX)) return { platform: "meet", reason: null };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { platform: null, reason: "not_meeting" };
  }
  if (parsed.protocol !== "https:") return { platform: null, reason: "not_meeting" };
  if (!isZoomHost(parsed.hostname)) return { platform: null, reason: "not_meeting" };
  if (ZOOM_WEB_CLIENT_PATH_RE.test(parsed.pathname)) {
    return { platform: "zoom-web", reason: null };
  }
  return { platform: null, reason: "zoom_not_web_client" };
}

export function isCaptureRequest(value: unknown): value is CaptureRequest {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { mode?: unknown; tabId?: unknown };
  if (maybe.mode === "tab") return typeof maybe.tabId === "number";
  return maybe.mode === "device";
}

export function isCaptureSource(value: unknown): value is CaptureSource {
  if (!value || typeof value !== "object") return false;
  const maybe = value as {
    kind?: unknown;
    platform?: unknown;
    tabId?: unknown;
    tabTitle?: unknown;
  };
  if (maybe.kind === "tab") {
    return (
      (maybe.platform === "meet" || maybe.platform === "zoom-web") &&
      typeof maybe.tabId === "number" &&
      (maybe.tabTitle === null || typeof maybe.tabTitle === "string")
    );
  }
  return maybe.kind === "device" && maybe.platform === "zoom-app";
}

export function platformLabel(platform: MeetingPlatform | null): string {
  switch (platform) {
    case "meet":
      return "Google Meet";
    case "zoom-web":
      return "Zoom（ブラウザ）";
    case "zoom-app":
      return "Zoom（アプリ）";
    default:
      return "—";
  }
}

export function captureModeLabel(mode: CaptureMode | null): string {
  switch (mode) {
    case "tab":
      return "タブ音声";
    case "device":
      return "仮想デバイス";
    default:
      return "—";
  }
}
