import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { normalizeRepoPath, sessionsDirFor } from "../src/sessions";
import { routinesMessageForRemote } from "../src/remote-policy";
import type { HostMsg } from "../src/protocol";

describe("project archive presentation", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-project-archive-"));
    vi.stubEnv("GROK_HOME", path.join(root, "grok"));
    vi.stubEnv("GROK_CLOUD_ENVIRONMENT", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function setup(desktop = true, provider: "grok" | "codex" | "claude" = "grok") {
    const repo = path.join(root, "repo");
    const app = path.join(repo, "packages", "app");
    const worktree = path.join(root, "worktree");
    for (const dir of [app, worktree, path.join(repo, ".git")]) fs.mkdirSync(dir, { recursive: true });
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const stored: Record<string, any> = {
      "grok.sessionMeta": {
        conversation: { pinnedCwd: app, pinnedAt: 1, provider },
        worktree: { worktreePath: worktree, sourceGitRoot: repo },
      },
    };
    sidebar.state = {
      get: (key: string, fallback: unknown) => stored[key] ?? fallback,
      update: vi.fn(async (key: string, value: unknown) => { stored[key] = value; }),
    };
    sidebar.host = {
      canSwitchWorkspaceFolder: desktop,
      canArchiveRepos: true,
      workspaceRoot: () => repo,
      appendLine: vi.fn(),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    };
    sidebar.context = { extensionVersion: "test" };
    sidebar.appPurpose = () => "coding";
    sidebar.workspaceRoot = () => repo;
    sidebar.openWorkspaceFolders = () => [repo, app];
    sidebar.selectedRepoCwd = repo;
    sidebar.authEpoch = 7;
    sidebar.focused = new Session();
    sidebar.focused.cwd = repo;
    sidebar.pool = new Set();
    sidebar.worktreeCache = [];
    sidebar.remoteClients = new RemoteClientState<Session>(app);
    sidebar.remoteClients.ready("phone");
    sidebar.defaultProviderForProject = () => provider;
    sidebar.connectedProviders = () => [provider];
    sidebar.postLocal = vi.fn();
    sidebar.uplink = { broadcastTo: vi.fn() };
    sidebar.remoteMediaDeps = {};
    sidebar.refreshWorktreeCache = vi.fn();
    sidebar.scheduleAdapterHistoryRefresh = vi.fn();
    sidebar.annotateWorktreeLabels = vi.fn();
    sidebar.dotForId = () => "idle";
    const row = {
      id: "conversation", cwd: app, provider, displayName: "Still reachable",
      rawSummary: "Still reachable", createdAt: 1, updatedAt: 1, numMessages: 2,
    };
    sidebar.codexSessionCache = new Map(provider === "codex" ? [[normalizeRepoPath(app), [row]]] : []);
    sidebar.claudeSessionCache = new Map(provider === "claude" ? [[normalizeRepoPath(app), [row]]] : []);
    sidebar.readEntriesCachedMulti = (ids: string[]) => ids.includes(row.id) ? [{ ...row }] : [];
    if (provider === "grok") {
      const dir = path.join(sessionsDirFor(process.env.GROK_HOME!, app), row.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "summary.json"), "{}");
    }
    return { sidebar, stored, repo, app, worktree, row };
  }

  it.each(["grok", "codex", "claude"] as const)(
    "remote archive and unarchive keep %s projects, history and pins reachable",
    async (provider) => {
      const { sidebar, stored, app, worktree, row } = setup(true, provider);
      // No active session: project curation needs only the catalog capability.
      expect(sidebar.remoteClients.active("phone")).toBeUndefined();
      const trusted = sidebar.authorizedSessionCwds();
      const epoch = sidebar.authEpoch;
      sidebar.handleRemoteMessage("phone", { type: "setRepoArchived", cwd: app, archived: true });
      await vi.waitFor(() => expect(sidebar.uplink.broadcastTo).toHaveBeenCalled());
      expect(stored["grok.repoArchives"][normalizeRepoPath(app)].archived).toBe(true);
      expect(sidebar.authorizedSessionCwds()).toEqual(trusted);
      expect(sidebar.authEpoch).toBe(epoch);
      expect(sidebar.remoteTargetableCwd(app)).toBe(true);
      expect(sidebar.remoteTargetableCwd(worktree)).toBe(true);
      const image = path.join(app, "result.png");
      fs.writeFileSync(image, "image fixture");
      expect(sidebar.isImagePathAuthorizedNow(image)).toBe(true);
      expect(sidebar.buildRemoteReposMsg("phone")).toMatchObject({
        selectedCwd: app, entries: expect.arrayContaining([expect.objectContaining({ cwd: app, archived: true })]),
      });
      sidebar.uplink.broadcastTo.mockClear();
      sidebar.handleRemoteMessage("phone", { type: "listRepoSessions", cwd: app });
      expect(sidebar.uplink.broadcastTo).toHaveBeenCalledWith(["phone"], expect.objectContaining({
        type: "repoSessions", cwd: app, entries: [expect.objectContaining({ id: row.id })],
      }), app);
      expect(sidebar.buildPinnedSessions().entries).toContainEqual(expect.objectContaining({ id: row.id }));
      sidebar.sendRemoteClient("phone", { type: "messageChunk", text: "still working" }, app);
      expect(sidebar.uplink.broadcastTo).toHaveBeenCalledWith(["phone"], {
        type: "messageChunk", text: "still working",
      }, app);

      sidebar.handleRemoteMessage("phone", { type: "setRepoArchived", cwd: app, archived: false });
      await vi.waitFor(() => expect(sidebar.buildRemoteReposMsg("phone").entries).toContainEqual(
        expect.objectContaining({ cwd: app, archived: false, archivedAt: expect.any(Number) }),
      ));
      expect(sidebar.authorizedSessionCwds()).toEqual(trusted);
      expect(sidebar.host.appendLine.mock.calls.flat().join("\n")).not.toMatch(/dropped|failed/);
    },
  );

  it.each([false, true])("shared worktree access is independent of either owner's archive choice (desktop=%s)", async (desktop) => {
    const { sidebar, repo, app, worktree } = setup(desktop);
    const overrides = sidebar.state.get("grok.sessionMeta", {});
    expect(sidebar.sessionCwdsForRepo(repo, overrides)).toContain(worktree);
    expect(sidebar.sessionCwdsForRepo(app, overrides)).toContain(worktree);
    for (const cwd of [repo, app]) await sidebar.setRepoArchived(cwd, true);
    expect(sidebar.authorizedSessionCwds().filter((cwd: string) => cwd === worktree)).toEqual([worktree]);
    expect(sidebar.buildRemoteReposMsg("phone").entries).toHaveLength(2);
    expect(sidebar.remoteTargetableCwd(worktree)).toBe(true);
  });

  it("advertises archive choices on desktop fallback rows without session catalogs", async () => {
    const { sidebar, app } = setup();
    sidebar.repoCatalog = () => [];
    expect(sidebar.localRepoCatalogEntries()).toContainEqual(expect.objectContaining({ cwd: app, archived: false, archivedAt: 0 }));
    await sidebar.setRepoArchived(app, true);
    expect(sidebar.localRepoCatalogEntries()).toContainEqual(expect.objectContaining({ cwd: app, archived: true }));
  });

  it("keeps archived routines and retained runs while omitting absent projects", async () => {
    const { sidebar, repo, app } = setup();
    await sidebar.setRepoArchived(app, true);
    const message = {
      type: "routines", models: [],
      projects: [{ cwd: app, label: "app", archived: true }, { cwd: "/absent", label: "absent" }],
      entries: [{ cwd: repo, runs: [{ cwd: app, sessionId: "conversation", detail: "kept" }] }],
    } as unknown as Extract<HostMsg, { type: "routines" }>;
    expect(routinesMessageForRemote(message, sidebar.authorizedSessionCwds(), (a, b) => a === b)).toMatchObject({
      projects: [{ cwd: app, archived: true }],
      entries: [{ runs: [{ cwd: app, sessionId: "conversation", detail: "kept" }] }],
    });
  });

  it("offers Hide only on a local desktop, independently of archive support", () => {
    const { sidebar } = setup();
    expect(sidebar.buildInitialStateMsg().capabilities.removeProjectFolder).toBe(true);
    vi.stubEnv("GROK_CLOUD_ENVIRONMENT", "1");
    expect(sidebar.buildInitialStateMsg().capabilities.removeProjectFolder).toBe(false);
    expect(sidebar.localRepoCatalogEntries().every((r: { archived?: boolean }) => typeof r.archived === "boolean")).toBe(true);
  });
});
