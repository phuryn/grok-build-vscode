// DOM-level tests for edit review surfaces, driving the REAL shipped
// media/chat.js in a happy-dom window.
//
// #30: a permission that resolves to a *single* edit must stay expandable so its
// diff remains reviewable, both live and after a session restore. closeToolGroup
// must NOT flatten a lone edit into a `.tool-flat` (which would drop the diff
// attached to the tool-item in the body).
//
// #45: under Auto accept (no permission card), an edit still has to be reviewable
// in chat. Every edit row shows an always-visible `+A −R` count (rolled up onto
// the collapsed group header too) and an expandable inline diff — computed from
// the region grok sends (oldText/newText) — sharing the command IN/OUT expand
// machinery. The native "open diff →" link stays.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const DIFF = { type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" };
const EDIT_CALL = { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" };
// "a\nb" -> "a\nB\nc": 'a' context, 'b' removed, 'B'+'c' added → +2 −1.

describe("single-edit tool group stays expandable + reviewable (#30, #45)", () => {
  it("keeps a lone edit as an expandable group with its inline diff, not a flat row (live)", () => {
    const { window, posted, doc } = bootWebview();

    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, { type: "promptComplete", meta: {} }); // turn boundary → closeToolGroup

    const group = doc.querySelector(".tool-group");
    expect(group).not.toBeNull(); // NOT collapsed into a bare `.tool-flat`
    expect(doc.querySelector(".tool-flat")).toBeNull();

    const item = group!.querySelector(".tool-item") as HTMLElement;
    expect(item.classList.contains("has-details")).toBe(true); // rides the command detail machinery
    expect(item.querySelector(".tool-chevron")).not.toBeNull();

    // Always-visible +A −R on the row, with the file name — not just "Edit".
    expect(item.querySelector(".tool-item-label")!.textContent).toBe("Edit foo.ts");
    expect(item.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(item.querySelector(".diff-stat-del")!.textContent).toBe("−1");

    // Rolled up onto the (collapsed) group header: "Edited 1 file · +2 −1".
    const header = group!.querySelector(".tool-group-label")!;
    expect(header.textContent).toContain("Edited 1 file");
    expect(header.querySelector(".diff-stat-add")!.textContent).toBe("+2");

    // The inline diff itself (Codex-style gutter rows) lives in the row's detail.
    const diffBlock = item.querySelector(".tool-item-details .tool-diff-region") as HTMLElement;
    expect(diffBlock).not.toBeNull();
    const adds = [...diffBlock.querySelectorAll(".tdl-add .tdl-code")].map((s) => s.textContent);
    const dels = [...diffBlock.querySelectorAll(".tdl-del .tdl-code")].map((s) => s.textContent);
    expect(adds).toEqual(["B", "c"]);
    expect(dels).toEqual(["b"]);
    // Color-blind affordance: +/- glyph by the border; region-relative line numbers.
    expect([...diffBlock.querySelectorAll(".tdl-add .tdl-sign")].map((s) => s.textContent)).toEqual(["+", "+"]);
    expect(diffBlock.querySelector(".tdl-del .tdl-sign")!.textContent).toBe("-");
    expect([...diffBlock.querySelectorAll(".tdl .tdl-num")].map((s) => s.textContent)).toEqual(["1", "2", "2", "3"]);

    // "open diff →" still opens the native editor with the region.
    const link = group!.querySelector(".tool-group-body .preview-link") as HTMLButtonElement;
    expect(link.textContent).toContain("open diff");
    click(window, link);
    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toMatchObject({ path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" });
  });

  it("names a pathless Edit from the diff path and a rename from old/new paths", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "p1", kind: "edit", title: "Edit" } });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "p1", content: [{ type: "diff", path: "docs/plan.md", oldText: "a", newText: "b" }] },
    });
    expect(doc.querySelector(".tool-item-label")!.textContent).toBe("Edit plan.md");

    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "r1",
        kind: "edit",
        title: "Edit",
        rawInput: { old_path: "src/old-name.ts", new_path: "src/new-name.ts" },
      },
    });
    expect([...doc.querySelectorAll(".tool-item-label")].at(-1)!.textContent)
      .toBe("Edit old-name.ts → new-name.ts");
  });

  it("names a tool whose arguments only arrive on the update, and keeps them", () => {
    // Claude's shape: a generic first call, then the real title and arguments,
    // then an update carrying ONLY the tool response. Rendering the first call
    // and ignoring the rest produced a flat list of bare verbs — Run, Read,
    // Search — with no argument, input or output.
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "c1", kind: "read", title: "Read File", rawInput: {} },
    });
    const label = () => doc.querySelector(".tool-item-label")!.textContent;
    expect(label()).toBe("Read");

    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "c1", title: "Read package.json", rawInput: { file_path: "/repo/package.json" } },
    });
    expect(label()).toBe("Read package.json");

    // The sparse response-only update must not blank what we just learned, and
    // a null title (Grok sends these) must not either.
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "c1" } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "c1", title: null, status: "completed" } });
    expect(label()).toBe("Read package.json");
  });

  it("gives a row its IN/OUT box when the command only lands on the update", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "s1", kind: "execute", title: "Run Shell", rawInput: {} },
    });
    expect(doc.querySelector(".cmd-block")).toBeNull();

    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "s1", title: "Run git status", rawInput: { command: "git status" } },
    });
    expect(doc.querySelector(".cmd-block")).not.toBeNull();
  });

  it("collapsed by default; expanding the group then the row reveals the diff", () => {
    const { window, doc } = bootWebview();

    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, { type: "promptComplete", meta: {} });

    const group = doc.querySelector(".tool-group") as HTMLElement;
    const body = group.querySelector(".tool-group-body") as HTMLElement;
    const item = group.querySelector(".tool-item") as HTMLElement;
    const details = item.querySelector(".tool-item-details") as HTMLElement;
    expect(body.hidden).toBe(true); // group collapsed by default (setting off)
    expect(details.hidden).toBe(true); // diff collapsed by default

    click(window, group.querySelector(".tool-group-header")!);
    expect(body.hidden).toBe(false);

    click(window, item); // expand the row
    expect(details.hidden).toBe(false);
    expect(item.classList.contains("expanded")).toBe(true);

    click(window, item); // collapse again
    expect(details.hidden).toBe(true);
  });

  it("clicking 'open diff →' inside the detail does not toggle the row", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, { type: "promptComplete", meta: {} });

    const item = doc.querySelector(".tool-item") as HTMLElement;
    const details = item.querySelector(".tool-item-details") as HTMLElement;
    click(window, item); // open the row
    expect(details.hidden).toBe(false);
    click(window, details.querySelector(".preview-link")!);
    expect(details.hidden).toBe(false); // still open — the button doesn't collapse the row
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(1);
  });

  it("does not double-render the diff when the same update replays (idempotent)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } }); // replay
    dispatch(window, { type: "promptComplete", meta: {} });

    const item = doc.querySelector(".tool-item") as HTMLElement;
    expect(item.querySelectorAll(".tool-item-details")).toHaveLength(1);
    expect(item.querySelectorAll(".diff-stat")).toHaveLength(1);
  });

  it("a new file (empty oldText) reads as pure additions, no phantom removal", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "n1", kind: "edit", title: "Edit new.ts" } });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "n1", content: [{ type: "diff", path: "new.ts", oldText: "", newText: "x\ny" }] },
    });
    dispatch(window, { type: "promptComplete", meta: {} });

    const item = doc.querySelector(".tool-item") as HTMLElement;
    expect(item.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(item.querySelector(".diff-stat-del")!.textContent).toBe("−0");
  });

  it("pre-expands the diff when grok.expandCommandOutputs (Expand tool details) is on", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
    });
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, { type: "promptComplete", meta: {} });

    const group = doc.querySelector(".tool-group") as HTMLElement;
    // The edit group is has-details, so the setting auto-opens the group AND the diff.
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(false);
    expect((group.querySelector(".tool-item-details") as HTMLElement).hidden).toBe(false);
  });

  it("still flattens a lone non-edit (a read) into a `.tool-flat`", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "r1", kind: "read", title: "Read src/foo.ts" } });
    dispatch(window, { type: "promptComplete", meta: {} });

    expect(doc.querySelector(".tool-flat")).not.toBeNull();
    expect(doc.querySelector(".tool-group")).toBeNull();
  });

  it("survives restore: a completed edit that carries its own diff still shows the inline diff + open diff", () => {
    const { window, posted, doc } = bootWebview();

    // grok's REAL session/load wire: a completed edit replays as a SINGLE
    // `tool_call` — kind:"edit", status:"completed" — carrying the diff in its own
    // `content`, with NO follow-up `tool_call_update`. So diff extraction must run
    // on the `tool_call` itself (#30).
    const REPLAYED_EDIT = { ...EDIT_CALL, status: "completed", content: [DIFF] };

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "permissionHistoryQueue",
      permissions: [{ toolCallId: "tc1", title: "Edit src/foo.ts", outcome: "allowed" }],
    });
    dispatch(window, { type: "toolCall", call: REPLAYED_EDIT }); // single message, diff included
    dispatch(window, { type: "historyReplay", active: false });

    const group = doc.querySelector(".tool-group");
    expect(group).not.toBeNull();
    expect(doc.querySelector(".tool-flat")).toBeNull();
    expect(group!.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(group!.querySelector(".tool-item-details .tool-diff-region")).not.toBeNull();

    const link = group!.querySelector(".tool-group-body .preview-link") as HTMLButtonElement;
    expect(link.textContent).toContain("open diff");
    click(window, link);
    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toMatchObject({ path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" });

    // The answered permission card replays right at the tool it gated.
    expect(doc.querySelector(".card.permission.perm-resolved")).not.toBeNull();
  });

  it("rolls per-file totals up onto a multi-edit group header, de-duped by path", () => {
    const { window, doc } = bootWebview();
    // Two edits to the SAME file → "Edited 1 file", totals summed. grok's edit
    // tool_call carries the path in rawInput.file_path.
    dispatch(window, { type: "toolCall", call: { toolCallId: "e1", kind: "edit", title: "Edit a.ts", rawInput: { file_path: "a.ts" } } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "e1", content: [{ type: "diff", path: "a.ts", oldText: "1", newText: "1\n2" }] } });
    dispatch(window, { type: "toolCall", call: { toolCallId: "e2", kind: "edit", title: "Edit a.ts", rawInput: { file_path: "a.ts" } } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "e2", content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y" }] } });
    dispatch(window, { type: "promptComplete", meta: {} });

    const label = doc.querySelector(".tool-group-label")!;
    expect(label.textContent).toContain("Edited 1 file"); // de-duped, not "2 files"
    // Totals: e1 +1 −0, e2 +1 −1 → +2 −1.
    expect(label.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(label.querySelector(".diff-stat-del")!.textContent).toBe("−1");
  });
});

// The diff data is on the wire per-edit, ~2.2–3.3s before the turn ends
// (research/edit-diff-timing.log), so the header roll-up must track each edit as it
// lands rather than waiting for closeToolGroup. The trap: addToToolGroup rebuilds the
// header's innerHTML for every new call in the batch, which wipes any painted totals.
describe("edit totals paint mid-turn, before the batch closes (#45 follow-up)", () => {
  const edit = (window: any, id: string, file: string, oldText: string, newText: string) => {
    dispatch(window, { type: "toolCall", call: { toolCallId: id, kind: "edit", title: `Edit ${file}`, rawInput: { file_path: file } } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: id, kind: "edit", title: `Edit \`${file}\``, content: [{ type: "diff", path: file, oldText, newText }] } });
  };

  it("shows totals on the IN-PROGRESS header and grows them per edit — no promptComplete", () => {
    const { window, doc } = bootWebview();
    const label = () => doc.querySelector(".tool-group-label")!;

    edit(window, "e1", "alpha.txt", "W1", "G1"); // +1 −1
    expect(doc.querySelector(".tool-group")!.classList.contains("in-progress")).toBe(true);
    expect(label().querySelector(".diff-stat-add")!.textContent).toBe("+1");
    expect(label().querySelector(".diff-stat-del")!.textContent).toBe("−1");

    // The 2nd call rebuilds the header — the totals must survive that clobber.
    edit(window, "e2", "bravo.txt", "W2", "G2"); // cumulative +2 −2
    expect(label().querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(label().querySelector(".diff-stat-del")!.textContent).toBe("−2");

    edit(window, "e3", "charlie.txt", "W3", "G3"); // cumulative +3 −3
    expect(label().querySelector(".diff-stat-add")!.textContent).toBe("+3");
    expect(label().querySelector(".diff-stat-del")!.textContent).toBe("−3");
    // Still mid-batch: nothing has closed the group.
    expect(doc.querySelector(".tool-group")!.classList.contains("in-progress")).toBe(true);
    // Exactly one totals slot — re-painting replaces, never appends a second copy.
    expect(label().querySelectorAll(".diff-stat")).toHaveLength(1);

    dispatch(window, { type: "promptComplete", meta: {} });
    expect(label().textContent).toContain("Edited 3 files");
    expect(label().querySelector(".diff-stat-add")!.textContent).toBe("+3");
    expect(label().querySelectorAll(".diff-stat")).toHaveLength(1);
  });

  it("a running batch with a landed edit diff stays COLLAPSED (only the setting/latch expand it)", () => {
    const { window, doc } = bootWebview();
    edit(window, "e1", "alpha.txt", "W1", "G1");
    // Totals are visible on the header, but nothing auto-opened.
    expect(doc.querySelector(".tool-group-label")!.querySelector(".diff-stat")).not.toBeNull();
    expect((doc.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);
    expect((doc.querySelector(".tool-item-details") as HTMLElement).hidden).toBe(true);
    expect(doc.querySelector(".tool-group")!.classList.contains("expanded")).toBe(false);
  });
});

// Wire fact (research/edit-diff-timing.log, grok 0.2.99): every edit reports its diff
// TWICE — an optimistic pre-write echo, then the authoritative completed update. For a
// search_replace both are byte-identical, but a whole-file Write's echo carries
// oldText:"" while the completed one carries the real prior content. The echo lands
// first, so a first-wins guard renders an overwrite as pure adds forever.
describe("the authoritative completed diff corrects the optimistic echo (#45 follow-up)", () => {
  const OLD = '{\n  "name": "old-name",\n  "version": "1.0.0",\n  "debug": false\n}\n';
  const NEW = '{\n  "name": "new-name",\n  "version": "2.0.0",\n  "debug": true,\n  "added": "field"\n}\n';

  it("re-renders a whole-file overwrite when the real oldText arrives", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "w1", title: "write", rawInput: { file_path: "config.json", content: NEW } } });
    // 1) echo: oldText "" → reads as a brand-new file (+7 −0).
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "w1", kind: "edit", title: "Write `config.json`", content: [{ type: "diff", path: "config.json", oldText: "", newText: NEW }] } });
    const row = () => doc.querySelector(".tool-item")!;
    expect(row().querySelector(".diff-stat-del")!.textContent).toBe("−0");

    // 2) authoritative: the real prior content → a true old→new diff.
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "w1", status: "completed", content: [{ type: "diff", path: "config.json", oldText: OLD, newText: NEW }] } });
    expect(row().querySelector(".diff-stat-add")!.textContent).toBe("+4");
    expect(row().querySelector(".diff-stat-del")!.textContent).toBe("−3");
    expect(row().querySelectorAll(".diff-stat")).toHaveLength(1); // replaced, not doubled
    // The group roll-up follows the correction rather than summing both renders.
    dispatch(window, { type: "promptComplete", meta: {} });
    const label = doc.querySelector(".tool-group-label")!;
    expect(label.querySelector(".diff-stat-add")!.textContent).toBe("+4");
    expect(label.querySelector(".diff-stat-del")!.textContent).toBe("−3");

    // The corrected diff is what "open diff →" hands to the native editor.
    (doc.querySelector(".tool-item-details .preview-link") as HTMLElement).click();
  });

  it("the corrected row keeps ONE working toggle (no listener bound to a stale node)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "w1", kind: "edit", title: "Write config.json", rawInput: { file_path: "config.json" } } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "w1", content: [{ type: "diff", path: "config.json", oldText: "", newText: NEW }] } });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "w1", status: "completed", content: [{ type: "diff", path: "config.json", oldText: OLD, newText: NEW }] } });

    const item = doc.querySelector(".tool-item") as HTMLElement;
    const details = () => doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details().hidden).toBe(true);
    click(window, item); // one click → open (a double-bound listener would toggle twice = no-op)
    expect(details().hidden).toBe(false);
    click(window, item);
    expect(details().hidden).toBe(true);
  });

  it("an identical repaint is still a no-op (buffer replay stays idempotent)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    const item = doc.querySelector(".tool-item")!;
    click(window, item); // user opens the diff
    expect((doc.querySelector(".tool-item-details") as HTMLElement).hidden).toBe(false);

    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } }); // replay
    expect(item.querySelectorAll(".diff-stat")).toHaveLength(1);
    expect(item.querySelectorAll(".tool-item-details")).toHaveLength(1);
    expect((doc.querySelector(".tool-item-details") as HTMLElement).hidden).toBe(false); // stays open
    dispatch(window, { type: "promptComplete", meta: {} });
    expect(doc.querySelector(".tool-group-label")!.querySelector(".diff-stat-add")!.textContent).toBe("+2"); // not doubled
  });
});

