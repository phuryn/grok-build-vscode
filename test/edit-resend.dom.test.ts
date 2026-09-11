// Edit-and-resend (#56) — drives the REAL shipped media/chat.js in happy-dom.
//
// Edit and Rewind are exact complements: Rewind is hidden on the newest user
// message (the CLI tip isn't a valid rewind target), Edit is shown ONLY there.
// Between them every user message has a way back.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const send = (window: any, text: string) =>
  dispatch(window, { type: "userMessage", text, chips: [] });

const userBubbles = (doc: Document) => [...doc.querySelectorAll(".msg.user:not(.queued)")];
const editBtn = (el: Element) => el.querySelector(".msg-edit-btn") as HTMLButtonElement;
const rewindBtn = (el: Element) => el.querySelector(".msg-rewind-btn") as HTMLButtonElement;

describe("Edit on the latest user message (#56)", () => {
  it("shows Edit only on the newest message, exactly where Rewind is hidden", () => {
    const { window, doc } = bootWebview();
    send(window, "first");
    send(window, "second");
    send(window, "third");

    const users = userBubbles(doc);
    expect(users).toHaveLength(3);
    expect(users.map((el) => editBtn(el).hidden)).toEqual([true, true, false]);
    // The complement: Rewind is available on the older two, hidden on the tip.
    expect(users.map((el) => rewindBtn(el).hidden)).toEqual([false, false, true]);
  });

  it("moves Edit to the new tip when another message is sent", () => {
    const { window, doc } = bootWebview();
    send(window, "first");
    expect(editBtn(userBubbles(doc)[0]).hidden).toBe(false);
    send(window, "second");
    expect(userBubbles(doc).map((el) => editBtn(el).hidden)).toEqual([true, false]);
  });

  it("is offered on a lone first message — the primer is what it rewinds to", () => {
    const { window, doc } = bootWebview();
    send(window, "only message");
    // Rewind has nothing to target here, but Edit does (the hidden primer).
    expect(editBtn(userBubbles(doc)[0]).hidden).toBe(false);
    expect(rewindBtn(userBubbles(doc)[0]).hidden).toBe(true);
  });

  it("posts the bubble index and the bubble's own text", () => {
    const { window, posted, doc } = bootWebview();
    send(window, "first");
    send(window, "fix teh typo");

    click(window, editBtn(userBubbles(doc)[1]));
    expect(posted.find((m: any) => m.type === "editLastMessage")).toEqual({
      type: "editLastMessage",
      userBubbleIndex: 1,
      text: "fix teh typo",
      totalUserBubbles: 2,
    });
  });

  it("posts attached chips with editLastMessage when the message has attachments", () => {
    const { window, posted, doc } = bootWebview();
    const chip = {
      id: "image:/s/test.png:1:1",
      path: "/s/test.png",
      relPath: "Image #1",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    dispatch(window, {
      type: "userMessage",
      text: "with image",
      chips: [chip],
    });

    click(window, editBtn(userBubbles(doc)[0]));
    expect(posted.find((m: any) => m.type === "editLastMessage")).toEqual({
      type: "editLastMessage",
      userBubbleIndex: 0,
      text: "with image",
      chips: [expect.objectContaining({ id: chip.id })],
      totalUserBubbles: 1,
    });
  });

  it("does nothing mid-turn — the rewind underneath needs a settled session", () => {
    const { window, posted, doc } = bootWebview();
    send(window, "go");
    dispatch(window, { type: "agentStart" });
    click(window, editBtn(userBubbles(doc)[0]));
    expect(posted.filter((m: any) => m.type === "editLastMessage")).toHaveLength(0);
  });

  it("clicking a hidden Edit (older bubble) posts nothing", () => {
    const { window, posted, doc } = bootWebview();
    send(window, "first");
    send(window, "second");
    click(window, editBtn(userBubbles(doc)[0]));
    expect(posted.filter((m: any) => m.type === "editLastMessage")).toHaveLength(0);
  });
});

describe("restoreComposer (#56)", () => {
  const input = (doc: Document) => doc.querySelector("#input") as HTMLTextAreaElement;

  it("puts the rewound text back in the composer and focuses it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "restoreComposer", text: "fix teh typo" });
    expect(input(doc).value).toBe("fix teh typo");
    expect(doc.activeElement).toBe(input(doc));
  });

  it("APPENDS rather than destroying text the user already typed", () => {
    // Losing typed work here would be the same class of bug Edit exists to fix.
    const { window, doc } = bootWebview();
    input(doc).value = "meanwhile I typed this";
    dispatch(window, { type: "restoreComposer", text: "the original message" });
    expect(input(doc).value).toBe("meanwhile I typed this\n\nthe original message");
  });

  it("leaves the caret at the end so typing continues the restored text", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "restoreComposer", text: "hello" });
    expect(input(doc).selectionStart).toBe(5);
    expect(input(doc).selectionEnd).toBe(5);
  });

  it("tolerates a missing text field instead of writing 'undefined'", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "restoreComposer" } as any);
    expect(input(doc).value).toBe("");
  });
});

