// Two halves, because they answer different questions.
//
// The fake-process half pins CLASSIFICATION — which failures get which
// sentence, and which commands are skipped rather than run. Those are
// decisions, and a real repository is a slow way to test a decision.
//
// The real-git half pins the READING. Every parser in `git-status.ts` is a
// claim about what git actually prints, and a fixture is only a copy of what
// someone believed it printed. These tests build throwaway repositories in a
// temp directory and ask the installed git, so a porcelain change or a
// platform difference shows up as a failure instead of as a wrong number on
// someone's phone.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planGitOp } from "../src/git-status";
import {
  GitRunGate,
  readGitFileDiff,
  readGitStatus,
  runGit,
  runGitPlan,
  type GitIo,
} from "../src/git-run";

/* ------------------------------------------------------------------ *
 * Fake process — classification
 * ------------------------------------------------------------------ */

type FakeReply = { code?: number; stdout?: string; stderr?: string; enoent?: boolean };

/** An execFile stand-in that answers by matching the first git subcommand. */
function fakeIo(replies: Record<string, FakeReply>, seen?: string[][]): GitIo {
  const impl = ((file: string, args: string[], _opts: unknown, cb: Function) => {
    seen?.push(args.slice());
    // args are ["-C", root, <subcommand>, ...]
    const key = args[2] || "";
    const reply = replies[key] || { code: 0, stdout: "" };
    setImmediate(() => {
      if (reply.enoent) {
        const err = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        cb(err, "", "");
        return;
      }
      if (reply.code && reply.code !== 0) {
        const err = new Error(`Command failed`) as NodeJS.ErrnoException & { code: number };
        err.code = reply.code;
        cb(err, reply.stdout || "", reply.stderr || "");
        return;
      }
      cb(null, reply.stdout || "", reply.stderr || "");
    });
    return undefined as never;
  }) as unknown as GitIo["execFile"];
  return { execFile: impl };
}

describe("runGit", () => {
  it("passes -C root before the subcommand", async () => {
    const seen: string[][] = [];
    await runGit("/repo", ["status"], { io: fakeIo({}, seen) });
    expect(seen[0]).toEqual(["-C", "/repo", "status"]);
  });

  it("reports a missing git as a spawn failure rather than an exit code", async () => {
    const result = await runGit("/repo", ["status"], { io: fakeIo({ status: { enoent: true } }) });
    expect(result.ok).toBe(false);
    expect(result.spawnFailed).toBe(true);
  });

  it("never rejects, even when the seam throws synchronously", async () => {
    const throwing: GitIo = {
      execFile: (() => {
        throw new Error("no processes today");
      }) as unknown as GitIo["execFile"],
    };
    const result = await runGit("/repo", ["status"], { io: throwing });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("no processes today");
  });
});

