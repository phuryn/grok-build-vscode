import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const CODEX_MANAGED_TAG = "rust-v0.153.4";
export const CODEX_MANAGED_VERSION = CODEX_MANAGED_TAG.replace(/^rust-v/, "");
export const CODEX_MANAGED_BASE_URL =
  `https://github.com/openai/codex/releases/download/${CODEX_MANAGED_TAG}`;

export interface CodexManagedRelease {
  target: string;
  sha256: string;
  asset: string;
  url: string;
}

const RELEASE_HASHES: Readonly<Record<string, string>> = Object.freeze({
  "x86_64-pc-windows-msvc": "a6ef3442cb12766a88b39311d79244289e4f9763e2c53ff4fbebc2cb653cc5f3",
  "aarch64-pc-windows-msvc": "ac51b1a5932e07dffcaa6e98f4801f13b25192094739b732fc8b40ddb41bbda2",
  "x86_64-apple-darwin": "3ee638d7155c856ef31f3f4a85cb2195de1939962d3924c935b24f0514564a3d",
  "aarch64-apple-darwin": "35438da1fbf7a6db7ddb3bcec84448fa6015ba188461472a97d9d1da7d9c4353",
  "x86_64-unknown-linux-musl": "a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821",
  "aarch64-unknown-linux-musl": "fc395cb043a1093ab0db34f44aba3199bfaa9ce640cd9be7fd588f44b0da64a4",
});

export function codexManagedTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  if (!cpu) return undefined;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "linux") return `${cpu}-unknown-linux-musl`;
  return undefined;
}

export function codexManagedRelease(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CodexManagedRelease | undefined {
  const target = codexManagedTarget(platform, arch);
  if (!target) return undefined;
  const sha256 = RELEASE_HASHES[target];
  if (!sha256) return undefined;
  const asset = `codex-package-${target}.tar.gz`;
  return { target, sha256, asset, url: `${CODEX_MANAGED_BASE_URL}/${asset}` };
}

/** Every managed install, the pinned one and any a bump superseded. */
export function codexManagedRoot(storageRoot: string): string {
  return path.join(storageRoot, "codex-managed");
}

export function codexManagedVersionDir(storageRoot: string): string {
  return path.join(codexManagedRoot(storageRoot), CODEX_MANAGED_TAG);
}

export function codexManagedBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "codex.exe" : "codex";
}

export function codexManagedBinaryPath(
  storageRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(codexManagedVersionDir(storageRoot), "bin", codexManagedBinaryName(platform));
}

export interface TarHeader {
  name: string;
  size: number;
  type: string;
  mode: number;
}

export function tarRegularFileMode(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  return platform === "win32" ? undefined : mode & 0o777;
}

function tarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8").trim();
}

function tarOctal(block: Buffer, start: number, length: number): number {
  const value = tarString(block, start, length).replace(/^\0+/, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar size field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Tar entry is too large.");
  return parsed;
}

/** Parse one POSIX ustar header. A zero block returns undefined. */
export function parseTarHeader(block: Buffer): TarHeader | undefined {
  if (block.length !== 512) throw new Error("Tar headers must be exactly 512 bytes.");
  if (block.every((byte) => byte === 0)) return undefined;
  const storedChecksum = tarOctal(block, 148, 8);
  let checksum = 0;
  for (let index = 0; index < block.length; index++) {
    checksum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (storedChecksum !== checksum) throw new Error("Tar header checksum mismatch.");
  const name = tarString(block, 0, 100);
  const prefix = tarString(block, 345, 155);
  const fullName = prefix ? `${prefix}/${name}` : name;
  if (!fullName) throw new Error("Tar entry has no name.");
  return {
    name: fullName,
    size: tarOctal(block, 124, 12),
    type: tarString(block, 156, 1) || "0",
    mode: tarOctal(block, 100, 8) & 0o777,
  };
}

function safeTarDestination(root: string, entryName: string): string {
  const normalized = path.posix.normalize(entryName.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe tar entry path: ${entryName}`);
  }
  const destination = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(path.resolve(root), destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe tar entry path: ${entryName}`);
  }
  return destination;
}

async function readExactly(handle: fs.promises.FileHandle, length: number, position: number): Promise<Buffer> {
  const out = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(out, offset, length - offset, position + offset);
    if (!result.bytesRead) throw new Error("Truncated tar archive.");
    offset += result.bytesRead;
  }
  return out;
}

