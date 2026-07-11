import * as path from "node:path";
import type { FsLike, SessionIndexEntry } from "./sessions";
import type { Dot } from "./session-pool";

/**
 * Pure data layer for the multi-workspace panel (Grok Workspaces tree view).
 *
 * grok keys its on-disk session store by the EXACT spawn cwd, URL-encoded:
 * `~/.grok/sessions/<encodeURIComponent(cwd)>/<session-id>/`. Two consequences
 * drive everything here:
 *
 *  1. Every workspace grok has ever run in is discoverable by decoding the
 *     store's directory names — no separate registry of "known" workspaces is
 *     needed for discovery ({@link discoverWorkspaces}).
 *  2. One real folder can be represented by SEVERAL storage spellings (drive
 *     letter case on Windows — VS Code's `Uri.fsPath` lowercases it while a
 *     terminal usually doesn't — trailing separators, forward vs back slashes).
 *     So workspace IDENTITY is a canonical key ({@link canonicalizeWorkspacePath}),
 *     while DISK ACCESS always uses the literal storage spellings
 *     (`WorkspaceRef.storageCwds`) — never the canonical form.
 */

export interface DiscoveredWorkspace {
  /** Identity/dedup key — see {@link canonicalizeWorkspacePath}. */
  canonicalKey: string;
  /** Every on-disk storage spelling for this workspace, most recently active first. */
  storageCwds: string[];
  /** The most recently active spelling — what the UI shows. */
  displayPath: string;
  /** Total session dirs across all spellings (cheap readdir count, a hint not a promise). */
  sessionCount: number;
  /** Newest storage-dir mtime across spellings (ms). */
  lastActivityMs: number;
}

/**
 * Canonical identity for a workspace path. Dedupe/equality ONLY — never touch
 * disk with the canonical form (grok's store is keyed by the exact original
 * spelling). win32 folds case, normalizes slashes, and strips trailing
 * separators; POSIX only strips trailing slashes (case is significant there).
 */
