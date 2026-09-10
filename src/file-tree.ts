/**
 * Pure workspace file-tree helpers: path containment, directory listing, and
 * read-only preview. Shared by the desktop panel IPC and remote (phone) file
 * browse — no Electron, no vscode.
 *
 * Containment is **canonical**, not merely lexical: after the path is resolved
 * under the workspace root we `realpath` both the root and the candidate and
 * reject anything whose real path leaves the real root. That closes symlink
 * and Windows-junction escapes (a link whose own path is inside the workspace
 * but whose target is not). Symlinks that stay inside the workspace remain
 * usable — the boundary is "cannot read outside", not "no links".
 *
 * Lives at `src/` (not under `desktop/`) so the common host path (`sidebar.ts`)
 * can compose it without importing desktop code.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { isFsPathInWorkspace } from "./host";

/**
 * Walk ancestors of `dir` until an existing directory is found (or the root).
 * Used by the bound file watcher so a missing custom Grok home can still be
 * supervised via the nearest living parent.
 */
export function nearestExistingAncestor(
  dir: string,
  existsSync: (p: string) => boolean = (p) => fs.existsSync(p),
  isDirectory: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
): string | undefined {
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try {
      if (existsSync(current) && isDirectory(current)) {
        return current;
      }
    } catch {
      /* continue walking */
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Cap per directory so a huge folder cannot freeze the panel. */
export const FILE_TREE_MAX_ENTRIES = 2000;

export type TreeEntryKind = "file" | "dir";

export interface TreeEntry {
  name: string;
  kind: TreeEntryKind;
  /** Workspace-relative POSIX path ("" for root children is just the name). */
  relPath: string;
}

export type ResolveTreePathResult =
  | { ok: true; absPath: string; relPath: string }
  | { ok: false; reason: string };

export type ListTreeResult =
  | { ok: true; entries: TreeEntry[]; truncated: boolean }
  | { ok: false; reason: string };

/** Injectable FS surface so tests can simulate symlink realpath without OS privileges. */
export interface TreePathFs {
  realpathSync(p: string): string;
  existsSync(p: string): boolean;
  statSync(p: string): fs.Stats;
  readdirSync(p: string, opts: { withFileTypes: true }): fs.Dirent[];
}

export interface TreeFileStamp {
  mtimeMs: number;
  size: number;
}

/** A file root exposes exactly one named file, never its directory or siblings. */
export type TreeRoot = string | { filePath: string };

export type TextFileLineEnding = "lf" | "crlf";

export interface TextFileDetails {
  stamp: TreeFileStamp;
  lineEnding: TextFileLineEnding;
  trailingNewline: boolean;
  bom: boolean;
}

export interface WriteTreeFileOptions {
  platform?: NodeJS.Platform;
  pathFs?: TreePathFs;
  readFileSync?: (p: string) => Buffer;
  writeFileSync?: (
    p: string,
    data: Buffer,
    options?: { flag?: string; mode?: number },
  ) => void;
  renameSync?: (from: string, to: string) => void;
  unlinkSync?: (p: string) => void;
  /**
   * The absolute path this content was READ at. When given, the write refuses
   * unless `relPath` still resolves there under `root`.
   *
   * The stamp answers "did this file change?"; this answers the question that
   * comes first -- "is this still the same file?". A tab left open on one
   * project and saved after the active folder moved to another resolved its
   * relative path against the new root and wrote into the other project's
   * same-named file. The stamp caught the common case and then offered
   * Overwrite, which completed the loss.
   */
  expectedAbsPath?: string;
}

const defaultTreeFs: TreePathFs = {
  realpathSync: (p) => fs.realpathSync(p),
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  readdirSync: (p, opts) => fs.readdirSync(p, opts),
};

/**
 * Best-effort real path. When the path does not exist, walk up to the nearest
 * existing ancestor and rejoin the missing tail (so a not-yet-created path is
 * still checked against the real root of its parent).
 */
export function canonicalPath(absPath: string, pathFs: TreePathFs = defaultTreeFs): string {
  try {
    return pathFs.realpathSync(absPath);
  } catch {
    /* fall through */
  }
  let current = absPath;
  const missing: string[] = [];
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    try {
      return path.join(pathFs.realpathSync(parent), ...missing);
    } catch {
      current = parent;
    }
  }
  return absPath;
}

/**
 * True when the real path of `absPath` stays inside the real path of `root`.
 * Lexical containment alone is not enough (symlink / junction escape).
 */
export function isCanonicallyInsideRoot(
  root: TreeRoot,
  absPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
): boolean {
  if (typeof root !== "string") {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const expected = paths.join(canonicalPath(paths.dirname(root.filePath), pathFs), paths.basename(root.filePath));
    const actual = canonicalPath(absPath, pathFs);
    return platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  }
  const realRoot = canonicalPath(root, pathFs);
  const realAbs = canonicalPath(absPath, pathFs);
  return isFsPathInWorkspace(realAbs, [realRoot], platform);
}

/**
 * Resolve a workspace-relative path to an absolute path under `root`.
 * Rejects traversal (`..`), absolute inputs that leave the root, null bytes,
 * empty/invalid roots, and paths whose **real** target escapes the real root.
 * The workspace root itself is allowed (`relPath` "").
 * A file root accepts only its exact basename and refuses a redirected file.
 */
export function resolveTreePath(
  root: TreeRoot,
  relPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
): ResolveTreePathResult {
  if (root && typeof root === "object") {
    const paths = platform === "win32" ? path.win32 : path.posix;
    if (typeof root.filePath !== "string" || !paths.isAbsolute(root.filePath)) {
      return { ok: false, reason: "invalid file root" };
    }
    const absPath = paths.resolve(root.filePath);
    // Exact input, before normalization: no aliases, traversal, or listing.
    if (relPath !== paths.basename(absPath)) return { ok: false, reason: "path is not the allowed file" };
    if (!isCanonicallyInsideRoot(root, absPath, platform, pathFs)) {
      return { ok: false, reason: "file root redirects to another file" };
    }
    return { ok: true, absPath, relPath };
  }
  if (!root || typeof root !== "string") {
    return { ok: false, reason: "no workspace root" };
  }
  if (typeof relPath !== "string") {
    return { ok: false, reason: "invalid path" };
  }
  if (relPath.includes("\0")) {
    return { ok: false, reason: "null byte in path" };
  }

  const pathMod = platform === "win32" ? path.win32 : path.posix;
  // Also accept the host path module for mixed separators on Windows when
  // platform === process.platform; for pure tests callers pass explicit platform.
  const hostPath = platform === process.platform ? path : pathMod;

  const rootAbs = hostPath.resolve(root);
  const normalized = relPath.replace(/\\/g, "/");
  // Whether the INPUT was absolute must be decided BEFORE the leading slash is
  // stripped, or a POSIX absolute path silently becomes a relative one.
  // `/etc/passwd` used to trim to `etc/passwd`, miss every absolute test below,
  // and resolve against the workspace root — so on macOS and Linux an absolute
  // path did not escape the workspace, it landed somewhere else INSIDE it, and
  // openFile (documented to accept absolute paths) quietly opened nothing.
  //
  // POSIX only. A leading slash is genuinely absolute there; on Windows it is a
  // drive-relative root that callers legitimately pass as workspace-relative,
  // and Windows absolutes always carry a drive letter or UNC prefix, both
  // checked separately below.
  const posixAbsolute = platform !== "win32" && normalized.startsWith("/");
  const trimmed = normalized.replace(/^\/+/, "").replace(/\/+$/, "");

  // Empty → workspace root (allowed for listing).
  if (!trimmed || trimmed === ".") {
    return { ok: true, absPath: rootAbs, relPath: "" };
  }

  let absPath: string;

  // Reject absolute inputs early (Unix /foo, Windows C:\foo, //server/share).
  if (
    posixAbsolute ||
    pathMod.isAbsolute(trimmed) ||
    /^[A-Za-z]:[\/]/.test(relPath) ||
    relPath.startsWith("\\\\")
  ) {
    // Absolute only accepted if it still lands inside the workspace.
    const absCandidate = hostPath.resolve(relPath);
    if (!isFsPathInWorkspace(absCandidate, [rootAbs], platform)) {
      return { ok: false, reason: "path escapes workspace" };
    }
    absPath = absCandidate;
  } else {
    // Segment-wise reject `..` so we never resolve out then back in via tricks.
    const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
    if (segments.some((s) => s === "..")) {
      return { ok: false, reason: "path escapes workspace" };
    }

    absPath = hostPath.resolve(rootAbs, ...segments);
    if (!isFsPathInWorkspace(absPath, [rootAbs], platform)) {
      return { ok: false, reason: "path escapes workspace" };
    }
  }

  // Canonical check: symlink / junction targets must stay inside the real root.
  if (!isCanonicallyInsideRoot(rootAbs, absPath, platform, pathFs)) {
    return { ok: false, reason: "path escapes workspace (symlink)" };
  }

  const rel = hostPath.relative(rootAbs, absPath).split(hostPath.sep).join("/");
  // Open/list operate on the caller's path (the link path when it is a link);
  // containment was already decided on the real target. Using the link path
  // keeps relative labels stable under the workspace root.
  return { ok: true, absPath, relPath: rel };
}

function entrySort(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * List one directory under the workspace. Directories first, then files,
 * case-insensitive name order. Caps at {@link FILE_TREE_MAX_ENTRIES}.
 * Entries whose real path leaves the workspace (outbound symlink/junction)
 * are omitted — they must not be expandable or openable.
 */
export function listTreeDir(
  root: string,
  relPath: string,
  maxEntries: number = FILE_TREE_MAX_ENTRIES,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
): ListTreeResult {
  const resolved = resolveTreePath(root, relPath, platform, pathFs);
  if (!resolved.ok) return resolved;

  let stat: fs.Stats;
  try {
    // lstat-first so a symlink-to-dir at this path is still a directory listing
    // only when the *canonical* target is inside the root (already checked).
    stat = pathFs.statSync(resolved.absPath);
  } catch {
    return { ok: false, reason: "not found" };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: "not a directory" };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = pathFs.readdirSync(resolved.absPath, { withFileTypes: true });
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "unreadable" };
  }

  const hostPath = platform === process.platform ? path : platform === "win32" ? path.win32 : path.posix;
  const entries: TreeEntry[] = [];
  let truncated = false;
  for (const ent of dirents) {
    const childAbs = hostPath.join(resolved.absPath, ent.name);
    // Drop anything whose real target leaves the workspace before classifying.
    if (!isCanonicallyInsideRoot(root, childAbs, platform, pathFs)) {
      continue;
    }

    let kind: TreeEntryKind | null = null;
    if (ent.isDirectory()) kind = "dir";
    else if (ent.isFile()) kind = "file";
    else if (ent.isSymbolicLink()) {
      try {
        const s = pathFs.statSync(childAbs);
        if (s.isDirectory()) kind = "dir";
        else if (s.isFile()) kind = "file";
      } catch {
        kind = null;
      }
    }
    if (!kind) continue;

    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const childRel = resolved.relPath
      ? `${resolved.relPath}/${ent.name}`
      : ent.name;
    entries.push({ name: ent.name, kind, relPath: childRel });
  }

  entries.sort(entrySort);
  return { ok: true, entries, truncated };
}

