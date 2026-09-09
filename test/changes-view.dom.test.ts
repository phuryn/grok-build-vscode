// The Changes view: the pure snapshot→sentence functions, and the panel that
// draws them.
//
// Two halves, deliberately. The pure half pins the WORDS — a headline that says
// the wrong thing is the whole failure mode of a view whose job is one sentence
// — and the DOM half pins the things a person can only discover by pressing
// something: which control appears, which is disabled, and what actually
// reaches the host when it is pressed.
//
// What lives elsewhere: `test/git-status.test.ts` owns parsing and planning,
// `test/git-run.test.ts` owns real repositories, and
// `scripts/changes-view-screens.mjs` owns how it looks at three viewports.
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
// @ts-expect-error Plain-JS webview module intentionally has no TS build step.
import {
  changeCountLabel,
  changesBranchLine,
  changesCommitOnlyAction,
  changeTotalLabel,
  changesHeadline,
  changesPrimaryAction,
  createFilePanel,
  parseUnifiedDiff,
} from "../media/file-panel.js";

type Snapshot = Record<string, unknown>;

const snap = (over: Snapshot = {}): Snapshot => ({
  branch: "main",
  detached: false,
  unborn: false,
  isDefaultBranch: true,
  hasRemote: true,
  hasUpstream: true,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  unpushed: [],
  unpushedTruncated: false,
  conflicted: false,
  ...over,
});

const file = (path: string, status: string, added: number | null = 1, deleted: number | null = 1) =>
  ({ path, status, added, deleted });

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A panel wired to a scripted host.
 *
 * `runs` is the point of most of these tests: the view's contract with the host
 * is a closed set of four operations, and what matters is that pressing a
 * button sends exactly the one it says it will.
 */
function harness(options: {
  snapshot?: Snapshot;
  status?: () => Promise<unknown>;
  diff?: () => Promise<unknown>;
  run?: (request: Record<string, unknown>) => Promise<unknown>;
  gitEnabled?: () => boolean;
  omitGit?: boolean;
} = {}) {
  const window = new Window({ url: "https://example.test/" });
  const document = window.document;
  const runs: Array<Record<string, unknown>> = [];
  const diffs: string[] = [];
  let statusCalls = 0;

  const access: Record<string, unknown> = {
    currentScope: async () => ({ id: "/work/app", label: "app", title: "/work/app" }),
    list: async () => ({ ok: true, entries: [], truncated: false }),
    // Readable, because one test needs a FILE tab open while the Changes view
    // is on screen — the state in which two tabs used to look selected.
    read: async (_scopeId: string, relPath: string) => ({
      ok: true, kind: "text", relPath, text: "hello",
      stamp: { mtimeMs: 1, size: 5 }, absPath: "/work/app/" + relPath,
    }),
  };
  if (!options.omitGit) {
    access.gitStatus = async () => {
      statusCalls += 1;
      if (options.status) return options.status();
      return { ok: true, snapshot: options.snapshot || snap() };
    };
    access.gitDiff = async (_scopeId: string, relPath: string) => {
      diffs.push(relPath);
      if (options.diff) return options.diff();
      return { ok: true, patch: "@@ -1 +1 @@\n-old\n+new\n", truncated: false, untracked: false };
    };
    access.gitRun = async (_scopeId: string, request: Record<string, unknown>) => {
      runs.push(request);
      if (options.run) return options.run(request);
      return { ok: true, snapshot: options.snapshot || snap() };
    };
  }

  const panel = createFilePanel({
    access,
    document,
    window,
    mount: { panelHost: document.body, toggleHost: document.body, presentation: "overlay" },
    ui: {
      confirm: async (request: { actions?: Array<{ id: string }> }) =>
        (request.actions && request.actions[0] ? request.actions[0].id : "cancel"),
      renderMarkdown: (source: string) => `<p>${source}</p>`,
    },
    gitEnabled: options.gitEnabled,
  });

  const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
  const qq = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[];

  return {
    window, document, panel, runs, diffs, q, qq,
    statusCalls: () => statusCalls,
    async open() {
      panel.setOpen(true);
      await settle();
      (q(".gfp-changes-btn") as HTMLElement).click();
      await settle();
      await settle();
    },
  };
}

