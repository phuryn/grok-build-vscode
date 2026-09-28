import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";

const closed = "/old/fde-template";
const open = "/GitHub/grok-remote";

function harness() {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  let root = closed;
  let folders = [closed];
  sidebar.host = { workspaceRoot: () => root, canSwitchWorkspaceFolder: true, appendLine: vi.fn() };
  sidebar.openWorkspaceFolders = () => folders;
  sidebar.authorizedSessionCwds = () => folders;
  sidebar.remoteTargetableCwd = (cwd: string) => folders.includes(cwd);
  sidebar.repoCatalog = () => folders.map((cwd) => ({ cwd, available: true }));
  sidebar.sessionCwdsForRepo = (cwd: string) => folders.includes(cwd) ? [cwd] : [];
  sidebar.remoteClients = new RemoteClientState<Session>(() => sidebar.defaultRemoteCwd());
  sidebar.focused = new Session();
  sidebar.focused.cwd = open;
  sidebar.focused.activeSessionId = "desktop-session";
  sidebar.focused.client = {};
  sidebar.pool = new Set([sidebar.focused]);
  sidebar.state = { get: (_: string, fallback: unknown) => fallback };
  sidebar.remoteVoice = new Map();
  sidebar.sessionLoadReservations = new Map();
  sidebar.sessionCache = new Map();
  sidebar.startingForRemote = new Set();
  sidebar.firstBootScanCompleted = true;
  sidebar.defaultProviderForProject = () => "codex";
  sidebar.findUnusedEmptySession = () => undefined;
  sidebar.clearSettledCliUpdates = vi.fn();
  sidebar.dropRemoteVoice = vi.fn();
  sidebar.restorePersistedDraft = vi.fn();
  sidebar.restoreStrandedDraft = vi.fn();
  sidebar.sendRemoteClient = vi.fn();
  sidebar.sendRemoteRequester = vi.fn();
  sidebar.sendRemoteRepoCatalog = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.sendRemoteSessionList = vi.fn();
  sidebar.emit = vi.fn();
  sidebar.onMessage = vi.fn(async () => {});
  sidebar.sweepEmptySessions = vi.fn();
  sidebar.persistWorktreeBinding = vi.fn(async () => {});
  sidebar.setSessionCwd = (session: Session, cwd: string) => { session.cwd = cwd; };
  sidebar.parkRemoteSession = (id: string) => sidebar.remoteClients.deleteActive(id);
  sidebar.focusRemoteSession = (id: string, session: Session) => sidebar.remoteClients.setActive(id, session);
  sidebar.startSession = vi.fn(async (_: string, session: Session) => {
    session.client = {} as any;
    return session.client;
  });
  sidebar.buildSessionsList = () => ({ type: "sessions", entries: [] });
  return {
    sidebar,
    changeProjects(nextRoot = open, nextFolders = [open]) { root = nextRoot; folders = nextFolders; },
    async dispatch(message: unknown, id = "phone") {
      sidebar.handleRemoteMessage(id, message);
      await sidebar.remoteClients.runAfterSessionTransition(id, async () => {});
    },
  };
}