/** In-panel preview kinds (read-only). Everything else hands off to the OS. */
export type FilePreviewKind = "markdown" | "json" | "image" | "text" | "external";

const PREVIEW_IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const PREVIEW_TEXT_EXT = new Set([
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".htm",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".csv",
  ".log",
  ".env",
  ".sh",
  ".ps1",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".jsonc",
  ".mdx",
  ".svg",
  // Added alongside syntax highlighting (2026-08-12). Each of these was handed
  // to the OS before, which from a phone means it could not be opened at all —
  // and each is a file people read far more often than they edit. `.sql` was
  // asked for by name.
  ".sql",
  ".scss",
  ".sass",
  ".less",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".bash",
  ".zsh",
  // Windows' shell scripts, for the same reason their POSIX counterparts are
  // here: they are text people read and edit. `.sh` and `.ps1` were previewable
  // and these were not, which was inconsistency rather than policy.
  ".bat",
  ".cmd",
  ".rb",
  ".php",
  ".kt",
  ".swift",
  ".cs",
  ".cc",
  ".hh",
  ".mts",
  ".cts",
  ".diff",
  ".patch",
]);

/** Cap for in-panel text/json previews (bytes). */
export const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Cap for in-panel image previews (bytes). */
export const FILE_PREVIEW_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Classify a workspace-relative path for the desktop file panel viewer.
 * `.md` → markdown, `.json` → json, images → image, common source/text → text,
 * everything else → external (OS open).
 */