describe("the sentence at the top", () => {
  it("names conflicts first, because they are the only state that blocks committing", () => {
    const headline = changesHeadline(snap({
      conflicted: true,
      ahead: 3,
      files: [file("a.ts", "U"), file("b.ts", "U"), file("c.ts", "M")],
    }));
    expect(headline).toEqual({ tone: "warn", text: "2 files have conflicts" });
  });

  it("does NOT warn about ordinary uncommitted work", () => {
    // The whole point of the tone split. A colour that fires on every edit is a
    // colour nobody reads, and it would make conflicts look like nothing.
    expect(changesHeadline(snap({ files: [file("a.ts", "M")] })))
      .toEqual({ tone: "note", text: "1 file not committed" });
    expect(changesHeadline(snap({ files: [file("a.ts", "M"), file("b.ts", "A")] })).tone)
      .toBe("note");
  });

  it("falls through to unpushed commits only when nothing is uncommitted", () => {
    expect(changesHeadline(snap({ ahead: 2, files: [file("a.ts", "M")] })).text)
      .toBe("1 file not committed");
    expect(changesHeadline(snap({ ahead: 2 })).text)
      .toBe("2 commits saved here but not pushed");
    expect(changesHeadline(snap({ ahead: 1 })).text)
      .toBe("1 commit saved here but not pushed");
  });

  it("says the safe thing when there is nothing to do", () => {
    expect(changesHeadline(snap({}))).toEqual({ tone: "ok", text: "Everything is committed and pushed" });
    expect(changesHeadline(snap({ unborn: true })).text).toBe("Nothing committed yet");
  });
});

describe("the branch line", () => {
  it("distinguishes no remote at all from a branch that has never been pushed", () => {
    // These are different problems with different answers, and conflating them
    // is how somebody spends ten minutes looking for a push that cannot work.
    expect(changesBranchLine(snap({ hasRemote: false, hasUpstream: false })))
      .toEqual({ branch: "main", note: "No remote" });
    expect(changesBranchLine(snap({ hasUpstream: false })))
      .toEqual({ branch: "main", note: "Not on the remote yet" });
  });

  it("reports behind as a fact rather than a live count", () => {
    expect(changesBranchLine(snap({ behind: 4 })).note)
      .toBe("4 commits on the remote you do not have");
    // Null is the ordinary case: the view never fetches, so it must not imply
    // it just checked.
    expect(changesBranchLine(snap({ behind: null })).note).toBe("");
    expect(changesBranchLine(snap({ behind: 0 })).note).toBe("");
  });

  it("has something to say when HEAD is not on a branch", () => {
    expect(changesBranchLine(snap({ detached: true, branch: null })))
      .toEqual({ branch: "Detached HEAD", note: "Not on a branch" });
  });
});

describe("the one button", () => {
  it("promises commit AND push in one press when both are wanted", () => {
    const action = changesPrimaryAction(
      snap({ ahead: 1, files: [file("a.ts", "M")] }),
      { message: "Fix the thing" },
    );
    expect(action.op).toBe("commit");
    expect(action.push).toBe(true);
    expect(action.label).toBe("Commit and push");
    expect(action.disabled).toBe(false);
  });

  it("will not commit without a message, and says why", () => {
    const action = changesPrimaryAction(snap({ files: [file("a.ts", "M")] }), { message: "   " });
    expect(action.disabled).toBe(true);
    expect(action.hint).toBe("Describe what changed, then commit.");
  });

  it("refuses to commit while a merge is unresolved", () => {
    const action = changesPrimaryAction(
      snap({ conflicted: true, files: [file("a.ts", "U")] }),
      { message: "anything" },
    );
    expect(action.disabled).toBe(true);
    expect(action.hint).toBe("Resolve the conflicts first.");
  });

  it("refuses to push into nowhere, and says which nowhere", () => {
    // No op at all, not a disabled push: there is nothing for the press to do.
    const noRemote = changesPrimaryAction(snap({ hasRemote: false, hasUpstream: false, ahead: 2 }), { message: "" });
    expect(noRemote.op).toBe(null);
    expect(noRemote.disabled).toBe(true);
    expect(noRemote.hint).toBe("This project has no remote to push to.");

    // A detached HEAD on a repository that HAS an origin must not be told the
    // project has no remote — that is false, and sends the reader looking for
    // a remote they already have.
    const detached = changesPrimaryAction(snap({ detached: true, branch: null, ahead: 2 }), { message: "" });
    expect(detached.hint).toBe("You are not on a branch, so there is nothing to push to.");
  });

  it("counts the commits it is about to push", () => {
    expect(changesPrimaryAction(snap({ ahead: 1 }), { message: "" }).label).toBe("Push 1 commit");
    expect(changesPrimaryAction(snap({ ahead: 5 }), { message: "" }).label).toBe("Push 5 commits");
  });
});

