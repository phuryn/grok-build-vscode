import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { isPrimerText, isPrimerSummary } from "./grok-primer";
import {
  applyContextOccupancy,
  occupancyFromUsageLog,
  sumUsage,
  type ContextOccupancyEvent,
  type ContextOccupancyState,
  type PromptUsage,
} from "./acp-dispatch";

/** A session with at most this many recorded messages is cheap to confirm as empty
 *  (a primer-only session has ~4). The sweep only reads `chat_history.jsonl` for
 *  sessions under this bound, so it never touches large real sessions. */
export const EMPTY_PRIMER_MAX_MESSAGES = 20;

export interface SessionListEntry {
  id: string;
  cwd: string;
  displayName: string;
  rawSummary: string;
  customName?: string;
  updatedAt: number;
  createdAt: number;
  numMessages: number;
  modelId?: string;
  /** grok's `session_kind` when it marks a non-user session — a `spawn_subagent`
   *  delegation persists its child as a top-level session dir with
   *  `session_kind: "subagent"`; the history list hides those. `"headless"`
   *  marks a session a non-interactive CLI run created (grok ≥1.0.11) — those
   *  STAY in the list: /resume must be able to pick up where a headless run
   *  left off. */
  kind?: "subagent" | "headless";
  /** Worktree label when this session's cwd is an isolated git worktree (P2-8). */
  worktreeLabel?: string;
  /** When the user pinned this conversation, from `SessionMetaOverride`. Drives
   *  the projects rail's Pinned group; absent means unpinned. */
  pinnedAt?: number;
  /** Agent that owns this immutable session. Absent means Grok for compatibility. */
  provider?: "grok" | "codex" | "claude";
}

export interface SessionMetaOverride {
  /** Agent that owns the session. Existing records omit it and therefore mean Grok. */
  provider?: "grok" | "codex" | "claude";
  /** Provider-reported cwd for stores that are not laid out under the Grok home. */
  providerCwd?: string;
  /**
   * "This conversation was used just now", asserted by the host rather than
   * read off disk.
   *
   * Grok ordering is by `updates.jsonl` mtime (see {@link statSessionActivity}),
   * and measured against the real CLI that file is written about **2.1 seconds**
   * after a send (the turn itself ended at 4.5s). So between sending and that
   * write, the row you just typed into sits wherever it was — and a brand-new
   * conversation is not in the list at all. Waiting is the wrong answer to
   * "I just used this".
   *
   * Set when a message is sent and when a session is created. It is a FLOOR,
   * never a ceiling: the on-disk clock wins the moment it is newer, which it
   * will be within seconds — which is also why persisting it alongside the
   * other overrides is harmless rather than a lie that outlives the run. By
   * the time anything reads it again the real file has overtaken it.
   */
  activeAt?: number;
  customName?: string;
  /** The extension's own title, taken from the first user message when a session's
   *  first turn completes. Deliberately NOT stored as `customName`: a name the
   *  user typed and a name we guessed are different claims, and writing the guess
   *  into the same field made it permanent — grok's own `session_summary` for that
   *  session could never surface, so history read as half-sentences of the opening
   *  prompt while `grok sessions list` showed a clean topic (#96). Ranks BELOW the
   *  CLI's title, so it only fills the gap before grok writes one. Always stored
   *  through {@link capAutoName} (`AUTO_NAME_MAX_CHARS`). */
  autoName?: string;
  pinnedAt?: number;
  /** The checkout this pinned session lives in, captured when it was pinned. The
   *  Pinned group spans repos, so it must know where to read each session from —
   *  without this it would have to scan every repo in the catalog to find one
   *  conversation. Written and cleared together with `pinnedAt`. */
  pinnedCwd?: string;
  /** Isolated worktree this session is bound to (P2-8). Lets history reopen the
   *  right cwd and show a worktree badge without re-querying the CLI. */
  worktreePath?: string;
  worktreeLabel?: string;
  sourceGitRoot?: string;
  /** Session-cumulative billing (#53). Ours, not grok's: the CLI reports usage
   *  per prompt and persists only context size in `signals.json`, so this is the
   *  only thing that survives a reload. Absent = never measured (an old session,
   *  or a pre-usage CLI) — the popover then shows no breakdown rather than 0s. */
  usage?: PromptUsage;
  /** Per-turn billing, positioned like `plans`/`permissions`. `usage` above is
   *  just the sum of these. Kept separately because a rewind has to be able to
   *  SUBTRACT the discarded turns, and a single running total can't be undone —
   *  the extension is the only place per-turn usage exists at all (grok reports
   *  it per prompt and never persists it). Sessions predating this field keep
   *  their total uncorrected rather than losing it. */
  usageLog?: {
    afterUserMessage: number;
    afterHistoryEvent?: number;
    usage?: PromptUsage;
    /** This turn's observed adapter prompt size (not the remembered max). */
    contextUsed?: number;
    /** Compaction reset; the next `contextUsed` is the new baseline. */
    compacted?: boolean;
  }[];
  /**
   * Remembered adapter context occupancy (Claude/Codex). The latest prompt
   * size, monotonic between compactions. Grok still reads `signals.json`.
   */
  contextUsed?: number;
  contextWindow?: number;
  contextPendingCompact?: boolean;
  /** Last verdict the user gave to an exit_plan_mode card in this session, for the restore-card label. */
  lastPlanVerdict?: "approved" | "rejected" | "abandoned";
  /** Every plan the user resolved in this session, in chronological order. grok's plan.md only
   *  retains the latest plan content on disk; saving each one here lets the resume view replay
   *  rejected/cancelled plans that grok overwrote later in the conversation. `afterUserMessage`
   *  plus `afterInterjection` positions repeated native revisions inside one prompt. */
  plans?: {
    text: string;
    verdict: "approved" | "rejected" | "abandoned";
    afterUserMessage?: number;
    afterInterjection?: number;
    afterHistoryEvent?: number;
  }[];
  /** Every permission card the user answered in this session, in order. The CLI
   *  doesn't replay `session/request_permission` on `session/load` (it's a server
   *  request, not a session update), so we persist the title + outcome here and
   *  replay each as a collapsed card. `afterUserMessage` positions it inline, like
   *  `plans`. */
  permissions?: { title: string; outcome: "allowed" | "rejected"; toolCallId?: string; afterUserMessage?: number; afterHistoryEvent?: number }[];
  /** Dashboard "unread" badge: a turn finished while this session wasn't focused and
   *  hasn't been opened since. Drives the green/red dot; cleared on open. Persisted
   *  (not tied to the live process) so the badge survives reaping and a reload. */
  unread?: boolean;
  /** The unread turn ended in an error (red dot instead of green). */
  unreadError?: boolean;
  /** Documents uploaded from a remote browser and staged in extension storage.
   *  Retained until the last session/fork referencing each path is deleted. */
  uploadedFiles?: string[];
  /** A composer draft the host rescued when this conversation was disposed out
   *  from under it (provider sign-out). The conversation is the draft's durable
   *  home: broadcasting the text instead is both lossable and audience-wrong,
   *  because the notice goes to whoever is focused rather than to the person who
   *  typed it. Restored into the composer the next time the conversation starts,
   *  and cleared in the same write so a reopen cannot append it twice. */
  queuedDraft?: string;
}
export type SessionMetaOverrides = Record<string, SessionMetaOverride>;

/** Storage ceiling for `autoName`. History rows elide well before this; the cap
 *  exists so a pasted prompt cannot bloat `grok.sessionMeta`. */
export const AUTO_NAME_MAX_CHARS = 120;

/** Prefer a word boundary this close to the cap rather than cutting mid-word. */
const AUTO_NAME_WORD_LOOKBACK = 20;

/** Storage ceiling for `usageLog`: one entry per user prompt, ~260 bytes each.
 *  400 is far above anything observed — measured 2026-08-22 across 1,366 stored
 *  sessions, the longest log was 13 entries and the median was 1. The cap is
 *  here so a marathon session cannot grow `session-meta.json` without bound,
 *  not because today's data needs trimming. */
export const USAGE_LOG_MAX_ENTRIES = 400;

type UsageLogEntry = NonNullable<SessionMetaOverride["usageLog"]>[number];

