import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_RELEASE_LOOKUP_TIMEOUT_MS,
  CODEX_MANAGED_TAG,
  CODEX_MANAGED_VERSION,
  codexManagedBinaryPath,
  codexManagedRelease,
  codexManagedTarget,
  downloadCodexAsset,
  extractTarFile,
  installManagedCodex,
  parseTarHeader,
  resolveCodexManagedRelease,
  tarRegularFileMode,
  type CodexDownload,
} from "../src/codex-managed-installer";

const temporaryRoots: string[] = [];
const floor = codexManagedRelease("linux", "x64")!;
const latestTag = "rust-v0.171.0";
const latestUrl = `https://github.com/openai/codex/releases/download/${latestTag}/${floor.asset}`;

function latestMetadata(digest = "a".repeat(64)) {
  return {
    tag_name: latestTag, draft: false, prerelease: false,
    assets: [
      { name: "codex-package-aarch64-unknown-linux-musl.tar.gz", digest: `sha256:${"b".repeat(64)}` },
      { name: floor.asset, browser_download_url: latestUrl, digest: `sha256:${digest}` },
    ],
  };
}
const lookupOptions = { platform: "linux", arch: "x64", signal: new AbortController().signal } as const;

async function temporaryRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "grok-codex-managed-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

function tarHeader(name: string, size: number, type = "0", mode = 0o755): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tar(entries: Array<{ name: string; body?: Buffer; type?: string; mode?: number }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    chunks.push(tarHeader(entry.name, body.length, entry.type, entry.mode));
    chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

// Transcribed from `codex-package_SHA256SUMS` at the pinned release. This table
// exists to make a silent digest edit fail the suite, so it is deliberately a
// second copy rather than an import of the one under test.
const releases = [
  ["win32", "x64", "x86_64-pc-windows-msvc", "d559bb88e74d471265857b93b7f19bc250dae527673b9191b33534478093f6bc"],
  ["win32", "arm64", "aarch64-pc-windows-msvc", "9383152a72f97bb5dd148493c8214e4fed38d805aa2c3297cb3739f7f130becf"],
  ["darwin", "x64", "x86_64-apple-darwin", "1cb65690230be5982c654ba2655e3a3b594dce9c55b780e78bfdfeff829d7ad9"],
  ["darwin", "arm64", "aarch64-apple-darwin", "55a440cb579f970abe7c79ab181e54b0ea4c419be99f333bbd868eebac9c21f0"],
  ["linux", "x64", "x86_64-unknown-linux-musl", "1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254"],
  ["linux", "arm64", "aarch64-unknown-linux-musl", "7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6"],
] as const;

describe("managed Codex release selection", () => {
  it.each(releases)("pins %s/%s to the official target, URL, and digest", (platform, arch, target, sha256) => {
    expect(codexManagedTarget(platform, arch)).toBe(target);
    expect(codexManagedRelease(platform, arch)).toEqual({
      tag: CODEX_MANAGED_TAG,
      version: CODEX_MANAGED_VERSION,
      target,
      sha256,
      asset: `codex-package-${target}.tar.gz`,
      url: `https://github.com/openai/codex/releases/download/${CODEX_MANAGED_TAG}/codex-package-${target}.tar.gz`,
    });
  });

  it("refuses unsupported targets instead of guessing", () => {
    expect(codexManagedRelease("freebsd", "x64")).toBeUndefined();
    expect(codexManagedRelease("linux", "ia32")).toBeUndefined();
  });

  it("resolves the stable release using the matching platform asset and digest", async () => {
    const fetchRelease = vi.fn(async () => Response.json(latestMetadata("A".repeat(64))));
    await expect(resolveCodexManagedRelease({ ...lookupOptions, fetchRelease })).resolves.toEqual({
      ...floor, tag: latestTag, version: "0.171.0", url: latestUrl, sha256: "a".repeat(64),
    });
    expect(fetchRelease).toHaveBeenCalledOnce();
    expect(fetchRelease).toHaveBeenCalledWith("https://api.github.com/repos/openai/codex/releases/latest",
      { signal: expect.any(AbortSignal), redirect: "error" });
  });

  it.each([
    ["missing digest", { digest: undefined }],
    ["malformed digest", { digest: "sha256:short" }],
    ["wrong algorithm", { digest: `sha512:${"a".repeat(64)}` }],
    ["foreign host", { browser_download_url: latestUrl.replace("github.com", "example.invalid") }],
    ["wrong repository", { browser_download_url: latestUrl.replace("/openai/codex/", "/other/codex/") }],
    ["insecure URL", { browser_download_url: latestUrl.replace("https:", "http:") }],
    ["wrong tag path", { browser_download_url: latestUrl.replace(latestTag, CODEX_MANAGED_TAG) }],
    ["missing platform asset", { name: "other.tar.gz" }],
  ])("falls back and reports invalid metadata for %s", async (_case, value) => {
    const metadata = latestMetadata();
    Object.assign(metadata.assets[1], value);
    const onLookupFailure = vi.fn();
    await expect(resolveCodexManagedRelease({
      ...lookupOptions, fetchRelease: async () => Response.json(metadata), onLookupFailure,
    })).resolves.toEqual(floor);
    expect(onLookupFailure).toHaveBeenCalledOnce();
  });

  it("uses the pinned floor when the latest endpoint reports an older release", async () => {
    const tag = "rust-v0.99.0";
    const metadata = { ...latestMetadata(), tag_name: tag };
    metadata.assets[1].browser_download_url = latestUrl.replace(latestTag, tag);
    await expect(resolveCodexManagedRelease({
      ...lookupOptions, fetchRelease: async () => Response.json(metadata),
    })).resolves.toEqual(floor);
  });

  it("falls back on a rate-limited lookup and honors cancellation", async () => {
    const fetchRelease = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(resolveCodexManagedRelease({ ...lookupOptions, fetchRelease })).resolves.toEqual(floor);
    await expect(resolveCodexManagedRelease({
      ...lookupOptions, fetchRelease, signal: AbortSignal.abort(new Error("cancelled")),
    })).rejects.toThrow("cancelled");
    expect(fetchRelease).toHaveBeenCalledOnce();
  });

  it("bounds a stalled release response body and falls back to the pin", async () => {
    const timeout = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const pending = resolveCodexManagedRelease({
        ...lookupOptions,
        fetchRelease: async (_url, options) => new Response(new ReadableStream({
          start(stream) {
            options!.signal!.addEventListener("abort", () => stream.error(options!.signal!.reason));
            timeout.abort(new Error("lookup deadline"));
          },
        })),
      });
      await expect(pending).resolves.toEqual(floor);
      expect(deadline).toHaveBeenCalledWith(CODEX_RELEASE_LOOKUP_TIMEOUT_MS);
    } finally { deadline.mockRestore(); }
  });
});

