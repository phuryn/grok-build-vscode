/**
 * The process seam for the Changes view. Everything it decides lives in
 * `src/git-status.ts`; this file only runs what that one planned.
 *
 * Kept out of sidebar.ts for the same reason `git-clone.ts` is: sidebar holds
 * no bare `execFile`, because every one-shot *grok* invocation has to go
 * through `execGrokCli`'s Windows-shim policy and a test enforces that by
 * banning the call shape. `git` is a real binary with no `.cmd` shim, so it
 * wants an explicit boundary of its own rather than that wrapper.
 *
 * Four environment settings apply to every call here and each is load-bearing:
 *
 * - `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` — the difference
 *   between a reported failure and a hang. A push needing credentials
 *   otherwise blocks on a terminal that does not exist, or pops a Windows
 *   credential dialog on a machine nobody is sitting at.
 * - `GIT_OPTIONAL_LOCKS=0` on the read paths — `git status` normally refreshes
 *   the index, which takes `index.lock`. The agent is often running git in the
 *   same repository at the same time, and a status refresh is never worth
 *   making its commit fail.
 * - `LC_ALL=C` — {@link describeGitFailure} matches English. Without this it
 *   silently stops recognising anything on a localised machine.
 */
import { execFile as nodeExecFile } from "node:child_process";
import {
  GIT_NUMSTAT_ARGS,
  GIT_REMOTE_ARGS,
  GIT_STATUS_ARGS,
  buildGitStatusSnapshot,
  gitDiffArgs,
  gitDiffUntrackedArgs,
  gitUnpushedArgs,
  parseGitNumstatZ,
  parseGitStatusPorcelain2,
  parseUnpushedLog,
  type GitOpPlan,
  type GitStatusSnapshot,
} from "./git-status";

/** Injected process seam. Matches the one shape this module uses. */
export interface GitIo {
  execFile: typeof nodeExecFile;
}

const REAL_IO: GitIo = { execFile: nodeExecFile };

/** Reads: long enough for a cold disk, short enough not to look wedged. */
export const GIT_READ_TIMEOUT_MS = 20_000;
/** Writes: a push over a slow line, or a repository with heavy hooks. */
export const GIT_WRITE_TIMEOUT_MS = 180_000;
/** A patch past this is cut; the view says so rather than rendering silence. */
export const GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024;

export interface GitExecResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** The command could not start at all — usually git is not installed. */
  spawnFailed?: boolean;
}

function gitEnv(base: NodeJS.ProcessEnv, readOnly: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
  if (readOnly) env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** Run one `git` in `root`. Never rejects — every caller classifies instead. */
export function runGit(
  root: string,
  args: readonly string[],
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv; timeoutMs?: number; readOnly?: boolean; maxBytes?: number },
): Promise<GitExecResult> {
  const io = opts?.io ?? REAL_IO;
  const readOnly = opts?.readOnly !== false;
  return new Promise((resolve) => {
    try {
      io.execFile(
        "git",
        ["-C", root, ...args],
        {
          env: gitEnv(opts?.env ?? process.env, readOnly),
          timeout: opts?.timeoutMs ?? (readOnly ? GIT_READ_TIMEOUT_MS : GIT_WRITE_TIMEOUT_MS),
          windowsHide: true,
          maxBuffer: opts?.maxBytes ?? 8 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const out = String(stdout ?? "");
          const err = String(stderr ?? "");
          if (!error) {
            resolve({ ok: true, code: 0, stdout: out, stderr: err });
            return;
          }
          const anyError = error as NodeJS.ErrnoException & { code?: number | string };
          // ENOENT means no git on PATH; a numeric code is git's own exit.
          const spawnFailed = anyError.code === "ENOENT";
          const code = typeof anyError.code === "number" ? anyError.code : spawnFailed ? -1 : 1;
          resolve({
            ok: false,
            code,
            stdout: out,
            stderr: err || String(error.message || ""),
            ...(spawnFailed ? { spawnFailed: true } : {}),
          });
        },
      );
    } catch (e: unknown) {
      resolve({
        ok: false,
        code: -1,
        stdout: "",
        stderr: String((e as Error)?.message ?? e),
        spawnFailed: true,
      });
    }
  });
}

const NOT_A_REPO = /not a git repository|does not appear to be a git repository/i;

export type GitStatusRead =
  | { ok: true; snapshot: GitStatusSnapshot }
  | { ok: false; reason: string; kind: "no-git" | "not-a-repo" | "failed" };

/**
 * Read everything the Changes view shows, in as few calls as the answers need.
 *
 * The status call runs first and alone because its result decides whether the
 * others are even askable: an unborn repository has no HEAD to diff against,
 * and a branch with no upstream has to ask a different question about which
 * commits are unpushed. The remaining three run together.
 *
 * There is deliberately no `git fetch` here. Fetching is a network call on a
 * path a person is waiting on, it can hang on credentials, and the number it
 * refreshes — how far behind the remote is — is not one the view needs to be
 * correct to answer "is my work safe". `behind` is reported as of the last
 * fetch, and the view says so.
 */