// The diff block carries the region's REAL position in the file on its own `_meta`
// (`old_line`/`new_line`, 1-based). We used to drop `_meta` entirely and restart the
// gutter at 1 for every edit, so a one-line replace at line 147 rendered as "1".
// Wire shape (grok 0.2.101): {type:"diff", path, oldText, newText, _meta:{old_line, new_line}}
// Expanding a RUNNING tool group to watch it must survive the batch finishing.
// closeToolGroup settles every group to its default expand state, which silently
// threw away a mid-execution manual expand (shipped since #41; only reachable now
// that totals/diffs paint during the turn and give a reason to expand early).
describe("a manual expand of a running tool group survives the batch closing", () => {
  const startBatch = () => {
    const h = bootWebview();
    dispatch(h.window, { type: "toolCall", call: EDIT_CALL });
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    return h;
  };
  const groupBody = (doc: Document) => doc.querySelector(".tool-group-body") as HTMLElement;

  it("stays expanded when the user opened it mid-execution", () => {
    const { window, doc } = startBatch();
    click(window, doc.querySelector(".tool-group-header")!); // user expands mid-run
    expect(groupBody(doc).hidden).toBe(false);

    dispatch(window, { type: "promptComplete", meta: {} }); // batch closes
    expect(groupBody(doc).hidden).toBe(false); // must NOT snap shut
    expect(doc.querySelector(".tool-group")!.classList.contains("expanded")).toBe(true);
  });

  it("stays collapsed when the user closed it mid-execution, even with the setting on", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding", // would auto-open this group at close
    });
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    // A running group is collapsed even with the setting on (it only auto-opens at
    // close), so reaching "the user deliberately closed it" takes open-then-close.
    const hdr = doc.querySelector(".tool-group-header")!;
    click(window, hdr); // open
    expect(groupBody(doc).hidden).toBe(false);
    click(window, hdr); // and deliberately close again
    expect(groupBody(doc).hidden).toBe(true);

    dispatch(window, { type: "promptComplete", meta: {} });
    expect(groupBody(doc).hidden).toBe(true); // user intent beats the setting's auto-open
  });

  it("still settles to the default when the user never touched it", () => {
    const { window, doc } = startBatch();
    dispatch(window, { type: "promptComplete", meta: {} });
    expect(groupBody(doc).hidden).toBe(true); // unchanged default behavior
  });

  it("an explicit Collapse All still overrides a manual expand", () => {
    const { window, doc } = startBatch();
    click(window, doc.querySelector(".tool-group-header")!);
    dispatch(window, { type: "promptComplete", meta: {} });
    expect(groupBody(doc).hidden).toBe(false);

    dispatch(window, { type: "setAllToolDetails", expand: false }); // the latch wins
    expect(groupBody(doc).hidden).toBe(true);
  });
});

