import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { authorizeMcpRemote, recordMcpRemoteOutcome } from "../src/mcp-connector-auth";
import { authorizeMcpConnectorOAuth, ownedMcpOAuthClient } from "../src/mcp-connector-oauth";
import { CONNECTOR_UNAVAILABLE_MESSAGE, MCP_CONNECTORS_KEY, MCP_REMOTE_STORE_VERSION, mcpConnectorSecretKey } from "../src/mcp-connectors";

vi.mock("../src/mcp-connector-auth", async (original) => ({
  ...await original<typeof import("../src/mcp-connector-auth")>(),
  authorizeMcpRemote: vi.fn(),
  npxSpawnPlan: () => ({ command: "npx", env: {}, shell: false }),
}));

vi.mock("../src/mcp-connector-oauth", async (original) => ({
  ...await original<typeof import("../src/mcp-connector-oauth")>(),
  authorizeMcpConnectorOAuth: vi.fn(),
  ownedMcpOAuthClient: vi.fn(),
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
  h.host = { appendLine: vi.fn(), openExternal: vi.fn() };
  h.remoteClients = { active: () => undefined, cwd: () => "" };
  h.captureRemoteRequester = () => ({});
  h.workspaceRoot = () => "";
  return { h, secrets };
}

let authRoot: string;
beforeEach(() => {
  authRoot = mkdtempSync(join(tmpdir(), "grok-remote-connector-test-"));
  vi.stubEnv("MCP_REMOTE_CONFIG_DIR", authRoot);
  mkdirSync(join(authRoot, `mcp-remote-${MCP_REMOTE_STORE_VERSION}`));
  vi.mocked(authorizeMcpRemote).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(authorizeMcpConnectorOAuth).mockReset();
  vi.mocked(ownedMcpOAuthClient).mockReset();
  vi.mocked(spawn).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(authRoot, { recursive: true, force: true });
});

const client = { client_id: "host-client", redirect_uris: ["https://relay.example/mcp/oauth/callback"] };

function begin(h: any, clientId = "phone-a") {
  const url = "https://vendor.example/authorize?state=private-attempt";
  let finish!: (result: typeof client) => void;
  let fail!: (error: Error) => void;
  vi.mocked(authorizeMcpConnectorOAuth).mockImplementationOnce(async (opts) => {
    opts.onAuthorization(url);
    return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const connecting = h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", clientId);
  return { url, finish: (_result: unknown) => finish(client), fail: (error: Error) => fail(error), connecting };
}

describe("remote connector host routing", () => {
  it.each([true, false])("keeps the private client file through the probe and deletes it afterward (success=%s)", async (ok) => {
    const { h } = host();
    const editor = vi.fn();
    h.settingsEditor = { webview: { postMessage: editor } };
    let path = "";
    vi.mocked(authorizeMcpRemote).mockImplementationOnce(async (opts) => {
      path = opts.args[opts.args.indexOf("--static-oauth-client-info") + 1].slice(1);
      expect(existsSync(path)).toBe(true);
      return ok ? { ok: true } : { ok: false, kind: "failed", message: "Could not connect." };
    });
    const attempt = begin(h);
    expect(editor).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting", url: attempt.url }));
    attempt.finish({ ok: true });
    await attempt.connecting;
    expect(existsSync(path)).toBe(false);
    expect(editor).toHaveBeenCalledWith(expect.objectContaining({ status: "finished" }));
    expect(h.connectedConnectorStore().notion !== undefined).toBe(ok);
  });

  it("clears failed authorization without launching the proxy", async () => {
    const { h } = host();
    const attempt = begin(h);
    attempt.fail(new Error("Sign-in was cancelled."));
    await attempt.connecting;
    expect(h.mcpRemoteAuthorization).toBeUndefined();
    expect(h.connectedConnectorStore()).toEqual({});
    expect(authorizeMcpRemote).not.toHaveBeenCalled();
  });

  it("broadcasts consent and finishes automatically after host authorization", async () => {
    const { h } = host();
    const attempt = begin(h);
    const [frame] = h.post.mock.lastCall;
    expect(frame).toMatchObject({ type: "mcpConnectorAuthorization", id: "notion", status: "waiting", url: attempt.url });
    expect(h.mcpRemoteAuthorization).not.toHaveProperty("clientId");
    expect(h.mcpRemoteAuthorization).not.toHaveProperty("complete");
    expect(authorizeMcpRemote).not.toHaveBeenCalled();
    expect(h.host.openExternal).not.toHaveBeenCalled();
    attempt.finish({ ok: true });
    await attempt.connecting;
    expect(h.mcpRemoteAuthorization).toBeUndefined();
    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ status: "finished", attemptId: frame.attemptId }));
    expect(h.connectedConnectorStore()).toHaveProperty("notion");
    const probe = vi.mocked(authorizeMcpRemote).mock.lastCall![0];
    expect(probe.headless).toBe(true);
    expect(probe.args).toContain("--static-oauth-client-info");
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
    expect(authorizeMcpConnectorOAuth).toHaveBeenCalledOnce();
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
    expect(authorizeMcpConnectorOAuth).toHaveBeenCalledOnce();
    expect(h.mcpRemoteAuthorization).toBe(pending);
    expect(h.mcpConnectError.message).toContain("Finish it with the link above");
    expect(h.mcpConnectorAuthorizationMessage()).toMatchObject({ attemptId: pending.attemptId, status: "waiting" });
    attempt.finish({ ok: true });
    await attempt.connecting;
  });

  it("keeps desk OAuth automatic and advertises the additive capability", async () => {
    const { h } = host();
    vi.mocked(authorizeMcpConnectorOAuth).mockImplementationOnce(async (opts) => {
      await opts.onAuthorization("https://vendor.example/authorize");
      return client;
    });
    await h.onMessage({ type: "connectMcpConnector", id: "notion" }, "local");
    expect(h.host.openExternal).toHaveBeenCalledWith("https://vendor.example/authorize");
    expect(vi.mocked(authorizeMcpRemote).mock.calls[0][0].headless).toBe(true);
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
      expect(args.headless).toBeUndefined();
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

describe("known-unavailable connector recovery through existing actions", () => {
  const endpoint = "https://custom.example.invalid/mcp";
  const unavailable = { ok: false, kind: "server-unavailable", message: CONNECTOR_UNAVAILABLE_MESSAGE } as const;

  async function savedHost() {
    const { h, secrets } = host();
    h.reservedMcpIdentityFor = () => ({ names: [], urls: [] });
    await h.state.update(MCP_CONNECTORS_KEY, { notion: { endpoint } });
    h.state.update.mockClear();
    return { h, secrets };
  }

  it.each(["grok", "codex", "claude"])("a failed proxy is withheld from the next %s session and shown in Settings", async (provider) => {
    const { h } = await savedHost();
    vi.mocked(authorizeMcpConnectorOAuth).mockResolvedValue(client);
    vi.mocked(authorizeMcpRemote).mockResolvedValue(unavailable);
    await h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", "phone");
    expect(h.state.update).not.toHaveBeenCalled();
    expect(h.connectedConnectorStore()).toEqual({ notion: { endpoint } });
    expect(h.mcpConnectorsMessage().connectors.find((c) => c.id === "notion"))
      .toMatchObject({ connected: false, status: "error", endpoint });
    expect(await h.hostMcpServersFor({ provider }, vi.fn())).toEqual([]);
    // A second host reads the same marker, without inheriting an in-memory error.
    const second = await savedHost();
    expect(await second.h.hostMcpServersFor({ provider }, vi.fn())).toEqual([]);
    vi.mocked(authorizeMcpRemote).mockResolvedValue({ ok: true });
    await second.h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", "phone");
    expect(h.mcpConnectorsMessage().connectors.find((c) => c.id === "notion"))
      .toMatchObject({ connected: true, status: "idle" });
  });

  it.each(["local", "remote"])("%s Connect retries saved OAuth without authorizing or opening a browser", async (origin) => {
    const { h } = await savedHost();
    recordMcpRemoteOutcome(endpoint, unavailable);
    vi.mocked(ownedMcpOAuthClient).mockReturnValue(client);
    await h.onMessage({ type: "connectMcpConnector", id: "notion" }, origin, "phone");
    expect(authorizeMcpConnectorOAuth).not.toHaveBeenCalled();
    expect(h.host.openExternal).not.toHaveBeenCalled();
    expect(authorizeMcpRemote).toHaveBeenCalledTimes(1);
    const snapshots = h.post.mock.calls.map(([message]) => message).filter((message) => message.type === "mcpConnectors");
    if (origin === "remote") {
      expect(snapshots[0].connectors.find((c) => c.id === "notion").status).toBe("error");
      expect(snapshots[1].connectors.find((c) => c.id === "notion").status).toBe("connecting");
    }
    const args = vi.mocked(authorizeMcpRemote).mock.calls[0][0];
    expect(args.headless).toBe(true);
    expect(args.args).toContain(endpoint);
    expect(args.args).toContain("--static-oauth-client-info");
    expect(h.mcpConnectorsMessage().connectors.find((c) => c.id === "notion"))
      .toMatchObject({ connected: true, status: "idle" });
    const cleanup: Array<() => void> = [];
    try {
      for (const provider of ["grok", "codex", "claude"]) {
        expect(await h.hostMcpServersFor({ provider }, (fn) => cleanup.push(fn)))
          .toEqual([expect.objectContaining({ name: "notion" })]);
      }
    } finally { cleanup.forEach((fn) => fn()); }
  });

  it.each(["timeout", "port-conflict", "failed"] as const)("an ambiguous or healthy %s retry clears withholding and never respawns", async (kind) => {
    const { h } = await savedHost();
    recordMcpRemoteOutcome(endpoint, unavailable);
    vi.mocked(authorizeMcpRemote).mockResolvedValue({ ok: false, kind, message: kind });
    await h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", "phone");
    expect(authorizeMcpConnectorOAuth).not.toHaveBeenCalled();
    expect(authorizeMcpRemote).toHaveBeenCalledTimes(1);
    expect(h.state.update).not.toHaveBeenCalled();
    expect(await h.hostMcpServersFor({ provider: "grok" }, vi.fn()))
      .toEqual([expect.objectContaining({ name: "notion" })]);
    expect(h.mcpConnectorsMessage().connectors.find((c) => c.id === "notion").connected).toBe(true);
    if (kind === "port-conflict") expect(h.mcpConnectError).toBeUndefined();
  });

  it("a repeated definite failure retains saved auth and stays unavailable", async () => {
    const { h } = await savedHost();
    recordMcpRemoteOutcome(endpoint, unavailable);
    vi.mocked(authorizeMcpRemote).mockResolvedValue(unavailable);
    await h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", "phone");
    expect(authorizeMcpConnectorOAuth).not.toHaveBeenCalled();
    expect(h.state.update).not.toHaveBeenCalled();
    expect(await h.hostMcpServersFor({ provider: "grok" }, vi.fn())).toEqual([]);
  });

  it("a key retry accepts the existing form's empty token without becoming a preference-only write", async () => {
    const { h, secrets } = host();
    const key = "ghp_saved_key";
    await h.onMessage({ type: "connectMcpConnector", id: "github", key, readOnly: true }, "remote", "phone");
    const endpoint = h.connectedConnectorStore().github.endpoint;
    vi.mocked(authorizeMcpRemote).mockResolvedValueOnce(unavailable);
    await h.onMessage({ type: "connectMcpConnector", id: "github", key }, "remote", "phone");
    expect(h.mcpConnectorsMessage().connectors.find((c) => c.id === "github"))
      .toMatchObject({ connected: false, keySet: true });
    vi.mocked(authorizeMcpRemote).mockClear();
    await h.onMessage({ type: "connectMcpConnector", id: "github", key: "", readOnly: true }, "remote", "phone");
    expect(authorizeMcpRemote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authorizeMcpRemote).mock.calls[0][0].env?.AUTH_HEADER).toBe(`Bearer ${key}`);
    expect(h.connectedConnectorStore().github).toEqual({ endpoint, readOnly: true });
    expect(secrets.get(mcpConnectorSecretKey("github"))).toBe(key);
    expect(h.context.secrets.delete).not.toHaveBeenCalled();
    expect(h.mcpConnectorsMessage().connectors.find((c) => c.id === "github"))
      .toMatchObject({ connected: true, status: "idle" });
  });
});
