import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import liveCatalogs from "./fixtures/smoke-live-catalogs.json";
// @ts-expect-error Standalone smoke helper has no declarations.
import { desktopLaunch, parseTrace, desktopFacts, promptCompletion, modelRowIndex, deliveryChunk } from "../scripts/smoke-page-driver.mjs";
const { installTrace } = require("../scripts/smoke-desktop-trace.cjs");

const sent = (clientId = 1, sessionId = "s") => ({ direction: "send", clientId, message: { id: 6, method: "session/prompt", params: { sessionId } } });
const reply = (clientId = 1, result: any = { stopReason: "end_turn" }) => ({ direction: "receive", clientId, message: { id: 6, result } });
const chunk = (at: number, clientId = 1, sessionId = "s") => ({ at: new Date(at).toISOString(), direction: "receive", clientId,
  message: { method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: "ok" } } } } });

describe("page-driven desktop launch and disk facts", () => {
  it("launches the real entry with explicit Electron, no test mode or global action API", () => {
    const env = { NODE_ENV: "test", ELECTRON_RUN_AS_NODE: "1", GROK_DESKTOP_TEST_ALLOW_MULTIPLE: "1", NODE_OPTIONS: "--inspect", PATH: "real-path" };
    const launch = desktopLaunch("root", "electron.exe", "workspace", "profile", "evidence", env);
    expect(launch.executablePath).toBe("electron.exe");
    expect(launch.args.slice(0, 3)).toEqual(["-r", expect.stringContaining("smoke-desktop-trace.cjs"), expect.stringContaining("main.js")]);
    expect(launch.env).toEqual({ PATH: "real-path", ACP_SMOKE_RENDER_OUTPUT: "evidence" });
    expect(env.NODE_ENV).toBe("test");
    const driver = readFileSync(resolve(__dirname, "../scripts/smoke-render.mjs"), "utf8");
    expect(driver).not.toMatch(/app\.evaluate|__renderSmoke|sidebar\.onMessage/);
  });
  it("ignores an incomplete append but fails on corrupt complete records", () => {
    expect(parseTrace('{"direction":"receive"}\n{"unfinished":')).toEqual([{ direction: "receive" }]);
    expect(() => parseTrace('{"unfinished":\n')).toThrow();
  });
  it("requires an acknowledged client matching the currently displayed session/provider", () => {
    const session = { direction: "host-to-webview", message: { type: "session", sessionId: "s", provider: "codex" } };
    const state = { direction: "client-state", provider: "codex", clientId: 1, message: { sessionId: "s", modelId: "gpt-6-luna", effort: "low" } };
    expect(desktopFacts([session])).toBeUndefined();
    expect(desktopFacts([state, session, { ...state, clientId: 2, message: { ...state.message, sessionId: "background" } }])).toMatchObject({ clientId: 1, modelId: "gpt-6-luna", effort: "low" });
    expect(desktopFacts([state, { ...session, message: { ...session.message, sessionId: "new" } }])).toBeUndefined();
    expect(desktopFacts([state, { ...session, message: { ...session.message, provider: "grok" } }])).toBeUndefined();
  });
  it("correlates prompt replies by client, request and session, including refusal", () => {
    expect(promptCompletion([sent(), reply(2)], 0, 1, "s")).toBe(false);
    expect(promptCompletion([sent(1, "child"), reply()], 0, 1, "s")).toBe(false);
    expect(promptCompletion([sent(), reply()], 2, 1, "s")).toBe(false);
    expect(promptCompletion([sent(), reply()], 0, 1, "s")).toEqual(reply());
    expect(() => promptCompletion([sent(), { ...reply(), message: { id: 6, error: { message: "busy" } } }], 0, 1, "s")).toThrow(/busy/);
    expect(() => promptCompletion([sent(), reply(1, { stopReason: "cancelled" })], 0, 1, "s")).toThrow(/complete normally/);
  });
  it("matches provider and full row title; never guesses at a truncated/ambiguous label", () => {
    const model = { modelId: "gpt-6-luna", description: "Fast and affordable model for easier tasks" };
    expect(modelRowIndex([{ provider: "grok", name: model.modelId, title: model.description }, { provider: "codex", name: model.modelId, title: model.description }], model, "codex")).toBe(1);
    expect(modelRowIndex([{ provider: "muse", name: "muse-spark-1.3", title: "muse-spark-1.3" }], { modelId: "muse-spark-1.3" }, "muse")).toBe(0);
    expect(() => modelRowIndex([], model, "codex")).toThrow(/found 0/);
    expect(() => modelRowIndex(Array(2).fill({ provider: "codex", name: model.modelId, title: model.description }), model, "codex")).toThrow(/found 2/);
  });
  it("distinguishes the real Muse contributor rows with identical descriptions", () => {
    const models = liveCatalogs.muse.session.models.availableModels;
    const rows = models.map(m => ({ provider: "muse", name: m.name, title: "description" in m ? m.description : m.modelId }));
    const index = models.findIndex(m => m.modelId === "muse-spark-1.3-contributor");
    expect(modelRowIndex(rows, models[index], "muse")).toBe(index);
  });
  it("requires fresh unsolicited text after successful workflow and launch completion", () => {
    const done = { direction: "host-to-webview", message: { type: "runProgress", update: { done: true } } };
    const events = [sent(), done, reply(), chunk(10000)];
    expect(deliveryChunk(events, 0, 1, "s", 10500)).toEqual(events[3]);
    expect(deliveryChunk(events, 0, 1, "s", 12000)).toBeUndefined();
    expect(deliveryChunk([sent(), done, chunk(10000), reply()], 0, 1, "s", 10500)).toBeUndefined();
    expect(deliveryChunk([...events.slice(0, 3), chunk(10000, 2)], 0, 1, "s", 10500)).toBeUndefined();
    expect(deliveryChunk([...events.slice(0, 3), chunk(10000, 1, "child")], 0, 1, "s", 10500)).toBeUndefined();
    expect(deliveryChunk(events.filter(e => e !== done), 0, 1, "s", 10500)).toBeUndefined();
    expect(deliveryChunk([sent(), { ...done, message: { ...done.message, update: { done: true, failed: true } } }, reply(), chunk(10000)], 0, 1, "s", 10500)).toBeUndefined();
  });
});

