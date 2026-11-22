import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";
import { MuseBackend } from "../src/muse-backend";
import { rememberedModelEffort, withModelEffort } from "../src/mode-prefs";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

// The owner's sequence: Opus at High, Sonnet at Low, back to Opus. Before,
// effort was remembered per provider and followed the session, so Opus came
// back at Low. Each model now keeps its own last level.

const LEVELS = ["low", "medium", "high"];

function adapterClient(backend: any, start = { model: "sonnet", effort: "low" }) {
  const client = new AcpClient({ cliPath: "fake", cwd: "/", backend, log: () => {} } as any);
  client.sessionId = "s1";
  client.currentModelId = start.model;
  client.currentReasoningEffort = start.effort;
  client.availableModels = ["opus", "sonnet"].map((modelId) => ({
    modelId, name: modelId, supportsReasoningEffort: true, reasoningEfforts: LEVELS,
  })) as any;
  const calls: string[] = [];
  (client as any).request = vi.fn(async (method: string, params: any) => {
    calls.push(`${method} ${params.configId ?? ""}=${params.value ?? params.modelId ?? ""}`);
    return {};
  });
  (client as any).refreshContextSelection = async () => {};
  client.on("modelChanged", () => calls.push("modelChanged"));
  return { client, calls };
}

describe("effort remembered per model", () => {
  it("stores and reads a level per provider and model", () => {
    let prefs = withModelEffort(undefined, "claude", "opus", "high");
    prefs = withModelEffort(prefs, "claude", "sonnet", "low");
    prefs = withModelEffort(prefs, "codex", "gpt-6.2-sol", "xhigh");
    expect(rememberedModelEffort(prefs, "claude", "opus")).toBe("high");
    expect(rememberedModelEffort(prefs, "claude", "sonnet")).toBe("low");
    expect(rememberedModelEffort(prefs, "codex", "opus")).toBeUndefined();
    expect(rememberedModelEffort(prefs, "claude", undefined)).toBeUndefined();
    expect(rememberedModelEffort(withModelEffort(prefs, "claude", "opus", ""), "claude", "opus")).toBe("");
  });

  it.each([
    ["claude", () => new ClaudeBackend(), "effort"],
    ["codex", () => new CodexBackend(), "reasoning_effort"],
    ["muse", () => new MuseBackend(), "reasoning_effort"],
  ] as const)("%s: a switch states the target's own level before announcing the change", async (_p, make, configId) => {
    const { client, calls } = adapterClient(make());
    await client.setModel("opus", "high");
    expect(calls.filter((call) => call !== "modelChanged" && !call.startsWith("session/set_model")).at(-1))
      .toBe(`session/set_config_option ${configId}=high`);
    expect(calls.at(-1)).toBe("modelChanged");
    expect(client.currentReasoningEffort).toBe("high");
  });

  it("keeps carrying the live level when the target has none of its own", async () => {
    const { client, calls } = adapterClient(new ClaudeBackend());
    await client.setModel("opus", undefined);
    expect(calls).toEqual(["session/set_config_option model=opus", "modelChanged"]);
    expect(client.currentReasoningEffort).toBe("low");
  });

  it("sends no extra call when the remembered level is already the live one, or is not offered", async () => {
    for (const preferred of ["low", "max", ""]) {
      const { client, calls } = adapterClient(new ClaudeBackend());
      await client.setModel("opus", preferred);
      expect(calls, preferred).toEqual(["session/set_config_option model=opus", "modelChanged"]);
    }
  });

  it("grok carries the target's own level inside set_model", async () => {
    const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, grokVersion: "1.0.46", grokVersionVerified: true });
    client.sessionId = "s1";
    client.currentModelId = "grok-a";
    client.currentReasoningEffort = "low";
    client.availableModels = ["grok-a", "grok-b"].map((modelId) => ({
      modelId, name: modelId, supportsReasoningEffort: true, reasoningEfforts: LEVELS,
    })) as any;
    const request = vi.fn(async (_method: string, params: any) => ({ _meta: { model: { Ok: params.modelId } } }));
    (client as any).request = request;
    (client as any).refreshContextSelection = async () => {};
    await client.setModel("grok-b", "high");
    expect(request).toHaveBeenCalledWith("session/set_model", { sessionId: "s1", modelId: "grok-b", _meta: { reasoningEffort: "high" } });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function sidebarFor(provider: "claude" | "codex") {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = provider;
  session.cwd = "/project";
  session.hasHistory = true;
  const client: any = {
    currentModelId: "opus",
    currentReasoningEffort: "high",
    currentModelSupportsEffort: () => true,
    setModel: vi.fn(async (modelId: string, preferred?: string) => {
      client.currentModelId = modelId;
      if (preferred) client.currentReasoningEffort = preferred;
    }),
    setReasoningEffort: vi.fn(async (level: string) => { client.currentReasoningEffort = level; return true; }),
  };
  session.client = client;
  const values: Record<string, unknown> = {};
  sidebar.focused = session;
  sidebar.host = { getConfiguration: () => ({ get: (_k: string, f = "") => f, inspect: () => ({}), update: vi.fn() }) };
  sidebar.state = {
    get: (key: string, fallback: unknown) => values[key] ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
  };
  sidebar.workspaceRoot = () => "/project";
  sidebar.pendingAgyForkHandoff = () => undefined;
  sidebar.emit = vi.fn();
  sidebar.restartSession = vi.fn();
  sidebar.pickRestartMode = vi.fn(async () => "clear");
  return { sidebar, session, client, values };
}

describe("the picker remembers effort per model", () => {
  it("Opus High, Sonnet Low, back to Opus runs at High", async () => {
    const { sidebar, client, values } = sidebarFor("claude");
    await sidebar.switchModel("sonnet");
    // Sonnet has no level of its own yet: the live High carries, as before.
    expect(client.setModel).toHaveBeenLastCalledWith("sonnet", undefined);
    await sidebar.onMessage({ type: "setEffort", level: "low" }, "local");
    expect(client.currentReasoningEffort).toBe("low");
    await sidebar.switchModel("opus");
    expect(client.setModel).toHaveBeenLastCalledWith("opus", "high");
    expect(values["grok.defaultEffortByModel"]).toEqual({ claude: { opus: "high", sonnet: "low" } });
    // The provider's last level stays the fallback for a model never set.
    expect(values["grok.defaultEffortByProvider"]).toEqual({ claude: "low" });
  });

  it("a new chat starts at its model's own level, else the provider's", () => {
    const { sidebar, values } = sidebarFor("claude");
    values["grok.defaultEffortByProvider"] = { claude: "low" };
    values["grok.defaultEffortByModel"] = { claude: { opus: "high" } };
    expect(sidebar.defaultEffortForProvider("claude", "opus")).toBe("high");
    expect(sidebar.defaultEffortForProvider("claude", "haiku")).toBe("low");
    expect(sidebar.defaultEffortForProvider("claude")).toBe("low");
  });

  it("one picker close that changed model and effort remembers the level for the target model", async () => {
    const { sidebar, client, values } = sidebarFor("codex");
    sidebar.switchModel = vi.fn(async (modelId: string) => { client.currentModelId = modelId; });
    await sidebar.onMessage({ type: "setModel", modelId: "gpt-6.2-sol", provider: "codex", effort: "xhigh" }, "local");
    expect(values["grok.defaultEffortByModel"]).toEqual({ codex: { "gpt-6.2-sol": "xhigh" } });
  });
});

describe("a routine never becomes the project's choice", () => {
  it("its model switch writes no project default and no effort memory", async () => {
    const { sidebar, session, values } = sidebarFor("codex");
    session.fromRoutine = true;
    await sidebar.switchModel("gpt-6.2-sol", session, undefined, "codex");
    expect(values["grok.projectProviderDefaults"]).toBeUndefined();
    expect(values["grok.defaultEffortByModel"]).toBeUndefined();
    session.fromRoutine = false;
    await sidebar.switchModel("opus", session, undefined, "codex");
    expect(Object.values(values["grok.projectProviderDefaults"] as object)).toEqual([{ provider: "codex", modelId: "opus" }]);
  });
});
