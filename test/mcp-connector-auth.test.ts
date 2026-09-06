import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  mcpRemoteStoreDir,
  authorizeMcpRemote,
  connectorsLackingOAuthToken,
  mcpServerUrlHash,
  npxSpawnPlan,
  persistConnectorOAuthClientMetadata,
  quoteSpawnArgs,
  writeOAuthClientMetadataFile,
} from "../src/mcp-connector-auth";
import {
  MCP_INITIALIZE_REQUEST,
  MCP_REMOTE_AUTH_HEADER_ENV,
  MCP_REMOTE_AUTH_HEADER_TEMPLATE,
  MCP_REMOTE_HEADER_FLAG,
  STATIC_OAUTH_CLIENT_METADATA_FLAG,
  connectConnector,
  connectFailureMessage,
  mcpConnectorSecretKey,
  mcpRemoteArgs,
  withMcpRemoteCallbackPort,
  MCP_CONNECTORS_KEY,
  MCP_REMOTE_PACKAGE } from "../src/mcp-connectors";
import { DISK_KEYS, PersistedState, type MementoLike, type StateFs } from "../src/persisted-state";
import { GrokSidebar } from "../src/sidebar";

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  written = "";

  constructor() {
    super();
    this.stdin.on("data", (buf: Buffer) => { this.written += String(buf); });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

describe("sidebar connect wiring", () => {
  it("hands the child npxSpawnPlan's env, not the stripped process.env", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private async connectMcpConnector(");
    const end = src.indexOf("private async disconnectMcpConnector(");
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("env: npx.env");
    expect(body).not.toContain("env: process.env");
    expect(body).toContain("writeOAuthClientMetadataFile");
    expect(body).toContain("clientInfo.path");
    expect(body).not.toContain("quoteSpawnArgs");
    expect(body).toContain("withAuthHeaderEnv(npx.env, token)");
    expect(body).toContain('auth: "key"');
    expect(body).toContain("this.context.secrets.store");
    expect(body).toContain("mcpConnectorSecretKey");
  });

  it("disconnect of a key connector deletes HostSecrets and the connected record", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private async disconnectMcpConnector(");
    const end = src.indexOf("private findLiveGrokSession(", start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("forgetConnectorKey");
    expect(body).toContain("disconnectConnector");
    expect(body).toContain("MCP_CONNECTORS_KEY");
    const forgetStart = src.indexOf("private async forgetConnectorKey(");
    const forgetEnd = src.indexOf("private async connectMcpConnector(", forgetStart);
    const forget = src.slice(forgetStart, forgetEnd);
    expect(forgetStart).toBeGreaterThan(-1);
    expect(forgetEnd).toBeGreaterThan(forgetStart);
    expect(forget).toContain("this.context.secrets.delete");
    expect(forget).toContain("mcpConnectorSecretKey");
  });

  it("loading keys never writes grok.mcpConnectors, including when a secret read fails", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private async loadMcpConnectorKeys(");
    const end = src.indexOf("private async forgetConnectorKey(", start);
    const load = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(load).toContain("this.context.secrets.get");
    expect(load).toContain("mcpConnectorSecretKey");
    expect(load).toContain("could not read");
    expect(load).toContain("this.postMcpConnectors");
    expect(load).not.toContain("disconnectConnector");
    expect(load).not.toContain("forgetConnectorKey");
    expect(load).not.toContain("this.state.update");
    expect(load).not.toContain("MCP_CONNECTORS_KEY");
    expect(load).not.toContain("connectedConnectorStore");
  });

  it("session/new Stripe entry also carries static OAuth client metadata", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private async hostMcpServersFor(");
    const end = src.indexOf("private async loadMcpConnectorKeys(");
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("persistConnectorOAuthClientMetadata");
    expect(body).toContain("hostMcpServers(");
    expect(body).toContain("this.mcpConnectorKeys");
    expect(body).toContain("this.loadMcpConnectorKeys");
    expect(body).toContain("this.connectedConnectorStore");
    expect(body).not.toContain("quoteSpawnArgs");
    expect(body).not.toContain("disconnectConnector");
    expect(body).not.toContain("this.state.update");
  });
});

const SPACED_METADATA_PATH =
  "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\grok-mcp-oauth-x\\oauth-client-metadata.json";
const SPACED_METADATA_ARG = `@${SPACED_METADATA_PATH}`;
const SPACED_MCP_ARGV = [
  "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com",
  STATIC_OAUTH_CLIENT_METADATA_FLAG, SPACED_METADATA_ARG,
];

describe("quoteSpawnArgs", () => {
  it("is applied at the mcp-remote spawn seam", () => {
    const src = readFileSync(new URL("../src/mcp-connector-auth.ts", import.meta.url), "utf8");
    expect(src).toMatch(/quoteSpawnArgs\(opts\.args,\s*opts\.shell\)/);
  });

  it("wraps whitespace-bearing entries for a shell spawn and leaves the rest raw", () => {
    expect(quoteSpawnArgs(SPACED_MCP_ARGV, true)).toEqual([
      "-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, `"${SPACED_METADATA_ARG}"`,
    ]);
    expect(quoteSpawnArgs(["-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com"], true))
      .toEqual(["-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com"]);
  });

  it("leaves argv unchanged for a non-shell spawn", () => {
    expect(quoteSpawnArgs(SPACED_MCP_ARGV, false)).toEqual(SPACED_MCP_ARGV);
    expect(quoteSpawnArgs(SPACED_MCP_ARGV)).toEqual(SPACED_MCP_ARGV);
    expect(quoteSpawnArgs(SPACED_MCP_ARGV, false).some((arg) => arg.startsWith('"'))).toBe(false);
  });

  it("a shell-spawned child receives the original unquoted path as one argument", () => {
    const root = mkdtempSync(join(tmpdir(), "Jane Doe-echo-"));
    const script = join(root, "echo-argv.cjs");
    try {
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
      const result = spawnSync("node", quoteSpawnArgs([script, SPACED_METADATA_ARG], true), {
        encoding: "utf8",
        shell: true,
        windowsHide: true,
        timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([script, SPACED_METADATA_ARG]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a non-shell spawn is given the raw argv, with no quotes added", () => {
    const root = mkdtempSync(join(tmpdir(), "Jane Doe-echo-"));
    const script = join(root, "echo-argv.cjs");
    try {
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
      const argv = quoteSpawnArgs([script, SPACED_METADATA_ARG], false);
      expect(argv).toEqual([script, SPACED_METADATA_ARG]);
      const result = spawnSync(process.execPath, argv, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([script, SPACED_METADATA_ARG]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("headless OAuth guard", () => {
  function begin() {
    const proc = new FakeProc();
    const spawn = vi.fn(() => proc as never);
    const result = authorizeMcpRemote({ command: "npx", args: mcpRemoteArgs("https://vendor.example/mcp"),
      spawn, timeoutMs: 1000, headless: true,
      env: { PATH: "npx-path", NODE_OPTIONS: "--no-warnings" } });
    return { proc, spawn, result };
  }

  it("fails an unexpected authorization attempt without exposing the link", async () => {
    const h = begin();
    h.proc.stderr.write("Please authorize this client by visiting:\nhttps://vendor.example/?state=private\n");
    const result = await h.result;
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(h.proc.killed).toBe(true);
  });

  it.each(["error", "close"])("cleans up the preload on asynchronous %s", async (event) => {
    const h = begin();
    const options = h.spawn.mock.calls[0][2].env.NODE_OPTIONS as string;
    expect(options).toContain("--no-warnings --require ");
    const preload = JSON.parse(options.slice(options.indexOf("--require ") + 10));
    expect(existsSync(preload)).toBe(true);
    h.proc.emit(event, event === "error" ? new Error("spawn failed") : 1);
    await expect(h.result).resolves.toMatchObject({ ok: false });
    expect(existsSync(preload)).toBe(false);
  });
});

describe("npx spawn plan", () => {
  it("uses the Windows cmd shim with a shell", () => {
    const empty = { pathEnv: "", isFile: () => false };
    expect(npxSpawnPlan("win32", empty)).toMatchObject({ command: "npx.cmd", shell: true });
    expect(npxSpawnPlan("linux", empty)).toMatchObject({ command: "npx", shell: false });
  });
});

describe("authorizeMcpRemote", () => {
  it("succeeds when initialize returns, then kills the bridge", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    expect(proc.written).toBe(MCP_INITIALIZE_REQUEST);
    proc.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}\n');
    await expect(result).resolves.toEqual({ ok: true });
    expect(proc.killed).toBe(true);
  });

  it("succeeds on an auth-success log without waiting for initialize", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Authentication successful! Caching credentials...\n");
    await expect(result).resolves.toEqual({ ok: true });
  });

  it("reports a distinct missing-npx error", async () => {
    const err = Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
    await expect(authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => { throw err; },
    })).resolves.toMatchObject({ ok: false, kind: "npx-missing" });
  });

  it("reports a closed-browser cancel from process output", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Authorization cancelled by the user\n");
    proc.emit("exit", 1, null);
    await expect(result).resolves.toMatchObject({ ok: false, kind: "cancelled" });
  });

  it("times out with a readable message instead of spinning", async () => {
    const proc = new FakeProc();
    await expect(authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 20,
      spawn: () => proc as never,
    })).resolves.toMatchObject({ ok: false, kind: "timeout" });
    expect(proc.killed).toBe(true);
  });

  // The retry that used to live here is GONE, and its absence is the fix.
  // mcp-remote pins the callback port from its OAuth registration; handing it a
  // different one means "delete client_info.json and re-register", which forces
  // a fresh consent screen AND invalidates the registration every other host on
  // this machine shares through ~/.mcp-auth. A conflict means the connector is
  // already signed in and running elsewhere, so exactly one spawn happens and
  // the result says so.
  it("never respawns on a port conflict — one spawn, and it reports it", async () => {
    const proc = new FakeProc();
    const spawns: string[][] = [];
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: (_c, args) => { spawns.push([...args]); return proc as never; },
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:22227\n");
    await expect(result).resolves.toMatchObject({ ok: false, kind: "port-conflict" });
    expect(spawns).toHaveLength(1);
    // and no callback port was appended, so the registration is untouched
    expect(spawns[0]).toEqual(["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"]);
  });

  it("surfaces a port-conflict without retry when no port probe is injected", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:22227\n");
    await expect(result).resolves.toEqual({
      ok: false,
      kind: "port-conflict",
      message: connectFailureMessage("port-conflict"),
    });
    expect(proc.killed).toBe(true);
  });

  it("does not retry when the port probe returns an unusable port", async () => {
    const proc = new FakeProc();
    let calls = 0;
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      pickFreeListenPort: async () => 0,
      spawn: () => {
        calls += 1;
        return proc as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Error: listen EADDRINUSE: address already in use :::22227\n");
    await expect(result).resolves.toMatchObject({ ok: false, kind: "port-conflict" });
    expect(calls).toBe(1);
  });

  it("does not retry when the port probe fails", async () => {
    const proc = new FakeProc();
    let calls = 0;
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      pickFreeListenPort: async () => { throw new Error("no port"); },
      spawn: () => {
        calls += 1;
        return proc as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Error: listen EADDRINUSE: address already in use :::22227\n");
    await expect(result).resolves.toMatchObject({ ok: false, kind: "port-conflict" });
    expect(calls).toBe(1);
  });

  it("classifies GitHub's DCR fallback after a rejected key as key-rejected", async () => {
    const proc = new FakeProc();
    const secret = "ghp_TESTSECRET_do_not_store";
    let spawned: { args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const result = authorizeMcpRemote({
      command: "npx",
      args: mcpRemoteArgs("https://api.githubcopilot.com/mcp/", undefined, undefined, { authorization: true }),
      env: { [MCP_REMOTE_AUTH_HEADER_ENV]: `Bearer ${secret}` },
      auth: "key",
      timeoutMs: 1_000,
      spawn: (_command, args, opts) => {
        spawned = { args: [...args], env: opts.env };
        return proc as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Connection error: Incompatible auth server: does not support dynamic client registration\n");
    await expect(result).resolves.toEqual({
      ok: false,
      kind: "key-rejected",
      message: connectFailureMessage("key-rejected"),
    });
    expect(spawned?.args).toContain(MCP_REMOTE_HEADER_FLAG);
    expect(spawned?.args).toContain(MCP_REMOTE_AUTH_HEADER_TEMPLATE);
    expect(spawned?.args.join(" ")).not.toContain(secret);
    expect(spawned?.env?.[MCP_REMOTE_AUTH_HEADER_ENV]).toBe(`Bearer ${secret}`);
    expect(proc.killed).toBe(true);
  });

  it("classifies a DCR client-metadata rejection as oauth-incompatible, not a stack", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.stripe.com"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write(`Connection error: InvalidClientMetadataError: Not supported: openid, email, profile
    at async auth (file:///C:/Users/foo/chunk-65X3S4HB.js:18536:12)
    at async StreamableHTTPClientTransport.send (file:///C:/Users/foo/chunk.js:99:5)\n`);
    await expect(result).resolves.toEqual({
      ok: false,
      kind: "oauth-incompatible",
      message: connectFailureMessage("oauth-incompatible"),
    });
    expect(proc.killed).toBe(true);
  });

  it("does not quote a spaced metadata path when the spawn is not a shell", async () => {
    const proc = new FakeProc();
    let spawned: string[] | undefined;
    const result = authorizeMcpRemote({
      command: "npx",
      args: SPACED_MCP_ARGV,
      shell: false,
      timeoutMs: 1_000,
      spawn: (_command, args) => {
        spawned = [...args];
        return proc as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(spawned).toEqual(SPACED_MCP_ARGV);
    proc.stderr.write("Authentication successful! Caching credentials...\n");
    await expect(result).resolves.toEqual({ ok: true });
  });
});

describe("OAuth client metadata files", () => {
  it("writes compact scope JSON to a temp file and disposes the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-mcp-oauth-test-"));
    const written = writeOAuthClientMetadataFile("mcp", { tmpRoot: root });
    expect(readFileSync(written.path, "utf8")).toBe('{"scope":"mcp"}');
    expect(written.path.endsWith("oauth-client-metadata.json")).toBe(true);
    written.dispose();
    expect(existsSync(written.path)).toBe(false);
  });

  it("persists metadata only for connected connectors that declare a scope", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-mcp-oauth-persist-"));
    const paths = persistConnectorOAuthClientMetadata({
      stripe: { endpoint: "https://mcp.stripe.com" },
      linear: { endpoint: "https://mcp.linear.app/mcp" },
      calendly: { endpoint: "https://mcp.calendly.com" },
      airtable: { endpoint: "https://mcp.airtable.com/mcp" },
      github: { endpoint: "https://api.githubcopilot.com/mcp/" },
    }, { root });
    expect(Object.keys(paths)).toEqual(["stripe"]);
    expect(readFileSync(paths.stripe, "utf8")).toBe('{"scope":"mcp"}');
    expect(existsSync(join(root, "linear.json"))).toBe(false);
    expect(existsSync(join(root, "calendly.json"))).toBe(false);
    expect(existsSync(join(root, "airtable.json"))).toBe(false);
    expect(existsSync(join(root, "github.json"))).toBe(false);
  });
});

class SharedStateFs implements StateFs {
  files = new Map<string, string>();
  private nextMtime = 1;
  private mtimes = new Map<string, number>();

  existsSync(p: string): boolean {
    return this.files.has(p);
  }
  readFileSync(p: string): string {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }
  statSync(p: string): { size: number; mtimeMs: number } {
    const data = this.files.get(p);
    if (data === undefined) throw new Error(`ENOENT: ${p}`);
    return { size: Buffer.byteLength(data), mtimeMs: this.mtimes.get(p) ?? 0 };
  }
  writeFileSync(p: string, data: string, opts?: { encoding: "utf8"; flag?: string }): void {
    if (opts?.flag === "wx" && this.files.has(p)) {
      const error = new Error(`EEXIST: ${p}`) as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    }
    this.files.set(p, data);
    this.mtimes.set(p, this.nextMtime++);
  }
  renameSync(from: string, to: string): void {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.mtimes.delete(from);
    this.writeFileSync(to, v);
  }
  mkdirSync(): void { /* */ }
}

class MemoryMemento implements MementoLike {
  store = new Map<string, unknown>();
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): PromiseLike<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

const GITHUB_ENDPOINT = "https://api.githubcopilot.com/mcp/";
const PAT_A = "ghp_HOST_A_TOKEN_do_not_store";
const PAT_B = "ghp_HOST_B_TOKEN_do_not_store";
const PAT_B_NEXT = "ghp_HOST_B_REPLACED_do_not_store";
const GITHUB_SECRET = mcpConnectorSecretKey("github");

type SidebarHost = {
  mcpConnectorKeys: Map<string, string>;
  context: { secrets: { get: (k: string) => Promise<string | undefined>; store: (k: string, v: string) => Promise<void>; delete: (k: string) => Promise<void> } };
  state: PersistedState;
  host: { appendLine: ReturnType<typeof vi.fn> };
  post: ReturnType<typeof vi.fn>;
  settingsEditor: undefined;
  reservedMcpIdentityFor: () => { names: string[]; urls: string[] };
};

function makeKeyHost(secrets: Map<string, string>, state: PersistedState): SidebarHost {
  const host = Object.create(GrokSidebar.prototype) as SidebarHost;
  host.mcpConnectorKeys = new Map();
  host.context = {
    secrets: {
      get: async (k) => secrets.get(k),
      store: async (k, v) => { secrets.set(k, v); },
      delete: async (k) => { secrets.delete(k); },
    },
  };
  host.state = state;
  host.host = { appendLine: vi.fn() };
  host.post = vi.fn();
  host.settingsEditor = undefined;
  host.reservedMcpIdentityFor = () => ({ names: [], urls: [] });
  return host;
}

function githubAuth(servers: Array<{ name: string; env?: Array<{ name: string; value: string }> }>): string | undefined {
  const github = servers.find((s) => s.name === "github");
  return github?.env?.find((e) => e.name === MCP_REMOTE_AUTH_HEADER_ENV)?.value;
}

const proto = GrokSidebar.prototype as unknown as {
  loadMcpConnectorKeys(): Promise<void>;
  hostMcpServersFor(session: { provider: string }): unknown;
  connectedConnectorStore(): Record<string, { endpoint: string }>;
};

describe("key cache across hosts sharing grok.mcpConnectors", () => {
  const DIR = "/home/.grok/client-state";
  const diskFile = `${DIR}/${DISK_KEYS[MCP_CONNECTORS_KEY]}`;

  function twoHosts() {
    const fs = new SharedStateFs();
    const stateA = new PersistedState(new MemoryMemento(), DIR, fs);
    const stateB = new PersistedState(new MemoryMemento(), DIR, fs);
    const secretsA = new Map<string, string>();
    const secretsB = new Map<string, string>();
    const a = makeKeyHost(secretsA, stateA);
    const b = makeKeyHost(secretsB, stateB);
    return { fs, stateA, stateB, secretsA, secretsB, a, b };
  }

  it("connecting GitHub in one host is picked up by the other without a restart, and the secret stays put", async () => {
    const { fs, stateA, secretsA, secretsB, a, b } = twoHosts();
    await proto.loadMcpConnectorKeys.call(a);
    await proto.loadMcpConnectorKeys.call(b);
    expect(await proto.hostMcpServersFor.call(b, { provider: "grok" })).toEqual([]);

    secretsA.set(GITHUB_SECRET, PAT_A);
    a.mcpConnectorKeys.set("github", PAT_A);
    await stateA.update(MCP_CONNECTORS_KEY, connectConnector({}, "github", GITHUB_ENDPOINT));
    await stateA.flush();

    secretsB.set(GITHUB_SECRET, PAT_B);
    const servers = await proto.hostMcpServersFor.call(b, { provider: "grok" }) as Array<{ name: string; env?: Array<{ name: string; value: string }>; args?: string[] }>;
    expect(githubAuth(servers)).toBe(`Bearer ${PAT_B}`);
    expect(JSON.stringify(servers)).not.toContain(PAT_A);
    expect(secretsB.get(GITHUB_SECRET)).toBe(PAT_B);
    expect(secretsA.get(GITHUB_SECRET)).toBe(PAT_A);
    expect(fs.files.get(diskFile)).not.toContain(PAT_A);
    expect(fs.files.get(diskFile)).not.toContain(PAT_B);
    expect(JSON.parse(fs.files.get(diskFile)!)).toEqual({ github: { endpoint: GITHUB_ENDPOINT } });
  });

  it("replacing a token on this host is what a later session/new sends, not the boot snapshot", async () => {
    const { secretsB, stateA, b } = twoHosts();
    secretsB.set(GITHUB_SECRET, PAT_B);
    await proto.loadMcpConnectorKeys.call(b);
    await stateA.update(MCP_CONNECTORS_KEY, connectConnector({}, "github", GITHUB_ENDPOINT));
    await stateA.flush();
    expect(githubAuth(await proto.hostMcpServersFor.call(b, { provider: "grok" }) as never)).toBe(`Bearer ${PAT_B}`);

    secretsB.set(GITHUB_SECRET, PAT_B_NEXT);
    const servers = await proto.hostMcpServersFor.call(b, { provider: "grok" }) as Array<{ name: string; env?: Array<{ name: string; value: string }> }>;
    expect(githubAuth(servers)).toBe(`Bearer ${PAT_B_NEXT}`);
    expect(JSON.stringify(servers)).not.toContain(PAT_B);
  });

  it("a host with no key still omits GitHub and does not delete the shared record", async () => {
    const { fs, stateA, secretsB, a, b } = twoHosts();
    secretsB.set(GITHUB_SECRET, PAT_B);
    await proto.loadMcpConnectorKeys.call(a);
    await proto.loadMcpConnectorKeys.call(b);
    await stateA.update(MCP_CONNECTORS_KEY, connectConnector({}, "github", GITHUB_ENDPOINT));
    await stateA.flush();

    const none = makeKeyHost(new Map(), a.state);
    await proto.loadMcpConnectorKeys.call(none);
    const servers = await proto.hostMcpServersFor.call(none, { provider: "grok" });
    expect(servers).toEqual([]);
    expect(proto.connectedConnectorStore.call(none)).toEqual({ github: { endpoint: GITHUB_ENDPOINT } });
    expect(fs.files.get(diskFile)).toContain("github");
    expect(JSON.parse(fs.files.get(diskFile)!)).toEqual({ github: { endpoint: GITHUB_ENDPOINT } });
    expect(secretsB.get(GITHUB_SECRET)).toBe(PAT_B);
  });
});


describe("mcp-remote version pin", () => {
  // A floating spec resolves at spawn time, and mcp-remote namespaces its OAuth
  // cache by its own version — so an upstream publish silently empties every
  // credential on the machine and re-runs OAuth for every connected service.
  // Measured 2026-08-22: six version directories under ~/.mcp-auth, the newest
  // holding ~60 abandoned code_verifier files and zero tokens. It is also what
  // keeps the desktop app and the editor hosts in ONE token directory.
  it("pins an exact version rather than floating on latest", () => {
    expect(MCP_REMOTE_PACKAGE).toMatch(/^mcp-remote@\d+\.\d+\.\d+$/);
  });

  it("puts the pinned spec on the wire, so npx cannot resolve something else", () => {
    const args = mcpRemoteArgs("https://mcp.linear.app/mcp");
    expect(args[0]).toBe("-y");
    expect(args[1]).toBe(MCP_REMOTE_PACKAGE);
    expect(args[1]).toContain("@");
    expect(args[2]).toBe("https://mcp.linear.app/mcp");
  });

  it("still finds the package when rebuilding args with a callback port", () => {
    const rebuilt = withMcpRemoteCallbackPort(mcpRemoteArgs("https://mcp.linear.app/mcp"), 22227);
    expect(rebuilt).toEqual(["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp", "22227"]);
  });
});

describe("connectorsLackingOAuthToken — never re-prompt a connector we cannot refresh (#owner 2026-08-30)", () => {
  const LINEAR = "https://mcp.linear.app/mcp";
  const NOTION = "https://mcp.notion.com/mcp";
  const store = { linear: { endpoint: LINEAR }, notion: { endpoint: NOTION } } as never;

  function fakeFs(dirs: { name: string; mtimeMs: number }[], files: string[]) {
    const set = new Set(files);
    return { versionDirs: () => dirs, hasFile: (p: string) => set.has(p) };
  }

  it("names the one directory the proxy reads, and nothing else", () => {
    // Never by mtime: a token REFRESH rewrites the file without touching the
    // parent's mtime, so an abandoned directory can stay "newest" for ever.
    expect(mcpRemoteStoreDir([
      { name: "mcp-remote-0.2.5" },
      { name: "mcp-remote-0.1.36" },
      { name: "not-ours" },
    ])).toBe("mcp-remote-0.1.36");
    // Absent -> undefined, which the caller must treat as "cannot tell".
    expect(mcpRemoteStoreDir([{ name: "mcp-remote-0.2.5" }])).toBeUndefined();
    expect(mcpRemoteStoreDir([])).toBeUndefined();
  });

  it("does not let an abandoned directory's token prove anything", () => {
    // The proxy reads ONE directory, derived from its own embedded version, and
    // never looks at siblings. A token in 0.2.9 is unreachable to a proxy
    // reading 0.1.36 — so accepting it would pass the connector through and let
    // it open a browser anyway, which is the thing this exists to prevent.
    const root = join("/home/dev", ".mcp-auth");
    const lapsed = connectorsLackingOAuthToken({
      store,
      home: "/home/dev",
      env: {},
      fs: fakeFs(
        [{ name: "mcp-remote-0.1.36", mtimeMs: 10 }, { name: "mcp-remote-0.2.9", mtimeMs: 9000 }],
        [
          join(root, "mcp-remote-0.2.9", `${mcpServerUrlHash(LINEAR)}_tokens.json`),
          join(root, "mcp-remote-0.1.36", `${mcpServerUrlHash(NOTION)}_tokens.json`),
        ],
      ),
    });
    expect([...lapsed]).toEqual(["linear"]);
  });

  it("fails open when the directory the proxy reads is not there at all", () => {
    // A changed pin, an unfamiliar layout: withholding everything would break
    // every connector on a machine we simply do not recognise.
    const root = join("/home/dev", ".mcp-auth");
    expect([...connectorsLackingOAuthToken({
      store,
      home: "/home/dev",
      env: {},
      fs: fakeFs([{ name: "mcp-remote-9.9.9", mtimeMs: 1 }],
        [join(root, "mcp-remote-9.9.9", `${mcpServerUrlHash(LINEAR)}_tokens.json`)]),
    })]).toEqual([]);
  });

  it("hashes an endpoint the way the real store does", () => {
    // Measured: this is the directory name mcp-remote actually used for Linear.
    expect(mcpServerUrlHash(LINEAR)).toBe("fcc436b0d1e0a1ed9a2b15bbd638eb13");
  });

  it("names only the connector whose token file is gone", () => {
    const root = join("/home/dev", ".mcp-auth", "mcp-remote-0.1.36");
    const lapsed = connectorsLackingOAuthToken({
      store,
      home: "/home/dev",
      env: {},
      fs: fakeFs(
        [{ name: "mcp-remote-0.1.36", mtimeMs: 1 }],
        [join(root, `${mcpServerUrlHash(NOTION)}_tokens.json`)],
      ),
    });
    // Withheld only because there is no token for it in ANY version directory.
    expect([...lapsed]).toEqual(["linear"]);
  });

  it("does not care that a token has EXPIRED — only that it is absent", () => {
    // These live 1-24 hours and carry a refresh_token mcp-remote uses silently.
    // Treating expiry as failure would disconnect connectors that work.
    const root = join("/home/dev", ".mcp-auth", "mcp-remote-0.1.36");
    const lapsed = connectorsLackingOAuthToken({
      store,
      home: "/home/dev",
      env: {},
      fs: fakeFs(
        [{ name: "mcp-remote-0.1.36", mtimeMs: 1 }],
        [
          join(root, `${mcpServerUrlHash(LINEAR)}_tokens.json`),
          join(root, `${mcpServerUrlHash(NOTION)}_tokens.json`),
        ],
      ),
    });
    expect([...lapsed]).toEqual([]);
  });

  it("fails OPEN when it cannot tell", () => {
    // No store directory at all: withholding everything would break every
    // connector on a machine whose layout we simply do not recognise.
    expect([...connectorsLackingOAuthToken({
      store, home: "/home/dev", env: {}, fs: fakeFs([], []),
    })]).toEqual([]);
    expect([...connectorsLackingOAuthToken({
      store,
      home: "/home/dev",
      env: {},
      fs: { versionDirs: () => { throw new Error("EACCES"); }, hasFile: () => false },
    })]).toEqual([]);
  });

  it("honours MCP_REMOTE_CONFIG_DIR as the BASE, with the version segment still appended", () => {
    const base = "/custom/store";
    const root = join(base, "mcp-remote-0.1.36");
    expect([...connectorsLackingOAuthToken({
      store,
      home: "/home/dev",
      env: { MCP_REMOTE_CONFIG_DIR: base },
      fs: fakeFs(
        [{ name: "mcp-remote-0.1.36", mtimeMs: 1 }],
        [join(root, `${mcpServerUrlHash(LINEAR)}_tokens.json`)],
      ),
    })]).toEqual(["notion"]);
  });
});
