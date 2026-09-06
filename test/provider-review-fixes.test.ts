import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { sessionsDirFor, type SessionListEntry } from "../src/sessions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8").replace(/\r\n/g, "\n");
const desktopSources = fs.readdirSync(path.join(root, "src", "desktop"))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => fs.readFileSync(path.join(root, "src", "desktop", name), "utf8"))
  .join("\n");

function methodBody(signature: string): string {
  const start = sidebar.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const next = sidebar.indexOf("\n  private ", start + signature.length);
  return sidebar.slice(start, next < 0 ? sidebar.length : next);
}

describe("multi-provider review regressions", () => {
  it("proves cold Codex session existence from the adapter-backed cache before Grok disk lookup", () => {
    const body = methodBody("private remoteSessionTarget(");
    expect(body).toContain("findCachedAdapterSession(");
    expect(body.indexOf("findCachedAdapterSession(")).toBeLessThan(body.indexOf("indexSessions("));
    expect(body).toContain("sessionCwdBelongsToRepo");
  });

  it("builds pinned Codex rows from the adapter-backed cache", () => {
    const body = methodBody("private buildPinnedSessions(");
    expect(body).toContain("this.allAdapterCatalogs()");
    expect(body).toContain("this.scheduleAdapterHistoryRefresh");
    expect(body).toContain("findCachedAdapterSession(");
    expect(body).toContain("pinnedAt: overrides[id]?.pinnedAt");
  });

  it("uses one ordinary Grok page and the complete cached Codex catalog for combined history", () => {
    const body = methodBody("private buildSessionsList(");
    expect(body).toContain("{ offset: providerCursor.grokOffset, limit, query }");
    expect(body).toContain("providers.includes(\"codex\")");
    expect(body).toContain("providers.includes(\"claude\")");
    expect(body).not.toContain("slotOffsets");
    expect(body).not.toContain("lookAhead");
  });

  it("real remote history request revalidates cwd before scheduling a Codex adapter scan", () => {
    const instance = Object.create(GrokSidebar.prototype) as any;
    const closed = path.join(os.tmpdir(), "closed-project");
    const open = path.join(os.tmpdir(), "open-project");
    const remoteClients = new RemoteClientState<Session>(closed);
    remoteClients.ready("phone");
    const session = new Session();
    session.cwd = closed;
    session.provider = "codex";
    remoteClients.setActive("phone", session);
    instance.remoteClients = remoteClients;
    instance.focused = new Session();
    instance.host = { appendLine: vi.fn() };
    instance.remoteTargetableCwd = vi.fn(() => true);
    // The project closes after ingress validation but before the list builder.
    // The combined builder must own the second check because it owns the scan.
    instance.authorizedSessionCwds = vi
      .fn()
      .mockReturnValueOnce([closed])
      .mockReturnValue([open]);
    instance.isAuthorizedCwd = vi.fn(() => false);
    instance.sendRemoteClient = vi.fn();
    instance.scheduleCodexHistoryRefresh = vi.fn();
    instance.codexSessionCache = new Map([["sentinel", [{ id: "keep" }]]]);
    instance.codexSessionCacheAt = new Map([["sentinel", 123]]);

    instance.installTestHooks().fromRemote({ type: "listSessions", offset: 0, query: "" }, "phone");

    expect(instance.scheduleCodexHistoryRefresh).not.toHaveBeenCalled();
    expect(instance.codexSessionCache.get("sentinel")).toEqual([{ id: "keep" }]);
    expect(instance.codexSessionCacheAt.get("sentinel")).toBe(123);
    expect(instance.sendRemoteClient).toHaveBeenCalledWith("phone", {
      type: "sessions",
      entries: [],
      activeId: null,
      dots: {},
      offset: 0,
      total: 0,
      hasMore: false,
      nextOffset: 0,
      query: "",
    });
  });

  it("exact-sorts the loaded Grok window before combined-provider merging", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-combined-order-"));
    const cwd = path.join(grokHome, "repo");
    const catalog = sessionsDirFor(grokHome, cwd);
    const previousHome = process.env.GROK_HOME;
    try {
      process.env.GROK_HOME = grokHome;
      for (const [id, mtime] of [["mtime-new", 2_000], ["mtime-old", 1_000]] as const) {
        const dir = path.join(catalog, id);
        fs.mkdirSync(dir, { recursive: true });
        const summary = path.join(dir, "summary.json");
        fs.writeFileSync(summary, "{}");
        fs.utimesSync(summary, mtime / 1_000, mtime / 1_000);
      }

      const instance = Object.create(GrokSidebar.prototype) as any;
      instance.authorizedSessionCwds = vi.fn(() => [cwd]);
      instance.sessionCwdsForRepo = vi.fn(() => [cwd]);
      instance.refreshWorktreeCache = vi.fn(async () => {});
      instance.state = { get: vi.fn(() => ({})) };
      instance.host = { appendLine: vi.fn() };
      instance.pool = new Set<Session>();
      instance.annotateWorktreeLabels = vi.fn();
      instance.dotForId = vi.fn(() => "none");
      instance.readEntriesCachedMulti = vi.fn((ids: string[]) => ids.map((id): SessionListEntry => ({
        id,
        cwd,
        displayName: id,
        rawSummary: id,
        updatedAt: id === "mtime-old" ? 200 : 100,
        createdAt: 1,
        numMessages: 1,
      })));

      const result = instance.buildGrokSessionsList(
        cwd,
        { offset: 0, limit: 2 },
        null,
      );

      expect(result.entries.map((entry: SessionListEntry) => entry.id)).toEqual(["mtime-old", "mtime-new"]);
      expect(result.nextOffset).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previousHome;
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("routes every sidebar Codex discovery through the class-owned locator", () => {
    expect(sidebar.match(/locateCodexCli\(/g)).toHaveLength(1);
    expect(desktopSources).not.toContain("locateCodexCli(");
    const start = methodBody("private async startSessionBody(");
    expect(start).toContain("this.locateProvider(session.provider)");
    expect(start).not.toContain("locateCodexCli(");
    const owner = methodBody("private locateProvider(");
    expect(owner).toContain("managedStorageRoot: this.context.globalStorageUri.fsPath");
    expect(owner).toContain("arch: process.arch");
  });

  it("observes Codex logout success before entering the synchronous logout reset", () => {
    const body = sidebar.slice(sidebar.indexOf("async logout("), sidebar.indexOf("dispose(): void"));
    const exec = body.indexOf("await execGrokCli(cliPath, logoutArgs");
    // Matched without its argument list: the invariant is the ORDER — the CLI is
    // observed to succeed before the reset — not the call's exact shape. Pinning
    // the full literal broke when a `report` callback was threaded through so a
    // cloud environment's failures reach the person who asked, which changed
    // nothing about the ordering this guards.
    const disconnect = body.indexOf("await this.finishProviderLogout(provider");
    expect(exec).toBeGreaterThan(-1);
    expect(disconnect).toBeGreaterThan(exec);
    expect(body.slice(exec, disconnect)).toContain("catch (error)");
    expect(body).toContain("The account remains connected");
    expect(body).toContain("this.locateProvider(provider)");
    expect(body).toContain('this.locateProvider("grok")');
    expect(body).toContain("await this.finishProviderLogout(provider");
    expect(body).toContain('await this.finishProviderLogout("grok"');
  });

  it("posts provider-specific recovery UI after a second auth failure", () => {
    const body = methodBody("private async recoverAuthAndResend(");
    // Via onboardingForSession, which still resolves to providerLoginState for
    // this case — the provider IS connected, its credentials just died — and
    // falls back to the three-way chooser only when nothing is connected at
    // all, where naming one agent's login would name one nobody picked.
    expect(body).toContain("this.onboardingForSession(session)");
  });

  it("routes Re-check through the provider credential probe without allowing Codex warm-up failure to escape", () => {
    const warm = methodBody("private async warmConnectedCodexModels(");
    expect(warm).toContain("await warmCodexModelCache(");
    expect(warm).toContain("model-cache warm-up failed");
    const reprobe = methodBody("private async reprobeProviderCredentials(");
    expect(reprobe).toContain('if (provider === "codex")');
    expect(reprobe).toContain("this.warmConnectedCodexModels()");
    const recheck = sidebar.slice(sidebar.indexOf('case "recheckConnection":'), sidebar.indexOf('case "logout":'));
    expect(recheck).toContain("await this.reprobeProviderCredentials(provider)");
  });

  it("refuses to clear adapter history that could not be refreshed", () => {
    const body = methodBody("private async clearAllSessions(");
    expect(body).toContain("const adapterHistoryChecked = new Set<AcpProvider>()");
    expect(body).toContain("adapterHistoryChecked.add(provider)");
    expect(body).toContain("adapterEntriesEligibleForClear(");
    const catchIdx = body.indexOf("history could not be checked, so its conversations were not cleared");
    const addIdx = body.indexOf("adapterHistoryChecked.add(provider)");
    const eligibleIdx = body.indexOf("adapterEntriesEligibleForClear(");
    const skipIdx = body.indexOf("if (!adapterHistoryChecked.has(provider)) continue");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(eligibleIdx).toBeGreaterThan(catchIdx);
    expect(skipIdx).toBeGreaterThan(eligibleIdx);
  });

  it("tears down ownerless live sessions before deleting their directories", () => {
    // Same lesson as deleteSession: a grok process holding the dir makes the
    // Windows delete fail, and the row comes back as a live-empty "New session".
    const body = methodBody("private async clearAllSessions(");
    const dispose = body.indexOf("this.disposeSession(s)");
    const clear = body.indexOf("clearSessions({");
    expect(dispose).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(dispose);
    expect(body).toContain("if (this.sessionHasLiveOwner(s)) continue");
    expect(body).toContain("this.sendLocalRepoSessionsPreview(cwd)");
  });

  it("never sweeps past the newest-N window, however tempting the old shells look", () => {
    const body = methodBody("private sweepEmptySessions(");
    // The scan stays bounded. Walking every `hasTranscript === false` entry
    // would reach shells that fell off the window — but that flag is a
    // SNAPSHOT, and another editor window can start a session's first prompt
    // after it was taken. The age gate does not save it either: an old session
    // that stayed open still looks stale, so an in-progress first write could
    // be deleted from a second window, unrecoverably. Historical shells are
    // inert; a lost conversation is not. Creation is stopped at the probe
    // instead (see the scratch cwd), which needs no such gamble.
    expect(body).toContain("GrokSidebar.SWEEP_SCAN_LIMIT");
    expect(body).not.toContain("entry.hasTranscript !== false");
  });

  it("freezes adapter listing time on first discovery for Codex and Claude", () => {
    const body = methodBody("private async refreshAdapterHistory(");
    expect(body).toContain("if (typeof previous.activeAt === \"number\") continue");
    expect(body).toContain("activeAt: adapterListEntry(entry, {}, provider, Date.now()).updatedAt");
    // No provider carve-out — Claude restamps on load, same pin Codex already had.
    expect(body).not.toContain('if (provider === "codex")');
    expect(body).not.toContain("...(provider === \"codex\"");
  });

  it("puts minimal provider state in every remote client snapshot", () => {
    const instance = Object.create(GrokSidebar.prototype) as any;
    instance.providerConnections = vi.fn(() => ({ grok: true, codex: true }));
    instance.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: false }));
    expect(instance.providerStateMessage()).toEqual({
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: false },
        { id: "claude", connected: false },
        { id: "gemini", connected: false },
      ],
    });

    const snapshot = methodBody("private buildRemoteSnapshot(");
    expect(snapshot).toContain("snap.push(this.providerStateMessage());");
    expect(snapshot).toContain("snap.push(this.mcpConnectorsMessage());");
    expect(snapshot).toContain("this.mcpServersMessage()");
    expect(snapshot).not.toContain("mcpServersMessageForCwd");
    expect(snapshot).not.toContain("mcpViewCwd");
    expect(snapshot).not.toContain("this.mcpServersMessage(session || this.focused)");
    expect(snapshot.indexOf("snap.push(initial);")).toBeLessThan(
      snapshot.indexOf("snap.push(this.providerStateMessage());"),
    );
  });

  it("routes an empty remote provider pick through the cross-backend restart", async () => {
    const instance = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    session.provider = "grok";
    session.activeSessionId = "empty-grok";
    session.client = { setModel: vi.fn() } as any;
    instance.connectedProviders = vi.fn(() => ["grok", "codex"]);
    instance.sessionCwd = vi.fn(() => "/repo");
    instance.rememberProjectProvider = vi.fn(async () => {});
    instance.startSession = vi.fn(async () => {});
    instance.discardRestartedEmptySession = vi.fn();

    await instance.switchModel("gpt-5.6-sol", session, { clientId: "phone" }, "codex");

    expect(session.provider).toBe("codex");
    expect(instance.rememberProjectProvider).toHaveBeenCalledWith("/repo", "codex", "gpt-5.6-sol");
    expect(instance.startSession).toHaveBeenCalledWith(undefined, session);
    expect(instance.discardRestartedEmptySession).toHaveBeenCalledWith("empty-grok", session);
    expect(session.client.setModel).not.toHaveBeenCalled();
  });

  it("infers an old client's cross-provider model and returns a targeted backstop", async () => {
    const instance = Object.create(GrokSidebar.prototype) as any;
    instance.state = {
      get: vi.fn(() => ({
        grok: { models: [{ modelId: "grok-build" }], seenAt: 1 },
        codex: { models: [{ modelId: "gpt-5.6-sol" }], seenAt: 1 },
      })),
    };
    const inferred = instance.providerForRequestedModel("grok-build", "codex");
    expect(inferred).toBe("grok");

    const session = new Session();
    session.provider = "codex";
    session.hasHistory = true;
    session.client = { setModel: vi.fn(async () => { throw new Error("Invalid params (-32602)"); }) } as any;
    instance.sendRemoteRequester = vi.fn();

    await instance.switchModel("grok-build", session, { clientId: "phone" }, inferred);

    expect(session.client.setModel).not.toHaveBeenCalled();
    expect(instance.sendRemoteRequester).toHaveBeenCalledWith(
      { clientId: "phone" },
      {
        type: "hostNotice",
        level: "warning",
        text: "This Codex conversation can only use Codex models. Start a new conversation to switch to Grok.",
      },
    );
    expect(sidebar.slice(sidebar.indexOf('case "setModel":'), sidebar.indexOf('case "installCodex":')))
      .toContain("providerForRequestedModel");
  });
});