/**
 * Fold a `usageLog` back under {@link USAGE_LOG_MAX_ENTRIES} by summing its
 * oldest entries into a single carry entry. Returns the SAME array when nothing
 * needed folding, so a load-time sweep can skip the write.
 *
 * **Tokens survive exactly**: `sumUsage` over the folded log equals `sumUsage`
 * over the original, so the session total is unchanged.
 *
 * **Context occupancy survives too.** `contextUsed` is monotonic between
 * compactions, so the last dropped entry's value is already the maximum over
 * everything dropped — which is what `occupancyFromUsageLog` would have folded
 * those entries to. Carrying its `compacted` flag preserves the reset boundary.
 *
 * **The dollar SESSION cost is deliberately given up** on a folded log.
 * `enforceCompleteSessionCost` judges coverage by counting distinct
 * `afterUserMessage` coordinates, and a carry entry carries one where it used
 * to carry many — so a folded session reports its cost as unknown rather than
 * as a number that is quietly too small. That is the existing, designed
 * degradation for incomplete coverage, not a new failure mode, and "unknown"
 * beats "wrong" for a figure the user reads as money.
 *
 * **Known limitation, accepted rather than fixed.** A rewind that lands INSIDE
 * the folded prefix is lossy: `truncateResolvedAfter` filters entries by
 * `afterUserMessage`, and the carry sits at the last dropped turn, so rewinding
 * to an earlier turn discards the carry and with it the usage of turns that
 * survive. No choice of carry position fixes this — placing it at the first
 * dropped turn merely swaps under-reporting for over-reporting. Folding is
 * inherently lossy for rewinds into the folded range.
 *
 * It is left alone because reaching it needs 401 uncompacted turns in one
 * conversation and then a rewind to turn one or two, discarding 399 turns of
 * work. Measured 2026-08-22 across 1,369 stored sessions: the longest log is 13
 * entries. If that distribution ever changes, revisit the cap before the fold.
 */
export function capUsageLog(entries: UsageLogEntry[]): UsageLogEntry[] {
  if (entries.length <= USAGE_LOG_MAX_ENTRIES) return entries;
  // +1 so the carry entry itself fits inside the ceiling.
  const dropCount = entries.length - USAGE_LOG_MAX_ENTRIES + 1;
  const dropped = entries.slice(0, dropCount);
  const boundary = dropped[dropped.length - 1];
  const summed = sumUsage(dropped);
  const carry: UsageLogEntry = summed === undefined
    ? { ...boundary, usage: undefined }
    : { ...boundary, usage: summed };
  return [carry, ...entries.slice(dropCount)];
}

/** Cap every `usageLog` in a session-meta map. Same contract as
 *  {@link capSessionMetaAutoNames}: the identical object back when nothing
 *  changed. Never touches any other field. */
export function capSessionMetaUsageLogs<T extends Record<string, { usageLog?: unknown }>>(
  meta: T,
): { value: T; changed: boolean } {
  let changed = false;
  let next: T | undefined;
  for (const id of Object.keys(meta)) {
    const entry = meta[id];
    if (!entry || !Array.isArray(entry.usageLog)) continue;
    const usageLog = capUsageLog(entry.usageLog as UsageLogEntry[]);
    if (usageLog === entry.usageLog) continue;
    if (!next) next = { ...meta };
    (next as Record<string, unknown>)[id] = { ...entry, usageLog };
    changed = true;
  }
  return { value: next ?? meta, changed };
}

/** Collapse whitespace and cut a candidate `autoName` to {@link AUTO_NAME_MAX_CHARS}.
 *  Cuts on a nearby word boundary when one exists; otherwise a hard cut.
 *  Empty / non-string input becomes `""`. Idempotent on an already-capped value. */
