import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { execGrokCli } from "../src/cli-process";
import { warmCodexModelCache } from "../src/codex-model-cache";
import { warmClaudeModelCache } from "../src/claude-model-cache";
import { CODEX_MANAGED_VERSION } from "../src/codex-managed-installer";
import { allowFromRemote, remoteRequiresBoundSession, transformHostMsgForRemote } from "../src/remote-policy";

vi.mock("../src/cli-process", () => ({ execGrokCli: vi.fn() }));
vi.mock("../src/codex-model-cache", () => ({ warmCodexModelCache: vi.fn() }));
vi.mock("../src/claude-model-cache", () => ({ warmClaudeModelCache: vi.fn() }));

const CACHE = "grok.providerModelCache";
const exec = vi.mocked(execGrokCli);
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

function harness(provider: "codex" | "claude") {
  const host = Object.create(GrokSidebar.prototype) as any;
  const local = new Session();
  local.provider = provider;
  local.activeSessionId = "local-thread";
  local.userMessageCount = 3;
  local.cwd = "/project";
  const phone = new Session();
  phone.provider = provider;
  phone.activeSessionId = "phone-thread";
  phone.userMessageCount = 1;
  const background = new Session();
  background.provider = provider;
  background.activeSessionId = "background-thread";
  const other = new Session();
  other.provider = "grok";
  for (const session of [local, phone, background, other]) {
    session.client = { disposeForUpdate: vi.fn(async () => {}) } as any;
  }
  const store: Record<string, any> = {
    [CACHE]: { [provider]: { models: [{ modelId: "old-model" }], cliVersion: "0.149.0" } },
  };
  Object.assign(host, {
    focused: local, pool: new Set([local, phone, background, other]),
    providerCliVersions: { [provider]: "0.149.0" }, providerCliUpdates: {},
    [`${provider}VersionProbe`]: Promise.resolve("0.149.0"),
    providerConnections: () => ({ [provider]: true }),
    locatedProviders: () => ({ [provider]: true }),
    locateProvider: vi.fn(() => "/installed/cli"),
    workspaceRoot: () => "/project",
    setProviderNeedsLogin: vi.fn(), emptySessionsForModelRefresh: () => [],
    state: { get: (key: string, fallback: unknown) => store[key] ?? fallback,
      update: async (key: string, value: unknown) => { store[key] = value; } },
    host: { appendLine: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
    terminalManager: { releaseOwnedBy: vi.fn(() => 0) },
    remoteClients: { clients: () => ["phone"], active: () => phone,
      isActiveValueVisible: (s: Session) => s === phone },
    post: vi.fn(), emit: vi.fn(), setStatus: vi.fn(),
    settingsEditor: { webview: { postMessage: vi.fn() } },
    // A resolved client means the conversation reopened. Returning undefined
    // unconditionally (as this fake used to) models a FAILED resume, which is
    // the state the update path must not report as success.
    startSession: vi.fn(async () => ({}) as unknown),
  });
  exec.mockImplementation(async (_path, args) => ({
    stdout: args[0] === "--version" ? `${provider} ${CODEX_MANAGED_VERSION}` : "arbitrary updater output",
    stderr: "",
  }));
  for (const warm of [vi.mocked(warmCodexModelCache), vi.mocked(warmClaudeModelCache)]) {
    warm.mockImplementation(async (options) => {
      await options.onModels([{ modelId: "new-model", name: "New model" }]);
    });
  }
  return { host, store, local, phone, background, other };
}

beforeEach(() => vi.clearAllMocks());

describe.each(["codex", "claude"] as const)("%s explicit CLI update", (provider) => {
  it("awaits every target process exit, re-observes the memoized version, and re-reads models", async () => {
    const { host, store, local, phone, background, other } = harness(provider);
    const exits = [defer(), defer(), defer()];
    [local, phone, background].forEach((s, i) => vi.mocked(s.client!.disposeForUpdate).mockReturnValue(exits[i].promise));
    const untouched = other.client;
    const updating = host.updateProviderCliOnDemand(provider);
    await vi.waitFor(() => expect(local.client).toBeUndefined());
    expect(exec).not.toHaveBeenCalled();
    exits[0].resolve(); exits[1].resolve();
    await Promise.resolve();
    expect(exec).not.toHaveBeenCalled();
    exits[2].resolve();
    await updating;
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["update"], ["--version"]]);
    expect(exec.mock.calls[0][2]).toMatchObject({ windowsHide: true, closeStdin: true, timeout: 180_000 });
    expect(host.providerCliVersions[provider]).toBe(CODEX_MANAGED_VERSION);
    expect(store[CACHE][provider]).toMatchObject({ cliVersion: CODEX_MANAGED_VERSION, models: [{ modelId: "new-model" }] });
    expect(provider === "codex" ? warmCodexModelCache : warmClaudeModelCache).toHaveBeenCalledOnce();
    expect(other.client).toBe(untouched);
    expect(untouched!.disposeForUpdate).not.toHaveBeenCalled();
    // silent: this resume is ours, not the person's -- its failure must reach
    // the update row, never a red banner in a conversation they were reading.
    expect(host.startSession.mock.calls).toEqual([
      ["local-thread", local, "ensure", undefined, { silent: true }],
      ["phone-thread", phone, "ensure", undefined, { silent: true }],
    ]);
    expect(background.activeSessionId).toBe("background-thread");
    expect(host.pool.has(phone)).toBe(true);
    const frame = host.providerStateMessage();
    expect(frame.providers.find((p: any) => p.id === provider).cliUpdate.status).toBe("succeeded");
    expect(host.settingsEditor.webview.postMessage).toHaveBeenLastCalledWith(frame);
    expect(transformHostMsgForRemote(frame, { readFile: () => null, toBase64: () => "" })).toEqual(frame);
    expect(host.host.showWarningMessage).not.toHaveBeenCalled();
    expect(host.host.showInformationMessage).not.toHaveBeenCalled();
  });

  it("reports a nonzero exit even when stdout claims success, then probes and resumes", async () => {
    const { host } = harness(provider);
    exec.mockRejectedValueOnce(Object.assign(new Error("updater exited with code 7"), { code: 7, stdout: "Successfully updated" }));
    await host.updateProviderCliOnDemand(provider);
    expect(host.providerCliUpdates[provider]).toMatchObject({ status: "failed", message: expect.stringContaining("code 7") });
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["update"], ["--version"]]);
    expect(host.startSession).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh session rather than reopening one nobody typed in", async () => {
    // The owner pressed Update on an empty "New session" and was told the
    // conversation could not be reopened. Codex never persisted a session for
    // it -- the same absence behind "could not discard empty session ...:
    // Internal error" in the host log -- so the load could only fail, and the
    // row reported a loss of something that did not exist.
    const { host, local, phone } = harness(provider);
    local.userMessageCount = 0;
    await host.updateProviderCliOnDemand(provider);
    expect(host.startSession.mock.calls).toEqual([
      [undefined, local, "ensure", undefined, { silent: true }],
      ["phone-thread", phone, "ensure", undefined, { silent: true }],
    ]);
    expect(host.providerCliUpdates[provider]).toMatchObject({ status: "succeeded" });
  });

  it("forgets a finished update when the person starts a new conversation", async () => {
    // The row had no expiry and providerState carries it everywhere, so
    // "Update completed - Codex CLI v0.153.4" greeted the owner on the empty
    // state of every new conversation until the host restarted (2026-09-06).
    const { host } = harness(provider);
    await host.updateProviderCliOnDemand(provider);
    expect(host.providerCliUpdates[provider]).toMatchObject({ status: "succeeded" });
    host.postProviderState = vi.fn();
    (host as any).clearSettledCliUpdates();
    expect(host.providerCliUpdates[provider]).toBeUndefined();
    expect(host.postProviderState).toHaveBeenCalledOnce();
    // Idempotent: nothing settled left to forget, so no repaint.
    (host as any).clearSettledCliUpdates();
    expect(host.postProviderState).toHaveBeenCalledOnce();
  });

  it("clears a settled update wherever a new conversation is actually made", async () => {
    // The clear lived in `case "newSession"`, which is not where a new session
    // is made. Two deliberate doors never reach that case: a remote's New,
    // which serializesRemoteSessionTransition routes straight to
    // newRemoteSession, and the IDE's own newSession() command, which calls
    // newFocusedSession. So the owner kept being greeted by "Update completed"
    // on a fresh conversation from his phone (2026-09-06) -- with the
    // mechanism fully covered by the test above and the wiring covered by
    // nothing. Both constructors clear it FIRST, before anything else in them
    // can throw, which is what makes this assertable without a whole sidebar.
    for (const [make, arg] of [["newFocusedSession", "local"], ["newRemoteSession", "phone"]] as const) {
      const bare = Object.create(GrokSidebar.prototype) as Record<string, unknown>;
      const cleared = vi.fn();
      bare.clearSettledCliUpdates = cleared;
      await (bare[make] as (a: string) => Promise<void>).call(bare, arg).catch(() => {});
      expect(cleared, make).toHaveBeenCalledOnce();
    }
  });

  it("keeps an update that is still running", async () => {
    const { host } = harness(provider);
    host.providerCliUpdates = { [provider]: { status: "running", message: "Updating..." } };
    host.postProviderState = vi.fn();
    (host as any).clearSettledCliUpdates();
    expect(host.providerCliUpdates[provider]).toMatchObject({ status: "running" });
    expect(host.postProviderState).not.toHaveBeenCalled();
  });

  it("does not claim success when the conversation it reopened failed to start", async () => {
    // startSessionBody reports its own failure into the conversation and returns
    // undefined rather than throwing. The owner saw the result of trusting that:
    // "Update completed - Codex CLI v0.153.4" on the row, and a red "Failed to
    // start Codex: Internal error" in the conversation underneath it.
    const { host } = harness(provider);
    host.startSession = vi.fn(async () => undefined);
    await host.updateProviderCliOnDemand(provider);
    expect(host.startSession).toHaveBeenCalled();
    expect(host.providerCliUpdates[provider]).toMatchObject({
      status: "failed", message: expect.stringContaining("could not be reopened"),
    });
  });

  it("reports an unverifiable version instead of repeating the old observed version", async () => {
    const { host } = harness(provider);
    exec.mockResolvedValue({ stdout: "", stderr: "" });
    await host.updateProviderCliOnDemand(provider);
    expect(host.providerCliVersions[provider]).toBeUndefined();
    expect(host.providerCliUpdates[provider].message).toContain("could not be verified");
  });

  it("serializes repeat clicks and holds new session starts until binary replacement ends", async () => {
    const { host } = harness(provider);
    const updating = defer();
    exec.mockImplementationOnce(async () => { await updating.promise; return { stdout: "", stderr: "" }; });
    const run = host.updateProviderCliOnDemand(provider);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
    await host.updateProviderCliOnDemand(provider);
    const startBody = vi.fn(async () => undefined);
    host.startSessionBody = startBody;
    const newSession = new Session(); newSession.provider = provider;
    const started = (GrokSidebar.prototype as any).startSession.call(host, undefined, newSession);
    await Promise.resolve();
    expect(startBody).not.toHaveBeenCalled();
    updating.resolve();
    await Promise.all([run, started]);
    expect(startBody).toHaveBeenCalledOnce();
    expect(exec.mock.calls.filter((c) => c[1][0] === "update")).toHaveLength(1);
  });

  it("waits for an existing model probe and declines new probes during replacement", async () => {
    const { host } = harness(provider);
    const pending = defer();
    host.providerModelProbes = new Map([[provider, new Set([pending.promise])]]);
    const run = host.updateProviderCliOnDemand(provider);
    await Promise.resolve();
    expect(await host.reprobeProviderCredentials(provider)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    pending.resolve();
    await run;
    expect(exec).toHaveBeenCalled();
  });

  it("does not run the updater after a failed teardown and still releases the startup gate", async () => {
    const { host, local } = harness(provider);
    vi.mocked(local.client!.disposeForUpdate).mockRejectedValueOnce(new Error("process did not exit"));
    await host.updateProviderCliOnDemand(provider);
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"]]);
    expect(host.providerCliUpdate).toBeUndefined();
    expect(host.providerCliUpdates[provider].message).toContain("process did not exit");
  });

  it("drains history readers and prevents history refreshes during the update", async () => {
    const { host } = harness(provider);
    const reader = defer();
    host.adapterHistory = () => ({ refresh: new Map([["project", reader.promise]]) });
    const run = host.updateProviderCliOnDemand(provider);
    await host.refreshAdapterHistory(provider, "/project");
    await Promise.resolve();
    expect(exec).not.toHaveBeenCalled();
    reader.resolve();
    await run;
    expect(exec.mock.calls[0][1]).toEqual(["update"]);
  });

  it("waits for a late old version observation before clearing its memo", async () => {
    const { host } = harness(provider);
    const old = defer();
    host[`${provider}VersionProbe`] = old.promise.then(() => { host.providerCliVersions[provider] = "0.149.0"; });
    const run = host.updateProviderCliOnDemand(provider);
    await Promise.resolve();
    expect(exec).not.toHaveBeenCalled();
    old.resolve();
    await run;
    expect(host.providerCliVersions[provider]).toBe(CODEX_MANAGED_VERSION);
  });

  it("keeps a missing-binary failure in the UI even when the provider disappears", async () => {
    const { host } = harness(provider);
    host.locateProvider.mockReturnValue(undefined);
    host.locatedProviders = () => ({});
    await host.updateProviderCliOnDemand(provider);
    const entry = host.providerStateMessage().providers.find((p: any) => p.id === provider);
    expect(entry.connected).toBe(false);
    expect(entry.cliUpdate).toMatchObject({ status: "failed", message: expect.stringContaining("not found") });
    expect(exec).not.toHaveBeenCalled();
  });
});

it.each(["updateCodex", "updateClaude"] as const)("%s is available to full remotes without a bound conversation", (type) => {
  expect(allowFromRemote(type, "full")).toBe(true);
  expect(allowFromRemote(type, "propose")).toBe(false);
  expect(allowFromRemote(type, "view")).toBe(false);
  expect(remoteRequiresBoundSession(type)).toBe(false);
});

it.each(["0.149.0", CODEX_MANAGED_VERSION, "1.0.0"])("observes Codex %s against the shipped version without polling", (version) => {
  const { host } = harness("codex");
  host.providerCliVersions.codex = version;
  const codex = host.providerStateMessage().providers.find((p: any) => p.id === "codex");
  expect(codex.latestCliVersion).toBe(CODEX_MANAGED_VERSION);
  expect(codex.updateAvailable).toBe(version === "0.149.0");
  expect(exec).not.toHaveBeenCalled();
});