describe("managed Codex tar reader", () => {
  it("parses verified 512-byte headers and extracts regular and empty files", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "package.tar");
    const bytes = tar([
      { name: "./", type: "5" },
      { name: "package/bin/codex", body: Buffer.from("binary") },
      { name: "package/empty", body: Buffer.alloc(0) },
    ]);
    await fs.promises.writeFile(archive, bytes);
    expect(parseTarHeader(bytes.subarray(512, 1024))).toMatchObject({ name: "package/bin/codex", size: 6, type: "0" });
    const destination = path.join(root, "out");
    const files = await extractTarFile(archive, destination);
    expect(files.map((file) => path.relative(destination, file))).toEqual([
      path.join("package", "bin", "codex"),
      path.join("package", "empty"),
    ]);
    expect(await fs.promises.readFile(files[0], "utf8")).toBe("binary");
  });

  it("rejects corrupt headers and traversal before writing outside the destination", async () => {
    const root = await temporaryRoot();
    const corrupt = tarHeader("codex", 0);
    corrupt[12] ^= 1;
    expect(() => parseTarHeader(corrupt)).toThrow("checksum");
    const archive = path.join(root, "unsafe.tar");
    await fs.promises.writeFile(archive, tar([{ name: "../escape/codex", body: Buffer.from("bad") }]));
    await expect(extractTarFile(archive, path.join(root, "out"))).rejects.toThrow("Unsafe tar entry path");
    expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
  });

  it("preserves executable mode bits for regular helper files on POSIX and ignores them on Windows", async () => {
    const root = await temporaryRoot();
    const archive = path.join(root, "helpers.tar");
    await fs.promises.writeFile(archive, tar([
      { name: "package/bin/codex-code-mode-host", body: Buffer.from("helper"), mode: 0o755 },
    ]));

    const posixFiles = await extractTarFile(archive, path.join(root, "posix"), "linux");
    const windowsFiles = await extractTarFile(archive, path.join(root, "windows"), "win32");
    expect(tarRegularFileMode(0o10755, "linux")).toBe(0o755);
    expect(tarRegularFileMode(0o755, "win32")).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await fs.promises.stat(posixFiles[0])).mode & 0o777).toBe(0o755);
      expect((await fs.promises.stat(windowsFiles[0])).mode & 0o111).toBe(0);
    }
  });
});

