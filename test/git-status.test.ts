// The Changes view answers one question — "is it safe to walk away?" — and
// every case below is a repository state where a naive reading of `git status`
// answers it wrongly.
//
// The ones that motivated this file, in the order they bite: a path with a
// space in it (which is why the commands use `-z` and not the quoted default),
// a rename (whose porcelain record is two chunks, so a parser that reads one
// chunk per record then mis-reads the NEXT file), a repository with no commits
// yet (where `git diff HEAD` is an error rather than an empty diff), and a
// branch that has never been pushed (where `@{u}` cannot be asked at all and
// "unpushed" has to mean something different).
import { describe, expect, it } from "vitest";
import {
  buildGitStatusSnapshot,
  GIT_STATUS_ARGS,
  canRevertFile,
  combineStatusCodes,
  describeGitFailure,
  emptyGitStatus,
  gitDiffArgs,
  gitDiffUntrackedArgs,
  gitUnpushedArgs,
  isKnownChangedPath,
  isValidBranchName,
  parseGitNumstatZ,
  parseGitStatusPorcelain2,
  parseUnpushedLog,
  planGitOp,
  renderSteps,
  UNPUSHED_LIMIT,
  type GitOpPlan,
  type GitStatusSnapshot,
} from "../src/git-status";

const NUL = "\0";
const US = "\u001f";

/** Join porcelain records the way `-z` emits them: NUL after every one. */
function z(...records: string[]): string {
  return records.map((record) => record + NUL).join("");
}

function ordinary(xy: string, path: string): string {
  return `1 ${xy} N... 100644 100644 100644 aaaaaaa bbbbbbb ${path}`;
}

function snapshotOf(over: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return { ...emptyGitStatus(), ...over };
}

function planOrThrow(result: ReturnType<typeof planGitOp>): GitOpPlan {
  if (!result.ok) throw new Error(`expected a plan, got refusal: ${result.reason}`);
  return result;
}

