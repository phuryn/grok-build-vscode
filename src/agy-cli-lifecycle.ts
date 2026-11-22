import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { agyInstallDir, locateAgyCli } from "./agy-backend";
import { extractTarFile } from "./codex-managed-installer";
import { extensionWasUpgraded } from "./cli-locator";

export const AGY_INSTALL_TIMEOUT_MS = 180_000;
export const AGY_UPDATE_TIMEOUT_MS = 20_000;
const AGY_SETUP_TIMEOUT_MS = 60_000;

/** Google's own release server, the one its install.ps1 and install.sh read. */
export const AGY_RELEASE_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";

/** The build name Google's installers ask for: OS, CPU, and on Linux the C library. */
export function agyBuildName(platform: NodeJS.Platform, arch: string, musl = false): string | undefined {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!cpu) return undefined;
  if (platform === "win32") return `windows_${cpu}`;
  if (platform === "darwin") return `darwin_${cpu}`;
  if (platform === "linux") return `linux_${cpu}${musl ? "_musl" : ""}`;
  return undefined;
}

function isMuslLinux(): boolean {
  return fs.existsSync("/lib/libc.musl-x86_64.so.1") || fs.existsSync("/lib/libc.musl-aarch64.so.1");
}

export type AgyDownloadOptions = {
  signal: AbortSignal;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  musl?: boolean;
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
};

/**
 * What Google's install scripts do, done in Node: read the build's manifest,
 * download it, check its SHA-512, and put the binary where the scripts put it.
 * The extension spawns no shell to fetch and run a remote script.
 */
