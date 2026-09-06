import { readFileSync } from "node:fs";
/**
 * Deleting the conversation you are looking at must not mint a replacement
 * while siblings remain, and minting a blank session must not add a second
 * unused empty row in the same project.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import type { SessionListEntry } from "../src/sessions";

const cwd = "/work/accredia";

function listEntry(id: string, extra: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    id,
    cwd,
    displayName: extra.displayName ?? id,
    rawSummary: extra.rawSummary ?? id,
    updatedAt: extra.updatedAt ?? 1,
    createdAt: extra.createdAt ?? 1,
    numMessages: extra.numMessages ?? 1,
    ...extra,
  };
}

function sessionsMessage(entries: SessionListEntry[], activeId: string | null = null): HostMsg {
  return {
    type: "sessions",
    entries,
    activeId,
    dots: {},
    offset: 0,
    total: entries.length,
    hasMore: false,
    nextOffset: entries.length,
    query: "",
  };
}

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.cwd = cwd;
  sidebar.sessionLoadReservations = new Map();
  sidebar.sessionCache = new Map();
  sidebar.codexSessionCache = new Map();
  sidebar.claudeSessionCache = new Map();
  sidebar.geminiSessionCache = new Map();
  sidebar.worktreeCache = [];
  sidebar.selectedRepoCwd = cwd;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.state = {
    get: vi.fn((_key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, _key) ? memento[_key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    canSwitchWorkspaceFolder: false,
    appendLine: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    fs: { delete: vi.fn(async () => {}) },
  };
  sidebar.workspaceRoot = vi.fn(() => cwd);
  sidebar.historyCwdFor = vi.fn(() => cwd);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.setSessionCwd = vi.fn((session: Session, next: string) => { session.cwd = next; });
  sidebar.defaultProviderForProject = vi.fn(() => "grok");
  sidebar.authorizedSessionCwds = vi.fn(() => [cwd]);
  sidebar.sessionCwdsForRepo = vi.fn(() => [cwd]);
  sidebar.resolveLocalRepoTarget = vi.fn(() => ({ cwd, available: true }));
  sidebar.remoteSessionTarget = vi.fn(() => ({ cwd }));
  sidebar.modelsForSession = vi.fn(() => []);
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.postSessionName = vi.fn();
  sidebar.postMode = vi.fn();
  sidebar.sendLocalRepoSessionsPreview = vi.fn();
  sidebar.refreshRemoteRepoPreview = vi.fn();
  sidebar.removePlanReviews = vi.fn();
  sidebar.removeUploadsForSessions = vi.fn(async () => {});
  sidebar.removeSessionFromDisk = vi.fn();
  sidebar.discardAdapterEmptySession = vi.fn(async () => {});
  sidebar.persistWorktreeBinding = vi.fn(async () => {});
  sidebar.sweepEmptySessions = vi.fn();
  sidebar.dropRemoteVoice = vi.fn();
  sidebar.emit = vi.fn();
  sidebar.post = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  const sent: Array<{ clientId: string; msg: HostMsg }> = [];
  sidebar.sent = sent;
  sidebar.sendRemoteClient = vi.fn((clientId: string, msg: HostMsg) => { sent.push({ clientId, msg }); });
  sidebar.sendRemoteSessionList = vi.fn();
  sidebar.listEntries = [] as SessionListEntry[];
  sidebar.buildSessionsList = vi.fn(() => sessionsMessage(sidebar.listEntries));
  sidebar.startSession = vi.fn(async (_id?: string, session?: Session) => {
    const target = session ?? sidebar.focused;
    if (!target.activeSessionId) target.activeSessionId = `minted-${++sidebar.mintCount}`;
    target.client = { dispose() {}, sessionId: target.activeSessionId };
    sidebar.pool.add(target);
    return target.client;
  });
  sidebar.mintCount = 0;
  sidebar.disposeSession = vi.fn((session: Session) => {
    sidebar.pool.delete(session);
    sidebar.remoteClients.deleteActiveValue(session);
    session.client = undefined;
    return Promise.resolve();
  });
  return sidebar;
}

function liveSession(id: string, opts: { hasHistory?: boolean; cwd?: string } = {}): Session {
  const session = new Session();
  session.cwd = opts.cwd ?? cwd;
  session.activeSessionId = id;
  session.hasHistory = opts.hasHistory ?? true;
  session.client = { dispose() {}, sessionId: id } as Session["client"];
  return session;
}

function seedRemote(sidebar: any, clientId: string, session: Session): void {
  sidebar.remoteClients.ready(clientId);
  sidebar.remoteClients.select(clientId, session.cwd || cwd);
  sidebar.remoteClients.setActive(clientId, session);
  sidebar.pool.add(session);
}

describe("deleting a conversation re-homes to a neighbour", () => {
  it("focuses a sibling and creates nothing when the focused conversation has neighbours", async () => {
    const sidebar = makeSidebar();
    const focused = liveSession("empty-a", { hasHistory: false });
    const sibling = liveSession("kept-b");
    sidebar.focused = focused;
    sidebar.pool.add(focused);
    sidebar.pool.add(sibling);
    sidebar.listEntries = [listEntry("empty-a", { displayName: "New session", numMessages: 0 }), listEntry("kept-b")];

    const created: Session[] = [];
    const origNew = sidebar.newLocalSession.bind(sidebar);
    sidebar.newLocalSession = () => {
      const session = origNew();
      created.push(session);
      return session;
    };

    await sidebar.deleteSession("empty-a", undefined, "local");

    expect(sidebar.focused).toBe(sibling);
    expect(created).toEqual([]);
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.pool.has(focused)).toBe(false);
    expect(sidebar.pool.has(sibling)).toBe(true);
  });

  it("creates exactly one replacement when the last conversation in a project is deleted", async () => {
    const sidebar = makeSidebar();
    const focused = liveSession("only", { hasHistory: false });
    sidebar.focused = focused;
    sidebar.pool.add(focused);
    sidebar.listEntries = [listEntry("only", { displayName: "New session", numMessages: 0 })];

    await sidebar.deleteSession("only", undefined, "local");

    expect(sidebar.focused).not.toBe(focused);
    expect(sidebar.focused.activeSessionId).toBe("minted-1");
    expect(sidebar.startSession).toHaveBeenCalledTimes(1);
    expect(sidebar.pool.has(focused)).toBe(false);
    expect(sidebar.pool.has(sidebar.focused)).toBe(true);
  });

  it("lands a watcher of the deleted conversation on the same neighbour and does not move anyone else", async () => {
    const sidebar = makeSidebar();
    const deleted = liveSession("empty-a", { hasHistory: false });
    const neighbour = liveSession("kept-b");
    const other = liveSession("other-c");
    sidebar.focused = deleted;
    sidebar.pool.add(deleted);
    sidebar.pool.add(neighbour);
    sidebar.pool.add(other);
    sidebar.listEntries = [
      listEntry("empty-a", { displayName: "New session", numMessages: 0 }),
      listEntry("kept-b"),
      listEntry("other-c"),
    ];
    seedRemote(sidebar, "watcher", deleted);
    seedRemote(sidebar, "bystander", other);

    await sidebar.deleteSession("empty-a", undefined, "local");

    expect(sidebar.focused).toBe(neighbour);
    expect(sidebar.remoteClients.active("watcher")).toBe(neighbour);
    expect(sidebar.remoteClients.active("bystander")).toBe(other);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });

  it("does not yank the desk when a remote tab deletes a conversation the desk is not reading", async () => {
    const sidebar = makeSidebar();
    const desk = liveSession("desk-keep");
    const deleted = liveSession("phone-gone");
    const neighbour = liveSession("kept-b");
    sidebar.focused = desk;
    sidebar.pool.add(desk);
    sidebar.pool.add(deleted);
    sidebar.pool.add(neighbour);
    sidebar.listEntries = [listEntry("phone-gone"), listEntry("kept-b"), listEntry("desk-keep")];
    seedRemote(sidebar, "phone", deleted);

    await sidebar.deleteSession("phone-gone", undefined, "remote", "phone");

    expect(sidebar.focused).toBe(desk);
    expect(sidebar.remoteClients.active("phone")).toBe(neighbour);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });

  it("gives a watcher of the last conversation its own blank, not the desk’s", async () => {
    const sidebar = makeSidebar();
    const deleted = liveSession("only", { hasHistory: false });
    sidebar.focused = deleted;
    sidebar.pool.add(deleted);
    sidebar.listEntries = [listEntry("only", { displayName: "New session", numMessages: 0 })];
    seedRemote(sidebar, "watcher", deleted);

    await sidebar.deleteSession("only", undefined, "local");

    // Sharing the desk’s replacement with ONE watcher would be fine — desk and
    // remote may share. With two watchers it is the remote-plus-remote
    // collision this loop now refuses, and making it safe for one but not two
    // is a special case nobody would remember. So everybody gets their own,
    // which is what v4.1.4 did. The cost is two EMPTY conversations instead of
    // one, which is a price worth paying for a rule that fits in a sentence.
    expect(sidebar.focused.activeSessionId).toBe("minted-1");
    const watcherSession = sidebar.remoteClients.active("watcher");
    expect(watcherSession).toBeTruthy();
    expect(watcherSession).not.toBe(sidebar.focused);
    expect(watcherSession.activeSessionId).not.toBe("only");
  });
});

describe("minting a blank session reuses an unused empty one", () => {
  it("adopts an existing unused empty conversation instead of adding a second", async () => {
    const sidebar = makeSidebar();
    const used = liveSession("used");
    const unused = liveSession("empty-wait", { hasHistory: false });
    sidebar.focused = used;
    sidebar.pool.add(used);
    sidebar.pool.add(unused);
    sidebar.listEntries = [
      listEntry("empty-wait", { displayName: "New session", numMessages: 0 }),
      listEntry("used"),
    ];

    const created: Session[] = [];
    const origNew = sidebar.newLocalSession.bind(sidebar);
    sidebar.newLocalSession = () => {
      const session = origNew();
      created.push(session);
      return session;
    };

    await sidebar.newFocusedSession("local");

    expect(sidebar.focused).toBe(unused);
    expect(created).toEqual([]);
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.pool.has(used)).toBe(true);
  });

  it("a remote new session adopts the same unused empty instead of minting another", async () => {
    const sidebar = makeSidebar();
    const used = liveSession("used");
    const unused = liveSession("empty-wait", { hasHistory: false });
    sidebar.focused = used;
    sidebar.pool.add(used);
    sidebar.pool.add(unused);
    sidebar.listEntries = [
      listEntry("empty-wait", { displayName: "New session", numMessages: 0 }),
      listEntry("used"),
    ];
    sidebar.remoteClients.ready("phone");
    sidebar.remoteClients.select("phone", cwd);
    const phoneSession = liveSession("phone-used");
    sidebar.remoteClients.setActive("phone", phoneSession);
    sidebar.pool.add(phoneSession);

    await sidebar.newRemoteSession("phone", false);

    expect(sidebar.remoteClients.active("phone")).toBe(unused);
    expect(sidebar.focused).toBe(used);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });
});

describe("the cold-neighbour cases the first tests missed", () => {
  const src = readFileSync("src/sidebar.ts", "utf8");

  it("does not park the conversation it just deleted", () => {
    // Re-homing opens the neighbour, and a COLD neighbour falls through to
    // parkFocused while `this.focused` is still the disposed object. A queued
    // follow-up (typed while the agent worked) made parkFocused put it BACK in
    // the pool, and the list synthesizes a row for any pool member with no
    // directory — so the deleted conversation reappeared. Every earlier test
    // here seeded a LIVE sibling, which returns before parkFocused, so none of
    // them could see it.
    const at = src.indexOf("private parkFocused()");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1600);
    const guard = body.indexOf("if (cur.deleted) return;");
    const park = body.indexOf("this.pool.add(cur);");
    expect(guard).toBeGreaterThan(-1);
    expect(park).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(park);
    // And the flag is set where the deletion happens, not inferred later.
    expect(src).toContain("if (live) live.deleted = true;");
  });

  it("never hands a watcher a conversation another remote holds", () => {
    // `focusRemoteSession` attaches without the exclusivity check that
    // `openRemoteSession` performs. Two browser tabs then shared one
    // conversation: the deleter’s next message went into the other tab’s
    // conversation, and refreshing hit the conflicting-owner refusal and left
    // them unbound. Desk-plus-remote sharing is fine; remote-plus-remote is not.
    const at = src.indexOf("Every watcher goes through");
    expect(at).toBeGreaterThan(-1);
    const loop = src.slice(at, at + 1400);
    expect(loop).toContain("await this.openRemoteSession(watcher");
    expect(loop).not.toContain("focusRemoteSession(watcher");
    // Refused or no neighbour: their own blank conversation, as v4.1.4 did.
    expect(loop).toContain("await this.newRemoteSession(watcher, false);");
  });
});

describe("what the reuse and neighbour rules refuse to assume", () => {
  const src = readFileSync("src/sidebar.ts", "utf8");

  it("never adopts a conversation it only saw in a list", () => {
    // `numMessages` is HARDCODED to 0 for every Codex and Claude row
    // (provider-ui.ts, adapterListEntry), so a list field cannot say whether
    // a conversation has been used. An earlier version read it as emptiness
    // and would have let New Session adopt a conversation holding real work,
    // sending the next message into it. Only live pool sessions qualify now,
    // where emptiness is the host’s own state rather than an inference.
    const at = src.indexOf("private findUnusedEmptySession");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("private newLocalSession", at));
    expect(body).not.toContain("buildSessionsList");
    // The CODE form, not the word: the comment above the helper explains the
    // premise it rejected, and a test that matched prose would fail on that.
    expect(body).not.toContain("entry.numMessages");
    expect(body).not.toContain("list.entries");
  });

  it("asks whether the view is on the deleted row AFTER the teardown", () => {
    // `wasFocused` is captured before the provider teardown. A delete that was
    // not focused when it started can finish after the view has navigated ONTO
    // the conversation being deleted — a different Session object carrying the
    // same id — and the stale snapshot then says "not mine" and leaves the view
    // attached to a disposed session, whose next send resumes a dead id.
    const at = src.indexOf("private viewIsOnDeleted");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("private newLocalSession", at));
    // BY ID ONLY. `disposeSession` leaves `activeSessionId` in place, so the
    // id covers both a view that never moved and one that moved onto the
    // conversation mid-delete.
    expect(body).toContain("this.focused.activeSessionId === id");
    // Object identity was tried and removed: a Session is RECYCLED, so after
    // disposal a reasoning-effort change can hand the same object a brand-new
    // conversation. Identity then reads "still on the deleted one" and moves
    // the person off something they just started writing in.
    expect(body).not.toContain("this.focused === live");
    // And the decision must consult it, not the snapshot alone.
    // And no snapshot may feed the decision: `wasFocused` was read before
    // the teardown, so a view that moved after it answered for a view that
    // no longer existed.
    expect(src).not.toContain("wasFocused");
  });

  it("mints only when the view is still on the deleted conversation", () => {
    // Three rounds hit this tail and the first two fixes were exact inverses.
    // Comparing `this.focused` to the neighbour minted a blank over a
    // conversation the person chose mid-load. Asking openSession whether it
    // succeeded minted a blank when the person had already opened that
    // neighbour themselves and their own reservation refused the call. Both
    // were proxies for the real question, and a proxy has a direction to be
    // wrong in.
    //
    // The guarded failure never changed: focus left on a deleted, disposed
    // session, so the view looks attached and the next send resumes a dead id.
    // Anywhere else the person lands is fine.
    const at = src.indexOf("THE ONLY QUESTION");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, at + 1800);
    expect(branch).toContain("const viewNeedsHome = this.viewIsOnDeleted(id);");
    expect(branch).toContain("await this.startSession();");
    // Neither discarded proxy may come back.
    expect(src).not.toContain("this.focused.activeSessionId !== neighbour.id");
    expect(src).not.toContain("if (!tookUs)");
  });
});
