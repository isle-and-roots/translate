import {
  BROKER_TIMEOUT_MS,
  classifyHttpError,
  type Direction,
  type TokenIssueResponse,
  targetLanguageFor,
} from "../../shared/protocol.js";
import { appError } from "../../shared/errors.js";

export interface BrokerConfig {
  baseUrl: string;
  getPairingToken: () => Promise<string | null>;
}

export function createBrokerClient(config: BrokerConfig) {
  return {
    async issue(direction: Direction): Promise<TokenIssueResponse> {
      const pairing = await config.getPairingToken();
      if (!pairing) {
        throw appError(
          "MISSING_PAIRING",
          "接続コードが未設定です。setup画面で入力してください。",
        );
      }

      const base = config.baseUrl.replace(/\/$/, "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);

      try {
        const response = await fetch(`${base}/api/translation-token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pairing}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ direction }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw classifyHttpError(
            response.status,
            `トークン発行に失敗しました (${response.status})`,
          );
        }

        const json = (await response.json()) as Partial<TokenIssueResponse>;
        if (!json.clientSecret || typeof json.clientSecret !== "string") {
          throw appError("BROKER_UPSTREAM", "トークン応答が不正です");
        }

        return {
          clientSecret: json.clientSecret,
          expiresAt: json.expiresAt ?? null,
          direction,
          targetLanguage: json.targetLanguage ?? targetLanguageFor(direction),
          requestId: json.requestId ?? crypto.randomUUID(),
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw appError("BROKER_TIMEOUT", "トークン発行がタイムアウトしました");
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
