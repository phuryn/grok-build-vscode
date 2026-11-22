import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { safeTarDestination, type DownloadProgress } from "./codex-managed-installer";

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