describe("counts and diffs", () => {
  it("says nothing about lines it does not know", () => {
    // Untracked files carry null counts on purpose — counting them means
    // reading every one of them on a cold cloud disk.
    expect(changeCountLabel(file("a.ts", "?", null, null))).toBe("");
    expect(changeCountLabel(file("a.ts", "M", 12, 3))).toBe("+12 −3");
    expect(changeCountLabel(file("a.ts", "A", 288, 0))).toBe("+288");
    expect(changeCountLabel(file("a.ts", "D", 0, 91))).toBe("−91");
  });

  it("turns a unified patch into numbered rows", () => {
    const rows = parseUnifiedDiff([
      "diff --git a/x b/x",
      "index 1..2 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -10,3 +10,4 @@ ctx",
      " keep",
      "-gone",
      "+added",
      "+also",
      "",
    ].join("\n"));
    const kinds = rows.map((r: { kind: string }) => r.kind);
    // No trailing blank row: a patch ends with a newline, and the empty string
    // that split leaves behind is not a line of anybody's file. It was showing
    // up as a numbered blank line at the foot of every diff.
    expect(kinds).toEqual(["hunk", "ctx", "del", "add", "add"]);
    expect(rows[1]).toMatchObject({ text: "keep", oldNo: 10, newNo: 10 });
    expect(rows[2]).toMatchObject({ text: "gone", oldNo: 11 });
    expect(rows[3]).toMatchObject({ text: "added", newNo: 11 });
    expect(rows[4]).toMatchObject({ text: "also", newNo: 12 });
  });
});

