/**
 * Whole-file expansion for the native diff editor (#66).
 *
 * grok's `diff` content block carries only the **replaced region**
 * (search_replace's `old_string`/`new_string`), so handing it to `vscode.diff`
 * verbatim opens a two-line tab with no surrounding file — you can see *what*
 * changed but not *where*. The file on disk is the missing half of the pair:
 * for a completed edit it already IS the "after" text, for a still-pending
 * permission it is still the "before". Substituting the region into (or out of)
 * it reconstructs both sides in full.
 *
 * Completed updates identify every replaced site with a real post-edit line,
 * and the pre-write echo identifies the first site. Those coordinates prevent
 * a matching token elsewhere in the file from becoming a phantom change. The
 * block-level `replace_all` flag is the only reason to substitute every match.
 * When the region can't be located (the file moved on, or it's too big to hold
 * twice) the caller falls back to the region-only diff rather than inventing a
 * whole-file side.
 *
 * Pure — no `fs`, no `vscode`. The caller reads the file and passes the text in.
 */

/** Above this, expansion is skipped — a diff holds both sides in memory. */
export const MAX_DIFF_EXPAND_BYTES = 2 * 1024 * 1024;

export type DiffSides = {
  oldText: string;
  newText: string;
  /** 0-based line of the first difference — where the editor should open. */
  firstChangedLine: number;
  /** False when expansion was skipped and the sides are the bare region. */
  wholeFile: boolean;
};

export type DiffExpandInput = {
  /** The file's current content, or undefined when it couldn't be read. */
  diskText: string | undefined;
  oldRegion: string;
  newRegion: string;
  /** True for a pending permission — the edit hasn't been written yet. */
  diskIsBefore: boolean;
  /** True only when the tool's raw input explicitly requested replace_all. */
  replaceAll?: boolean;
  /** Per-site coordinates carried by the completed update / pre-write echo. */
  sites?: readonly DiffSite[];
};

export type DiffSite = {
  oldText: string;
  newText: string;
  /** 1-based line coordinates. Completed-update oldLine is also post-edit. */
  oldLine?: number;
  newLine?: number;
};

const lf = (s: string): string => s.replace(/\r\n/g, "\n");

function lineStart(text: string, line: number): number | null {
  if (!Number.isInteger(line) || line < 1) return null;
  let at = 0;
  for (let current = 1; current < line; current++) {
    at = text.indexOf("\n", at);
    if (at < 0) return null;
    at++;
  }
  return at;
}

/** Find a region whose first character is on the requested 1-based line. */
function findAtLine(text: string, needle: string, line: number | undefined): number | null {
  const start = lineStart(text, line ?? 0);
  if (start === null) return null;
  if (!needle) return start;
  const end = text.indexOf("\n", start);
  const at = text.indexOf(needle, start);
  return at >= start && (end < 0 || at <= end) ? at : null;
}

function expandAtSites(
  haystack: string,
  sites: readonly DiffSite[],
  diskIsBefore: boolean,
): string | null {
  const replacements: { at: number; needle: string; replacement: string }[] = [];
  for (const site of sites) {
    const needle = diskIsBefore ? site.oldText : site.newText;
    const replacement = diskIsBefore ? site.newText : site.oldText;
    const line = diskIsBefore ? site.oldLine : site.newLine;
    let at: number | null = null;
    if (Number.isInteger(line) && line! >= 1) {
      at = findAtLine(haystack, needle, line);
      if (at === null) return null;
    } else {
      if (!needle) return null;
      const first = haystack.indexOf(needle);
      if (first < 0) return null;
      if (sites.length > 1) {
        const second = haystack.indexOf(needle, first + 1);
        if (second >= 0) return null;
      }
      at = first;
    }
    replacements.push({ at, needle, replacement });
  }
  replacements.sort((a, b) => b.at - a.at);
  for (let i = 1; i < replacements.length; i++) {
    const later = replacements[i - 1];
    const earlier = replacements[i];
    if (earlier.at + earlier.needle.length > later.at) return null;
  }
  let other = haystack;
  for (const { at, needle, replacement } of replacements) {
    other = other.slice(0, at) + replacement + other.slice(at + needle.length);
  }
  return other;
}

