/**
 * Pure project-discovery seeding for the desktop open-folder set.
 *
 * Seeding is a one-shot heuristic: open checkouts that look actively used, then
 * leave the set user-owned. It must never run as a live mirror of ~/.grok
 * (throwaway agent cwds would permanently pollute the rail) and must never be
 * triggered from the renderer.
 *
 * Threshold: ≥ {@link PROJECT_DISCOVERY_MIN_SESSIONS} **well-formed** sessions
 * whose summary.json mtime falls in `[now − window, now]` (future stamps do
 * not count). Seed paths must be verified Git roots after realpath.
 */

import * as path from "node:path";
import { gitRootForPath, pathsEqual } from "./worktree";

/** Minimum sessions inside the window for a checkout to be auto-opened. */
export const PROJECT_DISCOVERY_MIN_SESSIONS = 10;

/** Look-back window for "recent" sessions (~3 months). */
export const PROJECT_DISCOVERY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Injectable FS for seed-path realpath / git-root checks. */
export interface SeedPathFs {
  existsSync(p: string): boolean;
  realpathSync(p: string): string;
  statSync(p: string): { isDirectory(): boolean };
}

/**
 * Whether a checkout meets the auto-open bar given its session activity stamps
 * (typically summary.json mtimes from well-formed session indexing).
 *
 * Window is closed on both ends: `floor <= t <= nowMs`. Future timestamps
 * (clock skew or planted mtimes) never count toward the threshold.
 */
export function meetsProjectDiscoveryThreshold(
  sessionTimestampsMs: readonly number[],
  nowMs: number,
  opts?: { minSessions?: number; windowMs?: number },
): boolean {
  const min = opts?.minSessions ?? PROJECT_DISCOVERY_MIN_SESSIONS;
  const windowMs = opts?.windowMs ?? PROJECT_DISCOVERY_WINDOW_MS;
  if (min <= 0) return true;
  if (!Number.isFinite(nowMs) || windowMs < 0) return false;
  const floor = nowMs - windowMs;
  let count = 0;
  for (const t of sessionTimestampsMs) {
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    // Inclusive window: not older than floor, not in the future.
    if (t >= floor && t <= nowMs) {
      count++;
      if (count >= min) return true;
    }
  }
  return false;
}

/**
 * Canonicalize a discovery candidate and accept it only as a **verified Git
 * root** (the path itself is the checkout root, not merely inside one).
 *
 * - realpath must succeed and name an existing directory
 * - realpath must not escape the resolved path's identity via `..` after
 *   resolve (reject when realpath is outside `path.resolve(cwd)`'s own tree
 *   in the sense that resolve+realpath disagree with a non-dir or missing root)
 * - `gitRootForPath(real) === real` — must be a git root, not a nested folder
 *
 * Returns the canonical absolute path to open, or undefined to skip.
 */
export function canonicalizeSeedProjectPath(
  cwd: string,
  fs: SeedPathFs,
): string | undefined {
  if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) return undefined;
  if (cwd.includes("\0")) return undefined;
  const resolved = path.resolve(cwd);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return undefined;
  }
  try {
    if (!fs.statSync(real).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  // Symlink targets are fine when the *target* is the git root we open; reject
  // when realpath walks outside a non-existent resolved base (broken link) —
  // already handled by stat. "Resolves outside itself": if the caller passed a
  // path whose realpath is not equal to itself and the original is not a
  // symlink-or-equal of that real path, we still open `real` (the true root).
  // Reject only when the git root of `real` is a strict ancestor (nested dir).
  const gitRoot = gitRootForPath(real, fs);
  if (!gitRoot || !pathsEqual(gitRoot, real)) return undefined;
  // If lexical resolve and realpath differ, require that resolved is a path
  // that realpath's directory contains or equals (no arbitrary escape through
  // a symlink named like an open folder that points at /etc).
  // Policy: open the realpath only when it is a git root (above). A symlink
  // project → other-git-root seeds the real root, which is correct.
  return real;
}

/**
 * Decide whether the host should run discovery seeding.
 *
 * **First run / never seeded:** `discoverySeedCompleted === false` and nothing
 * open → seed (even if discovery finds zero projects — the rail simply stays
 * empty and the user can Add Project Folder).
 *
 * **Already seeded:** never seed again. Closing every folder later is a
 * deliberate empty set; re-opening throwaways would undo that choice.
 *
 * **Non-empty open set:** never seed — the user (or a prior seed / prefs
 * restore) already owns the list. A first launch with `--workspace=` or a
 * restored prefs file falls here.
 *
 * Note: "first run" and "list is empty" are not independent after the seed
 * flag is set — empty + completed does **not** re-seed. That is intentional
 * and is what makes "close everything" stick across restarts.
 */
export function shouldSeedProjectDiscovery(opts: {
  discoverySeedCompleted: boolean;
  openFolderCount: number;
}): boolean {
  if (opts.discoverySeedCompleted) return false;
  return opts.openFolderCount <= 0;
}

/**
 * Pick absolute cwd paths that meet the threshold, preserving input order.
 * Does not open folders — callers feed the result into addWorkspaceFolder.
 * Optional `canonicalize` rejects non-git-roots / failed realpaths (seed path).
 */
export function selectProjectsToSeed(
  candidates: readonly { cwd: string; sessionTimestampsMs: readonly number[] }[],
  nowMs: number,
  opts?: {
    minSessions?: number;
    windowMs?: number;
    /** When set, only paths that canonicalize to a verified git root are kept. */
    canonicalize?: (cwd: string) => string | undefined;
  },
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c?.cwd || typeof c.cwd !== "string") continue;
    if (!meetsProjectDiscoveryThreshold(c.sessionTimestampsMs ?? [], nowMs, opts)) continue;
    const cwd = opts?.canonicalize ? opts.canonicalize(c.cwd) : c.cwd;
    if (!cwd) continue;
    const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cwd);
  }
  return out;
}

/**
 * Strip archive fields so the webview's capability probe
 * (`typeof repo.archived === "boolean"`) reports "host cannot archive".
 * Used when {@link Host.canArchiveRepos} is false.
 */
export function withoutArchiveFields<T extends { archived?: boolean; archivedAt?: number }>(
  entry: T,
): Omit<T, "archived" | "archivedAt"> {
  const { archived: _a, archivedAt: _b, ...rest } = entry;
  return rest;
}
