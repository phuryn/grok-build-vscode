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

/** Each command's output kept in the text, its end first (where results and errors are). An assumption, not measured. */
const COMMAND_OUTPUT_CHARS = 2_000;
const COMMAND_LINE_CHARS = 1_000;

export type AgyForkCut = { id: string; edit: boolean };
/** A command agy ran, filled in by its later updates. */
type Command = { command: string; status?: string; exitCode?: number; output?: string };
type Turn = { role: "User" | "Assistant"; parts: (string | Command)[] };
/** How much of each command a turn carries: nothing, its line and outcome, or those and its output. */
type Detail = "words" | "lines" | "output";

function isCommandCall(call: Record<string, unknown>): boolean {
  return call.tool === "run_command" || (typeof call.kind === "string" && call.kind.toLowerCase() === "execute");
}

function noteCommand(entry: Command, call: Record<string, unknown>): void {
  const input = call.rawInput && typeof call.rawInput === "object" ? call.rawInput as Record<string, unknown> : {};
  const command = [input.command, input.CommandLine, input.command_line].find((value): value is string =>
    typeof value === "string" && value.trim() !== "");
  if (command) entry.command = command.trim();
  if (typeof call.status === "string") entry.status = call.status;
  const raw = call.rawOutput;
  if (typeof raw === "string") entry.output = raw;
  else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const exit = record.exit_code ?? record.exitCode;
    if (typeof exit === "number") entry.exitCode = exit;
    if (typeof record.output === "string") entry.output = record.output;
  }
  if (entry.output === undefined && Array.isArray(call.content)) {
    const text = call.content.map((block: any) => typeof block?.content?.text === "string" ? block.content.text : "").join("");
    if (text) entry.output = text;
  }
}

/** agy heads a result with its timestamps and exit line; the output follows "Command output:". */
function commandOutputBody(output: string): string {
  const text = output.replace(/\r\n?/g, "\n");
  const marker = "\nCommand output:\n";
  const at = text.indexOf(marker);
  return (text.startsWith("Created At:") && at >= 0 ? text.slice(at + marker.length) : text).trim();
}