function expandSides(input: DiffExpandInput): { oldText: string; newText: string } | null {
  const { diskText, oldRegion, newRegion, diskIsBefore, replaceAll = false, sites = [] } = input;
  if (typeof diskText !== "string") return null;
  if (diskText.length > MAX_DIFF_EXPAND_BYTES) return null;

  if (oldRegion === "") {
    // A whole-file Write reports oldText:"" in its pre-write echo (it hasn't
    // read the file yet), so the permission card would show a 500-line
    // overwrite as pure adds. Disk is the real "before". A genuine creation
    // has no file on disk (handled above) and already carries the whole file
    // in newRegion, so there is nothing to expand.
    return diskIsBefore && diskText !== "" ? { oldText: diskText, newText: newRegion } : null;
  }

  const needle = diskIsBefore ? oldRegion : newRegion;
  const replacement = diskIsBefore ? newRegion : oldRegion;
  // Raw first so the file is shown byte-for-byte; the LF-normalized retry
  // covers a CRLF file whose region arrived with bare LFs (both sides are
  // normalized together, so that can't manufacture a line-ending diff).
  const attempts: [string, string, string, readonly DiffSite[]][] = [
    [diskText, needle, replacement, sites],
    [
      lf(diskText),
      lf(needle),
      lf(replacement),
      sites.map((site) => ({ ...site, oldText: lf(site.oldText), newText: lf(site.newText) })),
    ],
  ];
  for (const [haystack, find, put, locatedSites] of attempts) {
    let other: string | null;
    if (diskIsBefore && replaceAll) {
      if (!find || !haystack.includes(find)) continue;
      other = haystack.split(find).join(put);
    } else if (locatedSites.length) {
      other = expandAtSites(haystack, locatedSites, diskIsBefore);
    } else {
      if (!find || !haystack.includes(find)) continue;
      const at = haystack.indexOf(find);
      other = replaceAll
        ? haystack.split(find).join(put)
        : haystack.slice(0, at) + put + haystack.slice(at + find.length);
    }
    if (other === null) continue;
    return diskIsBefore ? { oldText: haystack, newText: other } : { oldText: other, newText: haystack };
  }
  return null;
}

/** 0-based index of the first differing line; 0 when the texts are identical. */
export function firstChangedLine(oldText: string, newText: string): number {
  const a = lf(oldText).split("\n");
  const b = lf(newText).split("\n");
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? 0 : shared;
}

export function expandDiffToWholeFile(input: DiffExpandInput): DiffSides {
  const expanded = expandSides(input);
  const { oldText, newText } = expanded ?? { oldText: input.oldRegion, newText: input.newRegion };
  return { oldText, newText, firstChangedLine: firstChangedLine(oldText, newText), wholeFile: expanded !== null };
}

/**
 * What reverting one completed edit should DO, given the file's current
 * (post-edit) disk content (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 5). Pure —
 * the caller performs the actual read/write/delete and any user-facing
 * confirmation.
 *
 * A create (empty `oldRegion`, no multi-site `sites`) has no "before" text to
 * restore, so it reverts by deleting the file — `delete` when the file still
 * holds exactly what the edit wrote, `delete-confirm` when it has since
 * diverged (a later edit or a manual save) and the caller should confirm
 * before destroying that work. Every other edit reconstructs the pre-edit
 * whole file by running {@link expandDiffToWholeFile} against the CURRENT
 * disk content with `diskIsBefore: false` — the same machinery the "open
 * diff →" view uses, run in reverse. `conflict` means the edited region/sites
 * can no longer be found byte-for-byte: a reverse-patch would be a guess, so
 * the caller refuses rather than risk clobbering unrelated later work.
 */
export type EditRevertPlan =
  | { action: "delete" }
  | { action: "delete-confirm" }
  | { action: "write"; text: string }
  | { action: "unreadable" }
  | { action: "conflict" };

export function planEditRevert(input: {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  sites?: readonly DiffSite[];
  /** The file's content right now (post-edit), or undefined if unreadable. */
  currentText: string | undefined;
}): EditRevertPlan {
  const isCreate = input.oldText === "" && !(input.sites && input.sites.length);
  if (isCreate) {
    if (input.currentText === undefined) return { action: "unreadable" };
    return input.currentText === input.newText ? { action: "delete" } : { action: "delete-confirm" };
  }
  if (input.currentText === undefined) return { action: "unreadable" };
  const sides = expandDiffToWholeFile({
    diskText: input.currentText,
    oldRegion: input.oldText,
    newRegion: input.newText,
    diskIsBefore: false,
    replaceAll: input.replaceAll,
    sites: input.sites,
  });
  return sides.wholeFile ? { action: "write", text: sides.oldText } : { action: "conflict" };
}
