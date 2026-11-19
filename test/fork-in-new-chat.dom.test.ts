import { expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

function announce(h: Harness, provider: string, turnForkSupported?: boolean) {
  dispatch(h.window, { type: "session", sessionId: "source", provider, models: [], currentModelId: "model" });
  dispatch(h.window, { type: "sessionName", sessionId: "source", name: "Source", cwd: "/repo", turnForkSupported });
}

function openContinue(h: Harness) {
  click(h.window, h.doc.querySelector(".rail-menu-btn")!);
  return [...h.doc.querySelectorAll(".rail-menu-item")].find(el => el.textContent?.includes("Continue in a new chat"));
}

function forkButtons(h: Harness, role: string) {
  return [...h.doc.querySelectorAll<HTMLButtonElement>(`.msg.${role} .msg-fork-btn`)];
}

it.each(["claude", "codex"])("offers %s's whole fork and only the settled bubble actions", (provider) => {
  const h = bootWebview({ vscode: true });
  announce(h, provider, true);
  click(h.window, openContinue(h)!);
  expect(h.posted).toContainEqual({ type: "forkSession", sessionId: "source" });
  expect(h.doc.querySelector("#gear-popover")!.textContent).not.toContain("Use a new worktree");
  dispatch(h.window, { type: "userMessage", text: "First prompt" });
  dispatch(h.window, { type: "agentStart" });
  dispatch(h.window, { type: "messageChunk", text: "Opening narration", messageId: "opening" });
  dispatch(h.window, { type: "toolCall", call: { toolCallId: "tool1", kind: "execute", title: "Read", status: "completed" } });
  dispatch(h.window, { type: "userMessage", steer: true, text: "Mid-turn correction" });
  dispatch(h.window, { type: "messageChunk", text: "Last reply", messageId: "end" });
  expect(forkButtons(h, "agent")).toHaveLength(0);
  dispatch(h.window, { type: "promptComplete" });
  dispatch(h.window, { type: "agentEnd", forkPoint: "end" });
  dispatch(h.window, { type: "userMessage", text: "Second prompt", chips: [{ id: "f", relPath: "a.txt" }], forkBefore: "end" });
  dispatch(h.window, { type: "queuedSends", items: ["Still in the queue"] });

  const [reply] = forkButtons(h, "agent");
  const [edit] = forkButtons(h, "user");
  expect(forkButtons(h, "agent")).toHaveLength(1);
  expect(forkButtons(h, "user")).toHaveLength(1);
  expect(reply.parentElement!.hidden).toBe(false);
  expect(reply.closest(".msg")?.querySelector(".body")?.textContent).toBe("Last reply");
  expect(reply.title).toBe("Go back to here in a new chat");
  expect(edit.title).toBe("Edit in a new chat");
  expect(h.doc.querySelector(".msg.user[data-steer] .msg-fork-btn")).toBeNull();
  expect(h.doc.querySelector(".msg.queued .msg-fork-btn")).toBeNull();
  click(h.window, reply);
  click(h.window, edit);
  expect(h.posted.filter(m => m.type === "forkAtReply")).toEqual([
    { type: "forkAtReply", sessionId: "source", messageId: "end" },
    { type: "forkAtReply", sessionId: "source", messageId: "end", draft: "Second prompt" },
  ]);
});

it.each(["claude", "codex", "grok"])("keeps %s on the older host's controls without a new capability", (provider) => {
  const h = bootWebview({ vscode: true });
  announce(h, provider);
  for (let i = 0; i < 2; i++) {
    dispatch(h.window, { type: "userMessage", text: `Prompt ${i}` });
    dispatch(h.window, { type: "agentStart" });
    dispatch(h.window, { type: "messageChunk", text: `Answer ${i}` });
    dispatch(h.window, { type: "agentEnd" });
  }
  expect(h.doc.querySelector(".msg-fork-btn")).toBeNull();
  expect(!!openContinue(h)).toBe(provider === "grok");
  expect(!!h.doc.querySelector(".msg-rewind-btn:not([hidden])")).toBe(provider === "grok");
  expect(!!h.doc.querySelector(".msg-edit-btn:not([hidden])")).toBe(provider === "grok");
  expect(h.posted.some(m => m.type === "forkAtReply")).toBe(false);
});

it("keeps phone reply points aligned as a replay window prepends older turns", () => {
  const h = bootWebview({ remote: true, beforeScripts: w => { (w as any).__grokHistoryWindow = 1; } });
  dispatch(h.window, { type: "historyReplay", active: true });
  dispatch(h.window, { type: "historyBatch", messages: [
    { type: "userMessageChunk", text: "First prompt", startsMessage: true },
    { type: "messageChunk", text: "First reply", messageId: "end-1", forkPoint: "end-1" },
    { type: "userMessageChunk", text: "Early ", startsMessage: true, forkBefore: "end-1" },
    { type: "userMessageChunk", text: "prompt" },
    { type: "messageChunk", text: "Opening reply", messageId: "opening" },
    { type: "userMessageChunk", text: "Steered text", startsMessage: true },
    { type: "messageChunk", text: "Second reply", messageId: "end-2", forkPoint: "end-2" },
    { type: "userMessageChunk", text: "Final prompt", startsMessage: true, forkBefore: "end-2" },
    { type: "messageChunk", text: "Final reply", messageId: "end-3", forkPoint: "end-3" },
  ] });
  dispatch(h.window, { type: "historyReplay", active: false });
  // On reconnect, the session identity can arrive after the history batch.
  announce(h, "codex", true);
  expect(h.doc.body.classList.contains("turn-fork-supported")).toBe(true);
  click(h.window, openContinue(h)!);
  expect(h.posted).toContainEqual({ type: "forkSession", sessionId: "source" });
  expect(forkButtons(h, "user").map(btn => btn.dataset.messageId)).toEqual(["end-2"]);
  (h.window as any).__grokHistory.expandAll();
  expect(forkButtons(h, "user").map(btn => btn.dataset.messageId)).toEqual(["end-1", "end-2"]);
  expect(forkButtons(h, "agent").map(btn => btn.dataset.messageId)).toEqual(["end-1", "end-2", "end-3"]);
  click(h.window, forkButtons(h, "user")[0]);
  expect(h.posted).toContainEqual({ type: "forkAtReply", sessionId: "source", messageId: "end-1", draft: "Early prompt" });
  dispatch(h.window, { type: "forkPointsCleared" });
  expect(h.doc.querySelector(".msg-fork-btn")).toBeNull();
});

it("restores only text in the fork's composer", () => {
  const h = bootWebview({ remote: true });
  announce(h, "claude", true);
  dispatch(h.window, { type: "clearMessages" });
  dispatch(h.window, { type: "sessionName", sessionId: "fork", name: "(Fork) Source", cwd: "/repo", turnForkSupported: true });
  dispatch(h.window, { type: "restoreComposer", sessionId: "fork", text: "Original prompt text", draft: true });
  expect((h.doc.querySelector("#input") as HTMLTextAreaElement).value).toBe("Original prompt text");
  expect(h.doc.querySelector("#chips")?.textContent).toBe("");
  expect(h.posted.some(m => m.type === "send")).toBe(false);
});
