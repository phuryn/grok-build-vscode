// Turn-level "Changed N files" summary: path-deduped +/− across every edit in
// the open agent turn, live as diffs land and pinned at turn end. Reuses the
// same openDiff payload as each row's "open diff →".
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const diff = (path: string, oldText: string, newText: string) => ({
  type: "diff" as const,
  path,
  oldText,
  newText,
});

function editUpdate(toolCallId: string, path: string, oldText: string, newText: string) {
  return {
    type: "toolCallUpdate" as const,
    call: { toolCallId, content: [diff(path, oldText, newText)] },
  };
}

function editCall(toolCallId: string, path: string, title?: string) {
  return {
    type: "toolCall" as const,
    call: { toolCallId, kind: "edit", title: title || `Edit ${path}` },
  };
}

function rowByPath(doc: Document, re: RegExp) {
  return [...doc.querySelectorAll(".turn-diff-file")].find((r) =>
    re.test(r.querySelector(".turn-diff-file-path")?.textContent || ""),
  ) as HTMLElement | undefined;
}

describe("turn-level file change summary", () => {
  it("lists every edited file with path-deduped totals and reveals its diff", () => {
    const { window, doc, posted } = bootWebview();

    dispatch(window, { type: "agentStart" });
    dispatch(window, editCall("e1", "src/a.ts"));
    // "x" → "y" = +1 −1
    dispatch(window, editUpdate("e1", "src/a.ts", "x", "y"));
    dispatch(window, editCall("e2", "src/b.ts"));
    // "" → "hi" = +1 −0
    dispatch(window, editUpdate("e2", "src/b.ts", "", "hi"));
    // Second edit on a.ts — sum both region stats; openDiff spans first→last
    dispatch(window, editCall("e3", "src/a.ts"));
    dispatch(window, editUpdate("e3", "src/a.ts", "y", "yz"));
    dispatch(window, { type: "agentEnd" });

    const card = doc.querySelector(".turn-diff-summary") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector(".turn-diff-summary-title")!.textContent).toBe("Changed 2 files");
    // a: (+1−1)+(+1−1 for y→yz) = +2 −2; b create "hi": +1 −0 → header +3 −2
    expect(card.querySelector(".turn-diff-summary-header .diff-stat-add")!.textContent).toBe("+3");
    expect(card.querySelector(".turn-diff-summary-header .diff-stat-del")!.textContent).toBe("−2");

    const rows = [...card.querySelectorAll(".turn-diff-file")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".turn-diff-file-path")!.textContent).toBe("src/a.ts");
    expect(rows[0].querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(rows[0].querySelector(".diff-stat-del")!.textContent).toBe("−2");
    expect(rows[1].querySelector(".turn-diff-file-path")!.textContent).toBe("src/b.ts");

    click(window, rows[0] as HTMLElement);
    // The row reveals that file's own tool row — there is no honest
    // turn-level diff to post (see webview-helpers.js § aggregateTurnEdits).
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
    expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeTruthy();
  });

  describe("same file edited multiple times in one turn", () => {
    it("sums create + later edit across case-variant paths", () => {
      const { window, doc, posted } = bootWebview();
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("c1", "F1.txt", "Write F1.txt"));
      dispatch(window, editUpdate("c1", "d:\\Temp\\AITest\\F1.txt", "", "a\nb\nc"));
      dispatch(window, editCall("c2", "f1.txt"));
      dispatch(window, editUpdate("c2", "d:/Temp/AITest/f1.txt", "a\nb\nc", "A\nB\nC"));
      dispatch(window, { type: "agentEnd" });

      const rows = doc.querySelectorAll(".turn-diff-file");
      expect(rows).toHaveLength(1);
      // Create +3 −0 plus rewrite "a\nb\nc"→"A\nB\nC" = +3 −3 → sum +6 −3
      expect(rows[0].querySelector(".diff-stat-add")!.textContent).toBe("+6");
      expect(rows[0].querySelector(".diff-stat-del")!.textContent).toBe("−3");

      click(window, rows[0] as HTMLElement);
      // The row reveals that file's own tool row — there is no honest
      // turn-level diff to post (see webview-helpers.js § aggregateTurnEdits).
      expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
      expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeTruthy();
    });

    it("three sequential appends on F3 sum to +3", () => {
      const { window, doc, posted } = bootWebview();
      const v0 = "base\n";
      const v1 = "base\npass1\n";
      const v2 = "base\npass1\npass2\n";
      const v3 = "base\npass1\npass2\npass3\n";
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("p1", "F3.txt"));
      dispatch(window, editUpdate("p1", "F3.txt", v0, v1));
      dispatch(window, editCall("p2", "F3.txt"));
      dispatch(window, editUpdate("p2", "F3.txt", v1, v2));
      dispatch(window, editCall("p3", "F3.txt"));
      dispatch(window, editUpdate("p3", "F3.txt", v2, v3));
      dispatch(window, { type: "agentEnd" });

      const row = rowByPath(doc, /F3\.txt/)!;
      expect(row.querySelector(".diff-stat-add")!.textContent).toBe("+3");
      expect(row.querySelector(".diff-stat-del")!.textContent).toBe("−0");
      click(window, row);
      // The row reveals that file's own tool row — there is no honest
      // turn-level diff to post (see webview-helpers.js § aggregateTurnEdits).
      expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
      expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeTruthy();
    });

    it("add a line then remove that same line — both + and − appear in the sum", () => {
      const { window, doc, posted } = bootWebview();
      const before = "keep\n";
      const withExtra = "keep\nTEMP\n";
      const after = "keep\n";
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("a1", "note.txt"));
      dispatch(window, editUpdate("a1", "note.txt", before, withExtra)); // +1
      // Live card should already show the add
      expect(rowByPath(doc, /note\.txt/)!.querySelector(".diff-stat-add")!.textContent).toBe("+1");

      dispatch(window, editCall("a2", "note.txt"));
      dispatch(window, editUpdate("a2", "note.txt", withExtra, after)); // −1
      dispatch(window, { type: "agentEnd" });

      const row = rowByPath(doc, /note\.txt/)!;
      expect(row.querySelector(".diff-stat-add")!.textContent).toBe("+1");
      expect(row.querySelector(".diff-stat-del")!.textContent).toBe("−1");
      click(window, row);
      // The row reveals that file's own tool row — there is no honest
      // turn-level diff to post (see webview-helpers.js § aggregateTurnEdits).
      expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
      expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeTruthy();
    });

    it("add content then rewrite that same content", () => {
      const { window, doc } = bootWebview();
      const v0 = "header\n";
      const v1 = "header\nDRAFT\n";
      const v2 = "header\nFINAL\n";
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("r1", "doc.txt"));
      dispatch(window, editUpdate("r1", "doc.txt", v0, v1));
      dispatch(window, editCall("r2", "doc.txt"));
      dispatch(window, editUpdate("r2", "doc.txt", v1, v2));
      dispatch(window, { type: "agentEnd" });

      const row = rowByPath(doc, /doc\.txt/)!;
      // +1 (append DRAFT) + (+1 −1 rewrite DRAFT→FINAL) = +2 −1
      expect(row.querySelector(".diff-stat-add")!.textContent).toBe("+2");
      expect(row.querySelector(".diff-stat-del")!.textContent).toBe("−1");
    });

    it("append, edit that line, then remove it — three-pass sum", () => {
      const { window, doc, posted } = bootWebview();
      const v0 = "stable\n";
      const v1 = "stable\nX\n";
      const v2 = "stable\nY\n";
      const v3 = "stable\n";
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("t1", "f.txt"));
      dispatch(window, editUpdate("t1", "f.txt", v0, v1));
      dispatch(window, editCall("t2", "f.txt"));
      dispatch(window, editUpdate("t2", "f.txt", v1, v2));
      dispatch(window, editCall("t3", "f.txt"));
      dispatch(window, editUpdate("t3", "f.txt", v2, v3));
      dispatch(window, { type: "agentEnd" });

      const row = rowByPath(doc, /^f\.txt$/)!;
      // +1, then +1−1, then −1 → +2 −2
      expect(row.querySelector(".diff-stat-add")!.textContent).toBe("+2");
      expect(row.querySelector(".diff-stat-del")!.textContent).toBe("−2");
      click(window, row);
      // The row reveals that file's own tool row — there is no honest
      // turn-level diff to post (see webview-helpers.js § aggregateTurnEdits).
      expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
      expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeTruthy();
    });

    it("live card grows as a second edit lands on the same file (before agentEnd)", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("l1", "live.txt"));
      // Avoid trailing "\n" — computeLineDiff would count a phantom empty line.
      dispatch(window, editUpdate("l1", "live.txt", "", "one"));
      expect(doc.querySelector(".turn-diff-summary-header .diff-stat-add")!.textContent).toBe("+1");

      dispatch(window, editCall("l2", "live.txt"));
      dispatch(window, editUpdate("l2", "live.txt", "one", "one\ntwo"));
      // Still one card, one row, summed counts
      expect(doc.querySelectorAll(".turn-diff-summary")).toHaveLength(1);
      expect(doc.querySelectorAll(".turn-diff-file")).toHaveLength(1);
      expect(doc.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    });

    it("interleaved A/B/A edits keep separate path rows with summed A", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("i1", "a.ts"));
      dispatch(window, editUpdate("i1", "a.ts", "1", "2"));
      dispatch(window, editCall("i2", "b.ts"));
      dispatch(window, editUpdate("i2", "b.ts", "", "x"));
      dispatch(window, editCall("i3", "a.ts"));
      dispatch(window, editUpdate("i3", "a.ts", "2", "3"));
      dispatch(window, { type: "agentEnd" });

      expect(doc.querySelectorAll(".turn-diff-file")).toHaveLength(2);
      const a = rowByPath(doc, /a\.ts/)!;
      const b = rowByPath(doc, /b\.ts/)!;
      expect(a.querySelector(".diff-stat-add")!.textContent).toBe("+2"); // 1→2 and 2→3
      expect(a.querySelector(".diff-stat-del")!.textContent).toBe("−2");
      expect(b.querySelector(".diff-stat-add")!.textContent).toBe("+1");
    });
  });

  describe("deletes", () => {
    it("tracks Remove-Item shell deletes as Deleted rows", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "agentStart" });
      dispatch(window, {
        type: "toolCall",
        call: {
          toolCallId: "w1",
          kind: "edit",
          title: "Write F2.txt",
          content: [diff("d:\\Temp\\AITest\\F2.txt", "", "x\ny\nz")],
        },
      });
      dispatch(window, {
        type: "toolCall",
        call: {
          toolCallId: "d1",
          kind: "execute",
          title: "Shell",
          rawInput: { command: "Remove-Item -Force 'd:\\Temp\\AITest\\F2.txt'" },
        },
      });
      dispatch(window, {
        type: "toolCall",
        call: {
          toolCallId: "d2",
          kind: "execute",
          title: "Shell",
          rawInput: { command: "Remove-Item 'd:\\Temp\\AITest\\to-delete-1.txt'" },
        },
      });
      dispatch(window, { type: "agentEnd" });

      const card = doc.querySelector(".turn-diff-summary")!;
      expect(card).not.toBeNull();
      const deleted = [...card.querySelectorAll(".turn-diff-file.is-deleted")];
      expect(deleted.length).toBeGreaterThanOrEqual(2);
      expect(deleted.every((r) => r.textContent?.includes("Deleted"))).toBe(true);
      // F2 was written then deleted → only Deleted, not +3
      const f2 = deleted.find((r) =>
        /F2\.txt/i.test(r.querySelector(".turn-diff-file-path")!.textContent || ""),
      );
      expect(f2).toBeTruthy();
    });

    it("edit then delete then recreate only counts post-delete edits", () => {
      const { window, doc, posted } = bootWebview();
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("x1", "x.txt"));
      dispatch(window, editUpdate("x1", "x.txt", "old", "mid"));
      dispatch(window, {
        type: "toolCall",
        call: {
          toolCallId: "xd",
          kind: "execute",
          title: "Shell",
          rawInput: { command: "rm -f x.txt" },
        },
      });
      dispatch(window, editCall("x2", "x.txt", "Write x.txt"));
      dispatch(window, editUpdate("x2", "x.txt", "", "brand\nnew")); // +2
      dispatch(window, editCall("x3", "x.txt"));
      dispatch(window, editUpdate("x3", "x.txt", "brand\nnew", "brand\nnew\nplus")); // +1
      dispatch(window, { type: "agentEnd" });

      const rows = [...doc.querySelectorAll(".turn-diff-file")];
      expect(rows).toHaveLength(1);
      expect(rows[0].classList.contains("is-deleted")).toBe(false);
      // create +2, append +1 → +3 (pre-delete edit wiped)
      expect(rows[0].querySelector(".diff-stat-add")!.textContent).toBe("+3");
      click(window, rows[0] as HTMLElement);
      // The row reveals that file's own tool row — there is no honest
      // turn-level diff to post (see webview-helpers.js § aggregateTurnEdits).
      expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
      expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeTruthy();
    });
  });

  it("appears live as the first edit lands (before agentEnd)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, editCall("e1", "foo.ts"));
    dispatch(window, editUpdate("e1", "foo.ts", "a", "b"));
    const card = doc.querySelector(".turn-diff-summary");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".turn-diff-summary-title")!.textContent).toBe("Changed 1 file");
  });

  it("echo→completed repaint replaces counts (no double-count)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, editCall("w1", "note.txt", "Write note.txt"));
    // Echo for overwrite: oldText empty → pure adds
    dispatch(window, editUpdate("w1", "note.txt", "", "new\nline"));
    // Authoritative completed: real prior content
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "w1",
        status: "completed",
        content: [diff("note.txt", "old\nline", "new\nline")],
      },
    });
    dispatch(window, { type: "agentEnd" });

    const card = doc.querySelector(".turn-diff-summary")!;
    expect(card.querySelectorAll(".turn-diff-file")).toHaveLength(1);
    // "old\nline" → "new\nline": del old, add new, ctx line → +1 −1
    expect(card.querySelector(".diff-stat-add")!.textContent).toBe("+1");
    expect(card.querySelector(".diff-stat-del")!.textContent).toBe("−1");
  });

  it("starts a fresh card on the next agent turn", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "agentStart" });
    dispatch(window, editCall("t1", "a.ts"));
    dispatch(window, editUpdate("t1", "a.ts", "1", "2"));
    dispatch(window, { type: "agentEnd" });
    expect(doc.querySelectorAll(".turn-diff-summary")).toHaveLength(1);

    dispatch(window, { type: "userMessage", text: "next" });
    dispatch(window, { type: "agentStart" });
    dispatch(window, editCall("t2", "b.ts"));
    dispatch(window, editUpdate("t2", "b.ts", "x", "y"));
    dispatch(window, { type: "agentEnd" });

    const cards = [...doc.querySelectorAll(".turn-diff-summary")];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector(".turn-diff-file-path")!.textContent).toBe("a.ts");
    expect(cards[1].querySelector(".turn-diff-file-path")!.textContent).toBe("b.ts");
  });

  it("rebuilds on session restore from completed tool_call diffs", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "please edit" });
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "r1",
        kind: "edit",
        title: "Edit restored.ts",
        status: "completed",
        content: [diff("restored.ts", "old", "new")],
      },
    });
    dispatch(window, { type: "historyReplay", active: false });

    const card = doc.querySelector(".turn-diff-summary");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".turn-diff-file-path")!.textContent).toBe("restored.ts");
  });

  it("restore with multi-edit same file sums both completed tool_calls", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "multi" });
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "r1",
        kind: "edit",
        title: "Edit multi.txt",
        status: "completed",
        content: [diff("multi.txt", "", "one")],
      },
    });
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "r2",
        kind: "edit",
        title: "Edit multi.txt",
        status: "completed",
        content: [diff("multi.txt", "one", "one\ntwo")],
      },
    });
    dispatch(window, { type: "historyReplay", active: false });

    const row = rowByPath(doc, /multi\.txt/)!;
    expect(row.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    click(window, row);
    // The row reveals that file's own tool row — there is no honest
    // turn-level diff to post (see webview-helpers.js § aggregateTurnEdits).
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
    expect(doc.querySelector(".tool-item.expanded, .tool-item-flat.expanded")).toBeTruthy();
  });

  it("does not appear for non-edit tool turns", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "r1", kind: "read", title: "Read foo.ts", rawInput: { path: "foo.ts" } },
    });
    dispatch(window, { type: "agentEnd" });
    expect(doc.querySelector(".turn-diff-summary")).toBeNull();
  });

  // The card is a ROLL-UP of diffs the rows can already show in full, so it is
  // worth its space only where they are collapsed. Asserted on the body class
  // rather than the node: hiding it in CSS is what lets a card return when the
  // user flips the setting back, on turns whose edit map is long gone.
  // A plain ellipsis on the whole path eats the filename first, which is the
  // only part that says which file the row is. The leaf is its own span so CSS
  // can shrink the directory and never the name; the screens harness
  // (scripts/turn-diff-screens.mjs) is what proves the pixels follow.
  it("splits the path so the directory is the half that can be cut", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, editCall("p1", "packages/relay/src/deep/reconnect-policy.ts"));
    dispatch(window, editUpdate("p1", "packages/relay/src/deep/reconnect-policy.ts", "a", "b"));
    dispatch(window, { type: "agentEnd" });

    const path = doc.querySelector(".turn-diff-file-path") as HTMLElement;
    expect(path.querySelector(".turn-diff-file-dir")!.textContent).toBe("packages/relay/src/deep");
    // The separator rides the leaf, so a cut directory still reads ".../name".
    expect(path.querySelector(".turn-diff-file-name")!.textContent).toBe("/reconnect-policy.ts");
    expect(path.textContent).toBe("packages/relay/src/deep/reconnect-policy.ts");
    expect(path.title).toBe("packages/relay/src/deep/reconnect-policy.ts");
  });

  it("leaves a bare filename in one piece", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentStart" });
    dispatch(window, editCall("p2", "README.md"));
    dispatch(window, editUpdate("p2", "README.md", "a", "b"));
    dispatch(window, { type: "agentEnd" });

    const path = doc.querySelector(".turn-diff-file-path") as HTMLElement;
    expect(path.querySelector(".turn-diff-file-dir")).toBeNull();
    expect(path.textContent).toBe("README.md");
  });

  // Two independent reasons the card cannot open a native diff, and together
  // they leave ONE behaviour rather than a per-surface branch. A remote may not
  // post openDiff at all (host-local in src/remote-policy.ts). And a host has
  // nothing honest to post: the wire carries each edit's REPLACED REGION, so a
  // twice-edited file has no before/after without a pre-turn baseline. The row
  // reveals that file's own tool row, where the real diff already is.
  describe("the row reveals the file's own diff, on every surface", () => {
    function editTurn(remote: boolean) {
      const h = bootWebview(remote ? { remote: true } : {});
      dispatch(h.window, { type: "appPurpose", value: "coding" });
      dispatch(h.window, { type: "agentStart" });
      dispatch(h.window, editCall("r1", "src/a.ts"));
      dispatch(h.window, editUpdate("r1", "src/a.ts", "x", "y"));
      dispatch(h.window, { type: "agentEnd" });
      return h;
    }

    for (const remote of [false, true]) {
      it(`expands the tool row and posts nothing (${remote ? "remote" : "host"})`, () => {
        const { window, doc, posted } = editTurn(remote);
        const row = doc.querySelector(".turn-diff-file") as HTMLElement;
        expect(row.tagName).toBe("BUTTON");
        expect(row.title).toBe("Show the diff");

        click(window, row);
        expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
        // revealToolDiff opens the row AND its group, so the diff is on screen.
        const item = doc.querySelector(".tool-item, .tool-item-flat");
        expect(item!.classList.contains("expanded")).toBe(true);
      });
    }
  });

  describe("when the roll-up earns its space", () => {
    const HIDDEN = "hide-turn-diff-summary";

    function editedTurn(window: any) {
      dispatch(window, { type: "agentStart" });
      dispatch(window, editCall("g1", "src/a.ts"));
      dispatch(window, editUpdate("g1", "src/a.ts", "x", "y"));
      dispatch(window, { type: "agentEnd" });
    }

    it("stays hidden in knowledge work, which is the default before the host speaks", () => {
      const { window, doc } = bootWebview();
      expect(doc.body.classList.contains(HIDDEN)).toBe(true);
      editedTurn(window);
      // Built, so it is there to reveal — but not shown.
      expect(doc.querySelector(".turn-diff-summary")).not.toBeNull();
      expect(doc.body.classList.contains(HIDDEN)).toBe(true);
    });

    it("shows in coding work while tool details stay collapsed", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "appPurpose", value: "coding" });
      editedTurn(window);
      expect(doc.body.classList.contains(HIDDEN)).toBe(false);
      expect(doc.querySelector(".turn-diff-summary")).not.toBeNull();
    });

    it("hides again when Expand tool details opens every diff inline", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "appPurpose", value: "coding" });
      editedTurn(window);
      expect(doc.body.classList.contains(HIDDEN)).toBe(false);
      dispatch(window, { type: "expandCommandOutputs", value: true });
      expect(doc.body.classList.contains(HIDDEN)).toBe(true);
      // Reversible, and the card that was already in the transcript comes back.
      dispatch(window, { type: "expandCommandOutputs", value: false });
      expect(doc.body.classList.contains(HIDDEN)).toBe(false);
      expect(doc.querySelector(".turn-diff-summary")).not.toBeNull();
    });

    it("follows the session's Expand/Collapse All latch, not just the setting", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "appPurpose", value: "coding" });
      editedTurn(window);
      dispatch(window, { type: "setAllToolDetails", open: true });
      expect(doc.body.classList.contains(HIDDEN)).toBe(true);
      dispatch(window, { type: "setAllToolDetails", open: false });
      expect(doc.body.classList.contains(HIDDEN)).toBe(false);
    });

    it("goes back to hidden when the user switches to knowledge work", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "appPurpose", value: "coding" });
      editedTurn(window);
      expect(doc.body.classList.contains(HIDDEN)).toBe(false);
      dispatch(window, { type: "appPurpose", value: "knowledge" });
      expect(doc.body.classList.contains(HIDDEN)).toBe(true);
    });
  });
});
