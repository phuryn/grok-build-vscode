/**
 * Pure media-path trust checks shared by the host media forwarder and the
 * desktop resource registry.
 *
 * Generated media from ACP is only legitimate when it lives under Grok's
 * session tree (`…/sessions/…/images|videos/…`) with a media extension.
 * Lexical containment under `~/.grok` is **not** enough: a symlink that
 * starts inside the home and resolves outside must not be served or inlined
 * to remotes.
 *
 * A path that fails provenance is refused before any file read. A trusted path
 * may still be inlined as a size-capped data: URI when the current webview
 * cannot serve its root. Renderer-named `app-resource://` paths remain
 * registry-contained.
 */
import * as path from "node:path";
import { isPathInside, keepsCanonicalDirectChildIdentity } from "./sessions";

const GENERATED_MEDIA_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
]);

/**
 * Cap for base64-inlining agent media into the DOM (and remote frames).
 * 8 MiB covers charts / screenshots / typical /imagine stills without
 * stuffing multi-dozen-MB videos into a data: string. Trusted session media
 * under grok home prefers asWebviewUri and is not bound by this for streaming.
 */
export const MAX_INLINE_MEDIA_BYTES = 8 * 1024 * 1024;

/** Free refuse: nothing legitimate reports the CLI credential as an image. */
export function isRefusedMediaBasename(fsPath: string): boolean {
  return /(^|[/\\])auth\.json$/i.test(fsPath || "");
}

/** Injectable realpath so tests can simulate symlink targets without OS privileges. */
export type RealpathFn = (p: string) => string;

/**
 * Refuse when the reported path **or** its canonical target is a secret name
 * (e.g. `chart.png` → symlink → `auth.json`). Missing/unresolvable paths fall
 * back to the reported basename only.
 */
export function isRefusedMediaPath(
  fsPath: string,
  realpath: RealpathFn = (p) => path.resolve(p),
): boolean {
  if (!fsPath) return false;
  if (isRefusedMediaBasename(fsPath)) return true;
  try {
    return isRefusedMediaBasename(realpath(fsPath));
  } catch {
    return false;
  }
}

/**
 * Decoded byte length of a base64 payload (padding-aware). Used to gate
 * ACP-inline media before it is emitted into the webview / relay.
 */
export function base64DecodedByteLength(b64: string): number {
  if (!b64 || typeof b64 !== "string") return 0;
  // Strip whitespace the wire sometimes inserts; count only payload chars.
  const s = b64.replace(/\s+/g, "");
  if (!s) return 0;
  let padding = 0;
  if (s.endsWith("==")) padding = 2;
  else if (s.endsWith("=")) padding = 1;
  return Math.floor((s.length * 3) / 4) - padding;
}

/**
 * Generated media path shape under a Grok home / sessions tree.
 * `…/sessions/<anything>/images|videos/<file.ext>`
 */
export function isGeneratedSessionMediaPath(fsPath: string): boolean {
  const n = path.normalize(fsPath).replace(/\\/g, "/");
  const ext = path.extname(n).toLowerCase();
  if (!GENERATED_MEDIA_EXT.has(ext)) return false;
  return /\/sessions\/.+\/(images|videos)\/[^/]+$/i.test(n);
}

/**
 * Segment-boundary containment (same contract as {@link isPathInside}):
 * `p` is strictly inside `root`, never `root` itself.
 */
export function isLexicallyInside(root: string, p: string): boolean {
  return isPathInside(root, p);
}

/**
 * True when `fsPath` is trusted generated media under `mediaRoot`:
 * generated-session shape + media extension + **canonical** containment
 * (realpath of the file stays inside realpath of the root).
 *
 * When the file does not exist yet, falls back to lexical containment of the
 * link path so a race before the write is not a hard refuse of legitimate media.
 */
