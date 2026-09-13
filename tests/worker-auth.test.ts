import { describe, expect, it } from "vitest";

/**
 * Lightweight integration-style checks for Worker auth helpers.
 * Mirrors worker/src/index.ts logic without Cloudflare runtime.
 */

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("worker auth helpers", () => {
  it("hashes pairing token stably", async () => {
    const hash1 = await sha256Hex("test-token");
    const hash2 = await sha256Hex("test-token");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("compares hashes in constant-ish time", async () => {
    const hash = await sha256Hex("abc");
    expect(timingSafeEqual(hash, hash)).toBe(true);
    expect(timingSafeEqual(hash, "0".repeat(64))).toBe(false);
    expect(timingSafeEqual("a", "ab")).toBe(false);
  });

  it("rejects origin mismatch rule", () => {
    const allowed = "chrome-extension://abcdef";
    const good: string = "chrome-extension://abcdef";
    const evil: string = "https://evil.example";
    const missing: string | null = null;
    expect(good === allowed).toBe(true);
    expect(evil === allowed).toBe(false);
    expect(missing === allowed).toBe(false);
  });
});
