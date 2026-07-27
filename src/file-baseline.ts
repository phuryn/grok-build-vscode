/**
 * Per-turn file baselines for "view deleted" / undo-one / undo-all.
 *
 * Captured on the host at first touch of a path (fs/write or shell delete)
 * while the pre-mutation content is still on disk. Pure helpers here;
 * Session holds the maps, sidebar does the reads/writes.
 */

/** Above this, we store "omitted" instead of the full text (memory + chat). */
export const MAX_BASELINE_BYTES = 2 * 1024 * 1024;

export type BaselineKind = "content" | "absent" | "omitted";

export type FileBaseline = {
  /** Absolute (or as-reported) path — display + restore target. */
  path: string;
  kind: BaselineKind;
  /** Present only when kind === "content". */
  content?: string;
  /** Why omitted (too-large / binary / read-error). */
  reason?: string;
};

/** Metadata the webview needs (no content payload). */
export type BaselineFileMeta = {
  path: string;
  kind: BaselineKind;
  reason?: string;
};

/**
 * Merge key: slash-normalized + lowercased so Windows path casing and
 * `\` vs `/` don't split one file into two baselines.
 */
export function normalizeBaselinePathKey(path: string): string {
  if (path == null || path === "") return "";
  return String(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Paths a shell command is deleting — best-effort parse of the delete verbs
 * grok actually emits (PowerShell Remove-Item / ri / del, POSIX rm).
 * Keep in lockstep with media/webview-helpers.js `parseShellDeletePaths`.
 */
export function parseShellDeletePaths(command: string): string[] {
  const s = String(command || "").trim();
  if (!s) return [];
  const first = s.split(/(?:;|\n|&&|\|\|)/)[0].trim();
  const head = first.match(/^(?:Remove-Item|ri|del|erase|rm(?:\.exe)?)\b/i);
  if (!head) return [];
  const rest = first.slice(head[0].length);

  const paths: string[] = [];
  const quoted = /"([^"]+)"|'([^']+)'|`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(rest))) {
    const p = m[1] || m[2] || m[3];
    if (p) paths.push(p);
  }
  if (paths.length) return paths;

  const tokens = rest.split(/\s+/).filter(Boolean);
  const flagWithArg = /^(?:-ErrorAction|-ea|-Path|-LiteralPath|-Include|-Exclude|-Filter|-Name)$/i;
  const isFlag = (t: string) => /^-/.test(t) || /^\/[A-Za-z]{1,3}$/.test(t);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (flagWithArg.test(t)) {
      i++;
      continue;
    }
    if (isFlag(t)) continue;
    paths.push(t);
  }
  return paths;
}

/** Build a baseline from a successful read of existing file bytes. */
export function baselineFromContent(path: string, content: string, byteLength: number): FileBaseline {
  if (byteLength > MAX_BASELINE_BYTES) {
    return { path, kind: "omitted", reason: "too-large" };
  }
  // NUL in text ⇒ treat as binary; we only restore text baselines.
  if (content.includes("\0")) {
    return { path, kind: "omitted", reason: "binary" };
  }
  return { path, kind: "content", content };
}

export function baselineAbsent(path: string): FileBaseline {
  return { path, kind: "absent" };
}

export function baselineOmitted(path: string, reason: string): FileBaseline {
  return { path, kind: "omitted", reason };
}

/** Drop content for the host→webview meta message. */
export function baselineToMeta(b: FileBaseline): BaselineFileMeta {
  return {
    path: b.path,
    kind: b.kind,
    ...(b.reason ? { reason: b.reason } : {}),
  };
}

/**
 * Pick which baselines to restore. `paths` empty/undefined → all entries.
 * Path match is case/slash-insensitive.
 */
export function selectBaselinesForUndo(
  map: Map<string, FileBaseline>,
  paths?: readonly string[],
): FileBaseline[] {
  if (!paths || paths.length === 0) return [...map.values()];
  const out: FileBaseline[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const k = normalizeBaselinePathKey(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const b = map.get(k);
    if (b) out.push(b);
  }
  return out;
}

/** Max completed turns kept for late undo/view after later turns start. */
export const MAX_ARCHIVED_TURNS = 20;

/**
 * Archive current turn map under turnId; prune oldest when over the cap.
 * Mutates `archive` in place; returns the archived map (same reference as `current`).
 */
export function archiveTurnBaselines(
  archive: Map<number, Map<string, FileBaseline>>,
  turnId: number,
  current: Map<string, FileBaseline>,
  maxTurns: number = MAX_ARCHIVED_TURNS,
): Map<string, FileBaseline> {
  if (turnId > 0 && current.size > 0) {
    archive.set(turnId, current);
  }
  while (archive.size > maxTurns) {
    const oldest = Math.min(...archive.keys());
    archive.delete(oldest);
  }
  return current;
}

/** Resolve a turn's baseline map: prefer live current when turnId matches. */
export function resolveTurnBaselineMap(
  turnId: number,
  currentTurnId: number,
  current: Map<string, FileBaseline>,
  archive: Map<number, Map<string, FileBaseline>>,
): Map<string, FileBaseline> | undefined {
  if (turnId === currentTurnId && current.size > 0) return current;
  return archive.get(turnId);
}