describe("parseGitStatusPorcelain2", () => {
  it("asks git for individual untracked files, preserving all of them for operation validation", () => {
    expect(GIT_STATUS_ARGS).toContain("-uall");
    const paths = Array.from({ length: 1205 }, (_, i) => `docs/file-${i}.md`);
    const snapshot = buildGitStatusSnapshot({
      status: parseGitStatusPorcelain2(z("# branch.head main", ...paths.map((path) => "? " + path))),
      hasRemote: false,
    });
    expect(snapshot.files).toHaveLength(paths.length);
    expect(isKnownChangedPath(snapshot, paths.at(-1))).toBe(true);
    expect(isKnownChangedPath(snapshot, "docs/")).toBe(false);
    const plan = planOrThrow(planGitOp({ op: "commit", message: "Save all files" }, snapshot));
    expect(plan.steps.map((step) => step.args)).toEqual([["add", "-A"], ["commit", "-m", "Save all files"]]);
    const selected = planOrThrow(planGitOp({ op: "commit", message: "Save last file", paths: [paths.at(-1)!] }, snapshot));
    expect(selected.steps[0].args).toContain(paths.at(-1));
  });
  it("reads the branch header, including ahead and behind", () => {
    const { headers } = parseGitStatusPorcelain2(
      z(
        "# branch.oid 1111111111111111111111111111111111111111",
        "# branch.head feature/changes-tab",
        "# branch.upstream origin/feature/changes-tab",
        "# branch.ab +3 -2",
      ),
    );
    expect(headers.branch).toBe("feature/changes-tab");
    expect(headers.upstream).toBe("origin/feature/changes-tab");
    expect(headers.ahead).toBe(3);
    expect(headers.behind).toBe(2);
    expect(headers.unborn).toBe(false);
    expect(headers.detached).toBe(false);
  });

  it("recognises an unborn repository", () => {
    const { headers } = parseGitStatusPorcelain2(z("# branch.oid (initial)", "# branch.head main"));
    expect(headers.unborn).toBe(true);
    expect(headers.branch).toBe("main");
  });

  it("recognises a detached HEAD and reports no branch", () => {
    const { headers } = parseGitStatusPorcelain2(
      z("# branch.oid 1111111111111111111111111111111111111111", "# branch.head (detached)"),
    );
    expect(headers.detached).toBe(true);
    expect(headers.branch).toBeNull();
  });

  it("leaves behind unknown when there is no upstream", () => {
    // No `# branch.ab` line is emitted at all without an upstream, so a parser
    // that defaults behind to 0 would claim the branch is up to date with a
    // remote it has never met.
    const { headers } = parseGitStatusPorcelain2(
      z("# branch.oid 1111111111111111111111111111111111111111", "# branch.head solo"),
    );
    expect(headers.upstream).toBeNull();
    expect(headers.behind).toBeNull();
  });

  it("keeps a path that contains spaces intact", () => {
    const { files } = parseGitStatusPorcelain2(z(ordinary(".M", "docs/release notes.md")));
    expect(files).toEqual([
      { path: "docs/release notes.md", status: "M", added: null, deleted: null },
    ]);
  });

  it("reads a rename and does not mistake its second chunk for a file", () => {
    const parsed = parseGitStatusPorcelain2(
      z(
        "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new-name.ts",
        "src/old-name.ts",
        ordinary(".M", "src/after.ts"),
      ),
    );
    expect(parsed.files).toEqual([
      { path: "src/new-name.ts", status: "R", added: null, deleted: null, origPath: "src/old-name.ts" },
      { path: "src/after.ts", status: "M", added: null, deleted: null },
    ]);
  });

  it("flags an unmerged file as a conflict", () => {
    const parsed = parseGitStatusPorcelain2(
      z("u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflicted.ts"),
    );
    expect(parsed.conflicted).toBe(true);
    expect(parsed.files[0]).toEqual({ path: "src/conflicted.ts", status: "U", added: null, deleted: null });
  });

  it("keeps untracked files and skips ignored ones", () => {
    const parsed = parseGitStatusPorcelain2(z("? scratch/notes.txt", "! node_modules/"));
    expect(parsed.files).toEqual([{ path: "scratch/notes.txt", status: "?", added: null, deleted: null }]);
  });

  it("returns an empty result for empty output", () => {
    expect(parseGitStatusPorcelain2("")).toEqual({
      headers: { branch: null, upstream: null, ahead: 0, behind: null, unborn: false, detached: false },
      files: [],
      conflicted: false,
    });
  });
});

describe("combineStatusCodes", () => {
  it("shows a file staged as added then modified as added", () => {
    // The list answers "what would a commit of everything contain", and to the
    // reader that file is new.
    expect(combineStatusCodes("A", "M")).toBe("A");
  });

  it("prefers rename over either side's other letter", () => {
    expect(combineStatusCodes("R", "M")).toBe("R");
    expect(combineStatusCodes(".", "R")).toBe("R");
  });

  it("reports a deletion from either side", () => {
    expect(combineStatusCodes("D", ".")).toBe("D");
    expect(combineStatusCodes(".", "D")).toBe("D");
  });

  it("falls back to modified", () => {
    expect(combineStatusCodes(".", "M")).toBe("M");
    expect(combineStatusCodes(undefined, undefined)).toBe("M");
  });
});

describe("parseGitNumstatZ", () => {
  it("reads counts for an ordinary file", () => {
    const counts = parseGitNumstatZ(z("12\t3\tsrc/a.ts", "0\t9\tsrc/b.ts"));
    expect(counts.get("src/a.ts")).toEqual({ added: 12, deleted: 3 });
    expect(counts.get("src/b.ts")).toEqual({ added: 0, deleted: 9 });
  });

  it("reports a binary file as unknown rather than zero", () => {
    const counts = parseGitNumstatZ(z("-\t-\tassets/logo.png"));
    expect(counts.get("assets/logo.png")).toEqual({ added: null, deleted: null });
  });

  it("keys a rename by the new path", () => {
    // The rename form is three chunks: counts with an empty path, then the old
    // path, then the new one. Status reports the new path, so that is the key
    // the two sides have to agree on.
    const counts = parseGitNumstatZ(z("4\t4\t", "src/old.ts", "src/new.ts", "1\t0\tsrc/after.ts"));
    expect(counts.get("src/new.ts")).toEqual({ added: 4, deleted: 4 });
    expect(counts.get("src/after.ts")).toEqual({ added: 1, deleted: 0 });
    expect(counts.has("src/old.ts")).toBe(false);
  });
});

