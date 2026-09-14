import { describe, expect, it } from "vitest";
import {
  captureModeLabel,
  detectTabPlatform,
  isCaptureRequest,
  isCaptureSource,
  isZoomHost,
  platformLabel,
} from "../shared/platform";
import {
  createDefaultSettings,
  isOffscreenStartMessage,
  validateRouting,
  type LocalSettings,
} from "../shared/protocol";

describe("detectTabPlatform", () => {
  it("detects Google Meet", () => {
    expect(detectTabPlatform("https://meet.google.com/abc-defg-hij")).toEqual({
      platform: "meet",
      reason: null,
    });
  });

  it("detects the Zoom web client on all Zoom domains and subdomains", () => {
    const urls = [
      "https://zoom.us/wc/join/123456789",
      "https://app.zoom.us/wc/123456789/join?fromPWA=1",
      "https://us02web.zoom.us/wc/123456789/join",
      "https://pwa.zoom.us/wc/home",
      "https://app.zoom.com/wc/123456789/join",
      "https://zoomgov.com/wc/123456789/join",
      "https://us06web.zoomgov.com/wc/123456789/join",
      "https://app.zoom.us/wc",
    ];
    for (const url of urls) {
      expect(detectTabPlatform(url), url).toEqual({
        platform: "zoom-web",
        reason: null,
      });
    }
  });

  it("flags Zoom pages that are not the web client", () => {
    for (const url of [
      "https://zoom.us/j/123456789",
      "https://us02web.zoom.us/j/123456789?pwd=abc",
      "https://zoom.us/s/123456789",
      "https://zoom.us/",
      "https://app.zoom.us/wcsomething",
    ]) {
      expect(detectTabPlatform(url), url).toEqual({
        platform: null,
        reason: "zoom_not_web_client",
      });
    }
  });

  it("rejects non-meeting, lookalike, and insecure URLs", () => {
    for (const url of [
      undefined,
      null,
      "",
      "https://example.com/wc/1",
      "https://notzoom.us/wc/1",
      "https://zoom.us.evil.example/wc/1",
      "https://fakezoom.us/wc/1",
      "http://app.zoom.us/wc/1",
      "chrome://extensions",
      "not a url",
    ]) {
      expect(detectTabPlatform(url), String(url)).toEqual({
        platform: null,
        reason: "not_meeting",
      });
    }
  });

  it("matches zoom hosts strictly", () => {
    expect(isZoomHost("zoom.us")).toBe(true);
    expect(isZoomHost("us02web.zoom.us")).toBe(true);
    expect(isZoomHost("app.zoom.com")).toBe(true);
    expect(isZoomHost("zoomgov.com")).toBe(true);
    expect(isZoomHost("zoom.us.example.com")).toBe(false);
    expect(isZoomHost("myzoom.us")).toBe(false);
  });
});

describe("capture request / source guards", () => {
  it("accepts tab and device requests", () => {
    expect(isCaptureRequest({ mode: "tab", tabId: 3 })).toBe(true);
    expect(isCaptureRequest({ mode: "device" })).toBe(true);
    expect(isCaptureRequest({ mode: "tab" })).toBe(false);
    expect(isCaptureRequest({ mode: "tab", tabId: "3" })).toBe(false);
    expect(isCaptureRequest({ mode: "nope" })).toBe(false);
    expect(isCaptureRequest(null)).toBe(false);
  });

  it("accepts resolved sources", () => {
    expect(
      isCaptureSource({ kind: "tab", platform: "meet", tabId: 1, tabTitle: null }),
    ).toBe(true);
    expect(
      isCaptureSource({ kind: "tab", platform: "zoom-web", tabId: 1, tabTitle: "Zoom" }),
    ).toBe(true);
    expect(isCaptureSource({ kind: "device", platform: "zoom-app" })).toBe(true);
    expect(isCaptureSource({ kind: "tab", platform: "zoom-app", tabId: 1, tabTitle: null })).toBe(
      false,
    );
    expect(isCaptureSource({ kind: "device", platform: "meet" })).toBe(false);
  });

  it("validates the offscreen START_RX message", () => {
    const settings = createDefaultSettings();
    expect(
      isOffscreenStartMessage({
        channel: "offscreen",
        type: "START_RX",
        requestId: "r",
        source: { kind: "device", platform: "zoom-app" },
        settings,
        hasPairing: true,
      }),
    ).toBe(true);
    expect(
      isOffscreenStartMessage({
        channel: "offscreen",
        type: "START_RX",
        requestId: "r",
        tabId: 1,
        settings,
      }),
    ).toBe(false);
  });

  it("labels platforms and capture modes", () => {
    expect(platformLabel("meet")).toBe("Google Meet");
    expect(platformLabel("zoom-web")).toBe("Zoom（ブラウザ）");
    expect(platformLabel("zoom-app")).toBe("Zoom（アプリ）");
    expect(platformLabel(null)).toBe("—");
    expect(captureModeLabel("device")).toBe("仮想デバイス");
  });
});

describe("validateRouting", () => {
  function configured(): LocalSettings {
    return {
      ...createDefaultSettings("https://broker.example.workers.dev"),
      physicalMicId: "mic-1",
      headphoneOutputId: "hp-1",
      virtualOutputId: "bh2-out",
      deviceLabels: {
        physicalMic: "MacBook Pro Microphone",
        headphoneOutput: "External Headphones",
        virtualOutput: "BlackHole 2ch",
      },
    };
  }

  it("passes a complete tab-mode configuration", () => {
    expect(validateRouting(configured(), "tab")).toBeNull();
  });

  it("does not require the Zoom-app input in tab mode", () => {
    const s = configured();
    s.remoteCaptureInputId = "";
    expect(validateRouting(s, "tab")).toBeNull();
  });

  it("requires the base devices and broker in every mode", () => {
    const missing = configured();
    missing.virtualOutputId = "";
    expect(validateRouting(missing, "tab")?.code).toBe("MISSING_SETTINGS");

    const noBroker = configured();
    noBroker.brokerBaseUrl = "https://YOUR-BROKER.workers.dev";
    expect(validateRouting(noBroker, "device")?.code).toBe("MISSING_SETTINGS");
  });

  it("requires the Zoom-app input in device mode", () => {
    expect(validateRouting(configured(), "device")?.code).toBe("MISSING_SETTINGS");
  });

  it("passes a valid Zoom-app configuration (BlackHole 16ch as speaker sink)", () => {
    const s = configured();
    s.remoteCaptureInputId = "bh16-in";
    s.deviceLabels.remoteCaptureInput = "BlackHole 16ch";
    expect(validateRouting(s, "device")).toBeNull();
  });

  it("rejects using the physical mic as the Zoom-app input", () => {
    const s = configured();
    s.remoteCaptureInputId = "mic-1";
    s.deviceLabels.remoteCaptureInput = "MacBook Pro Microphone";
    expect(validateRouting(s, "device")?.code).toBe("ROUTING_CONFLICT");
  });

  it("rejects routing Zoom's speaker into the same BlackHole used as its mic", () => {
    const s = configured();
    s.remoteCaptureInputId = "bh2-in";
    s.deviceLabels.remoteCaptureInput = "BlackHole 2ch";
    const err = validateRouting(s, "device");
    expect(err?.code).toBe("ROUTING_CONFLICT");
    expect(err?.message).toContain("16ch");
  });
});
