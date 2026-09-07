import { describe, it, expect, vi } from "vitest";
import { modeToRemember, rememberedEffort, startsInYolo } from "../src/mode-prefs";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

describe("remembered mode preference (#25)", () => {
  it("remembers a switch to Agent or Auto accept, but never Plan", () => {
    expect(modeToRemember("agent")).toBe("agent");
    expect(modeToRemember("yolo")).toBe("yolo");
    // Plan is a transient per-task choice — leave the remembered preference alone.
    expect(modeToRemember("plan")).toBeNull();
  });

  it("starts a NEW session in Auto accept only when that's the remembered mode", () => {
    expect(startsInYolo("yolo", false)).toBe(true);
    expect(startsInYolo("agent", false)).toBe(false);
    expect(startsInYolo("", false)).toBe(false); // unset = Agent
    expect(startsInYolo(undefined, false)).toBe(false);
  });

  it("never pre-applies the remembered mode on a resume (those are verdict-driven)", () => {
    expect(startsInYolo("yolo", true)).toBe(false);
    expect(startsInYolo("agent", true)).toBe(false);
  });
});

describe("remembered effort by provider (#151)", () => {
  it("uses only the provider's own preference, with the legacy fallback for Grok", () => {
    const prefs = { claude: "low", codex: "medium" };
    expect(rememberedEffort(prefs, "claude", "high")).toBe("low");
    expect(rememberedEffort(prefs, "codex", "high")).toBe("medium");
    expect(rememberedEffort(prefs, "grok", "high")).toBe("high");
    expect(rememberedEffort(undefined, "claude", "high")).toBe("");
    expect(rememberedEffort(undefined, "codex", "high")).toBe("");
    expect(rememberedEffort(undefined, "grok", undefined)).toBe("");
  });

  it("keeps a cleared adapter preference at the provider default", () => {
    expect(rememberedEffort({ claude: "" }, "claude", "high")).toBe("");
  });
});

describe("effort picker persistence", () => {
  function picker(provider: "grok" | "claude" | "codex") {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    session.provider = provider;
    session.cwd = "/project";
    session.hasHistory = true;
    session.client = { currentModelSupportsEffort: () => true, setReasoningEffort: vi.fn(async () => true) } as any;
    const values: Record<string, unknown> = {};
    const cfg = { get: () => "high", update: vi.fn(async () => {}) };
    sidebar.focused = session;
    sidebar.host = { getConfiguration: () => cfg };
    sidebar.state = {
      get: (key: string, fallback: unknown) => values[key] ?? fallback,
      update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
    };
    sidebar.workspaceRoot = () => "/project";
    sidebar.startSession = vi.fn();
    sidebar.restartSession = vi.fn();
    sidebar.discardAdapterEmptySession = vi.fn();
    sidebar.discardRestartedEmptySession = vi.fn();
    sidebar.pickRestartMode = vi.fn(async () => "clear");
    return { sidebar, session, cfg, values };
  }

  it.each(["grok", "claude", "codex"] as const)("remembers a successful live %s change without changing another provider", async (provider) => {
    const { sidebar, session, cfg, values } = picker(provider);
    await sidebar.onMessage({ type: "setEffort", level: "low" }, "local");
    expect(session.client!.setReasoningEffort).toHaveBeenCalledWith("low");
    if (provider === "grok") {
      expect(cfg.update).toHaveBeenCalledWith("defaultEffort", "low", "global");
    } else {
      expect(cfg.update).not.toHaveBeenCalled();
      expect(values["grok.defaultEffortByProvider"]).toEqual({ [provider]: "low" });
    }
    expect(sidebar.restartSession).not.toHaveBeenCalled();
  });

  it.each([false, true])("remembers an adapter reset for the restart path (empty=%s)", async (empty) => {
    const { sidebar, session, cfg, values } = picker("claude");
    session.hasHistory = !empty;
    values["grok.defaultEffortByProvider"] = { claude: "low", codex: "medium" };
    await sidebar.onMessage({ type: "setEffort", level: "" }, "local");
    expect(values["grok.defaultEffortByProvider"]).toEqual({ claude: "", codex: "medium" });
    expect(cfg.update).not.toHaveBeenCalled();
    expect(empty ? sidebar.startSession : sidebar.restartSession).toHaveBeenCalled();
  });

  it("does not remember a rejected live change when restart is dismissed", async () => {
    const { sidebar, session, cfg } = picker("claude");
    vi.mocked(session.client!.setReasoningEffort).mockResolvedValue(false);
    sidebar.pickRestartMode.mockResolvedValue(undefined);
    await sidebar.onMessage({ type: "setEffort", level: "low" }, "local");
    expect(sidebar.state.update).not.toHaveBeenCalled();
    expect(cfg.update).not.toHaveBeenCalled();
  });
});