describe("parseUnpushedLog", () => {
  it("reads sha and subject, keeping a subject that contains a space", () => {
    const parsed = parseUnpushedLog(`abc1234${US}Fix the thing\ndef5678${US}Another commit`);
    expect(parsed.commits).toEqual([
      { sha: "abc1234", subject: "Fix the thing" },
      { sha: "def5678", subject: "Another commit" },
    ]);
    expect(parsed.truncated).toBe(false);
  });

  it("marks the list truncated when more than the limit came back", () => {
    // The caller asks for limit+1 exactly so this is answerable without a
    // second count.
    const lines = Array.from({ length: 4 }, (_, i) => `sha${i}${US}subject ${i}`).join("\n");
    const parsed = parseUnpushedLog(lines, 3);
    expect(parsed.commits).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
  });

  it("returns nothing for empty output", () => {
    expect(parseUnpushedLog("")).toEqual({ commits: [], truncated: false });
  });
});

describe("gitUnpushedArgs", () => {
  it("asks the upstream question when there is an upstream", () => {
    expect(gitUnpushedArgs("origin/main", 50)).toEqual([
      "log",
      `--format=%h${US}%s`,
      "--max-count=51",
      "origin/main..HEAD",
    ]);
  });

  it("asks about all remotes when the branch has never been pushed", () => {
    // `@{u}` does not exist here, so the honest question is "commits that are
    // on no remote at all".
    expect(gitUnpushedArgs(null, 50)).toEqual([
      "log",
      `--format=%h${US}%s`,
      "--max-count=51",
      "HEAD",
      "--not",
      "--remotes",
    ]);
  });

  it("defaults to the shared limit", () => {
    expect(gitUnpushedArgs("origin/main")).toContain(`--max-count=${UNPUSHED_LIMIT + 1}`);
  });
});

describe("diff arguments", () => {
  it("diffs a tracked file against HEAD", () => {
    expect(gitDiffArgs("src/a b.ts")).toEqual(["diff", "HEAD", "--", "src/a b.ts"]);
  });

  it("diffs an untracked file against nothing", () => {
    expect(gitDiffUntrackedArgs("new.ts")).toEqual(["diff", "--no-index", "--", "/dev/null", "new.ts"]);
  });
});

describe("buildGitStatusSnapshot", () => {
  const headers = {
    branch: "main",
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
    unborn: false,
    detached: false,
  };

  it("attaches line counts and sorts conflicts first, untracked last", () => {
    const snapshot = buildGitStatusSnapshot({
      status: {
        headers,
        files: [
          { path: "z-untracked.txt", status: "?", added: null, deleted: null },
          { path: "b.ts", status: "M", added: null, deleted: null },
          { path: "a-conflict.ts", status: "U", added: null, deleted: null },
          { path: "a.ts", status: "M", added: null, deleted: null },
        ],
        conflicted: true,
      },
      numstat: parseGitNumstatZ(z("3\t1\tb.ts")),
      hasRemote: true,
    });
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "a-conflict.ts",
      "a.ts",
      "b.ts",
      "z-untracked.txt",
    ]);
    expect(snapshot.files[2]).toMatchObject({ added: 3, deleted: 1 });
    expect(snapshot.conflicted).toBe(true);
  });

  it("treats main as the default branch", () => {
    const snapshot = buildGitStatusSnapshot({
      status: { headers, files: [], conflicted: false },
      hasRemote: true,
    });
    expect(snapshot.isDefaultBranch).toBe(true);
    expect(snapshot.hasUpstream).toBe(true);
    expect(snapshot.ahead).toBe(2);
    expect(snapshot.behind).toBe(0);
  });

  it("counts ahead from the log when there is no upstream", () => {
    // Porcelain emits no `branch.ab` without an upstream, so ahead has to come
    // from the log — and behind stays unknown rather than becoming a false 0.
    const snapshot = buildGitStatusSnapshot({
      status: {
        headers: { ...headers, branch: "solo", upstream: null, ahead: 0, behind: null },
        files: [],
        conflicted: false,
      },
      unpushed: {
        commits: [
          { sha: "aaa", subject: "one" },
          { sha: "bbb", subject: "two" },
        ],
        truncated: false,
      },
      hasRemote: true,
    });
    expect(snapshot.hasUpstream).toBe(false);
    expect(snapshot.ahead).toBe(2);
    expect(snapshot.behind).toBeNull();
    expect(snapshot.isDefaultBranch).toBe(false);
  });
});

