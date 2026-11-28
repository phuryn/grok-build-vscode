import { expect, it } from "vitest";
import { bootWebview, click, dispatch, type Posted } from "./webview-harness";

// A desktop side chat closes with the conversation it shows, and its Files
// panel with it. Deleting that conversation from the chat's own Session history
// must ask about unsaved file edits first, as closing the chat with × does.
function sidePaneWithHistory(filesAnswer: boolean) {
  const h = bootWebview({ vscode: true,
    beforeScripts: win => {
      win.document.body.dataset.editorChat = "true";
      (win as unknown as { grokDesktopShell: boolean }).grokDesktopShell = true;
    },
  });
  const asked: number[] = [];
  (h.window as unknown as { __grokDeskFtBeforeClose: () => Promise<boolean> }).__grokDeskFtBeforeClose = () => {
    asked.push(1);
    return Promise.resolve(filesAnswer);
  };
  dispatch(h.window, { type: "editorChatBinding", sessionId: "s1" });
  dispatch(h.window, { type: "editorChatBound", binding: 1 });
  dispatch(h.window, {
    type: "initialState", useCtrlEnter: false,
    capabilities: { deleteActiveSession: true },
  });
  click(h.window, h.doc.getElementById("history-btn") as HTMLElement);
  dispatch(h.window, { type: "sessions", entries: [
    { id: "s1", displayName: "Open here", provider: "grok", numMessages: 2, lastModified: 1 },
  ], activeId: "s1" });
  return { ...h, asked };
}

const deletes = (posted: Posted[]) => posted.filter(m =>
  m.type === "deleteSession" || (m.type === "editorChatAction" && (m.message as Posted | undefined)?.type === "deleteSession"));

async function confirmDelete(h: ReturnType<typeof sidePaneWithHistory>) {
  click(h.window, h.doc.querySelector(".history-row .history-action-danger") as HTMLElement);
  click(h.window, h.doc.querySelector(".confirm-overlay .confirm-danger") as HTMLElement);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

it("keeps the conversation when the Files panel's unsaved edits are not discarded", async () => {
  const h = sidePaneWithHistory(false);
  await confirmDelete(h);
  expect(h.asked).toHaveLength(1);
  expect(deletes(h.posted)).toEqual([]);
});

it("deletes once the Files panel's unsaved edits are discarded", async () => {
  const h = sidePaneWithHistory(true);
  await confirmDelete(h);
  expect(h.asked).toHaveLength(1);
  expect(deletes(h.posted)).toHaveLength(1);
});
