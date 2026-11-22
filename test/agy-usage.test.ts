import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agySubscriptionWindows, AgyUsageMeter, agyWindowsForModel } from "../src/agy-usage";
import { AgyBackend } from "../src/agy-backend";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const rows = [
  "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-28T13:40:10Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-22T05:29:32Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-29T02:59:30Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-22T07:59:30Z",
].join("\r\n");
const time = Date.parse("2026-11-22T02:00:00Z");

describe("Antigravity CLI quota", () => {
  beforeEach(() => { vi.mocked(execFile).mockReset(); });

  it("reads all four tab-separated windows", () => {
    const windows = agySubscriptionWindows(rows, time);
    expect(windows.map(({ periodType, label, usedPercent, periodEnd, observedAt }) =>
      [periodType, label, usedPercent, periodEnd, observedAt])).toEqual([
      ["gemini_weekly", "Gemini · Weekly", 0, "2026-11-28T13:40:10.000Z", "2026-11-22T02:00:00.000Z"],
      ["gemini_5h", "Gemini · 5-hour", 0, "2026-11-22T05:29:32.000Z", "2026-11-22T02:00:00.000Z"],
      ["claude-gpt_weekly", "Claude & GPT · Weekly", 0, "2026-11-29T02:59:30.000Z", "2026-11-22T02:00:00.000Z"],
      ["claude-gpt_5h", "Claude & GPT · 5-hour", 0, "2026-11-22T07:59:30.000Z", "2026-11-22T02:00:00.000Z"],
    ]);
    expect(agyWindowsForModel(windows, "gemini-4-argon")).toEqual(windows.slice(0, 2));
    expect(agyWindowsForModel(windows, "gpt-oss")).toEqual(windows.slice(2));
  });

  it("ignores garbage, invalid dates and percentages outside 0–100", () => {
    const noise = [
      "Open AI Studio for usage.",
      "Other Models\tWeekly Limit Remaining\t100%\t2026-11-22T07:59:30Z",
      "Gemini Models\tWeekly Limit Remaining\t101%\t2026-11-22T07:59:30Z",
      "Gemini Models\tWeekly Limit Remaining\t80%\t2026-02-31T00:00:00Z",
    ];
    expect(agySubscriptionWindows(noise.join("\n"), time)).toEqual([]);
    expect(agySubscriptionWindows(rows.replace("100%", "75.5%"), time)[0].usedPercent).toBe(24.5);
  });

  it.each([0, 2])("runs one bounded print command, giving exit %s its proper meaning", async code => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, output: string) => void;
      queueMicrotask(() => callback(code ? Object.assign(new Error("no account quota"), { code }) : null, rows));
      return {} as ReturnType<typeof execFile>;
    });
    const signal = new AbortController().signal;
    const meter = new AgyUsageMeter("fake-agy", { PATH: "/test", GEMINI_API_KEY: "fixture", google_api_key: "inherited" }, signal);
    expect(await meter.read("gemini-api-key")).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
    const read = meter.read("oauth-personal");
    expect(meter.read("oauth-personal")).toBe(read);
    expect(await read).toHaveLength(code === 2 ? 0 : 4);
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith("fake-agy", ["-p", "/usage"], {
      env: { PATH: "/test", AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
      signal, timeout: 10_000, maxBuffer: 65_536, windowsHide: true,
    }, expect.any(Function));
  });

  it("offers print-mode usage from the verified CLI version onward", async () => {
    const meter = new AgyUsageMeter("fake-agy", {});
    const read = vi.spyOn(meter, "read").mockResolvedValue([]);
    const backend = new AgyBackend({ usageMeter: meter });
    backend.steeringCapabilities({ agentInfo: { version: "1.5.7" } });
    expect(backend.subscriptionCredentialContext()).toBeUndefined();
    expect(await backend.readSubscriptionUsage()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    backend.steeringCapabilities({ agentInfo: { version: "1.5.8" } });
    expect(backend.subscriptionCredentialContext()).toBe("agy:cli");
    await backend.readSubscriptionUsage();
    expect(read).toHaveBeenCalledOnce();
  });
});
