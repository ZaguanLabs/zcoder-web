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

export async function readRpcJson<T = unknown>(response: Response): Promise<T> {
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