describe("isValidBranchName", () => {
  it("accepts ordinary names", () => {
    for (const name of ["main", "feature/changes-tab", "fix_1.2", "a"]) {
      expect(isValidBranchName(name)).toBe(true);
    }
  });

  it("rejects anything that would turn into a flag or a path escape", () => {
    for (const name of ["-f", "--force", "/leading", "trailing/", ".hidden", "ends.", "a..b", "a//b", "a.lock", "HEAD"]) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });

  it("rejects whitespace, shell characters and non-strings", () => {
    for (const name of ["has space", "a;rm -rf /", "a$(b)", "a\nb", "", "   ", undefined, null, 3]) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });

  it("rejects a name with surrounding whitespace rather than silently trimming", () => {
    expect(isValidBranchName(" main ")).toBe(false);
  });
});

describe("path fences", () => {
  const snapshot = snapshotOf({
    branch: "main",
    files: [
      { path: "src/a.ts", status: "M", added: 1, deleted: 0 },
      { path: "new.txt", status: "?", added: null, deleted: null },
      { path: "src/c.ts", status: "U", added: null, deleted: null },
    ],
  });

  it("accepts only paths the snapshot is reporting", () => {
    expect(isKnownChangedPath(snapshot, "src/a.ts")).toBe(true);
    expect(isKnownChangedPath(snapshot, "src/unchanged.ts")).toBe(false);
    expect(isKnownChangedPath(snapshot, "../../../etc/passwd")).toBe(false);
    expect(isKnownChangedPath(snapshot, "")).toBe(false);
    expect(isKnownChangedPath(snapshot, undefined)).toBe(false);
  });

  it("offers discard only where the path is in HEAD under that name", () => {
    // The button and its confirmation promise "the last commit", and the only
    // command planned is `git checkout HEAD -- <path>`. Every status this
    // refuses is one that command cannot restore: git has never recorded the
    // path (untracked, staged-new), it is recorded under a DIFFERENT name
    // (renamed), or there is no single last-commit state (unmerged). The
    // alternative is worse than refusing — see the rename case below.
    expect(canRevertFile(snapshot, "src/a.ts")).toBe(true);
    expect(canRevertFile(snapshot, "new.txt")).toBe(false);
    expect(canRevertFile(snapshot, "src/c.ts")).toBe(false);
    expect(canRevertFile(snapshot, "missing.ts")).toBe(false);
  });

  it("refuses a staged-new file and a rename, which checkout cannot restore", () => {
    const staged = snapshotOf({
      branch: "main",
      files: [
        { path: "src/added.ts", status: "A", added: 9, deleted: 0 },
        { path: "src/new-name.ts", status: "R", added: 2, deleted: 2, origPath: "src/old-name.ts" },
        { path: "src/gone.ts", status: "D", added: 0, deleted: 40 },
      ],
    });
    expect(canRevertFile(staged, "src/added.ts")).toBe(false);
    expect(canRevertFile(staged, "src/new-name.ts")).toBe(false);
    // A deletion is the discard that matters most, and HEAD has the file.
    expect(canRevertFile(staged, "src/gone.ts")).toBe(true);
  });
});