export function classifyFilePreview(relOrName: string): FilePreviewKind {
  const ext = path.extname(relOrName).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".json") return "json";
  if (PREVIEW_IMAGE_EXT.has(ext)) return "image";
  if (PREVIEW_TEXT_EXT.has(ext)) return "text";
  // Dotfiles like `.env` have ext "" when basename is `.env` — treat as text.
  if (ext === "" || /^\./.test(path.basename(relOrName))) return "text";
  return "external";
}

export type ReadTreeFileResult =
  | {
      ok: true;
      kind: Exclude<FilePreviewKind, "external">;
      relPath: string;
      absPath: string;
      /** UTF-8 text for markdown/json/text; empty for image. */
      text?: string;
      /** data: URL for images. */
      dataUrl?: string;
      /** The JSON pretty-printer RAN (kind is json and it parsed). */
      pretty?: boolean;
      /** The pretty-printer actually CHANGED the text. Most JSON in a repo is
       *  already formatted this way, so `pretty` alone cannot tell a consumer
       *  that numbers lines whether these are the bytes on disk. */
      reformatted?: boolean;
      /** Version stamp sent back by the editor on save. */
      stamp?: TreeFileStamp;
      lineEnding?: TextFileLineEnding;
      trailingNewline?: boolean;
      bom?: boolean;
      details?: TextFileDetails;
    }
  | { ok: false; reason: string; openExternal?: boolean };

