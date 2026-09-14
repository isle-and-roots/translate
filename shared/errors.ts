import type { AppError, ErrorCode } from "./protocol.js";

export function appError(
  code: ErrorCode,
  message: string,
  details?: string,
): AppError {
  return details ? { code, message, details } : { code, message };
}

export function toAppError(error: unknown, fallback: ErrorCode = "UNKNOWN"): AppError {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const e = error as AppError;
    return {
      code: e.code,
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
    };
  }
  if (error instanceof Error) {
    return appError(fallback, error.message);
  }
  return appError(fallback, String(error));
}

export class GenerationStaleError extends Error {
  readonly code = "GENERATION_STALE" as const;
  constructor(message = "処理世代が古くなりました") {
    super(message);
    this.name = "GenerationStaleError";
  }
}

export function assertGeneration(
  expected: number,
  actual: number,
  label = "generation",
): void {
  if (expected !== actual) {
    throw new GenerationStaleError(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}
