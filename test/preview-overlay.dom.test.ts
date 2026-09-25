// DOM regression for the in-app preview overlay (desktop previewInApp).
// Drives the real media/chat.js View-all / proposed-diff entry points.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootWebview, click, dispatch } from "./webview-harness";

const highlightSrc = readFileSync(
  fileURLToPath(new URL("../media/syntax-highlight.js", import.meta.url)),
  "utf8",
);

const LONG_CMD = Array.from({ length: 8 }, (_, i) =>
  i === 0 ? 'function Get-Status { Write-Output "probe" }' : `Write-Output "line ${i + 1}"`,
).join("\n");
const LONG_OUT = Array.from({ length: 9 }, (_, i) => `output ${i + 1}`).join("\n");
const DIFF = { type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" };

function exec(id: string, command: string) {
  return {
    type: "toolCall",
    call: {
      toolCallId: id,
      kind: "execute",
      title: `Run ${command.slice(0, 20)}…`,
      rawInput: { variant: "Bash", command, is_background: false },
    },
  };
}

function out(command: string, output: string) {
  return { type: "commandOutput", command, output, exitCode: 0, truncated: false };
}

function bootPreview(opts: { preview?: boolean; commandLanguage?: string } = {}) {
  const h = bootWebview({
    beforeScripts: (window) => {
      (window as unknown as { eval: (src: string) => void }).eval(highlightSrc);
    },
  });
  dispatch(h.window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: true,
    commandLanguage: opts.commandLanguage || "powershell",
    capabilities: opts.preview === false ? {} : { previewInApp: true },
  });
  return h;
}

function mockClipboard(window: Window): { value: string } {
  const box = { value: "" };
  Object.defineProperty((window as unknown as { navigator: Navigator }).navigator, "clipboard", {
    value: { writeText: (t: string) => { box.value = t; return Promise.resolve(); } },
    configurable: true,
  });
  return box;
}

function openLongCommand(window: Window) {
  dispatch(window, exec("preview-cmd", LONG_CMD));
  dispatch(window, { type: "messageChunk", text: "done" });
  dispatch(window, out(LONG_CMD, LONG_OUT));
}

function viewAllButtons(doc: Document): HTMLButtonElement[] {
  return [...doc.querySelectorAll(".command-view-all")] as HTMLButtonElement[];
}

