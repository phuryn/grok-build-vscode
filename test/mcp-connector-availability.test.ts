import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeMcpRemote, connectorsWithUnavailableServer, mcpServerUrlHash, recordMcpRemoteOutcome,
  type AuthorizeMcpRemoteResult,
} from "../src/mcp-connector-auth";
import {
  classifyConnectFailure, CONNECTOR_REAUTH_MESSAGE, CONNECTOR_UNAVAILABLE_MESSAGE,
  connectorViews, connectOutputLooksLikeUnavailableServer, hostMcpServers, MCP_REMOTE_STORE_VERSION,
} from "../src/mcp-connectors";

vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>() }));

const endpoint = "https://mcp.example.invalid/mcp";
const store = { canva: { endpoint }, github: { endpoint: "https://key.example.invalid/mcp", readOnly: true } };
const failure: AuthorizeMcpRemoteResult = { ok: false, kind: "server-unavailable", message: CONNECTOR_UNAVAILABLE_MESSAGE };
// Synthetic terminal Node connection errors: no genuine outage was captured
// in #8. In particular, these are NOT the healthy slow-start traces.
const refused = "[123] Connection error: TypeError: fetch failed\n  [cause]: Error: connect ECONNREFUSED 192.0.2.1:443\n";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("definite proxy unavailability predicate", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH"])("recognizes a terminal proxy %s", (code) => {
    const output = refused.replace("connect ECONNREFUSED", code === "ENOTFOUND" ? "getaddrinfo ENOTFOUND" : `connect ${code}`);
    expect(connectOutputLooksLikeUnavailableServer(output)).toBe(true);
    expect(classifyConnectFailure({ output, exitCode: 1 })).toBe("server-unavailable");
  });

  it.each([undefined, null, 0])("does not infer failure from an ambiguous exit (%s)", (exitCode) => {
    expect(classifyConnectFailure({ output: refused, exitCode })).not.toBe("server-unavailable");
  });

  it.each([
    "", "startup was cancelled", "unable to connect", "certificate error",
    "npm error code ENOTFOUND\nnpm error getaddrinfo ENOTFOUND registry.npmjs.org",
    "Error: getaddrinfo ENOTFOUND registry.npmjs.org",
    "Error: connect ECONNREFUSED 192.0.2.1:443",
    "Connection error: Error: getaddrinfo EAI_AGAIN mcp.example.invalid",
    "Connection error: Error: connect ETIMEDOUT 192.0.2.1:443",
    "Connection error: ConnectTimeoutError: fetch failed",
    "Connection error: HTTP 401", "Connection error: HTTP 403", "Connection error: HTTP 404",
    "Connection error: HTTP 500", "Connection error: HTTP 503",
    "Connection error: HTTP 401; remote description mentioned ECONNREFUSED",
    "Connection error: unknown error with code ECONNREFUSED",
    refused + "npm error code ECONNREFUSED",
    refused + "Error: listen EADDRINUSE",
    refused + "startup was cancelled",
    refused + "Connection timed out",
    refused + "Connected to remote server using StreamableHTTPClientTransport",
    refused + "Authentication successful",
    refused + '{"jsonrpc":"2.0","id":1,"result":{}}\n',
  ])("fails open for %s", (output) => {
    expect(connectOutputLooksLikeUnavailableServer(output)).toBe(false);
    expect(classifyConnectFailure({ output, exitCode: 1 })).not.toBe("server-unavailable");
  });

  it("a timeout, spawn error or auth rejection cannot turn into unavailability", () => {
    expect(classifyConnectFailure({ output: refused, exitCode: 1, timedOut: true })).toBe("timeout");
    expect(classifyConnectFailure({ output: refused, exitCode: 1, spawnError: { code: "ENOENT" } })).toBe("npx-missing");
    expect(classifyConnectFailure({ output: refused + "InvalidClientMetadataError", exitCode: 1 })).toBe("oauth-incompatible");
    expect(classifyConnectFailure({ output: refused + "InvalidClientMetadataError", exitCode: 1, auth: "key" })).toBe("key-rejected");
  });
});

describe("bounded proxy outcomes", () => {
  function probe() {
    const proc = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const result = authorizeMcpRemote({ command: "npx", args: [], spawn: () => proc as never, timeoutMs: 100 });
    return { proc, result };
  }

  it("waits for a failed exit, allowing transport fallback to work", async () => {
    const { proc, result } = probe();
    proc.stderr.write(refused);
    expect(proc.kill).not.toHaveBeenCalled();
    proc.stderr.write("Connected to remote server using StreamableHTTPClientTransport\n");
    await expect(result).resolves.toEqual({ ok: true });
  });

  it("records a definite failure only after the proxy exits", async () => {
    const { proc, result } = probe();
    proc.stderr.write(refused);
    proc.emit("close", 1, null);
    await expect(result).resolves.toEqual(failure);
  });

  it("a slow proxy never becomes unavailable, even after a connection error", async () => {
    vi.useFakeTimers();
    const { proc, result } = probe();
    proc.stderr.write(refused);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({ ok: false, kind: "timeout" });
  });
});

