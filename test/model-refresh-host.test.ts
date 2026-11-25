import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Uri } from "../src/host";
import { INTERNAL_PROVIDERS, type AcpProvider } from "../src/acp-backend";
import { removeAgyConversation } from "../src/agy-backend";
import { MODEL_LIST_MAX_AGE_MS, MODEL_REFRESH_CHECK_MS, MODEL_REFRESH_FIRST_DELAY_MS } from "../src/model-refresh";

// One fake agent per process start: it records what the host asked of it, and
// a test may make any step fail or wait.
const agent = vi.hoisted(() => ({
  calls: [] as string[],
  options: [] as any[],
  models: [] as any[],
  newSession: undefined as undefined | ((provider: string) => Promise<void>),
  deleteSession: undefined as undefined | (() => Promise<void>),
  sessionId: "blank-1",
  credentialError: false,
}));
const cli = vi.hoisted(() => ({ run: vi.fn(async (_path: string, _args: readonly string[], _options?: any) => ({ stdout: "", stderr: "" })) }));
vi.mock("../src/cli-process", async original => ({
  ...await original<typeof import("../src/cli-process")>(), execGrokCli: cli.run,
}));
vi.mock("../src/acp", async original => {
  const actual = await original<typeof import("../src/acp")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, AcpClient: class extends EventEmitter {
    availableModels: any[] = [];
    currentModelId?: string;
    sessionId?: string;
    provider: string;
    constructor(readonly options: any) {
      super();
      this.provider = options.backend?.provider ?? "grok";
      agent.options.push(options);
    }
    async start() {
      this.options.signal?.throwIfAborted();
      agent.calls.push(`${this.provider} start`);
      this.emit("initialized", { _meta: { models: { currentModelId: "wonder", availableModels: [
        { modelId: "wonder", name: "Wonder", description: "Best", _meta: { totalContextTokens: 1000, supportsReasoningEffort: true, reasoningEfforts: [{ value: "low" }, { value: "high" }] } },
      ] } } });
    }
    async authenticate() { agent.calls.push(`${this.provider} authenticate`); }
    async newSession() {
      agent.calls.push(`${this.provider} newSession`);
      this.sessionId = agent.sessionId;
      await agent.newSession?.(this.provider);
      this.availableModels = agent.models;
      this.currentModelId = agent.models[0]?.modelId;
      return { sessionId: this.sessionId };
    }
    async deleteSession() { agent.calls.push(`${this.provider} delete`); await agent.deleteSession?.(); }
    async dispose() { agent.calls.push(`${this.provider} dispose`); }
    isCredentialError() { return agent.credentialError; }
  } };
});
vi.mock("../src/agy-backend", async original => ({
  ...await original<typeof import("../src/agy-backend")>(), locateAgyCli: vi.fn(() => process.execPath),
}));

const NEW = { modelId: "new", name: "New" };
const OLD = { modelId: "old", name: "Old" };
const DAY = MODEL_LIST_MAX_AGE_MS;
let dir: string;
const hosts: any[] = [];

