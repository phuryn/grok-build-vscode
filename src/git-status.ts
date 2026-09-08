/**
 * Pure parsing and command construction for the file panel's Changes view.
 *
 * Nothing here spawns anything. `src/git-run.ts` owns the process seam; this
 * module owns every decision that can be made from text, which is all of them
 * except running the command. That split is what makes the interesting parts
 * testable: porcelain output with a space in a path, a repository with no
 * commits yet, a branch with no upstream, a rename, a conflict.
 *
 * Two rules run through the whole file and are worth stating once.
 *
 * **One structure decides what runs and what is written down.**
 * {@link planGitOp} returns the exact `git` argument vectors together with
 * {@link renderSteps}'s rendering of them, so the two cannot drift. The
 * rendering goes to the HOST LOG, not to the person: the view's confirmation
 * surface is the button's own label, which promises the outcome in plain
 * language ("Commit and push") rather than reciting a command line. Somebody
 * committing from a phone is not auditing argv, and a card full of flags would
 * be exactly the duplicated information this view is built to avoid. The log
 * line is what makes an operation reconstructable afterwards.
 *
 * **Nothing user-supplied becomes an argument without passing a validator
 * here.** Paths are checked against the snapshot the host just computed
 * (`--` and a pathspec are not enough on their own: `git checkout -- x` is
 * fine, but the path still has to be a path this repository is reporting as
 * changed), and branch names go through {@link isValidBranchName}.
 */

/** How a changed file differs from the last commit. `?` is untracked. */
export type GitFileStatus = "M" | "A" | "D" | "R" | "U" | "?";

/** One row of the "not committed" list. */
export interface GitFileChange {
  /** Repository-relative, forward slashes. */
  path: string;
  status: GitFileStatus;
  /**
   * Lines added / deleted against HEAD, or null when not knowable cheaply.
   *
   * Untracked files are always null: counting them means reading every one of
   * them, and the number is visible the moment the file's diff is opened. A
   * count nobody is waiting for is not worth N spawns on a cold cloud disk.
   */
  added: number | null;
  deleted: number | null;
  /** Only for renames — where the file came from. */
  origPath?: string;
}

/** One commit that exists here and not on the remote. */
export interface GitUnpushedCommit {
  sha: string;
  subject: string;
}

/** Everything the Changes view needs to answer "is it safe to walk away?". */
export interface GitStatusSnapshot {
  branch: string | null;
  /** HEAD is not on a branch. `branch` is null and pushing is not offered. */
  detached: boolean;
  /** A repository with no commits yet. `git diff HEAD` cannot run. */
  unborn: boolean;
  /** On `main` / `master` — drives the guard, never blocks anything. */
  isDefaultBranch: boolean;
  /** Any remote at all. False means push is impossible, not merely unset. */
  hasRemote: boolean;
  /** This branch tracks something. False with `hasRemote` means `-u` is needed. */
  hasUpstream: boolean;
  upstream: string | null;
  ahead: number;
  /**
   * Commits on the upstream that are not here, or null when unknowable.
   *
   * Null is the ordinary case, not an error: v1 never runs `git fetch`, so
   * this is only as fresh as whatever last fetched. The view says "as of the
   * last fetch" rather than implying it just checked.
   */
  behind: number | null;
  files: GitFileChange[];
  unpushed: GitUnpushedCommit[];
  unpushedTruncated: boolean;
  /** A merge or rebase left conflicts. Committing is refused while true. */
  conflicted: boolean;
}

/** Most commits we will list under "not pushed". */
export const UNPUSHED_LIMIT = 50;

/** Branches treated as the default when the remote does not say otherwise. */
export const DEFAULT_BRANCH_NAMES: readonly string[] = ["main", "master"];

/** An empty snapshot, used for an unborn or otherwise unreadable repository. */
export function emptyGitStatus(): GitStatusSnapshot {
  return {
    branch: null,
    detached: false,
    unborn: false,
    isDefaultBranch: false,
    hasRemote: false,
    hasUpstream: false,
    upstream: null,
    ahead: 0,
    behind: null,
    files: [],
    unpushed: [],
    unpushedTruncated: false,
    conflicted: false,
  };
}

/* ------------------------------------------------------------------ *
 * Reading git
 * ------------------------------------------------------------------ */

