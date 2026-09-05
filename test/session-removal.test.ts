import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient } from "../src/acp";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { defaultFs, sessionsDirFor } from "../src/sessions";
import { mayDeliverRemoteHostMsg, OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH } from "../src/remote-policy";

vi.mock("../src/acp", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/acp")>(),
  AcpClient: vi.fn(function () { throw new Error("unexpected temporary ACP client"); }),
}));

const cwd = path.resolve("test-project");
const id = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(origin: "local" | "remote", provider: "grok" | "codex" | "claude" = "grok") {
  vi.mocked(AcpClient).mockClear();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-removal-"));
  roots.push(root);
  vi.stubEnv("GROK_HOME", root);
  const dir = path.join(sessionsDirFor(root, cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ num_messages: 0 }));
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.cwd = cwd;
  session.provider = provider;
  session.activeSessionId = id;
  sidebar.focused = origin === "local" ? session : new Session();
  sidebar.pool = new Set([session]);
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  for (const client of ["phone", "other-tab"]) {
    sidebar.remoteClients.ready(client);
    sidebar.remoteClients.select(client, cwd);
  }
  if (origin === "remote") sidebar.remoteClients.setActive("phone", session);
  sidebar.view = { webview: { postMessage: vi.fn() } };
  sidebar.projectsRail = { webview: { postMessage: vi.fn() } };
  sidebar.uplink = { broadcastTo: vi.fn() };
  sidebar.authorizedSessionCwds = () => [cwd];
  sidebar.state = { get: (_key: string, fallback: unknown) => fallback };
  sidebar.sessionCache = new Map();
  sidebar.host = { appendLine: vi.fn() };
  sidebar.sessionCwd = (s: Session) => s.cwd;
  sidebar.disposeSession = vi.fn((s: Session) => { s.activeSessionId = undefined; });
  sidebar.postSessionsList = vi.fn();
  sidebar.buildSessionsList = vi.fn();
  const park = () => origin === "local" ? sidebar.parkFocused() : sidebar.parkRemoteSession("phone");
  const delivered = () => sidebar.view.webview.postMessage.mock.calls.map(([m]: any[]) => m);
  return { sidebar, session, dir, park, delivered };
}

