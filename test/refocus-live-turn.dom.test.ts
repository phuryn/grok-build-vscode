// A conversation opened from history, then answered live, then switched away
// from and back to. The host rebuilds the view from its buffer inside its own
// historyReplay bracket, and that buffer still holds the open's own bracket, so
// the open's end is an INNER end and commits nothing. The live prompt must
// still end the last history reply: before this, the new reply was appended to
// it ("okHONEYDEW") and the prompt sat below, looking unanswered.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const INIT = {
  type: "initialState",
  effort: "",
  cwd: "/w",
  useCtrlEnter: false,
  extVersion: "0",
  showThinking: false,
};

function transcript(doc: Document) {
  return [...doc.querySelectorAll("#messages .msg.user, #messages .msg.agent")].map((el) => {
    const role = el.classList.contains("user") ? "user" : "agent";
    return `${role}:${(el.querySelector(".body")?.textContent ?? "").trim()}`;
  });
}

describe("re-focusing a history-opened chat with a live turn", () => {
  it("keeps the live reply in its own message, after its prompt", () => {
    const { window, doc } = bootWebview();
    dispatch(window, INIT);

    // focusSession: clear, then its own bracket around the buffer.
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "historyReplay", active: true });
    // The buffer: the cold open's replay, bracketed...
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "say ok" });
    dispatch(window, { type: "messageChunk", text: "ok" });
    dispatch(window, { type: "historyReplay", active: false });
    // ...then the live turn sent after it.
    dispatch(window, { type: "userMessage", text: "say HONEYDEW", chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "HONEYDEW" });
    dispatch(window, { type: "promptComplete" });
    dispatch(window, { type: "historyReplay", active: false });

    expect(transcript(doc)).toEqual([
      "user:say ok",
      "agent:ok",
      "user:say HONEYDEW",
      "agent:HONEYDEW",
    ]);
  });

  it("a steer stays inside the running reply", () => {
    const { window, doc } = bootWebview();
    dispatch(window, INIT);
    dispatch(window, { type: "userMessage", text: "go", chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "part one" });
    dispatch(window, { type: "userMessage", text: "also this", chips: [], steer: true });
    dispatch(window, { type: "messageChunk", text: " part two" });
    dispatch(window, { type: "promptComplete" });

    const agents = [...doc.querySelectorAll("#messages .msg.agent .body")].map((el) => el.textContent?.trim());
    expect(agents).toEqual(["part one part two"]);
  });
});