// A steered (interjected) message paints a user bubble but is NOT a prompt and
// has no rewind point. Before the fix it consumed a bubble index, so every
// later bubble mapped to the wrong turn: Rewind would have targeted (and
// reverted files from) the wrong message, and Edit failed outright, reporting
// the tenth message as the session's first. Reproduced from a real session.
describe("steered messages don't consume a rewind index (#52/#56)", () => {
  const steer = (window: any, text: string) =>
    dispatch(window, { type: "userMessage", text, chips: [], steer: true });

  it("keeps later bubbles' indices aligned with the prompt list", () => {
    const { window, doc } = bootWebview();
    send(window, "first");
    steer(window, "(Read only)");
    send(window, "second");

    const idx = userBubbles(doc).map((el) => (el as HTMLElement).dataset.userBubbleIndex);
    // The steer takes no slot: "second" is prompt 1, not prompt 2.
    expect(idx).toEqual(["0", undefined, "1"]);
  });

  it("offers neither Edit nor Rewind on a steer bubble — there's nothing to roll back to", () => {
    const { window, doc } = bootWebview();
    send(window, "first");
    steer(window, "(Read only)");

    const steerEl = userBubbles(doc)[1];
    expect((steerEl as HTMLElement).dataset.steer).toBe("1");
    expect(editBtn(steerEl).hidden).toBe(true);
    expect(rewindBtn(steerEl).hidden).toBe(true);
  });

  it("puts Edit on the last REAL message when a steer is the newest bubble", () => {
    // The exact reported case: the steer was the final bubble on screen.
    const { window, doc } = bootWebview();
    send(window, "first");
    send(window, "second");
    steer(window, "(Read only)");

    const users = userBubbles(doc);
    expect(users.map((el) => editBtn(el).hidden)).toEqual([true, false, true]);
    expect((users[1] as HTMLElement).dataset.userBubbleIndex).toBe("1");
  });

  it("detects a steer replayed from history by its CLI envelope", () => {
    // On session/load the interjection comes back as a user_message_chunk
    // wrapped by the CLI — there is no `steer` flag to rely on.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "first" });
    dispatch(window, { type: "messageChunk", text: "on it" });
    dispatch(window, {
      type: "userMessageChunk",
      text: "The user sent a message while you were working:\n<user_query>\n(Read only)\n</user_query>",
    });
    dispatch(window, { type: "historyReplay", active: false });

    const steered = [...doc.querySelectorAll(".msg.user")].filter(
      (el) => (el as HTMLElement).dataset.steer === "1",
    );
    expect(steered.length).toBe(1);
    expect((steered[0] as HTMLElement).dataset.userBubbleIndex).toBeUndefined();
  });
});

// Rewind DISCARDS the message it targets (probe-verified), so it must hand the
// text back like Edit does — otherwise the button silently destroys what the
// user wrote. The CLI agrees: execute returns the discarded prompt's text.
describe("Rewind returns the discarded message's text too (#56)", () => {
  it("sends the bubble's own text with the rewind request", () => {
    const { window, posted, doc } = bootWebview();
    send(window, "first");
    send(window, "second");

    click(window, rewindBtn(userBubbles(doc)[0]));
    expect(posted.find((m: any) => m.type === "rewindSession")).toEqual({
      type: "rewindSession",
      userBubbleIndex: 0,
      text: "first",
      totalUserBubbles: 2,
    });
  });

  it("sends nothing when Rewind is hidden on the tip", () => {
    const { window, posted, doc } = bootWebview();
    send(window, "only");
    click(window, rewindBtn(userBubbles(doc)[0]));
    expect(posted.filter((m: any) => m.type === "rewindSession")).toHaveLength(0);
  });
});