export function capAutoName(name: unknown): string {
  if (typeof name !== "string") return "";
  const collapsed = name.replace(/\s+/g, " ").trim();
  if (collapsed.length <= AUTO_NAME_MAX_CHARS) return collapsed;
  let end = AUTO_NAME_MAX_CHARS;
  // Don't split a surrogate pair at the hard limit.
  if ((collapsed.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1;
  const slice = collapsed.slice(0, end);
  const boundary = slice.lastIndexOf(" ");
  const minKeep = AUTO_NAME_MAX_CHARS - AUTO_NAME_WORD_LOOKBACK;
  if (boundary >= minKeep) return slice.slice(0, boundary).trimEnd();
  return slice.trimEnd();
}

/** Cap every `autoName` in a session-meta map. Returns the same object when
 *  nothing changed so a load-time sweep can skip the write. Never touches
 *  `customName` or any other field. */
export function capSessionMetaAutoNames<T extends Record<string, { autoName?: unknown }>>(
  meta: T,
): { value: T; changed: boolean } {
  let changed = false;
  let next: T | undefined;
  for (const id of Object.keys(meta)) {
    const entry = meta[id];
    if (!entry || typeof entry.autoName !== "string") continue;
    const autoName = capAutoName(entry.autoName);
    if (autoName === entry.autoName) continue;
    if (!next) next = { ...meta };
    (next as Record<string, unknown>)[id] = { ...entry, autoName };
    changed = true;
  }
  return { value: next ?? meta, changed };
}

/** Pick the newest user-visible session from an already-scoped history list. */
export function mostRecentSession(entries: readonly SessionListEntry[]): SessionListEntry | undefined {
  return entries
    .filter((entry) => entry.kind !== "subagent")
    .reduce<SessionListEntry | undefined>(
      (recent, entry) => !recent || entry.updatedAt > recent.updatedAt ? entry : recent,
      undefined,
    );
}

export interface RepoPin {
  cwd: string;
  pinnedAt: number;
}
export type RepoPins = Record<string, RepoPin>;

/** The user's own last word on where a project belongs in the remote client's
 *  rail, and when they said it. A choice is only in force until the project is
 *  worked in again: any conversation newer than `at` overrides it, which is what
 *  makes "using an archived project brings it back" need no bookkeeping.
 *
 *  `archived: false` is a real, stored answer — "keep showing me this one" —
 *  not the absence of one. Without it, unarchiving a long-idle project would be
 *  undone by the age rule on the very next render. */
export interface RepoArchiveChoice {
  cwd: string;
  at: number;
  archived: boolean;
}
export type RepoArchives = Record<string, RepoArchiveChoice>;

/**
 * A cwd a remote may be allowed to name, and the project it belongs to.
 *
 * Provenance travels with the cwd because the alternative is re-deriving it in
 * the fence, and the fence runs on every inbound AND outbound remote message.
 * The trusted-set builder already knows which project each cwd came from — it
 * expanded the project to get there — so carrying the answer out costs nothing
 * and turns the archive check into a map lookup.
 */
export interface TrustedSessionCwd {
  cwd: string;
  /** The project this cwd belongs to: itself, or the project owning a worktree. */
  repoCwd: string;
}

/**
 * Archive choices that newer work has already made moot.
 *
 * `RepoArchiveChoice` has always said a choice holds "only until the project is
 * worked in again", and the renderer implemented that as a timestamp comparison
 * re-derived on every paint. Once the host began fencing remotes on the stored
 * flag, the two sides could disagree about the same project: the desk showed it
 * in Projects while the phone could not reach it, and no refresh helped.
 *
 * Resolving the expiry in the STORE — rather than at every read — is what keeps
 * the fence itself a cheap lookup, and what makes both sides read one answer.
 *
 * ## The part that took four review rounds
 *
 * Two earlier attempts deleted the choice from a session lifecycle event, and
 * both handed a remote back a project the user had archived. Session start
 * includes a reconnecting phone's recovery restart, which bypasses inbound
 * authorization by design; "a completed turn" was no better, because a plain
 * CLI exit reports `error` down the same status path.
 *
 * Fixing the trigger was the wrong instinct. What made those reachable was the
 * EVIDENCE: session-directory mtimes — and `events.jsonl` — move when a
 * conversation is merely loaded, so a remote could manufacture the proof.
 * `newestActivityAt` must therefore be {@link newestTranscriptMtime}, which
 * stats `updates.jsonl` only and never falls back to `events.jsonl` or
 * `summary.json` the way {@link indexSessions} does. A remote cannot move that
 * file without running a turn, and it cannot run a turn in a project it is
 * fenced out of. With evidence that cannot be forged, it stops mattering
 * which event asks the question.
 */
export function expiredArchiveChoiceKeys(opts: {
  archives: RepoArchives;
  /** Newest TRANSCRIPT mtime across the project and its worktrees, ms. */
  newestActivityAt: (repoCwd: string) => number;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const out: string[] = [];
  for (const [storedKey, choice] of Object.entries(opts.archives ?? {})) {
    // `archived: false` is a real stored answer — "keep showing me this one" —
    // and expires the same way, so both are considered.
    if (!choice?.cwd) continue;
    const newest = opts.newestActivityAt(choice.cwd) || 0;
    if (newest > 0 && newest > choice.at) {
      out.push(storedKey || normalizeRepoPath(choice.cwd, platform));
    }
  }
  return out;
}

/**
 * Projects that are archived, as normalised keys.
 *
 * Assumes {@link expiredArchiveChoiceKeys} has already retired the stale ones,
 * which is what lets this stay a plain read of the store on a hot path.
 *
 * A project the host has OPEN is never archived here, matching the rail's own
 * rule. Opening a project does not clear its flag, and fencing one the desk is
 * working in would blind the phone to the conversation on screen.
 */
export function archivedProjectKeys(opts: {
  archives: RepoArchives;
  openCwds: readonly string[];
  platform?: NodeJS.Platform;
}): Set<string> {
  const platform = opts.platform ?? process.platform;
  const key = (c: string) => normalizeRepoPath(c, platform);
  const open = new Set(opts.openCwds.filter(Boolean).map(key));
  const out = new Set<string>();
  for (const choice of Object.values(opts.archives ?? {})) {
    if (!choice?.archived || !choice.cwd) continue;
    const k = key(choice.cwd);
    if (k && !open.has(k)) out.add(k);
  }
  return out;
}

/**
 * The host's trusted cwds, minus everything belonging to an archived project.
 *
 * A REMOTE-only narrowing. On the desk, archiving means "fold this away" — the
 * project is one keystroke from being worked in — so subtracting it locally
 * would break the thing archiving is for. From a phone it should mean what it
 * looks like: out of reach.
 *
 * Filters by each cwd's OWNING PROJECT, not by the cwd itself. A worktree is
 * not something you archive separately, and matching only exact cwds let a
 * worktree the host learned about after the fence was built walk straight
 * through it — the project is the unit, so the project is what is checked.
 *
 * Note what `archived` does NOT include: a project the rail merely hides for
 * being 30 days idle is still reachable here. That rule lives in the renderer
 * and moves on its own, so binding a capability to it would revoke a phone's
 * access with nobody having done anything, mid-conversation included.
 */
export function remoteAuthorizedCwds(opts: {
  trusted: readonly TrustedSessionCwd[];
  archivedProjects: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): string[] {
  if (!opts.archivedProjects.size) return opts.trusted.map((t) => t.cwd);
  const platform = opts.platform ?? process.platform;
  return opts.trusted
    .filter((t) => !opts.archivedProjects.has(normalizeRepoPath(t.repoCwd, platform)))
    .map((t) => t.cwd);
}

/**
 * Project-folder colour ids the rail understands. Empty string is "none"
 * (default): the host still puts `color: ""` on every catalog row so the client
 * can tell "no colour" from "this host cannot colour" without a version check.
 * Non-empty values map 1:1 to CSS `--repo-color-*` custom properties.
 */
export const REPO_COLOR_IDS = ["blue", "teal", "green", "amber", "coral", "purple"] as const;
export type RepoColorId = (typeof REPO_COLOR_IDS)[number];
/** Wire value: one of {@link REPO_COLOR_IDS}, or `""` for none. */
export type RepoColor = RepoColorId | "";

export function isRepoColor(value: unknown): value is RepoColor {
  if (value === "") return true;
  return typeof value === "string" && (REPO_COLOR_IDS as readonly string[]).includes(value);
}

/** Stored folder colour for one project. Absent entry ≡ none; the wire still
 *  emits `color: ""` so capability detection stays field-presence based. */
export interface RepoColorChoice {
  cwd: string;
  color: RepoColorId;
}
export type RepoColors = Record<string, RepoColorChoice>;

export interface RepoListEntry {
  cwd: string;
  label: string;
  available: boolean;
  pinned: boolean;
  pinnedAt?: number;
  updatedAt: number;
  /** Provider a fresh conversation in this project will use. Optional so older
   * hosts keep rendering their existing provider-neutral New-session row. */
  defaultProvider?: "grok" | "codex" | "claude";
  worktreeLabel?: string;
  /**
   * Archive choice flattened for the wire. **Present when the host supports
   * archiving** (VS Code / discovered list) — even when nothing is archived,
   * which is how the client tells "nothing archived" from "this host cannot
   * archive" without a version number. **Omitted** when the host's project
   * list is curated open/close (desktop): close already removes a row, so
   * archive would be a second weaker mechanism. Ordering in
   * {@link discoverRepos} deliberately ignores these fields.
   */
  archived?: boolean;
  archivedAt?: number;
  /**
   * This row exists because the user added the folder by hand, not because Grok
   * has ever run there. Set by the host (VS Code only — see
   * EXTRA_PROJECT_FOLDERS_KEY in `sidebar.ts`), never by {@link discoverRepos},
   * which knows nothing about it.
   *
   * The client uses it to offer removal, and removal is the point: every other
   * row is here because of work that happened, and stops being listed when that
   * stops being true. A hand-added folder has no such expiry, and it is
   * remotely browsable and editable like any other project — so the only way it
   * is honest is if it can be taken back out.
   */
  added?: boolean;
  /**
   * Folder-icon colour id flattened for the wire. **Present when the host
   * supports project colours** — even when unset (`""`), which is how the client
   * tells "no colour" from "this host cannot colour" without a version number
   * (same capability rule as {@link RepoListEntry.archived}). One of
   * {@link REPO_COLOR_IDS}, or empty for none. Ordering in {@link discoverRepos}
   * deliberately ignores this field.
   */
  color?: RepoColor;
}

/** Move a renamed session's `customName` from one id to another and drop the source entry. Used when
 *  a primer-only session is discarded and restarted under a new grok id (a model/effort switch on an
 *  empty session): the user's rename should follow to the new session, and the abandoned id's
 *  override must not linger. Only `customName` carries — a fresh session has no plans/unread/etc.
 *  worth keeping. Pure: removing the on-disk dir is the caller's job. Returns a new map; the input is
 *  left untouched. No-op carry when the source has no `customName` or `toId` is undefined. */
export function carrySessionName(
  overrides: SessionMetaOverrides,
  fromId: string,
  toId: string | undefined,
): SessionMetaOverrides {
  const next: SessionMetaOverrides = { ...overrides };
  const carried = next[fromId]?.customName?.trim();
  delete next[fromId];
  if (carried && toId) next[toId] = { ...(next[toId] ?? {}), customName: carried };
  return next;
}

/** The `(Fork)` tag on a forked session's name (#48). */
export const FORK_NAME_TAG = "(Fork)";

/** Name a fork after its parent, tagged `(Fork)` so it's identifiable in history.
 *
 *  **Leading**, not trailing: history rows ellipsize at the panel edge (and
 *  `fallbackName` truncates at 60 chars), so a trailing tag is the first thing to
 *  disappear — exactly the marker you need to still see in a narrow sidebar.
 *
 *  Idempotent: forking a fork must not stack ("(Fork) (Fork) Foo"), so a name
 *  already carrying the tag is returned unchanged. Matching ignores case but the
 *  parent's own casing is preserved. A blank parent name yields just "(Fork)"
 *  rather than a stray separator. Pure — persisting it is the caller's job. */
export function forkDisplayName(parentName: string | undefined): string {
  const base = (parentName ?? "").trim();
  if (!base) return FORK_NAME_TAG;
  if (base.toLowerCase().startsWith(FORK_NAME_TAG.toLowerCase())) return base;
  return `${FORK_NAME_TAG} ${base}`;
}

export interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, encoding: "utf8"): string;
  statSync(p: string): { isDirectory(): boolean; mtimeMs: number };
  /** `maxRetries`/`retryDelay` are load-bearing on Windows — see RM_RETRY. */
  rmSync?(
    p: string,
    opts?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number },
  ): void;
  rmdirSync(p: string, opts?: { recursive?: boolean }): void;
}

export interface ListDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  overrides: SessionMetaOverrides;
  platform?: NodeJS.Platform;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Percent-encoded leaf under `sessions/` for a given cwd string.
 * Mirrors grok's URL-encoded layout exactly — casing of `cwd` is preserved,
 * so `c:\…` and `C:\…` become distinct leaves on disk.
 */
export function encodeSessionCatalogLeaf(cwd: string): string {
  const encoded = encodeURIComponent(cwd);
  return encoded === "" ? "%00" : encoded === "." ? "%2E" : encoded === ".." ? "%2E%2E" : encoded;
}

/** Build the directory grok uses for sessions rooted at `cwd`. Exact cwd encode
 *  (CLI write path). Prefer {@link sessionCatalogDirs} / {@link sessionDirFor}
 *  with `fs` when *reading* history — those merge case-aliases on Windows. */
export function sessionsDirFor(grokHome: string, cwd: string): string {
  return path.join(grokHome, "sessions", encodeSessionCatalogLeaf(cwd));
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Grok session ids are opaque safe path segments, never paths themselves. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" &&
    SESSION_ID_RE.test(id) &&
    id !== "__proto__" &&
    id !== "prototype" &&
    id !== "constructor";
}

/** True when `candidate` is a direct child of `base` (no `..` escape). */
export function isSessionDirChild(
  base: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const b = path.normalize(base);
  const parent = path.dirname(path.normalize(candidate));
  return platform === "win32"
    ? parent.toLowerCase() === b.toLowerCase()
    : parent === b;
}

/** Injectable realpath for layout-identity checks (tests simulate junctions). */
export type PathRealpathFn = (p: string) => string;

/**
 * True when `child`'s **canonical** form is a direct child of the **canonical**
 * `parent` **and** keeps the same leaf basename as the given `child` path.
 *
 * Fences the class of unsafe shapes where a layout directory is a junction or
 * symlink onto another directory of the same kind: leaf-only is not enough
 * (same name relocated under a different parent), and parent containment alone
 * is not enough (sibling under the same parent with a different leaf). A
 * symlinked ancestor that remaps parent and child together still passes.
 * Case-insensitive leaf compare on win32 for case-aliases of the same segment.
 */
export function keepsCanonicalDirectChildIdentity(
  child: string,
  parent: string,
  realpath: PathRealpathFn,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const givenLeaf = path.basename(path.resolve(child));
    if (!givenLeaf) return false;
    const realChild = path.normalize(realpath(child));
    const realLeaf = path.basename(realChild);
    if (!realLeaf) return false;
    const leafOk =
      platform === "win32"
        ? givenLeaf.toLowerCase() === realLeaf.toLowerCase()
        : givenLeaf === realLeaf;
    if (!leafOk) return false;
    const realParent = path.normalize(realpath(parent));
    return isSessionDirChild(realParent, realChild, platform);
  } catch {
    return false;
  }
}