/**
 * `git status --porcelain=2 --branch -z`.
 *
 * `-z` rather than the quoted default because the default C-quotes any path
 * with a space, a quote or a non-ASCII byte, and un-quoting it correctly is a
 * parser nobody should write twice. Porcelain v2 (not v1) because it carries
 * the branch header, which is where ahead/behind come from without a second
 * `rev-list`.
 */
export const GIT_STATUS_ARGS: readonly string[] = ["status", "--porcelain=2", "--branch", "-z"];

/**
 * `git diff HEAD --numstat -z` — line counts for tracked changes.
 *
 * Against HEAD rather than the index so a file the agent happened to `git add`
 * still counts. Fails on an unborn repository; the caller skips it there.
 */
export const GIT_NUMSTAT_ARGS: readonly string[] = ["diff", "HEAD", "--numstat", "-z"];

/** `git remote` — one line per remote, so emptiness is the whole answer. */
export const GIT_REMOTE_ARGS: readonly string[] = ["remote"];

const UNIT_SEP = "\u001f";

/**
 * Arguments for the "not pushed" list.
 *
 * With an upstream the question is `@{u}..HEAD`. Without one — a branch that
 * has never been pushed — the honest question is "commits that are on no
 * remote at all", which `--not --remotes` answers and `@{u}` cannot ask.
 */
export function gitUnpushedArgs(upstream: string | null, limit: number = UNPUSHED_LIMIT): string[] {
  const format = `--format=%h${UNIT_SEP}%s`;
  const capped = `--max-count=${Math.max(1, Math.floor(limit)) + 1}`;
  if (upstream) return ["log", format, capped, `${upstream}..HEAD`];
  return ["log", format, capped, "HEAD", "--not", "--remotes"];
}

/** `git diff HEAD -- <path>` for a tracked file. */
export function gitDiffArgs(path: string): string[] {
  return ["diff", "HEAD", "--", path];
}

/** Whole-file diff for a file git has never seen. */
export function gitDiffUntrackedArgs(path: string): string[] {
  return ["diff", "--no-index", "--", nullDevicePath(), path];
}

/** The path `git diff --no-index` accepts as "nothing" on this platform. */
export function nullDevicePath(platform: NodeJS.Platform = process.platform): string {
  // Git for Windows understands /dev/null in --no-index; NUL is not accepted
  // as a diff operand. Kept as a function so the choice is testable rather
  // than an assumption spread across call sites.
  return platform === "win32" ? "/dev/null" : "/dev/null";
}

interface StatusHeaders {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number | null;
  unborn: boolean;
  detached: boolean;
}

/**
 * Parse `git status --porcelain=2 --branch -z`.
 *
 * Record types, all NUL-terminated: `#` header, `1` ordinary change, `2`
 * rename or copy (whose record is followed by a SECOND NUL-terminated chunk
 * holding the original path), `u` unmerged, `?` untracked, `!` ignored.
 */
export function parseGitStatusPorcelain2(
  stdout: string,
): { headers: StatusHeaders; files: GitFileChange[]; conflicted: boolean } {
  const headers: StatusHeaders = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: null,
    unborn: false,
    detached: false,
  };
  const files: GitFileChange[] = [];
  let conflicted = false;
  if (typeof stdout !== "string" || stdout.length === 0) {
    return { headers, files, conflicted };
  }
  const chunks = stdout.split("\0");
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const kind = chunk[0];
    if (kind === "#") {
      applyStatusHeader(headers, chunk);
      continue;
    }
    if (kind === "!") continue;
    if (kind === "?") {
      const path = chunk.slice(2);
      if (path) files.push({ path: normalizePath(path), status: "?", added: null, deleted: null });
      continue;
    }
    if (kind === "1" || kind === "2" || kind === "u") {
      const fields = chunk.split(" ");
      // 1: kind XY sub mH mI mW hH hI path         → path at 8
      // 2: kind XY sub mH mI mW hH hI Xscore path  → path at 9
      // u: kind XY sub m1 m2 m3 mW h1 h2 h3 path   → path at 10
      const pathIndex = kind === "1" ? 8 : kind === "2" ? 9 : 10;
      const xy = fields[1] || "";
      const path = fields.slice(pathIndex).join(" ");
      // A rename's original path is the next NUL-terminated chunk, so it must
      // be consumed here or it is read as a bogus record on the next turn.
      let origPath: string | undefined;
      if (kind === "2") {
        i += 1;
        const orig = chunks[i];
        if (orig) origPath = normalizePath(orig);
      }
      if (!path) continue;
      if (kind === "u") {
        conflicted = true;
        files.push({ path: normalizePath(path), status: "U", added: null, deleted: null });
        continue;
      }
      const entry: GitFileChange = {
        path: normalizePath(path),
        status: combineStatusCodes(xy[0], xy[1]),
        added: null,
        deleted: null,
      };
      if (origPath) entry.origPath = origPath;
      files.push(entry);
    }
  }
  return { headers, files, conflicted };
}

