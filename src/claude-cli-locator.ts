import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

export interface ClaudeLocatorFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
  readText?(path: string): string | undefined;
}

export interface ClaudeLocatorOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fs?: ClaudeLocatorFs;
  which?: (name: string) => string | undefined;
}

const WIN_SHIM_EXT = /\.(cmd|bat)$/i;
const WIN_NATIVE_EXT = /\.(exe|com)$/i;

const defaultFs: ClaudeLocatorFs = {
  exists: existsSync,
  isFile: (file) => {
    try { return statSync(file).isFile(); } catch { return false; }
  },
  readText: (file) => {
    try { return readFileSync(file, "utf8"); } catch { return undefined; }
  },
};

function defaultWhich(name: string, platform: NodeJS.Platform): string | undefined {
  const pathVar = process.env.PATH || process.env.Path || "";
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  try {
    const command = platform === "win32" ? `where ${name}` : `command -v ${name}`;
    return execSync(command, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Official Claude Code user-bin locations that are often missing from PATH. */
function wellKnownClaudeBins(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(home, ".local", "bin", "claude.exe"),
      path.join(localAppData, "Programs", "claude", "claude.exe"),
    ];
  }
  return [
    path.join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
  ];
}

function winDirWithSep(file: string): string {
  const dir = path.win32.dirname(file);
  return /[\\/]$/.test(dir) ? dir : `${dir}\\`;
}

function expandShimVars(text: string, shimPath: string): string {
  const dir = winDirWithSep(shimPath);
  const posixDir = dir.replace(/\\/g, "/");
  return text
    .replace(/%~dp0/gi, dir)
    .replace(/%dp0%/gi, dir)
    .replace(/\$basedir\//g, posixDir)
    .replace(/\$basedir\\/g, dir);
}

function existingWinFile(candidate: string, fs: ClaudeLocatorFs): string | undefined {
  if (fs.isFile(candidate)) return candidate;
  const normalized = path.win32.normalize(candidate);
  if (normalized !== candidate && fs.isFile(normalized)) return normalized;
  return undefined;
}

function isNodeExecutable(file: string): boolean {
  return /(?:^|[\\/])node(?:\.exe)?$/i.test(file);
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * The Claude ACP SDK spawns `CLAUDE_CODE_EXECUTABLE` with `shell: false`.
 * Modern Node rejects a `.cmd`/`.bat` that way (`EINVAL`), so a PATH hit
 * that is only an npm shim cannot be handed through.
 */
export function resolveClaudeSpawnTarget(
  candidate: string,
  options: { platform?: NodeJS.Platform; fs?: ClaudeLocatorFs } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? defaultFs;
  if (!fs.isFile(candidate)) return undefined;
  if (platform !== "win32") return candidate;
  if (WIN_NATIVE_EXT.test(candidate)) return candidate;

  const sibling = `${candidate.replace(WIN_SHIM_EXT, "")}.exe`;
  if (sibling !== candidate) {
    const native = existingWinFile(sibling, fs);
    if (native) return native;
  }

  const raw = fs.readText?.(candidate);
  if (!raw) return undefined;
  const expanded = expandShimVars(raw, candidate);
  const quoted = quotedStrings(expanded).map((value) => value.replace(/\//g, "\\"));
  const claudeExe = quoted.find((value) => /(?:^|[\\/])claude\.exe$/i.test(value));
  if (claudeExe) {
    const native = existingWinFile(claudeExe, fs);
    if (native) return native;
  }
  for (const value of quoted) {
    if (!WIN_NATIVE_EXT.test(value) || isNodeExecutable(value)) continue;
    const native = existingWinFile(value, fs);
    if (native) return native;
  }
  for (const value of quoted) {
    if (!/\.js$/i.test(value)) continue;
    const dir = path.win32.dirname(value);
    for (const guess of [path.win32.join(dir, "claude.exe"), path.win32.join(dir, "bin", "claude.exe")]) {
      const native = existingWinFile(guess, fs);
      if (native) return native;
    }
  }
  return undefined;
}

/**
 * Find an already-installed Claude Code CLI. We never download or install
 * Anthropic's binary — login and credentials stay in their tooling.
 */
export function locateClaudeCli(options: ClaudeLocatorOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const configured = options.configuredPath?.trim();
  if (configured) {
    return fs.isFile(configured) ? resolveClaudeSpawnTarget(configured, { platform, fs }) : undefined;
  }

  // Native exe first: the SDK cannot spawn an npm `.cmd` (`shell: false`).
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const which = options.which ?? ((candidate) => defaultWhich(candidate, platform));
  for (const name of names) {
    const found = which(name);
    if (!found || !fs.isFile(found)) continue;
    const resolved = resolveClaudeSpawnTarget(found, { platform, fs });
    if (resolved) return resolved;
  }

  const home = options.home || (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  for (const candidate of wellKnownClaudeBins(home, env, platform)) {
    const resolved = resolveClaudeSpawnTarget(candidate, { platform, fs });
    if (resolved) return resolved;
  }
  return undefined;
}

/** Normalize `claude --version` output for display. Never use the adapter handshake. */
export function parseClaudeVersionOutput(output: string): string {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output.trim())?.[1] ?? "";
}
