import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { authorizeMcpRemote } from "../src/mcp-connector-auth";
import { MCP_CONNECTORS_KEY, mcpConnectorSecretKey } from "../src/mcp-connectors";

vi.mock("../src/mcp-connector-auth", async (original) => ({
  ...await original<typeof import("../src/mcp-connector-auth")>(),
  authorizeMcpRemote: vi.fn(),
  npxSpawnPlan: () => ({ command: "npx", env: {}, shell: false }),
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
  h.postMcpConnectors = vi.fn();
  h.deliverRemote = vi.fn();
  h.post = vi.fn();
  h.host = { appendLine: vi.fn() };
  h.remoteClients = { active: () => undefined, cwd: () => "" };
  h.captureRemoteRequester = () => ({});
  h.workspaceRoot = () => "";
  return { h, secrets };
}

beforeEach(() => { vi.mocked(authorizeMcpRemote).mockReset(); });

describe("remote connector host routing", () => {
  it("routes the link and correction only to the requester, then clears the attempt", async () => {
    const { h } = host();
    const url = "https://vendor.example/authorize?state=private-attempt";
    const complete = vi.fn().mockRejectedValueOnce(new Error("state does not match")).mockResolvedValue(undefined);
    let finish!: (result: { ok: true }) => void;
    vi.mocked(authorizeMcpRemote).mockImplementation(async (opts) => {
      opts.onAuthorization!(url, complete);
      return new Promise((resolve) => { finish = resolve; });
    });
    const connecting = h.onMessage({ type: "connectMcpConnector", id: "notion" }, "remote", "phone-a");
    const [, frame] = h.deliverRemote.mock.calls[0];
    expect(h.deliverRemote.mock.calls[0]).toEqual([["phone-a"], expect.objectContaining({
      type: "mcpConnectorAuthorization", id: "notion", status: "waiting", url,
    })]);
    const message = { type: "completeMcpConnectorOAuth", id: "notion", attemptId: frame.attemptId, redirectUrl: "pasted" };
    await h.onMessage(message, "remote", "phone-b");
    expect(complete).not.toHaveBeenCalled();
    expect(h.deliverRemote.mock.lastCall).toEqual([["phone-b"], expect.objectContaining({ status: "finished" })]);
    expect(JSON.stringify(h.deliverRemote.mock.lastCall)).not.toContain(url);
    await h.onMessage(message, "remote", "phone-a");
    expect(h.deliverRemote.mock.lastCall).toEqual([["phone-a"], expect.objectContaining({ status: "waiting", error: "state does not match", url })]);
    await h.onMessage({ ...message, attemptId: "stale" }, "remote", "phone-a");
    expect(complete).toHaveBeenCalledTimes(1);
    await h.onMessage(message, "remote", "phone-a");
    expect(h.deliverRemote.mock.lastCall).toEqual([["phone-a"], expect.objectContaining({ status: "submitted" })]);
    finish({ ok: true });
    await connecting;
    expect(h.mcpRemoteAuthorization).toBeUndefined();
    expect(h.deliverRemote.mock.lastCall).toEqual([["phone-a"], expect.objectContaining({ status: "finished" })]);
    expect(h.connectedConnectorStore()).toHaveProperty("notion");
    expect(h.post).not.toHaveBeenCalled();
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
