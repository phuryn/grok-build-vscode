import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeMcpConnectorOAuth, generateMcpOAuthChallenge, mcpOAuthRegistrationKey, mcpOAuthTokenPath,
  mcpOAuthUrls, ownedMcpOAuthClient, pollMcpOAuthResult, seedMcpOAuthTokens, writeOAuthClientInfoFile } from "../src/mcp-connector-oauth";
import { mcpRemoteArgs, connectorById, MCP_REMOTE_STORE_VERSION } from "../src/mcp-connectors";
import { GrokSidebar } from "../src/sidebar";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const roots: string[] = [];
function temp() { const root = fs.mkdtempSync(join(tmpdir(), "grok-oauth-test-")); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const relayUrl = "wss://dev.relay.example/socket";
const endpoint = "https://mcp.notion.com/mcp";
const callback = "https://dev.relay.example/mcp/oauth/callback";
const issuer = "https://auth.example/tenant";
const client = { client_id: "registered-client", redirect_uris: [callback] };
const tokens = { access_token: "test-access", token_type: "Bearer", expires_in: 3600, refresh_token: "test-refresh", scope: "tools" };
const registration = (active = true) => ({ endpoint, issuer, client, active });

function secrets() {
  const data = new Map<string, string>();
  return { data, get: vi.fn(async (key: string) => data.get(key)), store: vi.fn(async (key: string, value: string) => { data.set(key, value); }) };
}

describe("state, PKCE, relay origin and token-store compatibility", () => {
  it("generates independent high-entropy state and RFC7636 S256 verifier/challenge pairs", () => {
    const pairs = Array.from({ length: 100 }, generateMcpOAuthChallenge);
    expect(new Set(pairs.map((pair) => pair.state)).size).toBe(100);
    expect(new Set(pairs.map((pair) => pair.verifier)).size).toBe(100);
    for (const pair of pairs) {
      expect(pair.state).toMatch(/^[A-Za-z0-9._~-]{32,256}$/);
      expect(Buffer.from(pair.state, "base64url")).toHaveLength(32);
      expect(pair.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      expect(pair.verifier).not.toBe(pair.state);
      expect(pair.challenge).toBe(createHash("sha256").update(pair.verifier).digest("base64url"));
    }
  });

  it("uses the configured relay origin and separates production/dev registrations", () => {
    expect(mcpOAuthUrls(relayUrl)).toEqual({ origin: "https://dev.relay.example", callback, result: "https://dev.relay.example/mcp/oauth/result" });
    expect(mcpOAuthUrls("ws://127.0.0.1:8787/ws").callback).toBe("http://127.0.0.1:8787/mcp/oauth/callback");
    expect(mcpOAuthRegistrationKey("notion", relayUrl)).toBe(mcpOAuthRegistrationKey("notion", "wss://dev.relay.example/else"));
    expect(mcpOAuthRegistrationKey("notion", relayUrl)).not.toBe(mcpOAuthRegistrationKey("notion", "wss://prod.relay.example"));
    expect(mcpOAuthRegistrationKey("notion", relayUrl)).not.toBe(mcpOAuthRegistrationKey("linear", relayUrl));
  });

  it("seeds the exact response plus millisecond expires_at at the measured hash/version path", () => {
    const root = temp();
    const path = mcpOAuthTokenPath("https://mcp.linear.app/mcp", { MCP_REMOTE_CONFIG_DIR: root }, "/unused");
    expect(path).toBe(join(root, "mcp-remote-0.1.36", "fcc436b0d1e0a1ed9a2b15bbd638eb13_tokens.json"));
    seedMcpOAuthTokens(path, tokens, 1700000000000);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ ...tokens, expires_at: 1700003600000 });
    expect(fs.readdirSync(join(root, `mcp-remote-${MCP_REMOTE_STORE_VERSION}`))).toHaveLength(1);
    if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([undefined, 0, -1, NaN, Infinity, "3600"])("refuses an unusable expiry (%s) without replacing a legacy token", (expires_in) => {
    const path = join(temp(), "tokens.json");
    fs.writeFileSync(path, "legacy");
    expect(() => seedMcpOAuthTokens(path, { ...tokens, expires_in })).toThrow(/expiry/);
    expect(fs.readFileSync(path, "utf8")).toBe("legacy");
  });

  it("keeps an existing token and removes staging files when atomic replacement fails", () => {
    const root = temp(); const path = join(root, "tokens.json");
    fs.writeFileSync(path, "legacy");
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect(() => seedMcpOAuthTokens(path, tokens)).toThrow("EACCES");
    expect(fs.readFileSync(path, "utf8")).toBe("legacy");
    expect(fs.readdirSync(root)).toEqual(["tokens.json"]);
  });

  it("puts a confidential client in a private disposable file, never argv", () => {
    const root = temp();
    const confidential = { ...client, client_secret: "private-client-secret" };
    const file = writeOAuthClientInfoFile(confidential, root);
    expect(JSON.parse(fs.readFileSync(file.path, "utf8"))).toEqual(confidential);
    expect(mcpRemoteArgs(endpoint, undefined, undefined, undefined, file.path)).toContain(`@${file.path}`);
    expect(mcpRemoteArgs(endpoint, undefined, undefined, undefined, file.path).join(" ")).not.toContain(confidential.client_secret);
    if (process.platform !== "win32") expect(fs.statSync(file.path).mode & 0o777).toBe(0o600);
    file.dispose(); file.dispose();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("cleans the private directory on file-write failure", () => {
    const root = temp();
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => writeOAuthClientInfoFile(client, root)).toThrow("disk full");
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("relay polling", () => {
  it("keeps polling unknown states (204) and consumes a 200 code exactly once", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(Response.json({ code: "one-code" }));
    const state = generateMcpOAuthChallenge().state;
    await expect(pollMcpOAuthResult({ relayUrl, state, fetch: request, pollIntervalMs: 1 })).resolves.toBe("one-code");
    expect(request).toHaveBeenCalledTimes(3);
    expect(new URL(request.mock.calls[0][0]).searchParams.get("state")).toBe(state);
  });

  it.each(["access_denied", "server_error"])("handles a 200 provider error (%s) without leaking its description", async (error) => {
    const request = vi.fn().mockResolvedValue(Response.json({ error, errorDescription: "secret-description" }));
    await expect(pollMcpOAuthResult({ relayUrl, state: "s".repeat(43), fetch: request })).rejects.toThrow(error === "access_denied" ? /cancelled/ : /could not authorize/);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([400, 500])("stops on HTTP %s without retrying a consumed outcome", async (status) => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status }));
    await expect(pollMcpOAuthResult({ relayUrl, state: "s".repeat(43), fetch: request })).rejects.toThrow(status === 400 ? /expired or was already used/ : /relay failed/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("bounds a stream of 204 replies", async () => {
    const request = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(pollMcpOAuthResult({ relayUrl, state: "s".repeat(43), fetch: request, timeoutMs: 20, pollIntervalMs: 1 })).rejects.toThrow(/timed out/);
  });

  it("aborts a hung long-poll request at the deadline", async () => {
    const request = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(pollMcpOAuthResult({ relayUrl, state: "s".repeat(43), fetch: request, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not retry transport errors or malformed JSON after possible delivery", async () => {
    for (const failure of [new Error("network down"), new Response("invalid json"), Response.json({})]) {
      const request = vi.fn();
      if (failure instanceof Error) request.mockRejectedValue(failure); else request.mockResolvedValue(failure);
      await expect(pollMcpOAuthResult({ relayUrl, state: "s".repeat(43), fetch: request })).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    }
  });
});

function flow(options: { confidential?: boolean; postAuth?: boolean; outcome?: Record<string, unknown>; resourceFallback?: boolean; oidc?: boolean } = {}) {
  const root = temp();
  const vault = secrets();
  const returnedClient = { ...client, ...(options.confidential ? { client_secret: "test-client-secret", token_endpoint_auth_method: "none" } : {}) };
  const onAuthorization = vi.fn();
  const request = vi.fn(async (input, init) => {
    const url = String(input);
    if (url === endpoint) return new Response(null, { status: 401, headers: options.resourceFallback ? {} : {
      "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.notion.com/resource-metadata", scope="tools"',
    } });
    if (url.endsWith("oauth-protected-resource/mcp")) return new Response(null, { status: 404 });
    if (url.endsWith("/resource-metadata") || url.endsWith("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ["tools"] });
    if (url.includes(".well-known/oauth-authorization-server") || url.includes(".well-known/openid-configuration")) {
      if (options.oidc && !url.endsWith("/tenant/.well-known/openid-configuration")) return new Response(null, { status: 404 });
      return Response.json({ issuer, authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register", code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [options.postAuth ? "client_secret_post" : "client_secret_basic", "none"] });
    }
    if (url.endsWith("/register")) return Response.json(returnedClient, { status: 201 });
    if (url.includes("/mcp/oauth/result")) return Response.json(options.outcome ?? { code: "relay-code" });
    if (url.endsWith("/token")) return Response.json(tokens);
    throw new Error(`Unexpected request: ${url}`);
  });
  const opts = { connector: connectorById("notion")!, endpoint, relayUrl, secrets: vault, onAuthorization,
    fetch: request as typeof fetch, env: { MCP_REMOTE_CONFIG_DIR: root }, pollIntervalMs: 1 };
  return { root, vault, request, opts, onAuthorization, returnedClient,
    tokenPath: () => mcpOAuthTokenPath(endpoint, opts.env),
    calls: (path: string) => request.mock.calls.filter(([url]) => String(url).endsWith(path)) };
}

describe("owned registration versus legacy connector", () => {
  it("requires completed migration, matching connector endpoint, and matching relay origin", async () => {
    const vault = secrets();
    expect(await ownedMcpOAuthClient(vault, "notion", endpoint, relayUrl)).toBeUndefined();
    for (const active of [false, true]) {
      vault.data.set(mcpOAuthRegistrationKey("notion", relayUrl), JSON.stringify(registration(active)));
      expect(await ownedMcpOAuthClient(vault, "notion", endpoint, relayUrl)).toEqual(active ? client : undefined);
    }
    expect(await ownedMcpOAuthClient(vault, "notion", endpoint, "wss://prod.relay.example")).toBeUndefined();
    expect(await ownedMcpOAuthClient(vault, "notion", "https://other.example/mcp", relayUrl)).toBeUndefined();
    expect(await ownedMcpOAuthClient(vault, "linear", endpoint, relayUrl)).toBeUndefined();
    expect(mcpRemoteArgs(endpoint)).not.toContain("--static-oauth-client-info");
  });

  it("does not migrate or replace legacy tokens on cancelled consent, but reuses DCR on retry", async () => {
    const h = flow({ outcome: { error: "access_denied" } });
    fs.writeFileSync(h.tokenPath(), "legacy-token");
    await expect(authorizeMcpConnectorOAuth(h.opts)).rejects.toThrow(/cancelled/);
    expect(await ownedMcpOAuthClient(h.vault, "notion", endpoint, relayUrl)).toBeUndefined();
    expect(fs.readFileSync(h.tokenPath(), "utf8")).toBe("legacy-token");
    await expect(authorizeMcpConnectorOAuth(h.opts)).rejects.toThrow(/cancelled/);
    expect(h.calls("/register")).toHaveLength(1);
    expect(h.calls("/token")).toHaveLength(0);
  });

  it.each(["grok", "codex", "claude"])("passes static client info only for our registration to %s and cleans it with its CLI", async (provider) => {
    const h = flow({ confidential: true });
    await authorizeMcpConnectorOAuth(h.opts);
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.loadMcpConnectorKeys = async () => {};
    sidebar.connectedConnectorStore = () => ({ notion: { endpoint }, linear: { endpoint: "https://mcp.linear.app/mcp" } });
    sidebar.context = { secrets: h.vault };
    sidebar.relayUrl = () => relayUrl;
    sidebar.reservedMcpIdentityFor = () => ({ names: [], urls: [] });
    sidebar.lapsedOAuthConnectors = () => new Set();
    const cleanup = vi.fn();
    const servers = await sidebar.hostMcpServersFor({ provider }, cleanup);
    const notion = servers.find((server) => server.name === "notion");
    const linear = servers.find((server) => server.name === "linear");
    const file = notion.args[notion.args.indexOf("--static-oauth-client-info") + 1].slice(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(h.returnedClient);
    expect(JSON.stringify(servers)).not.toContain("test-client-secret");
    expect(linear.args).toEqual(mcpRemoteArgs("https://mcp.linear.app/mcp"));
    expect(cleanup).toHaveBeenCalledOnce();
    cleanup.mock.calls[0][0]();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("host-owned OAuth flow (all HTTP mocked)", () => {
  it.each([{}, { confidential: true }, { confidential: true, postAuth: true }])("registers, authorizes, exchanges and seeds with identical redirect URI (%j)", async (options) => {
    const h = flow(options);
    const before = Date.now();
    expect(await authorizeMcpConnectorOAuth(h.opts)).toEqual(h.returnedClient);
    const dcr = JSON.parse(h.calls("/register")[0][1].body);
    expect(dcr).toMatchObject({ redirect_uris: [callback], response_types: ["code"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" });
    const authorization = new URL(h.onAuthorization.mock.calls[0][0]);
    expect(authorization.searchParams.get("redirect_uri")).toBe(callback);
    expect(authorization.searchParams.get("resource")).toBe(endpoint);
    const exchange = h.calls("/token")[0][1];
    const body = new URLSearchParams(exchange.body);
    expect(body.get("redirect_uri")).toBe(callback);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("relay-code");
    expect(body.get("resource")).toBe(endpoint);
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
    if (options.confidential && !options.postAuth) expect(exchange.headers.Authorization).toBe(`Basic ${Buffer.from("registered-client:test-client-secret").toString("base64")}`);
    else expect(body.get("client_id")).toBe(client.client_id);
    if (options.postAuth) expect(body.get("client_secret")).toBe("test-client-secret");
    expect(authorization.href).not.toContain("test-client-secret");
    const seeded = JSON.parse(fs.readFileSync(h.tokenPath(), "utf8"));
    expect(seeded).toEqual({ ...tokens, expires_at: expect.any(Number) });
    expect(seeded.expires_at).toBeGreaterThanOrEqual(before + 3600000);
    expect(await ownedMcpOAuthClient(h.vault, "notion", endpoint, relayUrl)).toEqual(h.returnedClient);
    await authorizeMcpConnectorOAuth(h.opts);
    expect(h.calls("/register")).toHaveLength(1);
    expect(h.calls("/token")).toHaveLength(2); // Only authorization_code, never host refresh.
  });

  it("supports resource and OIDC discovery fallbacks", async () => {
    const h = flow({ resourceFallback: true, oidc: true });
    await authorizeMcpConnectorOAuth(h.opts);
    expect(h.calls("/tenant/.well-known/openid-configuration")).toHaveLength(1);
    expect(new URL(h.onAuthorization.mock.calls[0][0]).searchParams.get("scope")).toBe("tools");
  });

  it("preserves Stripe's explicit scope override", async () => {
    const h = flow();
    await authorizeMcpConnectorOAuth({ ...h.opts, connector: connectorById("stripe")! });
    expect(new URL(h.onAuthorization.mock.calls[0][0]).searchParams.get("scope")).toBe("mcp");
    expect(JSON.parse(h.calls("/register")[0][1].body).scope).toBe("mcp");
  });

  it("restores legacy tokens when activating the registration in SecretStorage fails", async () => {
    const h = flow();
    fs.writeFileSync(h.tokenPath(), "legacy-token");
    h.vault.store.mockImplementation(async (key, value) => {
      if (JSON.parse(value).active) throw new Error("vault failure with secret");
      h.vault.data.set(key, value);
    });
    await expect(authorizeMcpConnectorOAuth(h.opts)).rejects.toThrow("Could not complete connector sign-in");
    expect(fs.readFileSync(h.tokenPath(), "utf8")).toBe("legacy-token");
    expect(await ownedMcpOAuthClient(h.vault, "notion", endpoint, relayUrl)).toBeUndefined();
  });

  it("does not reflect transport/secret-store details and never seeds on failure", async () => {
    const h = flow();
    h.request.mockRejectedValueOnce(new Error("private token in network error"));
    await expect(authorizeMcpConnectorOAuth(h.opts)).rejects.toThrow("Could not complete connector sign-in");
    expect(fs.existsSync(h.tokenPath())).toBe(false);
    expect(h.onAuthorization).not.toHaveBeenCalled();
  });

  it("bounds a stalled discovery request before presenting a link", async () => {
    const h = flow();
    h.request.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(authorizeMcpConnectorOAuth({ ...h.opts, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(h.onAuthorization).not.toHaveBeenCalled();
  });

  it("gives consent its own budget after discovery and bounds token exchange", async () => {
    const h = flow();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (url, init) => {
      if (String(url).includes("/mcp/oauth/result")) {
        await new Promise((resolve) => setTimeout(resolve, 35));
        expect(init.signal.aborted).toBe(false);
      }
      if (String(url).endsWith("/token")) return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return original(url, init);
    });
    await expect(authorizeMcpConnectorOAuth({ ...h.opts, timeoutMs: 20, authorizationTimeoutMs: 80 })).rejects.toThrow(/timed out/);
    expect(h.calls("/token")).toHaveLength(1);
    expect(fs.existsSync(h.tokenPath())).toBe(false);
  });
});
