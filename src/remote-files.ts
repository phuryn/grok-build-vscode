/**
 * Project file access for remote (phone / browser) clients.
 *
 * ## Scope of this module
 *
 * Browse directories, open one file, read its contents, and — when the host
 * advertises `editProjectFiles` — save edits to an **existing** text file.
 * No create, delete, rename, mkdir, or bulk/large-file download. Those need
 * separate designs; do not grow them here by accident.
 *
 * ## Fence composition (do not invent a second root)
 *
 * 1. **Which root** — {@link repoScopeFor}: for a remote origin, that tab's
 *    selected repo cwd. Remote file access inherits the same per-tab cross-repo
 *    isolation as history / New session, instead of opening a second,
 *    differently-wrong boundary. A phone deliberately reaches *less* than the
 *    desktop panel (which roots at the whole workspace).
 * 2. **Which paths inside it** — {@link resolveTreePath} / {@link listTreeDir} /
 *    {@link readTreeFile} / {@link writeTreeFile}: refuses traversal, refuses
 *    outbound symlinks/junctions, re-resolves before use (TOCTOU). Same
 *    containment the desktop panel uses; pure and unit-tested there.
 *
 * ## Why save reuses writeTreeFile (do not fork a second write path)
 *
 * Desktop already owns the careful bits that matter more remotely than locally:
 * - **TreeFileStamp (mtime + size)** — "did this file change under me?"
 * - **expectedAbsPath** — "is this still the SAME file?" A tab left open on one
 *   project, saved after the active folder moved, resolved its relative path
 *   against the new root and wrote into another project's same-named file. The
 *   stamp alone caught the common case and then offered Overwrite, which
 *   completed the loss. Both guards are mandatory on the remote path.
 * - preserves line ending, BOM, trailing newline
 * - applies the same executable policy as opens
 *
 * Preview classification reuses {@link classifyFilePreview} (and its byte caps)
 * so remote and desktop never disagree on which extensions are text vs binary.
 */

import {
  classifyFilePreview,
  listTreeDir,
  readTreeFile,
  writeTreeFile,
  type ListTreeResult,
  type ReadTreeFileResult,
  type TreeFileStamp,
  type TreePathFs,
  type TreeRoot,
  type WriteTreeFileResult,
} from "./file-tree";
import { repoScopeFor, type MsgOrigin } from "./remote-policy";

/** Cap constants re-exported so callers document the same ceiling. */
export {
  FILE_PREVIEW_MAX_BYTES,
  FILE_PREVIEW_MAX_IMAGE_BYTES,
  FILE_TREE_MAX_ENTRIES,
} from "./file-tree";

export type RemoteFileRootResult =
  | { ok: true; root: string }
  | { ok: false; reason: string };

/**
 * Resolve the filesystem root a remote (or local) message may browse.
 *
 * `claimedCwd` is the cwd the client put on the wire. It must:
 * - be a catalog cwd the host already published (`isKnownCwd`) — otherwise
 *   `allowRemoteRepoTarget`'s default-true trap would let a remote name an
 *   arbitrary path that never appears in the switcher;
 * - equal the tab's scoped root from {@link repoScopeFor} — a known-but-other
 *   checkout would let the phone read a second repo without selecting it first.
 */
export function resolveRemoteFileRoot(opts: {
  origin: MsgOrigin;
  claimedCwd: string;
  selectedCwd: string;
  workspaceRoot: string;
  isKnownCwd: (cwd: string) => boolean;
  sameCwd: (a: string, b: string) => boolean;
}): RemoteFileRootResult {
  if (typeof opts.claimedCwd !== "string" || !opts.claimedCwd) {
    return { ok: false, reason: "missing cwd" };
  }
  // Unknown cwd first: this is the allowRemoteRepoTarget trap. Everything not
  // listed there falls through to true; listing these message types is what
  // makes a forged cwd fail closed.
  if (!opts.isKnownCwd(opts.claimedCwd)) {
    return { ok: false, reason: "cwd was not discovered" };
  }
  const root = repoScopeFor(opts.origin, {
    selectedCwd: opts.selectedCwd,
    workspaceRoot: opts.workspaceRoot,
  });
  if (!root) {
    return { ok: false, reason: "no repository scope" };
  }
  // Per-tab isolation: the claim must be the root this tab is already in.
  // selectRepo is the legitimate way to change that root (view-tier).
  if (!opts.sameCwd(opts.claimedCwd, root)) {
    return { ok: false, reason: "cwd is not this tab's selected repository" };
  }
  return { ok: true, root };
}

/**
 * List one directory under the remote file root. Containment is entirely
 * {@link listTreeDir}'s (canonical + outbound-symlink drop).
 */
export function listRemoteProjectDir(
  root: string,
  relPath: string = "",
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
): ListTreeResult {
  return listTreeDir(root, relPath || "", undefined, platform, pathFs);
}