describe("planGitOp — commit", () => {
  const clean = snapshotOf({
    branch: "feature/x",
    hasRemote: true,
    hasUpstream: true,
    upstream: "origin/feature/x",
    files: [
      { path: "src/a.ts", status: "M", added: 2, deleted: 1 },
      { path: "src/b.ts", status: "D", added: 0, deleted: 8 },
    ],
  });

  it("stages everything and commits", () => {
    const plan = planOrThrow(planGitOp({ op: "commit", message: "Fix the thing" }, clean));
    expect(plan.steps.map((step) => step.args)).toEqual([
      ["add", "-A"],
      ["commit", "-m", "Fix the thing"],
    ]);
    expect(plan.title).toBe("Commit 2 files");
  });

  it("uses -A even with a pathspec so a deletion is staged", () => {
    // Without -A, `git add -- <deleted path>` on old git leaves the removal out
    // of the commit and the file silently comes back.
    const plan = planOrThrow(
      planGitOp({ op: "commit", message: "Drop b", paths: ["src/b.ts"] }, clean),
    );
    expect(plan.steps[0].args).toEqual(["add", "-A", "--", "src/b.ts"]);
    expect(plan.steps[1].args).toEqual(["commit", "-m", "Drop b", "--", "src/b.ts"]);
    expect(plan.title).toBe("Commit 1 file");
  });

  it("appends the push when asked, with -u on a branch that has no upstream", () => {
    const plan = planOrThrow(
      planGitOp({ op: "commit", message: "Work", push: true }, { ...clean, hasUpstream: false, upstream: null }),
    );
    expect(plan.steps[2].args).toEqual(["push", "-u", "origin", "feature/x"]);
    expect(plan.title).toBe("Commit 2 files and push");
  });

  it("pushes plainly when the branch already tracks something", () => {
    const plan = planOrThrow(planGitOp({ op: "commit", message: "Work", push: true }, clean));
    expect(plan.steps[2].args).toEqual(["push"]);
  });

  it("refuses an empty message", () => {
    expect(planGitOp({ op: "commit", message: "   " }, clean)).toEqual({
      ok: false,
      reason: "A commit message is required.",
    });
  });

  it("refuses to commit a conflicted tree", () => {
    const result = planGitOp({ op: "commit", message: "Anything" }, { ...clean, conflicted: true });
    expect(result.ok).toBe(false);
  });

  it("refuses when nothing is changed", () => {
    expect(planGitOp({ op: "commit", message: "Anything" }, { ...clean, files: [] })).toEqual({
      ok: false,
      reason: "Nothing to commit.",
    });
  });

  it("refuses a path the snapshot is not reporting", () => {
    // The fence that matters: a stale or hostile path cannot reach argv, and
    // it goes stale in the safe direction.
    const result = planGitOp({ op: "commit", message: "x", paths: ["../outside.ts"] }, clean);
    expect(result).toEqual({ ok: false, reason: "That file is no longer changed. Refresh and try again." });
  });

  it("refuses a commit-and-push with no remote, before committing anything", () => {
    // The refusal has to happen at planning time. Committing and then failing
    // to push would leave the person with a state the card never described.
    const result = planGitOp(
      { op: "commit", message: "x", push: true },
      { ...clean, hasRemote: false, hasUpstream: false, upstream: null },
    );
    expect(result).toEqual({
      ok: false,
      reason: "This project has no remote, so there is nowhere to push.",
    });
  });
});

describe("planGitOp — push", () => {
  const ahead = snapshotOf({
    branch: "main",
    hasRemote: true,
    hasUpstream: true,
    upstream: "origin/main",
    ahead: 3,
  });

  it("pushes when there is something to push", () => {
    const plan = planOrThrow(planGitOp({ op: "push" }, ahead));
    expect(plan.steps[0].args).toEqual(["push"]);
    expect(plan.title).toBe("Push 3 commits");
  });

  it("says nothing to push when the branch is level", () => {
    expect(planGitOp({ op: "push" }, { ...ahead, ahead: 0 })).toEqual({ ok: false, reason: "Nothing to push." });
  });

  it("refuses on a detached HEAD", () => {
    const result = planGitOp({ op: "push" }, { ...ahead, detached: true, branch: null });
    expect(result).toEqual({ ok: false, reason: "HEAD is detached. Create a branch before pushing." });
  });

  it("refuses with no remote at all", () => {
    const result = planGitOp({ op: "push" }, { ...ahead, hasRemote: false, hasUpstream: false, upstream: null });
    expect(result.ok).toBe(false);
  });
});

