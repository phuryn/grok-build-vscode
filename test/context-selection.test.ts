import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AcpClient } from "../src/acp";
import { parseContextWindowSize, contextWindowSizes } from "../src/context-selection";
import { CodexBackend } from "../src/codex-backend";

function setup() {
  const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, grokVersion: "1.0.46", grokVersionVerified: true });
  client.sessionId = "s1";
  client.currentModelId = "grok-4.7";
  client.availableModels = [{ modelId: "grok-4.7", name: "Grok", contextWindowSizes: [256000, 500000] }];
  let size = 256000;
  const request = vi.fn(async (method: string, params: any) => {
    if (method === "_x.ai/session/info") return { result: { context: { used: 10, total: size } } };
    size = params._meta?.contextWindow ?? size;
    return { _meta: { model: { Ok: "grok-4.7" } } };
  });
  (client as any).request = request;
  return { client, request };
}

describe("native context selection", () => {
  it("validates native choices without sorting or inventing a size", () => {
    expect(contextWindowSizes([500000, 256000, 500000, 0, -1, 2.5, "100", Infinity])).toEqual([500000, 256000]);
    expect(contextWindowSizes(undefined, 256000)).toEqual([256000]);
    expect(contextWindowSizes(undefined)).toEqual([]);
  });
  it("accepts CLI shorthand and rejects non-native counts", () => {
    expect(parseContextWindowSize("500k")).toBe(500000);
    expect(parseContextWindowSize("256000")).toBe(256000);
    for (const text of ["0", "-1", "1.5k", "500kb", "500k high", "Infinity"]) expect(parseContextWindowSize(text)).toBeUndefined();
  });
  it("confirms the native override before publishing its active value", async () => {
    const { client, request } = setup();
    await client.getSessionInfo();
    await client.setContextWindow(500000, client.contextWindowSelection);
    expect(request).toHaveBeenCalledWith("session/set_model", { sessionId: "s1", modelId: "grok-4.7", _meta: { contextWindow: 500000 } });
    expect(client.contextWindowSelection.selectedSize).toBe(500000);
    expect(client.availableModels[0].totalContextTokens).toBe(500000);
    expect((await client.getSessionInfo() as any).window).toBe(500000);
  });
  it("preserves the last confirmed selection on rejection or missing confirmation", async () => {
    for (const fails of [true, false]) {
      const { client } = setup();
      await client.getSessionInfo();
      (client as any).request = vi.fn(async (method: string) => {
        if (method === "session/set_model" && fails) throw new Error("denied");
        return method === "session/set_model" ? { _meta: { model: { Ok: "grok-4.7" } } } : { context: { used: 10, total: 256000 } };
      });
      await expect(client.setContextWindow(500000, client.contextWindowSelection)).rejects.toThrow();
      expect(client.contextWindowSelection.selectedSize).toBe(256000);
      expect(client.contextWindowSelection.changing).toBe(false);
      expect(client.contextWindowSelection.stale).toBe(true);
      expect(client.availableModels[0].totalContextTokens).toBe(256000);
    }
  });
  it("rejects stale identity, invalid sizes and tagged old updates", async () => {
    const { client, request } = setup();
    const old = client.contextWindowSelection;
    await expect(client.setContextWindow(500000, { ...old, sessionId: "other" })).rejects.toThrow("older");
    await expect(client.setContextWindow(1000000, old)).rejects.toThrow("offer");
    expect(request).not.toHaveBeenCalled();
    await client.setContextWindow(500000, old);
    (client as any).handleSessionUpdate({ sessionUpdate: "usage_update", used: 9, size: 256000 }, { generation: old.generation }, "s1");
    expect(client.availableModels[0].totalContextTokens).toBe(500000);
    await expect(client.setContextWindow(256000, old)).rejects.toThrow("older");
  });
  it("locks concurrent prompts and model switches until native confirmation", async () => {
    const { client } = setup();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    (client as any).request = vi.fn(async (method: string) => {
      if (method === "session/set_model") { await wait; return { _meta: { model: { Ok: "grok-4.7" } } }; }
      return { context: { used: 10, total: 500000 } };
    });
    const changing = client.setContextWindow(500000, client.contextWindowSelection);
    expect(client.contextWindowSelection.changing).toBe(true);
    await expect(client.getSessionInfo()).rejects.toThrow("retry");
    await expect(client.prompt("hello")).rejects.toThrow("Wait");
    await expect(client.setModel("other")).rejects.toThrow("Wait");
    await expect(client.setReasoningEffort("high")).rejects.toThrow("Wait");
    await expect(client.newSession()).rejects.toThrow("Wait");
    await expect(client.loadSession("other")).rejects.toThrow("Wait");
    release(); await changing;
  });
  it("carries reasoning effort and clears stale state after a successful refresh", async () => {
    const { client, request } = setup();
    client.currentReasoningEffort = "high";
    (client as any).contextSelectionStale = true;
    await client.setContextWindow(500000, client.contextWindowSelection);
    expect(request).toHaveBeenCalledWith("session/set_model", { sessionId: "s1", modelId: "grok-4.7", _meta: { contextWindow: 500000, reasoningEffort: "high" } });
    expect(client.contextWindowSelection.stale).toBe(false);
  });
  it("reads default, model carry-over and resumed state from the native session", async () => {
    const { client } = setup();
    const model = (modelId: string) => ({ modelId, name: modelId, _meta: { contextWindows: [256000, 500000], totalContextTokens: 256000 } });
    let size = 256000;
    const request = vi.fn(async (method: string, params: any) => {
      if (method === "session/new" || method === "session/load") return { sessionId: params.sessionId ?? "new", models: { currentModelId: "grok-4.7", availableModels: [model("grok-4.7"), model("grok-4.6")] } };
      if (method === "_x.ai/session/info") return { context: { used: 0, total: size } };
      size = params._meta?.contextWindow ?? size;
      return { _meta: { model: { Ok: params.modelId } } };
    });
    (client as any).request = request;
    await client.newSession();
    expect(client.contextWindowSelection.selectedSize).toBe(256000);
    expect(request.mock.calls.some(c => c[0] === "session/set_model")).toBe(false);
    await client.setContextWindow(500000, client.contextWindowSelection);
    const previous = client.contextWindowSelection;
    await client.setModel("grok-4.6");
    expect(client.contextWindowSelection.selectedSize).toBe(500000);
    expect(client.contextWindowSelection.generation).toBeGreaterThan(previous.generation);
    await expect(client.setContextWindow(256000, previous)).rejects.toThrow("older");
    await client.loadSession("resumed");
    expect(client.contextWindowSelection).toMatchObject({ sessionId: "resumed", modelId: "grok-4.7", selectedSize: 500000 });
  });
  it("rejects a session-info response overtaken by a native context change", async () => {
    const { client } = setup();
    let release!: (value: unknown) => void;
    const late = new Promise(resolve => { release = resolve; });
    let infos = 0;
    (client as any).request = vi.fn(async (method: string) => {
      if (method === "_x.ai/session/info") return ++infos === 1 ? late : { context: { used: 10, total: 500000 } };
      return { _meta: { model: { Ok: "grok-4.7" } } };
    });
    const refresh = client.getSessionInfo();
    const rejected = expect(refresh).rejects.toThrow("changed");
    await client.setContextWindow(500000, client.contextWindowSelection);
    release({ context: { used: 10, total: 256000 } });
    await rejected;
    expect(client.contextWindowSelection.selectedSize).toBe(500000);
  });
  it.each(["1.0.45", "unreadable"])("does not guess RPC support from version %s", (grokVersion) => {
    const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, grokVersion, grokVersionVerified: true });
    client.sessionId = "s"; client.currentModelId = "m";
    client.availableModels = [{ modelId: "m", name: "m", contextWindowSizes: [256000, 500000] }];
    expect(client.contextWindowSelection.available).toBe(false);
    client.availableCommands = [{ name: "context-window" }];
    expect(client.contextWindowSelection.available).toBe(true);
  });
  it("uses only an advertised slash command and bypasses full-context preflight", async () => {
    const { client, request } = setup();
    client.availableCommands = [{ name: "context-window" }];
    (client as any).request = vi.fn(async (method: string) => method === "_x.ai/session/info" ? { context: { used: 600000, total: 500000 } } : {});
    await client.setContextWindow(500000, client.contextWindowSelection);
    expect((client as any).request.mock.calls[0]).toEqual(["session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "/context-window 500000" }] }]);
    expect(request).not.toHaveBeenCalled();
  });
  it("does not expose guessed capability or send an unsupported slash as prose", async () => {
    const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {} });
    client.sessionId = "s"; client.currentModelId = "m";
    client.availableModels = [{ modelId: "m", name: "m", contextWindowSizes: [256000, 500000] }];
    expect(client.contextWindowSelection.available).toBe(false);
    await expect(client.prompt("/context-window 500k")).rejects.toThrow("does not advertise");
    const codex = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, backend: new CodexBackend() });
    expect(codex.contextWindowSelection.available).toBe(false);
  });
});

