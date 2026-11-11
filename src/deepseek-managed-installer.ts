import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { downloadCodexAsset, extractTarFile, type CodexDownload, type DownloadProgress } from "./codex-managed-installer";
import { extractZipFile } from "./agy-managed-installer";

export const DEEPSEEK_VERSION = "0.2.1-rc.5";
export const DEEPSEEK_NODE_VERSION = "22.23.4";
/** The pinned tree's npm lock, as shipped in resources/deepseek. */
export const DEEPSEEK_SHIPPED_LOCK = "runtime-lock.json";
export function deepseekManagedDir(storageRoot: string): string {
  return path.join(storageRoot, "deepseek-managed", `${DEEPSEEK_VERSION}-node-${DEEPSEEK_NODE_VERSION}`);
}
/** A configured path names this same installation layout, never a PATH shim. */
export function deepseekRuntimePaths(root: string, platform: NodeJS.Platform = process.platform) {
  return { node: path.join(root, "node", platform === "win32" ? "node.exe" : "bin/node"),
    npm: path.join(root, "node", platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js"),
    cli: path.join(root, "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js") };
}
export function deepseekRuntimeVersion(root: string): string | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(root, "runtime/node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version; }
  catch { return undefined; }
}
export function locateDeepSeek(options: { configuredPath?: string; storageRoot?: string; platform?: NodeJS.Platform; isFile?: (file: string) => boolean; readVersion?: typeof deepseekRuntimeVersion } = {}): string | undefined {
  const root = options.configuredPath?.trim() || (options.storageRoot ? deepseekManagedDir(options.storageRoot) : undefined);
  if (!root) return undefined;
  const isFile = options.isFile ?? ((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  const files = deepseekRuntimePaths(root, options.platform);
  return isFile(files.node) && isFile(files.cli) && isFile(path.join(root, "runtime/package-lock.json"))
    && (options.readVersion ?? deepseekRuntimeVersion)(root) === DEEPSEEK_VERSION ? root : undefined;
}
export function deepseekNodeAsset(platform: NodeJS.Platform, arch: string) {
  if (!["win32", "darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(arch)) throw new Error(`DeepSeek installation is unavailable for ${platform}/${arch}.`);
  const stem = `node-v${DEEPSEEK_NODE_VERSION}-${platform === "win32" ? "win" : platform}-${arch}`;
  const file = `${stem}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/v${DEEPSEEK_NODE_VERSION}`;
  return { stem, file, url: `${base}/${file}`, checksums: `${base}/SHASUMS256.txt` };
}
export function nodeChecksum(text: string, file: string): string {
  const matches = text.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)).filter((v) => v?.[2] === file);
  if (matches.length !== 1) throw new Error("Official Node checksums do not uniquely identify the pinned archive.");
  return matches[0]![1];
}

async function npmCi(root: string, signal: AbortSignal): Promise<void> {
  const files = deepseekRuntimePaths(root);
  const userConfig = path.join(root, ".npmrc-user");
  const globalConfig = path.join(root, ".npmrc-global");
  await fs.promises.writeFile(userConfig, "");
  await fs.promises.writeFile(globalConfig, "");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|npm_config_.*)$/i.test(key)) delete env[key];
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = `${path.dirname(files.node)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  // Explicit npm CLI: neither global npm nor Electron can select the ABI.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(files.node, [files.npm, "ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts=false", `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, "--registry=https://registry.npmjs.org/"],
      { cwd: path.join(root, "runtime"), env, windowsHide: true, stdio: "ignore", detached: process.platform !== "win32" });
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill());
        killer.once("exit", code => { if (code !== 0) child.kill(); });
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
    };
    const finish = (error?: Error) => { clearTimeout(timer); signal.removeEventListener("abort", stop); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { stop(); }, 10 * 60_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", finish);
    child.once("exit", (code) => finish(code === 0 && !signal.aborted ? undefined : new Error(`DeepSeek dependency installation failed (${signal.aborted ? "cancelled" : code}).`)));
  });
}

export async function installManagedDeepSeek(options: {
  storageRoot: string; assets?: string; signal: AbortSignal; platform?: NodeJS.Platform; arch?: string;
  download?: CodexDownload; runNpm?: typeof npmCi;
  onProgress?: (phase: "downloading" | "verifying" | "installing", value?: DownloadProgress) => void;
}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const asset = deepseekNodeAsset(platform, options.arch ?? process.arch);
  const final = deepseekManagedDir(options.storageRoot);
  if (locateDeepSeek({ configuredPath: final, platform })) return final;
  const parent = path.dirname(final);
  await fs.promises.mkdir(parent, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(parent, ".install-"));
  const archive = path.join(stage, asset.file);
  const sums = path.join(stage, "SHASUMS256.txt");
  const download = options.download ?? downloadCodexAsset;
  try {
    options.onProgress?.("downloading", { receivedBytes: 0 });
    await download(asset.checksums, sums, options.signal, () => {});
    const expected = nodeChecksum(await fs.promises.readFile(sums, "utf8"), asset.file);
    const actual = await download(asset.url, archive, options.signal, (p) => options.onProgress?.("downloading", p));
    options.onProgress?.("verifying");
    if (actual !== expected) throw new Error("Downloaded Node archive failed SHA-256 verification.");
    options.signal.throwIfAborted();
    options.onProgress?.("installing");
    if (platform === "win32") await extractZipFile(archive, stage, options.signal);
    else {
      const tar = path.join(stage, "node.tar");
      await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(tar, { flags: "wx" }), { signal: options.signal });
      await extractTarFile(tar, stage, platform);
      await fs.promises.unlink(tar);
    }
    await fs.promises.rename(path.join(stage, asset.stem), path.join(stage, "node"));
    if (platform !== "win32") {
      // The shared tar extractor skips symlinks, including Node's npm/npx links.
      // Lifecycle scripts must resolve these to this runtime too.
      for (const command of ["npm", "npx"]) await fs.promises.writeFile(path.join(stage, "node/bin", command),
        '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../lib/node_modules/npm/bin/' + command + '-cli.js" "$@"\n', { mode: 0o755 });
    }
    await fs.promises.mkdir(path.join(stage, "runtime"));
    const assets = options.assets ?? path.join(__dirname, "../resources/deepseek");
    // The lock ships as runtime-lock.json: electron-builder leaves every
    // package-lock.json out of app.asar, so under its real name the desktop
    // app (and so every cloud machine) had no lock to install from.
    await fs.promises.copyFile(path.join(assets, "package.json"), path.join(stage, "runtime", "package.json"));
    await fs.promises.copyFile(path.join(assets, DEEPSEEK_SHIPPED_LOCK), path.join(stage, "runtime", "package-lock.json"));
    await (options.runNpm ?? npmCi)(stage, options.signal);
    options.signal.throwIfAborted();
    if (!locateDeepSeek({ configuredPath: stage, platform })) throw new Error("DeepSeek installation is incomplete.");
    await fs.promises.unlink(archive);
    await fs.promises.unlink(sums);
    // Failed installs never displace a working pin. No fallback to older trees.
    await fs.promises.rename(stage, final);
    return final;
  } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
}