function applyStatusHeader(headers: StatusHeaders, chunk: string): void {
  const rest = chunk.slice(2);
  const space = rest.indexOf(" ");
  if (space < 0) return;
  const key = rest.slice(0, space);
  const value = rest.slice(space + 1);
  if (key === "branch.oid") {
    if (value === "(initial)") headers.unborn = true;
    return;
  }
  if (key === "branch.head") {
    if (value === "(detached)") {
      headers.detached = true;
      headers.branch = null;
    } else {
      headers.branch = value;
    }
    return;
  }
  if (key === "branch.upstream") {
    headers.upstream = value || null;
    return;
  }
  if (key === "branch.ab") {
    // "+3 -0". Present only with an upstream, which is exactly when behind
    // is a number rather than a question.
    const match = /^\+(\d+)\s+-(\d+)$/.exec(value.trim());
    if (!match) return;
    headers.ahead = Number(match[1]) || 0;
    headers.behind = Number(match[2]) || 0;
  }
}

/**
 * Collapse porcelain's staged/worktree pair into the one letter a row shows.
 *
 * The list answers "what will a commit of everything contain", so a file
 * staged as added and then modified is still, to the reader, a new file.
 */
export function combineStatusCodes(staged: string | undefined, worktree: string | undefined): GitFileStatus {
  const x = staged || ".";
  const y = worktree || ".";
  if (x === "R" || y === "R") return "R";
  if (x === "A" || x === "C") return "A";
  if (x === "D" || y === "D") return "D";
  return "M";
}

/** Parse `git diff --numstat -z`: added, deleted, path, each NUL-terminated. */
export function parseGitNumstatZ(stdout: string): Map<string, { added: number | null; deleted: number | null }> {
  const out = new Map<string, { added: number | null; deleted: number | null }>();
  if (typeof stdout !== "string" || !stdout) return out;
  const chunks = stdout.split("\0");
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    // "12\t3\tpath" — or, for a rename, "12\t3\t" followed by two more chunks
    // (old path, new path). Binary files report "-" for both counts.
    const parts = chunk.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? null : Number(parts[0]);
    const deleted = parts[1] === "-" ? null : Number(parts[1]);
    let path = parts.slice(2).join("\t");
    if (!path) {
      // Rename form: the two paths follow as their own chunks.
      i += 1;
      const to = chunks[i + 1];
      if (to) {
        i += 1;
        path = to;
      } else {
        continue;
      }
    }
    out.set(normalizePath(path), {
      added: Number.isFinite(added as number) ? (added as number) : null,
      deleted: Number.isFinite(deleted as number) ? (deleted as number) : null,
    });
  }
  return out;
}

/** Parse the unpushed `git log`. Returns at most `limit`, plus whether more exist. */
export function parseUnpushedLog(
  stdout: string,
  limit: number = UNPUSHED_LIMIT,
): { commits: GitUnpushedCommit[]; truncated: boolean } {
  const commits: GitUnpushedCommit[] = [];
  if (typeof stdout !== "string" || !stdout.trim()) return { commits, truncated: false };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const sep = line.indexOf(UNIT_SEP);
    if (sep < 0) continue;
    const sha = line.slice(0, sep).trim();
    const subject = line.slice(sep + 1);
    if (sha) commits.push({ sha, subject });
  }
  // The caller asks for limit+1 precisely so this can be answered.
  const truncated = commits.length > limit;
  return { commits: truncated ? commits.slice(0, limit) : commits, truncated };
}

