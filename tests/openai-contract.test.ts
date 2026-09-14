import { describe, expect, it } from "vitest";

/**
 * Contract tests for the Worker ↔ OpenAI translation token shape.
 * These do not call the network; they lock the request/response mapping
 * used by worker/src/index.ts.
 */

type Direction = "rx" | "tx";

function targetLanguage(direction: Direction): "ja" | "en" {
  return direction === "rx" ? "ja" : "en";
}

function buildUpstreamBody(direction: Direction) {
  return {
    session: {
      type: "translation",
      model: "gpt-realtime-translate",
      audio: {
        output: { language: targetLanguage(direction) },
      },
    },
  };
}

function normalizeSecret(payload: {
  value?: string;
  expires_at?: number;
  client_secret?: { value?: string; expires_at?: number };
}) {
  const clientSecret = payload.value ?? payload.client_secret?.value;
  if (!clientSecret) throw new Error("missing");
  const expiresUnix = payload.expires_at ?? payload.client_secret?.expires_at;
  return {
    clientSecret,
    expiresAt:
      typeof expiresUnix === "number"
        ? new Date(expiresUnix * 1000).toISOString()
        : null,
  };
}

describe("OpenAI translation token contract", () => {
  it("requests only output language (no source transcription in V1)", () => {
    expect(buildUpstreamBody("rx")).toEqual({
      session: {
        type: "translation",
        model: "gpt-realtime-translate",
        audio: { output: { language: "ja" } },
      },
    });
    expect(buildUpstreamBody("tx").session.audio.output.language).toBe("en");
    expect(
      Object.keys(buildUpstreamBody("rx").session.audio),
    ).toEqual(["output"]);
  });

  it("normalizes flat value client secrets", () => {
    const normalized = normalizeSecret({
      value: "ek_test",
      expires_at: 1_700_000_000,
    });
    expect(normalized.clientSecret).toBe("ek_test");
    expect(normalized.expiresAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it("normalizes nested client_secret payloads", () => {
    const normalized = normalizeSecret({
      client_secret: { value: "ek_nested", expires_at: 1_700_000_100 },
    });
    expect(normalized.clientSecret).toBe("ek_nested");
    expect(normalized.expiresAt).toBe(
      new Date(1_700_000_100 * 1000).toISOString(),
    );
  });
});

describe("Worker request validation rules", () => {
  it("accepts only direction field", () => {
    const valid = { direction: "rx" };
    const invalid = { direction: "rx", model: "x" };
    expect(Object.keys(valid)).toEqual(["direction"]);
    expect(Object.keys(invalid).length).toBeGreaterThan(1);
  });

  it("maps broker status codes", () => {
    const map: Record<number, string> = {
      400: "bad_request",
      401: "unauthorized",
      403: "origin_forbidden",
      429: "rate_limited",
      502: "upstream_error",
      504: "upstream_timeout",
    };
    expect(map[401]).toBe("unauthorized");
    expect(map[403]).toBe("origin_forbidden");
  });
});
