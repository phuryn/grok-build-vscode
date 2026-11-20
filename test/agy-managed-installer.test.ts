import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGY_MANAGED_VERSION,
  agyManagedBinaryPath,
  agyManagedFileNames,
  agyManagedRelease,
  agyManagedRoot,
  extractZipFile,
  installManagedAgy,
  isSupersededManagedAgy,
  locateAgyServer,
} from "../src/agy-managed-installer";
import type { CodexDownload } from "../src/codex-managed-installer";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grok-agy-managed-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

type Entry = { name: string; body?: Buffer; method?: 0 | 8; flags?: number; zip64?: boolean };

/** A minimal zip writer: local headers, central directory, end record. */
function zip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.body ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const data = method === 8 && body.length ? deflateRawSync(body) : body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.flags ?? 0, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(entry.zip64 ? 0xffffffff : data.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function serverZip(platform: NodeJS.Platform): Buffer {
  const names = agyManagedFileNames(platform);
  return zip([
    { name: names.server, body: Buffer.from("server ".repeat(5000)) },
    { name: names.harness, body: Buffer.from("harness ".repeat(5000)) },
  ]);
}

function fakeDownload(archive: Buffer): CodexDownload {
  return async (_url, destination, _signal, progress) => {
    await fs.promises.writeFile(destination, archive, { flag: "wx" });
    progress({ receivedBytes: archive.length, totalBytes: archive.length });
    return sha256(archive);
  };
}

// Computed from the archives on Google's download host when the pin was taken
// (the registry publishes none). A second copy on purpose, so an edited digest
// in the source fails here rather than shipping.
const releases = [
  ["win32", "x64", "windows/agy-acp-server-1.5.2-windows-x86_64.zip", "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6", 105407645],
  ["win32", "arm64", "windows/agy-acp-server-1.5.2-windows-arm64.zip", "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab", 108049351],
  ["darwin", "arm64", "macos/agy-acp-server-1.5.2-darwin-arm64.zip", "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845", 100309778],
  ["darwin", "x64", "macos/agy-acp-server-1.5.2-darwin-x86_64.zip", "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06", 106351992],
  ["linux", "x64", "linux/agy-acp-server-1.5.2-linux-x86_64.zip", "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852", 273964075],
  ["linux", "arm64", "linux/agy-acp-server-1.5.2-linux-arm64.zip", "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb", 264270419],
] as const;

describe("managed Antigravity release", () => {
  it.each(releases)("pins %s/%s to Google's archive and digest", (platform, arch, asset, digest, size) => {
    expect(agyManagedRelease(platform, arch)).toMatchObject({
      url: `https://dl.google.com/agy-extensions/releases/${asset}`, sha256: digest, size,
    });
  });

  it("has nothing for platforms Google does not ship", () => {
    expect(agyManagedRelease("freebsd", "x64")).toBeUndefined();
    expect(agyManagedRelease("linux", "ia32")).toBeUndefined();
  });

  it("names the executables per platform", () => {
    expect(agyManagedFileNames("win32")).toEqual({ server: "agy_acp_server.exe", harness: "localharness_external.exe" });
    expect(agyManagedFileNames("darwin")).toEqual({ server: "agy_acp_server.par", harness: "localharness_external" });
    expect(agyManagedFileNames("linux")).toEqual({ server: "agy_acp_server.par", harness: "localharness_external" });
  });

  it("detects a superseded managed binary only inside extension storage", () => {
    const root = path.resolve("extension-storage");
    const old = path.join(agyManagedRoot(root), "1.4.0", agyManagedFileNames().server);
    expect(isSupersededManagedAgy(root, old)).toBe(true);
    expect(isSupersededManagedAgy(root, agyManagedBinaryPath(root))).toBe(false);
    expect(isSupersededManagedAgy(root, path.resolve("external", "1.4.0", agyManagedFileNames().server))).toBe(false);
  });
});

describe("managed Antigravity install", () => {
  it.each(["win32", "linux", "darwin"] as const)("unpacks both binaries side by side for %s", async (platform) => {
    const storageRoot = await tempRoot();
    const archive = serverZip(platform);
    const phases: string[] = [];
    const binary = await installManagedAgy({
      storageRoot, platform, arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
      onProgress: (phase) => { if (phases.at(-1) !== phase) phases.push(phase); },
    });
    const names = agyManagedFileNames(platform);
    expect(binary).toBe(agyManagedBinaryPath(storageRoot, platform));
    expect(path.dirname(binary)).toBe(path.join(agyManagedRoot(storageRoot), AGY_MANAGED_VERSION));
    expect(fs.readFileSync(binary, "utf8")).toBe("server ".repeat(5000));
    expect(fs.readFileSync(path.join(path.dirname(binary), names.harness), "utf8")).toBe("harness ".repeat(5000));
    expect(phases).toEqual(["downloading", "verifying", "installing"]);
    // Nothing but the version directory is left behind.
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([AGY_MANAGED_VERSION]);
    if (process.platform !== "win32" && platform !== "win32") {
      expect(fs.statSync(binary).mode & 0o111).not.toBe(0);
      expect(fs.statSync(path.join(path.dirname(binary), names.harness)).mode & 0o111).not.toBe(0);
    }
  });

  it("reports progress against the pinned size, not a compressed Content-Length", async () => {
    const storageRoot = await tempRoot();
    const archive = serverZip("win32");
    const download: CodexDownload = async (_url, destination, _signal, progress) => {
      await fs.promises.writeFile(destination, archive, { flag: "wx" });
      progress({ receivedBytes: archive.length, totalBytes: archive.length - 100 });
      return sha256(archive);
    };
    const totals: (number | undefined)[] = [];
    await installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download,
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
      onProgress: (_phase, value) => { if (value) totals.push(value.totalBytes); },
    });
    expect(totals).toEqual([archive.length, archive.length]);
  });

  it("rejects an archive whose digest does not match, and leaves nothing behind", async () => {
    const storageRoot = await tempRoot();
    const archive = serverZip("win32");
    await expect(installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: "0".repeat(64), size: archive.length, url: "https://example.invalid/a.zip" },
    })).rejects.toThrow(/SHA-256/);
    expect(fs.existsSync(agyManagedBinaryPath(storageRoot, "win32"))).toBe(false);
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([]);
  });

  it("rejects a verified archive without the harness beside the server", async () => {
    const storageRoot = await tempRoot();
    const archive = zip([{ name: "agy_acp_server.exe", body: Buffer.from("x") }]);
    await expect(installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
    })).rejects.toThrow(/layout/);
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([]);
  });

  it("stops when cancelled before unpacking", async () => {
    const storageRoot = await tempRoot();
    const archive = serverZip("win32");
    const controller = new AbortController();
    const download: CodexDownload = async (...args) => {
      const hash = await fakeDownload(archive)(...args);
      controller.abort(new Error("Installation cancelled."));
      return hash;
    };
    await expect(installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: controller.signal, download,
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
    })).rejects.toThrow(/cancelled/);
    expect(fs.existsSync(agyManagedBinaryPath(storageRoot, "win32"))).toBe(false);
  });

  it("removes a superseded version once the pinned one is in place", async () => {
    const storageRoot = await tempRoot();
    await fs.promises.mkdir(path.join(agyManagedRoot(storageRoot), "1.3.0"), { recursive: true });
    const archive = serverZip("win32");
    await installManagedAgy({
      storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, download: fakeDownload(archive),
      release: { target: "t", sha256: sha256(archive), size: archive.length, url: "https://example.invalid/a.zip" },
    });
    expect(fs.readdirSync(agyManagedRoot(storageRoot))).toEqual([AGY_MANAGED_VERSION]);
  });
});