describe("fresh availability markers, separate from authorization", () => {
  let root: string;
  let dir: string;
  const opts = () => ({ home: root, env: { MCP_REMOTE_CONFIG_DIR: root } });
  const marker = (url = endpoint) => join(dir, `${mcpServerUrlHash(url)}_grok-unavailable.json`);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "grok-availability-test-"));
    dir = join(root, `mcp-remote-${MCP_REMOTE_STORE_VERSION}`);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("absent storage withholds nothing and recording cannot create an auth store", () => {
    recordMcpRemoteOutcome(endpoint, failure, opts());
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual([]);
  });

  it("reads each change without a reload and never modifies tokens, registration or the saved record", () => {
    mkdirSync(dir);
    const token = join(dir, `${mcpServerUrlHash(endpoint)}_tokens.json`);
    const client = join(dir, `${mcpServerUrlHash(endpoint)}_client_info.json`);
    writeFileSync(token, "saved-token");
    writeFileSync(client, "saved-client");
    const before = JSON.stringify(store);
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual([]);
    recordMcpRemoteOutcome(endpoint, failure, opts());
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual(["canva"]);
    recordMcpRemoteOutcome(endpoint, { ok: true }, opts());
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual([]);
    expect(readFileSync(token, "utf8")).toBe("saved-token");
    expect(readFileSync(client, "utf8")).toBe("saved-client");
    expect(JSON.stringify(store)).toBe(before);
  });

  it.each(["timeout", "port-conflict", "failed", "endpoint-refused", "npx-missing", "cancelled", "oauth-incompatible", "key-rejected"] as const)("%s clears a previous failure and cannot create one", (kind) => {
    mkdirSync(dir);
    recordMcpRemoteOutcome(endpoint, failure, opts());
    const result = { ok: false, kind, message: "ambiguous" } as const;
    recordMcpRemoteOutcome(endpoint, result, opts());
    recordMcpRemoteOutcome(store.github.endpoint, result, opts());
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual([]);
  });

  it.each(["", "{", "null", "false", "[]", '"timeout"', '{"kind":"server-unavailable"}'])("malformed or unknown marker %s withholds nothing", (raw) => {
    mkdirSync(dir);
    writeFileSync(marker(), raw);
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual([]);
  });

  it("ignores markers for a different endpoint, proxy version or disconnected connector", () => {
    mkdirSync(dir);
    recordMcpRemoteOutcome(endpoint, failure, opts());
    expect([...connectorsWithUnavailableServer({ ...opts(), store: {} })]).toEqual([]);
    expect([...connectorsWithUnavailableServer({ ...opts(), store: { canva: { endpoint: endpoint + "/changed" } } })]).toEqual([]);
    const nextRoot = join(root, "another-store");
    expect([...connectorsWithUnavailableServer({ store, env: { MCP_REMOTE_CONFIG_DIR: nextRoot } })]).toEqual([]);
    rmSync(marker());
    const abandoned = join(root, "mcp-remote-9.9.9");
    mkdirSync(abandoned);
    writeFileSync(join(abandoned, `${mcpServerUrlHash(endpoint)}_grok-unavailable.json`), JSON.stringify("server-unavailable"));
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual([]);
  });

  it("filesystem faults fail open without throwing", () => {
    const fs = { readFileSync: () => { throw new Error("EACCES"); },
      writeFileSync: () => { throw new Error("ENOSPC"); }, unlinkSync: () => { throw new Error("EACCES"); } };
    expect([...connectorsWithUnavailableServer({ ...opts(), store, fs })]).toEqual([]);
    expect(() => recordMcpRemoteOutcome(endpoint, failure, { ...opts(), fs })).not.toThrow();
    expect(() => recordMcpRemoteOutcome(endpoint, undefined, { ...opts(), fs })).not.toThrow();
  });

  it("unavailable md5 cannot withhold anything", () => {
    mkdirSync(dir);
    recordMcpRemoteOutcome(endpoint, failure, opts());
    vi.spyOn(crypto, "createHash").mockImplementation(() => { throw new Error("FIPS"); });
    expect([...connectorsWithUnavailableServer({ ...opts(), store })]).toEqual([]);
    expect(() => recordMcpRemoteOutcome(endpoint, failure, opts())).not.toThrow();
  });
});

describe("unavailable connector hand-off and Settings row", () => {
  const unavailable = new Set(["canva", "github"]);
  it("withholds both auth types without changing the connected store", () => {
    const before = JSON.stringify(store);
    expect(hostMcpServers(store, undefined, {}, { github: "saved" }, new Set(), unavailable)).toEqual([]);
    expect(hostMcpServers(store, undefined, {}, { github: "saved" }).map((s) => s.name)).toEqual(["canva", "github"]);
    expect(JSON.stringify(store)).toBe(before);
  });

  it("offers Connect with a server/network explanation and saved-auth recovery", () => {
    const rows = connectorViews(store, { unavailable, keySet: new Set(["github"]) });
    for (const id of unavailable) {
      const row = rows.find((row) => row.id === id)!;
      expect(row.connected).toBe(false);
      expect(row.status).toBe("error");
      expect(row.error).toContain(CONNECTOR_UNAVAILABLE_MESSAGE);
      expect(row.error).not.toContain(CONNECTOR_REAUTH_MESSAGE);
    }
    expect(rows.find((row) => row.id === "github")).toMatchObject({ keySet: true, readOnly: true });
    expect(rows.find((row) => row.id === "github")?.error).toContain("Leave the token field empty");
    expect(rows.find((row) => row.id === "canva")?.error).toContain("saved authorization will be reused");
  });

  it("keeps the row unavailable during retry, with connecting status", () => {
    expect(connectorViews(store, { unavailable, connectingId: "canva" }).find((r) => r.id === "canva"))
      .toMatchObject({ connected: false, status: "connecting" });
  });

  it("missing authorization takes precedence, and absent records stay idle", () => {
    expect(connectorViews(store, { unavailable, lapsed: new Set(["canva"]) }).find((r) => r.id === "canva")?.error)
      .toBe(CONNECTOR_REAUTH_MESSAGE);
    expect(connectorViews({}, { unavailable }).find((r) => r.id === "canva"))
      .toMatchObject({ connected: false, status: "idle" });
  });
});
