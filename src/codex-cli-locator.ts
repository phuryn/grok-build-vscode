import { existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import { codexManagedBinaryName, codexManagedBinaryPath, codexManagedRoot } from "./codex-managed-installer";

export interface CodexLocatorFs {
  exists(path: string): boolean;
  readDir(path: string): string[];
  isFile(path: string): boolean;
}

export interface CodexLocatorOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  /** Extension-owned storage root. Checked last, after every user install. */
  managedStorageRoot?: string;
  fs?: CodexLocatorFs;
  which?: (name: string) => string | undefined;
}

/** Resolve Codex's data home: CODEX_HOME first, then the platform's ordinary
 * user home plus `.codex`, matching the CLI's generated_images layout. */
export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const fromEnv = platform === "win32" ? env.USERPROFILE : env.HOME;
  return path.join(fromEnv || homedir(), ".codex");
}

const defaultFs: CodexLocatorFs = {
  exists: existsSync,
  readDir: (dir) => readdirSync(dir),
  isFile: (file) => {
    try { return statSync(file).isFile(); } catch { return false; }
  },
};

function defaultWhich(name: string, platform: NodeJS.Platform): string | undefined {
  try {
    const command = platform === "win32" ? `where ${name}` : `command -v ${name}`;
    return execSync(command, { encoding: "utf8" }).trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function versionParts(name: string): number[] {
  const match = /openai\.chatgpt-(\d+(?:\.\d+)*)/i.exec(name);
  return match ? match[1].split(".").map(Number) : [];
}

function compareVersionsDesc(a: string, b: string): number {
  const av = versionParts(a);
  const bv = versionParts(b);
  const length = Math.max(av.length, bv.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (bv[i] ?? 0) - (av[i] ?? 0);
    if (diff) return diff;
  }
  return b.localeCompare(a);
}

/**
 * The ChatGPT extension bundle ships EVERY platform's binary side by side
 * (bin/linux-x86_64/codex next to bin/windows-x86_64/codex.exe), so the
 * host platform must filter directories — on win32 the bare `codex` in a
 * linux dir is a real file that "exists" and then fails to execute.
 */
function platformDirMatches(dir: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /win/i.test(dir);
  if (platform === "darwin") return /darwin|macos|apple/i.test(dir);
  return /linux/i.test(dir);
}

function archRank(dir: string, arch: string): number {
  const preferred = arch === "arm64" ? "aarch64" : "x86_64";
  // Non-matching arch stays as a fallback (x64 emulation on arm64 hosts),
  // ranked after an exact match rather than excluded.
  return dir.toLowerCase().includes(preferred) ? 0 : 1;
}

function bundledCandidates(
  root: string,
  fs: CodexLocatorFs,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const names = platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  const roots = [
    path.join(root, ".vscode", "extensions"),
    path.join(root, ".cursor", "extensions"),
    path.join(root, ".vscode-server", "extensions"),
  ];
  const extensions = roots.flatMap((extensionsRoot) =>
    fs.exists(extensionsRoot)
      ? fs.readDir(extensionsRoot)
        .filter((name) => /^openai\.chatgpt-/i.test(name))
        .map((name) => ({ extensionsRoot, name }))
      : [],
  ).sort((a, b) => compareVersionsDesc(a.name, b.name));
  const out: string[] = [];
  for (const extension of extensions) {
    const bin = path.join(extension.extensionsRoot, extension.name, "bin");
    if (!fs.exists(bin)) continue;
    const platformDirs = fs.readDir(bin)
      .filter((dir) => platformDirMatches(dir, platform))
      .sort((a, b) => archRank(a, arch) - archRank(b, arch));
    for (const platformDir of platformDirs) {
      for (const name of names) out.push(path.join(bin, platformDir, name));
    }
  }
  return out;
}

export function locateCodexCli(options: CodexLocatorOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const configured = options.configuredPath?.trim();
  if (configured) return fs.isFile(configured) ? configured : undefined;

  // Windows first, and the ORDER is the whole point. `npm i -g @openai/codex`
  // installs two shims side by side: `codex` (a POSIX sh script, for Git Bash)
  // and `codex.cmd`. Windows cannot execute the extensionless one — CreateProcess
  // rejects it (`spawn` reports ENOENT), and only cmd.exe reaches it, by appending
  // PATHEXT and finding the .cmd. Asking for the bare name first meant `where
  // codex` returned that script and we handed an unlaunchable path to
  // `createTerminal({ shellPath })` for `codex login`, which fails with nothing
  // to click. `cli-locator.ts` has always put `grok.cmd` first for this reason.
  const names = platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  for (const name of names) {
    const found = (options.which ?? ((candidate) => defaultWhich(candidate, platform)))(name);
    if (found && fs.isFile(found)) return found;
  }

  const home = options.home || (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  for (const candidate of bundledCandidates(home, fs, platform, options.arch ?? process.arch)) {
    if (fs.isFile(candidate)) return candidate;
  }
  if (options.managedStorageRoot) {
    const managed = codexManagedBinaryPath(options.managedStorageRoot, platform);
    if (fs.isFile(managed)) return managed;
    // The install directory carries the pinned tag, so moving the pin renames
    // it out from under someone who installed Codex through us: their working
    // binary is still on disk and simply stops counting. On a cloud machine
    // that is unrecoverable — `installCodex` is host-local, so the phone gets
    // "Codex is missing at the desk" and no button — and Codex would appear to
    // vanish on an update. So an install WE made still resolves.
    //
    // Ranking between leftovers does not matter: a successful install prunes
    // the others, so there is at most one, and any binary we put there runs.
    // Determinism does, hence the sort. Being a version behind is visible and
    // fixable, which is the whole point — the update action is right there.
    const root = codexManagedRoot(options.managedStorageRoot);
    const binary = codexManagedBinaryName(platform);
    let entries: string[] = [];
    try { entries = [...fs.readDir(root)].sort().reverse(); } catch { /* none installed */ }
    for (const entry of entries) {
      const candidate = path.join(root, entry, "bin", binary);
      if (fs.isFile(candidate)) return candidate;
    }
  }
  return undefined;
}