describe("preview overlay — View all", () => {
  it("leaves Settings' existing Escape path intact because the preview is below it", () => {
    const h = bootPreview();
    openLongCommand(h.window);
    click(h.window, viewAllButtons(h.doc)[0]);
    expect(h.doc.getElementById("preview-overlay")).not.toBeNull();
    expect(h.doc.body.dataset.modalAbove).toBeUndefined();
    (h.window as any).__grokFilePanelOpenSettings();
    expect((h.window as any).afkpilotLayers.depth).toBe(1);
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(h.doc.body.dataset.modalAbove).toBeUndefined();
  });

  it("posts openText when the host does not advertise previewInApp", () => {
    const { window, doc, posted } = bootPreview({ preview: false });
    openLongCommand(window);
    const buttons = viewAllButtons(doc);
    expect(buttons.length).toBeGreaterThan(0);
    click(window, buttons[0]);
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(posted.filter((m) => m.type === "openText")).toEqual([
      { type: "openText", content: LONG_CMD, language: "powershell" },
    ]);
  });

  it("opens a highlighted overlay and does not post openText when previewInApp is set", () => {
    const { window, doc, posted } = bootPreview();
    openLongCommand(window);
    click(window, viewAllButtons(doc)[0]);
    const overlay = doc.getElementById("preview-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay!.querySelector(".preview-title")!.textContent).toBe("Untitled (powershell)");
    expect(overlay!.querySelector(".preview-lang")!.textContent).toBe("powershell");
    expect(overlay!.querySelectorAll(".hl-kw").length).toBeGreaterThan(0);
    expect(overlay!.textContent).toContain("Get-Status");
    expect(overlay!.querySelector(".tdl")).toBeNull();
    expect(overlay!.querySelector(".preview-open-panel")).toBeNull();
    expect(posted.filter((m) => m.type === "openText")).toHaveLength(0);
    expect(posted.filter((m) => m.type === "readProjectFile")).toHaveLength(0);
  });

  it("closes on Escape", () => {
    const { window, doc } = bootPreview();
    openLongCommand(window);
    click(window, viewAllButtons(doc)[0]);
    expect(doc.getElementById("preview-overlay")).toBeTruthy();
    doc.dispatchEvent(new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    expect(doc.getElementById("preview-overlay")).toBeNull();
  });

  it("Copy writes the raw text and Save As posts filename-bearing openText", async () => {
    const { window, doc, posted } = bootPreview();
    const clip = mockClipboard(window);
    openLongCommand(window);
    click(window, viewAllButtons(doc)[0]);
    const overlay = doc.getElementById("preview-overlay")!;
    const copy = [...overlay.querySelectorAll(".preview-action-btn")]
      .find((el) => el.textContent === "Copy") as HTMLButtonElement;
    const save = [...overlay.querySelectorAll(".preview-action-btn")]
      .find((el) => el.textContent === "Save As") as HTMLButtonElement;
    click(window, copy);
    await Promise.resolve();
    expect(clip.value).toBe(LONG_CMD);
    click(window, save);
    expect(posted.filter((m) => m.type === "openText")).toEqual([
      { type: "openText", content: LONG_CMD, filename: "Untitled.ps1", language: "powershell" },
    ]);
  });
});

describe("preview overlay — proposed diffs", () => {
  function seedEdit(window: Window) {
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "tc1", kind: "edit", content: [DIFF] },
    });
    dispatch(window, { type: "messageChunk", text: "done" });
  }

  it("posts openDiff when the host does not advertise previewInApp", () => {
    const { window, doc, posted } = bootPreview({ preview: false });
    seedEdit(window);
    const link = doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement;
    expect(link).toBeTruthy();
    click(window, link);
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(1);
    expect(posted.find((m) => m.type === "openDiff")).toMatchObject({
      type: "openDiff",
      path: "src/foo.ts",
      oldText: "a\nb",
      newText: "a\nB\nc",
    });
  });

  it("opens a full-size overlay and does not post openDiff when previewInApp is set", () => {
    const { window, doc, posted } = bootPreview();
    seedEdit(window);
    click(window, doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement);
    const overlay = doc.getElementById("preview-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay!.querySelector(".preview-title")!.textContent).toBe("foo.ts");
    expect(overlay!.querySelector(".tool-diff-region")).toBeTruthy();
    expect(overlay!.querySelectorAll(".tdl").length).toBeGreaterThan(0);
    expect(overlay!.querySelector(".tool-diff-toggle")).toBeNull();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(0);
  });

  it("does not auto-open the overlay on a permission card", () => {
    const { window, doc, posted } = bootPreview();
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 7,
        toolCall: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      },
    });
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(0);
    click(window, doc.querySelector(".card.permission .preview-link") as HTMLButtonElement);
    expect(doc.getElementById("preview-overlay")).toBeTruthy();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(0);
  });

  it("Save As posts a unified diff through the existing openText filename path", () => {
    const { window, doc, posted } = bootPreview();
    seedEdit(window);
    click(window, doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement);
    const save = [...doc.querySelectorAll("#preview-overlay .preview-action-btn")]
      .find((el) => el.textContent === "Save As") as HTMLButtonElement;
    click(window, save);
    const sent = posted.filter((m) => m.type === "openText");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "openText",
      filename: "foo.ts.diff",
      language: "diff",
    });
    expect(String(sent[0].content)).toContain("--- src/foo.ts");
    expect(String(sent[0].content)).toContain("+B");
  });

  it("Open in file panel calls openPath with the diff's relPath and closes the overlay", () => {
    const { window, doc } = bootPreview();
    const opened: string[] = [];
    (window as unknown as { __grokDeskFilePanel: { openPath: (p: string) => void } }).__grokDeskFilePanel = {
      openPath: (p) => { opened.push(p); },
    };
    seedEdit(window);
    click(window, doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement);
    const overlay = doc.getElementById("preview-overlay")!;
    const panelBtn = [...overlay.querySelectorAll(".preview-action-btn")]
      .find((el) => el.textContent === "Open in file panel") as HTMLButtonElement;
    expect(panelBtn).toBeTruthy();
    click(window, panelBtn);
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(opened).toEqual(["src/foo.ts"]);
  });
});

