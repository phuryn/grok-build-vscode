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
import { describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeGitFailure } from "../src/git-status";
import { bootWebview, dispatch } from "./webview-harness";
import { fileTreePanelBootSource } from "../src/desktop/file-tree-panel";
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
  pollChanges?: () => boolean;
  omitGit?: boolean;
  askAgent?: (text: string) => void;
  openSettings?: () => void;
  presentation?: "overlay" | "dock";
  write?: () => Promise<unknown>;
  list?: (scopeId: string, relPath: string) => Promise<unknown>;
} = {}) {
  const window = new Window({ url: "https://example.test/" });
  const document = window.document;
  const intervals = new Map<number, () => void>();
  const intervalDelays: number[] = [];
  let timerSeq = 0;
  if (options.pollChanges) Object.assign(window, {
    setInterval: (fn: () => void, ms: number) => {
      intervalDelays.push(ms);
      intervals.set(++timerSeq, fn);
      return timerSeq;
    },
    clearInterval: (id: number) => intervals.delete(id),
  });
  const composer = document.createElement("textarea");
  composer.value = "Keep my draft";
  document.body.appendChild(composer);
  const runs: Array<Record<string, unknown>> = [];
  const diffs: string[] = [];
  let statusCalls = 0;

  const access: Record<string, unknown> = {
    currentScope: async () => ({ id: "/work/app", label: "app", title: "/work/app" }),
    list: options.list || (async () => ({ ok: true, entries: [], truncated: false })),
    // Readable, because one test needs a FILE tab open while the Changes view
    // is on screen — the state in which two tabs used to look selected.
    read: async (_scopeId: string, relPath: string) => ({
      ok: true, kind: "text", relPath, text: "hello",
      stamp: { mtimeMs: 1, size: 5 }, absPath: "/work/app/" + relPath,
    }),
  };
  if (options.write) access.write = options.write;
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
    mount: { panelHost: document.body, toggleHost: document.body, presentation: options.presentation || "overlay" },
    ui: {
      confirm: async (request: { actions?: Array<{ id: string }> }) =>
        (request.actions && request.actions[0] ? request.actions[0].id : "cancel"),
      renderMarkdown: (source: string) => `<p>${source}</p>`,
      askAgent: options.askAgent,
      openSettings: options.openSettings,
    },
    gitEnabled: options.gitEnabled,
    pollChanges: options.pollChanges,
  });

  const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
  const qq = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[];

  return {
    window, document, panel, runs, diffs, q, qq, composer,
    intervals, intervalDelays,
    async tick() {
      for (const fn of [...intervals.values()]) fn();
      await settle();
    },
    statusCalls: () => statusCalls,
    async open() {
      panel.setOpen(true);
      await settle();
      (q(".gfp-title") as HTMLElement).click();
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
  it("keeps the one refresh in the tree filter, absent from every Changes subview", async () => {
    const h = harness({ snapshot: snap({ files: [file("a.ts", "M")] }) });
    h.panel.setOpen(true);
    await settle();
    const refresh = h.q(".gfp-filter-row > .gfp-refresh")!;
    expect(refresh.hidden).toBe(false);
    await h.open();
    expect(h.q(".gfp-changes .gfp-refresh")).toBeNull();
    expect(h.q(".gfp-header .gfp-refresh")).toBeNull();
    expect(refresh.hidden).toBe(true);
    expect(h.qq(".gfp-refresh")).toHaveLength(1);
    h.q('.gfp-change-row[data-path="a.ts"]')!.click();
    await settle();
    expect(h.q(".gfp-changes .gfp-refresh")).toBeNull();
    h.q(".gfp-title")!.click();
    await settle();
    expect(h.q(".gfp-filter-row > .gfp-refresh")).toBe(refresh);
    expect(refresh.hidden).toBe(false);
    h.panel.destroy();
  });

  it.each([true, false])("re-reads git status exactly once after a successful editor save (ok=%s)", async (ok) => {
    let saved = false;
    const h = harness({
      status: async () => ({ ok: true, snapshot: snap({ files: saved ? [file("a.ts", "M")] : [] }) }),
      write: async () => {
        saved = ok;
        return ok ? { ok: true, stamp: { mtimeMs: 2, size: 6 } } : { ok: false, reason: "Save refused." };
      },
    });
    await h.open();
    await h.panel.openPath("a.ts");
    await settle();
    h.q(".gfp-edit")!.click();
    await settle();
    const editor = h.q(".gfp-editor") as HTMLTextAreaElement;
    editor.value = "edited";
    editor.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    const before = h.statusCalls();
    h.qq(".gfp-action").find((el) => el.textContent === "Save")!.click();
    await settle();
    await settle();
    expect(h.statusCalls()).toBe(before + (ok ? 1 : 0));
    expect(h.q(".gfp-changes-notice")).toBeNull();
    expect(h.q(".gfp-header .gfp-busy")).toBeNull();
    if (ok) expect(h.q(".gfp-toggle-count")?.textContent).toBe("1");
    h.panel.destroy();
  });

  it("re-reads what is on screen and leaves the commit message alone", async () => {
    // A connection ended and a new one is up. The list is stale and has to be
    // asked for again; the sentence somebody was part way through typing into
    // the commit box is not stale at all, and replacing it would take their
    // words away to fix a network problem they did not cause.
    const h = harness({ snapshot: snap({ files: [file("a.ts", "M")] }) });
    await h.open();
    const box = h.q(".gfp-changes-message") as HTMLTextAreaElement;
    expect(box, "no commit message box").toBeTruthy();
    box.value = "Fix the thing";
    box.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();
    const before = h.statusCalls();
    await h.panel.refreshDisplayed();
    await settle();
    await settle();
    expect(h.statusCalls(), "the list was not re-read").toBeGreaterThan(before);
    expect((h.q(".gfp-changes-message") as HTMLTextAreaElement).value).toBe("Fix the thing");
    h.panel.destroy();
  });

  it("does not re-read a file somebody has typed into", async () => {
    // Reload replaces a tab wholesale with the host's version. Doing that to a
    // dirty tab as part of a recovery would be the same theft as above, and
    // quieter: the words vanish and nothing says why.
    const h = harness({ write: async () => ({ ok: true, stamp: { mtimeMs: 2, size: 8 } }) });
    await h.open();
    await h.panel.openPath("a.ts");
    await settle();
    h.q(".gfp-edit")!.click();
    await settle();
    const editor = h.q(".gfp-editor") as HTMLTextAreaElement;
    editor.value = "my words";
    editor.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    await settle();
    await h.panel.refreshDisplayed();
    await settle();
    await settle();
    // The host's version of this file is "hello". Seeing it here would mean the
    // recovery had overwritten the draft.
    expect((h.q(".gfp-editor") as HTMLTextAreaElement).value).toBe("my words");
    h.panel.destroy();
  });

  it("labels exactly one section: uncommitted files win over unpushed commits", async () => {
    for (const dirty of [true, false]) {
      const h = harness({ snapshot: snap({
        files: dirty ? [file("a.ts", "M"), file("b.ts", "A")] : [],
        ahead: 12, unpushedTruncated: true,
        unpushed: [{ sha: "abc123", subject: "Saved work" }],
      }) });
      await h.open();
      expect(h.qq(".gfp-changes-section")).toHaveLength(1);
      const section = h.q(".gfp-changes-section")!;
      expect(section.textContent).toBe(dirty ? "Not committed" : "Not pushed");
      expect(section.nextElementSibling?.className).toBe(dirty ? "gfp-changes-list" : "gfp-changes-commits");
      expect(h.qq(dirty ? ".gfp-changes-commits" : ".gfp-changes-list")).toHaveLength(0);
    }
  });

  it("hides itself entirely when the host cannot answer git", async () => {
    // Every extension released before this one DROPS the three messages in
    // silence, so the adapter is simply absent rather than failing.
    const h = harness({ omitGit: true });
    h.panel.setOpen(true);
    await settle();
    expect(h.q(".gfp-changes-btn")?.hidden).toBe(true);
  });

  it("hides itself when the embedder disables git, and never asks git anything", async () => {
    // Not a purpose gate — the chat mount stopped passing one, because people
    // clone repositories in Knowledge work too and the panel can read the real
    // answer off git. This is the embedder saying this mount has no business
    // showing git at all, and then it must not pay for a spawn either.
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

  it("repeats the count on the panel toggle, and marks the changed file and every folder above it", async () => {
    const dirs: Record<string, unknown[]> = {
      "": [{ name: "src", kind: "dir", relPath: "src" }, { name: "README.md", kind: "file", relPath: "README.md" }],
      src: [{ name: "lib", kind: "dir", relPath: "src/lib" }, { name: "b.ts", kind: "file", relPath: "src/b.ts" }],
      "src/lib": [{ name: "a.ts", kind: "file", relPath: "src/lib/a.ts" }],
    };
    const h = harness({
      snapshot: snap({ files: [file("src/lib/a.ts", "M")] }),
      list: async (_scopeId: string, relPath: string) => ({ ok: true, entries: dirs[relPath] || [], truncated: false }),
    });
    h.panel.setOpen(true);
    await settle();
    await settle();
    // The same number as the Changes button, readable while the panel is closed.
    expect(h.q(".gfp-toggle-count")?.hidden).toBe(false);
    expect(h.q(".gfp-toggle-count")?.textContent).toBe("1");

    const changed = (rel: string) =>
      h.document.querySelector(`.gfp-node[data-rel="${rel}"]`)!.classList.contains("gfp-node-changed");
    // A closed folder that hides a change says so; a clean file does not.
    expect(changed("src")).toBe(true);
    expect(changed("README.md")).toBe(false);
    // Rows revealed later are painted from the same snapshot.
    (h.document.querySelector('.gfp-node[data-rel="src"] > .gfp-row') as HTMLElement).click();
    await settle();
    await settle();
    expect(changed("src/lib")).toBe(true);
    expect(changed("src/b.ts")).toBe(false);
    (h.document.querySelector('.gfp-node[data-rel="src/lib"] > .gfp-row') as HTMLElement).click();
    await settle();
    await settle();
    expect(changed("src/lib/a.ts")).toBe(true);
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

  it("names an untracked file the way the turn card does: A, once", async () => {
    // The panel used to print "+" in the badge and the word "new" at the other
    // end of the same row — two vocabularies for one fact, on the two surfaces
    // a person compares side by side. The card already said A.
    const h = harness({ snapshot: snap({ files: [file("src/deep/a.ts", "?", null, null)] }) });
    await h.open();
    const row = h.q(".gfp-change-row")!;
    expect(row.querySelector(".gfp-change-badge")!.textContent).toBe("A");
    expect(row.querySelector(".gfp-change-stat")).toBeNull();
    expect(row.textContent).not.toContain("new");
    expect(row.title).toBe("Added — src/deep/a.ts");
    // Filename first, path second — the order the turn card now uses too.
    const parts = [...row.querySelector(".gfp-change-name")!.children].map((el) => el.className);
    expect(parts).toEqual(["gfp-change-base", "gfp-change-dir"]);
    expect(row.querySelector(".gfp-change-base")!.textContent).toBe("a.ts");
    expect(row.querySelector(".gfp-change-dir")!.textContent).toBe("src/deep");
  });

  it("gives the filename no share of the shortfall, on both surfaces", () => {
    // The bug this pins: a 9999:1 shrink factor does NOT build a priority
    // ladder. Flex shrinking is proportional and SIMULTANEOUS, so the filename
    // kept about 0.013% of every shortfall -- one 1/64px layout unit of which
    // is enough for `text-overflow` to drop real characters, while the path
    // beside it was still a hundred pixels wide. Measured in Chromium at
    // 388px: the name's box came out 220.125 against a content width of
    // 220.1406, and rendered "testfilewithalongname." plus an ellipsis.
    //
    // Only an INFLEXIBLE name gives the path absolute priority, so the shrink
    // factor is the thing to guard. A source assertion rather than a layout
    // one because happy-dom does not lay out; the width sweep that proved it
    // runs in Chromium.
    const read = (name: string) => readFileSync(
      fileURLToPath(new URL(`../media/${name}`, import.meta.url)), "utf8",
    );
    const block = (css: string, selector: string) => {
      const at = css.indexOf(selector + " {");
      expect(at, `${selector} is gone`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    for (const [sheet, nameSel, dirSel] of [
      ["file-panel.css", ".gfp-change-base", ".gfp-change-dir"],
      ["chat.css", ".turn-diff-file-name", ".turn-diff-file-dir"],
    ] as const) {
      const css = read(sheet);
      const nameRule = block(css, nameSel);
      expect(nameRule, `${sheet} ${nameSel} must not shrink`).toMatch(/flex:\s*0\s+0\s+auto/);
      // It still has to ellipsize in the one case where it alone cannot fit.
      expect(nameRule).toMatch(/max-width:/);
      expect(nameRule).toMatch(/text-overflow:\s*ellipsis/);
      // And the path is then the only thing left that can absorb the shortfall,
      // so it needs an ordinary factor and a floor of zero -- not a magic one.
      const dirRule = block(css, dirSel);
      expect(dirRule).toMatch(/flex:\s*0\s+1\s+auto/);
      expect(dirRule).toMatch(/min-width:\s*0/);
    }
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
    expect(withRemote.label).toBe("Commit");
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

const pullMessage = "Pull the latest changes for this branch from the remote, resolve any conflicts, and tell me what changed.";
const githubReason = "Push needs GitHub. Connect it in Settings.";
const rejectedReason = "The remote has commits you do not have. Pull before pushing.";
const githubDetail = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
const rejectedDetail = "! [rejected] main -> main (fetch first)";

async function typeCommit(h: ReturnType<typeof harness>, text = "Save the work") {
  const box = h.q(".gfp-changes-message") as HTMLTextAreaElement;
  box.value = text;
  box.dispatchEvent(new h.window.Event("input", { bubbles: true }));
  await settle();
}

async function runPrimary(h: ReturnType<typeof harness>) {
  h.q(".gfp-changes-primary")!.click();
  await settle();
  await settle();
}

describe("GitHub disconnected, GitHub remote", () => {
  it.each(["overlay", "dock"] as const)("keeps the commit after push fails and opens Settings (%s)", async (presentation) => {
    let current = snap({ files: [file("a.ts", "M")] });
    const openSettings = vi.fn(() => expect(h.panel.isOpen()).toBe(presentation === "dock"));
    const h = harness({
      presentation, openSettings,
      status: async () => ({ ok: true, snapshot: current }),
      run: async () => {
        current = snap({ ahead: 1 });
        return { ok: false, snapshot: current, reason: githubReason, detail: githubDetail };
      },
    });
    await h.open();
    await typeCommit(h);
    await runPrimary(h);
    expect(h.runs).toEqual([{ op: "commit", message: "Save the work", push: true }]);
    expect(h.q(".gfp-changes-headline")?.textContent).toBe("1 commit saved here but not pushed");
    expect(h.q(".gfp-changes-primary")?.textContent).toBe("Push 1 commit");
    expect(h.q(".gfp-changes-notice-text")?.textContent).toBe(githubReason);
    expect(h.q(".gfp-changes-notice-detail")?.textContent).toBe(githubDetail);
    expect(h.q(".gfp-changes-notice-action")?.textContent).toBe("Connect GitHub");
    h.q(".gfp-changes-notice-action")!.click();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(h.runs).toHaveLength(1);
    expect(h.composer.value).toBe("Keep my draft");
    // Reveal the internal draft again: absence of a textarea after committing
    // alone would not prove the spent message had actually been cleared.
    current = snap({ ahead: 1, files: [file("next.ts", "M")] });
    await h.open();
    expect((h.q(".gfp-changes-message") as HTMLTextAreaElement).value).toBe("");
    h.panel.destroy();
  });

  it("commits locally without needing GitHub when Commit is chosen", async () => {
    const openSettings = vi.fn();
    const h = harness({
      snapshot: snap({ files: [file("a.ts", "M")] }), openSettings,
      run: async () => ({ ok: true, snapshot: snap({ ahead: 1 }) }),
    });
    await h.open();
    await typeCommit(h);
    const only = h.q(".gfp-changes-commit-only")!;
    expect(only.textContent).toBe("Commit");
    expect(only.parentElement?.classList.contains("gfp-changes-action-row")).toBe(true);
    expect(only.nextElementSibling).toBe(h.q(".gfp-changes-primary"));
    expect(h.q(".gfp-changes-hint")?.nextElementSibling).toBe(h.q(".gfp-changes-message"));
    only.click();
    await settle();
    expect(h.runs).toEqual([{ op: "commit", message: "Save the work", push: false }]);
    expect(h.q(".gfp-changes")?.textContent).not.toContain("GitHub");
    expect(openSettings).not.toHaveBeenCalled();
    h.panel.destroy();
  });

  it("retains an unspent message when the commit itself fails", async () => {
    const current = snap({ files: [file("a.ts", "M")] });
    const h = harness({ snapshot: current,
      run: async () => ({ ok: false, snapshot: current, reason: "A git hook refused this commit." }),
    });
    await h.open();
    await typeCommit(h);
    await runPrimary(h);
    expect((h.q(".gfp-changes-message") as HTMLTextAreaElement).value).toBe("Save the work");
    expect(h.q(".gfp-changes-notice-action")).toBeNull();
    h.panel.destroy();
  });
});

describe("Project without GitHub", () => {
  it("offers one local Commit and explains the missing remote without push wording", async () => {
    const h = harness({
      snapshot: snap({ hasRemote: false, hasUpstream: false, files: [file("a.ts", "M")] }),
      askAgent: vi.fn(), openSettings: vi.fn(),
    });
    await h.open();
    expect(h.q(".gfp-changes-btn")?.hidden).toBe(false);
    expect(h.panel.canShowChanges()).toBe(true);
    expect(h.q(".gfp-changes-primary")?.textContent).toBe("Commit");
    expect(h.q(".gfp-changes-commit-only")).toBeNull();
    expect(h.q(".gfp-changes-action-row")?.children).toHaveLength(1);
    expect(h.q(".gfp-changes-hint")?.textContent).toContain("no remote");
    expect(h.q(".gfp-changes-ask-pull")).toBeNull();
    expect(h.q(".gfp-changes")?.textContent).not.toMatch(/push/i);
    await typeCommit(h);
    await runPrimary(h);
    expect(h.runs).toEqual([{ op: "commit", message: "Save the work", push: false }]);
    h.panel.destroy();
  });

  it("names gitlab.com without offering the GitHub connection", async () => {
    const detail = "fatal: Authentication failed for 'https://gitlab.com/team/app.git/'";
    const h = harness({ snapshot: snap({ ahead: 1 }), openSettings: vi.fn(),
      run: async () => ({ ok: false, reason: describeGitFailure("push", detail), detail, snapshot: snap({ ahead: 1 }) }),
    });
    await h.open();
    await runPrimary(h);
    expect(h.q(".gfp-changes-notice-text")?.textContent).toBe("Git could not sign in to gitlab.com.");
    expect(h.q(".gfp-changes-notice-detail")?.textContent).toBe(detail);
    expect(h.q(".gfp-changes-notice-action")).toBeNull();
    h.panel.destroy();
  });
});

describe("Origin conflict", () => {
  it("explains a non-fast-forward after the commit succeeds and keeps the local save visible", async () => {
    const detail = "To https://example.test/team/app.git\n ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs";
    const h = harness({ snapshot: snap({ files: [file("a.ts", "M")] }),
      run: async () => ({ ok: false, snapshot: snap({ ahead: 1 }),
        reason: describeGitFailure("commit", detail, "push"), detail }),
    });
    await h.open();
    await typeCommit(h);
    await runPrimary(h);
    expect(h.q(".gfp-changes-headline")?.textContent).toBe("1 commit saved here but not pushed");
    expect(h.q(".gfp-changes-notice-text")?.textContent).toBe(rejectedReason);
    expect(h.q(".gfp-changes-notice-detail")?.textContent).toBe(detail);
    h.panel.destroy();
  });
  it.each(["overlay", "dock"] as const)("offers the exact pull draft in the notice and branch line (%s)", async (presentation) => {
    const askAgent = vi.fn(() => expect(h.panel.isOpen()).toBe(presentation === "dock"));
    const h = harness({ presentation, askAgent, snapshot: snap({ ahead: 1 }),
      run: async () => ({ ok: false, reason: describeGitFailure("push", rejectedDetail), detail: rejectedDetail, snapshot: snap({ ahead: 1 }) }),
    });
    await h.open();
    expect(h.q(".gfp-changes-ask-pull")?.textContent).toBe("Ask agent to pull");
    expect(h.q(".gfp-changes-ask-pull")?.title).toBe("Puts a pull request for this branch into the message box");
    await runPrimary(h);
    expect(h.q(".gfp-changes-notice-text")?.textContent).toBe(rejectedReason);
    expect(h.q(".gfp-changes-notice-detail")?.textContent).toBe(rejectedDetail);
    expect(h.q(".gfp-changes-notice-action")?.textContent).toBe("Ask the agent to pull");
    h.q(".gfp-changes-notice-action")!.click();
    expect(askAgent).toHaveBeenNthCalledWith(1, pullMessage);
    await h.open();
    h.q(".gfp-changes-ask-pull")!.click();
    expect(askAgent).toHaveBeenNthCalledWith(2, pullMessage);
    expect(h.runs).toEqual([{ op: "push" }]);
    expect(h.composer.value).toBe("Keep my draft");
    h.panel.destroy();
  });

  it.each([githubReason, rejectedReason])("offers no actions when the mount supplies no hooks: %s", async (reason) => {
    const h = harness({ snapshot: snap({ ahead: 1 }), run: async () => ({ ok: false, reason }) });
    await h.open();
    await runPrimary(h);
    expect(h.q(".gfp-changes-notice-action")).toBeNull();
    expect(h.q(".gfp-changes-ask-pull")).toBeNull();
    h.panel.destroy();
  });

  it.each([{ detached: true }, { branch: null }])("offers no branch pull without a usable branch: %s", async (fields) => {
    const askAgent = vi.fn();
    const h = harness({ snapshot: snap(fields), askAgent });
    await h.open();
    expect(h.q(".gfp-changes-ask-pull")).toBeNull();
    expect(askAgent).not.toHaveBeenCalled();
    h.panel.destroy();
  });
});

describe("bounded rendering with the complete change list", () => {
  it("caps rows while counting and retaining every path in a large untracked tree", async () => {
    const files = Array.from({ length: 1205 }, (_, i) => file(`docs/file-${i}.md`, "?", null, null));
    const snapshot = snap({ files });
    const h = harness({ snapshot });
    await h.open();
    expect(h.qq(".gfp-change-row")).toHaveLength(200);
    expect(h.q(".gfp-changes-more")?.textContent).toBe("and 1005 more");
    expect(h.q(".gfp-changes-headline")?.textContent).toBe("1205 files not committed");
    expect(h.q(".gfp-changes-btn")?.title).toContain("1205 files not committed");
    expect(h.panel._scopes.get("/work/app").changes.snapshot.files).toBe(files);
    expect(files).toHaveLength(1205);
    h.q(".gfp-change-row")!.click();
    await settle();
    expect(h.diffs).toEqual(["docs/file-0.md"]);
    h.panel.destroy();
  });

  it.each([0, 1, 200])("does not invent a remainder for %i files", async (count) => {
    const h = harness({ snapshot: snap({ files: Array.from({ length: count }, (_, i) => file(`${i}.ts`, "M")) }) });
    await h.open();
    expect(h.qq(".gfp-change-row")).toHaveLength(count);
    expect(h.q(".gfp-changes-more")).toBeNull();
    h.panel.destroy();
  });
});

describe("remote Changes polling", () => {
  it("keeps the branch draft and its selection without re-enabling Commit while naming", async () => {
    const h = harness({ pollChanges: () => true, snapshot: snap({ files: [file("a.ts", "M")] }) });
    await h.open();
    h.q(".gfp-changes-move-branch")!.click();
    await typeCommit(h);
    expect((h.q(".gfp-changes-primary") as HTMLButtonElement).disabled).toBe(true);
    expect((h.q(".gfp-changes-commit-only") as HTMLButtonElement).disabled).toBe(true);
    const branch = h.q(".gfp-changes-branch-input") as HTMLInputElement;
    branch.value = "feature/cloud";
    branch.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    branch.focus();
    branch.setSelectionRange(8, 13);
    await h.tick();
    const next = h.q(".gfp-changes-branch-input") as HTMLInputElement;
    expect(next.value).toBe("feature/cloud");
    expect([next.selectionStart, next.selectionEnd]).toEqual([8, 13]);
    expect(h.document.activeElement).toBe(next);
    h.panel.destroy();
  });

  it("runs every 30s only while the view and document are visible, including a diff", async () => {
    const h = harness({ pollChanges: () => true, snapshot: snap({ files: [file("a.ts", "M")] }) });
    await settle();
    expect(h.intervals.size).toBe(0);
    await h.open();
    expect(h.intervalDelays).toEqual([30000]);
    let before = h.statusCalls();
    await h.tick();
    expect(h.statusCalls()).toBe(before + 1);
    h.q(".gfp-change-row")!.click();
    await settle();
    before = h.statusCalls();
    await h.tick();
    expect(h.statusCalls()).toBe(before + 1);

    // Clearing the timer AND checking inside its callback protect against a
    // tick already queued before a visibility event was delivered.
    const queued = [...h.intervals.values()][0];
    Object.defineProperty(h.document, "visibilityState", { configurable: true, value: "hidden" });
    h.document.dispatchEvent(new h.window.Event("visibilitychange"));
    expect(h.intervals.size).toBe(0);
    before = h.statusCalls();
    queued();
    await h.tick();
    expect(h.statusCalls()).toBe(before);
    Object.defineProperty(h.document, "visibilityState", { configurable: true, value: "visible" });
    h.document.dispatchEvent(new h.window.Event("visibilitychange"));
    await settle();
    expect(h.statusCalls()).toBe(before + 1); // fresh on return, not 30s later
    expect(h.intervals.size).toBe(1);

    h.panel.setOpen(false);
    expect(h.intervals.size).toBe(0);
    before = h.statusCalls();
    queued();
    await h.tick();
    expect(h.statusCalls()).toBe(before);
    h.panel.setOpen(true);
    await settle();
    expect(h.statusCalls()).toBe(before + 1);
    h.q(".gfp-title")!.click();
    expect(h.intervals.size).toBe(0);
    before = h.statusCalls();
    await h.tick();
    expect(h.statusCalls()).toBe(before);
    h.panel.destroy();
  });

  it("stops on a file tab, scope change, loss of availability and destruction", async () => {
    let enabled = true;
    const h = harness({ pollChanges: () => true, gitEnabled: () => enabled });
    await h.open();
    await h.panel.openPath("notes.md");
    expect(h.intervals.size).toBe(0);
    await h.open();
    enabled = false;
    h.panel.refreshChangesAvailability();
    expect(h.intervals.size).toBe(0);
    enabled = true;
    h.panel.refreshChangesAvailability();
    expect(h.intervals.size).toBe(1);
    await h.panel.setScope({ id: "/work/other", label: "other" });
    expect(h.intervals.size).toBe(0);
    await h.open();
    const queued = [...h.intervals.values()][0];
    h.panel.destroy();
    expect(h.intervals.size).toBe(0);
    const before = h.statusCalls();
    queued();
    await settle();
    expect(h.statusCalls()).toBe(before);
  });

  it("does not opt a desktop mount into polling", async () => {
    const h = harness();
    const interval = vi.spyOn(h.window, "setInterval");
    await h.open();
    expect(interval).not.toHaveBeenCalled();
    h.panel.destroy();
  });

  it("preserves message text, focus, backward selection and scroll through a delayed poll", async () => {
    let finish: (result: unknown) => void = () => {};
    let delayed = false;
    const snapshot = snap({ files: [file("a.ts", "M")] });
    const h = harness({ pollChanges: () => true, status: async () => delayed
      ? new Promise((resolve) => { finish = resolve; }) : { ok: true, snapshot } });
    await h.open();
    delayed = true;
    await h.tick();
    const before = h.statusCalls();
    await h.tick();
    expect(h.statusCalls()).toBe(before); // no overlapping reads
    await typeCommit(h, "Keep this draft\nand this line");
    const box = h.q(".gfp-changes-message") as HTMLTextAreaElement;
    box.focus();
    box.setSelectionRange(5, 14, "backward");
    box.scrollTop = 12;
    finish({ ok: true, snapshot: snap({ files: [file("a.ts", "M"), file("b.ts", "?")] }) });
    await settle();
    const next = h.q(".gfp-changes-message") as HTMLTextAreaElement;
    expect(next).not.toBe(box);
    expect(next.value).toBe("Keep this draft\nand this line");
    expect([next.selectionStart, next.selectionEnd, next.selectionDirection, next.scrollTop]).toEqual([5, 14, "backward", 12]);
    expect(h.document.activeElement).toBe(next);
    expect(h.q(".gfp-changes-headline")?.textContent).toContain("2 files");
    expect(h.q(".gfp-changes-hint")?.nextElementSibling).toBe(next);
    h.panel.destroy();
  });

  it.each(["failed", "not-a-repo", "no-git", "throw"])("keeps good data and retries after a quiet %s failure", async (kind) => {
    let failing = false;
    const snapshot = snap({ files: [file("a.ts", "M")] });
    const h = harness({ pollChanges: () => true, status: async () => {
      if (failing && kind === "throw") throw new Error("Offline");
      return failing ? { ok: false, kind, reason: "Offline" } : { ok: true, snapshot };
    } });
    await h.open();
    await typeCommit(h);
    const html = h.q(".gfp-changes")!.innerHTML;
    failing = true;
    await h.tick();
    expect(h.q(".gfp-changes")!.innerHTML).toBe(html);
    expect(h.panel.canShowChanges()).toBe(true);
    expect(h.panel._scopes.get("/work/app").changes.errorKind).toBe("");
    const before = h.statusCalls();
    failing = false;
    await h.tick();
    expect(h.statusCalls()).toBe(before + 1);
    h.panel.destroy();
  });

  it("pauses for a long write and rejects a poll that arrives after the committed snapshot", async () => {
    let finishRead: (result: unknown) => void = () => {};
    let finishWrite: (result: unknown) => void = () => {};
    let delayed = false;
    const old = snap({ files: [file("a.ts", "M")] });
    const h = harness({ pollChanges: () => true,
      status: async () => delayed ? new Promise((resolve) => { finishRead = resolve; }) : { ok: true, snapshot: old },
      run: async () => new Promise((resolve) => { finishWrite = resolve; }),
    });
    await h.open();
    delayed = true;
    const queued = [...h.intervals.values()][0];
    await h.tick();
    await typeCommit(h);
    await runPrimary(h);
    expect(h.intervals.size).toBe(0);
    const before = h.statusCalls();
    for (let i = 0; i < 6; i++) { queued(); await h.tick(); }
    expect(h.statusCalls()).toBe(before);
    finishWrite({ ok: true, snapshot: snap() });
    await settle();
    finishRead({ ok: true, snapshot: old });
    await settle();
    expect(h.q(".gfp-changes-headline")?.textContent).toBe("Everything is committed and pushed");
    expect(h.intervals.size).toBe(1);
    delayed = false;
    await h.tick();
    expect(h.statusCalls()).toBe(before + 1);
    h.panel.destroy();
  });
});

describe("late git availability and existing turn cards", () => {
  it.each(["not-a-repo", "no-git"])("hides every existing Open Changes link after %s resolves", async (kind) => {
    const h = bootWebview({ remote: true });
    const style = h.doc.createElement("style");
    style.textContent = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");
    h.doc.head.appendChild(style);
    dispatch(h.window, { type: "initialState", cwd: "/work/app", appPurpose: "coding",
      capabilities: { browseProjectFiles: true, gitChanges: true } });
    await settle();
    dispatch(h.window, { type: "agentStart" });
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "edit", kind: "edit", title: "Edit a.ts" } });
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "edit", content: [
      { type: "diff", path: "a.ts", oldText: "x", newText: "y" },
    ] } });
    dispatch(h.window, { type: "agentEnd" });
    (h.doc.querySelector(".turn-diff-summary-header") as HTMLElement).click();
    const link = h.doc.querySelector(".turn-diff-open-changes") as HTMLElement;
    expect(link).toBeTruthy();
    expect(h.window.getComputedStyle(link).display).not.toBe("none");
    const request = h.posted.find((msg) => msg.type === "gitStatus")!;
    dispatch(h.window, { ...request, type: "gitStatusResult", ok: false, kind, reason: "No repository" });
    await settle();
    expect((h.doc.querySelector(".gfp-changes-btn") as HTMLElement).hidden).toBe(true);
    // happy-dom caches a failed ancestor selector on the descendant. Changing
    // a harmless attribute invalidates that cache before reading live CSS.
    link.setAttribute("data-style-read", "unavailable");
    expect(h.window.getComputedStyle(link).display).toBe("none");
    expect(link.isConnected).toBe(true); // no disappearing-on-click workaround
    dispatch(h.window, { type: "repos", selectedCwd: "/work/repo", activeCwd: "/work/repo", entries: [
      { cwd: "/work/repo", label: "repo", available: true, pinned: false, updatedAt: 2 },
    ] });
    await settle();
    expect(h.doc.body.classList.contains("changes-unavailable")).toBe(false);
    const next = h.posted.filter((msg) => msg.type === "gitStatus").at(-1)!;
    dispatch(h.window, { ...next, type: "gitStatusResult", ok: true, snapshot: snap() });
    await settle();
    expect(link.isConnected).toBe(true);
    expect(h.doc.body.classList.contains("changes-unavailable")).toBe(false);
    link.setAttribute("data-style-read", "available");
    expect(h.window.getComputedStyle(link).display).not.toBe("none");
    await h.window.happyDOM.abort();
  });

  // People clone repositories in Knowledge work too. The mount used to gate
  // Changes on the app purpose, which is a PROXY for "is there a repo here"
  // sitting in front of git's own answer — and the worse of the two, because
  // it is wrong about a repository somebody is writing prose in.
  it("offers Changes in Knowledge work when git says there is a repository", async () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "initialState", cwd: "/work/notes", appPurpose: "knowledge",
      capabilities: { browseProjectFiles: true, gitChanges: true } });
    await settle();
    const request = h.posted.find((msg) => msg.type === "gitStatus")!;
    dispatch(h.window, { ...request, type: "gitStatusResult", ok: true, snapshot: snap() });
    await settle();
    expect((h.doc.querySelector(".gfp-changes-btn") as HTMLElement).hidden).toBe(false);
    expect(h.doc.body.classList.contains("changes-unavailable")).toBe(false);

    // The turn-summary card is the half that STAYS Coding-only, and it stays
    // so for free: it hangs off turnDiffSummaryEnabled(), not this gate. The
    // card is BUILT and then hidden by a body class, so completed turns keep
    // their cards when the purpose changes back — assert the mechanism, not
    // the absence of a node.
    dispatch(h.window, { type: "agentStart" });
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "e", kind: "edit", title: "Edit a.ts" } });
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "e", content: [
      { type: "diff", path: "a.ts", oldText: "x", newText: "y" },
    ] } });
    dispatch(h.window, { type: "agentEnd" });
    await settle();
    expect(h.doc.body.classList.contains("hide-turn-diff-summary")).toBe(true);
    await h.window.happyDOM.abort();
  });

  // A plain folder is still a plain folder. The evidence decides, not the mode.
  it("still withholds Changes in Knowledge work when there is no repository", async () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "initialState", cwd: "/work/notes", appPurpose: "knowledge",
      capabilities: { browseProjectFiles: true, gitChanges: true } });
    await settle();
    const request = h.posted.find((msg) => msg.type === "gitStatus")!;
    dispatch(h.window, { ...request, type: "gitStatusResult", ok: false, kind: "not-a-repo",
      reason: "No repository" });
    await settle();
    expect((h.doc.querySelector(".gfp-changes-btn") as HTMLElement).hidden).toBe(true);
    await h.window.happyDOM.abort();
  });

  /**
   * Neither mount may reintroduce a purpose gate — and this is asserted on the
   * SOURCE deliberately.
   *
   * The two tests above drive the webview mount. The desktop app mounts the
   * same component from a generated bootstrap script, and the first attempt at
   * this change removed the gate from the webview and left the desktop one in
   * place — with a comment above it still claiming the two agreed. Everything
   * passed: the DOM tests exercise the mount that was fixed, and no test of a
   * component's option can see which embedders pass it.
   *
   * So the assertion has to be about the pair, not about the button. It reads
   * as crude and it is exactly load-bearing: it fails the moment a gate comes
   * back on one surface only, which is the failure this replaces.
   */
  it("keeps both mounts free of an app-purpose gate on Changes", () => {
    const deskBoot = fileTreePanelBootSource();
    const chatJs = readFileSync(new URL("../media/chat.js", import.meta.url), "utf8");

    // The desktop bootstrap must not pass the option at all. Absent means the
    // panel decides on git's answer, which is what both mounts now do.
    expect(deskBoot).not.toMatch(/gitEnabled\s*:/);

    // And the window hook that carried the purpose across to it is gone, so a
    // future bootstrap cannot quietly pick it back up.
    expect(deskBoot).not.toContain("__grokCodingPurpose");
    expect(chatJs).not.toContain("__grokCodingPurpose");
  });
});

