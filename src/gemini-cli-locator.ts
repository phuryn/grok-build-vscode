import { existsSync, statSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

export interface GeminiLocatorFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
}

export interface GeminiLocatorOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fs?: GeminiLocatorFs;
  which?: (name: string) => string | undefined;
}

const defaultFs: GeminiLocatorFs = {
  exists: existsSync,
  isFile: (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
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
    if (platform === "win32") {
      const out = execFileSync("where", [name], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim().split(/\r?\n/)[0]?.trim() || undefined;
    }
    return execSync(`command -v ${name}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isAntigravityCli(cliPath: string): boolean {
  if (!cliPath) return false;
  const basename = path.basename(cliPath).toLowerCase();
  return (
    basename === "agy" ||
    basename === "agy.exe" ||
    basename === "agy.cmd" ||
    basename === "antigravity" ||
    basename === "antigravity.exe" ||
    basename === "antigravity.cmd" ||
    basename.startsWith("agy-") ||
    basename.startsWith("agy.")
  );
}

/**
 * Where the Antigravity CLI keeps the Google account it signed in with.
 *
 * The ACP adapter answers `session/new` from a static model list without ever
 * launching `agy`, so a successful model warm-up says the binary is installed
 * and nothing at all about the account. This file is the cheap evidence there
 * is one, and it is what `agy auth login` writes.
 */
export function antigravityCredentialPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const base = env.GEMINI_HOME || path.join(home, ".gemini");
  return [
    path.join(base, "oauth_creds.json"),
    path.join(base, "antigravity-cli", "oauth_creds.json"),
  ];
}

export function hasAntigravityCredentials(options: GeminiLocatorOptions = {}): boolean {
  const fsImpl = options.fs ?? defaultFs;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  return antigravityCredentialPaths(home, env).some((file) => fsImpl.isFile(file));
}

/** Known Antigravity CLI binary locations (modern official standard) */
function wellKnownAgyBins(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    return [
      p.join(home, ".gemini", "bin", "agy.exe"),
      p.join(home, ".gemini", "bin", "agy.cmd"),
      p.join(localAppData, "agy", "bin", "agy.exe"),
      p.join(localAppData, "agy", "bin", "agy.cmd"),
      p.join(localAppData, "Programs", "agy", "agy.exe"),
      p.join(home, ".local", "bin", "agy.exe"),
    ];
  }
  return [
    p.join(home, ".gemini", "bin", "agy"),
    p.join(home, ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  ];
}

/** Known Gemini CLI binary locations (legacy) */
function wellKnownGeminiBins(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    const appData = env.APPDATA || p.join(home, "AppData", "Roaming");
    return [
      p.join(home, ".gemini", "bin", "gemini.exe"),
      p.join(home, ".gemini", "bin", "gemini.cmd"),
      p.join(localAppData, "Programs", "gemini", "gemini.exe"),
      p.join(appData, "npm", "gemini.cmd"),
      p.join(home, ".local", "bin", "gemini.exe"),
    ];
  }
  return [
    p.join(home, ".gemini", "bin", "gemini"),
    p.join(home, ".local", "bin", "gemini"),
    "/usr/local/bin/gemini",
    "/opt/homebrew/bin/gemini",
  ];
}

export function locateGeminiCli(options: GeminiLocatorOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const configured = options.configuredPath?.trim();
  if (configured) {
    return fs.isFile(configured) ? configured : undefined;
  }

  const which = options.which ?? ((candidate) => defaultWhich(candidate, platform));
  const home = options.home || (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();

  // 1. Prefer Antigravity CLI (agy) on PATH
  const agyNames = platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  for (const name of agyNames) {
    const found = which(name);
    if (found && fs.isFile(found)) return found;
  }

  // 2. Antigravity CLI in well-known locations (e.g. ~/.gemini/bin/agy.exe)
  for (const candidate of wellKnownAgyBins(home, env, platform)) {
    if (fs.isFile(candidate)) return candidate;
  }

  // 3. Fallback to legacy gemini on PATH
  const geminiNames = platform === "win32" ? ["gemini.exe", "gemini.cmd", "gemini"] : ["gemini"];
  for (const name of geminiNames) {
    const found = which(name);
    if (found && fs.isFile(found)) return found;
  }

  // 4. Legacy gemini in well-known locations
  for (const candidate of wellKnownGeminiBins(home, env, platform)) {
    if (fs.isFile(candidate)) return candidate;
  }

  return undefined;
}

export function parseGeminiVersionOutput(output: string): string {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output.trim())?.[1] ?? "";
}

export const parseAgyVersionOutput = parseGeminiVersionOutput;