describe("planGitOp — newBranch", () => {
  const onMain = snapshotOf({ branch: "main", isDefaultBranch: true, hasRemote: true });

  it("uses checkout -b rather than switch -c", () => {
    // `git switch` arrived in 2.23 and this runs on whatever git the machine
    // has, including one inside a cloud image we did not build.
    const plan = planOrThrow(planGitOp({ op: "newBranch", branch: "feature/x" }, onMain));
    expect(plan.steps[0].args).toEqual(["checkout", "-b", "feature/x"]);
    expect(plan.title).toBe("Move this work to feature/x");
  });

  it("refuses a name that is already the current branch", () => {
    expect(planGitOp({ op: "newBranch", branch: "main" }, onMain)).toEqual({ ok: false, reason: "Already on main." });
  });

  it("refuses a name that would become a flag", () => {
    const result = planGitOp({ op: "newBranch", branch: "--force" }, onMain);
    expect(result.ok).toBe(false);
  });

  it("refuses an empty name", () => {
    expect(planGitOp({ op: "newBranch", branch: "  " }, onMain)).toEqual({ ok: false, reason: "Enter a branch name." });
  });
});

describe("planGitOp — revertFile", () => {
  const snapshot = snapshotOf({
    branch: "main",
    files: [
      { path: "src/a.ts", status: "M", added: 1, deleted: 1 },
      { path: "new.txt", status: "?", added: null, deleted: null },
    ],
  });

  it("restores a tracked file from the last commit", () => {
    const plan = planOrThrow(planGitOp({ op: "revertFile", path: "src/a.ts" }, snapshot));
    // HEAD, not the index. Without the tree-ish, `git checkout -- <path>`
    // restores the STAGED copy: on a file the agent had staged it exits 0,
    // leaves the working tree as it was, and the view reports success.
    expect(plan.steps[0].args).toEqual(["checkout", "HEAD", "--", "src/a.ts"]);
    expect(plan.title).toBe("Discard changes to src/a.ts");
  });

  it("refuses a rename rather than half-undoing it", () => {
    // `git checkout HEAD -- <new path>` cannot bring the old name back, and
    // running it anyway threw away every edit made after the rename while
    // reporting "Restored … to the last commit."
    const renamed = snapshotOf({
      branch: "main",
      files: [{ path: "src/new.ts", status: "R", added: 3, deleted: 1, origPath: "src/old.ts" }],
    });
    expect(planGitOp({ op: "revertFile", path: "src/new.ts" }, renamed)).toEqual({
      ok: false,
      reason: "This file is not in the last commit, so there is nothing to restore it to.",
    });
  });

  it("refuses an untracked file", () => {
    const result = planGitOp({ op: "revertFile", path: "new.txt" }, snapshot);
    expect(result).toEqual({
      ok: false,
      reason: "This file is not in the last commit, so there is nothing to restore it to.",
    });
  });

  it("refuses a path outside the snapshot", () => {
    const result = planGitOp({ op: "revertFile", path: "../../secrets.env" }, snapshot);
    expect(result.ok).toBe(false);
  });
});

describe("planGitOp — unknown", () => {
  it("refuses anything not in the closed set", () => {
    const result = planGitOp({ op: "gc" } as never, snapshotOf());
    expect(result).toEqual({ ok: false, reason: "Unknown operation." });
  });
});

describe("renderSteps", () => {
  it("shows a message with spaces as one argument", () => {
    // The card teaches what is about to run. A message that reads as several
    // arguments teaches the wrong thing, even though execFile never splits it.
    expect(renderSteps([{ args: ["commit", "-m", "Fix the thing"], required: true }])).toBe(
      'git commit -m "Fix the thing"',
    );
  });

  it("leaves plain arguments unquoted", () => {
    expect(renderSteps([{ args: ["push", "-u", "origin", "feature/x"], required: true }])).toBe(
      "git push -u origin feature/x",
    );
  });

  it("escapes quotes and newlines in a multi-line message", () => {
    expect(renderSteps([{ args: ["commit", "-m", 'Say "hi"\nagain'], required: true }])).toBe(
      'git commit -m "Say \\"hi\\"\\nagain"',
    );
  });

  it("shows every step on its own line", () => {
    expect(
      renderSteps([
        { args: ["add", "-A"], required: true },
        { args: ["commit", "-m", "x"], required: true },
      ]),
    ).toBe("git add -A\ngit commit -m x");
  });
});

