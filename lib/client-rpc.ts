const TRANSIENT_STATUSES = new Set([502, 503, 504]);

export class RpcResponseError extends Error {
  constructor(message: string, public readonly retryable = false, public readonly status?: number) {
    super(message);
    this.name = "RpcResponseError";
  }
}

function responseError(data: unknown, status: number): string {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return `Request failed (${status})`;
}

export async function readRpcJson<T = unknown>(response: Response, onUnauthorized?: () => void): Promise<T> {
  if (response.status === 401 && response.headers.get("X-Zweb-Auth") === "required") onUnauthorized?.();
  const body = await response.text();
  let data: unknown;

  try {
    data = JSON.parse(body);
  } catch {
    if (TRANSIENT_STATUSES.has(response.status)) {
      throw new RpcResponseError("Service temporarily unavailable during restart", true, response.status);
    }
    throw new RpcResponseError(response.ok ? "Server returned an invalid response" : `Request failed (${response.status})`, false, response.status);
  }

  if (!response.ok) throw new RpcResponseError(responseError(data, response.status), TRANSIENT_STATUSES.has(response.status), response.status);
  return data as T;
}

export function isTransientRpcError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof RpcResponseError && error.retryable);
}

/**
 * Retry ladder for a lost event stream, indexed by how many attempts have
 * already failed. A zcoder restart holds the upstream down for roughly fifteen
 * seconds, and a flat short delay stops trying before it comes back; climbing
 * instead lands the later attempts after the restart has finished.
 */
const EVENT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];

export function eventRetryDelayMs(failureCount: number): number {
  const index = Math.min(Math.max(failureCount, 0), EVENT_RETRY_DELAYS_MS.length - 1);
  return EVENT_RETRY_DELAYS_MS[index] ?? 4_000;
}
