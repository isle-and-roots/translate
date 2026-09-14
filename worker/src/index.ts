export interface Env {
  OPENAI_API_KEY: string;
  PAIRING_TOKEN_SHA256: string;
  ALLOWED_EXTENSION_ORIGIN: string;
  ENABLED: string;
  TOKEN_RATE_LIMITER?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
}

type Direction = "rx" | "tx";

const MODEL = "gpt-realtime-translate";
const MAX_BODY_BYTES = 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

/** Fallback limiter when Cloudflare Rate Limiting binding is not configured. */
const memoryBuckets = new Map<string, number[]>();

function allowMemoryRateLimit(key: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const current = (memoryBuckets.get(key) ?? []).filter((t) => t > cutoff);
  if (current.length >= RATE_LIMIT) {
    memoryBuckets.set(key, current);
    return false;
  }
  current.push(now);
  memoryBuckets.set(key, current);
  return true;
}
function json(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function corsHeaders(origin: string | null, allowed: string): HeadersInit {
  if (!origin || origin !== allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

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

function targetLanguage(direction: Direction): "ja" | "en" {
  return direction === "rx" ? "ja" : "en";
}

function parseDirection(value: unknown): Direction | null {
  return value === "rx" || value === "tx" ? value : null;
}

interface OpenAISecretResponse {
  value?: string;
  expires_at?: number;
  client_secret?: { value?: string; expires_at?: number };
  session?: unknown;
}

function normalizeSecret(payload: OpenAISecretResponse): {
  clientSecret: string;
  expiresAt: string | null;
} {
  const clientSecret = payload.value ?? payload.client_secret?.value;
  if (!clientSecret) {
    throw new Error("missing client secret value");
  }
  const expiresUnix = payload.expires_at ?? payload.client_secret?.expires_at;
  return {
    clientSecret,
    expiresAt:
      typeof expiresUnix === "number"
        ? new Date(expiresUnix * 1000).toISOString()
        : null,
  };
}

async function issueClientSecret(
  env: Env,
  direction: Direction,
): Promise<{ clientSecret: string; expiresAt: string | null }> {
  const language = targetLanguage(direction);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/translations/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "translation",
            model: MODEL,
            audio: {
              output: { language },
            },
          },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      // Do not log upstream body or API key.
      throw new Error(`upstream ${response.status}`);
    }

    const payload = (await response.json()) as OpenAISecretResponse;
    return normalizeSecret(payload);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = env.ALLOWED_EXTENSION_ORIGIN;
    const headers = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS" && url.pathname === "/api/translation-token") {
      if (!origin || origin !== allowed) {
        return json(403, { error: "origin_forbidden" });
      }
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname === "/healthz") {
      return json(200, { ok: true, enabled: env.ENABLED === "true" });
    }

    if (url.pathname !== "/api/translation-token") {
      return json(404, { error: "not_found" }, headers as Record<string, string>);
    }

    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" }, headers as Record<string, string>);
    }

    if (env.ENABLED !== "true") {
      return json(503, { error: "disabled" }, headers as Record<string, string>);
    }

    if (!origin || origin !== allowed) {
      return json(403, { error: "origin_forbidden" }, headers as Record<string, string>);
    }

    const auth = request.headers.get("Authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match?.[1]) {
      return json(401, { error: "unauthorized" }, headers as Record<string, string>);
    }

    const providedHash = await sha256Hex(match[1].trim());
    if (!timingSafeEqual(providedHash, env.PAIRING_TOKEN_SHA256.toLowerCase())) {
      return json(401, { error: "unauthorized" }, headers as Record<string, string>);
    }

    const rateKey = providedHash.slice(0, 16);
    let allowedByRate = true;
    if (env.TOKEN_RATE_LIMITER) {
      const limited = await env.TOKEN_RATE_LIMITER.limit({ key: rateKey });
      allowedByRate = limited.success;
    } else {
      allowedByRate = allowMemoryRateLimit(rateKey);
    }
    if (!allowedByRate) {
      return json(
        429,
        { error: "rate_limited" },
        { ...(headers as Record<string, string>), "retry-after": "60" },
      );
    }

    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) {
      return json(400, { error: "body_too_large" }, headers as Record<string, string>);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid_json" }, headers as Record<string, string>);
    }

    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "direction") {
      return json(400, { error: "unexpected_fields" }, headers as Record<string, string>);
    }

    const direction = parseDirection(body.direction);
    if (!direction) {
      return json(400, { error: "invalid_direction" }, headers as Record<string, string>);
    }

    if (!env.OPENAI_API_KEY) {
      return json(502, { error: "upstream_misconfigured" }, headers as Record<string, string>);
    }

    const requestId = crypto.randomUUID();
    try {
      const issued = await issueClientSecret(env, direction);
      return json(
        200,
        {
          clientSecret: issued.clientSecret,
          expiresAt: issued.expiresAt,
          direction,
          targetLanguage: targetLanguage(direction),
          requestId,
        },
        headers as Record<string, string>,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return json(504, { error: "upstream_timeout", requestId }, headers as Record<string, string>);
      }
      return json(502, { error: "upstream_error", requestId }, headers as Record<string, string>);
    }
  },
};
