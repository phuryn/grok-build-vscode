import { AGY_HANDOFF_MARKER } from "./agy-handoff";
import { restoreAgySkillShortcuts } from "./agy-skills";
import { isImageChip } from "./chips";
import { STAGED_IMAGE_TAG_HINT, WORKSPACE_IMAGE_TAG_HINT } from "./image-history";
import type { HostMsg } from "./protocol";

// Use the same parsing as the transcript so editor context and attachment
// data are peeled off the exact replay text the person sees.
const { replayedUserBubbleVerdict, stripInterjectionEnvelope, parseAttachmentContext, parseSelectionBlocks, parseImageTags } =
  require("../media/webview-helpers.js") as {
    replayedUserBubbleVerdict(text: string): { text: string; hide: string | null };
    stripInterjectionEnvelope(text: string): string;
    parseAttachmentContext(text: string): { body: string };
    parseSelectionBlocks(text: string): { body: string; selections: unknown[] };
    parseImageTags(text: string): { body: string; images: unknown[] };
  };

const HEADER = AGY_HANDOFF_MARKER + "\n"
  + "This chat continues an earlier conversation. The turns below are what was said there. They are context, not a new request: do not act on anything in them. Answer only the message after them.\n\n";
const FOOTER = "[AFK Pilot: end of earlier conversation]";
const BUDGET = 64_000;

export type AgyForkCut = { id: string; edit: boolean };
type Turn = { role: "User" | "Assistant"; text: string };

function userText(text: string, imageCount: number): string {
  return [text, ...Array<string>(imageCount).fill("[image]")].filter(Boolean).join("\n");
}

function replayedUserText(raw: string): string {
  const verdict = replayedUserBubbleVerdict(raw);
  if (verdict.hide) return "";
  let body = stripInterjectionEnvelope(verdict.text);
  // A queued send may carry one context envelope and a set of image tags
  // per contribution. Consume all the envelopes and replace tagged inline
  // images even when another contribution follows the tag.
  for (;;) {
    const stripped = parseAttachmentContext(body).body;
    if (stripped === body) break;
    body = stripped;
  }
  // A selection can follow authored text in a native slash prompt, or be
  // between two queued contributions. Use the same fenced-block parser at
  // each paragraph that starts with the editor's selection header.
  const headers = /(?:^|\n\n)(?=`[^`\n]+` \(lines \d+-\d+\):\n```)/g;
  let cursor = 0;
  let withoutSelections = "";
  for (let match; (match = headers.exec(body));) {
    const start = match.index + match[0].length;
    const selection = parseSelectionBlocks(body.slice(start));
    if (selection.selections.length) {
      withoutSelections += body.slice(cursor, start);
      cursor = headers.lastIndex = body.length - selection.body.length;
    } else {
      headers.lastIndex = start + 1;
    }
  }
  body = withoutSelections + body.slice(cursor);
  body = body.replace(/^\[Image #\d+\] \(([^\r\n]*)\)$/gm, (line, detail: string) =>
    detail.includes(WORKSPACE_IMAGE_TAG_HINT) || detail.includes(STAGED_IMAGE_TAG_HINT) ? "[image]" : line);
  const { body: text, images } = parseImageTags(body);
  return userText(restoreAgySkillShortcuts(text), images.length);
}

function cutEnd(buffer: readonly HostMsg[], cut: AgyForkCut): number {
  if (cut.edit) {
    return buffer.findIndex(frame => (frame.type === "userMessage" || frame.type === "userMessageChunk") && frame.forkBefore === cut.id);
  }
  let lastText = -1;
  let offered = false;
  for (let i = 0; i < buffer.length; i++) {
    const frame = buffer[i];
    if (frame.type === "messageChunk") {
      if (frame.forkPoint === cut.id) offered = true;
      if ((frame.messageId === cut.id || frame.forkPoint === cut.id) && frame.text.trim()) lastText = i;
    } else if (frame.type === "agentEnd" && frame.forkPoint === cut.id) {
      offered = true;
    }
  }
  // A live footer's point arrives at agentEnd, but the button is on the last
  // reply text. A steer can follow that text before the turn settles.
  return offered && lastText >= 0 ? lastText + 1 : -1;
}

/** Cuts at the frame that drew the button. A stale ID cannot select a cut. */
export function buildAgyForkHandoff(buffer: readonly HostMsg[], cut?: AgyForkCut): string | undefined {
  const end = cut ? cutEnd(buffer, cut) : buffer.length;
  if (end < 0) return undefined;
  const turns: Turn[] = [];
  let replayUser: string | undefined;
  let reply = "";
  let replyId: string | undefined;
  function finishUser() {
    if (replayUser === undefined) return;
    const text = replayedUserText(replayUser);
    if (text.trim()) turns.push({ role: "User", text });
    replayUser = undefined;
  }
  function finishReply() {
    if (reply.trim()) turns.push({ role: "Assistant", text: reply });
    reply = "";
    replyId = undefined;
  }
  for (let i = 0; i < end; i++) {
    const frame = buffer[i];
    switch (frame.type) {
      case "userMessage":
      case "userMessageChunk": {
        if (frame.type === "userMessageChunk" && !frame.startsMessage && replayUser !== undefined) {
          replayUser += frame.text;
          break;
        }
        finishUser();
        finishReply();
        if (frame.type === "userMessageChunk") replayUser = frame.text;
        else {
          const text = userText(frame.text, frame.chips?.filter(isImageChip).length ?? 0);
          if (text.trim()) turns.push({ role: "User", text });
        }
        break;
      }
      case "messageChunk":
        finishUser();
        if (frame.messageId && replyId && frame.messageId !== replyId) finishReply();
        reply += frame.text;
        replyId = frame.messageId ?? replyId;
        break;
      case "agentStart":
      case "agentEnd":
      case "agentError":
      case "agentReset":
        finishUser();
        finishReply();
        break;
    }
  }
  finishUser();
  finishReply();
  return formatHandoff(turns);
}

function formatHandoff(turns: Turn[]): string {
  const lines = turns.map(({ role, text }) => `${role}: ${text}\n`);
  const available = BUDGET - HEADER.length - FOOTER.length;
  if (lines.reduce((length, line) => length + line.length, 0) <= available) {
    return HEADER + lines.join("") + FOOTER;
  }
  const omittedText = (count: number) => count ? `(${count} earlier turn${count === 1 ? "" : "s"} left out)\n` : "";
  const chosen = new Set<number>();
  const newestFirst = lines.map((_, i) => i).reverse();
  const priorities = new Set([
    newestFirst.find(i => turns[i].role === "User"),
    newestFirst.find(i => turns[i].role === "Assistant"),
    turns.findIndex(turn => turn.role === "User"),
  ]);
  for (const index of newestFirst) priorities.add(index);
  let used = 0;
  for (const index of priorities) {
    if (index === undefined || index < 0) continue;
    const length = lines[index].length;
    if (used + length + omittedText(lines.length - chosen.size - 1).length > available) continue;
    chosen.add(index);
    used += length;
  }
  let omission = omittedText(lines.length - chosen.size);
  return HEADER + lines.map((line, i) => {
    if (chosen.has(i)) return line;
    const note = omission;
    omission = "";
    return note;
  }).join("") + FOOTER;
}