describe("deleting a conversation on a machine nobody sits at", () => {
  // The owner, on a Cloud machine, could not delete a conversation he had
  // just navigated away from: "This conversation is open in another tab or
  // the VS Code view." There is no other tab and no VS Code view there. Five
  // identical refusals in one evening.

  it("does not let the host's own focus claim a session on a cloud machine", () => {
    // `this.focused` is a real second surface at a desk and a phantom on a
    // cloud VM: the host keeps one, nobody is ever looking at it, and it does
    // not move when the only real user switches conversations. So whatever it
    // adopted stayed owned for good.
    const body = methodBody("private sessionHasLiveOwner(");
    expect(body).toContain("!isCloudEnvironment()");
    // Remote ownership is untouched — a second phone or tab still protects a
    // conversation, on cloud exactly as anywhere else.
    expect(body).toContain("this.remoteClients.isActiveValueVisible(session)");
  });

  it("removes the row even when the provider refuses the delete", () => {
    // Codex deletes with one `threadArchive(threadId)` and Claude removes a
    // session file; BOTH throw when the thread was never written, which is
    // every conversation nobody has used yet. The error was the visible half.
    // The damaging half was the `return` after it: the host abandoned its own
    // cleanup, so a failed delete left a row that could never be sent to.
    const body = methodBody("async deleteSession(");
    const call = body.indexOf("client.deleteSession(id)");
    const cleanup = body.indexOf("if (live) this.disposeSession(live);");
    expect(call).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(call);
    // No early exit between the provider call and our cleanup.
    expect(body.slice(call, cleanup)).not.toContain("return;");
  });

  it("does not tell the person their own system failed", () => {
    // The overwhelmingly common cause is a thread that was never there, so
    // the refusal is not news — it is the delete succeeding by another name.
    // A genuine provider failure returns the row on the next listing refresh,
    // which is visible and recoverable; neither outcome loses written work.
    const body = methodBody("async deleteSession(");
    const at = body.indexOf("could not delete");
    expect(at).toBeGreaterThan(-1);
    const adapterHalf = body.slice(0, body.indexOf("deleteSessionDir("));
    expect(adapterHalf).not.toContain("refused to delete this conversation");
    expect(adapterHalf).not.toContain("showErrorMessage");
  });

  it("stopped predicting whether the provider has a thread", () => {
    // Three attempts guessed and each was wrong in a different direction:
    // `hasHistory` (a suppressed Summarize & Restart turn writes a thread the
    // row calls empty), a flag set at the prompt call site (a prompt that
    // THREW still looked written), and one set from provider output (the user
    // turn persists before any agent output arrives). Guessing wrong one way
    // orphans a real thread; the other way is the original bug. The host
    // cannot see the moment a provider persists, so it no longer tries.
    expect(sidebar).not.toContain("providerWrote");
    expect(sidebar).not.toContain("providerPrompted");
  });

  it("a refused resume changes the words, never the behaviour", () => {
    // The pinned Claude adapter raises -32002 for two unrelated causes:
    //   "Query closed before response received"  (a query that died mid-resume)
    //   "No conversation found with session ID"  (missing or message-less)
    // The first happens to conversations holding real work. An earlier version
    // read this code as "empty" and started a fresh session on it, which opens
    // a blank transcript and tells the person their conversation never held
    // anything — while it sits on disk. Reverted; this pins the reason.
    const at = sidebar.indexOf("isResumeNotFound(err)");
    expect(at).toBeGreaterThan(-1);
    // Bounded to THIS branch: the next one legitimately quotes the adapter,
    // which is correct for a failure we cannot describe better.
    const branch = sidebar.slice(at, sidebar.indexOf("} else {", at));
    expect(branch).not.toContain("newSession(");
    expect(branch).not.toContain("activeSessionId =");
    expect(branch).not.toContain("hasHistory =");
    // And it must not quote the adapter or the id at the person.
    expect(branch).not.toContain("${msg}");
  });

  it("says WHY it refused, in the line it writes", () => {
    // The bare version said "owned elsewhere" and could not say by whom. The
    // answer was one field away and it cost an evening of guessing.
    const src = sidebar;
    const at = src.indexOf("refused delete of live session");
    expect(at).toBeGreaterThan(-1);
    const line = src.slice(at, at + 400);
    expect(line).toContain("localFocused=");
    expect(line).toContain("cloud=");
    expect(line).toContain("remoteOwners=");
    expect(line).toContain("requesterWatches=");
  });

});