export function canonicalizeWorkspacePath(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let s = (p || "").trim();
  if (!s) return "";
  if (platform === "win32") {
    s = s.replace(/\//g, "\\").replace(/\\+$/g, "");
    if (/^[a-zA-Z]:$/.test(s)) s += "\\"; // keep a bare drive root as "c:\"
    return s.toLowerCase();
  }
  if (s.length > 1) s = s.replace(/\/+$/g, "");
  return s || "/";
}

export interface DiscoverDeps {
  fs: FsLike;
  grokHome: string;
  platform?: NodeJS.Platform;
  log?: (msg: string) => void;
}

/**
 * Every workspace in grok's session store, straight from the store's directory
 * names, merged by canonical key and ordered by last activity (newest first).
 * Cheap: one readdir of the store, then one stat + one readdir per workspace
 * dir (for recency + session count) — no summary.json parsing.
 */
export function discoverWorkspaces(deps: DiscoverDeps): DiscoveredWorkspace[] {
  const { fs, grokHome, log } = deps;
  const platform = deps.platform ?? process.platform;
  const root = path.join(grokHome, "sessions");
  if (!fs.existsSync(root)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    log?.(`[workspaces] failed to read ${root}: ${(e as Error).message}`);
    return [];
  }
  const byKey = new Map<string, { spellings: { cwd: string; mtimeMs: number; count: number }[] }>();
  for (const name of names) {
    const dir = path.join(root, name);
    let st: { isDirectory(): boolean; mtimeMs: number };
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let cwd: string;
    try {
      cwd = decodeURIComponent(name);
    } catch {
      continue; // not a grok workspace dir
    }
    if (!cwd) continue;
    let count = 0;
    try {
      count = fs.readdirSync(dir).length;
    } catch { /* unreadable — keep it listed with 0 */ }
    const key = canonicalizeWorkspacePath(cwd, platform);
    const bucket = byKey.get(key) ?? { spellings: [] };
    bucket.spellings.push({ cwd, mtimeMs: st.mtimeMs, count });
    byKey.set(key, bucket);
  }
  const out: DiscoveredWorkspace[] = [];
  for (const [canonicalKey, { spellings }] of byKey) {
    spellings.sort((a, b) => b.mtimeMs - a.mtimeMs);
    out.push({
      canonicalKey,
      storageCwds: spellings.map((s) => s.cwd),
      displayPath: spellings[0].cwd,
      sessionCount: spellings.reduce((n, s) => n + s.count, 0),
      lastActivityMs: spellings[0].mtimeMs,
    });
  }
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}

export type WorkspaceSource = "active" | "added";

export interface WorkspaceRef {
  canonicalKey: string;
  /**
   * On-disk storage spellings to index for sessions (may be empty for a folder
   * grok has never run in). Disk access goes through these, never the key.
   */
  storageCwds: string[];
  /** What the UI shows, and the spawn cwd for NEW sessions in this workspace. */
  displayPath: string;
  /** "active" = a folder of this window's VS Code workspace (not removable). */
  source: WorkspaceSource;
}

export interface BuildListInput {
  /** This window's workspace folders (all of them — multi-root included), in order. */
  workspaceFolders: string[];
  /** User-added folders from the persisted registry, in add order. */
  added: string[];
  discovered: DiscoveredWorkspace[];
  platform?: NodeJS.Platform;
}

/**
 * The tree's workspace list: the window's own folder(s) first (never removable),
 * then user-added ones — deduped by canonical key (an added path that IS an
 * active folder is dropped), each matched against the discovered on-disk
 * spellings so session listing hits the real dirs. The folder's own literal
 * spelling is kept as a storage candidate too (a missing dir just indexes
 * empty; on case-insensitive filesystems a same-key spelling resolves to the
 * same physical dir, and session listing dedupes by id).
 */
export function buildWorkspaceList(input: BuildListInput): WorkspaceRef[] {
  const platform = input.platform ?? process.platform;
  const discoveredByKey = new Map(input.discovered.map((d) => [d.canonicalKey, d]));
  const out: WorkspaceRef[] = [];
  const seen = new Set<string>();
  const push = (folder: string, source: WorkspaceSource) => {
    const key = canonicalizeWorkspacePath(folder, platform);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const disc = discoveredByKey.get(key);
    const storageCwds = [...(disc?.storageCwds ?? [])];
    if (!storageCwds.some((c) => c === folder)) storageCwds.push(folder);
    out.push({ canonicalKey: key, storageCwds, displayPath: folder, source });
  };
  for (const f of input.workspaceFolders) push(f, "active");
  for (const f of input.added) push(f, "added");
  return out;
}

/** Add a folder to the persisted registry — no-op when it's already listed or is
 *  one of `existingKeys` (the active folders). Returns a new array. */
export function addWorkspacePath(
  added: string[],
  folder: string,
  existingKeys: string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const key = canonicalizeWorkspacePath(folder, platform);
  if (!key) return added;
  if (existingKeys.some((k) => k === key)) return added;
  if (added.some((a) => canonicalizeWorkspacePath(a, platform) === key)) return added;
  return [...added, folder];
}

/** Remove a workspace (by canonical key) from the persisted registry. Forgetting
 *  only — never deletes the folder or its grok sessions. Returns a new array. */
export function removeWorkspacePath(
  added: string[],
  canonicalKey: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return added.filter((a) => canonicalizeWorkspacePath(a, platform) !== canonicalKey);
}

export interface WorkspaceSessionIndexEntry extends SessionIndexEntry {
  /** The storage spelling this session's dir lives under (disk access key). */
  storageCwd: string;
}

/**
 * Merge per-spelling session indexes into one newest-first list, deduped by
 * session id. The dedupe is load-bearing on case-insensitive filesystems: two
 * spellings of one workspace resolve to the SAME physical dir, so indexing both
 * would list every session twice. First (newest) occurrence wins.
 */
export function mergeSessionIndexes(
  perCwd: Array<{ cwd: string; entries: SessionIndexEntry[] }>,
): WorkspaceSessionIndexEntry[] {
  const merged: WorkspaceSessionIndexEntry[] = [];
  for (const { cwd, entries } of perCwd) {
    for (const e of entries) merged.push({ ...e, storageCwd: cwd });
  }
  merged.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set<string>();
  return merged.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

/** VS Code theme-color id for a dashboard dot in the tree — the same palette the
 *  history popover uses (chat.css). `none` is the gray "at rest" dot. */
export function dotColorId(dot: Dot): string {
  switch (dot) {
    case "working": return "charts.blue";
    case "needs-you": return "charts.yellow";
    case "unread": return "charts.green";
    case "error": return "errorForeground";
    default: return "descriptionForeground";
  }
}

/** Hover text for a session dot. Empty for the gray "at rest" state. */
export function dotTooltip(dot: Dot): string {
  switch (dot) {
    case "working": return "Working";
    case "needs-you": return "Needs you";
    case "unread": return "Finished — unread";
    case "error": return "Errored — unread";
    default: return "";
  }
}

/** Compact "how long ago" label for tree row descriptions ("just now", "5m ago",
 *  "3h ago", "2d ago"). Pure — `now` injected for testability. */
export function formatAgo(thenMs: number, nowMs: number): string {
  const d = Math.max(0, nowMs - thenMs);
  const min = Math.floor(d / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}