beforeEach(() => {
  agent.calls = []; agent.options = []; agent.models = [NEW]; agent.newSession = undefined; agent.credentialError = false;
  agent.deleteSession = undefined; agent.sessionId = "blank-1"; cli.run.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-refresh-"));
  vi.stubEnv("GROK_HOME", dir);
  vi.stubEnv("GEMINI_HOME", path.join(dir, "gemini"));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of hosts.splice(0)) {
    clearInterval(s.routineTimer); clearInterval(s.workflowTimer); clearTimeout(s.modelRefreshTimer);
    for (const controller of s.providerRuns.values()) controller.abort();
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeHost(connected: AcpProvider[], cache: Record<string, any> = {}) {
  const values: Record<string, any> = {
    "grok.providerConnections.v2": Object.fromEntries(connected.map(id => [id, true])),
    "grok.providerModelCache": cache,
  };
  const updates: string[] = [];
  const state = { get: (key: string, fallback?: any) => values[key] ?? fallback,
    update: vi.fn(async (key: string, value: any) => { updates.push(key); values[key] = value; }) };
  const context = { globalState: state, subscriptions: [], extensionUri: Uri.file(process.cwd()), globalStorageUri: Uri.file(dir),
    secrets: { get: async () => undefined }, extension: { packageJSON: { version: "4.17.15" } } };
  const host = {
    appendLine: vi.fn(), workspaceRoot: () => dir, workspaceFolders: () => [dir],
    getConfiguration: () => ({ get: (_key: string, fallback?: any) => fallback, inspect: () => undefined }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    secrets: { get: async () => undefined },
    setContext: vi.fn(), showErrorMessage: vi.fn(), showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(), getActiveTextEditor: () => undefined,
    fs: { readFile: async () => Buffer.from(""), writeFile: async () => {}, createDirectory: async () => {} },
  };
  const s = new GrokSidebar(context as any, host as any) as any;
  hosts.push(s);
  s.locateProvider = vi.fn(() => process.execPath);
  s.deepseekCredential = vi.fn(async () => ({ key: "k" }));
  s.agyGoogleAuthenticated = { cli: true };
  s.postSessionModels = vi.fn();
  s.post = vi.fn();
  s.removeSessionFromDisk = vi.fn();
  const models = (id: AcpProvider) => values["grok.providerModelCache"][id]?.models;
  return { s, values, updates, models, log: () => host.appendLine.mock.calls.map(([line]: any[]) => line).join("\n") };
}
const fresh = () => ({ models: [OLD], seenAt: Date.now() });
const stale = (cliVersion?: string) => ({ models: [OLD], seenAt: Date.now() - DAY, ...(cliVersion ? { cliVersion } : {}) });
const emptyChat = (provider: AcpProvider) => ({ provider, hasHistory: false, client: { sessionId: "open" } });

describe("the daily read of every agent's models", () => {
  it.each(INTERNAL_PROVIDERS)("a %s list over a day old is replaced, with no prompt", async provider => {
    const { s, models } = makeHost([provider], { [provider]: stale() });
    await s.refreshStaleModelLists();
    expect(models(provider)[0].modelId).toBe(provider === "muse" ? "wonder" : "new");
    expect(agent.calls).not.toContain(`${provider} prompt`);
    expect(agent.calls.at(-1)).toBe(`${provider} dispose`);
  });

  it("reads one agent at a time, and only the ones whose list is old", async () => {
    const { s, models } = makeHost(["grok", "codex", "claude"], { grok: stale(), codex: fresh(), claude: stale() });
    let release!: () => void;
    agent.newSession = provider => provider === "grok" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    const running = s.refreshStaleModelLists();
    await vi.waitFor(() => expect(agent.calls).toContain("grok newSession"));
    expect(agent.calls).not.toContain("claude start");
    release();
    await running;
    expect(models("grok")).toEqual([NEW]);
    expect(models("claude")).toEqual([NEW]);
    expect(models("codex")).toEqual([OLD]);
    expect(agent.calls.some(call => call.startsWith("codex"))).toBe(false);
  });

  it("never starts an agent that is not connected or not usable", async () => {
    const { s } = makeHost(["claude"], {});
    s.providerNeedsLogin = { claude: true };
    await s.refreshStaleModelLists();
    expect(agent.calls).toEqual([]);
  });

  it("records the attempt before the read, so a failure waits a day and keeps the list", async () => {
    const { s, values, updates, models } = makeHost(["codex"], { codex: stale() });
    let recorded: string[] = [];
    agent.newSession = async () => {
      recorded = [...updates];
      throw new Error("Internal error");
    };
    await s.refreshStaleModelLists();
    expect(recorded).toContain("grok.modelRefreshAttempts");
    expect(models("codex")).toEqual([OLD]);
    expect(values["grok.modelRefreshAttempts"].codex).toBeGreaterThan(Date.now() - 60_000);
    agent.calls = []; agent.newSession = undefined;
    await s.refreshStaleModelLists();
    expect(agent.calls).toEqual([]);
    values["grok.modelRefreshAttempts"].codex = Date.now() - DAY;
    await s.refreshStaleModelLists();
    expect(models("codex")).toEqual([NEW]);
  });

  it("skips a list a chat or another window refreshed while an earlier agent was read", async () => {
    const { s, values } = makeHost(["grok", "claude"], { grok: stale(), claude: stale() });
    agent.newSession = async provider => {
      if (provider === "grok") values["grok.providerModelCache"] = { ...values["grok.providerModelCache"], claude: fresh() };
    };
    await s.refreshStaleModelLists();
    expect(agent.calls).not.toContain("claude start");
  });

  it.each(["grok", "codex", "claude"] as const)("a credential failure on a %s read nobody asked for does not sign it out", async provider => {
    const { s, models } = makeHost([provider], { [provider]: stale() });
    agent.credentialError = true;
    agent.newSession = async () => { throw new Error("Authentication required. Sign in required. Please run /login"); };
    await s.refreshStaleModelLists();
    expect(s.providerNeedsLogin[provider]).toBeFalsy();
    expect(models(provider)).toEqual([OLD]);
    // The read a person asks for still says so.
    await s.reprobeProviderCredentials(provider);
    expect(s.providerNeedsLogin[provider]).toBe(true);
  });

  it.each(INTERNAL_PROVIDERS)("%s is left alone while it is being updated, and when it is not connected", async provider => {
    const { s } = makeHost([provider], { [provider]: stale() });
    s.providerCliUpdate = { provider, done: Promise.resolve() };
    await s.rereadProviderModels(provider);
    expect(agent.calls).toEqual([]);
    const other = makeHost([], { [provider]: stale() });
    await other.s.rereadProviderModels(provider);
    expect(agent.calls).toEqual([]);
  });

  it("one read serves callers that overlap", async () => {
    const { s } = makeHost(["codex"], { codex: stale() });
    const first = s.rereadProviderModels("codex");
    expect(s.rereadProviderModels("codex")).toBe(first);
    await first;
    expect(agent.calls.filter(call => call === "codex newSession")).toHaveLength(1);
  });
});

describe("what a read leaves behind", () => {
  it("removes Grok's blank session from disk", async () => {
    const { s } = makeHost(["grok"], { grok: stale() });
    await s.rereadProviderModels("grok");
    expect(s.removeSessionFromDisk).toHaveBeenCalledWith("blank-1", expect.stringContaining("grok-cred-probe-"), dir);
  });

  it("removes it from the home a workspace .env names, where the read wrote it", async () => {
    const { s } = makeHost(["grok"], { grok: stale() });
    delete s.removeSessionFromDisk;
    const other = path.join(dir, "other-home");
    s.buildEnv = () => ({ GROK_HOME: other });
    let written = "", bystander = "";
    agent.newSession = async () => {
      const scratch = encodeURIComponent(agent.options.at(-1).cwd);
      written = path.join(other, "sessions", scratch, "blank-1");
      bystander = path.join(dir, "sessions", scratch, "blank-1");
      fs.mkdirSync(written, { recursive: true });
      fs.mkdirSync(bystander, { recursive: true });
    };
    await s.rereadProviderModels("grok");
    expect(agent.options[0].env.GROK_HOME).toBe(other);
    expect(fs.existsSync(path.dirname(written))).toBe(false);
    expect(fs.existsSync(bystander)).toBe(true);
  });

  it("removes the empty catalog folder of Grok's scratch directory, and only an empty one", async () => {
    const { s } = makeHost(["grok"], { grok: stale() });
    const catalogs: string[] = [];
    agent.newSession = async () => {
      const at = path.join(dir, "sessions", encodeURIComponent(agent.options.at(-1).cwd));
      fs.mkdirSync(at, { recursive: true });
      catalogs.push(at);
      if (catalogs.length === 2) fs.writeFileSync(path.join(at, "kept"), "");
    };
    await s.rereadProviderModels("grok");
    await s.rereadProviderModels("grok");
    expect(catalogs.map(at => fs.existsSync(at))).toEqual([false, true]);
  });

  it("deletes the Codex thread it archived, by its exact id, after the agent has let go of it", async () => {
    const { s } = makeHost(["codex"], { codex: stale() });
    agent.sessionId = "01a21055-d2cc-7a93-98d9-30e6c7ea9c3e";
    let callsBefore: string[] = [];
    cli.run.mockImplementation(async () => { callsBefore = [...agent.calls]; return { stdout: "", stderr: "" }; });
    await s.rereadProviderModels("codex");
    const deletes = cli.run.mock.calls.filter(([, args]) => args[0] === "delete");
    expect(deletes.map(([, args]) => args)).toEqual([["delete", "--force", agent.sessionId]]);
    expect(callsBefore.slice(-2)).toEqual(["codex delete", "codex dispose"]);
  });

  it.each([["an id that is not a thread id", "x; rm -rf"], ["a thread that was never archived", "01a21055-d2cc-7a93-98d9-30e6c7ea9c3e"]])("never runs the Codex delete for %s", async (_why, id) => {
    const { s, models } = makeHost(["codex"], { codex: stale() });
    agent.sessionId = id;
    if (id.startsWith("01a")) agent.deleteSession = async () => { throw new Error("no rollout found"); };
    await s.rereadProviderModels("codex");
    expect(cli.run.mock.calls.filter(([, args]) => args[0] === "delete")).toEqual([]);
    expect(models("codex")).toEqual([NEW]);
  });

  it("a Codex without the delete command still gives its models", async () => {
    const { s, models } = makeHost(["codex"], { codex: stale() });
    agent.sessionId = "01a21055-d2cc-7a93-98d9-30e6c7ea9c3e";
    cli.run.mockRejectedValue(new Error("unexpected argument '--force'"));
    await s.rereadProviderModels("codex");
    expect(models("codex")).toEqual([NEW]);
  });

  it("opens no Muse session, and keeps the effort ladder and the CLI stamp", async () => {
    const { s, values } = makeHost(["muse"], { muse: stale("1.2.3") });
    await s.rereadProviderModels("muse");
    expect(agent.calls).toEqual(["muse start", "muse dispose"]);
    expect(agent.options[0].refuseServerRequests).toBe(true);
    expect(values["grok.providerModelCache"].muse).toMatchObject({
      cliVersion: "1.2.3", currentModelId: "wonder",
      models: [{ modelId: "wonder", totalContextTokens: 1000, supportsReasoningEffort: true, reasoningEfforts: ["low", "high"] }],
    });
  });

  it("removes Antigravity's blank conversation and nothing else of the person's", async () => {
    const { s, models } = makeHost(["agy"], { agy: stale() });
    const home = path.join(dir, "gemini", "antigravity-cli");
    const file = (...parts: string[]) => path.join(home, ...parts);
    for (const id of ["blank-1", "mine-2"]) {
      fs.mkdirSync(file("brain", id, "scratch"), { recursive: true });
      fs.mkdirSync(file("conversations"), { recursive: true });
      fs.writeFileSync(file("conversations", `${id}.db`), "x");
    }
    await s.rereadProviderModels("agy");
    expect(models("agy")).toEqual([NEW]);
    expect(fs.readdirSync(file("conversations"))).toEqual(["mine-2.db"]);
    expect(fs.readdirSync(file("brain"))).toEqual(["mine-2"]);
    expect(agent.options[0]).toMatchObject({ refuseServerRequests: true, env: { BROWSER: "none" } });
  });

  it.each(["..", "../../elsewhere", "", undefined])("never removes a path named by an odd id (%s)", id => {
    const kept = path.join(dir, "gemini", "antigravity-cli", "brain");
    fs.mkdirSync(kept, { recursive: true });
    removeAgyConversation("cli", id);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("does not start Antigravity without a saved sign-in, or while it is being installed", async () => {
    const { s } = makeHost(["agy"], { agy: stale() });
    s.agyGoogleAuthenticated = { cli: false };
    await s.rereadProviderModels("agy");
    s.agyGoogleAuthenticated = { cli: true };
    s.agyCliInstall = new Promise(() => {});
    await s.rereadProviderModels("agy");
    expect(agent.calls).toEqual([]);
  });
});

describe("the pickers on screen", () => {
  it("are repainted when the list changed, and not when it did not", async () => {
    const { s } = makeHost(["grok"], { grok: stale() });
    s.focused = emptyChat("codex");
    await s.rereadProviderModels("grok");
    await Promise.resolve();
    expect(s.postSessionModels).toHaveBeenCalledOnce();
    await s.rereadProviderModels("grok");
    await Promise.resolve();
    expect(s.postSessionModels).toHaveBeenCalledOnce();
  });

  it("keep the list when the agent answers with none", async () => {
    const { s, models } = makeHost(["codex"], { codex: stale() });
    agent.models = [];
    await s.rereadProviderModels("codex");
    expect(models("codex")).toEqual([OLD]);
  });
});

describe("a CLI whose version changed", () => {
  it.each(INTERNAL_PROVIDERS.filter(id => id !== "deepseek"))("%s is read once and its new list is kept", async provider => {
    const { s, models, values } = makeHost([provider], { [provider]: { ...fresh(), cliVersion: "1.0.0" } });
    await s.refreshModelsIfCliChanged(provider, "1.1.0");
    expect(models(provider)[0].modelId).toBe(provider === "muse" ? "wonder" : "new");
    expect(values["grok.providerModelCache"][provider].cliVersion).toBe("1.1.0");
    agent.calls = [];
    await s.refreshModelsIfCliChanged(provider, "1.1.0");
    expect(agent.calls).toEqual([]);
  });
});

describe("Refresh in Settings > Providers", () => {
  it("reads Muse and Antigravity too; opening the page does not", async () => {
    const { s, models } = makeHost(["muse", "agy"], { muse: fresh(), agy: fresh() });
    s.refreshAgyCliVersion = vi.fn(async () => {});
    s.reprobeProviderVersion = vi.fn(async () => {});
    s.refreshGithubState = vi.fn(async () => {});
    await s.refreshProviderStates();
    expect(agent.calls).toEqual([]);
    await s.refreshProviderStates({ credentials: true });
    expect(models("muse")[0].modelId).toBe("wonder");
    expect(models("agy")).toEqual([NEW]);
  });
});

describe("the timer", () => {
  it("starts with the panel, waits, then looks every hour until the window closes", async () => {
    vi.useFakeTimers();
    const { s } = makeHost([]);
    s.refreshStaleModelLists = vi.fn(async () => {});
    s.startModelRefresh();
    s.startModelRefresh();
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_FIRST_DELAY_MS - 1);
    expect(s.refreshStaleModelLists).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.refreshStaleModelLists).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_CHECK_MS);
    expect(s.refreshStaleModelLists).toHaveBeenCalledTimes(2);
    const stopped = s.refreshStaleModelLists.mock.calls[1][0];
    s.dispose();
    expect(stopped()).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_REFRESH_CHECK_MS * 3);
    expect(s.refreshStaleModelLists).toHaveBeenCalledTimes(2);
  });

  it("a window that closed mid-round starts no further agent", async () => {
    const { s } = makeHost(["grok", "claude"], { grok: stale(), claude: stale() });
    let closed = false;
    agent.newSession = async () => { closed = true; };
    await s.refreshStaleModelLists(() => closed);
    expect(agent.calls).not.toContain("claude start");
  });

  it("the panel's first frame starts it", () => {
    const { s } = makeHost([]);
    for (const name of ["postVoiceConfigured", "postRemoteStatus", "postMcpConnectors", "postProjectSetup", "refreshGithubState",
      "refreshImplicitChip", "postSessionsList"]) s[name] = vi.fn();
    s.postInitialState();
    const timer = s.modelRefreshTimer;
    expect(timer).toBeDefined();
    s.postInitialState();
    expect(s.modelRefreshTimer).toBe(timer);
  });

  it("a phone's page starts it where the panel was never opened", () => {
    const { s } = makeHost([]);
    s.remoteClients.ready("phone");
    s.handleRemoteClientReady("phone");
    expect(s.modelRefreshTimer).toBeDefined();
  });
});