const readCall = (id: string, input: Record<string, unknown>) => ({
  type: "toolCall",
  call: { toolCallId: id, kind: "read", title: "read_file", rawInput: input },
});
const readDone = (id: string, text: string, extra?: Record<string, unknown>) => ({
  type: "toolCallUpdate",
  call: {
    toolCallId: id,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text } }],
    ...(extra ? { rawOutput: extra } : {}),
  },
});
const closeTurn = (window: Window) => dispatch(window, { type: "messageChunk", text: "done" });

async function answerProjectFile(
  h: { window: Window; posted: Array<{ type: string; [k: string]: unknown }> },
  text: string,
  opts: { ok?: boolean; reason?: string; pretty?: boolean; reformatted?: boolean; kind?: string } = {},
) {
  const req = h.posted.find((m) => m.type === "readProjectFile") as
    | { type: string; requestId?: string; cwd: string; relPath: string }
    | undefined;
  expect(req).toBeTruthy();
  dispatch(h.window, {
    type: "projectFileContent",
    requestId: req!.requestId,
    cwd: req!.cwd,
    relPath: req!.relPath,
    ...(opts.ok === false
      ? { ok: false, reason: opts.reason || "path escapes workspace" }
      : { ok: true, kind: opts.kind || "text", text, ...(opts.pretty ? { pretty: true } : {}), ...(opts.reformatted ? { reformatted: true } : {}) }),
  });
  await Promise.resolve();
  await Promise.resolve();
}

function stubFilePanel(window: Window): string[] {
  const opened: string[] = [];
  (window as unknown as { __grokDeskFilePanel: { openPath: (p: string) => void } }).__grokDeskFilePanel = {
    openPath: (p) => { opened.push(p); },
  };
  return opened;
}

function lines(n: number, start = 1): string {
  return Array.from({ length: n }, (_, i) => `line ${i + start}`).join("\n");
}

