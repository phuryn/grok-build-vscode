import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";

describe.each(["local", "remote"] as const)("New draft identity (%s)", source => {
  it("binds each request to its own session even if startup completes after another New", async () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.focused = new Session();
    sidebar.remoteClients = new RemoteClientState<Session>("/repo");
    sidebar.remoteClients.ready("phone");
    sidebar.remoteClients.setActive("phone", sidebar.focused);
    sidebar.pool = new Set();
    sidebar.workspaceRoot = () => "/repo";
    sidebar.historyCwdFor = () => "/repo";
    sidebar.defaultProviderForProject = () => "grok";
    sidebar.sessionCwd = () => "/repo";
    sidebar.setSessionCwd = vi.fn();
    sidebar.findUnusedEmptySession = () => undefined;
    for (const name of ["clearSettledCliUpdates", "parkFocused", "parkRemoteSession", "dropRemoteVoice", "emit",
      "persistWorktreeBinding", "sweepEmptySessions", "postRepoCatalog", "postSessionsList", "sendRemoteSessionList",
      "postLocal", "sendRemoteClient"]) sidebar[name] = vi.fn();
    const starts: { session: Session; finish: () => void }[] = [];
    sidebar.startSession = (_id: unknown, session: Session) => new Promise<void>(resolve => {
      const id = `new-${starts.length + 1}`;
      starts.push({ session, finish: () => { session.activeSessionId = id; resolve(); } });
    });
    const first = sidebar.onMessage({ type: "newSession", draftId: "draft-1" }, source, source === "remote" ? "phone" : undefined);
    const second = sidebar.onMessage({ type: "newSession", draftId: "draft-2" }, source, source === "remote" ? "phone" : undefined);
    expect(starts).toHaveLength(2);
    starts[1].finish();
    await second;
    starts[0].finish();
    await first;
    const replies = (source === "local" ? sidebar.postLocal.mock.calls.map(c => c[0]) :
      sidebar.sendRemoteClient.mock.calls.map(c => c[1])).filter(m => m.type === "composerDraftSession");
    expect(replies).toEqual([
      { type: "composerDraftSession", draftId: "draft-2", sessionId: "new-2" },
      { type: "composerDraftSession", draftId: "draft-1", sessionId: "new-1" },
    ]);
  });
});