describe("inline diff gutter shows real file line numbers (_meta.old_line/new_line)", () => {
  const numsIn = (doc: Document) =>
    [...doc.querySelectorAll(".tool-item-details .tdl .tdl-num")].map((s) => s.textContent);

  // Drives one edit through the live path and returns the rendered gutter numbers.
  const renderWith = (meta?: Record<string, unknown>) => {
    const { window, doc } = bootWebview();
    const content = [meta ? { ...DIFF, _meta: meta } : DIFF];
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content } });
    dispatch(window, { type: "promptComplete", meta: {} });
    return numsIn(doc);
  };

  it("seeds the gutter from the wire's file position", () => {
    // Same row shape as the region-relative [1,2,2,3], just anchored at the real line.
    expect(renderWith({ old_line: 147, new_line: 147 })).toEqual(["147", "148", "148", "149"]);
  });

  it("falls back to 1 when _meta is absent (older builds, hand-built fixtures)", () => {
    expect(renderWith()).toEqual(["1", "2", "2", "3"]);
  });

  it("tracks the old and new sides independently when the region shifted", () => {
    // old_line 10 / new_line 40: a del reads the OLD side, an add/context the NEW side.
    expect(renderWith({ old_line: 10, new_line: 40 })).toEqual(["40", "11", "41", "42"]);
  });

  it("ignores a nonsense line number instead of rendering it", () => {
    // A 0/negative/non-integer line must never reach the gutter as "0" or "-3".
    expect(renderWith({ old_line: 0, new_line: 0 })).toEqual(["1", "2", "2", "3"]);
    expect(renderWith({ old_line: -3, new_line: -3 })).toEqual(["1", "2", "2", "3"]);
    expect(renderWith({ old_line: "147", new_line: "147" })).toEqual(["1", "2", "2", "3"]);
  });

  // The two updates per edit spell the position differently on the same block `_meta`:
  // the echo sends {old_line,new_line}; the COMPLETED sends {details:[{old_line,…}]}.
  // Reading only the echo's shape made the completed repaint silently revert to 1.
  // On the real wire a SINGLE-site details[] entry's old_string/new_string equal the
  // block's own oldText/newText (research/edit-diff-lines.log), so expanding details[]
  // renders the same 4 rows — only the seed differs.
  it("reads the position from the completed update's _meta.details[] too", () => {
    const details = [{ old_string: "a\nb", old_line: 147, new_string: "a\nB\nc", new_line: 147, line_prefix: "" }];
    expect(renderWith({ details })).toEqual(["147", "148", "148", "149"]);
  });

  // Defensive: a details[] entry naming NO strings can't be expanded into a site, only
  // positioned. Keep the block's own region rather than rendering an empty diff.
  it("falls back to the block's region when details[] has positions but no strings", () => {
    expect(renderWith({ details: [{ old_line: 147, new_line: 147 }] })).toEqual(["147", "148", "148", "149"]);
  });

  // The third delivery shape: session/load replays a completed `tool_call` carrying
  // the diff inline — details[] only, no block _meta. A restored session must still
  // show real line numbers, not 1.
  it("shows real line numbers on a session/load replay (details[] only)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "toolCall",
      call: {
        ...EDIT_CALL,
        status: "completed",
        content: [{
          ...DIFF,
          _meta: { details: [{ old_string: "a\nb", old_line: 147, new_string: "a\nB\nc", new_line: 147, line_prefix: "" }] },
        }],
      },
    });
    dispatch(window, { type: "historyReplay", active: false });
    expect(numsIn(doc)).toEqual(["147", "148", "148", "149"]);
  });

  it("does not revert to 1 when the completed update repaints the echo", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    // 1. echo — block _meta carries {old_line,new_line}
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "tc1", content: [{ ...DIFF, _meta: { old_line: 147, new_line: 147 } }] },
    });
    expect(numsIn(doc)).toEqual(["147", "148", "148", "149"]);
    // 2. completed — same region, position now under details[]; must NOT fall back to 1
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "tc1",
        status: "completed",
        content: [{
          ...DIFF,
          _meta: { details: [{ old_string: "a\nb", old_line: 147, new_string: "a\nB\nc", new_line: 147, line_prefix: "" }] },
        }],
      },
    });
    dispatch(window, { type: "promptComplete", meta: {} });
    expect(numsIn(doc)).toEqual(["147", "148", "148", "149"]);
  });
});