/**
 * Read one file for the in-page remote viewer. Uses {@link readTreeFile}:
 * text/markdown/json/image only, byte-capped, binary refused. Absolute paths
 * leave the host only when the caller includes edit metadata for a save
 * round-trip ({@link projectFileContentForWire}).
 *
 * Unsupported kinds (`external`) and oversize files fail closed for remote:
 * a phone has no OS open hand-off.
 */
export function readRemoteProjectFile(
  root: TreeRoot,
  relPath: string,
  platform: NodeJS.Platform = process.platform,
  pathFs?: TreePathFs,
  readFileSync?: (p: string) => Buffer,
): ReadTreeFileResult {
  return readTreeFile(root, relPath, platform, pathFs, readFileSync);
}

/**
 * Save an existing text file under the remote file root.
 *
 * Thin wrapper over {@link writeTreeFile} — same stamp + expectedAbsPath guards,
 * same EOL/BOM/executable policy. Existing files only: writeTreeFile refuses
 * missing paths (`not found`); this pass does not create, delete, or rename.
 */
export function writeRemoteProjectFile(
  root: TreeRoot,
  relPath: string,
  text: string,
  expectedStamp: TreeFileStamp,
  options: {
    expectedAbsPath: string;
    platform?: NodeJS.Platform;
    pathFs?: TreePathFs;
    readFileSync?: (p: string) => Buffer;
    writeFileSync?: (
      p: string,
      data: Buffer,
      opts?: { flag?: string; mode?: number },
    ) => void;
    renameSync?: (from: string, to: string) => void;
    unlinkSync?: (p: string) => void;
  },
): WriteTreeFileResult {
  // expectedAbsPath is mandatory on the remote path: a phone tab going stale
  // after the desk switches projects is precisely the cross-project scenario
  // the desktop save learned the hard way. Do not make it optional here.
  if (typeof options.expectedAbsPath !== "string" || !options.expectedAbsPath) {
    return { ok: false, reason: "missing expectedAbsPath" };
  }
  // Text only, decided HERE rather than by the client. The read path already
  // withholds the stamp and absolute path for an image, so no Edit control is
  // painted — but that is a UI affordance and the client is untrusted. Without
  // this, a crafted `writeProjectFile` reaches any non-text file inside the
  // selected repo. Reading an image on a phone is useful; writing one is not.
  const kind = classifyFilePreview(relPath);
  if (kind !== "markdown" && kind !== "json" && kind !== "text") {
    return { ok: false, reason: "only text files can be edited remotely" };
  }
  return writeTreeFile(root, relPath, text, expectedStamp, {
    expectedAbsPath: options.expectedAbsPath,
    platform: options.platform,
    pathFs: options.pathFs,
    readFileSync: options.readFileSync,
    writeFileSync: options.writeFileSync,
    renameSync: options.renameSync,
    unlinkSync: options.unlinkSync,
  });
}

/** Wire-safe success payload for a read. */
export type RemoteProjectFileWire =
  | {
      ok: true;
      kind: "markdown" | "json" | "image" | "text";
      relPath: string;
      text?: string;
      dataUrl?: string;
      pretty?: boolean;
      /** The JSON pretty-printer changed the text; line numbers would not
       *  describe the file on disk. */
      reformatted?: boolean;
      stamp?: TreeFileStamp;
      absPath?: string;
    }
  | { ok: false; reason: string };

/**
 * Strip host-only fields from a read result before it crosses the relay.
 *
 * Absolute paths and stamps leave the machine only when `includeEditMeta` is
 * true (host advertises `editProjectFiles`) and the kind is editable text —
 * the save path needs both. Image previews never get them.
 */
export function projectFileContentForWire(
  result: ReadTreeFileResult,
  opts?: { includeEditMeta?: boolean },
): RemoteProjectFileWire {
  if (!result.ok) {
    // Map "open externally" to a clear remote reason — no OS hand-off on a phone.
    if (result.openExternal) {
      return {
        ok: false,
        reason: result.reason === "open externally"
          ? "file type not previewable"
          : result.reason,
      };
    }
    return { ok: false, reason: result.reason };
  }
  const base: RemoteProjectFileWire = {
    ok: true,
    kind: result.kind,
    relPath: result.relPath,
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.dataUrl !== undefined ? { dataUrl: result.dataUrl } : {}),
    ...(result.pretty !== undefined ? { pretty: result.pretty } : {}),
    ...(result.reformatted !== undefined ? { reformatted: result.reformatted } : {}),
  };
  // Edit meta: only text kinds, only when the host offers a write path. Without
  // both, the client must not paint an Edit control that cannot save safely.
  if (
    opts?.includeEditMeta &&
    result.kind !== "image" &&
    result.stamp &&
    result.absPath
  ) {
    return {
      ...base,
      stamp: result.stamp,
      absPath: result.absPath,
    };
  }
  return base;
}