/** Extract regular files/directories from a tar file without buffering payloads. */
export async function extractTarFile(
  tarPath: string,
  destinationRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  const handle = await fs.promises.open(tarPath, "r");
  const extracted: string[] = [];
  let position = 0;
  let longName: string | undefined;
  try {
    const stat = await handle.stat();
    while (position + 512 <= stat.size) {
      const header = parseTarHeader(await readExactly(handle, 512, position));
      position += 512;
      if (!header) break;
      const payloadPosition = position;
      const paddedSize = Math.ceil(header.size / 512) * 512;
      if (payloadPosition + paddedSize > stat.size) throw new Error("Truncated tar entry.");
      if (header.type === "L") {
        if (header.size > 1024 * 1024) throw new Error("Tar long name is too large.");
        longName = (await readExactly(handle, header.size, payloadPosition)).toString("utf8").replace(/\0.*$/s, "");
      } else if (header.type === "0" || header.type === "\0") {
        const target = safeTarDestination(destinationRoot, longName || header.name);
        longName = undefined;
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const extractedMode = tarRegularFileMode(header.mode, platform);
        const mode = extractedMode === undefined ? {} : { mode: extractedMode };
        if (header.size === 0) await fs.promises.writeFile(target, "", { flag: "wx", ...mode });
        else await pipeline(
          fs.createReadStream(tarPath, { start: payloadPosition, end: payloadPosition + header.size - 1 }),
          fs.createWriteStream(target, { flags: "wx", ...mode }),
        );
        extracted.push(target);
      } else if (header.type === "5") {
        const directoryName = longName || header.name;
        longName = undefined;
        if (!/^\.\/?$/.test(directoryName)) {
          const target = safeTarDestination(destinationRoot, directoryName);
          await fs.promises.mkdir(target, { recursive: true });
        }
      } else {
        longName = undefined;
      }
      position = payloadPosition + paddedSize;
    }
  } finally {
    await handle.close();
  }
  return extracted;
}

function findExtractedCodex(files: readonly string[], platform: NodeJS.Platform): string | undefined {
  const wanted = platform === "win32" ? "codex.exe" : "codex";
  return files.find((file) => path.basename(file).toLowerCase() === wanted);
}

function findPackageRoot(files: readonly string[], binary: string): string | undefined {
  const manifest = files.find((file) => path.basename(file) === "codex-package.json");
  if (!manifest) return undefined;
  const root = path.dirname(manifest);
  const relative = path.relative(root, binary);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? root : undefined;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
}

export type CodexDownload = (
  url: string,
  destination: string,
  signal: AbortSignal,
  progress: (value: DownloadProgress) => void,
) => Promise<string>;