describe("preview overlay — file reads (#122 desktop)", () => {
  function seedRead(
    window: Window,
    file: string,
    excerpt: string,
    input: Record<string, unknown> = { offset: 1, limit: 12 },
  ) {
    dispatch(window, readCall("rd1", { target_file: file, ...input }));
    dispatch(window, readDone("rd1", excerpt, {
      type: "ReadFile",
      FileContent: { content: excerpt, offset: input.offset ?? 1, limit: input.limit ?? 12 },
    }));
    closeTurn(window);
  }

  it("renders the whole file, not the excerpt, with the read range marked and scrolled to", async () => {
    const h = bootPreview();
    const excerpt = lines(12);
    const whole = lines(40);
    seedRead(h.window, "src/a.ts", excerpt);
    const scrolled: Element[] = [];
    (h.window as unknown as { HTMLElement: { prototype: { scrollIntoView: (opts?: unknown) => void } } })
      .HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
        scrolled.push(this as unknown as Element);
      };

    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    expect(h.posted.filter((m) => m.type === "readProjectFile")).toEqual([
      expect.objectContaining({ type: "readProjectFile", cwd: "/w", relPath: "src/a.ts" }),
    ]);
    await answerProjectFile(h, whole);

    const overlay = h.doc.getElementById("preview-overlay")!;
    expect(overlay.querySelector(".preview-title")!.textContent).toBe("a.ts");
    expect(overlay.querySelectorAll(".tdl").length).toBe(40);
    expect(overlay.textContent).toContain("line 40");
    const marked = [...overlay.querySelectorAll(".tdl-read")] as HTMLElement[];
    expect(marked.map((el) => el.dataset.line)).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i + 1)),
    );
    const start = overlay.querySelector("#preview-read-start") as HTMLElement;
    expect(start).toBe(marked[0]);
    expect(scrolled).toContain(start);
    expect(overlay.querySelector(".preview-code")).toBeNull();
    expect(overlay.querySelector(".preview-notice")).toBeNull();
  });

  it("numbers a long file with the same gutter rule as a diff (4ch until 1000)", async () => {
    const h = bootPreview();
    const excerpt = lines(12, 980);
    const whole = lines(1000);
    seedRead(h.window, "src/deep.ts", excerpt, { offset: 980, limit: 12 });
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, whole);
    const overlay = h.doc.getElementById("preview-overlay")!;
    const region = overlay.querySelector(".preview-file-region") as HTMLElement;
    expect(region.style.getPropertyValue("--tdl-num-w")).toBe("5ch");
    const last = overlay.querySelector('.tdl[data-line="1000"]') as HTMLElement;
    expect(last.querySelector(".tdl-num")!.textContent).toBe("1000");
    expect(last.querySelector(".tdl-sign")!.textContent).toBe("");
    expect(last.children.length).toBe(3);
    const marked = [...overlay.querySelectorAll(".tdl-read")] as HTMLElement[];
    expect(marked[0].dataset.line).toBe("980");
    expect(marked[marked.length - 1].dataset.line).toBe("991");
  });

  it("keeps the excerpt and hides Open in file panel when the fetch fails", async () => {
    const h = bootPreview();
    stubFilePanel(h.window);
    const excerpt = lines(12);
    seedRead(h.window, "src/a.ts", excerpt);
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, "", { ok: false, reason: "path escapes workspace" });
    const overlay = h.doc.getElementById("preview-overlay")!;
    expect(overlay.querySelector(".preview-notice")!.textContent).toMatch(/Couldn't load the full file/);
    expect(overlay.querySelector(".preview-code")!.textContent).toBe(excerpt);
    expect(overlay.querySelector(".tdl")).toBeNull();
    expect(overlay.querySelector(".preview-open-panel")).toBeNull();
  });

  it("keeps the excerpt and hides Open in file panel for a path outside the workspace", () => {
    const h = bootPreview();
    stubFilePanel(h.window);
    const excerpt = lines(8);
    seedRead(h.window, "~/Downloads/x.md", excerpt, { offset: 1, limit: 8 });
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    expect(h.posted.filter((m) => m.type === "readProjectFile")).toHaveLength(0);
    const overlay = h.doc.getElementById("preview-overlay")!;
    expect(overlay.querySelector(".preview-notice")!.textContent).toMatch(/outside the project/);
    expect(overlay.querySelector(".preview-code")!.textContent).toBe(excerpt);
    expect(overlay.querySelector(".preview-open-panel")).toBeNull();
    expect(overlay.querySelector(".tdl")).toBeNull();
  });

  it("Open in file panel calls openPath with the file's relPath and closes the overlay", async () => {
    const h = bootPreview();
    const opened = stubFilePanel(h.window);
    seedRead(h.window, "src/a.ts", lines(12));
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, lines(40));
    const overlay = h.doc.getElementById("preview-overlay")!;
    const panelBtn = overlay.querySelector(".preview-open-panel") as HTMLButtonElement;
    expect(panelBtn.textContent).toBe("Open in file panel");
    click(h.window, panelBtn);
    expect(h.doc.getElementById("preview-overlay")).toBeNull();
    expect(opened).toEqual(["src/a.ts"]);
  });

  it("does not show Open in file panel when the host has no file panel", async () => {
    const h = bootPreview();
    seedRead(h.window, "src/a.ts", lines(12));
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, lines(40));
    expect(h.doc.querySelector(".preview-open-panel")).toBeNull();
  });

  // readProjectFile pretty-prints JSON for the file panel's benefit, so its
  // text is NOT the bytes on disk. Numbering it would put a gutter beside lines
  // the file does not have and mark the wrong ones as the agent's read.
  it("does not number a JSON file the host reformatted — it says so and keeps the excerpt", async () => {
    const h = bootPreview();
    const excerpt = '{"n":1e3}';
    seedRead(h.window, "a.json", excerpt);
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, ["{", '  "n": 1000', "}"].join("\n"), { kind: "json", pretty: true, reformatted: true });

    const overlay = h.doc.getElementById("preview-overlay")!;
    expect(overlay.querySelector(".preview-notice")!.textContent).toMatch(/reformatted/i);
    expect(overlay.querySelector(".preview-code")!.textContent).toBe(excerpt);
    // No gutter, and no panel button: the numbers would be a lie either way.
    expect(overlay.querySelector(".tdl")).toBeNull();
    expect(overlay.querySelector(".preview-open-panel")).toBeNull();
  });

  // The host serves text up to 2 MiB; a file of one-character lines is a
  // million rows at four DOM nodes each, built synchronously. Render a window
  // around the read instead, and SAY what was left out.
  it("windows a very long file around the read range and reports the clipping", async () => {
    const h = bootPreview();
    const excerpt = lines(4, 9000);
    const whole = lines(20000);
    seedRead(h.window, "big.log", excerpt, { offset: 9000, limit: 4 });
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, whole);

    const overlay = h.doc.getElementById("preview-overlay")!;
    const rows = overlay.querySelectorAll(".tdl");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(4000);
    // The lines the agent read must be inside the window — that is the point.
    const marked = [...overlay.querySelectorAll(".tdl-read")] as HTMLElement[];
    expect(marked.length).toBeGreaterThan(0);
    expect(marked[0]!.dataset.line).toBe("9000");
    const notice = overlay.querySelector(".preview-notice")!;
    expect(notice.textContent).toMatch(/Showing lines .* of 20000/);
  });

  // Most JSON in a repo is ALREADY formatted the way the pretty-printer would
  // write it, so `pretty` alone would have withdrawn the whole-file view from
  // nearly every JSON file — and told the user it was reformatted when it was
  // byte-for-byte the file on disk.
  it("still numbers a JSON file the pretty-printer left unchanged", async () => {
    const h = bootPreview();
    seedRead(h.window, "b.json", lines(3), { offset: 1, limit: 3 });
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, lines(30), { kind: "json", pretty: true });

    const overlay = h.doc.getElementById("preview-overlay")!;
    expect(overlay.querySelectorAll(".tdl").length).toBe(30);
    expect(overlay.querySelector(".preview-notice")).toBeNull();
    expect(overlay.querySelector(".preview-code")).toBeNull();
  });

  // A range larger than the context budget must still be shown in full — the
  // context is what gives way, never the lines the user asked to see.
  it("never drops requested lines to make room for context", async () => {
    const h = bootPreview();
    seedRead(h.window, "big.log", lines(4, 5000), { offset: 5000, limit: 3900 });
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    await answerProjectFile(h, lines(10000));

    const overlay = h.doc.getElementById("preview-overlay")!;
    const marked = [...overlay.querySelectorAll(".tdl-read")] as HTMLElement[];
    expect(marked[0]!.dataset.line).toBe("5000");
    expect(marked[marked.length - 1]!.dataset.line).toBe("8899");
    expect(marked.length).toBe(3900);
  });

});