export async function downloadAgyCli(options: AgyDownloadOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const build = agyBuildName(platform, arch, platform === "linux" && (options.musl ?? isMuslLinux()));
  if (!build) throw new Error(`Antigravity's CLI has no build for ${platform} ${arch}.`);
  const fetchFn = options.fetchFn ?? fetch;
  const { signal } = options;
  const listed = await fetchFn(`${AGY_RELEASE_BASE}/manifests/${build}.json`, { signal });
  if (!listed.ok) throw new Error(`Could not read the Antigravity CLI release manifest (HTTP ${listed.status}).`);
  const manifest = await listed.json() as { version?: unknown; url?: unknown; sha512?: unknown };
  const url = typeof manifest.url === "string" ? manifest.url : "";
  const sha512 = typeof manifest.sha512 === "string" ? manifest.sha512.toLowerCase() : "";
  if (!/^https:\/\//i.test(url) || !/^[0-9a-f]{128}$/.test(sha512)) throw new Error("The Antigravity CLI release manifest is incomplete.");
  options.log?.(`Downloading the Antigravity CLI ${typeof manifest.version === "string" ? manifest.version : ""} for ${build}.`);

  const dir = agyInstallDir(options.env ?? process.env, platform, options.home ?? os.homedir());
  const binary = path.join(dir, platform === "win32" ? "agy.exe" : "agy");
  const staging = path.join(dir, `.agy-install-${randomUUID()}`);
  await fs.promises.mkdir(staging, { recursive: true });
  try {
    const download = path.join(staging, "download");
    const response = await fetchFn(url, { signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
    const hash = createHash("sha512");
    const tap = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as any), tap, fs.createWriteStream(download, { flags: "wx" }), { signal });
    if (hash.digest("hex") !== sha512) throw new Error("Checksum verification failed: the download does not match Google's manifest.");
    let payload = download;
    if (/\.tar\.gz(?:$|[?#])/i.test(url)) {
      const tar = path.join(staging, "download.tar");
      await pipeline(fs.createReadStream(download), createGunzip(), fs.createWriteStream(tar, { flags: "wx" }), { signal });
      const files = await extractTarFile(tar, path.join(staging, "x"), platform, signal);
      payload = files.find(file => path.basename(file) === "antigravity") ?? "";
      if (!payload) throw new Error("The Antigravity CLI archive holds no antigravity binary.");
    }
    signal.throwIfAborted();
    // Staging sits in the install folder, so this is one rename: the binary
    // appears whole or not at all, and a symlink already at that name is
    // replaced rather than written through.
    if (platform !== "win32") await fs.promises.chmod(payload, 0o755);
    await fs.promises.rename(payload, binary);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  return binary;
}

type CommandOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  spawnChild?: typeof spawn;
  killGroup?: typeof process.kill;
};

export async function runAgyCommand(file: string, args: string[], options: CommandOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const spawnChild = options.spawnChild ?? spawn;
  const windows = (options.platform ?? process.platform) === "win32";
  return new Promise((resolve, reject) => {
    const child = spawnChild(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows });
    let output = "";
    let stopped: Error | undefined;
    let stopping: Promise<void> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const collect = (chunk: Buffer) => {
      const value = chunk.toString();
      output = (output + value).slice(-4096);
      if (value.trim()) options.log?.(value.trimEnd());
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const stop = (error: Error) => {
      if (stopped) return;
      stopped = error;
      stopTimer = setTimeout(() => {
        child.kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(error);
      }, 3_000);
      const pid = child.pid;
      if (!pid) return;
      if (windows) {
        stopping = new Promise<void>((done) => {
          const killer = spawnChild(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          const finish = (code: number | null) => { if (code !== 0) child.kill(); done(); };
          killer.once("error", () => finish(null));
          killer.once("exit", finish);
        });
      } else {
        try { (options.killGroup ?? process.kill)(-pid, "SIGKILL"); } catch { child.kill(); }
      }
    };
    const abort = () => stop(new Error("Installation cancelled."));
    const timer = setTimeout(() => stop(new Error(`Timed out after ${options.timeoutMs / 1000} seconds.`)), options.timeoutMs);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      options.signal?.removeEventListener("abort", abort);
      if (stopped || error) reject(stopped ?? error);
      else resolve(output);
    };
    const finish = async (error?: Error) => {
      await stopping;
      settle(error);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => void finish(error));
    child.once("close", (code) => void finish(code === 0 ? undefined : new Error(`Process exited (${code ?? "signal"}).`)));
    if (options.signal?.aborted) abort();
  });
}

export async function readAgyCliVersion(binary: string, options: Pick<CommandOptions, "signal" | "platform" | "spawnChild" | "killGroup"> = {}): Promise<string> {
  const output = await runAgyCommand(binary, ["--version"], { ...options, timeoutMs: 5_000 });
  const version = /\b\d+\.\d+\.\d+(?:[-+][\w.+-]+)?\b/.exec(output)?.[0];
  if (!version) throw new Error("agy --version did not report a version.");
  return version;
}

export async function installAgyCli(options: Omit<CommandOptions, "timeoutMs"> & {
  locate?: () => string | undefined;
  download?: (signal: AbortSignal) => Promise<string>;
  beforeVersion?: (binary: string) => Promise<void>;
}): Promise<{ binary: string; version: string }> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`Timed out after ${AGY_INSTALL_TIMEOUT_MS / 1000} seconds.`)), AGY_INSTALL_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  let installError: unknown;
  try {
    const downloaded = await (options.download ?? ((s) => downloadAgyCli({ signal: s, platform: options.platform, log: options.log })))(signal);
    // The scripts end with `agy install`, which sets up PATH; its failure is
    // absorbed there (`|| true`) and here, since the binary already works.
    try {
      await runAgyCommand(downloaded, ["install"], { ...options, signal, timeoutMs: AGY_SETUP_TIMEOUT_MS });
    } catch (error) {
      options.signal?.throwIfAborted();
      options.log?.(`agy install did not finish setup: ${String(error)}`);
    }
  } catch (error) {
    installError = error;
  } finally {
    clearTimeout(timer);
  }
  options.signal?.throwIfAborted();
  const binary = (options.locate ?? locateAgyCli)();
  if (!binary) throw installError ?? new Error("The installer finished but agy was not found.");
  await options.beforeVersion?.(binary);
  return { binary, version: await readAgyCliVersion(binary, options) };
}

export async function updateAgyCliOnUpgrade(binary: string, current: string, last: string | undefined,
  remember: (version: string) => PromiseLike<void>, log: (line: string) => void,
  { run = runAgyCommand, signal }: { run?: typeof runAgyCommand; signal?: AbortSignal } = {}): Promise<void> {
  if (!current || current === last) return;
  try {
    if (extensionWasUpgraded(last, current)) {
      log(`[agy] AFK upgraded to ${current}; running agy update.`);
      await run(binary, ["update"], { timeoutMs: AGY_UPDATE_TIMEOUT_MS, log, ...(signal ? { signal } : {}) });
    }
  } catch (error) {
    log(`[agy] Update failed; continuing with the installed CLI: ${String(error)}`);
  } finally {
    try { await remember(current); }
    catch (error) { log(`[agy] Could not save the update version: ${String(error)}`); }
  }
}