export type WriteTreeFileResult =
  | { ok: true; relPath: string; absPath: string; stamp: TreeFileStamp }
  | { ok: false; reason: string };

function textDetails(text: string, st: fs.Stats, bom: boolean): TextFileDetails {
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfCount = (text.replace(/\r\n/g, "").match(/\n/g) || []).length;
  return {
    stamp: { mtimeMs: st.mtimeMs, size: st.size },
    lineEnding: crlfCount > lfCount ? "crlf" : "lf",
    trailingNewline: text.endsWith("\n") || text.endsWith("\r"),
    bom,
  };
}

function decodeUtf8(buf: Buffer): { text: string; bom: boolean } | null {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const payload = bom ? buf.subarray(3) : buf;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(payload), bom };
  } catch {
    return null;
  }
}

/**
 * Re-resolve immediately before a read so a symlink swap between the first
 * containment check and the open cannot escape the workspace (same property
 * as the open-path TOCTOU rechecks in file-tree-ipc).
 */
function recheckTreePathForRead(
  root: TreeRoot,
  relPath: string,
  expectedAbs: string,
  expectedReal: string,
  platform: NodeJS.Platform,
  pathFs: TreePathFs,
): ResolveTreePathResult {
  const again = resolveTreePath(root, relPath, platform, pathFs);
  if (!again.ok) return again;
  if (again.absPath !== expectedAbs) {
    return { ok: false, reason: "path changed since check" };
  }
  const realNow = canonicalPath(again.absPath, pathFs);
  const a = platform === "win32" ? realNow.toLowerCase() : realNow;
  const b = platform === "win32" ? expectedReal.toLowerCase() : expectedReal;
  if (a !== b) {
    return { ok: false, reason: "path escaped workspace (symlink swap)" };
  }
  if (!isCanonicallyInsideRoot(root, again.absPath, platform, pathFs)) {
    return { ok: false, reason: "path escapes workspace (symlink)" };
  }
  return again;
}

/**
 * Read a workspace file for the in-panel viewer. Containment matches
 * {@link resolveTreePath}. Oversized or binary-looking files return
 * `{ openExternal: true }` so the panel can hand off to the OS.
 */
