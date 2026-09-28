import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone release script intentionally has no declaration file.
import { cleanupBudget, closeDesktop } from "../scripts/smoke-cleanup.mjs";
// @ts-expect-error Standalone release script intentionally has no declaration file.
import { smokeOutcome } from "../scripts/smoke-render-report.mjs";

describe("desktop smoke cleanup", () => {
  afterEach(() => vi.useRealTimers());
  const child = () => Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
  it("allows Windows Muse a bounded two-minute cleanup window", () => {
    expect(cleanupBudget("muse", "win32")).toBe(120_000);
    expect(cleanupBudget("grok", "win32")).toBe(15_000);
    expect(cleanupBudget("muse", "linux")).toBe(15_000);
  });
  it.each([100, 35_000])("records actual exit and warns without failing passed scenarios after %ims", async delay => {
    vi.useFakeTimers();
    const proc = child(), record = vi.fn();
    const app = { close: () => new Promise<void>(resolve => setTimeout(() => { proc.exitCode = 0; proc.emit("exit"); resolve(); }, delay)) };
    const pending = closeDesktop(app, proc, { budgetMs: 120_000, now: () => Date.now(), record });
    await vi.advanceTimersByTimeAsync(delay);
    const row = await pending;
    expect(row).toMatchObject({ result: delay > 15_000 ? "WARNING" : "PASS", durationMs: delay, exitMs: delay });
    expect(smokeOutcome([{ result: "PASS" }, row]).exitCode).toBe(0);
    expect(smokeOutcome([{ result: "FAIL" }, row]).exitCode).toBe(1);
    expect(record.mock.calls.map(c => c[0])).toEqual(["desktop-quit-requested", "desktop-exit", "desktop-cleanup"]);
    expect(proc.listenerCount("exit")).toBe(0);
  });
  it("fails when close resolves but the process never exits", async () => {
    vi.useFakeTimers();
    const proc = child();
    const pending = closeDesktop({ close: async () => {} }, proc, { budgetMs: 120_000, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(120_000);
    const row = await pending;
    expect(row).toMatchObject({ result: "FAIL", exitMs: null, durationMs: 120_000 });
    expect(row.reason).toContain("app exit not observed");
    expect(smokeOutcome([{ result: "PASS" }, row]).exitCode).toBe(1);
    expect(proc.listenerCount("exit")).toBe(0);
  });
  it("retains transport errors even when the app exits", async () => {
    const proc = child();
    const row = await closeDesktop({ close: async () => { proc.exitCode = 0; proc.emit("exit"); throw new Error("close failed"); } }, proc, { budgetMs: 100 });
    expect(row.result).toBe("FAIL");
    expect(row.reason).toContain("close failed");
  });
  it.each(["muse", "claude"])("%s distinguishes a slow Windows child from an app that did not exit", async provider => {
    vi.useFakeTimers();
    const proc = child();
    const pending = closeDesktop({ close: () => new Promise(() => {
      setTimeout(() => { proc.exitCode = 0; proc.emit("exit"); }, 250);
    }) }, proc, { budgetMs: 120_000, provider, platform: "win32", now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(120_000);
    const row = await pending;
    expect(row).toMatchObject({ result: provider === "muse" ? "WARNING" : "FAIL", exitMs: 250, durationMs: 120_000 });
    if (provider === "muse") {
      expect(row.reason).toContain("Muse child process");
      expect(row.reason).toContain("Electron app exited at 250ms");
      expect(smokeOutcome([{ result: "PASS" }, row]).exitCode).toBe(0);
    }
  });
});