describe("readGitStatus — classification", () => {
  it("says git is missing when it cannot spawn", async () => {
    const result = await readGitStatus("/repo", { io: fakeIo({ status: { enoent: true } }) });
    expect(result).toEqual({ ok: false, reason: "Git is not installed on this machine.", kind: "no-git" });
  });

  it("recognises a directory that is not a repository", async () => {
    const io = fakeIo({ status: { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" } });
    const result = await readGitStatus("/repo", { io });
    expect(result).toMatchObject({ ok: false, kind: "not-a-repo" });
  });

  it("skips the HEAD-relative commands on an unborn repository", async () => {
    // `git diff HEAD` is an ERROR with no commits, not an empty diff. Running
    // it anyway would put a spurious failure in front of someone whose repo is
    // simply new.
    const seen: string[][] = [];
    const io = fakeIo(
      { status: { stdout: "# branch.oid (initial)\0# branch.head main\0? a.txt\0" }, remote: { stdout: "" } },
      seen,
    );
    const result = await readGitStatus("/repo", { io });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.unborn).toBe(true);
    expect(result.snapshot.files.map((f) => f.path)).toEqual(["a.txt"]);
    const subcommands = seen.map((args) => args[2]);
    expect(subcommands).toContain("status");
    expect(subcommands).toContain("remote");
    expect(subcommands).not.toContain("diff");
    expect(subcommands).not.toContain("log");
  });

  it("reports no remote when git remote prints nothing", async () => {
    const io = fakeIo({
      status: { stdout: "# branch.oid abc\0# branch.head main\0" },
      remote: { stdout: "\n" },
      diff: { stdout: "" },
      log: { stdout: "" },
    });
    const result = await readGitStatus("/repo", { io });
    expect(result.ok && result.snapshot.hasRemote).toBe(false);
  });

  it("degrades to a snapshot without counts when numstat fails", async () => {
    // A failed count is a missing number, not a failed view. The list of
    // changed files is the part that answers the question.
    const io = fakeIo({
      status: { stdout: "# branch.oid abc\0# branch.head main\0" + "1 .M N... 100644 100644 100644 aa bb src/a.ts\0" },
      remote: { stdout: "origin\n" },
      diff: { code: 1, stderr: "boom" },
      log: { stdout: "" },
    });
    const result = await readGitStatus("/repo", { io });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.files).toEqual([{ path: "src/a.ts", status: "M", added: null, deleted: null }]);
  });
});

describe("readGitFileDiff", () => {
  it("treats a non-zero exit with a patch as success", async () => {
    // `git diff --no-index` exits 1 whenever the files differ, which for a new
    // file is always. Reading that as failure is the obvious way to break the
    // one case it exists for.
    const io = fakeIo({ diff: { code: 1, stdout: "diff --git a/new.txt b/new.txt\n+hello\n" } });
    const result = await readGitFileDiff("/repo", "new.txt", { io, untracked: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toContain("+hello");
    expect(result.untracked).toBe(true);
  });

  it("reports a failure with no output as a failure", async () => {
    const io = fakeIo({ diff: { code: 128, stderr: "fatal: bad revision" } });
    const result = await readGitFileDiff("/repo", "x.ts", { io });
    expect(result).toEqual({ ok: false, reason: "bad revision" });
  });
});

describe("runGitPlan", () => {
  const snapshot = {
    branch: "main",
    detached: false,
    unborn: false,
    isDefaultBranch: true,
    hasRemote: true,
    hasUpstream: true,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [{ path: "a.ts", status: "M" as const, added: 1, deleted: 0 }],
    unpushed: [],
    unpushedTruncated: false,
    conflicted: false,
  };

  it("does not push when the commit failed", async () => {
    // Otherwise "Commit and push" reports a push error for a commit that never
    // happened, and the person is told the wrong thing went wrong.
    const seen: string[][] = [];
    const io = fakeIo({ add: { stdout: "" }, commit: { code: 1, stderr: "hook declined" }, push: { stdout: "" } }, seen);
    const plan = planGitOp({ op: "commit", message: "x", push: true }, snapshot);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const outcome = await runGitPlan("/repo", plan, { io });
    expect(outcome.ok).toBe(false);
    expect(outcome.failedStep).toBe(1);
    expect(seen.map((args) => args[2])).toEqual(["add", "commit"]);
  });

  it("runs every step when they all succeed", async () => {
    const seen: string[][] = [];
    const io = fakeIo({}, seen);
    const plan = planGitOp({ op: "commit", message: "x", push: true }, snapshot);
    if (!plan.ok) throw new Error("expected a plan");
    const outcome = await runGitPlan("/repo", plan, { io });
    expect(outcome.ok).toBe(true);
    expect(seen.map((args) => args[2])).toEqual(["add", "commit", "push"]);
  });
});

describe("GitRunGate", () => {
  it("refuses a second run on the same repository until the first releases", async () => {
    const gate = new GitRunGate();
    expect(gate.tryAcquire("/repo")).toBe(true);
    expect(gate.tryAcquire("/repo")).toBe(false);
    gate.release("/repo");
    expect(gate.tryAcquire("/repo")).toBe(true);
  });

  it("lets two different repositories run at once", () => {
    const gate = new GitRunGate();
    expect(gate.tryAcquire("/one")).toBe(true);
    expect(gate.tryAcquire("/two")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Real git — the reading
 * ------------------------------------------------------------------ */

const run = promisify(execFile);

let gitAvailable = true;
let tmpRoot = "";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_GLOBAL: path.join(tmpRoot || os.tmpdir(), "no-such-gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(tmpRoot || os.tmpdir(), "no-such-gitconfig"),
    },
  });
  return String(stdout);
}

/** A fresh repository with an initial commit unless `bare` says otherwise. */
async function makeRepo(name: string, opts?: { empty?: boolean }): Promise<string> {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(root, { recursive: true });
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  if (!opts?.empty) {
    fs.writeFileSync(path.join(root, "README.md"), "hello\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "initial");
  }
  return root;
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grok-git-status-"));
  try {
    await run("git", ["--version"], { windowsHide: true });
  } catch {
    gitAvailable = false;
  }
});

afterAll(() => {
  if (tmpRoot) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not worth failing a suite over */
    }
  }
});

describe.runIf(gitAvailable !== false)("readGitStatus against real git", () => {
  it("reads a clean repository as having nothing to do", async () => {
    const root = await makeRepo("clean");
    const result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.files).toEqual([]);
    expect(result.snapshot.branch).toBe("main");
    expect(result.snapshot.isDefaultBranch).toBe(true);
    expect(result.snapshot.unborn).toBe(false);
    expect(result.snapshot.conflicted).toBe(false);
  });

  it("reads a repository with no commits and no remote — the emptiest real case", async () => {
    // "Not connected, nothing local" — a brand new project. Nothing here may
    // throw, and push must be impossible rather than merely unset.
    const root = await makeRepo("unborn", { empty: true });
    fs.writeFileSync(path.join(root, "draft.md"), "first\n");
    const result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.unborn).toBe(true);
    expect(result.snapshot.hasRemote).toBe(false);
    expect(result.snapshot.files.map((f) => f.path)).toEqual(["draft.md"]);
    expect(result.snapshot.ahead).toBe(0);
    expect(planGitOp({ op: "push" }, result.snapshot)).toMatchObject({ ok: false });
  });

  it("counts local commits as unpushed when there is no remote at all", async () => {
    // "Not connected, local commits" — the case the goal names. `@{u}` cannot
    // be asked, so ahead has to come from `HEAD --not --remotes`.
    const root = await makeRepo("local-only");
    fs.writeFileSync(path.join(root, "a.txt"), "one\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "add a");
    fs.writeFileSync(path.join(root, "b.txt"), "two\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "add b");

    const result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.hasRemote).toBe(false);
    expect(result.snapshot.hasUpstream).toBe(false);
    expect(result.snapshot.behind).toBeNull();
    // Three commits exist and none is on a remote.
    expect(result.snapshot.ahead).toBe(3);
    expect(result.snapshot.unpushed.map((c) => c.subject)).toEqual(["add b", "add a", "initial"]);
    // And the view must not offer a push it cannot perform.
    expect(planGitOp({ op: "push" }, result.snapshot)).toEqual({
      ok: false,
      reason: "This project has no remote, so there is nowhere to push.",
    });
  });

  it("reads modified, added, deleted, renamed and untracked in one tree", async () => {
    const root = await makeRepo("mixed");
    fs.writeFileSync(path.join(root, "keep.txt"), "a\nb\nc\n");
    fs.writeFileSync(path.join(root, "gone.txt"), "bye\n");
    fs.writeFileSync(path.join(root, "old name.txt"), "x\n".repeat(20));
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "seed");

    fs.appendFileSync(path.join(root, "keep.txt"), "d\n");
    fs.unlinkSync(path.join(root, "gone.txt"));
    fs.renameSync(path.join(root, "old name.txt"), path.join(root, "new name.txt"));
    fs.writeFileSync(path.join(root, "fresh.txt"), "new\n");
    await git(root, "add", "-A");

    const result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = new Map(result.snapshot.files.map((f) => [f.path, f]));

    expect(byPath.get("keep.txt")).toMatchObject({ status: "M", added: 1, deleted: 0 });
    expect(byPath.get("gone.txt")).toMatchObject({ status: "D" });
    expect(byPath.get("fresh.txt")).toMatchObject({ status: "A" });
    // The rename must appear once, under its new name, with the old one
    // recorded — not twice as an add and a delete.
    expect(byPath.has("old name.txt")).toBe(false);
    expect(byPath.get("new name.txt")).toMatchObject({ status: "R", origPath: "old name.txt" });
  });

  it("keeps a path containing a space intact end to end", async () => {
    const root = await makeRepo("spaces");
    fs.mkdirSync(path.join(root, "my docs"));
    fs.writeFileSync(path.join(root, "my docs", "release notes.md"), "one\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "seed");
    fs.appendFileSync(path.join(root, "my docs", "release notes.md"), "two\n");

    const result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.files.map((f) => f.path)).toEqual(["my docs/release notes.md"]);
    expect(result.snapshot.files[0]).toMatchObject({ added: 1, deleted: 0 });

    const diff = await readGitFileDiff(root, "my docs/release notes.md");
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.patch).toContain("+two");
  });

  it("reads an untracked file's whole contents as its diff", async () => {
    const root = await makeRepo("untracked-diff");
    fs.writeFileSync(path.join(root, "brand new.txt"), "alpha\nbeta\n");
    const diff = await readGitFileDiff(root, "brand new.txt", { untracked: true });
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.patch).toContain("+alpha");
    expect(diff.patch).toContain("+beta");
  });

  it("reports a conflicted tree and refuses to commit it", async () => {
    const root = await makeRepo("conflict");
    fs.writeFileSync(path.join(root, "c.txt"), "base\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "base");
    await git(root, "checkout", "-b", "other");
    fs.writeFileSync(path.join(root, "c.txt"), "theirs\n");
    await git(root, "commit", "-am", "theirs");
    await git(root, "checkout", "main");
    fs.writeFileSync(path.join(root, "c.txt"), "ours\n");
    await git(root, "commit", "-am", "ours");
    await run("git", ["merge", "other"], { cwd: root, windowsHide: true }).catch(() => undefined);

    const result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.conflicted).toBe(true);
    expect(result.snapshot.files[0]).toMatchObject({ path: "c.txt", status: "U" });
    expect(planGitOp({ op: "commit", message: "force it" }, result.snapshot)).toMatchObject({ ok: false });
  });

  it("reads a detached HEAD and refuses to push from it", async () => {
    const root = await makeRepo("detached");
    fs.writeFileSync(path.join(root, "d.txt"), "d\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "second");
    const head = (await git(root, "rev-parse", "HEAD~1")).trim();
    await git(root, "checkout", head);

    const result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.detached).toBe(true);
    expect(result.snapshot.branch).toBeNull();
    expect(result.snapshot.isDefaultBranch).toBe(false);
    expect(planGitOp({ op: "push" }, { ...result.snapshot, hasRemote: true, ahead: 1 })).toEqual({
      ok: false,
      reason: "HEAD is detached. Create a branch before pushing.",
    });
  });

  it("tracks ahead and behind against a real upstream", async () => {
    // A bare repository stands in for the remote, so push and fetch are real
    // without a network.
    const remote = path.join(tmpRoot, "origin.git");
    fs.mkdirSync(remote, { recursive: true });
    await git(remote, "init", "--bare", "--initial-branch=main");

    const root = await makeRepo("tracking");
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "-u", "origin", "main");

    let result = await readGitStatus(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.hasRemote).toBe(true);
    expect(result.snapshot.hasUpstream).toBe(true);
    expect(result.snapshot.upstream).toBe("origin/main");
    expect(result.snapshot.ahead).toBe(0);
    expect(result.snapshot.behind).toBe(0);
    expect(planGitOp({ op: "push" }, result.snapshot)).toEqual({ ok: false, reason: "Nothing to push." });

    fs.writeFileSync(path.join(root, "ahead.txt"), "x\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "one ahead");

    result = await readGitStatus(root);
    if (!result.ok) throw new Error("expected a snapshot");
    expect(result.snapshot.ahead).toBe(1);
    expect(result.snapshot.unpushed).toEqual([expect.objectContaining({ subject: "one ahead" })]);
    const plan = planGitOp({ op: "push" }, result.snapshot);
    expect(plan).toMatchObject({ ok: true, title: "Push 1 commit" });
  });

  it("needs -u for a branch created off a tracked one, and pushes it for real", async () => {
    const remote = path.join(tmpRoot, "origin-branch.git");
    fs.mkdirSync(remote, { recursive: true });
    await git(remote, "init", "--bare", "--initial-branch=main");

    const root = await makeRepo("new-branch");
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "-u", "origin", "main");
    await git(root, "checkout", "-b", "feature/x");
    fs.writeFileSync(path.join(root, "f.txt"), "f\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "feature work");

    const result = await readGitStatus(root);
    if (!result.ok) throw new Error("expected a snapshot");
    expect(result.snapshot.hasRemote).toBe(true);
    expect(result.snapshot.hasUpstream).toBe(false);
    expect(result.snapshot.ahead).toBe(1);

    const plan = planGitOp({ op: "push" }, result.snapshot);
    if (!plan.ok) throw new Error(`expected a plan: ${plan.reason}`);
    expect(plan.steps[0].args).toEqual(["push", "-u", "origin", "feature/x"]);

    // Run the plan the card showed, and confirm the remote actually moved.
    const outcome = await runGitPlan(root, plan);
    expect(outcome.ok).toBe(true);
    const remoteBranches = await git(remote, "branch", "--list", "feature/x");
    expect(remoteBranches.trim()).toContain("feature/x");
  });

  it("commits exactly the plan it displayed, deletions included", async () => {
    const root = await makeRepo("commit-run");
    fs.writeFileSync(path.join(root, "stay.txt"), "stay\n");
    fs.writeFileSync(path.join(root, "leave.txt"), "leave\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "seed");

    fs.unlinkSync(path.join(root, "leave.txt"));
    fs.appendFileSync(path.join(root, "stay.txt"), "more\n");

    const before = await readGitStatus(root);
    if (!before.ok) throw new Error("expected a snapshot");
    const plan = planGitOp({ op: "commit", message: "remove leave.txt and extend stay" }, before.snapshot);
    if (!plan.ok) throw new Error(`expected a plan: ${plan.reason}`);
    const outcome = await runGitPlan(root, plan);
    expect(outcome.ok).toBe(true);

    const after = await readGitStatus(root);
    if (!after.ok) throw new Error("expected a snapshot");
    expect(after.snapshot.files).toEqual([]);
    // The deletion has to be IN the commit — `git add` without -A leaves it
    // behind and the file quietly returns on the next checkout.
    const listed = await git(root, "ls-tree", "--name-only", "HEAD");
    expect(listed).not.toContain("leave.txt");
    expect(listed).toContain("stay.txt");
  });

  it("commits only the paths the request named", async () => {
    const root = await makeRepo("partial-commit");
    fs.writeFileSync(path.join(root, "one.txt"), "1\n");
    fs.writeFileSync(path.join(root, "two.txt"), "2\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "seed");
    fs.appendFileSync(path.join(root, "one.txt"), "edited\n");
    fs.appendFileSync(path.join(root, "two.txt"), "edited\n");

    const before = await readGitStatus(root);
    if (!before.ok) throw new Error("expected a snapshot");
    const plan = planGitOp({ op: "commit", message: "only one", paths: ["one.txt"] }, before.snapshot);
    if (!plan.ok) throw new Error(`expected a plan: ${plan.reason}`);
    expect(await runGitPlan(root, plan)).toMatchObject({ ok: true });

    const after = await readGitStatus(root);
    if (!after.ok) throw new Error("expected a snapshot");
    expect(after.snapshot.files.map((f) => f.path)).toEqual(["two.txt"]);
  });

  it("reverts one file and leaves the rest alone", async () => {
    const root = await makeRepo("revert");
    fs.writeFileSync(path.join(root, "r.txt"), "original\n");
    fs.writeFileSync(path.join(root, "other.txt"), "other\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "seed");
    fs.writeFileSync(path.join(root, "r.txt"), "changed\n");
    fs.writeFileSync(path.join(root, "other.txt"), "also changed\n");

    const before = await readGitStatus(root);
    if (!before.ok) throw new Error("expected a snapshot");
    const plan = planGitOp({ op: "revertFile", path: "r.txt" }, before.snapshot);
    if (!plan.ok) throw new Error(`expected a plan: ${plan.reason}`);
    expect(await runGitPlan(root, plan)).toMatchObject({ ok: true });

    // Line endings are git's business, not this test's: a checkout on Windows
    // applies core.autocrlf, so the restored file legitimately comes back CRLF.
    const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
    expect(read("r.txt")).toBe("original\n");
    expect(read("other.txt")).toBe("also changed\n");
  });

  it("creates and switches to a new branch, carrying the working tree", async () => {
    const root = await makeRepo("branch-move");
    fs.writeFileSync(path.join(root, "wip.txt"), "in progress\n");

    const before = await readGitStatus(root);
    if (!before.ok) throw new Error("expected a snapshot");
    expect(before.snapshot.isDefaultBranch).toBe(true);
    const plan = planGitOp({ op: "newBranch", branch: "feature/move" }, before.snapshot);
    if (!plan.ok) throw new Error(`expected a plan: ${plan.reason}`);
    expect(await runGitPlan(root, plan)).toMatchObject({ ok: true });

    const after = await readGitStatus(root);
    if (!after.ok) throw new Error("expected a snapshot");
    expect(after.snapshot.branch).toBe("feature/move");
    expect(after.snapshot.isDefaultBranch).toBe(false);
    // The uncommitted work must come along — that is the entire point of the
    // "move this off main" affordance.
    expect(after.snapshot.files.map((f) => f.path)).toEqual(["wip.txt"]);
  });

  it("reports a push to a missing remote as a failure with a readable reason", async () => {
    const root = await makeRepo("bad-remote");
    await git(root, "remote", "add", "origin", path.join(tmpRoot, "does-not-exist.git"));

    const result = await readGitStatus(root);
    if (!result.ok) throw new Error("expected a snapshot");
    const plan = planGitOp({ op: "push" }, { ...result.snapshot, ahead: 1 });
    if (!plan.ok) throw new Error(`expected a plan: ${plan.reason}`);
    const outcome = await runGitPlan(root, plan);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr.length).toBeGreaterThan(0);
  });
});
