/**
 * Desktop-only authorization for renderer-originated Host actions.
 *
 * Schema validation ({@link parseWebviewMsg}) proves a message is *well-formed*.
 * This module decides whether the operation is *allowed* — the same role
 * {@link remote-policy} plays for AFK Pilot clients. VS Code never loads this
 * file; extension behaviour is unchanged.
 *
 * Applied in {@link ElectronWebview.dispatchMessage} before sidebar handlers
 * see sensitive operations. Containment reuses the file-tree canonical check so
 * chat links cannot bypass the panel's workspace fence. Session-scoped roots
 * (worktree cwd + source git root) are supplied by the host — the message gate
 * alone has no session context.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFileRef } from "../file-ref";
import {
  isTrustedGeneratedMediaPath,
  resolveSessionGeneratedMediaPath,
  type RealpathFn,
} from "../media-serve";
import { isTrustedPlanReviewPath } from "../plan-review";
import type { WebviewMsg } from "../protocol";
import { keepsCanonicalDirectChildIdentity } from "../sessions";
import {
  findRelPathByBasename,
  isBareFileName,
  isExistingFile,
  resolveTreePath,
  type TreePathFs,
} from "./file-tree";

/** Extensions the OS may launch as code / scripts / installers / launchers. */
const EXECUTABLE_EXTS = new Set([
  // Windows PE / scripts / shortcuts
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".msi",
  ".msp",
  ".scr",
  ".pif",
  ".cpl",
  ".msc",
  ".ps1",
  ".psm1",
  ".psd1",
  ".vbs",
  ".vbe",
  ".jse",
  ".wsf",
  ".wsh",
  ".ws",
  ".lnk",
  ".hta",
  // Unix shells / binaries commonly double-clicked or openPath'd
  ".sh",
  ".bash",
  ".zsh",
  ".csh",
  ".ksh",
  ".run",
  ".app",
  ".command",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  // Desktop entry launchers (Linux) — shell.openPath can invoke them
  ".desktop",
  // Cross-platform script runners that shell.openPath may hand to an interpreter
  ".jar",
  ".apk",
]);

/** POSIX any-execute bits (owner/group/other). */
const POSIX_ANY_EXECUTE = 0o111;

export type DesktopAuthResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Path-bearing open/read authorize result — success carries the path to use. */
export type DesktopOpenPathResult =
  | { ok: true; /** Absolute path that passed containment (link path when still in-tree). */ absPath: string }
  | { ok: false; reason: string };

/**
 * Context for path-bearing desktop operations (openFile / openDiff / dropFile).
 * Prefer {@link allowedRoots} (session cwd + worktree + workspace); {@link workspaceRoot}
 * remains for call sites that only know the active project folder.
 */
export interface DesktopOpenFileContext {
  /** Bound conversation cwd, when a native chat pane initiated the open. */
  sessionCwd?: string;
  /** Absolute workspace / project root; used when allowedRoots is empty. */
  workspaceRoot?: string | undefined;
  /**
   * Every root the active session may open files under (workspace root,
   * session cwd / worktree path, worktree source git root). Tried in order.
   */
  allowedRoots?: readonly string[];
  platform?: NodeJS.Platform;
  pathFs?: TreePathFs;
  /**
   * When true, `dropFile` must carry a host-minted `handle` and must not carry
   * a renderer-supplied `path`. Desktop sets this; VS Code never uses this module.
   */
  requireDropFileHandle?: boolean;
  /** Resolve a one-shot selection handle to an absolute filesystem path. */
  resolveDropFileHandle?: (handle: string) => string | null;
  /**
   * Grok home (`~/.grok`). Used with {@link sessionDir} to resolve safe relative
   * `images|videos/<file>` links when the workspace candidate is missing.
   * Absolute generated-media opens must be trusted under this root **and** under
   * a {@link sessionCatalogDirs} entry (never-escape-home + project scope).
   */
  grokHome?: string | undefined;
  /**
   * Active session on-disk directory (`…/sessions/<cwd>/<id>`). Used with
   * {@link grokHome} to resolve safe relative `images|videos/<file>` links when
   * the workspace candidate is missing. Relative links stay session-local
   * (canonical containment under this dir — not only lexical — so a symlink
   * into a sibling session is refused).
   */
  sessionDir?: string | undefined;
  /**
   * Project session catalogs (`…/sessions/<urlencoded-cwd>` including case
   * aliases from {@link sessionCatalogDirs}). Absolute generated-media paths
   * must be trusted under **any** of these **and** under {@link grokHome} —
   * same-project sibling sessions (fork replay) pass; other repositories'
   * catalogs do not. Each catalog's realpath must keep the same urlencoded-cwd
   * leaf **and** remain a direct child of the canonical `<grokHome>/sessions`
   * root (a junction that renames the leaf, or relocates the same leaf under
   * e.g. `~/.grok/other/<leaf>`, fails that identity check).
   */
  sessionCatalogDirs?: readonly string[] | undefined;
  /** Host-owned review directory for the focused conversation; not a general auth root. */
  planReviewSessionRoot?: string | undefined;
  /**
   * Claude Code's own plans directory (`<home>/.claude/plans`).
   *
   * Claude writes a plan there and then cites the path, so refusing it made the
   * link it had just given the user dead — "path escapes authorized roots" for
   * a file the agent authored during this conversation. Same provenance class
   * as `planReviewSessionRoot`: a direct Markdown child, nothing else, and NOT
   * added to `desktopAuthRoots`, so it never becomes a general read root.
   */
  claudePlansRoot?: string | undefined;
}

