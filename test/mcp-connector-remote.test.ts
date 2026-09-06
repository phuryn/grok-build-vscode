import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { GrokSidebar } from "../src/sidebar";
import { authorizeMcpRemote } from "../src/mcp-connector-auth";
import { MCP_CONNECTORS_KEY, mcpConnectorSecretKey } from "../src/mcp-connectors";

vi.mock("../src/mcp-connector-auth", async (original) => ({
  ...await original<typeof import("../src/mcp-connector-auth")>(),
  authorizeMcpRemote: vi.fn(),
  npxSpawnPlan: () => ({ command: "npx", env: {}, shell: false }),
}));

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

function host() {
  const h = Object.create(GrokSidebar.prototype);
  let store = {};
  const secrets = new Map<string, string>();
  h.state = { get: () => store, update: vi.fn(async (_key, value) => { store = value; }) };
  h.context = { secrets: {
    get: vi.fn(async (key) => secrets.get(key)),
    store: vi.fn(async (key, value) => { secrets.set(key, value); }),
    delete: vi.fn(async (key) => { secrets.delete(key); }),
  } };
  h.mcpConnectorKeys = new Map();
  h.lapsedOAuthConnectors = () => new Set();
  h.postWelcomeTips = vi.fn();
  h.deliverRemote = vi.fn();
  h.post = vi.fn();
  h.host = { appendLine: vi.fn() };
  h.remoteClients = { active: () => undefined, cwd: () => "" };
  h.captureRemoteRequester = () => ({});
  h.workspaceRoot = () => "";
  return { h, secrets };
}

