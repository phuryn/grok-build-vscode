// The "Sending your message" strip on a remote must settle once the host has
// answered the send, whatever else the page went through in between. It used
// to wait for an echo matched against pending-submission fields that a
// clearMessages (relay reattach, CLI respawn) resets, and for an exact text
// match after a queue divert — so a delivered, answered message could leave
// "… 3:23 so far. Waiting for confirmation." up until the next send.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const opened: Harness[] = [];
const upLink = () => ({ reachable: true, phase: "up", since: Date.now(), restored: true, connection: 1 });
const IMPLICIT = { id: "implicit:/repo/a.ts", path: "/repo/a.ts", relPath: "a.ts", hidden: false };

function boot(): Harness {
  const h = bootWebview({ remote: true, beforeScripts: (win) => { (win as any).afkpilotHostLink = upLink(); } });
  opened.push(h);
  dispatch(h.window, { type: "initialState", cwd: "/repo" });
  dispatch(h.window, { type: "session", sessionId: "s1", models: [] });
  dispatch(h.window, { type: "setBusy", value: false });
  return h;
}
const strip = (h: Harness) => h.doc.getElementById("host-wait-strip");
const pending = (h: Harness) => { const s = strip(h); return !!s && !s.hidden && s.dataset.state === "pending"; };
const sends = (h: Harness) => h.posted.filter((m) => m.type === "send");
function type(h: Harness, text: string) {
  (h.doc.getElementById("input") as HTMLTextAreaElement).value = text;
  click(h.window, h.doc.getElementById("send-btn")!);
  return sends(h).at(-1)!;
}
function answer(h: Harness, reply = "Hello back") {
  dispatch(h.window, { type: "agentStart" });
  dispatch(h.window, { type: "messageChunk", text: reply });
  dispatch(h.window, { type: "agentEnd", meta: {} });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of opened.splice(0)) await h.window.happyDOM.abort();
});

describe("remote send wait", () => {
  it("settles on the host's echo of the submission", () => {
    const h = boot();
    const req = type(h, "htrtj");
    expect(req.submissionId).toBeTruthy();
    expect(pending(h)).toBe(true);
    dispatch(h.window, { type: "userMessage", text: "htrtj", chips: [], submissionId: req.submissionId });
    expect(pending(h)).toBe(false);
  });

  it("settles when the CLI respawns between the send and its echo", () => {
    const h = boot();
    const req = type(h, "htrtj");
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "setBusy", value: true, locked: true });
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "userMessageChunk", text: "earlier prompt" });
    dispatch(h.window, { type: "messageChunk", text: "earlier answer" });
    dispatch(h.window, { type: "historyReplay", active: false });
    dispatch(h.window, { type: "setBusy", value: false });
    dispatch(h.window, { type: "userMessage", text: "htrtj", chips: [], submissionId: req.submissionId });
    answer(h);
    expect(pending(h)).toBe(false);
  });

  it("settles when a relay reattach replays the echo inside its snapshot", () => {
    const h = boot();
    const req = type(h, "htrtj");
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "historyBatch", messages: [
      { type: "userMessage", text: "htrtj", chips: [], submissionId: req.submissionId },
      { type: "agentStart" },
      { type: "messageChunk", text: "Hello back" },
      { type: "agentEnd", meta: {} },
    ] });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(pending(h)).toBe(false);
  });

  it("settles when a send typed while the link was down is echoed after the attach burst", () => {
    const h = boot();
    const down = { reachable: false, phase: "waking", since: Date.now(), restored: false, connection: 2 };
    (h.window as any).afkpilotHostLink = down;
    dispatch(h.window, { type: "hostLink", link: down });
    const req = type(h, "htrtj");
    const up = { reachable: true, phase: "up", since: Date.now(), restored: true, connection: 2 };
    (h.window as any).afkpilotHostLink = up;
    dispatch(h.window, { type: "hostLink", link: up });
    dispatch(h.window, { type: "clearMessages" });
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "historyBatch", messages: [{ type: "userMessage", text: "older", chips: [], submissionId: "x" }] });
    dispatch(h.window, { type: "historyReplay", active: false });
    dispatch(h.window, { type: "userMessage", text: "htrtj", chips: [], submissionId: req.submissionId });
    answer(h);
    expect(pending(h)).toBe(false);
  });

  it("settles as queued when the host diverts the send into its queue", () => {
    const h = boot();
    dispatch(h.window, { type: "chips", chips: [IMPLICIT] });
    type(h, "htrtj");
    dispatch(h.window, { type: "queuedSends", items: ["htrtj"], queued: [{ text: "htrtj" }] });
    expect(pending(h)).toBe(false);
  });

  it("stays settled when the dequeued echo's chip or text differs from the send", () => {
    for (const [queued, echo] of [
      [[{ text: "htrtj" }], { text: "htrtj", chips: [{ ...IMPLICIT, id: "implicit:/repo/b.ts", path: "/repo/b.ts", relPath: "b.ts" }] }],
      [[{ text: "htrtj" }, { text: "from desk" }], { text: "htrtj\n\nfrom desk", chips: [] }],
    ] as const) {
      const h = boot();
      dispatch(h.window, { type: "chips", chips: [IMPLICIT] });
      type(h, "htrtj");
      dispatch(h.window, { type: "queuedSends", items: queued.map((q) => q.text), queued });
      dispatch(h.window, { type: "submitQueuedSend", id: "33333333-3333-4333-8333-333333333333", text: echo.text });
      dispatch(h.window, { type: "queuedSends", items: [], queued: [] });
      dispatch(h.window, { type: "userMessage", ...echo });
      answer(h);
      expect(pending(h)).toBe(false);
    }
  });
});