/**
 * Every on-disk `sessions/<urlencoded-cwd>` directory that is the **same project**
 * as `cwd` under {@link normalizeRepoPath} (case-insensitive on Windows, exact
 * elsewhere). Exact encode of `cwd` is listed first when present.
 *
 * Indexes already split across drive-letter casings (real machines) are merged
 * at read time — we do not rename or delete either leaf. New sessions still land
 * under whatever casing the live CLI process uses.
 */
export function sessionCatalogDirs(deps: {
  fs: Pick<FsLike, "existsSync" | "readdirSync">;
  grokHome: string;
  cwd: string;
  platform?: NodeJS.Platform;
}): string[] {
  const platform = deps.platform ?? process.platform;
  const targetKey = normalizeRepoPath(deps.cwd, platform);
  if (!targetKey) return [];

  const sessionsRoot = path.join(deps.grokHome, "sessions");
  const exact = path.normalize(sessionsDirFor(deps.grokHome, deps.cwd));
  const out: string[] = [];
  // Case-sensitive on the *path string*: catalog leaves that differ only by
  // encoded drive-letter case (`c%3A…` vs `C%3A…`) must both be scanned. Folding
  // the full path would collapse them and hide one side of a split index.
  // (On NTFS those leaves usually can't coexist as siblings — scanning the same
  // physical dir twice is fine; session ids are de-duped by the caller.)
  const seen = new Set<string>();
  const add = (dir: string) => {
    const n = path.normalize(dir);
    if (seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };

  // Prefer the exact encode of the live cwd first (CLI write path for new sessions).
  try {
    if (deps.fs.existsSync(exact)) add(exact);
  } catch {
    /* best-effort */
  }

  try {
    if (!deps.fs.existsSync(sessionsRoot)) return out;
    for (const name of deps.fs.readdirSync(sessionsRoot)) {
      let decoded = "";
      try {
        decoded = decodeURIComponent(name).trim();
      } catch {
        continue;
      }
      if (!decoded || normalizeRepoPath(decoded, platform) !== targetKey) continue;
      // Use the *readdir* leaf name so we open the on-disk casing, not a
      // reconstructed encode that can miss a case-sensitive store.
      add(path.join(sessionsRoot, name));
    }
  } catch {
    /* readdir failed — exact alone is still useful when present */
  }
  return out;
}

export interface SessionDirOpts {
  /** When set, prefer an existing id under any case-alias of `cwd`. */
  fs?: Pick<FsLike, "existsSync" | "readdirSync">;
  platform?: NodeJS.Platform;
}

/** Resolve one session directory and independently prove it is a direct child
 * of a catalog directory for `cwd`. With `opts.fs`, searches every case-alias
 * so a session stored under `c:\…` is found when the workspace is `C:\…`.
 * Without a hit (or without `fs`), returns the exact-encode path for `cwd`
 * (CLI write layout). Undefined means the caller must not touch the filesystem. */
export function sessionDirFor(
  grokHome: string,
  cwd: string,
  id: unknown,
  opts?: SessionDirOpts,
): string | undefined {
  if (!isValidSessionId(id)) return undefined;
  const platform = opts?.platform ?? process.platform;

  if (opts?.fs) {
    for (const base of sessionCatalogDirs({
      fs: opts.fs,
      grokHome,
      cwd,
      platform,
    })) {
      const candidate = path.join(base, id);
      if (!isSessionDirChild(base, candidate, platform)) continue;
      try {
        if (opts.fs.existsSync(candidate)) return candidate;
      } catch {
        /* try next alias */
      }
    }
  }

  const base = path.normalize(sessionsDirFor(grokHome, cwd));
  const candidate = path.join(base, id);
  return isSessionDirChild(base, candidate, platform) ? candidate : undefined;
}

/** Stable repo identity for globalState and remote-policy comparisons. */
export function normalizeRepoPath(cwd: string, platform = process.platform): string {
  let normalized = path.normalize((cwd || "").trim());
  if (normalized !== path.parse(normalized).root) normalized = normalized.replace(/[\\/]+$/, "");
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

/**
 * `absPath` expressed relative to `root`, or undefined when it is not inside it.
 *
 * Exists because "is this file part of this conversation's project?" became a
 * real question. VS Code history follows the rail's selection now, so the active
 * editor can be showing project A while the focused conversation belongs to
 * project B — and attaching A's file, or worse A's selected source text, to B's
 * prompt is content crossing projects.
 *
 * Compared on {@link normalizeRepoPath} keys, which is what makes it right in
 * the two places a naive prefix test is wrong: Windows treats `C:\Repo` and
 * `c:/repo` as one directory, and `/work/app-two` must not read as inside
 * `/work/app`. The result uses forward slashes on every platform — it is a
 * display and prompt path, not a filesystem one.
 */
export function relativePathWithin(
  root: string,
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!root || !absPath) return undefined;
  // The platform's OWN path module, not the process's. `normalizeRepoPath` uses
  // the native one, which is right for its callers (real paths on the machine
  // they are on) and wrong here: this takes `platform` as an argument, so it has
  // to answer for that platform on any host. Otherwise a Windows case decided on
  // Linux CI compares `c:\work\app` against `c:/work/app` and says "outside" —
  // the tests would pass on the author's machine and fail on the runner.
  const p = platform === "win32" ? path.win32 : path.posix;
  const key = (value: string): string => {
    let n = p.normalize((value || "").trim());
    if (n !== p.parse(n).root) n = n.replace(/[\\/]+$/, "");
    return platform === "win32" ? n.toLowerCase() : n;
  };
  const rootKey = key(root);
  const fileKey = key(absPath);
  if (!rootKey || !fileKey || fileKey === rootKey) return undefined;
  // Separator-terminated, so a sibling that merely shares a name prefix cannot
  // match: `/work/app-two` is not inside `/work/app`.
  if (!fileKey.startsWith(rootKey.replace(/[\\/]+$/, "") + p.sep)) return undefined;
  return p.relative(root, absPath).split(/[\\/]/).join("/");
}

function pathSegments(cwd: string): string[] {
  return (cwd || "").replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
}

/** Leaf labels by default; parent/leaf only for duplicate leaves. */
export function repoLabels(cwds: string[]): Map<string, string> {
  const leaves = new Map<string, number>();
  for (const cwd of cwds) {
    const parts = pathSegments(cwd);
    const leaf = parts.at(-1) || cwd;
    leaves.set(leaf.toLowerCase(), (leaves.get(leaf.toLowerCase()) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const cwd of cwds) {
    const parts = pathSegments(cwd);
    const leaf = parts.at(-1) || cwd;
    const duplicate = (leaves.get(leaf.toLowerCase()) ?? 0) > 1;
    out.set(cwd, duplicate && parts.length > 1 ? `${parts.at(-2)}/${leaf}` : leaf);
  }
  return out;
}

function isInsideOrEqual(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const a = normalizeRepoPath(candidate, platform);
  const b = normalizeRepoPath(root, platform);
  if (!a || !b) return false;
  const rel = path.relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface DiscoverReposDeps {
  fs: FsLike;
  grokHome: string;
  pins: RepoPins;
  /** Remote-rail archive choices. Reported on every row and acted on by nobody
   *  here — see RepoListEntry.archived. */
  archives?: RepoArchives;
  /** Project folder colours. Always flattened onto every row as `color` (empty
   *  string when unset) so the client can capability-probe without a version. */
  colors?: RepoColors;
  tmpDir: string;
  platform?: NodeJS.Platform;
  /** Host-known roots that remain selectable before Grok creates a catalog.
   *  These BYPASS the managed-worktree exclusion: that rule exists to keep
   *  worktrees from cluttering the list as rows, but the folder the user
   *  deliberately opened is not clutter — if VS Code is open on a worktree,
   *  that worktree IS the project, and dropping it leaves the selection naming
   *  a row that doesn't exist (which silently no-ops clear-all and selectRepo). */
  trustedCwds?: string[];
  worktreeLabels?: Map<string, string>;
  log?: (msg: string) => void;
}

/**
 * Enumerate cwd catalogs from `<grokHome>/sessions` without reading session
 * summaries. Temp-root catalogs and Grok-managed worktrees are rejected before
 * any cwd stat; only the surviving candidates are checked for availability.
 */
export function discoverRepos(deps: DiscoverReposDeps): RepoListEntry[] {
  const platform = deps.platform ?? process.platform;
  const sessionsRoot = path.join(deps.grokHome, "sessions");
  const worktreesRoot = path.join(deps.grokHome, "worktrees");
  const isManagedWorktree = (cwd: string) => isInsideOrEqual(cwd, worktreesRoot, platform);
  let encoded: string[] = [];
  try {
    if (deps.fs.existsSync(sessionsRoot)) encoded = deps.fs.readdirSync(sessionsRoot);
  } catch (e) {
    deps.log?.(`[sessions] failed to discover repos: ${(e as Error).message}`);
  }

  const byKey = new Map<string, Omit<RepoListEntry, "label">>();
  const archiveOf = (key: string) => {
    const choice = deps.archives?.[key];
    return { archived: !!choice?.archived, archivedAt: choice?.at ?? 0 };
  };
  // Always emit `color` (possibly "") — field presence is the capability signal.
  // Stored choices are non-empty palette ids; anything else collapses to none.
  const colorOf = (key: string): RepoColor => {
    const raw = deps.colors?.[key]?.color;
    return raw && (REPO_COLOR_IDS as readonly string[]).includes(raw) ? raw : "";
  };
  for (const name of encoded) {
    let cwd = "";
    try { cwd = decodeURIComponent(name).trim(); } catch { continue; }
    if (
      !cwd ||
      !path.isAbsolute(cwd) ||
      isInsideOrEqual(cwd, deps.tmpDir, platform) ||
      isManagedWorktree(cwd)
    ) continue;
    const key = normalizeRepoPath(cwd, platform);
    if (!key) continue;
    let available = false;
    try { available = deps.fs.statSync(cwd).isDirectory(); } catch { /* unavailable */ }
    if (!available) continue;
    let updatedAt = 0;
    try { updatedAt = deps.fs.statSync(path.join(sessionsRoot, name)).mtimeMs; } catch { /* best effort */ }
    const existing = byKey.get(key);
    if (existing) {
      // Same project under a different cwd casing (Windows drive letter, etc.):
      // keep one row, take the freshest catalog mtime so neither side is lost.
      existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
      continue;
    }
    const pin = deps.pins[key];
    byKey.set(key, {
      cwd,
      available: true,
      pinned: !!pin,
      pinnedAt: pin?.pinnedAt,
      updatedAt,
      worktreeLabel: deps.worktreeLabels?.get(key),
      color: colorOf(key),
      ...archiveOf(key),
    });
  }

  for (const cwd of deps.trustedCwds ?? []) {
    if (!cwd || !path.isAbsolute(cwd)) continue;
    const key = normalizeRepoPath(cwd, platform);
    if (!key || byKey.has(key)) continue;
    let available = false;
    try { available = deps.fs.statSync(cwd).isDirectory(); } catch { /* unavailable */ }
    if (!available) continue;
    const pin = deps.pins[key];
    byKey.set(key, {
      cwd,
      available: true,
      pinned: !!pin,
      pinnedAt: pin?.pinnedAt,
      updatedAt: 0,
      worktreeLabel: deps.worktreeLabels?.get(key),
      color: colorOf(key),
      ...archiveOf(key),
    });
  }

  // A pin is durable intent: keep it visible even when the checkout or its
  // session catalog is temporarily unavailable.
  for (const [key, pin] of Object.entries(deps.pins)) {
    if (
      !key ||
      byKey.has(key) ||
      !pin?.cwd ||
      !path.isAbsolute(pin.cwd) ||
      isManagedWorktree(pin.cwd)
    ) continue;
    let available = false;
    try { available = deps.fs.statSync(pin.cwd).isDirectory(); } catch { /* unavailable */ }
    byKey.set(key, {
      cwd: pin.cwd,
      available,
      pinned: true,
      pinnedAt: pin.pinnedAt,
      updatedAt: 0,
      worktreeLabel: deps.worktreeLabels?.get(key),
      color: colorOf(key),
      ...archiveOf(key),
    });
  }

  const values = [...byKey.values()];
  const labels = repoLabels(values.map((r) => r.cwd));
  return values
    .map((r) => ({ ...r, label: labels.get(r.cwd) || r.cwd }))
    .sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) ||
      b.updatedAt - a.updatedAt ||
      a.label.localeCompare(b.label),
    );
}

/** grok's own title for a session — `session_summary`, else `generated_title` —
 *  or "" when it has not produced a usable one. This is the title the CLI shows in
 *  `grok sessions list`, so preferring it keeps the same conversation recognizable
 *  in both surfaces (#96).
 *
 *  Legacy primer-derived titles are rejected: grok summarizes from message #1, and
 *  for sessions older extension versions started that message was our hidden
 *  primer — "Grok VSCode Plan Mode Hidden Primer" is not what that conversation is
 *  about. Both the summarized form ({@link isPrimerSummary}) and the raw marker
 *  ({@link isPrimerText}, which grok sometimes copies verbatim) are filtered. Pure. */
export function cliSessionTitle(summary?: string, generatedTitle?: string): string {
  for (const candidate of [summary, generatedTitle]) {
    const title = (candidate ?? "").trim();
    if (title && !isPrimerSummary(title) && !isPrimerText(title)) return title;
  }
  return "";
}

/** Default friendly name when no `customName` or `session_summary` is available. */
export function fallbackName(summary: string, updatedAt: number): string {
  const s = (summary || "").trim();
  if (s) return s.length > 60 ? s.slice(0, 57) + "…" : s;
  const d = new Date(updatedAt || Date.now());
  if (isNaN(d.getTime())) return "Untitled";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `Untitled (${yyyy}-${mm}-${dd} ${hh}:${mi})`;
}

function parseTimestamp(s: unknown, fallback: number): number {
  if (typeof s !== "string") return fallback;
  const t = Date.parse(s);
  return isNaN(t) ? fallback : t;
}

/** Parse one already-read summary.json into a list entry, applying any customName override. */
function buildEntry(
  dirName: string,
  raw: any,
  cwd: string,
  overrides: SessionMetaOverrides,
  fallbackNow: number,
  /** Recency-clock mtime — last time the conversation actually MOVED
   *  ({@link statSessionActivity}). Preferred over `updated_at`, which the
   *  CLI restamps on a mere open. */
  activityAt?: number,
): SessionListEntry {
  const id = (raw?.info?.id as string) ?? dirName;
  const sessCwd = (raw?.info?.cwd as string) ?? cwd;
  const rawSummary = typeof raw?.session_summary === "string" ? raw.session_summary : "";
  const fromDisk = typeof activityAt === "number" && activityAt > 0
    ? activityAt
    : parseTimestamp(raw?.updated_at, fallbackNow);
  // The host's "used just now" is a floor under the file's own timestamp, so a
  // send or a new conversation ranks immediately and the transcript takes over
  // as soon as it is written. Max, not override: a stale in-memory value must
  // never hold a row above a conversation that really is newer.
  const liveActivity = overrides[(raw?.info?.id as string) ?? dirName]?.activeAt;
  const updatedAt = typeof liveActivity === "number" && liveActivity > fromDisk
    ? liveActivity
    : fromDisk;
  const createdAt = parseTimestamp(raw?.created_at, updatedAt);
  const numMessages = typeof raw?.num_messages === "number" ? raw.num_messages : 0;
  const modelId = typeof raw?.current_model_id === "string" ? raw.current_model_id : undefined;
  const override = overrides[id];
  const customName = override?.customName?.trim() || undefined;
  // Precedence (#96): what the user called it, then what grok calls it, then our
  // own first-message guess, then the date. The middle step is the point — it is
  // the only one of the three that describes the conversation rather than its
  // opening line, and it is what the CLI shows for the same session.
  const generatedTitle = typeof raw?.generated_title === "string" ? raw.generated_title : "";
  const autoName = override?.autoName?.trim() || "";
  const displayName = customName || fallbackName(cliSessionTitle(rawSummary, generatedTitle) || autoName, updatedAt);
  const rawKind = raw?.session_kind;
  const kind = rawKind === "subagent" || rawKind === "headless" ? rawKind : undefined;
  const pinnedAt = typeof override?.pinnedAt === "number" ? override.pinnedAt : undefined;
  return {
    id,
    cwd: sessCwd,
    displayName,
    rawSummary,
    customName,
    updatedAt,
    createdAt,
    numMessages,
    modelId,
    kind,
    pinnedAt,
    ...(override?.provider ? { provider: override.provider } : {}),
  };
}

export interface SessionIndexEntry {
  /** Directory name = grok session id. */
  id: string;
  /** Recency-clock mtime (ms) from {@link statSessionActivity} — `updates.jsonl`
   *  when present, else `events.jsonl`, else `summary.json`. Also the key the
   *  host's `sessionCache` invalidates on, so a load (which does not touch
   *  `updates.jsonl`) is a cache hit and a real turn is a miss. */
  mtimeMs: number;
  /** True when `events.jsonl` exists. False is a summary-only shell — created
   *  (often by a credential probe or an abandoned New session) and never spoken
   *  to. The sweep uses this to find those shells even when they have fallen
   *  outside the newest-N window. Set by {@link indexSessions}; omitted by
   *  callers that only need identity + mtime. */
  hasTranscript?: boolean;
}

export interface IndexDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  /** Defaults to process.platform — inject `win32` in tests for case-fold merge. */
  platform?: NodeJS.Platform;
  log?: (msg: string) => void;
}

/**
 * Order of directories to search when resuming a session by id.
 *
 * A renderer may *name* a session id and optionally suggest a cwd (history-row
 * convenience). Host-owned inputs (`metaWorktreePath`, `cachedCwd`, every
 * entry of `trustedCwds`) are the only directories that may ever appear.
 * `messageCwd` is included **only** when it already equals a trusted catalog
 * cwd — never as an unauthenticated process root.
 */
export function orderedResumeCwdCandidates(opts: {
  messageCwd?: string;
  trustedCwds: readonly string[];
  metaWorktreePath?: string;
  cachedCwd?: string;
  sameCwd?: (a: string, b: string) => boolean;
}): string[] {
  const same = opts.sameCwd ?? ((a, b) => normalizeRepoPath(a) === normalizeRepoPath(b));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (cwd: string | undefined) => {
    if (!cwd || typeof cwd !== "string") return;
    const key = normalizeRepoPath(cwd);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(cwd);
  };
  // UI convenience: look first where the row claimed, but only if host-trusted.
  if (
    opts.messageCwd &&
    opts.trustedCwds.some((t) => same(t, opts.messageCwd!))
  ) {
    add(opts.messageCwd);
  }
  add(opts.metaWorktreePath);
  add(opts.cachedCwd);
  for (const t of opts.trustedCwds) add(t);
  return out;
}

/**
 * Resolve the process cwd for a resume by finding which **catalog** directory
 * actually holds `id` on disk. Returns undefined when no candidate contains
 * the session — callers must not fall back to a renderer-supplied path.
 */
export function findSessionCatalogCwd(deps: {
  fs: Pick<FsLike, "existsSync" | "readdirSync">;
  grokHome: string;
  id: string;
  candidates: readonly string[];
  platform?: NodeJS.Platform;
}): string | undefined {
  const { fs, grokHome, id, candidates } = deps;
  const platform = deps.platform ?? process.platform;
  if (!isValidSessionId(id)) return undefined;
  const seen = new Set<string>();
  for (const cwd of candidates) {
    if (!cwd || typeof cwd !== "string") continue;
    const key = normalizeRepoPath(cwd, platform);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Alias-aware lookup: session may live under a differently-cased catalog leaf.
    const dir = sessionDirFor(grokHome, cwd, id, { fs, platform });
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, "summary.json"))) return cwd;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

