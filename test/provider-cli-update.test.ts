import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { execGrokCli } from "../src/cli-process";
import { warmCodexModelCache } from "../src/codex-model-cache";
import { warmClaudeModelCache } from "../src/claude-model-cache";
import { CODEX_MANAGED_VERSION } from "../src/codex-managed-installer";
import { CLAUDE_PINNED_CLI_VERSION } from "../src/claude-backend";
import { allowFromRemote, remoteRequiresBoundSession, transformHostMsgForRemote } from "../src/remote-policy";

vi.mock("../src/cli-process", () => ({ execGrokCli: vi.fn() }));
vi.mock("../src/codex-model-cache", () => ({ warmCodexModelCache: vi.fn() }));
vi.mock("../src/claude-model-cache", () => ({ warmClaudeModelCache: vi.fn() }));

const CACHE = "grok.providerModelCache";
/** What is on disk BEFORE the update, matching the harness's cached row.
 *  Older than both pins, so the freshness guard lets the update proceed. */
const INSTALLED_BEFORE = "0.149.0";
/** What the CLI's own updater is asked, now that the plan carries a target.
 *  claude takes `install <version>`; codex has no measured version-capable
 *  spelling of its own, so it keeps the plain update. */
const updaterArgs = (provider: "codex" | "claude") =>
  provider === "claude" ? ["install", CLAUDE_PINNED_CLI_VERSION] : ["update"];
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
  // `--version` answers what is INSTALLED, and a successful updater run is what
  // changes it. The update path now reads the version twice — once before it
  // tears anything down, once after — so a single static answer would make a
  // real update look like a no-op to the freshness guard. Modelling the state
  // rather than counting calls also survives the probes other tests fire first.
  let installed = INSTALLED_BEFORE;
  const versionReply = () => ({ stdout: `${provider} ${installed}`, stderr: "" });
  exec.mockImplementation(async (_path, args) => {
    if (args[0] === "--version") return versionReply();
    installed = CODEX_MANAGED_VERSION;
    return { stdout: "arbitrary updater output", stderr: "" };
  });
  /** Fail the UPDATER only, leaving the version reads working — a bare
   *  `mockRejectedValueOnce` would land on the freshness probe instead. The
   *  installed version stays put, which is what a failed update means. */
  const rejectUpdater = (error: unknown) => exec.mockImplementation(async (_path, args) => {
    if (args[0] === "--version") return versionReply() as never;
    throw error;
  });
  for (const warm of [vi.mocked(warmCodexModelCache), vi.mocked(warmClaudeModelCache)]) {
    warm.mockImplementation(async (options) => {
      await options.onModels([{ modelId: "new-model", name: "New model" }]);
    });
  }
  return { host, store, local, phone, background, other, rejectUpdater };
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
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"]]);
    exits[0].resolve(); exits[1].resolve();
    await Promise.resolve();
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"]]);
    exits[2].resolve();
    await updating;
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"], updaterArgs(provider), ["--version"]]);
    expect(exec.mock.calls[1][2]).toMatchObject({ windowsHide: true, closeStdin: true, timeout: 180_000 });
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
    const { host, rejectUpdater } = harness(provider);
    rejectUpdater(Object.assign(new Error("updater exited with code 7"), { code: 7, stdout: "Successfully updated" }));
    await host.updateProviderCliOnDemand(provider);
    expect(host.providerCliUpdates[provider]).toMatchObject({ status: "failed", message: expect.stringContaining("code 7") });
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"], updaterArgs(provider), ["--version"]]);
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
    expect(exec.mock.calls.filter((c) => c[1][0] !== "--version")).toHaveLength(1);
  });

  it("waits for an existing model probe and declines new probes during replacement", async () => {
    const { host } = harness(provider);
    const pending = defer();
    host.providerModelProbes = new Map([[provider, new Set([pending.promise])]]);
    const run = host.updateProviderCliOnDemand(provider);
    await Promise.resolve();
    expect(await host.reprobeProviderCredentials(provider)).toBe(false);
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"]]);
    pending.resolve();
    await run;
    expect(exec).toHaveBeenCalled();
  });

  it("does not run the updater after a failed teardown and still releases the startup gate", async () => {
    const { host, local } = harness(provider);
    vi.mocked(local.client!.disposeForUpdate).mockRejectedValueOnce(new Error("process did not exit"));
    await host.updateProviderCliOnDemand(provider);
    // The freshness read, then the finally's re-probe. The updater never ran.
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"], ["--version"]]);
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
    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"]]);
    reader.resolve();
    await run;
    expect(exec.mock.calls[1][1]).toEqual(updaterArgs(provider));
  });

  it("waits for a late old version observation before clearing its memo", async () => {
    const { host } = harness(provider);
    const old = defer();
    host[`${provider}VersionProbe`] = old.promise.then(() => { host.providerCliVersions[provider] = "0.149.0"; });
    const run = host.updateProviderCliOnDemand(provider);
    await Promise.resolve();
    // Nothing is spawned yet: the freshness read drains the in-flight probe
    // before dropping the memo, so a late answer cannot land on top of it.
    expect(exec).not.toHaveBeenCalled();
    old.resolve();
    await run;
    expect(host.providerCliVersions[provider]).toBe(CODEX_MANAGED_VERSION);
  });

  it("says so instead of stopping sessions when the CLI is already on the pin", async () => {
    // The row that enables this button can be minutes old: the person may have
    // updated in a terminal, or another window may have run this already. What
    // used to follow was the full teardown -- every conversation on this
    // provider stopped and reopened -- to install a version already on disk.
    const { host, local, phone } = harness(provider);
    const pinned = provider === "codex" ? CODEX_MANAGED_VERSION : CLAUDE_PINNED_CLI_VERSION;
    exec.mockImplementation(async (_path, args) => ({
      stdout: args[0] === "--version" ? `${provider} ${pinned}` : "arbitrary updater output",
      stderr: "",
    }));
    const clients = [local.client, phone.client];

    await host.updateProviderCliOnDemand(provider);

    expect(exec.mock.calls.map((c) => c[1])).toEqual([["--version"]]);
    expect(host.providerCliUpdates[provider]).toMatchObject({
      status: "succeeded", message: expect.stringContaining(`already on v${pinned}`),
    });
    // Nothing was torn down, and nothing was reopened -- the difference between
    // a no-op and the old behaviour is exactly these two lines.
    expect([local.client, phone.client]).toEqual(clients);
    expect(local.client!.disposeForUpdate).not.toHaveBeenCalled();
    expect(host.startSession).not.toHaveBeenCalled();
    // The gate is released, or every later session start would wait on it.
    expect(host.providerCliUpdate).toBeUndefined();
  });

  it("still updates when the installed version is merely unreadable", async () => {
    // An unparseable `--version` is not evidence of being current. Refusing to
    // update on it would strand a machine on a broken binary with no way back.
    const { host } = harness(provider);
    exec.mockImplementation(async (_path, args) => ({
      stdout: args[0] === "--version" ? "" : "arbitrary updater output", stderr: "",
    }));
    await host.updateProviderCliOnDemand(provider);
    expect(exec.mock.calls.map((c) => c[1])).toContainEqual(updaterArgs(provider));
  });

  it("installs the version the product shows, not whatever npm calls latest", async () => {
    // Settings has already told this person their target is `latestCliVersion`
    // and computed "update available" against it. Fetching `@latest` installed
    // a number they were never shown and left the row still offering an update.
    const { host } = harness(provider);
    const pkg = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
    const pinned = provider === "codex" ? CODEX_MANAGED_VERSION : CLAUDE_PINNED_CLI_VERSION;
    host.locateProvider = vi.fn(() => `/home/x/.local/lib/node_modules/${pkg}/bin/cli.js`);
    host.isManagedCodexBinary = () => false;

    await host.updateProviderCliOnDemand(provider);

    const install = exec.mock.calls.find((c) => c[1][0] === "install");
    expect(install![1]).toEqual(["install", "-g", "--prefix", "/home/x/.local", `${pkg}@${pinned}`]);
    expect(install![1].join(" ")).not.toContain("@latest");
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

/**
 * Grok's own Update button, which #10 originally left alone.
 *
 * It is the one CLI whose update path is separate — grok holds its binary open
 * while running, so this tears the WHOLE pool down and resumes, where codex and
 * claude only stop the sessions on that provider. That makes an unnecessary run
 * of it the most expensive of the three, and it was the one still doing it.
 */
describe("grok explicit CLI update", () => {
  function grokHarness(check: () => { stdout: string; stderr: string }) {
    const host = Object.create(GrokSidebar.prototype) as any;
    const focused = new Session();
    focused.provider = "grok";
    focused.activeSessionId = "grok-thread";
    focused.cwd = "/project";
    Object.assign(host, {
      focused,
      pool: new Set([focused]),
      providerCliVersions: {},
      locateProvider: vi.fn(() => "/installed/grok"),
      host: { appendLine: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
      post: vi.fn(),
      settingsEditor: { webview: { postMessage: vi.fn() } },
      newLocalSession: vi.fn(() => new Session()),
      disposePool: vi.fn(async () => {}),
      runGrokUpdate: vi.fn(async () => {}),
      startSession: vi.fn(async () => ({}) as unknown),
    });
    exec.mockImplementation(async (_path, args) => {
      if (args[0] === "--version") return { stdout: "grok 1.4.2", stderr: "" };
      return check();
    });
    return host;
  }

  const current = () => ({
    stdout: JSON.stringify({ currentVersion: "1.4.2", latestVersion: "1.4.2", updateAvailable: false }),
    stderr: "",
  });

  it("says so instead of tearing the pool down when grok is already current", async () => {
    const host = grokHarness(current);
    await host.updateGrokCliOnDemand();
    // The expensive half never ran: no teardown, no update, no resume, and the
    // conversation the person was reading is still the focused one.
    expect(host.disposePool).not.toHaveBeenCalled();
    expect(host.runGrokUpdate).not.toHaveBeenCalled();
    expect(host.startSession).not.toHaveBeenCalled();
    expect(host.newLocalSession).not.toHaveBeenCalled();
    expect(host.post).not.toHaveBeenCalledWith({ type: "cliUpdating" });
    expect(host.focused.activeSessionId).toBe("grok-thread");
    expect(host.host.showInformationMessage).toHaveBeenCalledWith(
      "Grok Build CLI is already on v1.4.2.",
    );
    // The stale row that offered the button is corrected in the same breath, on
    // both surfaces — otherwise the only way to learn is to press it again.
    const status = { type: "grokUpdateStatus", current: "1.4.2", latest: "1.4.2", updateAvailable: false, policy: { allow: true } };
    expect(host.post).toHaveBeenCalledWith(status);
    expect(host.settingsEditor.webview.postMessage).toHaveBeenCalledWith(status);
  });

  it("updates when the check says a newer one exists", async () => {
    const host = grokHarness(() => ({
      stdout: JSON.stringify({ currentVersion: "1.4.2", latestVersion: "1.5.0", updateAvailable: true }),
      stderr: "",
    }));
    await host.updateGrokCliOnDemand();
    expect(host.runGrokUpdate).toHaveBeenCalledWith("/installed/grok", ["update"]);
    expect(host.startSession).toHaveBeenCalledWith("grok-thread");
  });

  it("updates rather than trusting a check that could not answer", async () => {
    const host = grokHarness(() => { throw new Error("network unreachable"); });
    await host.updateGrokCliOnDemand();
    // Not evidence of being current: refusing here would strand someone on a
    // binary too broken to describe itself, which is the state they came to fix.
    expect(host.runGrokUpdate).toHaveBeenCalledWith("/installed/grok", ["update"]);
    expect(host.host.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("network unreachable"),
    );
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
