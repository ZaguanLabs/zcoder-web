type Attempt = { count: number; resetAt: number; blockedUntil: number };

const attempts = new Map<string, Attempt>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_TRACKED_CLIENTS = 10_000;

function prune(now: number) {
  if (attempts.size < MAX_TRACKED_CLIENTS) return;
  for (const [key, attempt] of attempts) {
    if (attempt.resetAt <= now) attempts.delete(key);
  }
  if (attempts.size >= MAX_TRACKED_CLIENTS) attempts.delete(attempts.keys().next().value as string);
}

export function loginLimit(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  prune(now);
  const existing = attempts.get(key);
  if (!existing || existing.resetAt <= now) {
    attempts.set(key, { count: 0, resetAt: now + WINDOW_MS, blockedUntil: 0 });
    return { allowed: true, retryAfter: 0 };
  }
  if (existing.blockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((existing.blockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key) ?? { count: 0, resetAt: now + WINDOW_MS, blockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    const exponent = Math.min(entry.count - MAX_ATTEMPTS, 5);
    entry.blockedUntil = now + 30_000 * 2 ** exponent;
  }
  attempts.set(key, entry);
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}
