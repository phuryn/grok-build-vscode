import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Uri } from "../src/host";
import { AcpClient } from "../src/acp";
import { execGrokCli } from "../src/cli-process";
import { INTERNAL_PROVIDERS } from "../src/acp-backend";
import { DISCONNECTED_GITHUB, readGithubAuthState } from "../src/github-auth";

const calls = vi.hoisted(() => ({ start: vi.fn(), newSession: vi.fn(), loadSession: vi.fn(), list: vi.fn(), delete: vi.fn() }));
vi.mock("../src/acp", async original => {
  const actual = await original<typeof import("../src/acp")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, AcpClient: class extends EventEmitter {
    availableModels = [{ modelId: "test-model", name: "Test model" }];
    currentModelId = "test-model";
    availableModes = [];
    configOptions = [];
    sessionId?: string;
    provider: string;
    constructor(readonly options: any) { super(); this.provider = options.backend?.provider ?? "grok"; }
    async start() { calls.start(this.provider); this.options.signal?.throwIfAborted(); }
    async newSession() { calls.newSession(this.provider); this.sessionId = "new-id"; return { sessionId: this.sessionId }; }
    async loadSession() { calls.loadSession(this.provider); return { sessionId: "old-id" }; }
    async listSessions() { calls.list(this.provider); return { sessions: [{ sessionId: "saved-id", cwd: process.cwd(), title: "Saved", updatedAt: new Date().toISOString() }] }; }
    async deleteSession() { calls.delete(this.provider); }
    async dispose() {}
    isCredentialError() { return false; }
    supportsInterject() { return false; }
    honorsInterjectContent() { return false; }
    setHumanWaitActive() {}
  } };
});
vi.mock("../src/cli-process", async original => ({
  ...await original<typeof import("../src/cli-process")>(),
  execGrokCli: vi.fn(async () => ({ stdout: "2.1.100", stderr: "" })),
}));
vi.mock("../src/github-auth", async original => ({
  ...await original<typeof import("../src/github-auth")>(),
  readGithubAuthState: vi.fn(),
}));
vi.mock("../src/claude-cli-locator", () => ({ locateClaudeCli: vi.fn(() => process.execPath) }));
vi.mock("../src/codex-cli-locator", () => ({ locateCodexCli: vi.fn(() => undefined) }));
vi.mock("../src/muse-cli-locator", () => ({ locateMuseCli: vi.fn(() => undefined) }));
vi.mock("../src/cli-locator", async original => ({
  ...await original<typeof import("../src/cli-locator")>(), locateGrokCli: vi.fn(() => undefined),
}));