describe("Changes actions in the chat mounts", () => {
  it.each(["remote", "desktop"])("appends a pull draft without sending and opens GitHub Settings on %s", async (surface) => {
    const remote = surface === "remote";
    const current = snap({ ahead: 1 });
    const failure = { ok: false, snapshot: current, reason: githubReason, detail: githubDetail };
    const gitRun = vi.fn(async () => failure);
    const historyAccess = vi.fn();
    const h = bootWebview({ remote, beforeScripts: (window) => {
      const original = window.history;
      Object.defineProperty(window, "history", {
        configurable: true,
        get: () => { historyAccess("read"); return original; },
        set: () => { historyAccess("write"); },
      });
    }, postMessage: (msg) => {
      const responses: Record<string, Record<string, unknown>> = {
        listProjectDir: { type: "projectDirListing", ok: true, entries: [], truncated: false },
        gitStatus: { type: "gitStatusResult", ok: true, snapshot: current },
        gitRun: { type: "gitRunResult", ...failure },
      };
      const reply = responses[msg.type];
      if (reply) queueMicrotask(() => dispatch(h.window, { ...msg, ...reply }));
    } });
    const layers = (h.window as any).afkpilotLayers;
    const depths: number[] = [];
    h.window.addEventListener("afkpilot-layers", () => depths.push(layers.depth));
    dispatch(h.window, { type: "initialState", cwd: "/work/app", appPurpose: "coding",
      capabilities: { browseProjectFiles: remote, gitChanges: true },
    });
    dispatch(h.window, { type: "githubState", github: { connected: false, cliPresent: true } });
    if (!remote) {
      Object.assign(h.window, { grokDesktopFileTree: {
        root: async () => ({ root: "/work/app", name: "app" }),
        onRootChanged: () => () => {},
        list: async () => ({ ok: true, entries: [], truncated: false }),
        gitStatus: async () => ({ ok: true, snapshot: current }),
        gitRun,
      } });
      h.window.eval(fileTreePanelBootSource());
    }
    await settle();
    const q = (selector: string) => h.doc.querySelector(selector) as HTMLElement;
    const toggle = q(".gfp-toggle");
    toggle.click();
    await settle();
    if (remote) expect(depths).toEqual([1]);
    q(".gfp-changes-btn").click();
    await settle();
    const input = q("#input") as HTMLTextAreaElement;
    input.value = "Please keep my draft.";
    h.posted.length = 0;
    q(".gfp-changes-ask-pull").click();
    if (remote) {
      expect(layers.depth).toBe(0);
      expect(depths).toEqual([1, 0]);
    }
    expect(input.value).toBe("Please keep my draft. " + pullMessage);
    expect(h.doc.activeElement).toBe(input);
    expect(q(".gfp-panel").hidden).toBe(remote);
    expect(h.posted.filter((msg) => msg.type !== "composerFocus")).toEqual([]);
    expect(gitRun).not.toHaveBeenCalled();
    // Existing whitespace supplies the separator; a second click still appends.
    input.value = "Keep this line.\n";
    if (remote) toggle.click();
    q(".gfp-changes-ask-pull").click();
    expect(input.value).toBe("Keep this line.\n" + pullMessage);
    if (remote) toggle.click();
    q(".gfp-changes-primary").click();
    await settle();
    // The existing push confirmation is deliberately kept intact.
    const confirm = h.doc.querySelector(".confirm-primary") as HTMLElement | null;
    if (confirm) { confirm.click(); await settle(); }
    await settle();
    expect(q(".gfp-changes-notice-action")?.textContent).toBe("Connect GitHub");
    h.posted.length = 0;
    depths.length = 0;
    q(".gfp-changes-notice-action").click();
    if (remote) {
      // The phone panel closes before Settings takes focus. Both transitions
      // matter to a shell reconciling its own dismissible layers.
      expect(layers.depth).toBe(1);
      expect(depths).toEqual([0, 1]);
    }
    expect(q(".gfp-panel").hidden).toBe(remote);
    expect(q("#settings-overlay")).toBeTruthy();
    expect(h.doc.querySelector('[data-id="githubConnection"], [data-id="githubConnectionStatus"], [data-id="githubConnectionRemote"]')).toBeTruthy();
    expect(input.value).toBe("Keep this line.\n" + pullMessage);
    expect(h.posted.some((msg) => /send|prompt|gitRun|githubConnect/i.test(msg.type))).toBe(false);
    expect(historyAccess).not.toHaveBeenCalled();
    await h.window.happyDOM.abort();
  });

  it("routes Settings to the IDE editor's Providers category", async () => {
    const h = bootWebview({ vscode: true });
    dispatch(h.window, { type: "initialState", capabilities: { settingsEditor: true } });
    h.posted.length = 0;
    (h.window as unknown as { __grokFilePanelOpenSettings: () => void }).__grokFilePanelOpenSettings();
    expect(h.posted).toEqual([{ type: "openSettingsSurface", category: "providers" }]);
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    await h.window.happyDOM.abort();
  });
});