/** Fold the separate command outputs into the one thing the view renders. */
export function buildGitStatusSnapshot(input: {
  status: { headers: StatusHeaders; files: GitFileChange[]; conflicted: boolean };
  numstat?: Map<string, { added: number | null; deleted: number | null }>;
  unpushed?: { commits: GitUnpushedCommit[]; truncated: boolean };
  hasRemote: boolean;
  defaultBranch?: string | null;
}): GitStatusSnapshot {
  const { headers, files, conflicted } = input.status;
  const numstat = input.numstat || new Map();
  const unpushed = input.unpushed || { commits: [], truncated: false };
  const defaults = input.defaultBranch ? [input.defaultBranch] : DEFAULT_BRANCH_NAMES;
  const withCounts = files.map((file) => {
    const counts = numstat.get(file.path);
    if (!counts) return file;
    return { ...file, added: counts.added, deleted: counts.deleted };
  });
  withCounts.sort(compareChanges);
  return {
    branch: headers.branch,
    detached: headers.detached,
    unborn: headers.unborn,
    isDefaultBranch: !!headers.branch && defaults.indexOf(headers.branch) !== -1,
    hasRemote: !!input.hasRemote,
    hasUpstream: !!headers.upstream,
    upstream: headers.upstream,
    // Without an upstream, porcelain reports no branch.ab and the commit count
    // comes from the log instead — which is why that log asks a different
    // question when there is nothing to compare against.
    ahead: headers.upstream ? headers.ahead : unpushed.commits.length,
    behind: headers.upstream ? headers.behind : null,
    files: withCounts,
    unpushed: unpushed.commits,
    unpushedTruncated: unpushed.truncated,
    conflicted,
  };
}

/**
 * Row order: conflicts first because they block a commit, then untracked last
 * because a new file is the least surprising thing in the list. Alphabetical
 * inside each group so the list does not reshuffle between refreshes.
 */
function compareChanges(a: GitFileChange, b: GitFileChange): number {
  const rank = (s: GitFileStatus) => (s === "U" ? 0 : s === "?" ? 2 : 1);
  const byRank = rank(a.status) - rank(b.status);
  if (byRank !== 0) return byRank;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Writing git
 * ------------------------------------------------------------------ */

/** The closed set of things the panel may ask the host to run. */
export type GitOpName = "commit" | "push" | "newBranch" | "revertFile";

export interface GitOpRequest {
  op: GitOpName;
  /** commit — required, non-empty after trimming. */
  message?: string;
  /** commit — also push once the commit succeeds. */
  push?: boolean;
  /** commit — commit only these paths. Absent means everything. */
  paths?: string[];
  /** newBranch — the name to create and switch to. */
  branch?: string;
  /** revertFile — the single tracked path to restore. */
  path?: string;
}

/** One `git` invocation: the argv, and how it reads on the card. */
export interface GitStep {
  args: string[];
  /** True when a non-zero exit should stop the remaining steps. */
  required: boolean;
}

export interface GitOpPlan {
  ok: true;
  op: GitOpName;
  steps: GitStep[];
  /** The exact commands, one per line, as shown before Run. */
  display: string;
  /** Sentence naming what will happen, for the card's heading. */
  title: string;
}

export interface GitOpRefusal {
  ok: false;
  reason: string;
}

const MAX_COMMIT_MESSAGE = 20_000;

/**
 * Git refuses these itself, but not always with a message anyone can act on,
 * and `-` in the leading position is the one that turns a name into a flag.
 */
export function isValidBranchName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const value = name.trim();
  if (!value || value.length > 200) return false;
  if (value !== name) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  if (value.endsWith(".lock")) return false;
  if (value.indexOf("..") !== -1 || value.indexOf("//") !== -1) return false;
  if (value === "HEAD") return false;
  // Everything git's own check-ref-format rejects, plus whitespace and the
  // shell metacharacters that would matter if this ever reached a shell (it
  // does not — execFile — but the allowlist costs nothing).
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return false;
  return true;
}

/**
 * A path is acceptable only if the snapshot the host just computed is
 * reporting it. That is a stronger fence than any string check: it cannot name
 * a file outside the repository, cannot name an unchanged file, and goes stale
 * in the safe direction — a path that stopped being changed stops being
 * runnable.
 */
export function isKnownChangedPath(snapshot: GitStatusSnapshot, path: unknown): path is string {
  if (typeof path !== "string" || !path) return false;
  return snapshot.files.some((file) => file.path === path);
}

