export type DiscordFailureKind = "permanent" | "temporary";

export interface DiscordFailure {
  kind: DiscordFailureKind;
  reason: "discord member not found" | "discord permission denied" | "temporary discord api failure";
  retryAfterMs?: number;
}

type ErrorLike = { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown; retryAfter?: unknown; rawError?: { code?: unknown; retry_after?: unknown; status?: unknown }; cause?: { code?: unknown; name?: unknown } };

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === "object" && error !== null ? error as ErrorLike : {};
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function retryAfterMs(error: ErrorLike): number | undefined {
  // @discordjs/rest's RateLimitError exposes milliseconds, while the raw
  // Discord JSON field `retry_after` is expressed in seconds.
  if (error.name === "RateLimitError") {
    const milliseconds = numeric(error.retryAfter);
    return milliseconds === undefined ? undefined : Math.min(Math.max(milliseconds, 250), 10_000);
  }
  const seconds = numeric(error.rawError?.retry_after);
  return seconds === undefined ? undefined : Math.min(Math.max(seconds * 1_000, 250), 10_000);
}

export function classifyDiscordError(error: unknown, resource: "member" | "channel" | "permission" = "permission"): DiscordFailure {
  const value = asErrorLike(error);
  const status = numeric(value.status) ?? numeric(value.statusCode) ?? numeric(value.rawError?.status);
  const code = numeric(value.code) ?? numeric(value.rawError?.code);
  const name = typeof value.name === "string" ? value.name : typeof value.cause?.name === "string" ? value.cause.name : "";
  const networkCode = typeof value.code === "string" ? value.code : typeof value.cause?.code === "string" ? value.cause.code : "";

  if (status === 404 || code === 10007 || (resource === "channel" && code === 10003)) {
    return { kind: "permanent", reason: resource === "member" ? "discord member not found" : "discord permission denied" };
  }
  if (status === 403 || code === 50001 || code === 50013 || code === 50007) {
    return { kind: "permanent", reason: "discord permission denied" };
  }
  if (status === 429 || (status !== undefined && status >= 500 && status <= 599) || name === "RateLimitError" || name === "HTTPError" || name === "AbortError" || name === "TimeoutError" || /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/.test(networkCode)) {
    const delay = retryAfterMs(value);
    return { kind: "temporary", reason: "temporary discord api failure", ...(delay !== undefined ? { retryAfterMs: delay } : {}) };
  }

  // Unknown failures remain fail-closed and use the finite retry path instead
  // of being mistaken for a permanent denial.
  return { kind: "temporary", reason: "temporary discord api failure" };
}
