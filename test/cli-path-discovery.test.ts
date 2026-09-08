import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { locateClaudeCli } from "../src/claude-cli-locator";
import { locateCodexCli } from "../src/codex-cli-locator";
import { findCliOnPath, isCliFile } from "../src/cli-path";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execSync: vi.fn(() => { throw new Error("not on PATH"); }),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(execSync).mockReset().mockImplementation(() => { throw new Error("not on PATH"); });
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("CLI PATH discovery without a shell (#151)", () => {
  it.each(["grok", "claude", "codex"])("expands PATHEXT for bare %s on win32 and skips non-files", (name) => {
    const binary = `C:\\bin\\${name}.cmd`;
    const checked: string[] = [];
    expect(findCliOnPath(name, { PATH: "C:\\gone;C:\\directory;C:\\bin", PATHEXT: ".CMD;.EXE" }, "win32", (p) => {
      checked.push(p);
      if (p.startsWith("C:\\gone")) throw new Error("EACCES");
      return p === binary;
    })).toBe(binary);
    expect(checked).toContain(`C:\\directory\\${name}.cmd`);
    expect(execSync).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("finds a Windows %s.cmd and ignores an earlier directory with that name", (provider) => {
    const shim = `C:\\npm\\${provider}.cmd`;
    const native = `C:\\npm\\package\\${provider}.exe`;
    const isFile = (candidate: string) => [shim, native].some((p) => p.toLowerCase() === candidate.toLowerCase());
    const options = {
      platform: "win32" as const,
      env: { Path: "C:\\directory;\"C:\\npm\"", PATHEXT: ".COM;.EXE;.CMD;.BAT" },
      home: "C:\\empty",
      fs: {
        exists: (candidate: string) => isFile(candidate) || candidate.toLowerCase() === `c:\\directory\\${provider}.cmd`,
        isFile,
        readDir: () => [],
        readText: () => `@echo off\r\n"${native}" %*`,
      },
    };
    const found = provider === "claude" ? locateClaudeCli(options) : locateCodexCli(options);
    expect(found?.toLowerCase()).toBe(provider === "claude" ? native.toLowerCase() : shim.toLowerCase());
    // Claude may try `where claude.exe` first: its native-first priority is intentional.
    expect(vi.mocked(execSync).mock.calls.some(([command]) => command === `where ${provider}.cmd`)).toBe(false);
  });

  it("honors custom PATHEXT entries for an extensionless Windows lookup", () => {
    const binary = "C:\\bin\\codex.custom";
    expect(locateCodexCli({
      platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".CUSTOM;.CMD" }, home: "C:\\empty",
      fs: { exists: () => true, isFile: (p) => p.toLowerCase() === binary.toLowerCase(), readDir: () => [] },
    })?.toLowerCase()).toBe(binary.toLowerCase());
    expect(vi.mocked(execSync).mock.calls.some(([command]) => command === "where codex")).toBe(false);
  });

  it.each(["claude", "codex"] as const)("falls through to hidden execSync when %s has no PATH match", (provider) => {
    const binary = `C:\\shell\\${provider}.exe`;
    vi.mocked(execSync).mockReturnValue(`${binary}\r\n`);
    const options = {
      platform: "win32" as const, env: { PATH: "C:\\missing" }, home: "C:\\empty",
      fs: { exists: () => false, isFile: (p: string) => p === binary, readDir: () => [] },
    };
    expect(provider === "claude" ? locateClaudeCli(options) : locateCodexCli(options)).toBe(binary);
    expect(execSync).toHaveBeenCalledWith(expect.stringMatching(/^where /), expect.objectContaining({ windowsHide: true }));
  });

  it("scans Grok's PATH for a regular executable and retains the shell fallback", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grok-path-"));
    dirs.push(dir);
    const first = path.join(dir, "directory");
    const second = path.join(dir, "bin");
    const name = process.platform === "win32" ? "grok.cmd" : "grok";
    mkdirSync(path.join(first, name), { recursive: true });
    mkdirSync(second);
    const binary = path.join(second, name);
    writeFileSync(binary, "", { mode: 0o755 });
    // Inject the environment rather than stubbing process.env, the way every
    // other test in this file already does. Vitest runs test FILES as threads in
    // ONE process, so process.env is shared: a stub here - and the
    // unstubAllEnvs that cleans it up - reaches into whatever else is mid-test.
    // cli-locator.test.ts assigns HOME/USERPROFILE around its own assertions and
    // restores them in a finally, and the two clobbered each other. The flake is
    // invisible exactly where it is checked: with the stub lost, the lookup
    // falls through to the real ~/.grok/bin, which every dev box has and no CI
    // box does, so the suite is green in CI and red on the machine releasing it.
    const env = { PATH: [first, second].join(path.delimiter), PATHEXT: ".COM;.EXE;.CMD;.BAT" };

    expect(findCliOnPath("grok", env, process.platform)?.toLowerCase()).toBe(binary.toLowerCase());
    expect(execSync).not.toHaveBeenCalled();
    // A directory named exactly like the binary is not a hit.
    expect(isCliFile(path.join(first, name))).toBe(false);

    vi.mocked(execSync).mockReturnValue(binary + "\n");
    expect(findCliOnPath("grok", { PATH: "" }, process.platform)).toBe(binary);
    expect(execSync).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ windowsHide: true }));
  });
});