// Real file line numbers made 4+ digit gutters reachable, so the track sizes to the
// widest number in each region (+1ch slack) instead of being fixed at 4ch — which
// would clip 5 digits into the +/- glyph. Through 999 it must stay exactly 4ch.
describe("inline diff gutter width adapts to the line numbers it renders", () => {
  const widthFor = (line: number) => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: EDIT_CALL });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "tc1", content: [{ ...DIFF, _meta: { old_line: line, new_line: line } }] },
    });
    dispatch(window, { type: "promptComplete", meta: {} });
    const region = doc.querySelector(".tool-item-details .tool-diff-region") as HTMLElement;
    return region.style.getPropertyValue("--tdl-num-w");
  };

  it("stays 4ch for anything up to 999 (today's look is unchanged)", () => {
    expect(widthFor(1)).toBe("4ch");
    expect(widthFor(147)).toBe("4ch");
    expect(widthFor(996)).toBe("4ch"); // renders up to 998 — still 3 digits
  });

  it("grows once the numbers pass 999", () => {
    expect(widthFor(1000)).toBe("5ch"); // 4 digits + 1ch slack
    expect(widthFor(10000)).toBe("6ch"); // 5 digits + 1ch slack
  });

  it("sizes from the widest number actually rendered, not the region's first line", () => {
    // starts at 998, renders through 1000 → must widen for the 4-digit tail
    expect(widthFor(998)).toBe("5ch");
  });
});