const SESSION_UPDATES = "updates.jsonl";
const SESSION_EVENTS = "events.jsonl";
const SESSION_SUMMARY = "summary.json";

/**
 * Recency clock for one grok session directory. Stat-only (no reads).
 *
 * Preference:
 *   1. `updates.jsonl` — persist/replay log. A `session/load` with no turn
 *      leaves it alone; a real turn advances it. Measured on a fresh process:
 *      load restamps `events.jsonl` / `chat_history.jsonl` / `summary.json`
 *      and leaves `updates.jsonl` and `rewind_points.jsonl` untouched.
 *   2. `events.jsonl` — spoken-to session from before the updates log
 *      existed (~13% of dirs). A load still restamps this file, so those
 *      rows can still jump; the next real turn grows `updates.jsonl` and
 *      the preferred clock takes over. `rewind_points.jsonl` is also
 *      load-stable but a conversation-only turn may not touch it, so it is
 *      not a rank signal.
 *   3. `summary.json` — no transcript yet. Same fallback as before, so a
 *      brand-new conversation still lists.
 *
 * `hasTranscript` is still "events.jsonl exists" — the empty-session sweep
 * keys on that, not on the rank file. A stray file that is not a session
 * dir makes every join miss and this returns undefined.
 */
export function statSessionActivity(
  fs: FsLike,
  sessionDir: string,
): { mtimeMs: number; hasTranscript: boolean } | undefined {
  let eventsMtime: number | undefined;
  try {
    eventsMtime = fs.statSync(path.join(sessionDir, SESSION_EVENTS)).mtimeMs;
  } catch {
    /* no events.jsonl */
  }
  if (eventsMtime !== undefined) {
    try {
      return {
        mtimeMs: fs.statSync(path.join(sessionDir, SESSION_UPDATES)).mtimeMs,
        hasTranscript: true,
      };
    } catch {
      return { mtimeMs: eventsMtime, hasTranscript: true };
    }
  }
  try {
    return {
      mtimeMs: fs.statSync(path.join(sessionDir, SESSION_SUMMARY)).mtimeMs,
      hasTranscript: false,
    };
  } catch {
    return undefined;
  }
}