// Rewind/edit used to clear the panel and replay the whole conversation, which
// flashed the welcome logo and re-rendered everything for what is a tail
// deletion. Now only the discarded turns are removed.
describe("truncateMessages removes only the tail (#56/P2-9)", () => {
  const turn = (window: any, user: string, agent: string) => {
    dispatch(window, { type: "userMessage", text: user, chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: agent });
    dispatch(window, { type: "agentEnd", meta: { totalTokens: 1 } });
  };
  const texts = (doc: Document) =>
    userBubbles(doc).map((el) => (el as HTMLElement).dataset.userBubbleIndex);

  it("keeps the surviving messages and drops the rest", () => {
    const { window, doc } = bootWebview();
    turn(window, "one", "reply-alpha");
    turn(window, "two", "reply-bravo");
    turn(window, "three", "reply-charlie");
    dispatch(window, { type: "truncateMessages", surviving: 2 });

    const users = userBubbles(doc);
    expect(users).toHaveLength(2);
    expect(users.map((el) => el.textContent)).toEqual([
      expect.stringContaining("one"),
      expect.stringContaining("two"),
    ]);
    // Everything after the surviving bubbles is gone — the discarded turn's
    // user message is not the last child any more.
    const kids = [...doc.querySelectorAll("#messages > .msg")];
    expect(kids[kids.length - 1]).toBe(users[1]);
  });

  it("does NOT show the welcome screen — the panel never empties", () => {
    const { window, doc } = bootWebview();
    turn(window, "one", "1");
    turn(window, "two", "2");
    dispatch(window, { type: "truncateMessages", surviving: 1 });
    const welcome = doc.getElementById("welcome") as HTMLElement | null;
    expect(welcome === null || welcome.hidden || welcome.style.display === "none").toBe(true);
    expect(userBubbles(doc)).toHaveLength(1);
  });

  it("renumbers the surviving bubbles so the next rewind targets correctly", () => {
    const { window, doc } = bootWebview();
    turn(window, "one", "1");
    turn(window, "two", "2");
    turn(window, "three", "3");
    dispatch(window, { type: "truncateMessages", surviving: 2 });
    expect(texts(doc)).toEqual(["0", "1"]);
  });

  it("moves Edit onto the new last message", () => {
    const { window, doc } = bootWebview();
    turn(window, "one", "1");
    turn(window, "two", "2");
    turn(window, "three", "3");
    dispatch(window, { type: "truncateMessages", surviving: 2 });
    const users = userBubbles(doc);
    expect(users.map((el) => editBtn(el).hidden)).toEqual([true, false]);
    expect(rewindBtn(users[1]).hidden).toBe(true); // tip has no Rewind
  });

  it("removes everything when nothing survives", () => {
    const { window, doc } = bootWebview();
    turn(window, "one", "1");
    dispatch(window, { type: "truncateMessages", surviving: 0 });
    expect(userBubbles(doc)).toHaveLength(0);
  });

  it("clears the discarded last-turn usage while keeping the surviving aggregate", () => {
    const { window, doc } = bootWebview();
    // Usage rows live in the coding-mode half of the context popover; knowledge
    // work stops at the number and Compact.
    dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 300, costUsdTicks: 30_000_000 },
      session: { inputTokens: 600, costUsdTicks: 60_000_000 },
    });
    dispatch(window, {
      type: "usage",
      session: { inputTokens: 100, costUsdTicks: 10_000_000 },
    });

    dispatch(window, { type: "truncateMessages", surviving: 1 });
    click(window, doc.getElementById("donut") as HTMLElement);

    const text = doc.getElementById("context-popover")!.textContent!;
    expect(text).toContain("Session total");
    expect(text).not.toContain("Last turn");
    expect(text).toContain("$0.001");
    expect(text).not.toContain("$0.003");
  });

  it("clears the session aggregate when rewind removes every turn", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "usage",
      turn: { inputTokens: 300, costUsdTicks: 30_000_000 },
      session: { inputTokens: 600, costUsdTicks: 60_000_000 },
    });

    dispatch(window, { type: "truncateMessages", surviving: 0 });
    click(window, doc.getElementById("donut") as HTMLElement);

    const text = doc.getElementById("context-popover")!.textContent!;
    expect(text).not.toContain("Session total");
    expect(text).not.toContain("Last turn");
    expect(text).not.toContain("Cost");
  });

  it("is a no-op when nothing is discarded", () => {
    const { window, doc } = bootWebview();
    turn(window, "one", "1");
    turn(window, "two", "2");
    dispatch(window, { type: "truncateMessages", surviving: 2 });
    expect(userBubbles(doc)).toHaveLength(2);
  });

  it("does not count a steered bubble when deciding what to keep", () => {
    const { window, doc } = bootWebview();
    turn(window, "one", "1");
    dispatch(window, { type: "userMessage", text: "(read only)", chips: [], steer: true });
    turn(window, "two", "2");
    dispatch(window, { type: "truncateMessages", surviving: 1 });
    // "one" survives WITH its steer; only the "two" turn goes.
    const remaining = userBubbles(doc);
    expect(remaining.map((el) => el.textContent)).toEqual([
      expect.stringContaining("one"),
      expect.stringContaining("read only"),
    ]);
  });
});