const clients: AcpClient[] = [];
const homes: string[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.dispose(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
describe("context selection over fake CLI stdio", () => {
  it("resumes the persisted choice across processes and retains the default for a new conversation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-context-")); homes.push(home);
    const make = () => {
      const client = new AcpClient({ cliPath: path.join(__dirname, "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh"),
        cwd: process.cwd(), env: { ...process.env, GROK_HOME: home, FAKE_CONTEXT_WINDOWS: "1", FAKE_UNIQUE_SESSION_IDS: "1" },
        grokVersion: "1.0.46", grokVersionVerified: true, log: () => {} });
      clients.push(client); return client;
    };
    const first = make(); await first.start(); await first.newSession();
    const sessionId = first.sessionId!;
    await first.setContextWindow(500000, first.contextWindowSelection);
    await first.dispose();
    const resumed = make(); await resumed.start(); await resumed.loadSession(sessionId);
    expect(resumed.contextWindowSelection.selectedSize).toBe(500000);
    await resumed.newSession();
    expect(resumed.contextWindowSelection.selectedSize).toBe(256000);
  }, 30000);
  it("lets native compaction reduce occupancy after selecting a smaller window", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-context-")); homes.push(home);
    const client = new AcpClient({ cliPath: path.join(__dirname, "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh"),
      cwd: process.cwd(), env: { ...process.env, GROK_HOME: home, FAKE_CONTEXT_WINDOWS: "1", FAKE_CONTEXT_USED: "300000" },
      grokVersion: "1.0.46", grokVersionVerified: true, log: () => {} });
    clients.push(client); await client.start(); await client.newSession();
    const updates: any[] = [];
    client.on("xaiNotification", update => updates.push(update));
    await client.setContextWindow(256000, client.contextWindowSelection);
    expect(updates.map(u => u.sessionUpdate)).toContain("auto_compact_started");
    expect(updates.map(u => u.sessionUpdate)).toContain("auto_compact_completed");
    expect((await client.getSessionInfo() as any).used).toBe(10000);
    expect(client.contextWindowSelection.selectedSize).toBe(256000);
  }, 30000);

  it.each([undefined, "FAKE_CONTEXT_ERROR", "FAKE_CONTEXT_UNCONFIRMED"])("confirms or reports native outcome %s", async (failure) => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-context-")); homes.push(home);
    const client = new AcpClient({ cliPath: path.join(__dirname, "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh"),
      cwd: process.cwd(), env: { ...process.env, GROK_HOME: home, FAKE_CONTEXT_WINDOWS: "1", ...(failure ? { [failure]: "1" } : {}) },
      grokVersion: "1.0.46", grokVersionVerified: true, log: () => {} });
    clients.push(client); await client.start(); await client.newSession();
    expect(client.contextWindowSelection.selectedSize).toBe(256000);
    const change = client.setContextWindow(500000, client.contextWindowSelection);
    if (failure) { await expect(change).rejects.toThrow(); expect(client.contextWindowSelection.selectedSize).toBe(256000); }
    else { await change; expect((await client.getSessionInfo() as any).window).toBe(500000); }
  }, 30000);
});