/** Cheap ordering pass: every session id newest-first by {@link statSessionActivity}
 *  mtime, WITHOUT reading or parsing any summary content. One or two `stat`s per
 *  dir instead of a `stat` + `read` + `JSON.parse`, so it stays fast even with
 *  thousands of sessions. The caller reads (via `readSessionEntries`) only the
 *  window it actually shows. mtime is an approximate sort key; the exact
 *  `updated_at` order is re-applied within the loaded page after reading.
 *
 *  Scans **all case-aliases** of `cwd` ({@link sessionCatalogDirs}) so a Windows project split
 *  across `c:\…` and `C:\…` catalog leaves returns the union. Duplicate ids keep the higher mtime. */
export function indexSessions(deps: IndexDeps): SessionIndexEntry[] {
  const { fs, grokHome, cwd, log } = deps;
  const platform = deps.platform ?? process.platform;
  const catalogs = sessionCatalogDirs({ fs, grokHome, cwd, platform });
  if (!catalogs.length) return [];
  const byId = new Map<string, { mtimeMs: number; hasTranscript: boolean }>();
  for (const dir of catalogs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      log?.(`[sessions] failed to read ${dir}: ${(e as Error).message}`);
      continue;
    }
    for (const name of names) {
      if (!isValidSessionId(name)) continue;
      const resolvedSessionDir = path.join(dir, name);
      if (!isSessionDirChild(dir, resolvedSessionDir, platform)) continue;
      const clock = statSessionActivity(fs, resolvedSessionDir);
      if (!clock) continue;
      const prev = byId.get(name);
      if (!prev || clock.mtimeMs > prev.mtimeMs) {
        byId.set(name, { mtimeMs: clock.mtimeMs, hasTranscript: clock.hasTranscript });
      } else if (clock.hasTranscript) {
        prev.hasTranscript = true;
      }
    }
  }
  const out: SessionIndexEntry[] = [...byId.entries()].map(([id, rec]) => ({
    id,
    mtimeMs: rec.mtimeMs,
    hasTranscript: rec.hasTranscript,
  }));
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Newest real-activity mtime under `cwd`'s session catalogs, or 0.
 *
 * Deliberately NOT `indexSessions` / {@link statSessionActivity}: those fall
 * back to `events.jsonl` then `summary.json` so a brand-new or pre-updates
 * conversation still lists. That fallback is right for ordering and wrong
 * for authorization — grok restamps both files on a mere `session/load`. A
 * remote could therefore manufacture "this project was worked in" by getting
 * a session reloaded, which is exactly how the archive fence was bypassed.
 *
 * `updates.jsonl` is the only persist file a load leaves alone and a real
 * turn advances. No fallback. A dir that never grew that log reports
 * nothing, even if `events.jsonl` exists.
 */
export function newestTranscriptMtime(deps: IndexDeps): number {
  const { fs, grokHome, cwd, log } = deps;
  const platform = deps.platform ?? process.platform;
  let newest = 0;
  for (const dir of sessionCatalogDirs({ fs, grokHome, cwd, platform })) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      log?.(`[sessions] failed to read ${dir}: ${(e as Error).message}`);
      continue;
    }
    for (const name of names) {
      if (!isValidSessionId(name)) continue;
      const sessionDir = path.join(dir, name);
      if (!isSessionDirChild(dir, sessionDir, platform)) continue;
      try {
        const st = fs.statSync(path.join(sessionDir, SESSION_UPDATES));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // No updates log: a load writes events.jsonl, so that file is not evidence.
      }
    }
  }
  return newest;
}

