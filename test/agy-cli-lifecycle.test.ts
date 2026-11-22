import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { AGY_RELEASE_BASE, agyBuildName, downloadAgyCli, installAgyCli, updateAgyCliOnUpgrade, runAgyCommand } from "../src/agy-cli-lifecycle";
import { agyInstallDir } from "../src/agy-backend";

class FakeChild extends EventEmitter {
  readonly pid = 61561;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => this.close(null));

  close(code: number | null) {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

function fakeProcess(launch: (file: string, args: string[], child: FakeChild) => void) {
  return vi.fn((file: string, args: string[]) => {
    const child = new FakeChild();
    queueMicrotask(() => launch(file, args, child));
    return child;
  });
}

afterEach(() => vi.useRealTimers());

function tarWith(name: string, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar  \0", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}

function releaseServer(build: string, url: string, payload: Buffer, sha512 = createHash("sha512").update(payload).digest("hex")) {
  return vi.fn(async (requested: string | URL | Request) => {
    const href = String(requested);
    if (href === `${AGY_RELEASE_BASE}/manifests/${build}.json`) return new Response(JSON.stringify({ version: "1.5.14", url, sha512 }));
    if (href === url) return new Response(new Uint8Array(payload));
    return new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-install-"));
}

it("names the build Google's installers ask for", () => {
  expect(agyBuildName("win32", "x64")).toBe("windows_amd64");
  expect(agyBuildName("win32", "arm64")).toBe("windows_arm64");
  expect(agyBuildName("darwin", "arm64")).toBe("darwin_arm64");
  expect(agyBuildName("linux", "x64")).toBe("linux_amd64");
  expect(agyBuildName("linux", "arm64", true)).toBe("linux_arm64_musl");
  expect(agyBuildName("linux", "ia32")).toBeUndefined();
});

// The Marketplace's virus check refused every build that fetched Google's
// script and ran it in a hidden PowerShell (4.17.3 to 4.17.6). The download
// is done in Node, exactly as the script does it, and no shell is spawned.
// These write real files, so they use this machine's platform and paths.
const host = process.platform;
const build = agyBuildName(host, "x64", false)!;

function installTarget(home: string) {
  const env = { LOCALAPPDATA: path.join(home, "Local") };
  return { env, binary: path.join(agyInstallDir(env, host, home), host === "win32" ? "agy.exe" : "agy") };
}

it("installs a plain build where Google's script puts it, after checking its SHA-512", async () => {
  const home = tempHome();
  const { env, binary: expected } = installTarget(home);
  const url = "https://storage.googleapis.com/antigravity-public/cli_x64";
  const body = Buffer.from("fake agy binary");
  const binary = await downloadAgyCli({ signal: new AbortController().signal, platform: host, arch: "x64", musl: false, env, home,
    fetchFn: releaseServer(build, url, body) });
  expect(binary).toBe(expected);
  expect(fs.readFileSync(binary)).toEqual(body);
  expect(fs.readdirSync(path.dirname(binary))).toEqual([path.basename(binary)]);
  if (host !== "win32") expect(fs.statSync(binary).mode & 0o111).not.toBe(0);
  fs.rmSync(home, { recursive: true, force: true });
});

it("unpacks the antigravity binary from a .tar.gz build", async () => {
  const home = tempHome();
  const { env, binary: expected } = installTarget(home);
  const url = "https://storage.googleapis.com/antigravity-public/cli_x64.tar.gz";
  const elf = Buffer.from("\x7fELF fake agy");
  const binary = await downloadAgyCli({ signal: new AbortController().signal, platform: host, arch: "x64", musl: false, env, home,
    fetchFn: releaseServer(build, url, gzipSync(tarWith("antigravity", elf))) });
  expect(binary).toBe(expected);
  expect(fs.readFileSync(binary)).toEqual(elf);
  expect(fs.readdirSync(path.dirname(binary))).toEqual([path.basename(binary)]);
  fs.rmSync(home, { recursive: true, force: true });
});

it("refuses a download whose SHA-512 differs from the manifest and leaves nothing behind", async () => {
  const home = tempHome();
  const { env, binary } = installTarget(home);
  const url = "https://storage.googleapis.com/antigravity-public/cli_x64";
  await expect(downloadAgyCli({ signal: new AbortController().signal, platform: host, arch: "x64", musl: false, env, home,
    fetchFn: releaseServer(build, url, Buffer.from("tampered"), "a".repeat(128)) })).rejects.toThrow("Checksum verification failed");
  expect(fs.readdirSync(path.dirname(binary))).toEqual([]);
  fs.rmSync(home, { recursive: true, force: true });
});

// A dangling ~/.local/bin/agy is skipped by discovery, so install runs; the
// binary must replace that link, never write through it to its target.
it.skipIf(host === "win32")("replaces a dangling symlink at the install path instead of writing through it", async () => {
  const home = tempHome();
  const { env, binary: expected } = installTarget(home);
  const outside = path.join(home, "outside", "agy-target");
  fs.mkdirSync(path.dirname(expected), { recursive: true });
  fs.symlinkSync(outside, expected);
  const url = "https://storage.googleapis.com/antigravity-public/cli_x64";
  const binary = await downloadAgyCli({ signal: new AbortController().signal, platform: host, arch: "x64", musl: false, env, home,
    fetchFn: releaseServer(build, url, Buffer.from("fake agy binary")) });
  expect(fs.lstatSync(binary).isSymbolicLink()).toBe(false);
  expect(fs.existsSync(outside)).toBe(false);
  fs.rmSync(home, { recursive: true, force: true });
});

it("ships no shell download-and-run line in the installer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "agy-cli-lifecycle.ts"), "utf8");
  expect(source).not.toMatch(/powershell|ExecutionPolicy|\biex\b|\|\s*bash/i);
});

it("requires the located binary to answer --version even when the installer exits successfully", async () => {
  const child = fakeProcess((_file, _args, child) => child.close(0));
  const options = { download: async () => "fake agy", spawnChild: child as unknown as typeof spawn };
  await expect(installAgyCli({ ...options, locate: () => undefined })).rejects.toThrow("agy was not found");
  await expect(installAgyCli({ ...options, locate: () => "fake agy" })).rejects.toThrow("--version did not report");
  expect(child).toHaveBeenLastCalledWith("fake agy", ["--version"], expect.anything());
});

it("accepts an installed, answering CLI even when agy install exits nonzero", async () => {
  const log = vi.fn();
  const child = fakeProcess((_file, args, child) => {
    const setup = args[0] === "install";
    if (setup) child.stderr.write("Shell integration failed\n");
    else child.stdout.write("1.5.8\n");
    child.close(setup ? 1 : 0);
  });
  const beforeVersion = vi.fn(async () => {
    expect(child.mock.calls).toEqual([["fake agy", ["install"], expect.anything()]]);
  });
  await expect(installAgyCli({ download: async () => "fake agy", locate: () => "fake agy",
    beforeVersion, spawnChild: child as unknown as typeof spawn, log })).resolves.toEqual({ binary: "fake agy", version: "1.5.8" });
  expect(beforeVersion).toHaveBeenCalledWith("fake agy");
  expect(log).toHaveBeenCalledWith("Shell integration failed");
  expect(child).toHaveBeenNthCalledWith(1, "fake agy", ["install"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
});

it("cancels the Windows setup tree with taskkill and waits for exit", async () => {
  const controller = new AbortController();
  const installer = new FakeChild();
  const killer = new FakeChild();
  const child = vi.fn().mockReturnValueOnce(installer).mockReturnValueOnce(killer);
  const run = installAgyCli({ download: async () => "fake agy", signal: controller.signal,
    platform: "win32", spawnChild: child as typeof spawn, locate: () => undefined });
  const rejected = expect(run).rejects.toThrow("Installation cancelled.");
  await vi.waitFor(() => expect(child).toHaveBeenCalledTimes(1));
  controller.abort(new Error("Installation cancelled."));
  installer.close(null);
  killer.close(0);
  await rejected;
  expect(child).toHaveBeenLastCalledWith(expect.stringMatching(/System32\\taskkill\.exe$/i), ["/PID", "61561", "/T", "/F"], expect.anything());
  expect(installer.kill).not.toHaveBeenCalled();
});

it("cancels the POSIX process group started for agy install", async () => {
  const controller = new AbortController();
  const installer = new FakeChild();
  const child = vi.fn().mockReturnValue(installer);
  const killGroup = vi.fn(() => { queueMicrotask(() => installer.close(null)); return true; });
  const run = installAgyCli({ download: async () => "fake agy", platform: "linux", signal: controller.signal,
    spawnChild: child as typeof spawn, killGroup, locate: () => undefined });
  await vi.waitFor(() => expect(child).toHaveBeenCalledTimes(1));
  controller.abort(new Error("Installation cancelled."));
  await expect(run).rejects.toThrow("Installation cancelled.");
  expect(child).toHaveBeenCalledWith("fake agy", ["install"], expect.objectContaining({ detached: true }));
  expect(killGroup).toHaveBeenCalledWith(-61561, "SIGKILL");
});

it("records one bounded update attempt per AFK upgrade, including failure", async () => {
  vi.useFakeTimers();
  let last: string | undefined;
  const remember = async (version: string) => { last = version; };
  const child = new FakeChild();
  const log = vi.fn();
  const killGroup = vi.fn(() => { child.close(null); return true; });
  const run = vi.fn((file: string, args: string[], opts: Parameters<typeof runAgyCommand>[2]) =>
    runAgyCommand(file, args, { ...opts, platform: "linux", spawnChild: vi.fn().mockReturnValue(child) as typeof spawn, killGroup }));
  await updateAgyCliOnUpgrade("fake agy", "4.17.2", last, remember, log, { run });
  expect(last).toBe("4.17.2");
  expect(run).not.toHaveBeenCalled();
  const upgrade = updateAgyCliOnUpgrade("fake agy", "4.17.3", last, remember, log, { run });
  await vi.advanceTimersByTimeAsync(19_999);
  expect(killGroup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await upgrade;
  expect(killGroup).toHaveBeenCalledWith(-61561, "SIGKILL");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("continuing with the installed CLI"));
  expect(last).toBe("4.17.3");
  await updateAgyCliOnUpgrade("fake agy", "4.17.3", last, remember, log, { run });
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith("fake agy", ["update"], { timeoutMs: 20_000, log });
});