export function readTreeFile(
  root: TreeRoot,
  relPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
  readFileSync: (p: string) => Buffer = (p) => fs.readFileSync(p),
): ReadTreeFileResult {
  const resolved = resolveTreePath(root, relPath, platform, pathFs);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const realAtCheck = canonicalPath(resolved.absPath, pathFs);

  let st: fs.Stats;
  try {
    st = pathFs.statSync(resolved.absPath);
  } catch {
    return { ok: false, reason: "not found" };
  }
  if (!st.isFile()) {
    return { ok: false, reason: "not a file" };
  }

  const kind = classifyFilePreview(resolved.relPath || path.basename(resolved.absPath));
  if (kind === "external") {
    return { ok: false, reason: "open externally", openExternal: true };
  }

  if (kind === "image") {
    if (st.size > FILE_PREVIEW_MAX_IMAGE_BYTES) {
      return { ok: false, reason: "image too large", openExternal: true };
    }
    const rechecked = recheckTreePathForRead(
      root,
      relPath,
      resolved.absPath,
      realAtCheck,
      platform,
      pathFs,
    );
    if (!rechecked.ok) return { ok: false, reason: rechecked.reason };
    let buf: Buffer;
    try {
      buf = readFileSync(rechecked.absPath);
    } catch (e) {
      return { ok: false, reason: (e as Error).message || "unreadable" };
    }
    const ext = path.extname(rechecked.absPath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".svg"
              ? "image/svg+xml"
              : ext === ".bmp"
                ? "image/bmp"
                : "image/jpeg";
    return {
      ok: true,
      kind: "image",
      relPath: rechecked.relPath,
      absPath: rechecked.absPath,
      dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
    };
  }

  if (st.size > FILE_PREVIEW_MAX_BYTES) {
    return { ok: false, reason: "file too large", openExternal: true };
  }

  const rechecked = recheckTreePathForRead(
    root,
    relPath,
    resolved.absPath,
    realAtCheck,
    platform,
    pathFs,
  );
  if (!rechecked.ok) return { ok: false, reason: rechecked.reason };

  let buf: Buffer;
  try {
    buf = readFileSync(rechecked.absPath);
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "unreadable" };
  }
  // Reject obvious binary (NUL in first 8k).
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) {
    return { ok: false, reason: "binary file", openExternal: true };
  }

  const decoded = decodeUtf8(buf);
  if (!decoded) return { ok: false, reason: "invalid UTF-8", openExternal: true };
  let text = decoded.text;
  let pretty = false;
  let reformatted = false;
  if (kind === "json") {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
      // JSON.stringify never ends with a newline, so pretty-printing silently
      // drops the file's — and the writer reads a missing final newline as the
      // user deliberately deleting it (see writeTreeFile). Without this, saving
      // any formatted JSON file that ended in a newline would strip it. The
      // writer's rule holds only while the text the client was handed matches
      // the file's own newline state, and this transform is the one thing on
      // the read path that can break that.
      // Same terminator test `textDetails.trailingNewline` uses — a CR-only
      // file has a final line ending too, and the two must not disagree about
      // whether this file ends in one.
      if (/[\r\n]$/.test(decoded.text)) text += "\n";
      pretty = true;
      // `pretty` says the pretty-printer RAN. `reformatted` says it actually
      // changed something — most JSON in a repo is already formatted this way,
      // and a consumer that NUMBERS lines needs the difference between "this is
      // JSON" and "these are not the bytes on disk".
      reformatted = text !== decoded.text;
    } catch {
      /* show raw */
    }
  }

  const details = textDetails(decoded.text, st, decoded.bom);
  return {
    ok: true,
    kind,
    relPath: rechecked.relPath,
    absPath: rechecked.absPath,
    text,
    pretty,
    reformatted,
    stamp: details.stamp,
    lineEnding: details.lineEnding,
    trailingNewline: details.trailingNewline,
    bom: details.bom,
    details,
  };
}

/**
 * Save an edited workspace text file. The caller must provide the stamp from
 * readTreeFile and the host's executable predicate; keeping both explicit
 * prevents a new write caller from accidentally weakening either guard.
 */