describe("remote binding after the startup project closes", () => {
  it("a fresh phone follows the current project and can create a new session", async () => {
    const { sidebar, changeProjects, dispatch } = harness();
    changeProjects();
    sidebar.handleRemoteClientReady("phone");
    expect(sidebar.remoteClients.cwd("phone")).toBe(open);
    expect(sidebar.remoteClients.active("phone")).toBe(sidebar.focused);
    await dispatch({ type: "newSession" });
    expect(sidebar.startSession).toHaveBeenCalledOnce();
    expect(sidebar.remoteClients.active("phone").cwd).toBe(open);
    expect(sidebar.remoteClients.active("phone")).not.toBe(sidebar.focused);
    expect(sidebar.sendRemoteClient).not.toHaveBeenCalledWith("phone", expect.objectContaining({ type: "error" }));
  });

  it("names a phone New's composer draft back to that phone", async () => {
    const { sidebar, changeProjects, dispatch } = harness();
    changeProjects();
    sidebar.handleRemoteClientReady("phone");
    sidebar.startSession = vi.fn(async (_: string, session: Session) => {
      session.client = {} as any;
      session.activeSessionId = "phone-new";
      return session.client;
    });
    await dispatch({ type: "newSession", draftId: "draft-1" });
    expect(sidebar.sendRemoteRequester).toHaveBeenCalledWith(
      expect.anything(),
      { type: "composerDraftSession", draftId: "draft-1", sessionId: "phone-new" },
    );
  });

  it.each([false, true])("revalidates a restored tab (detached=%s) before starting its old session", (detached) => {
    const { sidebar, changeProjects } = harness();
    sidebar.remoteClients.ready("old-socket");
    sidebar.remoteClients.identify("old-socket", "stable-tab");
    const stale = new Session();
    stale.cwd = closed;
    sidebar.remoteClients.setActive("old-socket", stale);
    if (detached) sidebar.remoteClients.detachClient("old-socket");
    changeProjects();
    sidebar.handleRemoteClientReady("phone", "stable-tab");
    expect(sidebar.remoteClients.cwd("phone")).toBe(open);
    expect(sidebar.remoteClients.active("phone")).toBe(sidebar.focused);
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });

  it("preserves another still-open project and its conversation on reconnect", () => {
    const { sidebar, changeProjects } = harness();
    sidebar.remoteClients.ready("old-socket");
    sidebar.remoteClients.identify("old-socket", "stable-tab");
    const own = new Session();
    own.cwd = closed;
    own.client = {} as any;
    sidebar.remoteClients.setActive("old-socket", own);
    sidebar.remoteClients.detachClient("old-socket");
    changeProjects(open, [closed, open]);
    sidebar.handleRemoteClientReady("phone", "stable-tab");
    expect(sidebar.remoteClients.cwd("phone")).toBe(closed);
    expect(sidebar.remoteClients.active("phone")).toBe(own);
  });

  it("leaves a reconnect unbound when every project closed", () => {
    const { sidebar, changeProjects } = harness();
    sidebar.remoteClients.ready("phone");
    changeProjects("", []);
    sidebar.handleRemoteClientReady("phone");
    expect(sidebar.remoteClients.cwdIfPresent("phone")).toBe("");
    expect(sidebar.remoteClients.active("phone")).toBeUndefined();
    expect(sidebar.startSession).not.toHaveBeenCalled();
  });

  it("uses an open fallback if the host root still names the closed folder", () => {
    const { sidebar, changeProjects } = harness();
    changeProjects(closed, [open]);
    sidebar.handleRemoteClientReady("phone");
    expect(sidebar.remoteClients.cwd("phone")).toBe(open);
  });

  it("does not reclaim a conversation another tab took when repairing the folder", () => {
    const { sidebar, changeProjects } = harness();
    sidebar.remoteClients.ready("old-socket");
    sidebar.remoteClients.identify("old-socket", "stable-tab");
    sidebar.remoteClients.markRequiresExplicitSession("old-socket", "taken-session");
    sidebar.remoteClients.detachClient("old-socket");
    changeProjects();
    sidebar.handleRemoteClientReady("phone", "stable-tab");
    expect(sidebar.remoteClients.cwd("phone")).toBe(open);
    expect(sidebar.remoteClients.active("phone")).toBeUndefined();
    expect(sidebar.remoteClients.requiresExplicitSession("phone")).toBe(true);
  });

  it.each([closed, ""])("an explicit session click can leave an invalid selection %j", async (prior) => {
    const { sidebar, changeProjects, dispatch } = harness();
    changeProjects(prior, prior ? [prior] : []);
    sidebar.remoteClients.ready("phone");
    changeProjects();
    await dispatch({ type: "resumeSession", id: "desktop-session", cwd: open, claim: true });
    expect(sidebar.remoteClients.cwd("phone")).toBe(open);
    expect(sidebar.remoteClients.active("phone")).toBe(sidebar.focused);
    expect(sidebar.sendRemoteClient).not.toHaveBeenCalledWith("phone", expect.objectContaining({ type: "error" }));
  });

  it("refuses a closed destination with a resume failure, ending the loading transition", async () => {
    const { sidebar, changeProjects, dispatch } = harness();
    changeProjects();
    sidebar.handleRemoteClientReady("phone");
    await dispatch({ type: "resumeSession", id: "old-session", cwd: closed });
    expect(sidebar.sendRemoteClient).toHaveBeenCalledWith("phone", expect.objectContaining({
      type: "error", resumeFailed: { id: "old-session" },
    }));
    expect(sidebar.remoteClients.active("phone")).toBe(sidebar.focused);
  });

  it.each(["send", "cancel", "newSession"])("still refuses %s against an existing revoked binding", async (type) => {
    const { sidebar, changeProjects, dispatch } = harness();
    sidebar.remoteClients.ready("phone");
    const stale = new Session();
    stale.cwd = closed;
    sidebar.remoteClients.setActive("phone", stale);
    changeProjects();
    await dispatch({ type, text: "must not reach a provider" });
    expect(sidebar.sendRemoteClient).toHaveBeenCalledWith("phone", expect.objectContaining({ type: "error" }));
    expect(sidebar.startSession).not.toHaveBeenCalled();
    expect(sidebar.onMessage).not.toHaveBeenCalled();
  });
});