export function isTrustedGeneratedMediaPath(
  fsPath: string,
  mediaRoot: string,
  realpath: RealpathFn = (p) => path.resolve(p),
): boolean {
  if (!fsPath || !mediaRoot) return false;
  if (isRefusedMediaPath(fsPath, realpath)) return false;
  if (!isGeneratedSessionMediaPath(fsPath)) return false;

  try {
    const realRoot = realpath(mediaRoot);
    let realFile: string;
    try {
      realFile = realpath(fsPath);
    } catch {
      // Not on disk yet — lexical only.
      return isLexicallyInside(mediaRoot, fsPath);
    }
    if (isRefusedMediaBasename(realFile)) return false;
    // Real target must stay under the media root (strictly inside).
    if (!isLexicallyInside(realRoot, realFile)) return false;
    const ext = path.extname(realFile).toLowerCase();
    if (!GENERATED_MEDIA_EXT.has(ext)) return false;
    return true;
  } catch {
    return false;
  }
}

const UUID_SHAPE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CODEX_IMAGE_SESSION_ID = new RegExp(`^${UUID_SHAPE}$`, "i");
const CODEX_IMAGE_TOOL_CALL_ID = new RegExp(`^exec-${UUID_SHAPE}$`, "i");

export function isCodexGeneratedImageSessionId(value: unknown): value is string {
  return typeof value === "string" && CODEX_IMAGE_SESSION_ID.test(value);
}

export function isCodexGeneratedImageToolCallId(value: unknown): value is string {
  return typeof value === "string" && CODEX_IMAGE_TOOL_CALL_ID.test(value);
}

/** Infer only the captured adapter layout, resolving and fencing it twice. */
export function inferCodexGeneratedImagePath(
  codexHome: string,
  sessionId: unknown,
  toolCallId: unknown,
  resolve: (...segments: string[]) => string = path.resolve,
): string | undefined {
  // Validate both hostile adapter values before either is interpolated into a path.
  if (!isCodexGeneratedImageSessionId(sessionId) || !isCodexGeneratedImageToolCallId(toolCallId)) {
    return undefined;
  }
  const root = resolve(codexHome, "generated_images");
  const candidate = resolve(root, sessionId, `${toolCallId}.png`);
  return isPathInside(root, candidate) ? candidate : undefined;
}

/** Codex imagegen artifact under `<codexHome>/generated_images/<session>/<tool>.png`. */
export function isTrustedCodexGeneratedImagePath(
  fsPath: string,
  codexHome: string,
  realpath: RealpathFn = (p) => path.resolve(p),
): boolean {
  if (!fsPath || !codexHome || path.extname(fsPath).toLowerCase() !== ".png") return false;
  const root = path.resolve(codexHome, "generated_images");
  const resolvedPath = path.resolve(fsPath);
  if (!isPathInside(root, resolvedPath)) return false;
  const relative = path.relative(root, resolvedPath);
  const parts = relative.split(path.sep);
  if (
    parts.length !== 2 ||
    !isCodexGeneratedImageSessionId(parts[0]) ||
    !isCodexGeneratedImageToolCallId(path.basename(parts[1], ".png"))
  ) return false;
  try {
    const realRoot = realpath(root);
    const realFile = realpath(resolvedPath);
    return isPathInside(realRoot, realFile) && !isRefusedMediaPath(resolvedPath, realpath);
  } catch {
    return isPathInside(root, resolvedPath);
  }
}

/**
 * True when `relPath` is a safe relative chat link to session-generated media:
 * exactly `images/<file>` or `videos/<file>` with a media extension.
 *
 * Refuses absolute paths, drive letters, UNC, URI schemes, null bytes, any
 * `..` segment, nested paths, and non-media extensions. Pure — no I/O.
 */