export function writeTreeFile(
  root: TreeRoot,
  relPath: string,
  text: string,
  expectedStamp: TreeFileStamp,
  options: WriteTreeFileOptions,
): WriteTreeFileResult {
  const platform = options.platform ?? process.platform;
  const pathFs = options.pathFs ?? defaultTreeFs;
  const readFileSync = options.readFileSync ?? ((p: string) => fs.readFileSync(p));
  const writeFileSync = options.writeFileSync ?? ((p, data, writeOptions) => fs.writeFileSync(p, data, writeOptions));
  const renameSync = options.renameSync ?? ((from, to) => fs.renameSync(from, to));
  const unlinkSync = options.unlinkSync ?? ((p) => fs.unlinkSync(p));

  if (typeof text !== "string") return { ok: false, reason: "invalid body" };
  if (
    !expectedStamp ||
    typeof expectedStamp.mtimeMs !== "number" ||
    typeof expectedStamp.size !== "number"
  ) {
    return { ok: false, reason: "invalid version stamp" };
  }

  const resolved = resolveTreePath(root, relPath, platform, pathFs);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  // Same file, not just same relative name. See expectedAbsPath.
  if (options.expectedAbsPath) {
    // Normalise separators and (on Windows) case, but do NOT re-resolve through
    // the host path module: `platform` is injectable, and resolving a posix
    // path on a Windows box mixes the two worlds and fails a comparison that
    // should have passed.
    const norm = (p: string) => {
      const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
      return platform === "win32" ? slashed.toLowerCase() : slashed;
    };
    if (norm(resolved.absPath) !== norm(options.expectedAbsPath)) {
      return { ok: false, reason: "workspace changed" };
    }
  }
  const realAtCheck = canonicalPath(resolved.absPath, pathFs);

  let st: fs.Stats;
  try {
    st = pathFs.statSync(resolved.absPath);
  } catch {
    return { ok: false, reason: "not found" };
  }
  if (!st.isFile()) return { ok: false, reason: "not a file" };

  const kind = classifyFilePreview(resolved.relPath || path.basename(resolved.absPath));
  if (kind !== "markdown" && kind !== "json" && kind !== "text") {
    return { ok: false, reason: "file type is not editable" };
  }
  // NO executable refusal here, deliberately. `isExecutableOpenTarget` answers
  // "would handing this path to shell.openPath risk LAUNCHING code" — read its
  // own doc comment — and that is the right question for Open in default app
  // and Reveal, where it is still asked. Reusing it here answered a different
  // question it was never designed for, and the answer it gave was wrong:
  // saving `deploy.sh` from the panel was refused while the AGENT could rewrite
  // the same file on request, so the rule stopped the human and not the
  // machine. It also caught any file with the POSIX execute bit on macOS and
  // Linux, so an extensionless `chmod +x` script could not be edited either.
  // What actually protects this path is unchanged: the containment fence below,
  // the realpath re-check before the rename, the version stamp, and the size
  // cap.

  // Match readTreeFile's use-time containment check before reading the source
  // bytes whose encoding/EOL style will be preserved.
  const checked = recheckTreePathForRead(
    root,
    relPath,
    resolved.absPath,
    realAtCheck,
    platform,
    pathFs,
  );
  if (!checked.ok) return { ok: false, reason: checked.reason };

  let current: Buffer;
  try {
    current = readFileSync(checked.absPath);
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "unreadable" };
  }
  if (current.subarray(0, Math.min(current.length, 8192)).includes(0)) {
    return { ok: false, reason: "binary file" };
  }
  const decoded = decodeUtf8(current);
  if (!decoded) return { ok: false, reason: "invalid UTF-8" };

  let currentStamp: TreeFileStamp;
  try {
    const latest = pathFs.statSync(checked.absPath);
    currentStamp = { mtimeMs: latest.mtimeMs, size: latest.size };
  } catch {
    return { ok: false, reason: "not found" };
  }
  if (
    currentStamp.mtimeMs !== expectedStamp.mtimeMs ||
    currentStamp.size !== expectedStamp.size
  ) {
    return { ok: false, reason: "changed" };
  }

  // Line endings ARE restored, and must be: a textarea normalises every CRLF it
  // is handed to LF on read, so a submission's line endings say nothing about
  // what the user typed. Reapplying the file's dominant style is what stops
  // every save from rewriting a CRLF file wholesale.
  //
  // The FINAL NEWLINE is the opposite case — it survives that round-trip, so a
  // submission that lacks one lacks it because the user deleted it. It used to
  // be forced back to the file's previous state alongside the line endings,
  // which silently reversed exactly that edit while the client recorded the
  // text it sent as its clean baseline and reported "Saved." — the editor
  // showed the change applied and the file on disk did not have it.
  //
  // Honouring the submission is safe here because `expectedStamp` has already
  // proved the file is byte-identical to what this client was handed, so any
  // difference between `decoded.text` and `text` is the user's edit and nothing
  // else. An end of file nobody touched still round-trips its own newline.
  //
  // That argument depends on the client having been handed the file's own text.
  // `readTreeFile` TRANSFORMS one kind — it pretty-prints JSON — and
  // `JSON.stringify` emits no trailing newline, so the transform used to hand
  // back a newline-less copy of a file that had one and this writer would then
  // honour the "deletion" nobody made. The read path now carries the original's
  // trailing newline across that transform, which is what keeps the rule below
  // to a single case. Any future transform on the read path owes the same debt.
  const eol = textDetails(decoded.text, st, decoded.bom).lineEnding === "crlf" ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n|\r|\n/g, eol);
  const body = Buffer.from((decoded.bom ? "\ufeff" : "") + normalized, "utf8");
  if (body.byteLength > FILE_PREVIEW_MAX_BYTES) {
    return { ok: false, reason: "file too large" };
  }

  const dir = path.dirname(checked.absPath);
  const temp = path.join(
    dir,
    `.${path.basename(checked.absPath)}.grok-save-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  let tempWritten = false;
  try {
    writeFileSync(temp, body, { flag: "wx", mode: st.mode & 0o7777 });
    tempWritten = true;

    // This is deliberately the last path check before the target rename. A
    // link swap after the earlier check must not redirect the replacement.
    const finalCheck = recheckTreePathForRead(
      root,
      relPath,
      resolved.absPath,
      realAtCheck,
      platform,
      pathFs,
    );
    if (!finalCheck.ok || finalCheck.absPath !== checked.absPath) {
      return { ok: false, reason: finalCheck.ok ? "path changed since check" : finalCheck.reason };
    }
    // The containment re-check above stays — a link swapped between the first
    // check and the rename is a real attack and this is where it is caught.
    // Only the executable question is gone; see the note at the top.
    let finalStat: fs.Stats;
    try {
      finalStat = pathFs.statSync(finalCheck.absPath);
    } catch {
      return { ok: false, reason: "not found" };
    }
    if (finalStat.mtimeMs !== expectedStamp.mtimeMs || finalStat.size !== expectedStamp.size) {
      return { ok: false, reason: "changed" };
    }

    try {
      renameSync(temp, finalCheck.absPath);
    } catch (e) {
      // Windows does not replace an existing file with renameSync. Keep the
      // same temp+rename design and use a recoverable backup only for that OS.
      const code = (e as NodeJS.ErrnoException).code;
      if (platform !== "win32" || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(code || "")) {
        throw e;
      }
      const backup = `${finalCheck.absPath}.grok-save-backup-${process.pid}-${Date.now()}`;
      renameSync(finalCheck.absPath, backup);
      try {
        renameSync(temp, finalCheck.absPath);
      } catch (replaceError) {
        try { renameSync(backup, finalCheck.absPath); } catch { /* best effort restore */ }
        throw replaceError;
      }
      try { unlinkSync(backup); } catch { /* harmless backup residue */ }
    }
    tempWritten = false;
    const savedStat = pathFs.statSync(finalCheck.absPath);
    return {
      ok: true,
      relPath: finalCheck.relPath,
      absPath: finalCheck.absPath,
      stamp: { mtimeMs: savedStat.mtimeMs, size: savedStat.size },
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "write failed" };
  } finally {
    if (tempWritten) {
      try { unlinkSync(temp); } catch { /* best effort cleanup */ }
    }
  }
}

/**
 * Breadcrumb segments for a workspace-relative path.
 * Root is always the first segment with relPath "".
 */
export function breadcrumbSegments(
  relPath: string,
  rootLabel: string,
): { label: string; relPath: string }[] {
  const segs: { label: string; relPath: string }[] = [
    { label: rootLabel || "Files", relPath: "" },
  ];
  const trimmed = (relPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return segs;
  const parts = trimmed.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    segs.push({ label: part, relPath: acc });
  }
  return segs;
}

/**
 * True when `p` is a single filename with no directory components (and not an
 * absolute Windows/Unix path). Chat agents often emit bare basenames like
 * `product-decisions.md` for files that actually live under `docs/`.
 */
export function isBareFileName(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (p.includes("\0")) return false;
  const t = p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!t || t === "." || t === "..") return false;
  if (t.includes("/")) return false;
  // Absolute Windows drive or UNC.
  if (/^[A-Za-z]:/.test(p) || p.startsWith("\\\\")) return false;
  return true;
}

/** Directory basenames skipped while searching for a bare filename. */
export const FIND_BASENAME_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".grok",
  ".hg",
  ".svn",
  "dist",
  "out",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
]);

/** Cap visits so a huge monorepo cannot freeze open-from-chat. */
export const FIND_BASENAME_MAX_VISITS = 8000;

/**
 * Bounded search under `root` for a file whose basename matches (case-sensitive
 * on POSIX, case-insensitive on win32). Prefers the shallowest hit, then
 * lexical order. Skips bulky/generated dirs. Returns a workspace-relative
 * POSIX path or null.
 */
export function findRelPathByBasename(
  root: string,
  basename: string,
  platform: NodeJS.Platform = process.platform,
  pathFs: TreePathFs = defaultTreeFs,
  opts?: { maxVisits?: number; skipDirs?: ReadonlySet<string> },
): string | null {
  if (!root || !basename || basename.includes("/") || basename.includes("\\")) {
    return null;
  }
  if (basename === "." || basename === ".." || basename.includes("\0")) return null;

  const maxVisits = opts?.maxVisits ?? FIND_BASENAME_MAX_VISITS;
  const skip = opts?.skipDirs ?? FIND_BASENAME_SKIP_DIRS;
  const win = platform === "win32";
  const want = win ? basename.toLowerCase() : basename;

  type Hit = { rel: string; depth: number };
  const hits: Hit[] = [];
  let visits = 0;

  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (visits >= maxVisits) return;
    let ents: fs.Dirent[];
    try {
      ents = pathFs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (visits >= maxVisits) return;
      visits++;
      const name = ent.name;
      if (!name || name === "." || name === "..") continue;
      const childRel = relDir ? `${relDir}/${name}` : name;
      const childAbs = path.join(absDir, name);

      let isDir = false;
      let isFile = false;
      try {
        if (typeof ent.isDirectory === "function" && ent.isDirectory()) isDir = true;
        else if (typeof ent.isFile === "function" && ent.isFile()) isFile = true;
        else if (typeof ent.isSymbolicLink === "function" && ent.isSymbolicLink()) {
          const st = pathFs.statSync(childAbs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        }
      } catch {
        continue;
      }

      if (isDir) {
        if (skip.has(name) || (win && skip.has(name.toLowerCase()))) continue;
        // Stay inside the root (refuse outbound links).
        if (!isCanonicallyInsideRoot(root, childAbs, platform, pathFs)) continue;
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!isFile) continue;
      const got = win ? name.toLowerCase() : name;
      if (got === want) {
        if (!isCanonicallyInsideRoot(root, childAbs, platform, pathFs)) continue;
        hits.push({ rel: childRel, depth });
      }
    }
  };

  walk(path.resolve(root), "", 0);
  if (!hits.length) return null;
  hits.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  return hits[0]!.rel;
}

/** True when `absPath` exists and is a regular file. */
export function isExistingFile(
  absPath: string,
  pathFs: TreePathFs = defaultTreeFs,
): boolean {
  try {
    return pathFs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}
