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

/** openDiff is on the path control, not the whole row (row holds Undo/View). */
function clickOpenDiff(window: Window, row: HTMLElement) {
  const pathBtn = row.querySelector(".turn-diff-file-path.has-diff") as HTMLElement | null;
  click(window, pathBtn || row);
}

describe("turn-level file change summary", () => {
  it("lists every edited file with path-deduped totals and opens the native diff", () => {
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

    clickOpenDiff(window, rows[0] as HTMLElement);
    const opens = posted.filter((m: any) => m.type === "openDiff");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ path: "src/a.ts", oldText: "x", newText: "yz" });
  });

  describe("same file edited multiple times in one turn", () => {
    it("sums create + later edit across case-variant paths; openDiff is first→last", () => {
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

      clickOpenDiff(window, rows[0] as HTMLElement);
      const opens = posted.filter((m: any) => m.type === "openDiff");
      expect(opens[0]).toMatchObject({ oldText: "", newText: "A\nB\nC" });
    });

    it("three sequential appends on F3 sum to +3 and open the full span", () => {
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
      clickOpenDiff(window, row);
      expect(posted.filter((m: any) => m.type === "openDiff").pop()).toMatchObject({
        oldText: v0,
        newText: v3,
      });
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
      clickOpenDiff(window, row);
      expect(posted.filter((m: any) => m.type === "openDiff").pop()).toMatchObject({
        oldText: before,
        newText: after,
      });
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
      clickOpenDiff(window, row);
      expect(posted.filter((m: any) => m.type === "openDiff").pop()).toMatchObject({
        oldText: v0,
        newText: v3,
      });
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
      clickOpenDiff(window, rows[0]);
      expect(posted.filter((m: any) => m.type === "openDiff").pop()).toMatchObject({
        oldText: "",
        newText: "brand\nnew\nplus",
      });
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
    clickOpenDiff(window, row);
    expect(posted.filter((m: any) => m.type === "openDiff").pop()).toMatchObject({
      oldText: "",
      newText: "one\ntwo",
    });
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

  describe("host baselines (View deleted / Undo)", () => {
    it("shows Undo all + per-file Undo when turnBaselines arrives", () => {
      const { window, doc, posted } = bootWebview();
      dispatch(window, { type: "agentStart", turnId: 7 });
      dispatch(window, editCall("e1", "a.ts"));
      dispatch(window, editUpdate("e1", "a.ts", "x", "y"));
      dispatch(window, {
        type: "turnBaselines",
        turnId: 7,
        files: [{ path: "a.ts", kind: "content" }],
      });
      dispatch(window, { type: "agentEnd" });

      const card = doc.querySelector(".turn-diff-summary")!;
      expect(card.dataset.turnId).toBe("7");
      const undoAll = [...card.querySelectorAll(".turn-diff-action")].find(
        (b) => b.textContent === "Undo all",
      ) as HTMLButtonElement;
      expect(undoAll).toBeTruthy();
      click(window, undoAll);
      expect(posted.filter((m: any) => m.type === "undoTurnFiles")).toEqual([
        { type: "undoTurnFiles", turnId: 7 },
      ]);

      const rowUndo = [...card.querySelectorAll(".turn-diff-file .turn-diff-action")].find(
        (b) => b.textContent === "Undo",
      ) as HTMLButtonElement;
      expect(rowUndo).toBeTruthy();
      click(window, rowUndo);
      expect(posted.filter((m: any) => m.type === "undoTurnFiles" && m.paths)).toEqual([
        { type: "undoTurnFiles", turnId: 7, paths: ["a.ts"] },
      ]);
    });

    it("shows View on deleted rows when baseline has content", () => {
      const { window, doc, posted } = bootWebview();
      dispatch(window, { type: "agentStart", turnId: 3 });
      dispatch(window, {
        type: "toolCall",
        call: {
          toolCallId: "d1",
          kind: "execute",
          title: "Shell",
          rawInput: { command: "Remove-Item 'gone.txt'" },
        },
      });
      dispatch(window, {
        type: "turnBaselines",
        turnId: 3,
        files: [{ path: "gone.txt", kind: "content" }],
      });
      dispatch(window, { type: "agentEnd" });

      const view = [...doc.querySelectorAll(".turn-diff-action")].find(
        (b) => b.textContent === "View",
      ) as HTMLButtonElement;
      expect(view).toBeTruthy();
      click(window, view);
      expect(posted.filter((m: any) => m.type === "viewTurnBaseline")).toEqual([
        { type: "viewTurnBaseline", turnId: 3, path: "gone.txt" },
      ]);
    });
  });
});