export async function readGitStatus(
  root: string,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv },
): Promise<GitStatusRead> {
  const status = await runGit(root, GIT_STATUS_ARGS, opts);
  if (!status.ok) {
    if (status.spawnFailed) return { ok: false, reason: "Git is not installed on this machine.", kind: "no-git" };
    if (NOT_A_REPO.test(status.stderr)) {
      return { ok: false, reason: "This project is not a git repository.", kind: "not-a-repo" };
    }
    return { ok: false, reason: firstLine(status.stderr) || "git status failed.", kind: "failed" };
  }
  const parsed = parseGitStatusPorcelain2(status.stdout);

  const [numstat, unpushed, remotes] = await Promise.all([
    // An unborn repository has no HEAD, so `diff HEAD` is an error rather than
    // an empty diff. Every file is new there anyway.
    parsed.headers.unborn
      ? Promise.resolve(null)
      : runGit(root, GIT_NUMSTAT_ARGS, opts),
    parsed.headers.unborn
      ? Promise.resolve(null)
      : runGit(root, gitUnpushedArgs(parsed.headers.upstream), opts),
    runGit(root, GIT_REMOTE_ARGS, opts),
  ]);

  return {
    ok: true,
    snapshot: buildGitStatusSnapshot({
      status: parsed,
      numstat: numstat && numstat.ok ? parseGitNumstatZ(numstat.stdout) : undefined,
      unpushed: unpushed && unpushed.ok ? parseUnpushedLog(unpushed.stdout) : undefined,
      hasRemote: !!(remotes && remotes.ok && remotes.stdout.trim()),
    }),
  };
}

export type GitDiffRead =
  | { ok: true; patch: string; truncated: boolean; untracked: boolean }
  | { ok: false; reason: string };

/**
 * One file's diff against the last commit.
 *
 * The path is checked against the snapshot by the caller, not here — this
 * function is given a path the repository is already reporting as changed.
 *
 * `--no-index` for an untracked file exits 1 when the files differ, which for
 * a new file is always. A non-zero exit with a patch on stdout is therefore
 * the SUCCESS case, and treating it as failure is the obvious way to get this
 * wrong.
 */
export async function readGitFileDiff(
  root: string,
  path: string,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv; untracked?: boolean },
): Promise<GitDiffRead> {
  const args = opts?.untracked ? gitDiffUntrackedArgs(path) : gitDiffArgs(path);
  const result = await runGit(root, args, { ...opts, maxBytes: GIT_DIFF_MAX_BYTES + 1024 });
  const hasPatch = result.stdout.length > 0;
  if (!result.ok && !hasPatch) {
    if (result.spawnFailed) return { ok: false, reason: "Git is not installed on this machine." };
    return { ok: false, reason: firstLine(result.stderr) || "Could not read the diff." };
  }
  const truncated = result.stdout.length > GIT_DIFF_MAX_BYTES;
  return {
    ok: true,
    patch: truncated ? result.stdout.slice(0, GIT_DIFF_MAX_BYTES) : result.stdout,
    truncated,
    untracked: !!opts?.untracked,
  };
}

export interface GitRunOutcome {
  ok: boolean;
  /** Index of the step that failed, or -1 when every step succeeded. */
  failedStep: number;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a plan's steps in order, stopping at the first required failure.
 *
 * Stopping matters more than it looks: a commit that fails must not be
 * followed by the push it was paired with, or "Commit and push" reports a
 * push error for a commit that never happened.
 */
export async function runGitPlan(
  root: string,
  plan: GitOpPlan,
  opts?: { io?: GitIo; env?: NodeJS.ProcessEnv },
): Promise<GitRunOutcome> {
  const chunks: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const result = await runGit(root, step.args, { ...opts, readOnly: false });
    if (result.stdout) chunks.push(result.stdout);
    if (result.stderr) errors.push(result.stderr);
    if (!result.ok && step.required) {
      return {
        ok: false,
        failedStep: i,
        code: result.code,
        stdout: chunks.join("\n"),
        stderr: errors.join("\n"),
      };
    }
  }
  return { ok: true, failedStep: -1, code: 0, stdout: chunks.join("\n"), stderr: errors.join("\n") };
}

function firstLine(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const line = trimmed.split(/\r?\n/).find((entry) => entry.trim().length > 0) || "";
  return line.replace(/^fatal:\s*/i, "").trim();
}

/**
 * Serialise runs per repository.
 *
 * Two commits at once on one checkout is not a race worth surviving — the
 * second would stage what the first is committing. A remote pressing Run twice
 * is refused with a sentence rather than queued, because by the time a queued
 * second commit ran, the message on screen would describe a tree that no
 * longer exists.
 */
export class GitRunGate {
  private readonly busy = new Set<string>();

  tryAcquire(root: string): boolean {
    const key = this.key(root);
    if (this.busy.has(key)) return false;
    this.busy.add(key);
    return true;
  }

  release(root: string): void {
    this.busy.delete(this.key(root));
  }

  isBusy(root: string): boolean {
    return this.busy.has(this.key(root));
  }

  private key(root: string): string {
    return process.platform === "win32" ? String(root || "").toLowerCase() : String(root || "");
  }
}
