#!/usr/bin/env node
// Long-lived REAL host participant for the cross-repo lifecycle e2e.
//
// Part 2 (the relay repo) spawns this as a child and drives everything else
// through a real browser against a real relay. This process is a participant:
// boot the shipped desktop host, wait until the relay admits this host,
// print one ready line, then idle until told to stop. A restart is the
// orchestrator shutting us down and spawning us again with the same
// GROK_HOME + token.
//
//   npm --prefix <this repo> run e2e:lifecycle-host
//
// Environment (all required unless noted):
//   GROK_RELAY_URL              ws(s)://…  — already a development-only override
//   GROK_RELAY_DEVICE_TOKEN     linked-device token from the relay
//   GROK_HOME                   session store; STABLE across a restart
//   GROK_LIFECYCLE_WORKSPACES   one or more absolute project folders.
//                               `path.delimiter`-separated (`;` on Windows, `:`
//                               on POSIX). A JSON array is also accepted when
//                               the value trims to `[…`. Repo switching needs
//                               two distinct folders; one is enough to boot.
//   GROK_LIFECYCLE_READY_MS     optional ready timeout, default 60000
//   GROK_LIFECYCLE_SHUTDOWN_MS  optional Electron-exit wait, default 10000
//
// Ready line (stdout, once, greppable):
//   GROK_LIFECYCLE_HOST_READY
//
// Printed only after the relay admits this host. The local WebSocket `open`
// event is not enough — the relay upgrades first and may then reject (bad
// or revoked token, duplicate host / close 4002). The `clients` frame is
// the first post-admission signal we log (`[remote] relay clients:`).
//
// Shutdown (stdin, one line — the reliable path; SIGINT/SIGTERM remain as
// a fallback). After this token we kill Electron, wait for its actual
// exit, then exit ourselves:
//   GROK_LIFECYCLE_HOST_SHUTDOWN
//
// Bounded wait: GROK_LIFECYCLE_SHUTDOWN_MS, then a force kill, then a
// short extra wait. If Electron is still alive we exit 2 rather than hang
// or claim a restart that never happened. `npm run` owns this process and
// Electron is its grandchild; a signal to npm does not reliably reach us
// (POSIX grandchildren survive; Windows ChildProcess.kill is uncatchable).
//
// Why desktop, not @vscode/test-electron: the contract is "boot and idle
// until killed", which is Electron's natural shape. vscode-test is "run a
// suite and exit"; a never-finishing mocha test would also hang
// `npm run test:integration` if it ever landed in that glob. The shipped
// code path is `src/sidebar.ts` + `src/remote-uplink.ts` either way.
//
// Token injection cannot be a Node pre-seed of SecretStorage — desktop
// ciphertext is OS-keyed. The env token is honoured only by
// resolveInjectedDeviceToken (production + un-overridden URL ⇒ no token,
// no overlay, no uplink). A packaged build never accepts it. Desktop main
// consumes the env entry after capture so ACP children do not inherit it;
// this wrapper still forwards the variable into Electron so a restart
// (fresh process + same orchestrator env) can read it again.
//
// Fake ACP: grok.cliPath → test/fixtures/fake-grok-acp.{cmd,sh}. A configured
// path is never followed by a PATH search (locateGrokCli), so an installed
// grok cannot leak in. FAKE_UNIQUE_SESSION_IDS is set so two workspaces
// cannot share fake-session-1 (the host looks up by id before cwd).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const LIFECYCLE_HOST_READY_LINE = "GROK_LIFECYCLE_HOST_READY";
export const LIFECYCLE_HOST_SHUTDOWN_LINE = "GROK_LIFECYCLE_HOST_SHUTDOWN";
export const LIFECYCLE_HOST_SHUTDOWN_STUCK_CODE = 2;
export const LIFECYCLE_WORKSPACES_ENV = "GROK_LIFECYCLE_WORKSPACES";
export const FAKE_UNIQUE_SESSION_IDS_ENV = "FAKE_UNIQUE_SESSION_IDS";
/** First post-admission log line from RemoteUplink's `clients` frame. */
export const UPLINK_ADMITTED_NEEDLE = "[remote] relay clients:";
export const DEFAULT_SHUTDOWN_MS = 10_000;
export const DEFAULT_FORCE_WAIT_MS = 2_000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Parse GROK_LIFECYCLE_WORKSPACES: JSON array or OS-delimited paths. */
export function parseLifecycleWorkspaces(
  raw,
  delimiter = path.delimiter,
) {
  if (raw == null) return [];
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(
        `GROK_LIFECYCLE_WORKSPACES is not valid JSON: ${(e && e.message) || e}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("GROK_LIFECYCLE_WORKSPACES JSON must be an array of paths");
    }
    return parsed.map((p) => String(p).trim()).filter(Boolean);
  }
  return trimmed.split(delimiter).map((p) => p.trim()).filter(Boolean);
}

export function isLifecycleShutdownLine(line) {
  return String(line).trim() === LIFECYCLE_HOST_SHUTDOWN_LINE;
}

/** Env handed to Electron. Must keep the token — main consumes it. */
export function lifecycleChildEnv(envIn, { grokHome, userData }) {
  const env = { ...envIn };
  delete env.ELECTRON_RUN_AS_NODE;
  env.GROK_HOME = path.resolve(grokHome);
  env.NODE_ENV = "test";
  env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE = "1";
  env.GROK_DESKTOP_USER_DATA = userData;
  env[FAKE_UNIQUE_SESSION_IDS_ENV] = "1";
  return env;
}

export function createReadyScanner(needle, onReady) {
  let ready = false;
  let carry = "";
  return {
    get ready() {
      return ready;
    },
    push(text) {
      const combined = carry + String(text);
      if (!ready && combined.includes(needle)) {
        ready = true;
        onReady();
      }
      carry = combined.slice(-needle.length);
    },
  };
}

export function attachStdinShutdown(stdin, onShutdown) {
  if (!stdin || typeof stdin.on !== "function") return () => {};
  if (stdin.readableEnded || stdin.destroyed) return () => {};
  let rl;
  try {
    rl = createInterface({ input: stdin });
  } catch {
    return () => {};
  }
  const onLine = (line) => {
    if (isLifecycleShutdownLine(line)) onShutdown();
  };
  rl.on("line", onLine);
  return () => {
    rl.off("line", onLine);
    try {
      rl.close();
    } catch {
      /* already closed */
    }
  };
}

function requestSoftKill(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    const fallback = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    killer.once("error", fallback);
    killer.once("exit", code => { if (code !== 0) fallback(); });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

function requestHardKill(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    const fallback = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    killer.once("error", fallback);
    killer.once("exit", code => { if (code !== 0) fallback(); });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Ready/shutdown supervisor for an already-spawned host child.
 * Extracted so a grok-free test can prove the ready deadline dies on READY
 * (a leftover timer would kill an admitted host mid-run).
 */
export async function superviseLifecycleChild(child, opts = {}) {
  const readyMs = opts.readyMs ?? 60_000;
  const shutdownMs = opts.shutdownMs ?? DEFAULT_SHUTDOWN_MS;
  const stdin = opts.stdin ?? process.stdin;
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const relayUrl = opts.relayUrl ?? "";
  const redact = typeof opts.redactRelayUrl === "function" ? opts.redactRelayUrl : (u) => u;

  let ready = false;
  let finished = false;
  let shuttingDown = false;

  return await new Promise((resolve, reject) => {
    let detachStdin = () => {};
    let readyTimer;
    const done = (error, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(readyTimer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      detachStdin();
      if (error) reject(error);
      else resolve(code ?? 0);
    };
    const beginShutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      return await terminateAndWait(child, { timeoutMs: shutdownMs });
    };
    const scanner = createReadyScanner(UPLINK_ADMITTED_NEEDLE, () => {
      ready = true;
      // A leftover deadline would tear down an admitted host and dump a false
      // "relay did not admit this host" on top of a healthy run.
      clearTimeout(readyTimer);
      out.write(`${LIFECYCLE_HOST_READY_LINE}\n`);
    });
    const scan = (buf, stream) => {
      const text = buf.toString("utf8");
      stream.write(text);
      scanner.push(text);
    };
    if (child.stdout) child.stdout.on("data", (buf) => scan(buf, out));
    if (child.stderr) child.stderr.on("data", (buf) => scan(buf, err));
    readyTimer = setTimeout(() => {
      if (ready || finished || shuttingDown) return;
      void beginShutdown().then(() => {
        done(
          new Error(
            `relay did not admit this host within ${readyMs}ms ` +
              `(relay ${redact(relayUrl)})`,
          ),
        );
      });
    }, readyMs);
    const shutdown = () => {
      void beginShutdown().then((result) => {
        if (result?.timedOut) {
          done(undefined, LIFECYCLE_HOST_SHUTDOWN_STUCK_CODE);
          return;
        }
        if (!ready) {
          done(
            new Error(
              `host exited before relay admitted it (code ${result?.code}, signal ${result?.signal})`,
            ),
          );
          return;
        }
        done(undefined, 0);
      });
    };
    const onSignal = () => {
      shutdown();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    detachStdin = attachStdinShutdown(stdin, shutdown);
    child.once("error", (error) => done(error));
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      if (!ready) {
        done(
          new Error(
            `host exited before relay admitted it (code ${code}, signal ${signal})`,
          ),
        );
        return;
      }
      done(undefined, 0);
    });
  });
}

/** Kill the child and resolve only after it actually exits — or we give up. */
export function terminateAndWait(child, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_MS;
  const forceWaitMs = opts.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolve(result);
    };
    if (!child || child.exitCode != null || child.signalCode != null) {
      finish({
        timedOut: false,
        code: child?.exitCode ?? 0,
        signal: child?.signalCode ?? null,
      });
      return;
    }
    child.once("exit", (code, signal) => {
      finish({ timedOut: false, code, signal });
    });
    requestSoftKill(child);
    const softTimer = setTimeout(() => {
      requestHardKill(child);
    }, timeoutMs);
    const hardTimer = setTimeout(() => {
      finish({
        timedOut: true,
        code: child.exitCode,
        signal: child.signalCode,
      });
    }, timeoutMs + forceWaitMs);
  });
}

function resolveFakeCli() {
  const name = process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh";
  const cli = path.join(root, "test", "fixtures", name);
  if (!fs.existsSync(cli)) throw new Error(`fake ACP CLI missing: ${cli}`);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(cli, 0o755);
    } catch {
      /* best-effort */
    }
  }
  return cli;
}

function writeProfile(userData, workspaces, fakeCli) {
  fs.mkdirSync(userData, { recursive: true });
  const abs = workspaces.map((w) => path.resolve(w));
  const prefs = {
    workspaceRoot: abs[0],
    workspaceRoots: abs,
    discoverySeedCompleted: true,
    config: {
      "grok.cliPath": fakeCli,
      "grok.telemetry.enabled": false,
      "grok.remote.keepAwake": false,
    },
  };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(prefs, null, 2), "utf8");
  // The person pressed Connect for Grok. Since #171 nothing infers a
  // connection, so without this the host never starts the fake CLI and the
  // first turn never arrives. Same key as PROVIDER_CONNECTIONS_KEY in
  // src/sidebar.ts -- test/harness-consent-key.test.ts fails if they drift.
  fs.writeFileSync(
    path.join(userData, "globalState.json"),
    JSON.stringify({ "grok.providerConnections.v2": { grok: true } }, null, 2),
    "utf8",
  );
  const sessionOverrides = path.join(userData, "lifecycle-config.json");
  fs.writeFileSync(
    sessionOverrides,
    JSON.stringify({ "grok.cliPath": fakeCli, "grok.telemetry.enabled": false }, null, 2),
    "utf8",
  );
  return sessionOverrides;
}

function ensureSessionCatalogs(grokHome, workspaces) {
  for (const cwd of workspaces) {
    const dir = path.join(grokHome, "sessions", encodeURIComponent(path.resolve(cwd)));
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function runLifecycleHost(opts) {
  const envIn = opts.env ?? process.env;
  const framesPath = path.join(root, "out", "remote-frames.js");
  if (!fs.existsSync(framesPath)) {
    throw new Error(`Missing ${framesPath} — run \`npm run compile\` first`);
  }
  const {
    RELAY_URL_ENV,
    resolveInjectedDeviceToken,
    redactRelayUrl,
  } = require(framesPath);

  const token = resolveInjectedDeviceToken({ isProduction: false, env: envIn });
  if (!token) {
    throw new Error(
      "refusing to start: GROK_RELAY_DEVICE_TOKEN is not usable. " +
        "Need a development build, GROK_RELAY_URL overridden away from production, " +
        "and a non-empty token. A production build never accepts an injected token.",
    );
  }

  const grokHome = typeof envIn.GROK_HOME === "string" ? envIn.GROK_HOME.trim() : "";
  if (!grokHome) throw new Error("GROK_HOME is required and must be stable across a restart");
  fs.mkdirSync(grokHome, { recursive: true });

  const workspaces = parseLifecycleWorkspaces(envIn[LIFECYCLE_WORKSPACES_ENV]);
  if (!workspaces.length) {
    throw new Error(
      "GROK_LIFECYCLE_WORKSPACES is required (OS-delimited paths, or a JSON array). " +
        "Repo switching needs at least two distinct folders.",
    );
  }
  for (const cwd of workspaces) {
    let st;
    try {
      st = fs.statSync(cwd);
    } catch {
      throw new Error(`workspace does not exist: ${cwd}`);
    }
    if (!st.isDirectory()) throw new Error(`workspace is not a directory: ${cwd}`);
  }

  const mainJs = path.join(root, "out", "desktop", "main.js");
  if (!fs.existsSync(mainJs)) {
    throw new Error(`Missing ${mainJs} — run \`npm run compile\` first`);
  }
  const electronExe = path.join(
    root,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );
  if (!fs.existsSync(electronExe)) {
    throw new Error(`Missing Electron at ${electronExe}`);
  }

  const fakeCli = resolveFakeCli();
  const userData = path.join(path.resolve(grokHome), ".lifecycle-desktop-user-data");
  const configJson = writeProfile(userData, workspaces, fakeCli);
  ensureSessionCatalogs(path.resolve(grokHome), workspaces);

  const env = lifecycleChildEnv(envIn, { grokHome, userData });

  const child = spawn(
    electronExe,
    [
      mainJs,
      `--user-data-dir=${userData}`,
      `--config-json=${configJson}`,
      "--disable-gpu",
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  return await superviseLifecycleChild(child, {
    readyMs: Number(envIn.GROK_LIFECYCLE_READY_MS) || 60_000,
    shutdownMs: Number(envIn.GROK_LIFECYCLE_SHUTDOWN_MS) || DEFAULT_SHUTDOWN_MS,
    stdin: opts.stdin ?? process.stdin,
    relayUrl: envIn[RELAY_URL_ENV] || "",
    redactRelayUrl,
  });
}

function launchedDirectly() {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1] && path.resolve(process.argv[1]);
  return argv1 === self;
}

if (launchedDirectly()) {
  runLifecycleHost({ env: process.env })
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      process.stderr.write(`[lifecycle-host] ${e && e.message ? e.message : e}\n`);
      process.exit(1);
    });
}