describe("describeGitFailure", () => {
  it("names the next move for a rejected push", () => {
    expect(describeGitFailure("push", "! [rejected] main -> main (fetch first)")).toBe(
      "The remote has commits you do not have. Pull before pushing.",
    );
  });

  it.each([
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "github"],
    ["fatal: Authentication failed for 'https://gitlab.com/team/app.git/'", "gitlab.com"],
    ["git@github.com: Permission denied (publickey).", "github"],
    ["git@bitbucket.org: Permission denied (publickey).", "bitbucket.org"],
    ["Authentication failed for 'ssh://git@SSH.GITHUB.COM:443/team/app.git'", "github"],
    ["fatal: terminal prompts disabled", "the remote"],
    ["remote: Invalid username or password for 'https://dev.azure.com/team/app'", "dev.azure.com"],
    ["remote: error 403 for 'https://git.example.test:8443/team/app'", "git.example.test"],
    ["push failed: HTTP 403", "the remote"],
    ["remote: Support for password authentication was removed.\nfatal: Authentication failed for 'https://github.com/team/app'", "github"],
    ["remote: Support for password authentication was removed", "the remote"],
    ["Authentication failed for 'https://github.com.example.test/app'", "github.com.example.test"],
    ["Authentication failed for 'https://notgithub.com/app'", "notgithub.com"],
    ["Authentication failed for 'https://gitlab.com/github.com/app'", "gitlab.com"],
    ["Authentication failed for 'https://user:secret@gitlab.com/app'", "gitlab.com"],
    ["Authentication failed for 'https://'", "the remote"],
  ])("recognises credentials and their actual host: %s", (stderr, host) => {
    const expected = host === "github" ? "Push needs GitHub. Connect it in Settings."
      : `Git could not sign in to ${host}.`;
    expect(describeGitFailure("push", stderr)).toBe(expected);
    expect(describeGitFailure("push", stderr.toUpperCase())).toBe(expected);
    expect(describeGitFailure("commit", stderr, "push")).toBe(expected);
    expect(describeGitFailure("commit", stderr, "commit")).not.toBe(expected);
  });

  it.each([
    ["remote: Repository not found.\nfatal: repository 'https://github.com/team/private.git/' not found", "Push needs GitHub. Connect it in Settings."],
    ["remote: Repository not found.\nfatal: repository 'https://gitlab.com/team/app.git/' not found", "The remote repository was not found, or you do not have access to it."],
    ["remote: Repository not found.", "The remote repository was not found, or you do not have access to it."],
  ])("explains a missing or inaccessible repository: %s", (stderr, expected) => {
    expect(describeGitFailure("push", stderr)).toBe(expected);
    expect(describeGitFailure("push", stderr.toUpperCase())).toBe(expected);
  });

  it.each(["protected branch", "GH006: Protected branch update failed", "pre-receive hook declined"])(
    "recognises branch restrictions before generic rejection: %s", (reason) => {
      const stderr = `remote: ${reason}\n! [rejected] main -> main`;
      expect(describeGitFailure("push", stderr)).toBe("The remote refuses pushes to this branch.");
      expect(describeGitFailure("commit", stderr.toUpperCase(), "push")).toBe("The remote refuses pushes to this branch.");
    },
  );

  it.each(["Permission denied", "error 403", "remote returned 1403", "remote rejected by policy"])(
    "keeps unrelated failures as git's first line: %s", (stderr) => {
      expect(describeGitFailure("push", stderr + "\nmore detail")).toBe(stderr);
    },
  );

  it("recognises an unset git identity", () => {
    expect(describeGitFailure("commit", "*** Please tell me who you are.")).toBe(
      "Git needs a user name and email before it can commit.",
    );
  });

  it("recognises a refused hook", () => {
    expect(describeGitFailure("commit", "pre-commit hook failed")).toBe("A git hook refused this commit.");
  });

  it("keeps unknown failures as git's first line", () => {
    expect(describeGitFailure("push", "some other failure")).toBe("some other failure");
    expect(describeGitFailure("commit", "")).toBe("");
  });
});
