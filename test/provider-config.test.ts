import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_CONFIG_FILES, resolveProviderConfigFile } from "../src/provider-config";
import { readRemoteProjectFile, writeRemoteProjectFile } from "../src/remote-files";
import { resolveTreePath, type TreePathFs } from "../src/file-tree";
import { INBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, remoteRequiresBoundSession } from "../src/remote-policy";
import { parseRelayFrame } from "../src/remote-frames";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(provider: string = "grok") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
  roots.push(home);
  const target = resolveProviderConfigFile(provider, home);
  if (!target.ok) throw new Error(target.reason);
  fs.mkdirSync(path.dirname(target.root.filePath), { recursive: true });
  fs.writeFileSync(target.root.filePath, "original = true\n");
  fs.writeFileSync(path.join(path.dirname(target.root.filePath), "auth.json"), "PRIVATE");
  const pathFs: TreePathFs = {
    realpathSync: (p) => fs.realpathSync(p), existsSync: fs.existsSync,
    statSync: fs.statSync, readdirSync: vi.fn(() => { throw new Error("must never list config directories"); }),
  };
  return { ...target, pathFs };
}

describe("provider config file roots", () => {
  it("allows exactly the three provider identities, never paths or object properties", () => {
    expect(PROVIDER_CONFIG_FILES).toEqual({ grok: ".grok/config.toml", codex: ".codex/config.toml", claude: ".claude/settings.json" });
    for (const provider of ["auth.json", "../auth.json", "grok/../auth.json", ".grok/config.toml", "__proto__", "constructor", "toString", "Grok", "", null, {}]) {
      expect(resolveProviderConfigFile(provider).ok).toBe(false);
    }
    expect(resolveProviderConfigFile("codex", "C:\\Users\\test", "win32")).toMatchObject({ root: { filePath: "C:\\Users\\test\\.codex\\config.toml" } });
  });

  it.each(Object.keys(PROVIDER_CONFIG_FILES))("%s uses the existing reader, writer, stamp and identity guards", (provider) => {
    const target = fixture(provider);
    const read = readRemoteProjectFile(target.root, target.relPath, process.platform, target.pathFs);
    expect(read.ok).toBe(true);
    if (!read.ok || !read.stamp) throw new Error("no edit metadata");
    const opts = { expectedAbsPath: read.absPath!, pathFs: target.pathFs };
    expect(writeRemoteProjectFile(target.root, target.relPath, "next = true\n", read.stamp, { ...opts, expectedAbsPath: path.join(path.dirname(read.absPath!), "auth.json") }))
      .toMatchObject({ ok: false, reason: "workspace changed" });
    expect(writeRemoteProjectFile(target.root, target.relPath, "next = true\n", read.stamp, opts).ok).toBe(true);
    expect(writeRemoteProjectFile(target.root, target.relPath, "stale", read.stamp, opts)).toEqual({ ok: false, reason: "changed" });
    expect(fs.readFileSync(target.root.filePath, "utf8")).toBe("next = true\n");
    expect(target.pathFs.readdirSync).not.toHaveBeenCalled();
  });

  it.each(["auth.json", "../auth.json", "../outside.txt", "..\\auth.json", "config.toml/../auth.json", "./config.toml", "", ".", "config.toml/subfile"])("refuses %j before reading or writing bytes", (input) => {
    const target = fixture();
    const readBytes = vi.fn(() => Buffer.from("PRIVATE"));
    const writeBytes = vi.fn();
    expect(resolveTreePath(target.root, input).ok).toBe(false);
    expect(readRemoteProjectFile(target.root, input, process.platform, target.pathFs, readBytes).ok).toBe(false);
    expect(writeRemoteProjectFile(target.root, input, "changed", { mtimeMs: 1, size: 1 }, {
      expectedAbsPath: target.root.filePath, pathFs: target.pathFs, readFileSync: readBytes, writeFileSync: writeBytes,
    }).ok).toBe(false);
    expect(readBytes).not.toHaveBeenCalled();
    expect(writeBytes).not.toHaveBeenCalled();
    expect(target.pathFs.readdirSync).not.toHaveBeenCalled();
  });

  it("refuses a config symlink to its auth sibling before reading it", () => {
    const target = fixture();
    const realpath = target.pathFs.realpathSync;
    target.pathFs.realpathSync = (p) => p === target.root.filePath ? path.join(path.dirname(p), "auth.json") : realpath(p);
    const readBytes = vi.fn(() => Buffer.from("PRIVATE"));
    expect(readRemoteProjectFile(target.root, target.relPath, process.platform, target.pathFs, readBytes)).toMatchObject({ ok: false });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rechecks the exact file after stat and before reading", () => {
    const target = fixture();
    let swapped = false;
    const realpath = target.pathFs.realpathSync;
    target.pathFs.realpathSync = (p) => swapped && p === target.root.filePath ? path.join(path.dirname(p), "auth.json") : realpath(p);
    target.pathFs.statSync = (p) => { const st = fs.statSync(p); swapped = true; return st; };
    const readBytes = vi.fn(() => Buffer.from("PRIVATE"));
    expect(readRemoteProjectFile(target.root, target.relPath, process.platform, target.pathFs, readBytes).ok).toBe(false);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("refuses a final symlink swap without replacing either file", () => {
    const target = fixture();
    const read = readRemoteProjectFile(target.root, target.relPath);
    if (!read.ok || !read.stamp) throw new Error("read failed");
    let swapped = false;
    const realpath = target.pathFs.realpathSync;
    target.pathFs.realpathSync = (p) => swapped && p === target.root.filePath ? path.join(path.dirname(p), "auth.json") : realpath(p);
    const rename = vi.fn();
    expect(writeRemoteProjectFile(target.root, target.relPath, "next", read.stamp, {
      expectedAbsPath: read.absPath!, pathFs: target.pathFs,
      writeFileSync: (p, bytes, opts) => { fs.writeFileSync(p, bytes, opts); swapped = true; }, renameSync: rename,
    }).ok).toBe(false);
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(target.root.filePath, "utf8")).toBe("original = true\n");
  });

  it("reports missing files and read/write failures through the shared results", () => {
    const target = fixture();
    expect(readRemoteProjectFile(target.root, target.relPath, process.platform, target.pathFs, () => { throw new Error("read denied"); }))
      .toEqual({ ok: false, reason: "read denied" });
    const read = readRemoteProjectFile(target.root, target.relPath);
    if (!read.ok || !read.stamp) throw new Error("read failed");
    expect(writeRemoteProjectFile(target.root, target.relPath, "next", read.stamp, {
      expectedAbsPath: read.absPath!, writeFileSync: () => { throw new Error("write denied"); },
    })).toEqual({ ok: false, reason: "write denied" });
    fs.unlinkSync(target.root.filePath);
    expect(readRemoteProjectFile(target.root, target.relPath)).toEqual({ ok: false, reason: "not found" });
    expect(writeRemoteProjectFile(target.root, target.relPath, "next", read.stamp, { expectedAbsPath: read.absPath! }).ok).toBe(false);
    expect(fs.existsSync(target.root.filePath)).toBe(false);
  });
});

describe("provider config wire decisions", () => {
  const parse = (msg: unknown) => parseRelayFrame(JSON.stringify({ t: "msg", clientId: "phone", msg }));
  it("uses the file editing tier and binds only restart to a conversation", () => {
    expect(INBOUND_DISPOSITION.readProviderConfig).toBe("view");
    expect(INBOUND_DISPOSITION.writeProviderConfig).toBe(INBOUND_DISPOSITION.writeProjectFile);
    expect(INBOUND_DISPOSITION.restartProviderSession).toBe("propose");
    expect(remoteRequiresBoundSession("readProviderConfig")).toBe(false);
    expect(remoteRequiresBoundSession("writeProviderConfig")).toBe(false);
    expect(remoteRequiresBoundSession("restartProviderSession")).toBe(true);
    expect(OUTBOUND_PROJECT_AUTH.providerConfigContent).toBe("none");
  });
  it("accepts new types and rejects unknown provider ids, missing stamps and invalid restarts", () => {
    for (const provider of Object.keys(PROVIDER_CONFIG_FILES)) {
      expect(parse({ type: "readProviderConfig", provider })).not.toBeNull();
      const write = { type: "writeProviderConfig", provider, text: "abc", stamp: { mtimeMs: 1, size: 3 }, expectedAbsPath: "/home/user/.grok/config.toml" };
      expect(parse(write)).not.toBeNull();
      expect(parse({ ...write, stamp: undefined })).toBeNull();
      expect(parse({ ...write, stamp: { mtimeMs: null, size: 3 } })).toBeNull();
      expect(parse({ type: "restartProviderSession", provider, sessionId: "session-1" })).not.toBeNull();
      expect(parse({ type: "restartProviderSession", provider })).toBeNull();
    }
    for (const provider of ["auth.json", "../grok", "__proto__", null]) {
      expect(parse({ type: "readProviderConfig", provider })).toBeNull();
      expect(parse({ type: "writeProviderConfig", provider })).toBeNull();
    }
  });
});