describe("zip extraction", () => {
  async function extract(entries: Entry[]): Promise<{ root: string; files: string[] }> {
    const root = await tempRoot();
    const file = path.join(root, "a.zip");
    await fs.promises.writeFile(file, zip(entries));
    const files = await extractZipFile(file, path.join(root, "out"));
    return { root, files };
  }

  it("streams stored and deflated entries, directories and empty files", async () => {
    const { root, files } = await extract([
      { name: "dir/" },
      { name: "dir/stored.txt", body: Buffer.from("stored"), method: 0 },
      { name: "deflated.bin", body: Buffer.alloc(200_000, 7) },
      { name: "empty.txt" },
    ]);
    expect(files.map((file) => path.relative(path.join(root, "out"), file).replace(/\\/g, "/")).sort())
      .toEqual(["deflated.bin", "dir/stored.txt", "empty.txt"]);
    expect(fs.readFileSync(path.join(root, "out", "dir", "stored.txt"), "utf8")).toBe("stored");
    expect(fs.readFileSync(path.join(root, "out", "deflated.bin")).equals(Buffer.alloc(200_000, 7))).toBe(true);
  });

  it("refuses entries that would land outside the destination", async () => {
    await expect(extract([{ name: "../evil.txt", body: Buffer.from("x") }])).rejects.toThrow(/Unsafe/);
    await expect(extract([{ name: "/abs.txt", body: Buffer.from("x") }])).rejects.toThrow(/Unsafe/);
  });

  it("refuses what the pinned archives never use", async () => {
    await expect(extract([{ name: "a", body: Buffer.from("x"), flags: 1 }])).rejects.toThrow(/Encrypted/);
    await expect(extract([{ name: "a", body: Buffer.from("x"), zip64: true }])).rejects.toThrow(/ZIP64/);
    const root = await tempRoot();
    const file = path.join(root, "not.zip");
    await fs.promises.writeFile(file, "not a zip at all, just some text that is long enough");
    await expect(extractZipFile(file, path.join(root, "out"))).rejects.toThrow(/Not a zip/);
  });
});

describe("locating the Antigravity server", () => {
  const storage = path.join("/storage");
  const pinned = agyManagedBinaryPath(storage, "win32");
  const old = path.join(agyManagedRoot(storage), "1.3.0", "agy_acp_server.exe");

  it("prefers the configured path and never second-guesses a wrong one", () => {
    expect(locateAgyServer({ configuredPath: "C:\\mine\\agy_acp_server.exe", managedStorageRoot: storage, platform: "win32", isFile: () => true }))
      .toBe("C:\\mine\\agy_acp_server.exe");
    expect(locateAgyServer({ configuredPath: "C:\\missing.exe", managedStorageRoot: storage, platform: "win32", isFile: (file) => file === pinned }))
      .toBeUndefined();
  });

  it("finds the pinned install, then one a previous pin left, then nothing", () => {
    expect(locateAgyServer({ managedStorageRoot: storage, platform: "win32", isFile: (file) => file === pinned })).toBe(pinned);
    expect(locateAgyServer({ managedStorageRoot: storage, platform: "win32", isFile: (file) => file === old, readDir: () => ["1.3.0", ".tmp"] })).toBe(old);
    expect(locateAgyServer({ managedStorageRoot: storage, platform: "win32", isFile: () => false, readDir: () => [] })).toBeUndefined();
    expect(locateAgyServer({ platform: "win32", isFile: () => true })).toBeUndefined();
  });
});