/**
 * Whether a row offers "Discard these changes".
 *
 * The offer is only made where {@link planRevertFile}'s single
 * `git checkout HEAD -- <path>` can actually keep the promise the button and
 * its confirmation make — *this restores the file to the last commit*. That
 * rules out every status whose path is not in HEAD under that name:
 *
 * - `?` untracked and `A` staged-new — git has never recorded them, so there
 *   is nothing to restore them TO. The command that would remove them
 *   (`git clean`, `git rm`) destroys work with no undo, which this view does
 *   not do.
 * - `R` renamed — the new path is not in HEAD either. Undoing a rename is a
 *   multi-step plan that deletes a file on its way, so it is refused rather
 *   than half-performed.
 * - `U` unmerged — a conflicted file has no single "last commit" state.
 *
 * Refusing is the honest answer, and {@link planRevertFile}'s refusal sentence
 * already says it. The alternative shipped once and was worse:
 * `git checkout -- <path>` restores from the INDEX, so on a file the agent had
 * staged it exits 0, changes nothing a person can see, and the view reports
 * success. On a rename it also threw away every edit made after the rename.
 *
 * `media/file-panel.js` carries the same predicate as `canDiscard` — a webview
 * cannot import this module — and `test/changes-view.dom.test.ts` pins the two
 * together.
 */
export function canRevertFile(snapshot: GitStatusSnapshot, path: string): boolean {
  const file = snapshot.files.find((entry) => entry.path === path);
  if (!file) return false;
  return file.status === "M" || file.status === "D";
}

/**
 * Turn a request into the commands that will run, or say why it cannot.
 *
 * The snapshot is an argument because every refusal here is a question about
 * the repository as it is right now: you cannot push without a remote, cannot
 * commit a conflicted tree, cannot revert a file that is not changed.
 */
export function planGitOp(request: GitOpRequest, snapshot: GitStatusSnapshot): GitOpPlan | GitOpRefusal {
  switch (request.op) {
    case "commit":
      return planCommit(request, snapshot);
    case "push":
      return planPush(snapshot);
    case "newBranch":
      return planNewBranch(request, snapshot);
    case "revertFile":
      return planRevertFile(request, snapshot);
    default:
      return { ok: false, reason: "Unknown operation." };
  }
}

function planCommit(request: GitOpRequest, snapshot: GitStatusSnapshot): GitOpPlan | GitOpRefusal {
  const message = typeof request.message === "string" ? request.message.trim() : "";
  if (!message) return { ok: false, reason: "A commit message is required." };
  if (message.length > MAX_COMMIT_MESSAGE) return { ok: false, reason: "That commit message is too long." };
  if (snapshot.conflicted) {
    return { ok: false, reason: "This repository has unresolved conflicts. Resolve them before committing." };
  }
  if (!snapshot.files.length) return { ok: false, reason: "Nothing to commit." };

  const subset = Array.isArray(request.paths) ? request.paths : null;
  if (subset) {
    if (!subset.length) return { ok: false, reason: "Nothing to commit." };
    for (const path of subset) {
      if (!isKnownChangedPath(snapshot, path)) {
        return { ok: false, reason: "That file is no longer changed. Refresh and try again." };
      }
    }
  }
  const paths = subset ? subset.slice().sort() : null;
  const steps: GitStep[] = [];
  // `-A` even with a pathspec, because it is what stages a DELETION. Without
  // it a removed file silently stays in the commit.
  steps.push({ args: paths ? ["add", "-A", "--", ...paths] : ["add", "-A"], required: true });
  steps.push({
    args: paths ? ["commit", "-m", message, "--", ...paths] : ["commit", "-m", message],
    required: true,
  });

  const wantsPush = !!request.push;
  if (wantsPush) {
    const push = pushStep(snapshot);
    if (!push.ok) return push;
    steps.push(push.step);
  }

  const count = paths ? paths.length : snapshot.files.length;
  const noun = count === 1 ? "1 file" : `${count} files`;
  return {
    ok: true,
    op: "commit",
    steps,
    display: renderSteps(steps),
    title: wantsPush ? `Commit ${noun} and push` : `Commit ${noun}`,
  };
}

function pushStep(snapshot: GitStatusSnapshot): { ok: true; step: GitStep } | GitOpRefusal {
  if (!snapshot.hasRemote) {
    return { ok: false, reason: "This project has no remote, so there is nowhere to push." };
  }
  if (snapshot.detached || !snapshot.branch) {
    return { ok: false, reason: "HEAD is detached. Create a branch before pushing." };
  }
  if (snapshot.hasUpstream) return { ok: true, step: { args: ["push"], required: true } };
  return { ok: true, step: { args: ["push", "-u", "origin", snapshot.branch], required: true } };
}