describe("managed Codex atomic install", () => {
  function fakePackageDownload(bytes: Buffer): CodexDownload {
    return async (_url, destination, signal, progress) => {
      if (signal.aborted) throw signal.reason;
      await fs.promises.writeFile(destination, bytes, { flag: "wx" });
      progress({ receivedBytes: bytes.length, totalBytes: bytes.length });
      return createHash("sha256").update(bytes).digest("hex");
    };
  }

  it("verifies before unpacking, publishes atomically, and drops the version it replaced", async () => {
    const root = await temporaryRoot();
    // The install path carries the tag, so a bump lands BESIDE the previous
    // package rather than over it. Nothing used to remove the old ~100 MB.
    const stale = path.join(root, "codex-managed", "rust-v0.147.0", "bin");
    await fs.promises.mkdir(stale, { recursive: true });
    await fs.promises.writeFile(path.join(stale, "codex"), "previous");
    const packageBytes = gzipSync(tar([
      { name: "codex-package/codex-package.json", body: Buffer.from('{"version":"0.153.4"}') },
      { name: "codex-package/bin/codex", body: Buffer.from("managed-codex") },
      { name: "codex-package/codex-resources/bwrap", body: Buffer.from("helper") },
    ]));
    const sha256 = createHash("sha256").update(packageBytes).digest("hex");
    const phases: string[] = [];
    const installed = await installManagedCodex({
      storageRoot: root,
      platform: "linux",
      arch: "x64",
      signal: new AbortController().signal,
      release: { ...floor, sha256 },
      download: fakePackageDownload(packageBytes),
      onProgress: (phase) => phases.push(phase),
    });
    expect(installed).toBe(codexManagedBinaryPath(root, "linux"));
    expect(await fs.promises.readFile(installed, "utf8")).toBe("managed-codex");
    expect(await fs.promises.readFile(path.join(path.dirname(path.dirname(installed)), "codex-resources", "bwrap"), "utf8"))
      .toBe("helper");
    if (process.platform !== "win32") expect((await fs.promises.stat(installed)).mode & 0o111).toBeTruthy();
    expect(phases).toContain("verifying");
    expect(phases).toContain("installing");
    expect((await fs.promises.readdir(path.join(root, "codex-managed"))).sort()).toEqual([CODEX_MANAGED_TAG]);
  });

  it("installs the latest release into its own directory on a fresh install", async () => {
    const root = await temporaryRoot();
    const packageBytes = gzipSync(tar([
      { name: "codex-package/codex-package.json", body: Buffer.from('{"version":"0.171.0"}') },
      { name: "codex-package/bin/codex", body: Buffer.from("latest-binary") },
    ]));
    const sha256 = createHash("sha256").update(packageBytes).digest("hex");
    const download = vi.fn(fakePackageDownload(packageBytes));
    const installed = await installManagedCodex({
      ...lookupOptions, storageRoot: root, download,
      fetchRelease: async () => Response.json(latestMetadata(sha256)),
    });
    expect(download).toHaveBeenCalledWith(latestUrl, expect.any(String), lookupOptions.signal, expect.any(Function));
    expect(installed).toBe(codexManagedBinaryPath(root, "linux", latestTag));
    expect(await fs.promises.readFile(installed, "utf8")).toBe("latest-binary");
    expect(fs.existsSync(codexManagedBinaryPath(root, "linux"))).toBe(false);
  });

  it("retains the binary selected for launch while pruning older unused versions", async () => {
    const root = await temporaryRoot();
    const running = codexManagedBinaryPath(root, "linux");
    const stale = codexManagedBinaryPath(root, "linux", "rust-v0.99.0");
    for (const binary of [running, stale]) {
      await fs.promises.mkdir(path.dirname(binary), { recursive: true });
      await fs.promises.writeFile(binary, "previous");
    }
    const bytes = gzipSync(tar([
      { name: "package/codex-package.json", body: Buffer.from("{}") },
      { name: "package/bin/codex", body: Buffer.from("next") },
    ]));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await installManagedCodex({
      ...lookupOptions, storageRoot: root, keepBinary: running, download: fakePackageDownload(bytes),
      release: { ...floor, tag: latestTag, version: "0.171.0", url: latestUrl, sha256 },
    });
    expect(await fs.promises.readFile(running, "utf8")).toBe("previous");
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(codexManagedBinaryPath(root, "linux", latestTag))).toBe(true);
  });

  it("returns an already installed newer binary without downloading the pin", async () => {
    const root = await temporaryRoot();
    const binary = codexManagedBinaryPath(root, "linux", latestTag);
    await fs.promises.mkdir(path.dirname(binary), { recursive: true });
    await fs.promises.writeFile(binary, "latest-binary");
    const download = vi.fn();
    await expect(installManagedCodex({ ...lookupOptions, storageRoot: root, release: floor, download })).resolves.toBe(binary);
    expect(download).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(binary, "utf8")).toBe("latest-binary");
  });

  it.each([
    ["offline download", async () => {
      throw new Error("offline");
    }],
    ["checksum mismatch", async (destination: string) => {
      await fs.promises.writeFile(destination, "untrusted", { flag: "wx" });
      return "0".repeat(64);
    }],
    ["partial download/cancel", async (destination: string) => {
      await fs.promises.writeFile(destination, "partial", { flag: "wx" });
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    }],
    ["disk write failure", async () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }],
  ] as Array<[string, CodexDownload]>)
  ("cleans every staging artifact after %s", async (_label, download) => {
    const root = await temporaryRoot();
    await expect(installManagedCodex({
      storageRoot: root,
      platform: "linux",
      arch: "x64",
      signal: new AbortController().signal,
      release: { ...floor, sha256: "f".repeat(64) },
      download,
    })).rejects.toThrow();
    const managed = path.join(root, "codex-managed");
    expect(fs.existsSync(managed) ? await fs.promises.readdir(managed) : []).toEqual([]);
  });

  it("honors cancellation and removes a partially streamed archive", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const download: CodexDownload = async (_url, destination, signal) => {
      await fs.promises.writeFile(destination, "partial", { flag: "wx" });
      controller.abort(new Error("cancelled by user"));
      throw signal.reason;
    };
    await expect(installManagedCodex({
      storageRoot: root,
      platform: "linux",
      arch: "x64",
      signal: controller.signal,
      release: { ...floor, sha256: "f".repeat(64) },
      download,
    })).rejects.toThrow("cancelled by user");
    expect(await fs.promises.readdir(path.join(root, "codex-managed"))).toEqual([]);
  });

  it("streams response chunks to disk while hashing and reporting byte progress", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "download");
    const chunks = [Buffer.from("first-"), Buffer.from("second")];
    const progress: number[] = [];
    const hash = await downloadCodexAsset(
      "https://example.invalid/package",
      destination,
      new AbortController().signal,
      (value) => progress.push(value.receivedBytes),
      async () => new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }), { status: 200, headers: { "content-length": "12" } }) as Awaited<ReturnType<typeof fetch>>,
    );
    const bytes = Buffer.concat(chunks);
    expect(await fs.promises.readFile(destination)).toEqual(bytes);
    expect(hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(progress).toEqual([6, 12]);
  });

  it("reports HTTP failures without creating a download file", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "download");
    await expect(downloadCodexAsset(
      "https://example.invalid/missing",
      destination,
      new AbortController().signal,
      () => {},
      async () => new Response(null, { status: 404 }) as Awaited<ReturnType<typeof fetch>>,
    )).rejects.toThrow("HTTP 404");
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects an asynchronous output-stream failure while a network chunk is pending", async () => {
    const root = await temporaryRoot();
    const destination = path.join(root, "missing-parent", "download");
    await expect(downloadCodexAsset(
      "https://example.invalid/package",
      destination,
      new AbortController().signal,
      () => {},
      async () => new Response(new ReadableStream({
        start() {
          // Keep reader.read() pending while createWriteStream reports ENOENT.
        },
      }), { status: 200 }) as Awaited<ReturnType<typeof fetch>>,
    )).rejects.toMatchObject({ code: "ENOENT" });
  });
});