// Rewind/edit confirms were still native VS Code modals while every other
// destructive confirm moved in-chat in 2.0.0. They can't call uiConfirm
// themselves — only the host knows whether files are at stake — so the host
// asks and the webview answers.
describe("in-chat confirm round-trip", () => {
  const ask = (window: any, id = "c1") =>
    dispatch(window, {
      type: "uiConfirmRequest",
      id,
      title: "Rewind past this message?",
      body: "Files will be restored.",
      confirmLabel: "Rewind",
      danger: true,
    });
  const panel = (doc: Document) => doc.querySelector(".confirm-panel");
  const button = (doc: Document, label: string) =>
    [...doc.querySelectorAll(".confirm-panel button")].find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement;

  it("renders the host's dialog in-chat, not a native modal", () => {
    const { window, doc } = bootWebview();
    ask(window);
    expect(panel(doc)).not.toBeNull();
    expect(doc.body.textContent).toContain("Rewind past this message?");
    expect(doc.body.textContent).toContain("Files will be restored.");
  });

  it("answers true when confirmed, carrying the same id back", async () => {
    const { window, posted, doc } = bootWebview();
    ask(window, "abc");
    click(window, button(doc, "Rewind"));
    await Promise.resolve();
    expect(posted.find((m: any) => m.type === "uiConfirmAnswer")).toEqual({
      type: "uiConfirmAnswer", id: "abc", ok: true,
    });
  });

  it("answers FALSE on cancel — the host must not proceed", async () => {
    const { window, posted, doc } = bootWebview();
    ask(window, "xyz");
    click(window, button(doc, "Cancel"));
    await Promise.resolve();
    expect(posted.find((m: any) => m.type === "uiConfirmAnswer")).toEqual({
      type: "uiConfirmAnswer", id: "xyz", ok: false,
    });
  });

  it("always answers, so a rewind can never hang waiting on the dialog", async () => {
    const { window, posted, doc } = bootWebview();
    ask(window);
    click(window, button(doc, "Cancel"));
    await Promise.resolve();
    expect(posted.filter((m: any) => m.type === "uiConfirmAnswer")).toHaveLength(1);
  });
});

/**
 * The compatibility contract, in the one place this release forgot it.
 *
 * The relay serves the web client, so the browser is always as new as the last
 * deploy while the extension is whatever the user installed — and the release
 * order makes the relay FIRST. Rewind and Edit are host-local on every host
 * built before 4.1.0, which drops them without a reply: no error, no refusal,
 * nothing. Offering the buttons anyway gives every not-yet-updated user two
 * controls that quietly do nothing, which is worse than not having them.
 *
 * The sign-in work got this right (`remoteAgentSignIn`, `remoteGithubSignIn`);
 * rewind shipped without it. Found by the unsteered review round before 4.1.0.
 */
describe("Rewind and Edit are capability-gated for remotes (4.1.0)", () => {
  const caps = (window: any, capabilities: Record<string, unknown>) =>
    dispatch(window, { type: "initialState", cwd: "/proj", capabilities } as never);

  it("hides both against a host that never advertises remoteRewind", () => {
    const { window, doc } = bootWebview({ remote: true });
    caps(window, {});
    send(window, "first");
    send(window, "second");

    const users = userBubbles(doc);
    expect(users.map((el) => rewindBtn(el).hidden)).toEqual([true, true]);
    expect(users.map((el) => editBtn(el).hidden)).toEqual([true, true]);
  });

  it("shows them once the host says it accepts them", () => {
    const { window, doc } = bootWebview({ remote: true });
    caps(window, { remoteRewind: true });
    send(window, "first");
    send(window, "second");

    const users = userBubbles(doc);
    // Same complement as at the desk: Rewind on the older, Edit on the tip.
    expect(users.map((el) => rewindBtn(el).hidden)).toEqual([false, true]);
    expect(users.map((el) => editBtn(el).hidden)).toEqual([true, false]);
  });

  it("never gates the desk, which does not go through the relay at all", () => {
    const { window, doc } = bootWebview();
    caps(window, {});
    send(window, "first");
    send(window, "second");

    const users = userBubbles(doc);
    expect(users.map((el) => rewindBtn(el).hidden)).toEqual([false, true]);
    expect(users.map((el) => editBtn(el).hidden)).toEqual([true, false]);
  });
});
