/**
 * Universal diff synthesis (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 3).
 *
 * Grok and Codex already report an ACP `{ type: "diff" }` content block on
 * their edit tool calls; Antigravity (agy), Claude, and native Gemini often
 * don't — they report only the tool's raw parameters. This module builds the
 * same block shape from those parameters so the chat webview's existing
 * diff-viewing pipeline (`applyToolDiffs` in media/chat.js) works the same
 * way regardless of which CLI produced the edit.
 *
 * Pure — no `fs`, no `vscode`. Callers read the file (when a whole-file
 * `oldText` is needed) and pass the text in as `diskText`.
 */

export type AcpDiffDetail = {
  old_string: string;
  new_string: string;
  old_line?: number;
  new_line?: number;
  context_before?: string;
  context_after?: string;
  line_prefix?: string;
};

export type AcpDiffBlock = {
  type: "diff";
  path: string;
  oldText: string;
  newText: string;
  _meta?: {
    old_line?: number;
    new_line?: number;
    details?: AcpDiffDetail[];
  };
};

export type SynthesizeEditDiffInput = {
  path: string;
  oldText: string;
  newText: string;
  oldLine?: number;
  newLine?: number;
  replaceAll?: boolean;
  /** One entry per replaced site, for a multi-site edit. */
  details?: Array<{
    old_string: string;
    new_string: string;
    old_line?: number;
    new_line?: number;
  }>;
};

/** Build a diff block from a tool's edit parameters. Returns undefined for an
 *  empty path — a diff nobody can resolve a file for is worse than no diff. */
export function synthesizeEditDiff(input: SynthesizeEditDiffInput): AcpDiffBlock | undefined {
  const path = (input.path || "").trim();
  if (!path) return undefined;
  const oldText = input.oldText ?? "";
  const newText = input.newText ?? "";
  const details = (input.details ?? [])
    .filter((d) => typeof d.old_string === "string" || typeof d.new_string === "string")
    .map((d) => ({
      old_string: d.old_string ?? "",
      new_string: d.new_string ?? "",
      ...(d.old_line !== undefined ? { old_line: d.old_line } : {}),
      ...(d.new_line !== undefined ? { new_line: d.new_line } : {}),
    }));
  const meta: AcpDiffBlock["_meta"] = {};
  if (input.oldLine !== undefined) meta.old_line = input.oldLine;
  if (input.newLine !== undefined) meta.new_line = input.newLine;
  if (details.length) meta.details = details;
  return {
    type: "diff",
    path,
    oldText,
    newText,
    ...(Object.keys(meta).length ? { _meta: meta } : {}),
  };
}

function isDiffBlock(block: unknown): block is AcpDiffBlock {
  return !!block && typeof block === "object" && (block as any).type === "diff";
}

/**
 * A diff block that shows no change at all — `oldText === newText` at the
 * block level, and no `_meta.details[]` site says otherwise — conveys
 * nothing to the user (a "+0 −0" card with an empty region). Claude's own
 * diff blocks are documented as unreliable (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md
 * § 1.1: "Edit/Write kommen oft nur als rawInput", and even when a `content`
 * diff does arrive it has been observed blank); a degenerate one like that is
 * strictly worse than a diff synthesized from the tool's own rawInput, so it
 * does not count as "already has a diff" for idempotency purposes.
 */
function isUsefulDiffBlock(block: AcpDiffBlock): boolean {
  if (block.oldText !== block.newText) return true;
  const details = block._meta?.details;
  return Array.isArray(details) && details.some((d) => d && d.old_string !== d.new_string);
}

function findDiffIndexForPath(content: unknown[], path: string): number {
  return content.findIndex((block) => isDiffBlock(block) && block.path === path);
}

/**
 * Append a synthesized diff onto a tool call's `content`, never replace it —
 * `content = [diff]` would drop terminal output, plan text, or a diff another
 * site already produced. Idempotent per path: a USEFUL native diff for the
 * same file always wins over a synthesized one, so this never emits a second
 * block for a path that already carries one. A degenerate existing block
 * (see {@link isUsefulDiffBlock}) is replaced in place instead — two
 * "open diff →" buttons for one path would be worse than one correct one.
 */
export function mergeDiffIntoContent(content: unknown, diff: AcpDiffBlock | undefined): unknown[] {
  const existing = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];
  if (!diff) return existing;
  const at = findDiffIndexForPath(existing, diff.path);
  if (at === -1) return [...existing, diff];
  if (isUsefulDiffBlock(existing[at] as AcpDiffBlock)) return existing;
  const next = [...existing];
  next[at] = diff;
  return next;
}

/** True when `content` already carries a USEFUL native diff block for `path`
 *  (or, with no path given, any useful diff block at all) — see
 *  {@link isUsefulDiffBlock}. A degenerate block does not count, so a caller
 *  gating synthesis on this still attempts to build a better one. */
export function contentHasDiff(content: unknown, path?: string): boolean {
  if (!Array.isArray(content)) return false;
  if (path === undefined) {
    return content.some((block) => isDiffBlock(block) && isUsefulDiffBlock(block));
  }
  const at = findDiffIndexForPath(content, path);
  return at !== -1 && isUsefulDiffBlock(content[at] as AcpDiffBlock);
}