describe("the panel", () => {
  it("hides itself entirely when the host cannot answer git", async () => {
    // Every extension released before this one DROPS the three messages in
    // silence, so the adapter is simply absent rather than failing.
    const h = harness({ omitGit: true });
    h.panel.setOpen(true);
    await settle();
    expect(h.q(".gfp-changes-btn")?.hidden).toBe(true);
  });

  it("hides itself in Knowledge work, and never asks git anything", async () => {
    // The same progressive disclosure as thinking traces and tool detail. The
    // second half matters as much as the first: somebody writing prose should
    // not be paying for two git spawns after every turn.
    const h = harness({ gitEnabled: () => false });
    h.panel.setOpen(true);
    await settle();
    await settle();
    expect(h.q(".gfp-changes-btn")?.hidden).toBe(true);
    expect(h.statusCalls()).toBe(0);
  });

  it("hides itself when the project turns out not to be a repository", async () => {
    // An ordinary answer, not an error: the flag says the host UNDERSTANDS the
    // message, and the answer says whether there is anything to show.
    const h = harness({ status: async () => ({ ok: false, kind: "not-a-repo", reason: "no repo" }) });
    h.panel.setOpen(true);
    await settle();
    await settle();
    expect(h.q(".gfp-changes-btn")?.hidden).toBe(true);
  });

  it("counts uncommitted files on the button without being opened", async () => {
    const h = harness({ snapshot: snap({ files: [file("a.ts", "M"), file("b.ts", "A")] }) });
    h.panel.setOpen(true);
    await settle();
    await settle();
    expect(h.q(".gfp-changes-count")?.textContent).toBe("2");
    // Unpushed commits are named in words inside the view. A badge that added
    // two different things together would be a number nobody could act on.
    expect(h.q(".gfp-changes-btn")?.getAttribute("title")).toBe("Changes — 2 files not committed");
  });

  it("sends exactly the operation the button promised", async () => {
    const h = harness({ snapshot: snap({ ahead: 1, files: [file("src/a.ts", "M")] }) });
    await h.open();
    (h.q(".gfp-changes-message") as HTMLTextAreaElement).value = "Fix the thing";
    h.q(".gfp-changes-message")!.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();
    h.q(".gfp-changes-primary")!.click();
    await settle();
    await settle();
    expect(h.runs).toEqual([{ op: "commit", message: "Fix the thing", push: true }]);
  });

  it("asks before pushing the branch everyone builds on, and only then", async () => {
    const onDefault = harness({ snapshot: snap({ ahead: 1 }) });
    await onDefault.open();
    onDefault.q(".gfp-changes-primary")!.click();
    await settle();
    await settle();
    expect(onDefault.runs).toEqual([{ op: "push" }]);

    // A feature branch is nobody else's problem; no dialog, same one press.
    const onFeature = harness({
      snapshot: snap({ branch: "feature/x", isDefaultBranch: false, ahead: 1 }),
    });
    await onFeature.open();
    onFeature.q(".gfp-changes-primary")!.click();
    await settle();
    await settle();
    expect(onFeature.runs).toEqual([{ op: "push" }]);
  });

  it("names a new branch in the panel, not in a browser dialog", async () => {
    // window.prompt() does not exist in Electron, so the desktop app would have
    // shown nothing at all and created no branch.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    await h.open();
    h.q(".gfp-changes-move-branch")!.click();
    await settle();

    const input = h.q(".gfp-changes-branch-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    // One live primary at a time: committing is not what you are doing while
    // you are naming a branch.
    expect((h.q(".gfp-changes-primary") as HTMLButtonElement).disabled).toBe(true);

    input.value = "feature/bounded-retry";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();
    h.q(".gfp-changes-branch-create")!.click();
    await settle();
    await settle();
    expect(h.runs).toEqual([{ op: "newBranch", branch: "feature/bounded-retry" }]);
  });

  it("will not create a branch whose name cannot work", async () => {
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    await h.open();
    h.q(".gfp-changes-move-branch")!.click();
    await settle();
    const input = h.q(".gfp-changes-branch-input") as HTMLInputElement;
    const create = () => h.q(".gfp-changes-branch-create") as HTMLButtonElement;
    expect(create().disabled).toBe(true);
    input.value = "has a space";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();
    expect(create().disabled).toBe(true);
    input.value = "fine";
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();
    expect(create().disabled).toBe(false);
  });

  it("puts discard behind having looked at the diff", async () => {
    // The list has no per-row destructive control on purpose: the irreversible
    // action is reachable only from inside the file it would throw away.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    await h.open();
    expect(h.q(".gfp-changes-discard")).toBeNull();

    h.q(".gfp-change-row")!.click();
    await settle();
    await settle();
    expect(h.diffs).toEqual(["src/a.ts"]);
    expect(h.q(".gfp-changes-discard")).toBeTruthy();

    h.q(".gfp-changes-discard")!.click();
    await settle();
    await settle();
    expect(h.runs).toEqual([{ op: "revertFile", path: "src/a.ts" }]);
  });

  it("offers no discard where checkout HEAD could not keep the promise", async () => {
    // The webview carries its own copy of the host's `canRevertFile`, because
    // a webview cannot import `src/git-status.ts`. This is the test that pins
    // the two together: the four statuses refused here are exactly the four
    // that module refuses, and `test/git-status.test.ts` asserts the other
    // half.
    //
    // What the divergence cost: the panel used to offer discard for every
    // tracked row, so a staged file got a confirmed, irreversible-sounding
    // button that ran `git checkout -- <path>`, exited 0, changed nothing a
    // person could see, and reported "Restored … to the last commit."
    for (const status of ["?", "U", "A", "R"] as const) {
      const h = harness({ snapshot: snap({ files: [file("src/a.ts", status)] }) });
      await h.open();
      h.q(".gfp-change-row")!.click();
      await settle();
      await settle();
      expect(h.q(".gfp-changes-discard")).toBeNull();
    }
    // And a deletion — the discard that matters most — still offers it.
    const restorable = harness({ snapshot: snap({ files: [file("src/a.ts", "D")] }) });
    await restorable.open();
    restorable.q(".gfp-change-row")!.click();
    await settle();
    await settle();
    expect(restorable.q(".gfp-changes-discard")).toBeTruthy();
  });

  it("draws the diff in the product's own diff markup", async () => {
    // Not a second diff design: `.tool-diff-region` and `.tdl*` are chat.css's,
    // so a diff here is the same object as a diff under a tool call, on the
    // same already-theme-tuned palette.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    await h.open();
    h.q(".gfp-change-row")!.click();
    await settle();
    await settle();
    const region = h.q(".tool-diff-region");
    expect(region).toBeTruthy();
    expect(h.qq(".tdl-add").length).toBe(1);
    expect(h.qq(".tdl-del").length).toBe(1);
  });

  it("shows what git said, and a next move, when an operation fails", async () => {
    const h = harness({
      snapshot: snap({ ahead: 1 }),
      run: async () => ({
        ok: false,
        reason: "The push was rejected because the branch moved on the remote. Pull, then push again.",
        detail: "! [rejected] main -> main (fetch first)",
        snapshot: snap({ ahead: 1 }),
      }),
    });
    await h.open();
    h.q(".gfp-changes-primary")!.click();
    await settle();
    await settle();
    const notice = h.q(".gfp-changes-notice");
    expect(notice?.textContent).toContain("Pull, then push again.");
    // Both, never one: the sentence alone hides what happened, and stderr alone
    // tells a person nothing to do.
    expect(notice?.textContent).toContain("[rejected]");
  });

  it("spends the commit message once", async () => {
    // Leaving it in the box invites the same commit twice, and the second one
    // would be empty and confusing.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    await h.open();
    const box = h.q(".gfp-changes-message") as HTMLTextAreaElement;
    box.value = "Fix the thing";
    box.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();
    h.q(".gfp-changes-primary")!.click();
    await settle();
    await settle();
    expect((h.q(".gfp-changes-message") as HTMLTextAreaElement | null)?.value ?? "").toBe("");
  });

  it("goes back to the tree when the project title is pressed", async () => {
    // The way out is the same control that has always meant "show me the
    // files", so Changes does not need an exit of its own.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    await h.open();
    expect(h.q(".gfp-changes")?.hidden).toBe(false);
    h.q(".gfp-title")!.click();
    await settle();
    expect(h.q(".gfp-changes")?.hidden).toBe(true);
    expect(h.q(".gfp-changes-btn")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("leaves no file tab looking selected while the Changes list is showing", async () => {
    // One strip, one selected thing. With a file open, entering Changes used to
    // underline the Changes button AND leave the file wearing the active
    // treatment and its close — two tabs lit at once, which is what the strip
    // looks like when it is lying about where you are.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    h.panel.setOpen(true);
    await settle();
    await h.panel.openPath("notes.md");
    await settle();
    expect(h.qq(".gfp-tab-active")).toHaveLength(1);

    (h.q(".gfp-changes-btn") as HTMLElement).click();
    await settle();
    expect(h.q(".gfp-changes")?.hidden).toBe(false);
    expect(h.qq(".gfp-tab-active")).toHaveLength(0);
    expect(h.q(".gfp-changes-btn")?.classList.contains("gfp-changes-selected")).toBe(true);

    // And it comes back when the file does, so nothing was lost by hiding it.
    (h.q(".gfp-tab") as HTMLElement).click();
    await settle();
    expect(h.qq(".gfp-tab-active")).toHaveLength(1);
  });

  it("commits without pushing when the second button is used", async () => {
    // The whole point of the second button: same commit, no push. If this ever
    // sends push:true the two controls are one control wearing two labels.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M")] }) });
    await h.open();
    const box = h.q(".gfp-changes-message") as HTMLTextAreaElement;
    box.value = "Write it down";
    box.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();

    const only = h.q(".gfp-changes-commit-only") as HTMLButtonElement;
    expect(only).toBeTruthy();
    expect(only.disabled).toBe(false);
    only.click();
    await settle();
    await settle();
    expect(h.runs).toEqual([{ op: "commit", message: "Write it down", push: false }]);
  });

  it("does not offer a second commit button when the primary already only commits", async () => {
    // No remote to push to: "Commit" and "Commit without pushing" would be the
    // same press, and a choice with one outcome is not a choice.
    const h = harness({ snapshot: snap({ hasRemote: false, hasUpstream: false, files: [file("src/a.ts", "M")] }) });
    await h.open();
    expect((h.q(".gfp-changes-primary") as HTMLButtonElement).textContent).toBe("Commit");
    expect(h.q(".gfp-changes-commit-only")).toBeNull();
  });

  it("paints the two numbers in the two colours the rest of the UI uses", async () => {
    // The same +N −M appears on a tool row and on the turn's Changed N files
    // card in green and red. One grey blob here read as a different quantity.
    const h = harness({ snapshot: snap({ files: [file("src/a.ts", "M", 12, 3)] }) });
    await h.open();
    const stat = h.q(".gfp-change-stat")!;
    expect(stat.querySelector(".gfp-change-add")?.textContent).toBe("+12");
    expect(stat.querySelector(".gfp-change-del")?.textContent).toBe("−3");
  });
});

describe("the size of the whole change, not only the count of it", () => {
  it("sums every file's counts", () => {
    expect(changeTotalLabel([
      { path: "a.ts", status: "M", added: 12, deleted: 3 },
      { path: "b.ts", status: "A", added: 288, deleted: 0 },
      { path: "c.ts", status: "D", added: 0, deleted: 91 },
    ])).toBe("+300 −94");
  });

  // Untracked files carry null counts by design — counting them would mean
  // reading every one. A list of only those has nothing to total, and saying
  // "+0 −0" there would be a number the view invented.
  it("says nothing when no file carries a count", () => {
    expect(changeTotalLabel([{ path: "n.md", status: "?", added: null, deleted: null }])).toBe("");
    expect(changeTotalLabel([])).toBe("");
    expect(changeTotalLabel(undefined as never)).toBe("");
  });

  it("still totals the files that DO carry counts", () => {
    expect(changeTotalLabel([
      { path: "a.ts", status: "M", added: 4, deleted: 4 },
      { path: "n.md", status: "?", added: null, deleted: null },
    ])).toBe("+4 −4");
  });
});

describe("the second commit button, as a decision", () => {
  it("appears only when the primary would also push", () => {
    const opts = { message: "msg" };
    const withRemote = changesCommitOnlyAction(snap({ files: [file("a.ts", "M")] }), opts);
    expect(withRemote.show).toBe(true);
    expect(withRemote.label).toBe("Commit without pushing");
    expect(changesCommitOnlyAction(snap({ hasRemote: false, files: [file("a.ts", "M")] }), opts).show).toBe(false);
    expect(changesCommitOnlyAction(snap({ detached: true, branch: null, files: [file("a.ts", "M")] }), opts).show).toBe(false);
  });

  it("is absent where there is nothing to commit, and disabled without a message", () => {
    expect(changesCommitOnlyAction(snap({ ahead: 2 }), { message: "msg" }).show).toBe(false);
    expect(changesCommitOnlyAction(snap({ files: [] }), { message: "msg" }).show).toBe(false);
    expect(changesCommitOnlyAction(snap({ files: [file("a.ts", "M")] }), { message: "  " }).disabled).toBe(true);
  });

  it("refuses alongside the primary while a file is conflicted", () => {
    // The primary is disabled with "Resolve the conflicts first"; a second
    // button that still committed would be a way around that sentence.
    expect(changesCommitOnlyAction(snap({ files: [file("a.ts", "U")] }), { message: "msg" }).show).toBe(false);
  });
});
