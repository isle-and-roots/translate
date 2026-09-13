import { describe, expect, it } from "vitest";
import type { MeetingState } from "../shared/protocol";

function composeMeetingState(
  rx: string,
  tx: string,
  hasTabStream: boolean,
): MeetingState {
  if (rx === "error" || tx === "error" || rx === "reconnecting") return "DEGRADED";
  if (rx === "active" && tx === "active") return "ACTIVE_BOTH";
  if (rx === "active") return "ACTIVE_RX";
  if (rx === "connecting" || tx === "connecting") {
    return tx === "connecting" ? "CONNECTING_TX" : "CONNECTING_RX";
  }
  if (hasTabStream) return "CAPTURING";
  return "IDLE";
}

describe("meeting state composition", () => {
  it("keeps RX-only and both-active distinct", () => {
    expect(composeMeetingState("active", "off", true)).toBe("ACTIVE_RX");
    expect(composeMeetingState("active", "active", true)).toBe("ACTIVE_BOTH");
  });

  it("marks degraded on RX reconnect or errors", () => {
    expect(composeMeetingState("reconnecting", "active", true)).toBe("DEGRADED");
    expect(composeMeetingState("error", "off", true)).toBe("DEGRADED");
  });

  it("returns IDLE when nothing is captured", () => {
    expect(composeMeetingState("off", "off", false)).toBe("IDLE");
  });
});