// A replace_all's diff BLOCK is token-sized by design — oldText/newText are the search
// *pattern*, so the block alone renders a 148-occurrence rename as one meaningless
// "+1 −1" hunk. `_meta.details[]` carries the per-site truth (one entry per replaced
// site, real 1-based post-edit file lines), verified 12/12 against ground truth in
// research/edit-diff-lines.log. Expand it: N sites → N hunks in ONE region, +N −N.
describe("a replace_all renders one hunk per replaced site (_meta.details[])", () => {
  // The exact wire shape of research/edit-diff-lines.log's A-replace-all case:
  // PLACEHOLDER → REPLACED at non-contiguous lines, each entry carrying the text
  // BEFORE the match on its line (line_prefix). There is no line_suffix on the wire,
  // so the rendered line is prefix+token — the real line's tail (" here") is
  // unavailable and deliberately not reconstructed.
  const site = (line: number, n: number) => ({
    old_string: "PLACEHOLDER",
    old_line: line,
    new_string: "REPLACED",
    new_line: line,
    context_before: "intro filler line\n",
    context_after: "  filler after item\n",
    line_prefix: `item ${n}: the token is `,
  });
  const replaceAll = (sites: unknown[]) => ({
    type: "diff",
    path: "placeholders.txt",
    oldText: "PLACEHOLDER", // token-sized: the pattern, NOT the change
    newText: "REPLACED",
    _meta: { details: sites },
  });
  const boot = (sites: unknown[]) => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "toolCall",
      call: {
        toolCallId: "ra",
        kind: "edit",
        title: "Edit placeholders.txt",
        rawInput: { file_path: "placeholders.txt", replace_all: true },
      },
    });
    dispatch(h.window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "ra",
        status: "completed",
        rawInput: { variant: "SearchReplace", file_path: "placeholders.txt", replace_all: true },
        content: [replaceAll(sites)],
      },
    });
    return h;
  };
  const three = [site(3, 1), site(5, 2), site(7, 3)];

  it("renders every site as its own hunk at its real, non-contiguous file line", () => {
    const { doc } = boot(three);
    const regions = doc.querySelectorAll(".tool-item-details .tool-diff-region");
    expect(regions).toHaveLength(1); // ONE region per BLOCK — not one scroll box per site

    // 3 sites × (1 del + 1 add), each anchored at its own line — not 1, not 3,4,5.
    expect([...regions[0].querySelectorAll(".tdl .tdl-num")].map((s) => s.textContent))
      .toEqual(["3", "3", "5", "5", "7", "7"]);
    // line_prefix rides the rendered text: the bare "PLACEHOLDER" would be useless.
    expect([...regions[0].querySelectorAll(".tdl-del .tdl-code")].map((s) => s.textContent)).toEqual([
      "item 1: the token is PLACEHOLDER",
      "item 2: the token is PLACEHOLDER",
      "item 3: the token is PLACEHOLDER",
    ]);
    expect([...regions[0].querySelectorAll(".tdl-add .tdl-code")].map((s) => s.textContent)).toEqual([
      "item 1: the token is REPLACED",
      "item 2: the token is REPLACED",
      "item 3: the token is REPLACED",
    ]);
  });

  it("counts EVERY site: +3 −3, not the block-level +1 −1", () => {
    const { window, doc } = boot(three);
    const item = doc.querySelector(".tool-item") as HTMLElement;
    expect(item.querySelector(".diff-stat-add")!.textContent).toBe("+3");
    expect(item.querySelector(".diff-stat-del")!.textContent).toBe("−3");
    dispatch(window, { type: "promptComplete", meta: {} });
    const label = doc.querySelector(".tool-group-label")!;
    expect(label.textContent).toContain("Edited 1 file");
    expect(label.querySelector(".diff-stat-add")!.textContent).toBe("+3");
    expect(label.querySelector(".diff-stat-del")!.textContent).toBe("−3");
  });

  it("separates non-contiguous hunks, but not contiguous ones and never before the first", () => {
    // Sites at 3/5/7 skip lines → a separator between each pair, none leading.
    const gapped = boot(three).doc.querySelector(".tool-diff-region")!;
    expect(gapped.querySelectorAll(".tdl-sep")).toHaveLength(2);
    expect(gapped.firstElementChild!.classList.contains("tdl-sep")).toBe(false);

    // Sites on adjacent lines (3, then 4) are one continuous run → no separator.
    expect(boot([site(3, 1), site(4, 2)]).doc.querySelectorAll(".tdl-sep")).toHaveLength(0);
    // A single site is never separated either.
    expect(boot([site(3, 1)]).doc.querySelectorAll(".tdl-sep")).toHaveLength(0);
  });

  it("still ONE 'open diff →' per block, carrying the block's own region", () => {
    const { doc, window, posted } = boot(three);
    const links = doc.querySelectorAll(".tool-item-details .preview-link:not(.revert-link)");
    expect(links).toHaveLength(1); // not one per site
    click(window, links[0] as HTMLElement);
    expect(posted.filter((m: any) => m.type === "openDiff")[0]).toMatchObject({
      path: "placeholders.txt",
      oldText: "PLACEHOLDER",
      newText: "REPLACED",
      replaceAll: true,
      sites: [
        { oldText: "item 1: the token is PLACEHOLDER", newText: "item 1: the token is REPLACED", newLine: 3 },
        { oldText: "item 2: the token is PLACEHOLDER", newText: "item 2: the token is REPLACED", newLine: 5 },
        { oldText: "item 3: the token is PLACEHOLDER", newText: "item 3: the token is REPLACED", newLine: 7 },
      ],
    });
  });

  it("stays COLLAPSED with a multi-site diff (only the setting/latch expand it)", () => {
    const { window, doc } = boot(three);
    dispatch(window, { type: "promptComplete", meta: {} });
    expect((doc.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);
    expect((doc.querySelector(".tool-item-details") as HTMLElement).hidden).toBe(true);
    expect(doc.querySelector(".tool-group")!.classList.contains("expanded")).toBe(false);
  });

  // The echo can only ever paint ONE approximate hunk (no details[], and its block
  // _meta names the FIRST site only). The completed update must upgrade it to the full
  // per-site render — and the group roll-up must follow the correction, not sum both.
  it("upgrades the echo's single approximate hunk to N hunks without double-counting", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "ra", kind: "edit", title: "Edit placeholders.txt", rawInput: { file_path: "placeholders.txt" } },
    });
    // 1) echo: block _meta = first site only → the misleading "+1 −1" single hunk.
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "ra", kind: "edit", title: "Edit `placeholders.txt`",
        content: [{ type: "diff", path: "placeholders.txt", oldText: "PLACEHOLDER", newText: "REPLACED", _meta: { old_line: 3, new_line: 3 } }],
      },
    });
    const item = () => doc.querySelector(".tool-item") as HTMLElement;
    expect(item().querySelector(".diff-stat-add")!.textContent).toBe("+1");
    expect(doc.querySelectorAll(".tdl-del")).toHaveLength(1);

    // 2) completed: details[] → 3 real hunks, +3 −3.
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "ra", status: "completed", content: [replaceAll(three)] } });
    expect(item().querySelector(".diff-stat-add")!.textContent).toBe("+3");
    expect(item().querySelectorAll(".diff-stat")).toHaveLength(1); // replaced, not appended
    expect(doc.querySelectorAll(".tdl-del")).toHaveLength(3);
    expect(doc.querySelectorAll(".tool-item-details")).toHaveLength(1);
    expect(doc.querySelectorAll(".tool-diff-region")).toHaveLength(1);

    dispatch(window, { type: "promptComplete", meta: {} });
    const label = doc.querySelector(".tool-group-label")!;
    expect(label.querySelector(".diff-stat-add")!.textContent).toBe("+3"); // not 1+3=4
    expect(label.querySelector(".diff-stat-del")!.textContent).toBe("−3");

    // The upgraded row keeps ONE working toggle (the detail node was REUSED, so no
    // listener is stranded on a detached node and none is double-bound).
    const details = () => doc.querySelector(".tool-item-details") as HTMLElement;
    click(window, doc.querySelector(".tool-group-header")!);
    expect(details().hidden).toBe(true);
    click(window, item());
    expect(details().hidden).toBe(false);
  });

  it("an identical multi-site repaint is a no-op (replay stays idempotent)", () => {
    const { window, doc } = boot(three);
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "ra", status: "completed", content: [replaceAll(three)] } });
    expect(doc.querySelectorAll(".tool-diff-region")).toHaveLength(1);
    expect(doc.querySelectorAll(".tdl-del")).toHaveLength(3);
    expect(doc.querySelector(".tool-item")!.querySelectorAll(".diff-stat")).toHaveLength(1);
  });

  it("shows 12 rows by default, expands inline, then collapses back", () => {
    const sixteenRows = Array.from({ length: 8 }, (_, i) => site(3 + i, i + 1));
    const { window, doc } = boot(sixteenRows);
    const region = doc.querySelector(".tool-diff-region") as HTMLElement;
    const rows = [...region.querySelectorAll(".tdl")] as HTMLElement[];
    const visibleRows = () => rows.filter((row) => !row.hidden);
    const toggle = region.querySelector(".tool-diff-toggle") as HTMLButtonElement;

    expect(rows).toHaveLength(16);
    expect(visibleRows()).toHaveLength(12);
    expect(toggle.textContent).toBe("Show more");
    expect(region.querySelector(".tool-diff-more")).toBeNull(); // 12→16 is inline, not native-diff truncation

    click(window, toggle);
    expect(visibleRows()).toHaveLength(16);
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    click(window, toggle);
    expect(visibleRows()).toHaveLength(12);
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  // MAX_INLINE_DIFF_LINES (400) is a budget ACROSS the block's hunks — 250 sites must
  // not paint 500 rows. The counts are computed over every site regardless, so a
  // capped render still reports the true magnitude.
  it("caps the rendered rows but still reports the true +N −M", () => {
    const many = Array.from({ length: 250 }, (_, i) => site(3 + i * 2, i + 1));
    const { window, doc } = boot(many);
    expect(doc.querySelectorAll(".tdl")).toHaveLength(400); // 500 rows' worth, capped
    const more = doc.querySelector(".tool-diff-more") as HTMLElement;
    expect(more.textContent).toContain("100 more line(s)");
    expect(more.textContent).toContain("open diff");
    expect(more.hidden).toBe(true); // the 12-line preview only advertises inline expansion
    click(window, doc.querySelector(".tool-diff-toggle")!);
    expect(more.hidden).toBe(false); // >400 is the only native-diff truncation note
    // The stat is NOT capped — that's the whole point.
    const item = doc.querySelector(".tool-item") as HTMLElement;
    expect(item.querySelector(".diff-stat-add")!.textContent).toBe("+250");
    expect(item.querySelector(".diff-stat-del")!.textContent).toBe("−250");
  });

  // The single-site shapes must be untouched by the expansion: on the real wire a lone
  // details[] entry's old_string/new_string ARE the block's oldText/newText
  // (research/edit-diff-lines.log), including a whole-file Write's real prior content —
  // which is what keeps the echo's oldText:"" overwrite correction working.
  it("leaves a whole-file Write's single-site details[] rendering exactly as before", () => {
    const OLD = '{\n  "theme": "old-theme"\n}\n';
    const NEW = '{\n  "theme": "new-theme",\n  "extra": "added"\n}\n';
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "w1", kind: "edit", title: "Write settings.json", rawInput: { file_path: "settings.json" } },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "w1",
        status: "completed",
        content: [{
          type: "diff", path: "settings.json", oldText: OLD, newText: NEW,
          _meta: { details: [{ old_string: OLD, old_line: 1, new_string: NEW, new_line: 1, context_before: "", context_after: "", line_prefix: "" }] },
        }],
      },
    });
    const item = doc.querySelector(".tool-item") as HTMLElement;
    expect(item.querySelector(".diff-stat-add")!.textContent).toBe("+2");
    expect(item.querySelector(".diff-stat-del")!.textContent).toBe("−1");
    expect(doc.querySelectorAll(".tdl-sep")).toHaveLength(0);
    expect(doc.querySelectorAll(".tool-diff-region")).toHaveLength(1);
  });

  // The wire's newText ends in a trailing newline, so it is 4 lines to a line-splitter
  // — exactly what the block-level render reports too (old_string:"" and line_prefix:""
  // make the site byte-identical to the block). The point is the −0.
  it("a new file's details[] (old_string:'') still reads as pure additions", () => {
    const NEW = "first new line\nsecond new line\nthird new line\n";
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "n1", kind: "edit", title: "Write brandnew.txt", rawInput: { file_path: "brandnew.txt" } },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "n1",
        status: "completed",
        content: [{
          type: "diff", path: "brandnew.txt", oldText: "", newText: NEW,
          _meta: { details: [{ old_string: "", old_line: 1, new_string: NEW, new_line: 1, context_before: "", context_after: "", line_prefix: "" }] },
        }],
      },
    });
    const item = doc.querySelector(".tool-item") as HTMLElement;
    expect(item.querySelector(".diff-stat-add")!.textContent).toBe("+4");
    expect(item.querySelector(".diff-stat-del")!.textContent).toBe("−0"); // no phantom removal
  });
});
