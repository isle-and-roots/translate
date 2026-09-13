import { describe, expect, it } from "vitest";
import {
  clampGain,
  classifyHttpError,
  createDefaultSettings,
  createIdleSnapshot,
  estimateCostUsd,
  isBlackHoleLabel,
  isCommand,
  isLikelyVirtualInput,
  targetLanguageFor,
} from "../shared/protocol";
import { assertGeneration, GenerationStaleError } from "../shared/errors";
import { mergeTranscript } from "../extension/src/translation-session";

describe("protocol", () => {
  it("creates idle snapshot defaults", () => {
    const snap = createIdleSnapshot();
    expect(snap.meetingState).toBe("IDLE");
    expect(snap.rx.state).toBe("off");
    expect(snap.tx.state).toBe("off");
    expect(snap.cost.stopUsd).toBe(10);
  });

  it("validates commands", () => {
    expect(
      isCommand({ type: "START_RX", requestId: "a", tabId: 1 }),
    ).toBe(true);
    expect(isCommand({ type: "START_RX", requestId: "a" })).toBe(false);
    expect(isCommand({ type: "STOP_ALL", requestId: "b" })).toBe(true);
    expect(isCommand({ type: "NOPE", requestId: "c" })).toBe(false);
  });

  it("maps direction languages", () => {
    expect(targetLanguageFor("rx")).toBe("ja");
    expect(targetLanguageFor("tx")).toBe("en");
  });

  it("estimates bidirectional cost", () => {
    expect(estimateCostUsd(60_000, 60_000)).toBe(0.068);
  });

  it("clamps gains", () => {
    expect(clampGain(1.5)).toBe(1);
    expect(clampGain(-1)).toBe(0);
    expect(clampGain(0.2)).toBe(0.2);
  });

  it("detects virtual devices", () => {
    expect(isBlackHoleLabel("BlackHole 2ch")).toBe(true);
    expect(isLikelyVirtualInput("VB-Audio Cable")).toBe(true);
    expect(isLikelyVirtualInput("MacBook Pro Microphone")).toBe(false);
  });

  it("classifies broker HTTP errors", () => {
    expect(classifyHttpError(401, "x").code).toBe("BROKER_UNAUTHORIZED");
    expect(classifyHttpError(429, "x").code).toBe("BROKER_RATE_LIMITED");
    expect(classifyHttpError(504, "x").code).toBe("BROKER_TIMEOUT");
  });

  it("fills default settings", () => {
    const s = createDefaultSettings("https://example.workers.dev");
    expect(s.schemaVersion).toBe(1);
    expect(s.brokerBaseUrl).toBe("https://example.workers.dev");
    expect(s.originalGain).toBe(0.2);
  });
});

describe("errors and transcript", () => {
  it("asserts generation", () => {
    expect(() => assertGeneration(1, 1)).not.toThrow();
    expect(() => assertGeneration(1, 2)).toThrow(GenerationStaleError);
  });

  it("merges transcript without invented spaces", () => {
    expect(mergeTranscript("こんにちは", "世界")).toBe("こんにちは世界");
  });
});
