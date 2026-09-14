import { statSync } from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";

export function isCliFile(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

const cliCache = new Map<string, { path: string | undefined; at: number }>();

/** Avoid a shell on ordinary PATH hits; GUI hosts can still need the shell fallback. */
export function findCliOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (candidate: string) => boolean = (candidate) => isCliFile(candidate, platform),
): string | undefined {
  const win = platform === "win32";
  const pathKey = win ? Object.keys(env).find((key) => key.toLowerCase() === "path") : "PATH";
  const pathVal = env[pathKey ?? "PATH"] || "";
  const cacheKey = `${platform}:${name}:${pathVal}`;
  const now = Date.now();
  const cached = cliCache.get(cacheKey);
  if (cached && now - cached.at < 15000) {
    if (!cached.path || isFile(cached.path)) {
      return cached.path;
    }
  }

  const paths = win ? path.win32 : path.posix;
  const pathExtKey = Object.keys(env).find((key) => key.toLowerCase() === "pathext");
  // npm also installs POSIX scripts without an extension on Windows. Only
  // PATHEXT candidates can be launched there, even if the bare file exists.
  const names = win && !paths.extname(name)
    ? (env[pathExtKey ?? "PATHEXT"] || ".COM;.EXE;.BAT;.CMD")
      .split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."))
      .map((ext) => `${name}${ext}`)
    : [name];
  for (const entry of pathVal.split(win ? ";" : ":")) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry;
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = paths.join(dir, candidateName);
      try {
        if (isFile(candidate)) {
          cliCache.set(cacheKey, { path: candidate, at: now });
          return candidate;
        }
      } catch { /* A removed or inaccessible PATH entry must not stop discovery. */ }
    }
  }
  try {
    const command = win ? `where ${name}` : `command -v ${name}`;
    const found = execSync(command, {
      encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    }).trim().split(/\r?\n/)[0]?.trim();
    const resolved = found && isFile(found) ? found : undefined;
    cliCache.set(cacheKey, { path: resolved, at: now });
    return resolved;
  } catch {
    cliCache.set(cacheKey, { path: undefined, at: now });
    return undefined;
  }
}
