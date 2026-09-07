// DOM regressions for the 2026-07 benchmark-found bugs: the Windows drag-drop
// wire shape, busyLocked recovery after agentError/exit, and the per-session
// reset leaking the question/restored-card maps across sessions. Drives the
// REAL media/chat.js via the shared happy-dom harness.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

/** Dispatch a `drop` carrying exactly the transfer types named in `data`.
 *
 *  Modelled on a real dataTransfer, where `types` is what a handler enumerates
 *  and `getData` is only ever asked for a type that appears in it. A fixture
 *  that supplies `getData` alone would pass against a handler that reads the
 *  standard type blindly — which is precisely the bug these tests guard. */
function drop(window: any, doc: any, data: Record<string, string>, shiftKey = false): void {
  const ev = new window.Event("drop", { bubbles: true, cancelable: true });
  ev.dataTransfer = { types: Object.keys(data), getData: (t: string) => data[t] ?? "" };
  ev.shiftKey = shiftKey;
  doc.dispatchEvent(ev);
}

/** The attachment posts (one per resource) and the type-shape report that
 *  precedes them. The report carries no `path` — it exists so a drop that
 *  yielded nothing is distinguishable from one that never arrived. */
const attachments = (posted: any[]) => posted.filter((m) => m.type === "dropFile" && "path" in m);
const report = (posted: any[]) => posted.find((m) => m.type === "dropFile" && !("path" in m));

describe("drag-drop posts the raw file:// URI (#2 — Windows drops died silently)", () => {
  it("forwards the untouched URI so the host can fileUriToPath it", () => {
    const { window, posted, doc } = bootWebview();
    // The old handler posted decodeURIComponent of the URI minus `file://` —
    // `/C:/x`, which existsSync rejects on Windows, a silent no-op. The host
    // now owns the conversion, so the webview must pass the URI through raw.
    drop(window, doc, {
      "text/uri-list": "file:///C:/Users/p/My%20Docs/notes.txt\r\nhttps://x.ai/skip.txt",
    });
    expect(attachments(posted)).toEqual([
      { type: "dropFile", path: "file:///C:/Users/p/My%20Docs/notes.txt", shift: false },
    ]);
  });
});

describe("Explorer drags (#136 — nothing happened, then the wrong thing did)", () => {
  // The six types a real VS Code Explorer multi-select drag carries, with the
  // values it actually puts in them (captured from a live drag): `text/plain`
  // holds workspace-RELATIVE labels, and the standard `text/uri-list` is
  // truncated to the first resource. Only VS Code's own list has all of them.
  const explorerDrag = {
    "text/plain": "src/frames.ts\nsrc/hub.ts",
    "text/uri-list": "file:///c%3A/GitHub/grok-remote/src/frames.ts",
    ResourceURLs: JSON.stringify([
      "file:///c%3A/GitHub/grok-remote/src/frames.ts",
      "file:///c%3A/GitHub/grok-remote/src/hub.ts",
    ]),
    CodeFiles: JSON.stringify([
      "c:\\GitHub\\grok-remote\\src\\frames.ts",
      "c:\\GitHub\\grok-remote\\src\\hub.ts",
    ]),
    CodeEditors: JSON.stringify([{ resource: "file:///c%3A/GitHub/grok-remote/src/frames.ts" }]),
    "application/vnd.code.uri-list":
      "file:///c%3A/GitHub/grok-remote/src/frames.ts\r\nfile:///c%3A/GitHub/grok-remote/src/hub.ts",
  };

  it("attaches every dragged resource, not just the first", () => {
    const { window, posted, doc } = bootWebview();
    drop(window, doc, explorerDrag, true);
    expect(attachments(posted).map((m) => m.path)).toEqual([
      "file:///c%3A/GitHub/grok-remote/src/frames.ts",
      "file:///c%3A/GitHub/grok-remote/src/hub.ts",
    ]);
    // Reading the standard type first would have taken one file out of two.
    expect(report(posted).via).toBe("application/vnd.code.uri-list");
  });

  it("does not report Shift, because the workbench demanded it", () => {
    // A `dragstart` in the workbench sets pointer-events:none on every webview
    // iframe and only Shift lifts it, so an Explorer drag CANNOT arrive here
    // without Shift down. Reading it as our own modifier made every dropped
    // file a whole-file inline attachment, and every dropped image a binary
    // file read as utf-8 for a line count instead of a vision attachment.
    const { window, posted, doc } = bootWebview();
    drop(window, doc, explorerDrag, true);
    expect(attachments(posted).every((m) => m.shift === false)).toBe(true);
  });

  it("still honours Shift on an OS file-manager drag", () => {
    // A drag that began outside the window fires no `dragstart` in this
    // renderer, so nothing is blocked, none of VS Code's own types are set,
    // and Shift means what it has always meant here.
    const { window, posted, doc } = bootWebview();
    drop(window, doc, { Files: "", "text/uri-list": "file:///C:/tmp/a.png" }, true);
    expect(attachments(posted)).toEqual([
      { type: "dropFile", path: "file:///C:/tmp/a.png", shift: true },
    ]);
  });
});

describe("busyLocked recovery (#11 — error during the locked startup window)", () => {
  it("agentError during the startup lock frees the composer for a working resend", () => {
    // ready:false = the real startup state: busy + busyLocked (spinner).
    const { window, posted, doc } = bootWebview({ ready: false });
    dispatch(window, { type: "agentError", text: "spawn failed" });

    const input = doc.getElementById("input") as HTMLTextAreaElement;
    const sendBtn = doc.getElementById("send-btn") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);

    // The next send must behave like a normal live send — before the fix the
    // stale busyLocked flipped the button into a disabled "Initializing…"
    // spinner with no way to cancel.
    input.value = "retry after crash";
    click(window, sendBtn);
    expect(posted.some((m) => m.type === "send")).toBe(true);
    expect(sendBtn.title).toBe("Stop");
    expect(sendBtn.disabled).toBe(false);
  });

  it("a CLI exit during the startup lock frees the composer the same way", () => {
    const { window, posted, doc } = bootWebview({ ready: false });
    dispatch(window, { type: "exit", code: 1 });

    const input = doc.getElementById("input") as HTMLTextAreaElement;
    const sendBtn = doc.getElementById("send-btn") as HTMLButtonElement;
    input.value = "recover";
    click(window, sendBtn);
    expect(posted.some((m) => m.type === "send")).toBe(true);
    expect(sendBtn.title).toBe("Stop");
    expect(sendBtn.disabled).toBe(false);
  });
});

describe("session reset clears the question/restored-card maps (#9)", () => {
  it("a stale toolCallId from the previous session cannot mutate its detached card", () => {
    const { window, doc } = bootWebview();

    // Session A: replay a restored (unanswered) question card keyed by q1.
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "q1",
        title: "Ask: Pick one",
        status: "in_progress",
        rawInput: { questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] },
      },
    });
    dispatch(window, { type: "historyReplay", active: false });

    const staleCard = doc.querySelector(".card.question") as HTMLElement;
    expect(staleCard).toBeTruthy();
    expect(staleCard.querySelector(".question-answer")).toBeNull();

    // Session swap: the reset must forget q1 (it used to leak both maps).
    dispatch(window, { type: "clearMessages" });

    // Session B delivers an update reusing the same toolCallId. Before the fix
    // this looked up the DETACHED session-A card and wrote the answer into it.
    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "q1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "User answered your questions: Pick one: A" } }],
      },
    });

    expect(staleCard.querySelector(".question-answer")).toBeNull();
    expect((staleCard as any)._answered).toBeUndefined();
  });
});