export async function downloadCodexAsset(
  url: string,
  destination: string,
  signal: AbortSignal,
  progress: (value: DownloadProgress) => void = () => {},
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchFn(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
  const totalHeader = response.headers.get("content-length");
  const totalBytes = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined;
  const reader = response.body.getReader();
  const output = fs.createWriteStream(destination, { flags: "wx" });
  let rejectOutputError!: (error: Error) => void;
  const outputError = new Promise<never>((_resolve, reject) => { rejectOutputError = reject; });
  void outputError.catch(() => {});
  output.on("error", rejectOutputError);
  const hash = createHash("sha256");
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), outputError]);
      if (done) break;
      if (signal.aborted) throw signal.reason ?? new Error("Installation cancelled.");
      const chunk = Buffer.from(value);
      hash.update(chunk);
      receivedBytes += chunk.length;
      if (!output.write(chunk)) await Promise.race([
        new Promise<void>((resolve) => output.once("drain", resolve)),
        outputError,
      ]);
      progress({ receivedBytes, totalBytes });
    }
    await Promise.race([
      new Promise<void>((resolve) => output.end(resolve)),
      outputError,
    ]);
    return hash.digest("hex");
  } catch (error) {
    output.destroy();
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export interface ManagedCodexInstallOptions {
  storageRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  signal: AbortSignal;
  download?: CodexDownload;
  release?: CodexManagedRelease;
  onProgress?: (phase: "downloading" | "verifying" | "installing", value?: DownloadProgress) => void;
}

/**
 * Remove version directories this build no longer uses.
 *
 * The install path carries the tag, so bumping the pin leaves the previous
 * ~100 MB package sitting in global storage for ever. Best-effort on purpose:
 * on Windows a running Codex holds its own executable open, and failing to
 * tidy must never fail an install that already succeeded. The next bump tries
 * again.
 */
async function pruneOtherManagedCodex(parent: string): Promise<void> {
  let entries: string[];
  try { entries = await fs.promises.readdir(parent); } catch { return; }
  await Promise.all(entries
    .filter((entry) => entry !== CODEX_MANAGED_TAG && !entry.startsWith("."))
    .map((entry) => fs.promises.rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => {})));
}

export async function installManagedCodex(options: ManagedCodexInstallOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const release = options.release ?? codexManagedRelease(platform, options.arch ?? process.arch);
  if (!release) throw new Error(`Managed Codex is not available for ${platform}/${options.arch ?? process.arch}.`);
  const finalDir = codexManagedVersionDir(options.storageRoot);
  const finalBinary = codexManagedBinaryPath(options.storageRoot, platform);
  if (fs.existsSync(finalBinary)) return finalBinary;
  const parent = path.dirname(finalDir);
  await fs.promises.mkdir(parent, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const archive = path.join(parent, `.${CODEX_MANAGED_TAG}-${token}.download`);
  const tar = path.join(parent, `.${CODEX_MANAGED_TAG}-${token}.tar`);
  const unpacked = path.join(parent, `.${CODEX_MANAGED_TAG}-${token}.unpack`);
  const download = options.download ?? downloadCodexAsset;
  try {
    options.onProgress?.("downloading", { receivedBytes: 0 });
    const actualHash = (await download(release.url, archive, options.signal, (value) =>
      options.onProgress?.("downloading", value))).toLowerCase();
    options.onProgress?.("verifying");
    if (actualHash !== release.sha256.toLowerCase()) {
      throw new Error("Downloaded Codex package failed SHA-256 verification.");
    }
    if (options.signal.aborted) throw options.signal.reason ?? new Error("Installation cancelled.");
    options.onProgress?.("installing");
    await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(tar, { flags: "wx" }));
    const files = await extractTarFile(tar, unpacked, platform);
    const found = findExtractedCodex(files, platform);
    if (!found) throw new Error("The verified Codex package did not contain the Codex executable.");
    const packageRoot = findPackageRoot(files, found);
    if (!packageRoot) throw new Error("The verified archive did not contain a valid Codex package layout.");
    const canonical = path.join(packageRoot, "bin", platform === "win32" ? "codex.exe" : "codex");
    if (path.resolve(found) !== path.resolve(canonical)) {
      throw new Error("The verified archive contained an unexpected Codex executable layout.");
    }
    if (options.signal.aborted) throw options.signal.reason ?? new Error("Installation cancelled.");
    try {
      await fs.promises.rename(packageRoot, finalDir);
    } catch (error) {
      if (!fs.existsSync(finalBinary)) throw error;
    }
    await pruneOtherManagedCodex(parent);
    return finalBinary;
  } finally {
    await Promise.all([
      fs.promises.rm(archive, { force: true }).catch(() => {}),
      fs.promises.rm(tar, { force: true }).catch(() => {}),
      fs.promises.rm(unpacked, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}
