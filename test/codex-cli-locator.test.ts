import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { CODEX_MANAGED_TAG } from "../src/codex-managed-installer";
import { locateCodexCli, resolveCodexHome, type CodexLocatorFs } from "../src/codex-cli-locator";

function fakeFs(files: string[], dirs: Record<string, string[]> = {}): CodexLocatorFs {
  const set = new Set(files);
  return {
    exists: (value) => set.has(value) || Object.prototype.hasOwnProperty.call(dirs, value),
    isFile: (value) => set.has(value),
    readDir: (value) => dirs[value] ?? [],
  };
}

describe("locateCodexCli", () => {
  it("uses a valid configured override before PATH", () => {
    const configured = "C:\\tools\\codex.exe";
    expect(locateCodexCli({ configuredPath: configured, platform: "win32", fs: fakeFs([configured]), which: () => "C:\\path\\codex.cmd" }))
      .toBe(configured);
  });

  it("returns undefined for an invalid configured override without falling through", () => {
    expect(locateCodexCli({ configuredPath: "missing", fs: fakeFs([]), which: () => "/bin/codex" })).toBeUndefined();
  });

  it("checks codex command variants on Windows PATH", () => {
    const found = "C:\\npm\\codex.cmd";
    const asked: string[] = [];
    expect(locateCodexCli({
      platform: "win32",
      fs: fakeFs([found]),
      which: (name) => { asked.push(name); return name === "codex.cmd" ? found : undefined; },
    })).toBe(found);
    expect(asked).toEqual(["codex.cmd"]);
  });

  it("prefers codex.cmd over the extensionless npm shim Windows cannot launch", () => {
    // What `npm i -g @openai/codex` actually leaves on PATH: both files, with
    // `where codex` naming the sh script first. Handing that path to spawn or to
    // a terminal's shellPath fails - cmd.exe is the only thing that resolves it.
    const script = "C:\npm\codex";
    const cmd = "C:\npm\codex.cmd";
    expect(locateCodexCli({
      platform: "win32",
      fs: fakeFs([script, cmd]),
      which: (name) => (name === "codex" ? script : name === "codex.cmd" ? cmd : undefined),
    })).toBe(cmd);
  });

  it("selects the newest ChatGPT extension bundle and any platform bin directory", () => {
    const home = "C:\\Users\\Dev";
    const extensions = path.join(home, ".vscode", "extensions");
    const oldBin = path.join(extensions, "openai.chatgpt-1.9.0", "bin");
    const newBin = path.join(extensions, "openai.chatgpt-1.10.0", "bin");
    const candidate = path.join(newBin, "windows-x86_64", "codex.exe");
    const fs = fakeFs([candidate], {
      [extensions]: ["openai.chatgpt-1.9.0", "publisher.other-9.0.0", "openai.chatgpt-1.10.0"],
      [oldBin]: ["windows-x86_64"],
      [newBin]: ["windows-x86_64"],
    });
    expect(locateCodexCli({ home, platform: "win32", fs, which: () => undefined })).toBe(candidate);
  });

  it("selects the newest ChatGPT bundle across VS Code, Cursor, and remote VS Code roots", () => {
    const home = "C:\\Users\\Dev";
    const vscode = path.join(home, ".vscode", "extensions");
    const cursor = path.join(home, ".cursor", "extensions");
    const server = path.join(home, ".vscode-server", "extensions");
    const vscodeBin = path.join(vscode, "openai.chatgpt-2.0.0", "bin");
    const cursorBin = path.join(cursor, "openai.chatgpt-4.0.0", "bin");
    const serverBin = path.join(server, "openai.chatgpt-3.0.0", "bin");
    const newest = path.join(cursorBin, "windows-x86_64", "codex.exe");
    const fs = fakeFs([
      path.join(vscodeBin, "windows-x86_64", "codex.exe"),
      newest,
      path.join(serverBin, "windows-x86_64", "codex.exe"),
    ], {
      [vscode]: ["openai.chatgpt-2.0.0"],
      [cursor]: ["openai.chatgpt-4.0.0"],
      [server]: ["openai.chatgpt-3.0.0"],
      [vscodeBin]: ["windows-x86_64"],
      [cursorBin]: ["windows-x86_64"],
      [serverBin]: ["windows-x86_64"],
    });
    expect(locateCodexCli({ home, platform: "win32", fs, which: () => undefined })).toBe(newest);
  });

  it("never hands Windows a bundled Linux binary (multi-platform bundle)", () => {
    // The real ChatGPT extension ships every platform side by side; the
    // linux dir sorts first and its bare `codex` IS a real file — exactly
    // the pick that produced "not recognized as an internal or external
    // command" in the field.
    const home = "C:\\Users\\Dev";
    const extensions = path.join(home, ".vscode", "extensions");
    const bin = path.join(extensions, "openai.chatgpt-5.0.0", "bin");
    const linuxBinary = path.join(bin, "linux-x86_64", "codex");
    const windowsBinary = path.join(bin, "windows-x86_64", "codex.exe");
    const fs = fakeFs([linuxBinary, windowsBinary], {
      [extensions]: ["openai.chatgpt-5.0.0"],
      [bin]: ["linux-x86_64", "macos-aarch64", "windows-x86_64"],
    });
    expect(locateCodexCli({ home, platform: "win32", arch: "x64", fs, which: () => undefined }))
      .toBe(windowsBinary);
    // A bundle with ONLY foreign-platform binaries yields nothing on win32
    // rather than an unrunnable file.
    const foreignOnly = fakeFs([linuxBinary], {
      [extensions]: ["openai.chatgpt-5.0.0"],
      [bin]: ["linux-x86_64", "macos-aarch64"],
    });
    expect(locateCodexCli({ home, platform: "win32", arch: "x64", fs: foreignOnly, which: () => undefined }))
      .toBeUndefined();
    // Other platforms keep matching their own dirs.
    expect(locateCodexCli({ home, platform: "linux", arch: "x64", fs, which: () => undefined }))
      .toBe(linuxBinary);
  });

  it("prefers the host architecture dir, keeping the other as fallback", () => {
    const home = "C:\\Users\\Dev";
    const extensions = path.join(home, ".vscode", "extensions");
    const bin = path.join(extensions, "openai.chatgpt-5.0.0", "bin");
    const x64Binary = path.join(bin, "windows-x86_64", "codex.exe");
    const arm64Binary = path.join(bin, "windows-aarch64", "codex.exe");
    const both = fakeFs([x64Binary, arm64Binary], {
      [extensions]: ["openai.chatgpt-5.0.0"],
      [bin]: ["windows-aarch64", "windows-x86_64"],
    });
    expect(locateCodexCli({ home, platform: "win32", arch: "arm64", fs: both, which: () => undefined }))
      .toBe(arm64Binary);
    expect(locateCodexCli({ home, platform: "win32", arch: "x64", fs: both, which: () => undefined }))
      .toBe(x64Binary);
    // arm64 host with only an x64 build still gets it (emulation fallback).
    const x64Only = fakeFs([x64Binary], {
      [extensions]: ["openai.chatgpt-5.0.0"],
      [bin]: ["windows-x86_64"],
    });
    expect(locateCodexCli({ home, platform: "win32", arch: "arm64", fs: x64Only, which: () => undefined }))
      .toBe(x64Binary);
  });

  it("uses the managed copy only after PATH and every ChatGPT bundle", () => {
    const home = "C:\\Users\\Dev";
    const storage = "C:\\extension-storage";
    const managed = path.join(storage, "codex-managed", CODEX_MANAGED_TAG, "bin", "codex.exe");
    const extensions = path.join(home, ".vscode", "extensions");
    const bundleBin = path.join(extensions, "openai.chatgpt-3.0.0", "bin");
    const bundled = path.join(bundleBin, "windows-x86_64", "codex.exe");
    const fsWithBoth = fakeFs([managed, bundled], {
      [extensions]: ["openai.chatgpt-3.0.0"],
      [bundleBin]: ["windows-x86_64"],
    });

    expect(locateCodexCli({ home, platform: "win32", managedStorageRoot: storage, fs: fsWithBoth, which: () => undefined }))
      .toBe(bundled);
    expect(locateCodexCli({ home, platform: "win32", managedStorageRoot: storage, fs: fakeFs([managed]), which: () => undefined }))
      .toBe(managed);
    expect(locateCodexCli({ home, platform: "win32", managedStorageRoot: storage, fs: fakeFs([managed, "C:\\path\\codex.exe"]), which: () => "C:\\path\\codex.exe" }))
      .toBe("C:\\path\\codex.exe");
  });
});

describe("resolveCodexHome", () => {
  it("uses CODEX_HOME before the platform user home", () => {
    expect(resolveCodexHome({ CODEX_HOME: "D:\\codex-data", USERPROFILE: "C:\\Users\\dev" }, "win32"))
      .toBe("D:\\codex-data");
  });

  it("mirrors the platform home fallback", () => {
    expect(resolveCodexHome({ USERPROFILE: "C:\\Users\\dev" }, "win32"))
      .toBe(path.join("C:\\Users\\dev", ".codex"));
    expect(resolveCodexHome({ HOME: "/home/dev" }, "linux"))
      .toBe(path.join("/home/dev", ".codex"));
  });
});