/**
 * True when a parsed `summary.json` is minimally well-formed for discovery
 * seeding. Mtime-only dirs (empty/`{}`/non-JSON) must not count toward the
 * auto-open threshold — otherwise a planted tree of empty summaries would
 * open an arbitrary directory as a trusted root.
 */
export function isWellFormedSessionSummary(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  // Real grok summaries carry info and/or activity fields. Require at least one.
  if (o.info && typeof o.info === "object") return true;
  if (typeof o.updated_at === "string" && o.updated_at.length > 0) return true;
  if (typeof o.created_at === "string" && o.created_at.length > 0) return true;
  if (typeof o.num_messages === "number" && Number.isFinite(o.num_messages)) return true;
  if (typeof o.session_summary === "string") return true;
  if (typeof o.generated_title === "string") return true;
  return false;
}

/**
 * Like {@link indexSessions}, but only counts sessions whose `summary.json`
 * parses as a minimally well-formed object. Used by desktop discovery seeding
 * so mtime-shaped empty files cannot satisfy the threshold.
 */
export function indexWellFormedSessions(deps: IndexDeps): SessionIndexEntry[] {
  const { fs, grokHome, cwd, log } = deps;
  const platform = deps.platform ?? process.platform;
  const catalogs = sessionCatalogDirs({ fs, grokHome, cwd, platform });
  if (!catalogs.length) return [];
  const byId = new Map<string, number>();
  for (const dir of catalogs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      log?.(`[sessions] failed to read ${dir}: ${(e as Error).message}`);
      continue;
    }
    for (const name of names) {
      if (!isValidSessionId(name)) continue;
      const resolvedSessionDir = path.join(dir, name);
      if (!isSessionDirChild(dir, resolvedSessionDir, platform)) continue;
      const summaryPath = path.join(resolvedSessionDir, "summary.json");
      let st: { mtimeMs: number };
      let rawText: string;
      try {
        st = fs.statSync(summaryPath);
        rawText = fs.readFileSync(summaryPath, "utf8");
      } catch {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        continue;
      }
      if (!isWellFormedSessionSummary(raw)) continue;
      const prev = byId.get(name);
      if (prev === undefined || st.mtimeMs > prev) byId.set(name, st.mtimeMs);
    }
  }
  const out: SessionIndexEntry[] = [...byId.entries()].map(([id, mtimeMs]) => ({ id, mtimeMs }));
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export interface ReadEntriesDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  ids: string[];
  overrides: SessionMetaOverrides;
  platform?: NodeJS.Platform;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Read + parse summary.json for exactly the given ids (a page), returning full list entries in the
 *  same order. Malformed or vanished entries are skipped. This is the only path that touches file
 *  content, so callers keep it to the visible window. */
export function readSessionEntries(deps: ReadEntriesDeps): SessionListEntry[] {
  const { fs, grokHome, cwd, ids, overrides, log } = deps;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ? deps.now() : Date.now();
  const out: SessionListEntry[] = [];
  for (const id of ids) {
    const resolvedSessionDir = sessionDirFor(grokHome, cwd, id, { fs, platform });
    if (!resolvedSessionDir) continue;
    const summaryPath = path.join(resolvedSessionDir, "summary.json");
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch (e) {
      log?.(`[sessions] could not read summary.json for ${id}: ${(e as Error).message}`);
      continue;
    }
    // Same clock as indexSessions: `updated_at` inside summary.json is restamped
    // by merely OPENING the conversation. Undefined when there is no transcript
    // yet, and buildEntry then keeps `updated_at`.
    const clock = statSessionActivity(fs, resolvedSessionDir);
    const activityAt = clock?.hasTranscript ? clock.mtimeMs : undefined;
    out.push(buildEntry(id, raw, cwd, overrides, now, activityAt));
  }
  return out;
}

export interface ContextUsage {
  used: number;
  window?: number;
}

export function persistSessionContext(
  override: SessionMetaOverride,
  event: ContextOccupancyEvent,
): SessionMetaOverride {
  const next = applyContextOccupancy({
    used: override.contextUsed,
    window: override.contextWindow,
    pendingCompact: override.contextPendingCompact,
  }, event);
  return {
    ...override,
    contextUsed: next.used,
    contextWindow: next.window,
    contextPendingCompact: next.pendingCompact || undefined,
  };
}

export function persistedContextUsage(override: SessionMetaOverride | undefined): ContextUsage | null {
  const used = override?.contextUsed;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) return null;
  const window = override?.contextWindow;
  const hasWindow = typeof window === "number" && Number.isFinite(window) && window > 0;
  return { used, window: hasWindow ? window : undefined };
}

export function contextUsageFromLog(
  entries: SessionMetaOverride["usageLog"],
  window?: number,
): ContextOccupancyState {
  const folded = occupancyFromUsageLog(entries);
  return {
    ...folded,
    window: typeof window === "number" && Number.isFinite(window) && window > 0 ? window : folded.window,
  };
}

/** Read grok's persisted context usage from a session's `signals.json`
 *  (`contextTokensUsed` / `contextWindowTokens`). grok rewrites the file at the
 *  end of every turn — including a `/compact` turn — so it carries the real
 *  post-compact size that the ACP result meta doesn't (grok reports
 *  `totalTokens: 0` there, which the host strips; see `gateZeroTokenMeta`).
 *  It's also the only source of a count before any live turn has run, i.e. on
 *  a cold restore. Null when the file is missing/unreadable or the count isn't
 *  a positive number. Pure. */
export function readContextUsage(deps: {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  id: string;
  platform?: NodeJS.Platform;
}): ContextUsage | null {
  const { fs, grokHome, cwd, id } = deps;
  const platform = deps.platform ?? process.platform;
  const resolvedSessionDir = sessionDirFor(grokHome, cwd, id, { fs, platform });
  if (!resolvedSessionDir) return null;
  const signalsPath = path.join(resolvedSessionDir, "signals.json");
  try {
    const raw = JSON.parse(fs.readFileSync(signalsPath, "utf8"));
    const used = raw?.contextTokensUsed;
    if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) return null;
    const window = raw?.contextWindowTokens;
    const hasWindow = typeof window === "number" && Number.isFinite(window) && window > 0;
    return { used, window: hasWindow ? window : undefined };
  } catch {
    return null;
  }
}

/** Full session list sorted by last activity. Equivalent to `indexSessions` + `readSessionEntries`
 *  over every id; reads every summary.json, so prefer the paginated index/read primitives on hot
 *  paths. Kept for callers that genuinely need the whole list at once. */
