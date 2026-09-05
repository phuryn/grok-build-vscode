/**
 * Newest tab that explicitly claims a conversation wins. A non-claim resume
 * (reconnect restore) still refuses. The previous holder is told and a stale
 * Send from it is refused rather than adopted. The desk focused pointer is
 * left alone.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { SESSION_SUPERSEDED_CODE, type HostMsg } from "../src/protocol";

const cwd = "/repo";

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "grok";
  sidebar.focused.cwd = cwd;
  sidebar.sessionLoadReservations = new Map();
  sidebar.worktreeCache = [];
  sidebar.remoteVoice = new Map();
  sidebar.firstBootScanCompleted = true;
  sidebar.sessionCache = new Map();
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
  };
  sidebar.workspaceRoot = vi.fn(() => cwd);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.setSessionCwd = vi.fn((session: Session, next: string) => { session.cwd = next; });
  sidebar.sessionCwdsForRepo = vi.fn((repoCwd: string) => [repoCwd]);
  sidebar.remoteTargetableCwd = vi.fn(() => true);
  sidebar.authorizedSessionCwds = vi.fn(() => [cwd]);
  sidebar.isAuthorizedCwd = vi.fn(() => true);
  sidebar.dropRemoteVoice = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.postSessionName = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.sweepEmptySessions = vi.fn();
  sidebar.modelsForSession = vi.fn(() => []);
  sidebar.sessionDisplayName = vi.fn((session: Session) => session.activeSessionId || "Untitled");
  sidebar.setMetaUnread = vi.fn();
  sidebar.pushDot = vi.fn();
  const sent: Array<{ clientId: string; msg: HostMsg }> = [];
  sidebar.sent = sent;
  sidebar.sendRemoteClient = vi.fn((clientId: string, msg: HostMsg) => { sent.push({ clientId, msg }); });
  sidebar.buildSessionsList = vi.fn((_cwd: string, _opts: unknown, activeId: string | null | undefined) => ({
    type: "sessions",
    entries: [],
    activeId: activeId ?? null,
    dots: {},
    offset: 0,
    total: 0,
    hasMore: false,
    nextOffset: 0,
    query: "",
  }));
  return sidebar;
}

function seedTab(sidebar: any, clientId: string, id: string, buffer: HostMsg[] = []): Session {
  sidebar.remoteClients.ready(clientId);
  sidebar.remoteClients.select(clientId, cwd);
  const session = new Session();
  session.cwd = cwd;
  session.activeSessionId = id;
  session.client = { dispose() {}, sessionId: id } as any;
  session.hasHistory = true;
  session.buffer.push(...buffer);
  sidebar.pool.add(session);
  sidebar.remoteClients.setActive(clientId, session);
  return session;
}

describe("remote session claim", () => {
  it("transfers a live conversation on an explicit claim and refuses a non-claim", async () => {
    const sidebar = makeSidebar();
    const held = seedTab(sidebar, "tab-a", "session-a", [{ type: "userMessage", text: "keep me" }]);
    seedTab(sidebar, "tab-b", "session-b");
    const desk = sidebar.focused as Session;
    desk.activeSessionId = "desk-session";

    await sidebar.openRemoteSession("tab-b", "session-a", cwd, true, false);

    expect(sidebar.remoteClients.active("tab-a")).toBe(held);
    expect(sidebar.remoteClients.active("tab-b")?.activeSessionId).toBe("session-b");
    const refused = sidebar.sent.filter((s: { clientId: string; msg: HostMsg }) =>
      s.clientId === "tab-b" && s.msg.type === "error");
    expect(refused).toHaveLength(1);
    expect(refused[0].msg).toMatchObject({
      resumeFailed: { id: "session-a" },
      code: SESSION_SUPERSEDED_CODE,
    });
    expect(refused[0].msg.text).toMatch(/already open in another tab/);

    sidebar.sent.length = 0;
    await sidebar.openRemoteSession("tab-b", "session-a", cwd, true, true);

    expect(sidebar.remoteClients.active("tab-b")).toBe(held);
    expect(sidebar.remoteClients.active("tab-a")).toBeUndefined();
    expect(sidebar.remoteClients.requiresExplicitSession("tab-a")).toBe(true);
    expect(sidebar.focused).toBe(desk);
    expect(desk.activeSessionId).toBe("desk-session");
    expect(held.client).toBeDefined();

    const toLoser = sidebar.sent.filter((s: { clientId: string }) => s.clientId === "tab-a");
    expect(toLoser.some((s: { msg: HostMsg }) => s.msg.type === "clearMessages")).toBe(false);
    const takeover = toLoser.find((s: { msg: HostMsg }) => s.msg.type === "error");
    expect(takeover?.msg).toMatchObject({
      resumeFailed: { id: "session-a" },
      code: SESSION_SUPERSEDED_CODE,
    });
    const loserList = toLoser.filter((s: { msg: HostMsg }) => s.msg.type === "sessions").pop();
    expect(loserList?.msg).toMatchObject({ activeId: null });

    const toWinner = sidebar.sent.filter((s: { clientId: string }) => s.clientId === "tab-b");
    expect(toWinner.some((s: { msg: HostMsg }) => s.msg.type === "clearMessages")).toBe(true);
    expect(toWinner.some((s: { msg: HostMsg }) =>
      s.msg.type === "userMessage" && s.msg.text === "keep me"
      || (s.msg.type === "historyBatch" && (s.msg as any).messages?.some((m: HostMsg) =>
        m.type === "userMessage" && m.text === "keep me")))).toBe(true);
  });

  it("leaves the desk focused pointer alone when a tab claims the desk conversation", async () => {
    const sidebar = makeSidebar();
    const shared = seedTab(sidebar, "tab-a", "session-a", [{ type: "messageChunk", text: "live" }]);
    sidebar.focused = shared;
    sidebar.pool.add(shared);
    seedTab(sidebar, "tab-b", "session-b");

    await sidebar.openRemoteSession("tab-b", "session-a", cwd, true, true);

    expect(sidebar.focused).toBe(shared);
    expect(sidebar.remoteClients.active("tab-b")).toBe(shared);
    expect(sidebar.remoteClients.active("tab-a")).toBeUndefined();
    expect(shared.client).toBeDefined();
  });

  it("refuses a stale send from a demoted tab instead of adopting another session", () => {
    const sidebar = makeSidebar();
    const held = seedTab(sidebar, "tab-a", "session-a");
    seedTab(sidebar, "tab-b", "session-b");
    const desk = sidebar.focused as Session;

    sidebar.remoteClients.deleteActive("tab-a", held);
    sidebar.remoteClients.markRequiresExplicitSession("tab-a", "session-a");

    sidebar.handleRemoteMessage("tab-a", { type: "send", text: "stale" });

    expect(sidebar.remoteClients.active("tab-a")).toBeUndefined();
    expect(sidebar.focused).toBe(desk);
    const err = sidebar.sent.find((s: { clientId: string; msg: HostMsg }) =>
      s.clientId === "tab-a" && s.msg.type === "error");
    expect(err?.msg).toMatchObject({
      code: SESSION_SUPERSEDED_CODE,
      resumeFailed: { id: "session-a" },
    });
    expect(sidebar.pool.has(desk)).toBe(false);
  });

  /**
   * A demoted tab survives an ordinary reconnect with its repo and its latch.
   *
   * Found by review. `releaseRemoteClient` chose between keeping a logical tab
   * and deleting it purely on properties of its ACTIVE session — and a demoted
   * tab has none, which is the whole point of demotion. So `deleteClient` ran,
   * dropping both the latch and the tab's selected repo.
   *
   * The sequence is ordinary on a phone: tab A holds conversation S in repo A
   * with an unsent draft, tab B claims S, then tab A's network changes. On
   * reconnect it would bind to the host's default repo, get `clearMessages`,
   * have its composer re-enabled with the old draft still in it — and the next
   * Send would file text written for one conversation into another one, in
   * another repository.
   */
  it("keeps a demoted tab's repo and latch across a reconnect", () => {
    const sidebar = makeSidebar();
    const held = seedTab(sidebar, "tab-a", "session-a");
    sidebar.remoteClients.identify("tab-a", "token-a");

    sidebar.remoteClients.deleteActive("tab-a", held);
    sidebar.remoteClients.markRequiresExplicitSession("tab-a", "session-a");
    expect(sidebar.remoteClients.active("tab-a")).toBeUndefined();

    sidebar.releaseRemoteClient("tab-a");

    // Same tab token comes back on a new socket, as a mobile reconnect does.
    sidebar.remoteClients.identify("tab-new", "token-a");
    expect(sidebar.remoteClients.cwdIfPresent("tab-new")).toBe(cwd);
    expect(sidebar.remoteClients.requiresExplicitSession("tab-new")).toBe(true);
  });
});