describe.each(["local", "remote"] as const)("abandoning an empty %s session", (origin) => {
  it("deletes the known directory and delivers removal to both local views and all tabs without rebuilding", () => {
    const { sidebar, session, dir, park, delivered } = setup(origin);
    park();
    const frame = { type: "sessionRemoved", id, cwd };
    expect(fs.existsSync(dir)).toBe(false);
    expect(sidebar.disposeSession).toHaveBeenCalledWith(session);
    expect(delivered()).toEqual([frame]);
    expect(sidebar.projectsRail.webview.postMessage).toHaveBeenCalledWith(frame);
    expect(sidebar.uplink.broadcastTo).toHaveBeenCalledWith(["phone", "other-tab"], frame, cwd);
    expect(sidebar.postSessionsList).not.toHaveBeenCalled();
    expect(sidebar.buildSessionsList).not.toHaveBeenCalled();
  });

  it("does not announce a failed disk deletion", () => {
    const { sidebar, dir, park, delivered } = setup(origin);
    vi.spyOn(defaultFs, "rmSync").mockImplementation(() => { throw new Error("locked"); });
    park();
    expect(fs.existsSync(dir)).toBe(true);
    expect(delivered()).toEqual([]);
    expect(sidebar.postSessionsList).not.toHaveBeenCalled();
  });

  it.each(["hasHistory", "priming"] as const)("keeps a session with %s", (flag) => {
    const { sidebar, session, dir, park, delivered } = setup(origin);
    session[flag] = true;
    park();
    expect(fs.existsSync(dir)).toBe(true);
    expect(sidebar.disposeSession).not.toHaveBeenCalled();
    expect(delivered()).toEqual([]);
    expect(sidebar.postSessionsList).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"] as const)("waits for %s deletion before announcing removal", async (provider) => {
    const { sidebar, park, delivered } = setup(origin, provider);
    let complete!: (removed: boolean) => void;
    sidebar.discardAdapterEmptySession = vi.fn(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    park();
    expect(delivered()).toEqual([]);
    expect(sidebar.discardAdapterEmptySession).toHaveBeenCalledWith(provider, id, cwd, undefined);
    complete(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered()).toEqual([{ type: "sessionRemoved", id, cwd }]);
    expect(sidebar.postSessionsList).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"] as const)("does not announce a failed %s deletion", async (provider) => {
    const { sidebar, park, delivered } = setup(origin, provider);
    sidebar.discardAdapterEmptySession = vi.fn(async () => false);
    park();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered()).toEqual([]);
    expect(sidebar.postSessionsList).not.toHaveBeenCalled();
  });

  describe.each(["codex", "claude"] as const)("reusing the live %s client", (provider) => {
    function liveSetup() {
      const h = setup(origin, provider);
      const { sidebar, session } = h;
      let resolveDelete!: () => void;
      let rejectDelete!: (error: Error) => void;
      let resolveExit!: () => void;
      const deleted = new Promise<void>((resolve, reject) => { resolveDelete = resolve; rejectDelete = reject; });
      const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
      const client = {
        deleteSession: vi.fn(() => deleted),
        dispose: vi.fn(() => exited),
      };
      session.client = client as unknown as AcpClient;
      session.turnToken = {};
      // Exercise the real detach/dispose bookkeeping as well as the real discard.
      sidebar.disposeSession = GrokSidebar.prototype["disposeSession"];
      sidebar.terminalManager = { releaseOwnedBy: vi.fn(() => 0) };
      sidebar.post = vi.fn();
      sidebar.dotForId = vi.fn(() => "cold");
      sidebar.refreshKeepAwake = vi.fn();
      sidebar.adapterHistory = vi.fn();
      sidebar.locateProvider = vi.fn(() => "fake-adapter");
      sidebar.createProviderBackend = vi.fn(() => ({ provider }));
      return { ...h, client, resolveDelete, rejectDelete, resolveExit };
    }

    it.each(["success", "failure"])("returns before deletion and disposes the same client on %s, without constructing another", async (outcome) => {
      const { sidebar, session, client, park, delivered, resolveDelete, rejectDelete, resolveExit } = liveSetup();
      const generation = session.gen;
      expect(park()).toBeUndefined();
      expect(session.client).toBeUndefined();
      expect(session.turnToken).toBeUndefined();
      expect(session.gen).toBeGreaterThan(generation);
      expect(sidebar.pool.has(session)).toBe(false);
      expect(sidebar.remoteClients.clientsForActiveValue(session)).toEqual([]);
      expect(sidebar.terminalManager.releaseOwnedBy).toHaveBeenCalledOnce();
      expect(sidebar.terminalManager.releaseOwnedBy).toHaveBeenCalledWith(client);
      expect(sidebar.post).toHaveBeenCalledWith({ type: "sessionDot", id, dot: "cold" });
      expect(sidebar.refreshKeepAwake).toHaveBeenCalledOnce();
      expect(client.deleteSession).toHaveBeenCalledOnce();
      expect(client.deleteSession).toHaveBeenCalledWith(id);
      expect(client.dispose).not.toHaveBeenCalled();
      expect(delivered()).toEqual([]);
      expect(AcpClient).not.toHaveBeenCalled();
      expect(sidebar.locateProvider).not.toHaveBeenCalled();
      expect(sidebar.createProviderBackend).not.toHaveBeenCalled();

      if (outcome === "success") resolveDelete();
      else rejectDelete(new Error("session/delete refused"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(client.dispose).toHaveBeenCalledOnce();
      // Discard completion includes the process exit, even on a successful RPC.
      expect(delivered()).toEqual([]);
      resolveExit();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(delivered()).toEqual(outcome === "success" ? [{ type: "sessionRemoved", id, cwd }] : []);
      expect(AcpClient).not.toHaveBeenCalled();
      expect(sidebar.postSessionsList).not.toHaveBeenCalled();
    });

    it("still disposes an unregistered client when there is no session id to delete", async () => {
      const { session, client, park, delivered, resolveExit } = liveSetup();
      session.activeSessionId = undefined;
      park();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(client.deleteSession).not.toHaveBeenCalled();
      expect(client.dispose).toHaveBeenCalledOnce();
      resolveExit();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(delivered()).toEqual([]);
      expect(AcpClient).not.toHaveBeenCalled();
    });
  });
});

it("keeps removal local after its project loses remote authorization", () => {
  const { sidebar, park, delivered } = setup("local");
  sidebar.authorizedSessionCwds = () => [];
  park();
  expect(delivered()).toEqual([{ type: "sessionRemoved", id, cwd }]);
  expect(sidebar.uplink.broadcastTo).not.toHaveBeenCalled();
});

it("authorizes removal using the frame's cwd, independently of the sender's session scope", () => {
  const closed = path.resolve("closed-project");
  const sameCwd = (a: string, b: string) => a === b;
  expect(OUTBOUND_DISPOSITION.sessionRemoved).toBe("mirror");
  expect(OUTBOUND_PROJECT_AUTH.sessionRemoved).toBe("message-cwd");
  expect(mayDeliverRemoteHostMsg({ type: "sessionRemoved", id, cwd: closed }, [cwd], cwd, sameCwd)).toBe(false);
  expect(mayDeliverRemoteHostMsg({ type: "sessionRemoved", id, cwd }, [cwd], closed, sameCwd)).toBe(true);
  expect(mayDeliverRemoteHostMsg({ type: "sessionRemoved", id, cwd }, [cwd], undefined, sameCwd)).toBe(true);
});