describe("passive trace forwarding", () => {
  function fixture(record = vi.fn()) {
    class Client {
      provider = "codex"; sessionId = "s"; currentModelId = "gpt-6-luna"; currentReasoningEffort = "low";
      availableModels = [{ modelId: "gpt-6-luna" }];
      opts = { log: vi.fn() };
      backend = { normalizeUpdate: vi.fn((raw: any) => ({ update: raw })) };
      emit = vi.fn();
      start() { return "started"; }
      writeLine(message: any) { return message; }
      onLine(line: string) { return line; }
      handleSessionUpdate(raw: any) { this.emit("update", raw); return raw; }
      async newSession() { return { sessionId: this.sessionId }; }
      async loadSession() { return { sessionId: this.sessionId }; }
      async setModel(model: string) { if (model === "fail") throw new Error("provider failed"); this.currentModelId = model; }
      async setReasoningEffort() { return true; }
    }
    class Webview { postMessage(message: any) { return message; } }
    installTrace({ AcpClient: Client, ElectronWebview: Webview }, record);
    return { client: new Client(), webview: new Webview(), record };
  }
  it("forwards originals, records post-ack facts, and never answers permissions", async () => {
    const { client, webview, record } = fixture();
    expect(client.start()).toBe("started");
    const permission = { type: "permissionRequest", req: { id: 1, options: [{ kind: "allow_once" }] } };
    expect(webview.postMessage(permission)).toBe(permission);
    expect(record.mock.calls.map(c => c[0])).toEqual(["host-to-webview"]);
    const request = { id: 1, method: "session/set_model" };
    expect(client.writeLine(request)).toBe(request);
    const line = JSON.stringify({ id: 1, result: { configOptions: [] } });
    expect(client.onLine(line)).toBe(line);
    await client.setModel("haiku");
    expect(record).toHaveBeenLastCalledWith("client-state", expect.objectContaining({ modelId: "haiku", configOptions: [] }), { provider: "codex", clientId: 1 });
    const raw = { sessionUpdate: "tool_call" };
    expect(client.handleSessionUpdate(raw)).toBe(raw);
    expect(client.backend.normalizeUpdate(raw)).toEqual({ update: raw });
  });
  it("propagates rejected operations and trace write faults, with no false acknowledgement", async () => {
    const { client, record } = fixture();
    await expect(client.setModel("fail")).rejects.toThrow("provider failed");
    expect(record).not.toHaveBeenCalled();
    const broken = fixture(vi.fn(() => { throw new Error("disk full"); }));
    expect(() => broken.client.writeLine({ id: 1 })).toThrow("disk full");
    await expect(broken.client.newSession()).rejects.toThrow("disk full");
    const before = broken.client.emit;
    expect(() => broken.client.handleSessionUpdate({})).toThrow("disk full");
    expect(broken.client.emit).toBe(before);
  });
});
