// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { isPageVisible, onPageVisible, waitForPageVisible } from "./visibility";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("visibility gating", () => {
  afterEach(() => setVisibility("visible"));

  it("treats only a showing page as visible", () => {
    setVisibility("visible");
    expect(isPageVisible()).toBe(true);
    setVisibility("hidden");
    expect(isPageVisible()).toBe(false);
  });

  it("resolves at once when the page is already showing", async () => {
    setVisibility("visible");
    await expect(waitForPageVisible()).resolves.toBeUndefined();
  });

  it("suspends while hidden and resumes on the way back", async () => {
    setVisibility("hidden");
    let resumed = false;
    const waiting = waitForPageVisible().then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    setVisibility("visible");
    await waiting;
    expect(resumed).toBe(true);
  });

  it("stays suspended for a change that is still not showing", async () => {
    setVisibility("hidden");
    let resumed = false;
    const waiting = waitForPageVisible().then(() => { resumed = true; });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(resumed).toBe(false);
    setVisibility("visible");
    await waiting;
    expect(resumed).toBe(true);
  });

  it("rejects a suspended wait when the caller aborts", async () => {
    setVisibility("hidden");
    const controller = new AbortController();
    const waiting = waitForPageVisible(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects at once when the signal is already aborted", async () => {
    setVisibility("hidden");
    const controller = new AbortController();
    controller.abort();
    await expect(waitForPageVisible(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fires only on the way back and stops after unsubscribing", () => {
    setVisibility("hidden");
    let wakes = 0;
    const stop = onPageVisible(() => { wakes += 1; });
    setVisibility("hidden");
    expect(wakes).toBe(0);
    setVisibility("visible");
    expect(wakes).toBe(1);
    stop();
    setVisibility("visible");
    expect(wakes).toBe(1);
  });
});
