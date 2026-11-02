import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepseekManagedDir, deepseekNodeAsset, deepseekRuntimePaths, installManagedDeepSeek, locateDeepSeek, nodeChecksum, DEEPSEEK_VERSION } from "../src/deepseek-managed-installer";
import { DeepSeekBackend } from "../src/deepseek-backend";

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-install-test-")); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// A stored zip with real central-directory offsets, for the existing streaming extractor.
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [filename, text] of Object.entries(files)) {
    const name = Buffer.from(filename), data = Buffer.from(text), local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, name, data); central.push(entry, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
function tar(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const header = Buffer.alloc(512), data = Buffer.from(text);
    header.write(name); header.write("0000755", 100); header.write("0000000", 108); header.write("0000000", 116);
    header.write(data.length.toString(8).padStart(11, "0"), 124); header.write("00000000000", 136);
    header.fill(32, 148, 156); header[156] = 48; header.write("ustar", 257);
    const checksum = header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0");
    header.write(checksum + "\0 ", 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
describe("pinned private DeepSeek runtime", () => {
  it("locks the entire public dependency tree, including native addons", () => {
    const assets = path.join(__dirname, "../resources/deepseek");
    const manifest = JSON.parse(fs.readFileSync(path.join(assets, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(assets, "package-lock.json"), "utf8"));
    expect(manifest.dependencies["@deepseek-ai/dsh"]).toBe(DEEPSEEK_VERSION);
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
    expect(lock.packages["node_modules/@deepseek-ai/dsh"].version).toBe(DEEPSEEK_VERSION);
    for (const entry of Object.values(lock.packages) as any[]) if (entry.resolved) {
      expect(entry.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//); expect(entry.integrity).toMatch(/^sha512-/);
    }
    expect(Object.keys(lock.packages).some(v => v.endsWith("/node-pty"))).toBe(true);
  });
  it("configured root wins without PATH or old-version adoption", () => {
    const storageRoot = root(); const pin = deepseekManagedDir(storageRoot);
    const isFile = (file: string) => file.startsWith(pin + path.sep);
    const readVersion = () => DEEPSEEK_VERSION;
    expect(locateDeepSeek({ storageRoot, isFile, readVersion })).toBe(pin);
    expect(locateDeepSeek({ storageRoot, configuredPath: path.join(storageRoot, "missing"), isFile })).toBeUndefined();
    expect(locateDeepSeek({ isFile })).toBeUndefined();
  });
  it("extracts only after verification and publishes only after pinned npm ci succeeds", async () => {
    const storageRoot = root(), asset = deepseekNodeAsset("win32", "x64");
    const archive = zip({ [`${asset.stem}/node.exe`]: "fake node", [`${asset.stem}/node_modules/npm/bin/npm-cli.js`]: "fake npm" });
    const urls: string[] = [];
    const runNpm = vi.fn(async (stage: string) => {
      expect(fs.existsSync(deepseekManagedDir(storageRoot))).toBe(false);
      expect(fs.readFileSync(deepseekRuntimePaths(stage, "win32").node, "utf8")).toBe("fake node");
      const cli = deepseekRuntimePaths(stage, "win32").cli; fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, "fake dsh");
      fs.writeFileSync(path.join(path.dirname(cli), "../package.json"), JSON.stringify({ version: DEEPSEEK_VERSION }));
    });
    const installed = await installManagedDeepSeek({ storageRoot, platform: "win32", arch: "x64", signal: new AbortController().signal, runNpm,
      download: async (url, file) => { urls.push(url); const data = url.endsWith("SHASUMS256.txt") ? Buffer.from(`${hash(archive)}  ${asset.file}\n`) : archive; fs.writeFileSync(file, data); return hash(data); },
    });
    expect(urls).toEqual([asset.checksums, asset.url]); expect(runNpm).toHaveBeenCalledOnce();
    expect(locateDeepSeek({ configuredPath: installed, platform: "win32" })).toBe(installed);
    expect(fs.readdirSync(path.dirname(installed))).toEqual([path.basename(installed)]);
  });
  it("restores private npm launchers after POSIX tar extraction", async () => {
    const storageRoot = root(), asset = deepseekNodeAsset("linux", "x64");
    const archive = gzipSync(tar({ [asset.stem + "/bin/node"]: "fake node",
      [asset.stem + "/lib/node_modules/npm/bin/npm-cli.js"]: "fake npm" }));
    const installed = await installManagedDeepSeek({ storageRoot, platform: "linux", arch: "x64", signal: new AbortController().signal,
      download: async (url, file) => {
        const data = url.endsWith("SHASUMS256.txt") ? Buffer.from(hash(archive) + "  " + asset.file + "\n") : archive;
        fs.writeFileSync(file, data); return hash(data);
      },
      runNpm: async stage => {
        expect(fs.readFileSync(path.join(stage, "node/bin/npm"), "utf8")).toContain('../lib/node_modules/npm/bin/npm-cli.js');
        expect(fs.readFileSync(path.join(stage, "node/bin/npx"), "utf8")).toContain('../lib/node_modules/npm/bin/npx-cli.js');
        const cli = deepseekRuntimePaths(stage, "linux").cli; fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, "fake dsh");
        fs.writeFileSync(path.join(path.dirname(cli), "../package.json"), JSON.stringify({ version: DEEPSEEK_VERSION }));
      },
    });
    expect(locateDeepSeek({ configuredPath: installed, platform: "linux" })).toBe(installed);
  });
  it.each(["mismatch", "download failure", "cancelled"])("cleans staging and never runs npm after %s", async failure => {
    const storageRoot = root(), controller = new AbortController(), runNpm = vi.fn();
    const asset = deepseekNodeAsset("win32", "x64");
    await expect(installManagedDeepSeek({ storageRoot, platform: "win32", arch: "x64", signal: controller.signal, runNpm,
      download: async (url, file) => {
        fs.writeFileSync(file, `${"a".repeat(64)}  ${asset.file}\n`);
        if (url.endsWith("SHASUMS256.txt")) return "a".repeat(64);
        if (failure === "download failure") throw new Error("offline");
        if (failure === "cancelled") { controller.abort(); controller.signal.throwIfAborted(); }
        return "b".repeat(64);
      },
    })).rejects.toThrow();
    expect(runNpm).not.toHaveBeenCalled(); expect(fs.readdirSync(path.dirname(deepseekManagedDir(storageRoot)))).toEqual([]);
  });
  it("rejects missing/duplicate checksums and isolates both compositions", () => {
    expect(() => nodeChecksum("", "node.zip")).toThrow();
    const sum = `${"a".repeat(64)}  node.zip\n`; expect(() => nodeChecksum(sum + sum, "node.zip")).toThrow();
    const storageRoot = root();
    const args = { cliPath: storageRoot, cwd: storageRoot, env: { ELECTRON_RUN_AS_NODE: "1", DSH_HOME: "/foreign", DSH_SYSTEM_PROMPT: "override",
      VSCODE_IPC_HOOK: "\\\\.\\pipe\\vscode-ipc", VSCODE_PID: "1", PATH: "/bin" } };
    const full = new DeepSeekBackend({ storageRoot }).spawn(args);
    const minimal = new DeepSeekBackend({ storageRoot, harness: "minimal" }).spawn(args);
    expect(full.env.DSH_HOME).not.toBe(minimal.env.DSH_HOME);
    expect(full.args.slice(1, 3)).toEqual(["--profile", "acp"]);
    expect(minimal.args).toContain("sdk-minimal"); expect(minimal.args).toContain("--patch");
    expect(minimal.env.ELECTRON_RUN_AS_NODE).toBeUndefined(); expect(minimal.env.DSH_SYSTEM_PROMPT).toBeUndefined();
    // With VS Code's IPC hook inherited, dsh 0.2.1-rc.5 never answers initialize.
    for (const spawned of [full, minimal]) {
      expect(Object.keys(spawned.env).filter(k => k.startsWith("VSCODE_"))).toEqual([]);
      expect(spawned.env.PATH).toBe("/bin");
    }
    expect(fs.readFileSync(minimal.args.at(-1)!, "utf8")).toContain("@deepseek-ai/dsh-acp");
  });
  it.each(["win32", "linux", "darwin"] as const)("uses the official local shell overlay only for Default on %s", platform => {
    const storageRoot = root();
    const options = { cliPath: storageRoot, cwd: storageRoot, env: {} };
    const full = new DeepSeekBackend({ storageRoot, platform }).spawn(options);
    expect(full.args.slice(1, 3)).toEqual(["--profile", "acp"]);
    if (platform === "win32") {
      expect(full.args.at(-2)).toBe("--patch");
      const overlay = fs.readFileSync(full.args.at(-1)!, "utf8");
      expect(overlay).toContain("id: pwsh-sandbox");
      expect(overlay).toContain("name: '@deepseek-ai/dsh-pwsh-local'");
      expect(overlay).not.toMatch(/sandbox-policy|danger-full-access|approval:/);
      expect(full.args.at(-1)!.startsWith(full.env.DSH_HOME! + path.sep)).toBe(true);
    } else expect(full.args).not.toContain("--patch");
    const minimal = new DeepSeekBackend({ storageRoot, platform, harness: "minimal" }).spawn(options);
    expect(minimal.args).toContain("sdk-minimal");
    expect(fs.readFileSync(minimal.args.at(-1)!, "utf8")).not.toContain("dsh-pwsh-local");
    expect(full.env.DSH_PERMISSION_MODE).toBeUndefined();
  });
});