export function listSessions(deps: ListDeps): SessionListEntry[] {
  const { fs, grokHome, cwd, overrides, log } = deps;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ? deps.now() : Date.now();
  const index = indexSessions({ fs, grokHome, cwd, platform, log });
  const out = readSessionEntries({
    fs,
    grokHome,
    cwd,
    ids: index.map((e) => e.id),
    overrides,
    platform,
    now: () => now,
    log,
  });
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Pull the user-visible queries out of a grok `chat_history.jsonl`. grok wraps the
 *  user's actual prompt in `<user_query>…</user_query>` inside a `role:"user"`
 *  message; the separate `role:"user"` `<user_info>` context block carries no
 *  `<user_query>` and is naturally skipped. Non-user roles (system/assistant/
 *  reasoning) are ignored. Unparseable lines are skipped. Pure. */
export function extractUserQueries(chatHistoryJsonl: string): string[] {
  const out: string[] = [];
  for (const line of (chatHistoryJsonl ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    // grok keys the role on `type` (string like "system"/"user"/"reasoning"); some
    // builds use `role`. Either way we want only user turns.
    const role = o?.type ?? o?.role;
    if (role !== "user") continue;
    // Synthetic user turns — injected <system-reminder> / project-instructions /
    // background-task results — are not real queries; grok tags them `synthetic_reason`.
    if (o?.synthetic_reason) continue;
    const content = o?.content;
    const text = (
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
          : ""
    ).trim();
    if (!text) continue;
    // Skip the environment-context block (carries no user prompt) and any stray
    // reminder that wasn't flagged synthetic.
    if (/^<user_info>/.test(text) || /^<system-reminder>/.test(text)) continue;
    // The prompt is usually wrapped in <user_query>…</user_query>, but NOT always —
    // grok/composer sends some prompts (notably slash commands like `/imagine`) as a
    // plain user message with no wrapper. Counting only wrapped queries made those
    // sessions look primer-only, so a real one could be swept. Unwrap when present,
    // otherwise take the message verbatim. (Tolerate a missing closing tag.)
    const m = text.match(/<user_query>([\s\S]*?)(?:<\/user_query>|$)/);
    out.push((m ? m[1] : text).trim());
  }
  return out;
}

/** True when a `chat_history.jsonl` is written in the shape {@link extractUserQueries}
 *  knows how to read: at least one line parses as JSON carrying a role.
 *
 *  This is a safety interlock, not a parser. "No real user queries" is only
 *  evidence of an empty session if we could read the file at all — and a reader
 *  that silently skips what it does not recognize cannot tell "nothing was said"
 *  from "grok changed the format". Without this, one CLI schema change would turn
 *  the sweep from a cleanup into a shredder that finds EVERY session empty. A
 *  truncated final line (a write in progress) still leaves the earlier ones
 *  parseable, so this refuses the catastrophic case without refusing the ordinary
 *  one. Pure. */
export function historyIsIntelligible(chatHistoryJsonl: string): boolean {
  for (const line of (chatHistoryJsonl ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if (typeof (o?.type ?? o?.role) === "string") return true;
  }
  return false;
}

/** Split a session's user queries into primer vs. real. A session is "empty" when
 *  it received our hidden primer and never a real (non-primer) query. Pure. */
export function classifyUserQueries(chatHistoryJsonl: string): { primer: number; real: number } {
  let primer = 0;
  let real = 0;
  for (const q of extractUserQueries(chatHistoryJsonl)) {
    if (isPrimerText(q)) primer++;
    else real++;
  }
  return { primer, real };
}

export interface EmptySessionInput {
  /** A user rename means the session matters — never empty, whatever its content. */
  customName?: string;
  /** A pinned conversation is the same kind of deliberate intent as a rename. */
  pinnedAt?: number;
  /** A session bound to an isolated worktree backs a checkout the user asked for.
   *  `parkFocused` already refuses to auto-delete one; so does this. */
  worktreePath?: string;
  /** A queued composer draft makes the conversation user-owned even when its
   *  transcript has no real prompt yet. */
  queuedDraft?: string;
  /** grok's `session_kind`. A `subagent` directory is a delegation's own
   *  transcript — never a conversation the user started, and not ours to remove. */
  kind?: string;
  /** `num_messages` from summary.json (the cheap gate; a primer-only session is ~4). */
  numMessages: number;
  /** `session_summary` from summary.json (fallback signal when no chat history). */
  summary?: string;
  /** `generated_title` from summary.json (fallback signal when no chat history). */
  generatedTitle?: string;
  /** `chat_history.jsonl` contents — the authoritative signal when provided.
   *  Undefined means the file is NOT THERE, which is itself evidence; a file that
   *  exists but could not be read must arrive as `historyUnreadable` instead. */
  chatHistory?: string;
  /** The history file exists but could not be read (locked, permissions). We
   *  cannot prove the session is empty, so we must not claim that it is. */
  historyUnreadable?: boolean;
}

/** Decide whether a session directory holds no conversation at all and is safe to
 *  delete.
 *
 *  Chat history is authoritative — but only when it can be read AND understood. A
 *  session is empty iff its history is in a shape we can parse and carries **zero
 *  real user queries**. That covers both shapes we have shipped — the legacy
 *  primer-only session (our hidden primer, no real turn) and today's primer-free
 *  one (a session grok created for a view that was never typed into). Requiring a
 *  primer, as this did until the primer was retired, made the check a no-op on
 *  every session created since: nothing was removing them, and they piled up in
 *  history as unloadable "Untitled" rows (#97).
 *
 *  `num_messages` deliberately does NOT veto the content signal. An agentic primer
 *  turn could balloon to dozens of tool/reasoning messages with no real user query
 *  (and grok re-primes on restore/compact), which once left such sessions — a real
 *  74-message one — in history forever.
 *
 *  Without any history file the honest signals are the message count and the
 *  title: nothing written at all is empty, and a low-message session wearing a
 *  primer-derived title is the legacy case. Pure. */
export function isEmptySession(
  inp: EmptySessionInput,
  maxMessages = EMPTY_PRIMER_MAX_MESSAGES,
): boolean {
  if (inp.customName?.trim()) return false;
  if (typeof inp.pinnedAt === "number") return false;
  if (inp.worktreePath?.trim()) return false;
  if (inp.queuedDraft) return false;
  // Only a subagent transcript is invisible BY KIND. A headless session is a
  // conversation the user can resume — its emptiness is decided by content,
  // exactly like a desk session's.
  if (inp.kind === "subagent") return false;
  if (inp.historyUnreadable) return false;
  if ((inp.chatHistory ?? "").trim()) {
    // Read it, or refuse to judge it. A file we cannot parse is not an empty
    // conversation — see historyIsIntelligible.
    if (!historyIsIntelligible(inp.chatHistory!)) return false;
    return classifyUserQueries(inp.chatHistory!).real === 0;
  }
  // Either no history file, or one with nothing in it yet.
  if (inp.numMessages > maxMessages) return false;
  const title = `${inp.summary ?? ""} ${inp.generatedTitle ?? ""}`;
  // A directory holding nothing but summary.json: grok registered the session and
  // no turn ever reached it. The commonest producer is a window opened on a repo
  // and closed again without a prompt.
  if (inp.numMessages === 0 && !title.trim()) return true;
  return isPrimerSummary(title);
}

/** Remove the on-disk session directory. No-op if missing. Searches case-aliases. */
/**
 * Windows loses a directory delete to whatever still holds a handle inside it —
 * the grok process that just exited, a virus scanner, the search indexer — and
 * reports it as ENOTEMPTY, which reads like a logic bug and is not one. Node
 * retries exactly these errors when asked to; nothing else here changes.
 */
const RM_RETRY = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export function deleteSessionDir(deps: DeleteDeps): void {
  const { fs, grokHome, cwd, id } = deps;
  const platform = deps.platform ?? process.platform;
  const dir = sessionDirFor(grokHome, cwd, id, { fs, platform });
  if (!dir) return;
  if (!fs.existsSync(dir)) return;
  if (fs.rmSync) {
    fs.rmSync(dir, RM_RETRY);
  } else {
    fs.rmdirSync(dir, { recursive: true });
  }
}

export interface ClearDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  platform?: NodeJS.Platform;
  /** Session id to keep (the live/focused one — grok re-persists it, so deleting it wouldn't stick). */
  exceptId?: string;
  /** Session ids to keep when more than one live view owns history in this cwd. */
  exceptIds?: Iterable<string>;
}

export interface DeleteDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  id: string;
  platform?: NodeJS.Platform;
}

/** Remove every session directory under `cwd` (all case-aliases), optionally keeping selected ids.
 *  Returns the ids it removed. Best-effort: a directory that fails to remove is skipped, not thrown,
 *  so one locked dir doesn't abort the sweep. The directory name is the session id. */
export function clearSessions(deps: ClearDeps): string[] {
  const { fs, grokHome, cwd, exceptId, exceptIds } = deps;
  const platform = deps.platform ?? process.platform;
  const kept = new Set(exceptIds);
  if (exceptId) kept.add(exceptId);
  const catalogs = sessionCatalogDirs({ fs, grokHome, cwd, platform });
  if (!catalogs.length) return [];
  const removed: string[] = [];
  const removedSet = new Set<string>();
  for (const dir of catalogs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (kept.has(name) || !isValidSessionId(name)) continue;
      const full = path.join(dir, name);
      if (!isSessionDirChild(dir, full, platform)) continue;
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        if (fs.rmSync) fs.rmSync(full, RM_RETRY);
        else fs.rmdirSync(full, { recursive: true });
        if (!removedSet.has(name)) {
          removedSet.add(name);
          removed.push(name);
        }
      } catch {
        continue;
      }
    }
  }
  return removed;
}

/** Default node fs adapter for production use. */
export const defaultFs: FsLike = {
  existsSync: nodeFs.existsSync,
  readdirSync: (p) => nodeFs.readdirSync(p) as string[],
  readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
  statSync: (p) => nodeFs.statSync(p),
  rmSync: (nodeFs as any).rmSync
    ? (p, opts) => (nodeFs as any).rmSync(p, opts)
    : undefined,
  rmdirSync: (p, opts) => nodeFs.rmdirSync(p, opts as any),
};

/** Resolve the grok home directory the way the CLI does: `$GROK_HOME` override
 *  first, else `<home>/.grok` where home is USERPROFILE on Windows and HOME
 *  elsewhere (the CLI's Rust `std::env::home_dir()` ignores HOME on Windows) —
 *  now genuinely matching cli-locator's `effectiveHome()`. The old
 *  `HOME || USERPROFILE` read the wrong `.grok` on Windows boxes with HOME set
 *  (git-bash), splitting session history from where the CLI writes it. */
export function resolveGrokHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.GROK_HOME) return env.GROK_HOME;
  const fromEnv = platform === "win32" ? env.USERPROFILE : env.HOME;
  return path.join(fromEnv || homedir(), ".grok");
}

/** True when `p` resolves strictly inside directory `root` (never `root`
 *  itself). A path-segment boundary check, not a string-prefix one: `root/..foo`
 *  is inside (a legal dir name that merely starts with dots), `root/../x` and
 *  `root` are not, and a different-root path (other drive) is not. */
export function isPathInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