let dir: string;
const hosts: any[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-consent-"));
  vi.stubEnv("GROK_HOME", dir);
});
afterEach(() => {
  for (const s of hosts.splice(0)) {
    clearInterval(s.routineTimer); clearInterval(s.workflowTimer);
    for (const controller of s.providerRuns.values()) controller.abort();
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function coldHost(connected = false, cache?: any, saved?: Record<string, any>) {
  const values: Record<string, any> = saved ?? {
    "grok.providerConnections.v2": { claude: connected },
    "grok.providerModelCache": cache ? { claude: cache } : {},
  };
  const state = { get: (key: string, fallback?: any) => values[key] ?? fallback,
    update: vi.fn(async (key: string, value: any) => { values[key] = value; }) };
  const context = { globalState: state, subscriptions: [], extensionUri: Uri.file(process.cwd()), globalStorageUri: Uri.file(dir), extension: { packageJSON: { version: "4.11.0" } } };
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
  // Unrelated UI/remote services. Provider state, startup, model reads, history
  // scheduling, and both ready handlers below all run their real implementation.
  for (const name of ["postVoiceConfigured", "postRemoteStatus", "postMcpConnectors", "postProjectSetup", "refreshGithubState", "refreshImplicitChip"]) s[name] = vi.fn();
  s.post = vi.fn();
  s.projectsRail = { webview: { postMessage: vi.fn() } };
  return { s, state, values };
}
const idle = () => new Promise(resolve => setTimeout(resolve, 30));
function noAgentWork() {
  for (const spy of Object.values(calls)) expect(spy).not.toHaveBeenCalled();
}

describe("stored connection consent at the host boundary (#171)", () => {
  it.each(INTERNAL_PROVIDERS)("restores %s consent after restart without another sign-in panel", async provider => {
    const saved = { "grok.providerConnections.v2": { [provider]: true } };
    const { s } = coldHost(false, undefined, saved);
    s.locateProvider = vi.fn(() => process.execPath);
    s.probeProviderVersion = vi.fn(async () => undefined);
    s.refreshModelsIfCliChanged = vi.fn(async () => {});
    s.startSession = vi.fn(async () => {});
    s.postSessionsList = vi.fn();
    s.sweepEmptySessions = vi.fn();
    expect(s.providerNeedsLogin).toEqual({});
    s.postInitialState();
    await Promise.resolve();
    expect(s.hasProviderConsent(provider)).toBe(true);
    expect(s.focused.provider).toBe(provider);
    expect(s.startSession).toHaveBeenCalledWith(undefined, s.focused, "ensure");
    expect(s.post.mock.calls.some(([m]: any[]) => m.type === "onboarding")).toBe(false);
  });
  it("cold chat and Projects ready/visibility plus previews never start installed, signed-in Claude", async () => {
    const { s, state } = coldHost();
    s.providerCredentialFilePresent = vi.fn(() => true);
    await s.onMessage({ type: "ready" }, "local");
    await s.onProjectsRailMessage({ type: "ready" });
    await s.onProjectsRailMessage({ type: "listRepoSessions", cwd: dir });
    await s.onProjectsRailMessage({ type: "ready" }); // visibility handshake
    await idle();
    expect(s.locatedProviders().claude).toBe(true);
    expect(s.providerConnections().claude).toBe(false);
    noAgentWork();
    expect(execGrokCli).not.toHaveBeenCalled();
    expect(state.update.mock.calls.some(([key]) => key === "grok.providerConnections.v2")).toBe(false);
  });

  // The model cache's staleness used to decide this: a changed CLI version sent
  // refreshModelsIfCliChanged into reprobeProviderCredentials, which is a full
  // session. So the local half has to stay local at every cache state, not just
  // the one a test happened to pick.
  it.each([undefined, "2.1.100", "2.1.1"])("local-only refresh with cache version %s starts no ACP", async cliVersion => {
    const { s } = coldHost(true, cliVersion ? { models: [], cliVersion, seenAt: 1 } : undefined);
    await s.onMessage({ type: "refreshProviders", credentials: false }, "local");
    noAgentWork();
    // The spawn IS allowed: reading --version contacts nobody, and the row that
    // offers an update is derived from it.
    expect(execGrokCli).toHaveBeenCalledWith(process.execPath, ["--version"], expect.any(Object));
    expect(s.providerConnections().claude).toBe(true);
  });

  it("an unqualified refresh from an older client asks for the local half only", async () => {
    // Absent `credentials` means false at the host too, or the opt-in is only
    // written down in the protocol comment.
    const { s, state } = coldHost(true);
    await s.onMessage({ type: "refreshProviders" }, "local");
    noAgentWork();
    expect(execGrokCli).toHaveBeenCalledWith(process.execPath, ["--version"], expect.any(Object));
    expect(state.update).not.toHaveBeenCalledWith("grok.providerConnections.v2", expect.anything());
  });

  it("an unqualified refresh never promotes an unconnected agent", async () => {
    const { s, state } = coldHost();
    await s.onMessage({ type: "refreshProviders" }, "local");
    noAgentWork();
    expect(execGrokCli).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalledWith("grok.providerConnections.v2", expect.anything());
  });

  it("the Projects rail Re-check refreshes GitHub state through the chat handler (#186)", async () => {
    const { s, state } = coldHost(true);
    s.githubConnection = { ...DISCONNECTED_GITHUB };
    vi.mocked(readGithubAuthState).mockResolvedValue({ ...DISCONNECTED_GITHUB, connected: true, login: "rail-user" });
    // Keep the real refresh, post and rail mirror; only external I/O is stubbed.
    delete s.refreshGithubState;
    delete s.post;
    s.broadcastRemoteDevice = vi.fn();
    s.sendRemoteSession = vi.fn();
    await s.onProjectsRailMessage({ type: "refreshProviders", credentials: false });
    expect(readGithubAuthState).toHaveBeenCalledOnce();
    expect(s.projectsRail.webview.postMessage).toHaveBeenCalledWith({
      type: "githubState", github: { connected: true, cliPresent: true, login: "rail-user" },
    });
    noAgentWork();
    // As in chat, already-connected Claude may have its version refreshed.
    expect(execGrokCli).toHaveBeenCalledWith(process.execPath, ["--version"], expect.any(Object));
    expect(state.update).not.toHaveBeenCalledWith("grok.providerConnections.v2", expect.anything());
    expect(s.host.appendLine).not.toHaveBeenCalledWith("[projects-rail] ignored refreshProviders");
  });

  it.each([false, true, undefined])("rail refresh with credentials=%s cannot run any unconnected provider", async credentials => {
    const connections = Object.fromEntries(INTERNAL_PROVIDERS.map(id => [id, false]));
    const { s, state } = coldHost(false, undefined, { "grok.providerConnections.v2": connections });
    // All four binaries are discoverable and appear signed in elsewhere. Neither
    // fact is Connect consent, even if a rail message asks for credential probes.
    s.locateProvider = vi.fn(() => process.execPath);
    s.providerCredentialFilePresent = vi.fn(() => true);
    const credentialsProbe = vi.spyOn(s, "reprobeProviderCredentials");
    const versionProbe = vi.spyOn(s, "reprobeProviderVersion");
    await s.onProjectsRailMessage({ type: "refreshProviders", ...(credentials === undefined ? {} : { credentials }) });
    expect(s.refreshGithubState).toHaveBeenCalledOnce(); // The request really reached refresh.
    expect(s.locatedProviders()).toEqual(Object.fromEntries(INTERNAL_PROVIDERS.map(id => [id, true])));
    expect(credentialsProbe).not.toHaveBeenCalled();
    expect(versionProbe).not.toHaveBeenCalled();
    noAgentWork();
    expect(execGrokCli).not.toHaveBeenCalled();
    expect(s.providerConnections()).toEqual(connections);
    expect(state.update).not.toHaveBeenCalledWith("grok.providerConnections.v2", expect.anything());
  });

  it("migrates ambiguous old flags once without touching credentials", async () => {
    const saved = { "grok.providerConnections": { grok: true, codex: true, claude: true, muse: true } };
    const { s, values } = coldHost(false, undefined, saved);
    expect(s.providerConnections()).toEqual({});
    expect(values["grok.providerConnections.v2"]).toEqual({});
    expect(execGrokCli).not.toHaveBeenCalled();
    values["grok.providerConnections.v2"] = { claude: true };
    expect(coldHost(false, undefined, values).s.providerConnections()).toEqual({ claude: true });
  });

  it("keeps history and models for an explicitly connected provider with lapsed credentials", async () => {
    const { s } = coldHost(true);
    s.providerNeedsLogin.claude = true;
    await s.refreshAdapterHistory("claude", dir);
    await s.reprobeProviderCredentials("claude");
    expect(calls.list).toHaveBeenCalledWith("claude");
    expect(calls.newSession).toHaveBeenCalledWith("claude");
    expect(s.state.get("grok.providerModelCache").claude.models).toHaveLength(1);
  });
});