/** Deduped non-empty absolute roots from the auth context. */
export function desktopAuthRoots(ctx: DesktopOpenFileContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (r: string | undefined) => {
    if (!r || typeof r !== "string") return;
    const t = r.trim();
    if (!t) return;
    const key = process.platform === "win32" ? t.toLowerCase() : t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  if (ctx.allowedRoots) {
    for (const r of ctx.allowedRoots) add(r);
  }
  add(ctx.workspaceRoot);
  return out;
}

/**
 * True when the path's basename extension is one the OS may launch as code
 * (PE, scripts, shortcuts, `.desktop` launchers, packages). Pure — no FS.
 * Prefer {@link isExecutableOpenTarget} when a real path and mode are available.
 */
export function isExecutablePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (!ext) return false;
  return EXECUTABLE_EXTS.has(ext);
}

/**
 * True when handing this path to `shell.openPath` risks launching code:
 * dangerous extension on the path **or** its canonical (realpath) target,
 * a `.desktop` launcher, or (non-Windows) any POSIX execute bit on the
 * canonical file. Symlinks to binaries / `chmod +x` scripts without an
 * extension are refused even when the link name looks safe.
 */
export function isExecutableOpenTarget(
  absPath: string,
  opts?: {
    platform?: NodeJS.Platform;
    pathFs?: Pick<TreePathFs, "realpathSync" | "statSync">;
  },
): boolean {
  if (!absPath || typeof absPath !== "string") return false;
  if (isExecutablePath(absPath)) return true;

  const platform = opts?.platform ?? process.platform;
  const pathFs = opts?.pathFs;
  let real = absPath;
  try {
    real = pathFs ? pathFs.realpathSync(absPath) : fs.realpathSync(absPath);
  } catch {
    // Name check already ran; no FS metadata → not further refuse.
    return false;
  }
  if (real !== absPath && isExecutablePath(real)) return true;

  // Windows PE/scripts are extension-based; mode bits are not a reliable
  // "is this a program" signal (and Node reports them loosely).
  if (platform === "win32") return false;

  try {
    const st = pathFs ? pathFs.statSync(real) : fs.statSync(real);
    if (typeof st.isFile === "function" && !st.isFile()) return false;
    if (typeof st.mode === "number" && (st.mode & POSIX_ANY_EXECUTE) !== 0) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Realpath from the auth context's injectable pathFs, or the host default. */
function authRealpath(ctx: DesktopOpenFileContext): RealpathFn {
  const pathFs = ctx.pathFs;
  if (pathFs) {
    return (p: string) => pathFs.realpathSync(p);
  }
  return (p: string) => fs.realpathSync(p);
}

/**
 * Authorize a chat `openFile` / `openDiff` path: must resolve inside one of the
 * authorized session roots with the same canonical containment as the file tree,
 * and must not be an executable (name, symlink target, or POSIX +x).
 *
 * Additionally allows absolute paths that pass {@link isTrustedGeneratedMediaPath}
 * under **both** {@link DesktopOpenFileContext.grokHome} and any
 * {@link DesktopOpenFileContext.sessionCatalogDirs} entry (session
 * `images|videos` only — never escape home, and not other projects' catalogs),
 * and relative `images|videos/<file>` links resolved against
 * {@link DesktopOpenFileContext.sessionDir}. Does not add a general allowed
 * root for grok home.
 *
 * On success returns the absolute path to use (the resolveTreePath absPath —
 * link path when the link itself is still under the root). Callers that open
 * or read must not trust a path authorized earlier: call
 * {@link revalidateOpenFileForUse} immediately before use.
 *
 * `rawPath` may be absolute or root-relative (and may carry a `#L` / `:line`
 * suffix already stripped by the caller, or still present — we only need the
 * filesystem path portion).
 */
export function authorizeOpenFile(
  rawPath: string,
  ctx: DesktopOpenFileContext,
): DesktopOpenPathResult {
  if (!rawPath || typeof rawPath !== "string") {
    return { ok: false, reason: "empty path" };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "null byte in path" };
  }
  const roots = desktopAuthRoots(ctx);
  // Same precondition as openFsPath: no project folder → refuse, including
  // trusted media. Media is an extra provenance class under an open workspace,
  // not a standalone open mode when nothing is authorized.
  if (!roots.length) {
    return { ok: false, reason: "no workspace root" };
  }
  const platform = ctx.platform ?? process.platform;
  const realpath = authRealpath(ctx);

  // Workspace-first: prefer an authorized root when the path lands inside one.
  // When the workspace candidate exists as a file, it wins over session media.
  // When it is only a lexical in-tree path (file missing), we still return it
  // here so openDiff / relative opens keep working; session-media fallback for
  // missing generated links is applied in {@link resolveAuthorizedFileForOpen}.
  for (const root of roots) {
    const resolved = resolveTreePath(root, rawPath, platform, ctx.pathFs);
    if (!resolved.ok) continue;
    if (
      isExecutableOpenTarget(resolved.absPath, {
        platform,
        pathFs: ctx.pathFs,
      })
    ) {
      return { ok: false, reason: "executable path refused" };
    }
    return { ok: true, absPath: resolved.absPath };
  }

  // Plan snapshots are a separate provenance class. They are permitted only
  // as a direct Markdown child of the focused conversation's host-owned review
  // directory; globalStorage is deliberately not added to desktopAuthRoots.
  const planRoots = [ctx.planReviewSessionRoot, ctx.claudePlansRoot].filter(
    (root): root is string => !!root,
  );
  for (const planRoot of planRoots) {
    const exists = (p: string) =>
      ctx.pathFs ? isExistingFile(p, ctx.pathFs) : isExistingFile(p);
    if (
      isTrustedPlanReviewPath(rawPath, planRoot, {
        exists,
        realpath,
      }, platform)
    ) {
      return { ok: true, absPath: path.resolve(rawPath) };
    }
  }

  // Trusted generated session media (absolute path, or safe relative + sessionDir).
  const mediaAbs = resolveTrustedMediaOpenPath(rawPath, ctx, realpath);
  if (mediaAbs) {
    if (
      isExecutableOpenTarget(mediaAbs, {
        platform,
        pathFs: ctx.pathFs,
      })
    ) {
      return { ok: false, reason: "executable path refused" };
    }
    return { ok: true, absPath: mediaAbs };
  }

  return { ok: false, reason: "path escapes authorized roots" };
}

/**
 * True when realpath of `catalog` still names the **same** layout catalog:
 * same urlencoded-cwd leaf **and** a direct child of the canonical
 * `<grokHome>/sessions` root. Thin wrapper over
 * {@link keepsCanonicalDirectChildIdentity} (catalog under sessions root).
 */
function catalogKeepsEncodedLeaf(
  catalog: string,
  grokHome: string,
  realpath: RealpathFn,
  platform: NodeJS.Platform,
): boolean {
  const sessionsRoot = path.join(path.resolve(grokHome), "sessions");
  return keepsCanonicalDirectChildIdentity(catalog, sessionsRoot, realpath, platform);
}

/**
 * Absolute path that is trusted generated media under **both** Grok home and a
 * **project** session catalog, or null. Relative `images|videos/<file>` links
 * require {@link DesktopOpenFileContext.sessionDir} (+
 * {@link DesktopOpenFileContext.grokHome}) and stay scoped to that session only
 * (canonical session containment in {@link resolveSessionGeneratedMediaPath}).
 *
 * Both roots are required because {@link isTrustedGeneratedMediaPath} contains
 * against whichever root it is given. Catalog-only would accept a junction at
 * `~/.grok/sessions/<cwd>` whose realpath lies outside home (shape check still
 * sees `/sessions/` on the link path). Home-only would re-open any other
 * project's session media under `~/.grok`.
 *
 * Layout identity ({@link keepsCanonicalDirectChildIdentity}): used twice —
 * catalog under the canonical sessions root, and sessionDir under its catalog.
 * A cross-project catalog junction renames the leaf; a same-leaf relocating
 * junction (`sessions/<leaf>` → `other/<leaf>`) keeps the leaf but leaves the
 * sessions root; a sessionDir junction onto another session (sibling or other
 * repo) renames the leaf and/or leaves the catalog — all refused. The relative
 * branch applies both fences (session dirs are always `catalog/<id>`, including
 * when {@link sessionDirFor} derived them from a junctioned catalog).
 */
function resolveTrustedMediaOpenPath(
  rawPath: string,
  ctx: DesktopOpenFileContext,
  realpath: RealpathFn,
): string | null {
  const platform = ctx.platform ?? process.platform;
  if (path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith("\\\\")) {
    const abs = path.resolve(rawPath);
    const home = ctx.grokHome;
    const catalogs = ctx.sessionCatalogDirs;
    if (!home || !catalogs?.length) return null;
    // Never-escape-home half of the AND (restores pre-catalog-scoping property).
    if (!isTrustedGeneratedMediaPath(abs, home, realpath)) return null;
    // Project-catalog half — same-project sibling sessions still pass so a
    // fork can open media paths that still point at the parent session dir.
    // Refuse catalogs that fail the layout identity fence (leaf + sessions parent).
    for (const catalog of catalogs) {
      if (
        catalog &&
        catalogKeepsEncodedLeaf(catalog, home, realpath, platform) &&
        isTrustedGeneratedMediaPath(abs, catalog, realpath)
      ) {
        return abs;
      }
    }
    return null;
  }

  const home = ctx.grokHome;
  if (!home || !ctx.sessionDir) return null;
  // Relative route: catalog under sessions root, then sessionDir under catalog.
  // sessionDir is always catalog/<id> (sessionDirFor joins a catalog from
  // sessionCatalogDirs with the session id). A relocating catalog junction or
  // a sessionDir junction onto another session fails here before containment.
  const sessionCatalog = path.dirname(path.resolve(ctx.sessionDir));
  if (!catalogKeepsEncodedLeaf(sessionCatalog, home, realpath, platform)) {
    return null;
  }
  if (
    !keepsCanonicalDirectChildIdentity(
      ctx.sessionDir,
      sessionCatalog,
      realpath,
      platform,
    )
  ) {
    return null;
  }
  return resolveSessionGeneratedMediaPath(rawPath, ctx.sessionDir, home, realpath);
}

/**
 * Use-time revalidation for chat open/read (same property as the file-tree
 * panel's final `resolveTreePath` before open/read).
 *
 * Re-runs containment + executable checks immediately before openPath/readFile
 * and returns the path that must be used. A symlink/junction swap between the
 * message-gate authorize and this call (or between the two internal checks)
 * fails closed — the external target is never opened or read.
 *
 * Shared by {@link createElectronHost} `openFsPath` and sidebar `readFileForDiff`.
 */
export function revalidateOpenFileForUse(
  rawPath: string,
  ctx: DesktopOpenFileContext,
): DesktopOpenPathResult {
  const first = authorizeOpenFile(rawPath, ctx);
  if (!first.ok) return first;

  const pathFs = ctx.pathFs;
  const platform = ctx.platform ?? process.platform;
  // Snapshot realpath after the first pass so a swap that keeps the same link
  // path (and would still need a second authorize) is compared explicitly.
  let realAtCheck: string;
  try {
    realAtCheck = pathFs
      ? pathFs.realpathSync(first.absPath)
      : fs.realpathSync(first.absPath);
  } catch {
    realAtCheck = first.absPath;
  }

  const second = authorizeOpenFile(rawPath, ctx);
  if (!second.ok) return second;

  const norm = (p: string) =>
    platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
  if (norm(first.absPath) !== norm(second.absPath)) {
    return { ok: false, reason: "path changed since check" };
  }

  let realNow: string;
  try {
    realNow = pathFs
      ? pathFs.realpathSync(second.absPath)
      : fs.realpathSync(second.absPath);
  } catch {
    realNow = second.absPath;
  }
  if (norm(realAtCheck) !== norm(realNow)) {
    return { ok: false, reason: "path escaped workspace (symlink swap)" };
  }

  // Open/read the path from the final check — never the pre-revalidation string.
  return second;
}

/**
 * Use-time resolution for chat/OS open after containment is proven.
 *
 * 1. Revalidate the raw path (same TOCTOU property as {@link revalidateOpenFileForUse}).
 * 2. If that absolute path exists as a file, open it.
 * 3. If the caller's path is a **bare filename** that is not at the root, search
 *    authorized roots for a matching basename (shallowest hit) and re-authorize
 *    the found relative path — agents often link `product-decisions.md` when
 *    the real file is `docs/product-decisions.md`.
 * 4. Otherwise `{ reason: "file not found" }` — callers must show an **in-app**
 *    message and must **not** hand a missing path to `shell.openPath` (Windows
 *    would raise a shell dialog).
 *
 * Paths that escape authorized roots or look executable still fail closed.
 */
export function resolveAuthorizedFileForOpen(
  rawPath: string,
  ctx: DesktopOpenFileContext,
): DesktopOpenPathResult {
  const check = revalidateOpenFileForUse(rawPath, ctx);
  if (!check.ok) return check;

  const pathFs = ctx.pathFs;
  const exists = (p: string) =>
    pathFs ? isExistingFile(p, pathFs) : isExistingFile(p);
  if (exists(check.absPath)) {
    return check;
  }

  // Workspace miss: try session-generated media for genuinely relative
  // images|videos/<file> links only. Absolute paths the user named are never
  // re-mapped onto a different session-dir file. Workspace existence already
  // won above; this path only runs when that file is absent.
  const mediaTry = trySessionMediaOpen(rawPath, ctx, exists);
  if (mediaTry) return mediaTry;

  // Workspace basename search only for bare links. Multi-segment misses
  // (e.g. `src/missing.md`) stay "not found" — do not invent alternate paths.
  // Sidebar joins a relative bare name with the session cwd, so openFsPath often
  // sees an absolute path whose relative form under a root is still one segment.
  const bareProbe = parseFileRef(rawPath).path;
  const baseName = path.basename(bareProbe.replace(/\\/g, "/"));
  if (!baseName || baseName === "." || baseName === "..") {
    return { ok: false, reason: "file not found" };
  }
  const platform = ctx.platform ?? process.platform;
  const roots = desktopAuthRoots(ctx);
  let looksBare = isBareFileName(bareProbe);
  if (!looksBare) {
    for (const root of roots) {
      const rel = path.relative(root, check.absPath).split(path.sep).join("/");
      if (rel.includes("..")) continue;
      // Single segment under the root ≡ the chat bare-filename case after join.
      if (rel === baseName || (!rel.includes("/") && path.basename(rel) === baseName)) {
        looksBare = true;
        break;
      }
    }
  }
  if (!looksBare) {
    return { ok: false, reason: "file not found" };
  }

  for (const root of roots) {
    const foundRel = findRelPathByBasename(root, baseName, platform, pathFs);
    if (!foundRel) continue;
    // Re-authorize the discovered relative path (executable + containment).
    const again = revalidateOpenFileForUse(foundRel, {
      ...ctx,
      allowedRoots: [root, ...roots.filter((r) => r !== root)],
      workspaceRoot: root,
    });
    if (again.ok && exists(again.absPath)) {
      return again;
    }
  }
  return { ok: false, reason: "file not found" };
}

/**
 * When the workspace-authorized path is missing, resolve a safe **relative**
 * `images|videos/<file>` link against the session dir and re-authorize via the
 * trusted-media gate. Absolute raw paths are left alone — never substitute a
 * different session file for a path the user (or agent) named absolutely.
 *
 * Load-bearing relative-only path: the message gate sees `images/1.jpg`, the
 * sidebar resolves it to the absolute session path via
 * {@link resolveChatOpenFilePath}, and {@link authorizeOpenFile}'s absolute
 * trusted-media branch already authorizes that result. This fallback covers
 * the use-time path that still receives the relative link (workspace miss).
 */
function trySessionMediaOpen(
  rawPath: string,
  ctx: DesktopOpenFileContext,
  exists: (p: string) => boolean,
): DesktopOpenPathResult | null {
  if (!ctx.grokHome || !ctx.sessionDir) return null;

  const bare = parseFileRef(rawPath).path;
  if (
    path.isAbsolute(bare) ||
    /^[A-Za-z]:[\\/]/.test(bare) ||
    bare.startsWith("\\\\")
  ) {
    return null;
  }

  const realpath = authRealpath(ctx);
  // Same relative branch as authorizeOpenFile (catalog + sessionDir identity
  // fences + session/home containment) — not a bare join that would skip the
  // junction fences.
  const media = resolveTrustedMediaOpenPath(bare, ctx, realpath);
  if (!media || !exists(media)) return null;

  // Re-authorize the absolute media path (TOCTOU + executable + trust).
  const again = revalidateOpenFileForUse(media, ctx);
  if (!again.ok) return null;
  if (!exists(again.absPath)) return null;
  return again;
}

/**
 * Authorize `openUrl` / shell.openExternal targets: http(s) and mailto.
 * Blocks file:, javascript:, vscode:, custom handlers, etc.
 */
export function authorizeOpenUrl(url: string): DesktopAuthResult {
  if (!url || typeof url !== "string") {
    return { ok: false, reason: "empty url" };
  }
  const trimmed = url.trim();
  // Reject scheme-relative and whitespace tricks.
  if (/[\r\n\0]/.test(trimmed)) {
    return { ok: false, reason: "invalid url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    return { ok: false, reason: `scheme "${parsed.protocol}" refused` };
  }
  return { ok: true };
}

/**
 * Authorize `dropFile`. On desktop, only a host-minted handle is accepted; a
 * path string from the renderer is refused. On success the message is rewritten
 * to a path-bearing dropFile for the sidebar (VS Code shape).
 */
export function authorizeDropFile(
  msg: Extract<WebviewMsg, { type: "dropFile" }>,
  ctx: DesktopOpenFileContext,
):
  | { msg: Extract<WebviewMsg, { type: "dropFile" }> }
  | { refused: true; reason: string } {
  if (!ctx.requireDropFileHandle) {
    // Non-desktop callers should not use this gate; pass through if path present.
    if (typeof msg.path === "string" && msg.path.length > 0) {
      return { msg: { type: "dropFile", path: msg.path, shift: msg.shift } };
    }
    return { refused: true, reason: "dropFile path required" };
  }
  // Desktop: never accept a renderer-supplied path (forged arbitrary read).
  if (typeof msg.path === "string" && msg.path.length > 0) {
    return { refused: true, reason: "dropFile path refused; use host handle" };
  }
  if (typeof msg.handle !== "string" || !msg.handle) {
    return { refused: true, reason: "dropFile handle required" };
  }
  const resolve = ctx.resolveDropFileHandle;
  if (!resolve) {
    return { refused: true, reason: "dropFile handle resolver missing" };
  }
  const abs = resolve(msg.handle);
  if (!abs) {
    return { refused: true, reason: "unknown or spent dropFile handle" };
  }
  return { msg: { type: "dropFile", path: abs, shift: msg.shift } };
}

/**
 * Policy gate for a parsed WebviewMsg. Returns the message (possibly rewritten)
 * when allowed, or a refusal when the operation must not reach Host/sidebar.
 *
 * Filtered: openFile, showInFolder, openUrl, openDiff, dropFile. Everything else passes
 * (schema validation already ran).
 */
export function authorizeDesktopWebviewMsg(
  msg: WebviewMsg,
  ctx: DesktopOpenFileContext,
): { msg: WebviewMsg } | { refused: true; reason: string; type: WebviewMsg["type"] } {
  if (msg.type === "openUrl" || msg.type === "openUpdateRelease") {
    const r = authorizeOpenUrl(msg.url);
    if (!r.ok) return { refused: true, reason: r.reason, type: msg.type };
    return { msg };
  }
  if (msg.type === "openFile" || msg.type === "showInFolder") {
    // Strip #L / :line suffixes so containment uses the real file path.
    const bare = parseFileRef(msg.path).path;
    const r = authorizeOpenFile(bare, ctx);
    if (!r.ok) return { refused: true, reason: r.reason, type: msg.type };
    return { msg };
  }
  if (msg.type === "openDiff") {
    const bare = parseFileRef(msg.path).path;
    const r = authorizeOpenFile(bare, ctx);
    if (!r.ok) return { refused: true, reason: r.reason, type: msg.type };
    return { msg };
  }
  if (msg.type === "dropFile") {
    const r = authorizeDropFile(msg, ctx);
    if ("refused" in r) return { refused: true, reason: r.reason, type: msg.type };
    return { msg: r.msg };
  }
  return { msg };
}
