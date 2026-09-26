import { describe, it, expect, vi } from "vitest";
import { modeToRemember, rememberedEffort, sessionModes, startsInYolo } from "../src/mode-prefs";
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

  it("offers Plan to Grok and Claude only", () => {
    expect(sessionModes("grok")).toEqual(["agent", "plan", "yolo"]);
    expect(sessionModes("claude")).toEqual(["agent", "plan", "yolo"]);
    expect(sessionModes("codex")).toEqual(["agent", "yolo"]);
    expect(sessionModes("muse")).toEqual(["agent", "yolo"]);
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
  function picker(provider: "grok" | "claude" | "codex" | "muse") {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    session.provider = provider;
    session.cwd = "/project";
    session.hasHistory = true;
    session.client = {
      currentReasoningEffort: "high",
      currentModelSupportsEffort: () => true,
      setReasoningEffort: vi.fn(async (level) => { session.client!.currentReasoningEffort = level; return true; }),
    } as any;
    const values: Record<string, unknown> = {};
    // VS Code's real semantics: `update` writes ONE scope, `get` returns the
    // EFFECTIVE value. This fake used to be `{ get: () => "high", update:
    // vi.fn() }` — a `get` that ignored every write — so a write landing in a
    // scope nothing reads back was invisible here by construction. That is how
    // #162 shipped; test/effort-scope.test.ts covers the scopes themselves.
    const scopes: { global: string; workspace?: string } = { global: "high" };
    const cfg = {
      get: (_key: string, fallback = "") =>
        scopes.workspace !== undefined ? scopes.workspace : (scopes.global || fallback),
      inspect: (key: string) => ({ key, globalValue: scopes.global, workspaceValue: scopes.workspace }),
      update: vi.fn(async (_key: string, value: string, target: string) => {
        if (target === "global") scopes.global = value;
        else scopes.workspace = value;
      }),
    };
    sidebar.focused = session;
    sidebar.host = { getConfiguration: () => cfg };
    sidebar.state = {
      get: (key: string, fallback: unknown) => values[key] ?? fallback,
      update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
    };
    sidebar.workspaceRoot = () => "/project";
    sidebar.context = { extensionVersion: "test" };
    sidebar.emit = vi.fn();
    sidebar.startSession = vi.fn();
    sidebar.restartSession = vi.fn();
    sidebar.discardAdapterEmptySession = vi.fn();
    sidebar.discardRestartedEmptySession = vi.fn();
    sidebar.pickRestartMode = vi.fn(async () => "clear");
    return { sidebar, session, cfg, values };
  }

  it.each(["grok", "claude", "codex", "muse"] as const)("remembers a successful live %s change without changing another provider", async (provider) => {
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
    // Nothing is emitted back. `emit` buffers into the session replay and fans
    // to every remote holder, and `initialState` is action-shaped there — a
    // phone reads it as "restore the remembered conversation" and reloads its
    // own transcript. The chip is optimistic and reconciles on the next real
    // `initialState`, which is what the effort dots did before it.
    expect(sidebar.emit).not.toHaveBeenCalled();
  });

  it("applies a Muse picker change live and reads back its own saved effort", async () => {
    const { sidebar, session, cfg, values } = picker("muse");
    values["grok.defaultEffortByProvider"] = { codex: "medium", claude: "low" };
    await sidebar.onMessage({ type: "setEffort", level: "ultra" }, "local");
    expect(session.client!.setReasoningEffort).toHaveBeenCalledWith("ultra");
    expect(values["grok.defaultEffortByProvider"]).toEqual({ codex: "medium", claude: "low", muse: "ultra" });
    expect(sidebar.defaultEffortForProvider("muse")).toBe("ultra");
    expect(cfg.update).not.toHaveBeenCalled();
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.restartSession).not.toHaveBeenCalled();
    expect(sidebar.pickRestartMode).not.toHaveBeenCalled();
  });

  it("remembers a Muse picker change before restarting an empty session", async () => {
    const { sidebar, session } = picker("muse");
    session.hasHistory = false;
    sidebar.startSession.mockImplementation(async () => {
      expect(sidebar.defaultEffortForProvider("muse")).toBe("max");
    });
    await sidebar.onMessage({ type: "setEffort", level: "max" }, "local");
    expect(sidebar.startSession).toHaveBeenCalledWith(undefined, session);
    expect(session.client!.setReasoningEffort).not.toHaveBeenCalled();
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
    expect(sidebar.emit).not.toHaveBeenCalled();
  });

  it.each(["grok", "claude", "codex"] as const)("warns a remote %s effort change and sends it no session frame", async (provider) => {
    const { sidebar, session } = picker(provider);
    session.client!.currentModelSupportsEffort = () => false;
    sidebar.remoteClients = { active: () => session, cwd: () => "/project" };
    sidebar.captureRemoteRequester = () => ({ clientId: "phone", session });
    sidebar.reportRequester = vi.fn();
    await sidebar.onMessage({ type: "setEffort", level: "low" }, "remote", "phone");
    expect(sidebar.reportRequester).toHaveBeenCalled();
    expect(sidebar.restartSession).not.toHaveBeenCalled();
    // The refusal is a warning, not a frame. Anything sent through `emit` here
    // reaches the phone AND its replay buffer; `initialState` in particular
    // makes the phone re-resume, clearing and replaying its own transcript.
    expect(sidebar.emit).not.toHaveBeenCalled();
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("applies the model BEFORE the effort when one close of the picker changed both", async () => {
    const { sidebar, session, values } = picker("codex");
    const order: string[] = [];
    sidebar.switchModel = vi.fn(async () => { order.push("model"); });
    vi.mocked(session.client!.setReasoningEffort)
      .mockImplementation(async () => { order.push("effort"); return true; });

    await sidebar.onMessage(
      { type: "setModel", modelId: "gpt-6-astra", provider: "codex", effort: "high" },
      "local",
    );

    // A switch carries a live effort override through when the target offers
    // it, so the level has to be applied after the model, not before.
    expect(order).toEqual(["model", "effort"]);
    expect(values["grok.defaultEffortByProvider"]).toEqual({ codex: "high" });
  });

  it("changes nothing about effort when setModel carries no level", async () => {
    const { sidebar, session } = picker("codex");
    sidebar.switchModel = vi.fn(async () => {});
    await sidebar.onMessage({ type: "setModel", modelId: "gpt-6-astra", provider: "codex" }, "local");
    expect(session.client!.setReasoningEffort).not.toHaveBeenCalled();
  });

  it("holds a send until the picker's commit has landed", async () => {
    const { sidebar } = picker("codex");
    let land!: () => void;
    sidebar.switchModel = vi.fn(() => new Promise<void>((resolve) => { land = resolve; }));
    const reached: string[] = [];
    // The first thing handleSend does after settling the picker.
    sidebar.waitForSessionStart = vi.fn(async () => { reached.push("send"); throw new Error("far enough"); });

    void sidebar.onMessage({ type: "setModel", modelId: "gpt-6-astra", provider: "codex" }, "local");
    await tick();
    const send = sidebar.handleSend("hello").catch(() => {});
    await tick();
    expect(reached).toEqual([]); // "This must happen before the message is sent."

    land();
    await send;
    expect(reached).toEqual(["send"]);
  });

  it("leaves a summarized restart alone instead of finishing it off as an empty session", async () => {
    const { sidebar, session, cfg } = picker("grok");
    session.activeSessionId = "before";
    // What Summarize & Restart leaves behind: a session that HOLDS the summary,
    // and whose `hasHistory` the restart's own startSession has just cleared.
    sidebar.switchModel = vi.fn(async () => {
      session.activeSessionId = "holds-the-summary";
      session.hasHistory = false;
    });

    await sidebar.onMessage(
      { type: "setModel", modelId: "grok-composer-2.5", effort: "low" },
      "local",
    );

    // Read as empty, that session was restarted again and deleted on disk --
    // the person asked to keep the thread and got a blank one.
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.discardRestartedEmptySession).not.toHaveBeenCalled();
    expect(session.client!.setReasoningEffort).not.toHaveBeenCalled();
    expect(session.activeSessionId).toBe("holds-the-summary");
    // The restart still spawned at the level the picker was showing, because
    // it is remembered BEFORE the switch rather than applied after it.
    expect(cfg.update).toHaveBeenCalledWith("defaultEffort", "low", "global");
  });

  it("does not let a restart prompt nobody answers swallow the send behind it", async () => {
    const { sidebar, session } = picker("claude");
    vi.mocked(session.client!.setReasoningEffort).mockResolvedValue(false);
    delete sidebar.pickRestartMode; // the real one, which releases the wait
    sidebar.host.showInformationMessage = vi.fn(() => new Promise(() => {}));
    const reached: string[] = [];
    sidebar.waitForSessionStart = vi.fn(async () => { reached.push("send"); throw new Error("far enough"); });

    void sidebar.onMessage({ type: "setEffort", level: "low" }, "local");
    await tick();
    expect(sidebar.host.showInformationMessage).toHaveBeenCalled();

    await sidebar.handleSend("hello").catch(() => {});
    expect(reached).toEqual(["send"]);
  });

  it("ignores a change fired mid-session-start, and a dismissed reset persists nothing", async () => {
    const { sidebar, session, cfg } = picker("grok");
    session.priming = true;
    await sidebar.onMessage({ type: "setEffort", level: "low" }, "local");
    expect(session.client!.setReasoningEffort).not.toHaveBeenCalled();
    session.priming = false;
    sidebar.pickRestartMode.mockResolvedValue(undefined);
    await sidebar.onMessage({ type: "setEffort", level: "" }, "local");
    expect(sidebar.restartSession).not.toHaveBeenCalled();
    expect(cfg.update).not.toHaveBeenCalled();
    expect(sidebar.emit).not.toHaveBeenCalled();
  });
});
