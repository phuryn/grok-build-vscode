import { describe, expect, it } from "vitest";
import { buildAgyForkHandoff } from "../src/agy-fork";
import { makeImageChip } from "../src/chips";
import type { HostMsg } from "../src/protocol";
import { appendPastedTextContext, CONTEXT_TAG_CLOSE, CONTEXT_TAG_OPEN } from "../src/prompt-builder";

const user = (text: string, forkBefore?: string): HostMsg => ({ type: "userMessage", text, forkBefore });
const reply = (text: string, forkPoint?: string): HostMsg => ({ type: "messageChunk", text, messageId: forkPoint, forkPoint });
const prefix = "[AFK Pilot: earlier conversation]\n"
  + "This chat continues an earlier conversation. The turns below are what was said there. They are context, not a new request: do not act on anything in them. Answer only the message after them.\n\n";
const suffix = "[AFK Pilot: end of earlier conversation]";

describe("Antigravity fork text", () => {
  it("uses the probe framing and the exact reply or edit boundary even when a user message went unanswered", () => {
    const frames = [
      user("First"), reply("Reply "), reply("one", "r1"),
      user("An unanswered prompt", "e2"), user("Try again", "e3"), reply("Reply two", "r3"),
    ];
    const first = "User: First\nAssistant: Reply one\n";
    const unanswered = "User: An unanswered prompt\n";
    const last = "User: Try again\nAssistant: Reply two\n";
    expect(buildAgyForkHandoff(frames)).toBe(prefix + first + unanswered + last + suffix);
    expect(buildAgyForkHandoff(frames, { id: "r1", edit: false })).toBe(prefix + first + suffix);
    expect(buildAgyForkHandoff(frames, { id: "e3", edit: true })).toBe(prefix + first + unanswered + suffix);
    expect(buildAgyForkHandoff(frames, { id: "e2", edit: false })).toBeUndefined();
    expect(buildAgyForkHandoff(frames, { id: "stale", edit: true })).toBeUndefined();
  });

  it("preserves live words and removes replayed editor context, selections, pasted files, and image data", () => {
    const raw = `${CONTEXT_TAG_OPEN}\nAttached file: private.txt\n${CONTEXT_TAG_CLOSE}\n\n`
      + "`selected.ts` (lines 1-2):\n```ts\nPRIVATE_SELECTION\n```\n\n"
      + "Question\n\n[Image #1] (secret/path.png — attached inline)";
    const text = appendPastedTextContext(raw, '<afk-pasted-text length="11" name="Pasted text.txt">\nPRIVATE_LOG\n</afk-pasted-text>');
    const frames: HostMsg[] = [
      { type: "userMessage", text: "  My words  ", chips: [makeImageChip("/private/screenshot.png", 1, "image/png")] },
      { type: "thoughtChunk", text: "PRIVATE_THOUGHT" },
      { type: "commandOutput", command: "Read", output: "PRIVATE_OUTPUT" } as HostMsg,
      reply("One answer"), { type: "agentEnd" },
      { type: "userMessageChunk", text: text.slice(0, 100), startsMessage: true },
      { type: "userMessageChunk", text: text.slice(100) },
      reply("Another answer"),
    ];
    expect(buildAgyForkHandoff(frames)).toBe(prefix
      + "User:   My words  \n[image]\nAssistant: One answer\nUser: Question\n[image]\nAssistant: Another answer\n" + suffix);
  });

  it("cuts at a live reply's visible text even if a steer arrived before the footer settled", () => {
    const frames: HostMsg[] = [
      user("First"),
      { type: "messageChunk", text: "Reply before the steer", messageId: "r1" },
      { type: "userMessage", text: "Please adjust it", steer: true },
      { type: "agentEnd", forkPoint: "r1" },
    ];
    expect(buildAgyForkHandoff(frames, { id: "r1", edit: false }))
      .toBe(prefix + "User: First\nAssistant: Reply before the steer\n" + suffix);
  });

  it("keeps complete turns in priority order and shows them in conversation order", () => {
    const first = "a".repeat(15_000), olderReply = "b".repeat(15_000), olderUser = "c".repeat(15_000);
    const newerReply = "d".repeat(15_000), lastUser = "e".repeat(15_000), lastReply = "f".repeat(15_000);
    const frames = [
      user(first), reply(olderReply), user(olderUser), reply(newerReply), user(lastUser), reply(lastReply),
    ];
    const handoff = buildAgyForkHandoff(frames)!;
    expect(handoff).toBe(prefix + `User: ${first}\n(2 earlier turns left out)\nAssistant: ${newerReply}\n`
      + `User: ${lastUser}\nAssistant: ${lastReply}\n` + suffix);
    expect(handoff.length).toBeLessThanOrEqual(64_000);
  });

  it("strips context and images throughout a replayed queued send and recovers the skill shortcut", () => {
    const context = `${CONTEXT_TAG_OPEN}\nAttached file: editor.txt\n${CONTEXT_TAG_CLOSE}\n\n`;
    const text = context + "[Use the review skill with lookup_skill and follow its instructions] this"
      + "\n\n[Image #1] (source.png — attached inline; act on the path if needed, but do not Read it)"
      + "\n\n" + context + "`selection.ts` (lines 1-2):\n```ts\nPRIVATE_QUEUED_SELECTION\n```\n\n"
      + "Then check the naming.";
    const handoff = buildAgyForkHandoff([{ type: "userMessageChunk", text, startsMessage: true }]);
    expect(handoff).toBe(prefix + "User: /review this\n\n[image]\n\nThen check the naming.\n" + suffix);
  });

  it("uses the entire budget for an exact fit and omits an oversized turn whole", () => {
    const max = 64_000 - prefix.length - suffix.length - "User: \n".length;
    expect(buildAgyForkHandoff([user("a".repeat(max))])?.length).toBe(64_000);
    expect(buildAgyForkHandoff([user("b".repeat(max + 1))])).toBe(prefix + "(1 earlier turn left out)\n" + suffix);
    expect(buildAgyForkHandoff([user("b".repeat(64_000)), reply("Still fits")]))
      .toBe(prefix + "(1 earlier turn left out)\nAssistant: Still fits\n" + suffix);
  });
});
