import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { downloadCodexAsset, safeTarDestination, type CodexDownload, type DownloadProgress } from "./codex-managed-installer";

/**
 * Google's ACP server for Antigravity, from the ACP registry entry
 * `antigravity-acp` (publisher Google LLC). The registry publishes no
 * checksums, so these digests and sizes were computed from the archives on
 * Google's download host when the pin was taken; a changed archive fails
 * verification rather than running.
 */
export const AGY_MANAGED_VERSION = "1.5.2";
export const AGY_MANAGED_BASE_URL = "https://dl.google.com/agy-extensions/releases";

export interface AgyManagedRelease {
  target: string;
  sha256: string;
  size: number;
  url: string;
}

const RELEASES: Readonly<Record<string, { folder: string; target: string; sha256: string; size: number }>> = Object.freeze({
  "win32-x64": { folder: "windows", target: "windows-x86_64", sha256: "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6", size: 105_407_645 },
  "win32-arm64": { folder: "windows", target: "windows-arm64", sha256: "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab", size: 108_049_351 },
  "darwin-arm64": { folder: "macos", target: "darwin-arm64", sha256: "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845", size: 100_309_778 },
  "darwin-x64": { folder: "macos", target: "darwin-x86_64", sha256: "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06", size: 106_351_992 },
  "linux-x64": { folder: "linux", target: "linux-x86_64", sha256: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852", size: 273_964_075 },
  "linux-arm64": { folder: "linux", target: "linux-arm64", sha256: "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb", size: 264_270_419 },
});

export function agyManagedRelease(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AgyManagedRelease | undefined {
  const pinned = RELEASES[`${platform}-${arch}`];
  if (!pinned) return undefined;
  return {
    target: pinned.target,
    sha256: pinned.sha256,
    size: pinned.size,
    url: `${AGY_MANAGED_BASE_URL}/${pinned.folder}/agy-acp-server-${AGY_MANAGED_VERSION}-${pinned.target}.zip`,
  };
}

/** The server and the harness it spawns. They must stay side by side. */
export function agyManagedFileNames(platform: NodeJS.Platform = process.platform): { server: string; harness: string } {
  return platform === "win32"
    ? { server: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { server: "agy_acp_server.par", harness: "localharness_external" };
}

/** Every managed install, the pinned one and any a bump superseded. */
export function agyManagedRoot(storageRoot: string): string {
  return path.join(storageRoot, "agy-managed");
}

export function agyManagedVersionDir(storageRoot: string): string {
  return path.join(agyManagedRoot(storageRoot), AGY_MANAGED_VERSION);
}

export function agyManagedBinaryPath(storageRoot: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(agyManagedVersionDir(storageRoot), agyManagedFileNames(platform).server);
}

export function isSupersededManagedAgy(storageRoot: string, binary: string, platform: NodeJS.Platform = process.platform): boolean {
  const resolved = path.resolve(binary);
  return path.basename(resolved) === agyManagedFileNames(platform).server
    && path.dirname(path.dirname(resolved)) === path.resolve(agyManagedRoot(storageRoot))
    && resolved !== path.resolve(agyManagedBinaryPath(storageRoot, platform));
}

export interface AgyLocatorOptions {
  /** `grok.agyServerPath`: wins outright, and a wrong one is not second-guessed. */
  configuredPath?: string;
  /** Extension-owned storage root holding managed installs. */
  managedStorageRoot?: string;
  platform?: NodeJS.Platform;
  isFile?: (file: string) => boolean;
  readDir?: (dir: string) => string[];
}

const isRegularFile = (file: string): boolean => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};

/**
 * The server binary to spawn. There is no PATH lookup: nothing installs this
 * server onto PATH, and the `agy` CLI of the same name is a different program.
 * An install a previous pin left behind still resolves, so moving the pin
 * cannot make a working provider vanish before the new one is fetched.
 */
export function locateAgyServer(options: AgyLocatorOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? isRegularFile;
  const configured = options.configuredPath?.trim();
  if (configured) return isFile(configured) ? configured : undefined;
  if (!options.managedStorageRoot) return undefined;
  const pinned = agyManagedBinaryPath(options.managedStorageRoot, platform);
  if (isFile(pinned)) return pinned;
  const root = agyManagedRoot(options.managedStorageRoot);
  let entries: string[] = [];
  try { entries = [...(options.readDir ?? fs.readdirSync)(root)].filter((entry) => !entry.startsWith(".")).sort().reverse(); }
  catch { /* nothing installed */ }
  for (const entry of entries) {
    const candidate = path.join(root, entry, agyManagedFileNames(platform).server);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP32_LIMIT = 0xffffffff;

async function readAt(handle: fs.promises.FileHandle, length: number, position: number): Promise<Buffer> {
  const out = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(out, offset, length - offset, position + offset);
    if (!bytesRead) throw new Error("Truncated zip archive.");
    offset += bytesRead;
  }
  return out;
}

/**
 * The central directory of a zip, read from the file's tail. Only what the
 * pinned archives use is supported: stored or deflated entries, no
 * encryption, no ZIP64. Anything else is refused, never guessed at.
 */
export async function readZipEntries(handle: fs.promises.FileHandle): Promise<ZipEntry[]> {
  const { size } = await handle.stat();
  const tailLength = Math.min(size, 22 + 0xffff);
  if (tailLength < 22) throw new Error("Not a zip archive.");
  const tail = await readAt(handle, tailLength, size - tailLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("Not a zip archive.");
  const count = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || directorySize === ZIP32_LIMIT || directoryOffset === ZIP32_LIMIT) {
    throw new Error("ZIP64 archives are not supported.");
  }
  if (directoryOffset + directorySize > size) throw new Error("Truncated zip archive.");
  const directory = await readAt(handle, directorySize, directoryOffset);
  const entries: ZipEntry[] = [];
  let position = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
      throw new Error("Corrupt zip central directory.");
    }
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const entry: ZipEntry = {
      flags: directory.readUInt16LE(position + 8),
      method: directory.readUInt16LE(position + 10),
      compressedSize: directory.readUInt32LE(position + 20),
      uncompressedSize: directory.readUInt32LE(position + 24),
      localHeaderOffset: directory.readUInt32LE(position + 42),
      name: directory.toString("utf8", position + 46, position + 46 + nameLength),
    };
    if ([entry.compressedSize, entry.uncompressedSize, entry.localHeaderOffset].includes(ZIP32_LIMIT)) {
      throw new Error("ZIP64 archives are not supported.");
    }
    if (entry.flags & 1) throw new Error(`Encrypted zip entry: ${entry.name}`);
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unsupported zip compression for ${entry.name}.`);
    entries.push(entry);
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Extract a zip without holding any entry in memory: each entry streams from
 * its byte range through inflate into its own file. The Linux server unpacks
 * to about a gigabyte, so buffering is not an option. Returns written files.
 */
export async function extractZipFile(
  zipPath: string,
  destinationRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  const handle = await fs.promises.open(zipPath, "r");
  const written: string[] = [];
  try {
    const { size } = await handle.stat();
    for (const entry of await readZipEntries(handle)) {
      signal?.throwIfAborted();
      const target = safeTarDestination(destinationRoot, entry.name);
      if (entry.name.endsWith("/")) {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      const local = await readAt(handle, 30, entry.localHeaderOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`Corrupt zip entry: ${entry.name}`);
      const dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (dataStart + entry.compressedSize > size) throw new Error(`Truncated zip entry: ${entry.name}`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (entry.compressedSize === 0) {
        await fs.promises.writeFile(target, "", { flag: "wx" });
      } else {
        const source = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
        const output = fs.createWriteStream(target, { flags: "wx" });
        if (entry.method === 8) await pipeline(source, createInflateRaw(), output, { signal });
        else await pipeline(source, output, { signal });
      }
      const { size: actual } = await fs.promises.stat(target);
      if (actual !== entry.uncompressedSize) throw new Error(`Zip entry ${entry.name} extracted to the wrong size.`);
      written.push(target);
    }
  } finally {
    await handle.close();
  }
  return written;
}

export interface ManagedAgyInstallOptions {
  storageRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  signal: AbortSignal;
  download?: CodexDownload;
  release?: AgyManagedRelease;
  onProgress?: (phase: "downloading" | "verifying" | "installing", value?: DownloadProgress) => void;
}

/** Best-effort: a running server on Windows holds its own executable open. */
async function pruneOtherManagedAgy(parent: string): Promise<void> {
  let entries: string[];
  try { entries = await fs.promises.readdir(parent); } catch { return; }
  await Promise.all(entries
    .filter((entry) => entry !== AGY_MANAGED_VERSION && !entry.startsWith("."))
    .map((entry) => fs.promises.rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => {})));
}

/**
 * Download, verify and unpack the pinned server into extension storage.
 * Nothing is executed and nothing outside storage is touched; the install
 * appears at its final path only once both binaries are in place.
 */
export async function installManagedAgy(options: ManagedAgyInstallOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const release = options.release ?? agyManagedRelease(platform, arch);
  if (!release) throw new Error(`Antigravity is not available for ${platform}/${arch}.`);
  const finalDir = agyManagedVersionDir(options.storageRoot);
  const finalBinary = agyManagedBinaryPath(options.storageRoot, platform);
  if (fs.existsSync(finalBinary)) return finalBinary;
  const parent = path.dirname(finalDir);
  await fs.promises.mkdir(parent, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const archive = path.join(parent, `.${AGY_MANAGED_VERSION}-${token}.download`);
  const unpacked = path.join(parent, `.${AGY_MANAGED_VERSION}-${token}.unpack`);
  const download = options.download ?? downloadCodexAsset;
  const names = agyManagedFileNames(platform);
  try {
    options.onProgress?.("downloading", { receivedBytes: 0, totalBytes: release.size });
    // The pinned size, not Content-Length: Google's host can send the archive
    // compressed, and the header then counts fewer bytes than arrive.
    const actualHash = (await download(release.url, archive, options.signal, (value) =>
      options.onProgress?.("downloading", { receivedBytes: value.receivedBytes, totalBytes: release.size })))
      .toLowerCase();
    options.onProgress?.("verifying");
    if (actualHash !== release.sha256.toLowerCase()) {
      throw new Error("Downloaded Antigravity server failed SHA-256 verification.");
    }
    options.signal.throwIfAborted();
    options.onProgress?.("installing");
    const files = await extractZipFile(archive, unpacked, options.signal);
    const has = (name: string) => files.some((file) => path.resolve(file) === path.resolve(unpacked, name));
    if (!has(names.server) || !has(names.harness)) {
      throw new Error("The verified archive did not contain the Antigravity server layout.");
    }
    if (platform !== "win32") {
      await fs.promises.chmod(path.join(unpacked, names.server), 0o755);
      await fs.promises.chmod(path.join(unpacked, names.harness), 0o755);
    }
    options.signal.throwIfAborted();
    try {
      await fs.promises.rename(unpacked, finalDir);
    } catch (error) {
      if (!fs.existsSync(finalBinary)) throw error;
    }
    await pruneOtherManagedAgy(parent);
    return finalBinary;
  } finally {
    await Promise.all([
      fs.promises.rm(archive, { force: true }).catch(() => {}),
      fs.promises.rm(unpacked, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}