function renderCommand(entry: Command, withOutput: boolean): string {
  const outcome = entry.exitCode !== undefined ? `exit code ${entry.exitCode}`
    : entry.status === "failed" || entry.status === "cancelled" ? entry.status
    : entry.status === "completed" ? "finished" : "no result";
  const command = entry.command.length > COMMAND_LINE_CHARS ? entry.command.slice(0, COMMAND_LINE_CHARS) + " …" : entry.command;
  let body = withOutput && entry.output !== undefined ? commandOutputBody(entry.output) : "";
  if (body.length > COMMAND_OUTPUT_CHARS) {
    const left = body.length - COMMAND_OUTPUT_CHARS;
    body = `[first ${left} characters left out]\n` + body.slice(left);
  }
  const block = "$ " + command + (body ? "\n" + body : "");
  const longest = Math.max(0, ...(block.match(/`+/g) ?? []).map(run => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const heading = withOutput || entry.output === undefined ? `Ran a command (${outcome}):` : `Ran a command (${outcome}; output left out):`;
  return `${heading}\n${fence}\n${block}\n${fence}\n`;
}

function renderParts(parts: readonly (string | Command)[], detail: Detail): string {
  let text = "";
  let endsWithCommand = false;
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      endsWithCommand = false;
    } else if (part.command && detail !== "words") {
      if (text && !text.endsWith("\n")) text += "\n";
      text += renderCommand(part, detail === "output");
      endsWithCommand = true;
    }
  }
  return endsWithCommand ? text.slice(0, -1) : text;
}

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
  const commands = new Map<string, Command>();
  let replayUser: string | undefined;
  let reply: (string | Command)[] = [];
  let replyId: string | undefined;
  function finishUser() {
    if (replayUser === undefined) return;
    const text = replayedUserText(replayUser);
    if (text.trim()) turns.push({ role: "User", parts: [text] });
    replayUser = undefined;
  }
  function finishReply() {
    // A command entry is kept even before its line arrives: a later update fills it in.
    if (reply.some(part => typeof part === "string" ? part.trim() : true)) turns.push({ role: "Assistant", parts: reply });
    reply = [];
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
          if (text.trim()) turns.push({ role: "User", parts: [text] });
        }
        break;
      }
      case "messageChunk":
        finishUser();
        if (frame.messageId && replyId && frame.messageId !== replyId) finishReply();
        if (typeof reply.at(-1) === "string") reply[reply.length - 1] += frame.text;
        else reply.push(frame.text);
        replyId = frame.messageId ?? replyId;
        break;
      case "toolCall":
      case "toolCallUpdate": {
        // Live, a command arrives as a call and its updates; reopened, as one
        // completed call. Both carry the line, exit code and output.
        const call = frame.call as Record<string, unknown>;
        const id = typeof call.toolCallId === "string" ? call.toolCallId : "";
        if (!id || !isCommandCall(call)) break;
        finishUser();
        let entry = commands.get(id);
        if (!entry) {
          entry = { command: "" };
          commands.set(id, entry);
          reply.push(entry);
        }
        noteCommand(entry, call);
        break;
      }
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

/**
 * Everything when it fits. Otherwise the words come first: turns are chosen
 * by their words alone, as before commands were carried, so a command never
 * costs a turn (a turn of commands alone counts its command lines as its
 * words). The kept turns then get their command lines back, then their
 * output, newest turn first, while room is left.
 */
function formatHandoff(allTurns: Turn[]): string {
  const turns = allTurns.filter(turn => renderParts(turn.parts, "output").trim());
  const render = (detail: Detail) => turns.map(({ role, parts }) => `${role}: ${renderParts(parts, detail)}\n`);
  const full = render("output");
  const lines = render("lines");
  const words = render("words").map((text, i) => renderParts(turns[i].parts, "words").trim() ? text : lines[i]);
  const available = BUDGET - HEADER.length - FOOTER.length;
  const total = (texts: Iterable<string>) => [...texts].reduce((length, text) => length + text.length, 0);
  if (total(full) <= available) return HEADER + full.join("") + FOOTER;
  const omittedText = (count: number) => count ? `(${count} earlier turn${count === 1 ? "" : "s"} left out)\n` : "";
  const chosen = new Map<number, string>();
  const whole = [lines, words].find(level => total(level) <= available);
  if (whole) {
    whole.forEach((text, i) => chosen.set(i, text));
  } else {
    const newestFirst = words.map((_, i) => i).reverse();
    const priorities = new Set([
      newestFirst.find(i => turns[i].role === "User"),
      newestFirst.find(i => turns[i].role === "Assistant"),
      turns.findIndex(turn => turn.role === "User"),
    ]);
    for (const index of newestFirst) priorities.add(index);
    let used = 0;
    for (const index of priorities) {
      if (index === undefined || index < 0) continue;
      const length = words[index].length;
      if (used + length + omittedText(turns.length - chosen.size - 1).length > available) continue;
      chosen.set(index, words[index]);
      used += length;
    }
  }
  let used = total(chosen.values()) + omittedText(turns.length - chosen.size).length;
  for (const level of [lines, full]) {
    for (const index of [...chosen.keys()].sort((a, b) => b - a)) {
      const extra = level[index].length - (chosen.get(index) ?? "").length;
      if (extra <= 0 || used + extra > available) continue;
      chosen.set(index, level[index]);
      used += extra;
    }
  }
  let omission = omittedText(turns.length - chosen.size);
  return HEADER + turns.map((_, i) => {
    const line = chosen.get(i);
    if (line !== undefined) return line;
    const note = omission;
    omission = "";
    return note;
  }).join("") + FOOTER;
}