function planPush(snapshot: GitStatusSnapshot): GitOpPlan | GitOpRefusal {
  const push = pushStep(snapshot);
  if (!push.ok) return push;
  if (!snapshot.ahead) return { ok: false, reason: "Nothing to push." };
  const noun = snapshot.ahead === 1 ? "1 commit" : `${snapshot.ahead} commits`;
  return {
    ok: true,
    op: "push",
    steps: [push.step],
    display: renderSteps([push.step]),
    title: `Push ${noun}`,
  };
}

function planNewBranch(request: GitOpRequest, snapshot: GitStatusSnapshot): GitOpPlan | GitOpRefusal {
  const branch = typeof request.branch === "string" ? request.branch.trim() : "";
  if (!branch) return { ok: false, reason: "Enter a branch name." };
  if (!isValidBranchName(branch)) {
    return { ok: false, reason: "Branch names can use letters, digits, dot, dash, underscore and slash." };
  }
  if (snapshot.branch === branch) return { ok: false, reason: `Already on ${branch}.` };
  // `checkout -b` rather than the nicer `switch -c`: switch arrived in git
  // 2.23 and this runs on whatever git the machine has, including the one
  // inside a cloud image we did not build.
  const step: GitStep = { args: ["checkout", "-b", branch], required: true };
  return {
    ok: true,
    op: "newBranch",
    steps: [step],
    display: renderSteps([step]),
    title: `Move this work to ${branch}`,
  };
}

function planRevertFile(request: GitOpRequest, snapshot: GitStatusSnapshot): GitOpPlan | GitOpRefusal {
  const path = request.path;
  if (!isKnownChangedPath(snapshot, path)) {
    return { ok: false, reason: "That file is no longer changed. Refresh and try again." };
  }
  if (!canRevertFile(snapshot, path)) {
    return { ok: false, reason: "This file is not in the last commit, so there is nothing to restore it to." };
  }
  // HEAD, not the index. `git checkout -- <path>` restores the STAGED copy,
  // which is neither what the button says nor what the diff above it shows
  // (that diff is `git diff HEAD -- <path>`). On a file the agent had staged
  // the two differ, and the difference is the person's work.
  const step: GitStep = { args: ["checkout", "HEAD", "--", path], required: true };
  return {
    ok: true,
    op: "revertFile",
    steps: [step],
    display: renderSteps([step]),
    title: `Discard changes to ${path}`,
  };
}

/**
 * Render argv as the command text on the card.
 *
 * Quoting here is for READING, never for execution — every step reaches
 * `execFile` as an array and no shell is involved. It still has to be
 * faithful: a message with a space in it must look like one argument, or the
 * card teaches the wrong thing about what is about to run.
 */
export function renderSteps(steps: readonly GitStep[]): string {
  return steps.map((step) => `git ${step.args.map(quoteForDisplay).join(" ")}`).join("\n");
}

function quoteForDisplay(arg: string): string {
  if (arg === "") return '""';
  if (/^[A-Za-z0-9._\/=:@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, "\\$1").replace(/\n/g, "\\n")}"`;
}

function normalizePath(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

/* ------------------------------------------------------------------ *
 * Reading the result
 * ------------------------------------------------------------------ */

/**
 * Turn a failed push into a sentence with an action in it.
 *
 * Git's own stderr is kept and shown underneath; this is the line above it.
 * The three cases here are the ones a person actually meets, and each has a
 * different next move, which is the only reason to distinguish them.
 */
export function describeGitFailure(op: GitOpName, stderr: string): string {
  const text = String(stderr || "");
  if (op === "push") {
    if (/\[rejected\]|non-fast-forward|fetch first|behind its remote/i.test(text)) {
      return "The remote has commits you do not have. Pull before pushing.";
    }
    if (/could not read Username|Authentication failed|Permission denied|403/i.test(text)) {
      return "Git could not authenticate with the remote.";
    }
    if (/does not appear to be a git repository|Could not resolve host|unable to access/i.test(text)) {
      return "The remote could not be reached.";
    }
  }
  if (op === "commit") {
    if (/nothing to commit/i.test(text)) return "Nothing to commit — the files may already be committed.";
    if (/Please tell me who you are|empty ident name|unable to auto-detect email/i.test(text)) {
      return "Git needs a user name and email before it can commit.";
    }
    if (/pre-commit|hook declined|hook failed/i.test(text)) return "A git hook refused this commit.";
  }
  if (op === "newBranch" && /already exists/i.test(text)) return "A branch with that name already exists.";
  return "";
}