beforeEach(() => {
  vi.mocked(authorizeMcpRemote).mockReset();
  vi.mocked(spawn).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

function begin(h: any, clientId = "phone-a") {
  const url = "https://vendor.example/authorize?state=private-attempt";
  const complete = vi.fn().mockResolvedValue(undefined);
  let finish!: (result: Awaited<ReturnType<typeof authorizeMcpRemote>>) => void;
  let fail!: (error: Error) => void;
  vi.mocked(authorizeMcpRemote).mockImplementationOnce(async (opts) => {
    opts.onAuthorization!(url, complete);
    return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const connecting = h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", clientId);
  return { url, complete, finish: (result: Parameters<typeof finish>[0]) => finish(result),
    fail: (error: Error) => fail(error), connecting };
}

describe("remote connector host routing", () => {
  it("broadcasts consent and accepts completion from a different client after reload", async () => {
    const { h } = host();
    const attempt = begin(h);
    const [frame] = h.post.mock.lastCall;
    expect(frame).toMatchObject({ type: "mcpConnectorAuthorization", id: "notion", status: "waiting", url: attempt.url });
    expect(h.mcpRemoteAuthorization).not.toHaveProperty("clientId");
    expect(h.deliverRemote).not.toHaveBeenCalled();
    const message = { type: "completeMcpConnectorOAuth", id: "notion", attemptId: frame.attemptId, redirectUrl: "pasted" };
    await h.onMessage(message, "remote", "phone-b");
    expect(attempt.complete).toHaveBeenCalledOnce();
    expect(attempt.complete).toHaveBeenCalledWith("pasted");
    expect(h.post).toHaveBeenLastCalledWith(expect.objectContaining({ status: "submitted", attemptId: frame.attemptId }));
    h.postMcpConnectors();
    expect(h.post).toHaveBeenLastCalledWith(expect.objectContaining({ status: "submitted", attemptId: frame.attemptId }));
    attempt.finish({ ok: true });
    await attempt.connecting;
    expect(h.mcpRemoteAuthorization).toBeUndefined();
    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ status: "finished", attemptId: frame.attemptId }));
    expect(h.connectedConnectorStore()).toHaveProperty("notion");
  });

  it("refuses an unknown, wrong-connector, or ended attempt and permits correcting a callback", async () => {
    const { h } = host();
    const attempt = begin(h);
    const message = { type: "completeMcpConnectorOAuth", id: "notion", attemptId: h.mcpRemoteAuthorization.attemptId, redirectUrl: "pasted" };
    for (const mismatch of [{ attemptId: "stale" }, { id: "airtable" }]) {
      await h.onMessage({ ...message, ...mismatch }, "remote", "phone-b");
      expect(attempt.complete).not.toHaveBeenCalled();
      expect(h.deliverRemote).toHaveBeenLastCalledWith(["phone-b"], expect.objectContaining({
        status: "finished", error: "This sign-in expired or was replaced. Connect again to get a new link.",
      }));
      expect(JSON.stringify(h.deliverRemote.mock.lastCall)).not.toContain(attempt.url);
    }
    attempt.complete.mockRejectedValueOnce(new Error("state does not match"));
    await h.onMessage(message, "remote", "phone-b");
    expect(h.deliverRemote).toHaveBeenLastCalledWith(["phone-b"], expect.objectContaining({
      status: "waiting", error: "state does not match", url: attempt.url,
    }));
    await h.onMessage(message, "remote", "phone-b");
    expect(attempt.complete).toHaveBeenCalledTimes(2);
    attempt.finish({ ok: true });
    await attempt.connecting;
    await h.onMessage(message, "remote", "phone-a");
    expect(attempt.complete).toHaveBeenCalledTimes(2);
    expect(h.deliverRemote).toHaveBeenLastCalledWith(["phone-a"], expect.objectContaining({ status: "finished", error: expect.stringContaining("expired or was replaced") }));
  });

  it("replays the current authorization with connector initial state", async () => {
    const { h } = host();
    const attempt = begin(h);
    const [frame] = h.post.mock.lastCall;
    h.post.mockClear();
    h.postMcpConnectors();
    expect(h.post.mock.calls).toEqual([
      [expect.objectContaining({ type: "mcpConnectors", remoteConnect: true,
        connectors: expect.arrayContaining([expect.objectContaining({ id: "notion", status: "connecting" })]) })],
      [frame],
    ]);
    attempt.finish({ ok: true });
    await attempt.connecting;
    h.post.mockClear();
    h.postMcpConnectors();
    expect(h.post).toHaveBeenCalledOnce();
  });

  it("broadcasts consent independently of the focused conversation", async () => {
    const { h } = host();
    const attempt = begin(h);
    const [frame] = h.post.mock.lastCall;
    delete h.post;
    h.focused = {};
    h.mirrorToProjectsRail = vi.fn();
    h.broadcastRemoteDevice = vi.fn();
    h.sendRemoteSession = vi.fn();
    h.postMcpConnectors();
    expect(h.broadcastRemoteDevice).toHaveBeenCalledWith(frame);
    expect(h.sendRemoteSession).not.toHaveBeenCalled();
    attempt.finish({ ok: true });
    await attempt.connecting;
  });

  it("includes live consent in a new relay client's snapshot", async () => {
    const { h } = host();
    const attempt = begin(h);
    const [frame] = h.post.mock.lastCall;
    h.remoteClients.cwdIfPresent = () => "";
    h.remoteClients.requiresExplicitSession = () => false;
    h.authorizedSessionCwds = () => [];
    h.localRepoCatalogEntries = () => [];
    h.messageForRemote = (msg: unknown) => msg;
    h.buildInitialStateMsg = () => ({ type: "init" });
    h.mcpServersView = [];
    h.providerStateMessage = () => ({ type: "providerState" });
    h.githubStateMessage = () => ({ type: "githubState" });
    h.welcomeTipsMessage = () => ({ type: "welcomeTips" });
    h.projectSetupMessage = () => ({ type: "projectSetup" });
    h.githubProjectSetupExtra = () => ({});
    h.resolveVoiceApiKey = () => undefined;
    h.rememberVoiceConfigured = vi.fn();
    h.voiceConfiguredMsg = () => ({ type: "voiceConfigured", configured: false });
    h.seedPostedVoiceConfigured = vi.fn();
    h.remoteVoice = new Map();
    h.buildRemoteReposMsg = () => ({ type: "repos", entries: [] });
    h.buildSessionsList = () => ({ type: "sessionsList", sessions: [] });
    h.buildPinnedSessions = () => ({ pins: [] });
    expect(h.buildRemoteSnapshot("phone-b")).toContainEqual(frame);
    attempt.finish({ ok: true });
    await attempt.connecting;
    expect(h.buildRemoteSnapshot("phone-c").some((msg: { type: string }) => msg.type === "mcpConnectorAuthorization")).toBe(false);
  });

  it("still refuses a different connector while sign-in is pending", async () => {
    const { h } = host();
    const attempt = begin(h);
    const pending = h.mcpRemoteAuthorization;
    await h.onMessage({ type: "connectMcpConnector", id: "airtable" }, "remote", "phone-b");
    expect(authorizeMcpRemote).toHaveBeenCalledOnce();
    expect(h.mcpRemoteAuthorization).toBe(pending);
    expect(h.mcpConnectError).toEqual({ id: "airtable", message: "Already connecting notion. Wait for that to finish." });
    attempt.finish({ ok: true });
    await attempt.connecting;
  });

  it("refuses a second Connect on the same connector and points at the live link", async () => {
    const { h } = host();
    const attempt = begin(h);
    const pending = h.mcpRemoteAuthorization;
    await h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", "phone-b");
    // No replacement, no second listener, no process to stop: the sign-in the
    // second tab wants is the one already running, and it was just re-sent it.
    expect(authorizeMcpRemote).toHaveBeenCalledOnce();
    expect(h.mcpRemoteAuthorization).toBe(pending);
    expect(h.mcpConnectError.message).toContain("Finish it with the link above");
    expect(h.mcpConnectorAuthorizationMessage()).toMatchObject({ attemptId: pending.attemptId, status: "waiting" });
    attempt.finish({ ok: true });
    await attempt.connecting;
  });

  it("keeps desk OAuth automatic and advertises the additive capability", async () => {
    const { h } = host();
    vi.mocked(authorizeMcpRemote).mockResolvedValue({ ok: true });
    await h.onMessage({ type: "connectMcpConnector", id: "notion" }, "local");
    expect(vi.mocked(authorizeMcpRemote).mock.calls[0][0].onAuthorization).toBeUndefined();
    expect(h.deliverRemote).not.toHaveBeenCalled();
    expect(h.mcpConnectorsMessage().remoteConnect).toBe(true);
  });

  it("remote key writes/replacement/disconnect never return a secret or revoke running tools", async () => {
    const { h, secrets } = host();
    vi.mocked(authorizeMcpRemote).mockResolvedValue({ ok: true });
    for (const key of ["ghp_remote_first", "ghp_remote_replaced"]) {
      await h.onMessage({ type: "connectMcpConnector", id: "github", key }, "remote", "phone");
      expect(secrets.get(mcpConnectorSecretKey("github"))).toBe(key);
      const view = h.mcpConnectorsMessage();
      expect(view.connectors.find((c) => c.id === "github").keySet).toBe(true);
      expect(JSON.stringify(view)).not.toContain(key);
      expect(JSON.stringify(h.state.update.mock.calls)).not.toContain(key);
      const args = vi.mocked(authorizeMcpRemote).mock.lastCall![0];
      expect(args.onAuthorization).toBeUndefined();
      expect(args.env?.AUTH_HEADER).toBe(`Bearer ${key}`);
      expect(args.args.join(" ")).not.toContain(key);
    }
    expect(h.context.secrets.get).not.toHaveBeenCalled();
    await h.onMessage({ type: "disconnectMcpConnector", id: "github" }, "remote", "phone");
    expect(secrets.size).toBe(0);
    expect(h.state.update).toHaveBeenLastCalledWith(MCP_CONNECTORS_KEY, {});
    expect(h.deliverRemote).not.toHaveBeenCalled();
  });

  it("does not reflect a secret-storage exception back to a remote", async () => {
    const { h } = host();
    vi.mocked(authorizeMcpRemote).mockResolvedValue({ ok: true });
    h.context.secrets.store.mockRejectedValue(new Error("ghp_secret_do_not_echo"));
    await h.onMessage({ type: "connectMcpConnector", id: "github", key: "ghp_secret_do_not_echo" }, "remote", "phone");
    const frame = h.mcpConnectorsMessage();
    expect(JSON.stringify(frame)).not.toContain("ghp_secret_do_not_echo");
    expect(frame.connectors.find((c) => c.id === "github").error).toContain("Try connecting again");
  });
});
