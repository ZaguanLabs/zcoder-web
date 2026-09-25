/**
 * Visibility gating for work that would otherwise run while nobody is looking.
 *
 * zweb is installed as a phone app, so the page is hidden far more often than
 * it is shown. A hidden page should cost the upstream nothing, and everything
 * it missed should collapse into a single run on the way back rather than one
 * run per thing that happened while it was away.
 *
 * The event cursor is durable upstream, so suspending the poll loses no events:
 * it resumes from the seq it stopped at.
 */

/** True only while the page is actually showing. Server-side rendering counts as showing. */
export function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Resolves as soon as the page is showing, and at once when it already is.
 * Rejects with an `AbortError` if `signal` aborts first, so a suspended poll
 * unwinds through the same path as any other cancellation.
 */
export function waitForPageVisible(signal?: AbortSignal): Promise<void> {
  if (isPageVisible()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const detach = () => {
      document.removeEventListener("visibilitychange", onChange);
      signal?.removeEventListener("abort", onAbort);
    };
    const onChange = () => {
      if (!isPageVisible()) return;
      detach();
      resolve();
    };
    const onAbort = () => {
      detach();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    document.addEventListener("visibilitychange", onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Calls `onVisible` each time the page returns to the foreground. Returns the unsubscribe. */
export function onPageVisible(onVisible: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const listener = () => { if (isPageVisible()) onVisible(); };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