export function isSafeRelativeGeneratedMediaLink(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false;
  if (relPath.includes("\0")) return false;
  // Schemes (file:, http:) and Windows drive letters (C:).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relPath)) return false;
  if (relPath.startsWith("\\\\") || relPath.startsWith("//")) return false;

  const n = relPath.replace(/\\/g, "/");
  if (n.startsWith("/")) return false;

  const segments = n.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length !== 2) return false;
  if (segments.some((s) => s === ".." || s.includes("\0"))) return false;

  const folder = segments[0]!.toLowerCase();
  if (folder !== "images" && folder !== "videos") return false;

  const base = segments[1]!;
  if (!base || base === "." || base === ".." || /[/\\]/.test(base)) return false;
  return GENERATED_MEDIA_EXT.has(path.extname(base).toLowerCase());
}

/**
 * Join a safe relative media link onto a session directory and prove the
 * result is trusted generated media under **both** `sessionDir` and `grokHome`
 * (canonical containment). Session trust keeps a symlink under this session
 * from resolving into a sibling session still inside the home; home trust
 * keeps the target from escaping `~/.grok`. When the whole home sits under a
 * symlink, root and file canonicalize consistently and both checks still pass.
 *
 * Layout identity ({@link keepsCanonicalDirectChildIdentity}) is applied at
 * **both** levels here — self-sufficient, no caller fence required:
 * 1. Catalog (`dirname(sessionDir)`) must stay a direct child of
 *    `<grokHome>/sessions` with the same urlencoded-cwd leaf. A junction at
 *    `sessions/<cwd>` that relocates or renames the catalog would otherwise
 *    make sessionDir identity check against its own (remapped) dirname and
 *    pass — that is exactly the hole a dirname-only fence leaves open.
 * 2. `sessionDir` must stay a direct child of that catalog with the same id.
 *    A junction at `sessions/<cwd>/<id>` onto another session makes
 *    `realpath(sessionDir)` that other directory, so containment against it
 *    would accept that other session's media.
 *
 * Session dirs always live under `<grokHome>/sessions/<catalog>/<id>` —
 * including worktree sessions (their cwd is the worktree path; the catalog
 * leaf is still that cwd's encode under `sessions/`). The worktrees root is
 * the isolated checkout, not session storage.
 *
 * Returns the absolute path, or null when the link is unsafe / untrusted.
 */
export function resolveSessionGeneratedMediaPath(
  relativePath: string,
  sessionDir: string,
  grokHome: string,
  realpath: RealpathFn = (p) => path.resolve(p),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!sessionDir || !grokHome) return null;
  if (!isSafeRelativeGeneratedMediaLink(relativePath)) return null;

  // Layout identity: catalog under <grokHome>/sessions, then session under catalog.
  // Both halves live here so a caller that skips a pre-fence cannot open the
  // catalog-junction hole (desktop also fences via catalogKeepsEncodedLeaf;
  // VS Code's openResource path uses this resolver alone).
  const sessionCatalog = path.dirname(path.resolve(sessionDir));
  const sessionsRoot = path.join(path.resolve(grokHome), "sessions");
  if (
    !keepsCanonicalDirectChildIdentity(
      sessionCatalog,
      sessionsRoot,
      realpath,
      platform,
    )
  ) {
    return null;
  }
  if (
    !keepsCanonicalDirectChildIdentity(
      sessionDir,
      sessionCatalog,
      realpath,
      platform,
    )
  ) {
    return null;
  }

  const segments = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
  if (segments.length !== 2) return null;

  const joined = path.resolve(sessionDir, segments[0]!, segments[1]!);
  // Stay strictly inside the session dir (no root itself, no escape).
  if (!isLexicallyInside(sessionDir, joined)) return null;
  // Canonical half: real target must stay under this session (not a sibling).
  if (!isTrustedGeneratedMediaPath(joined, sessionDir, realpath)) return null;
  if (!isTrustedGeneratedMediaPath(joined, grokHome, realpath)) return null;
  return joined;
}

/**
 * `~` / `~/rest` → `<home>/rest`. Anything else — including `~user/…` and a
 * `~` that is not the first character — is returned untouched.
 */
