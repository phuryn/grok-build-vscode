// The window a model list leaves out: what that model last reported, else the
// agent's default, never the meter's generic 200K (owner, 2026-11-22: Claude
// "it's 1M. Later override it and store it locally when different value arrives").
import { describe, expect, it } from "vitest";
import { adapterContextCount, DEFAULT_MODEL_WINDOWS, rememberModelWindow, withRememberedWindows } from "../src/model-context-windows";

describe("model context windows", () => {
  it("assumes Claude's 1M and Codex's 258,400 before any turn", () => {
    const claude = withRememberedWindows([{ modelId: "sonnet" }], {}, "claude");
    const codex = withRememberedWindows([{ modelId: "gpt-6.2-sol" }], {}, "codex");
    expect(claude[0].totalContextTokens).toBe(1_000_000);
    expect(codex[0].totalContextTokens).toBe(258_400);
    expect(DEFAULT_MODEL_WINDOWS.grok).toBeUndefined();
  });

  it("uses what a model last reported over the default, and the agent's own figure over both", () => {
    const map = rememberModelWindow({}, "claude", "sonnet", 200_000)!;
    const [remembered, advertised, other] = withRememberedWindows(
      [{ modelId: "sonnet" }, { modelId: "opus[1m]", totalContextTokens: 1_000_000 }, { modelId: "haiku" }], map, "claude");
    expect(remembered.totalContextTokens).toBe(200_000);
    expect(advertised.totalContextTokens).toBe(1_000_000);
    expect(other.totalContextTokens).toBe(1_000_000);
  });

  it("keys by the row's own agent in a mixed picker", () => {
    const map = rememberModelWindow({}, "codex", "same-id", 400_000)!;
    const rows = withRememberedWindows([{ modelId: "same-id", provider: "codex" }, { modelId: "same-id", provider: "grok" }], map, "claude");
    expect(rows[0].totalContextTokens).toBe(400_000);
    expect(rows[1].totalContextTokens).toBeUndefined();
  });

  it("records only a real change, and keeps the newest entries when full", () => {
    expect(rememberModelWindow({}, "claude", undefined, 1_000_000)).toBeUndefined();
    expect(rememberModelWindow({}, "claude", "x", 0)).toBeUndefined();
    const once = rememberModelWindow({}, "claude", "x", 1_000_000)!;
    expect(rememberModelWindow(once, "claude", "x", 1_000_000)).toBeUndefined();
    let map = {};
    for (let i = 0; i < 70; i++) map = rememberModelWindow(map, "codex", `m${i}`, 1000 + i)!;
    expect(Object.keys(map)).toHaveLength(64);
    expect(map).not.toHaveProperty("codex:m0");
    expect(map).toHaveProperty("codex:m69", 1069);
  });

  // A reopened Antigravity chat showed 0: the count was not saved, and agy
  // reports 0 for a chat it has not run a turn in during this process.
  it("keeps Antigravity's 0 from replacing a saved count, and other agents' counts as they are", () => {
    expect(adapterContextCount("agy", 0)).toBeUndefined();
    expect(adapterContextCount("agy", 9733)).toBe(9733);
    expect(adapterContextCount("muse", 0)).toBe(0);
    expect(adapterContextCount("deepseek", undefined)).toBeUndefined();
  });
});