export function expandLeadingHome(rawPath: string, homeDir?: string | undefined): string {
  if (!homeDir || !rawPath.startsWith("~")) return rawPath;
  const rest = rawPath.slice(1);
  if (rest === "") return homeDir;
  if (rest[0] !== "/" && rest[0] !== "\\") return rawPath; // ~otheruser/…
  // slice(2) drops the separator so join cannot produce a doubled one.
  return path.join(homeDir, rest.slice(1));
}

export type ResolveChatOpenFilePathOpts = {
  /** Bare filesystem path (suffixes like `#L12` already stripped). */
  rawPath: string;
  /** Session cwd / workspace roots tried first (existence wins). */
  workspaceRoots: readonly string[];
  /** On-disk session directory (`…/sessions/<cwd>/<id>`), when known. */
  sessionDir?: string | undefined;
  /** Grok home used by {@link isTrustedGeneratedMediaPath}. */
  grokHome?: string | undefined;
  /** True when the absolute path is an existing regular file. */
  exists: (absPath: string) => boolean;
  realpath?: RealpathFn;
  /** Home directory for a leading `~`. Injected rather than read here so this
   *  stays pure and testable; omit it and `~` is left alone. */
  homeDir?: string | undefined;
  /** Optional resolver to find a relative path inside subtrees/subprojects of a root. */
  findInSubtree?: (root: string, relPath: string) => string | undefined;
};

/**
 * Resolve a chat `openFile` path: workspace file first, then session-generated
 * media for safe relative `images|videos/<file>` links.
 *
 * Absolute paths (drive-letter, UNC, POSIX) pass through **verbatim** — same as
 * the pre-media join path — so host/platform open semantics are unchanged
 * (e.g. win32 does not rewrite `/tmp/x.png` via `path.resolve`). Relative
 * non-media paths fall back to joining the first workspace root.
 */
export function resolveChatOpenFilePath(opts: ResolveChatOpenFilePathOpts): string {
  const rawInput = opts.rawPath;
  if (!rawInput || typeof rawInput !== "string" || rawInput.includes("\0")) {
    return rawInput || "";
  }

  // A leading `~` is the user's home (#125). Expand FIRST so the result takes
  // the absolute branch below — otherwise `~/Downloads/x.md` is treated as a
  // relative name and resolves to `<cwd>/~/Downloads/x.md`, which is why
  // clicking such a link reported "file not found".
  //
  // Only a bare `~` counts. `~user/…` means somebody else's home, which we
  // cannot resolve without consulting the password database, and guessing a
  // sibling of our own home would be wrong. It is left as written.
  let raw = expandLeadingHome(rawInput, opts.homeDir);
  if (/^file:\/\//i.test(raw)) {
    raw = raw.replace(/^file:\/\//i, "");
    if (/^\/[a-zA-Z]:[/\\]/.test(raw)) {
      raw = raw.slice(1);
    }
    try {
      raw = decodeURIComponent(raw);
    } catch {}
  }

  const realpath = opts.realpath ?? ((p: string) => path.resolve(p));
  const roots = opts.workspaceRoots.filter((r) => typeof r === "string" && r.length > 0);

  // Absolute / drive / UNC: pass through unchanged (no rewrite, no auth here —
  // desktop authorizeOpenFile / openFsPath own containment).
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    return raw;
  }

  // Workspace wins when the file actually exists there directly.
  for (const root of roots) {
    const candidate = path.resolve(root, raw);
    if (opts.exists(candidate)) return candidate;
  }

  // Subtree / subproject search in workspace roots when direct candidate does not exist.
  if (opts.findInSubtree) {
    for (const root of roots) {
      const candidate = opts.findInSubtree(root, raw);
      if (candidate && opts.exists(candidate)) return candidate;
    }
  }

  // Session-media fallback for agent-named relative links only.
  if (opts.sessionDir && opts.grokHome) {
    const media = resolveSessionGeneratedMediaPath(
      raw,
      opts.sessionDir,
      opts.grokHome,
      realpath,
    );
    if (media) return media;
  }

  // Default: join first workspace root (or leave relative if none).
  if (roots.length > 0) return path.resolve(roots[0]!, raw);
  return raw;
}
