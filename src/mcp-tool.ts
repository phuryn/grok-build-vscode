/**
 * Pure MCP tool-call normalizers.
 *
 * Providers agree on nothing (research/mcp-shapes.md). IN, OUT, and the
 * tool's own name each live in a different field, and grok/codex send no
 * `content` on the completed update — so the shell IN/OUT path cannot
 * reuse `content` unchanged. This module is the host-side normalizer:
 * fold grok `search_tool` into the explore group (stamp `kind:"search"`),
 * drop Codex startup rows (failed startups go to the host log), stamp
 * `detailInput` (always, on recognized MCP rows), and emit `commandOutput`
 * joined by `toolCallId`.
 */

import { capCommandOutput, MAX_COMMAND_OUTPUT_CHARS, type CommandOutputPayload } from "./acp-dispatch";

/** Pretty-printed empty-object IN. A no-argument call still gets a row. */
export const EMPTY_MCP_ARGS = "{}";

/** ACP kind that `categorize` in chat.js rolls up as "Explored N items". */
export const MCP_MACHINERY_KIND = "search";

export type McpPrepareState = {
  machineryIds: Set<string>;
  searchIds: Set<string>;
  startupServerById: Map<string, string>;
  mcpIds: Set<string>;
  inputById: Map<string, string>;
  emittedOutputIds: Set<string>;
};

export function createMcpPrepareState(): McpPrepareState {
  return {
    machineryIds: new Set(),
    searchIds: new Set(),
    startupServerById: new Map(),
    mcpIds: new Set(),
    inputById: new Map(),
    emittedOutputIds: new Set(),
  };
}

export type PreparedMcpToolCall =
  | { action: "drop"; logLine?: string }
  | { action: "emit"; call: Record<string, unknown>; commandOutput: CommandOutputPayload | null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolCallIdOf(call: unknown): string {
  const id = asRecord(call)?.toolCallId;
  return typeof id === "string" && id ? id : "";
}

function titleOf(call: unknown): string {
  const title = asRecord(call)?.title;
  return typeof title === "string" ? title : "";
}

function statusOf(call: unknown): string {
  const status = asRecord(call)?.status;
  return typeof status === "string" ? status.toLowerCase() : "";
}

function isSettledStatus(call: unknown): boolean {
  const status = statusOf(call);
  return status === "completed" || status === "failed";
}

function grokToolName(call: unknown): string {
  const meta = asRecord(asRecord(call)?._meta);
  const xai = asRecord(meta?.["x.ai/tool"]);
  return typeof xai?.name === "string" ? xai.name : "";
}

function claudeToolName(call: unknown): string {
  const meta = asRecord(asRecord(call)?._meta);
  const claude = asRecord(meta?.claudeCode);
  return typeof claude?.toolName === "string" ? claude.toolName : "";
}

function hasClaudeMcpMeta(call: unknown): boolean {
  return claudeToolName(call).startsWith("mcp__");
}

function hasCodexMcpMeta(call: unknown): boolean {
  return asRecord(asRecord(call)?._meta)?.is_mcp_tool_call === true;
}

function hasGrokUseToolMeta(call: unknown): boolean {
  return grokToolName(call) === "use_tool";
}

function isCodexStartupTitle(title: string): boolean {
  return /^mcp__.+__startup$/i.test(title);
}

function isGrokSearchToolRow(call: unknown): boolean {
  if (grokToolName(call) === "search_tool") return true;
  if (titleOf(call) === "search_tool") return true;
  const rawOut = asRecord(asRecord(call)?.rawOutput);
  if (rawOut?.type === "SearchTool") return true;
  const rawIn = asRecord(asRecord(call)?.rawInput);
  if (rawIn?.variant === "SearchTool") return true;
  return false;
}

/**
 * grok `search_tool` wrappers and Codex `mcp__<server>__startup` rows.
 * Neither is a real MCP invocation. Search folds into the explore group;
 * startup rows are dropped from the transcript for their whole lifecycle.
 */
export function isMcpMachineryRow(call: unknown): boolean {
  if (!asRecord(call)) return false;
  // Explicit invocation metadata is not machinery. Consult it before any
  // title / argument-key fold so a real tool cannot be re-categorized.
  if (hasClaudeMcpMeta(call) || hasGrokUseToolMeta(call)) return false;
  if (isCodexStartupTitle(titleOf(call))) return true;
  if (hasCodexMcpMeta(call)) return false;
  return isGrokSearchToolRow(call);
}

function foldSearchKind(call: Record<string, unknown>): Record<string, unknown> {
  const kind = typeof call.kind === "string" ? call.kind : "";
  if (kind && kind !== "other") return call;
  return { ...call, kind: MCP_MACHINERY_KIND };
}

function isClaudeMcpTitle(call: unknown): boolean {
  const title = titleOf(call);
  return title.startsWith("mcp__") && !isCodexStartupTitle(title);
}

function isCodexMcpArgs(call: unknown): boolean {
  const rawIn = asRecord(asRecord(call)?.rawInput);
  return !!(rawIn
    && typeof rawIn.server === "string" && rawIn.server
    && typeof rawIn.tool === "string" && rawIn.tool
    && typeof rawIn.command !== "string");
}

function isGrokUseToolArgs(call: unknown): boolean {
  const rawIn = asRecord(asRecord(call)?.rawInput);
  return typeof rawIn?.tool_name === "string" && !!rawIn.tool_name
    && asRecord(rawIn.tool_input) !== null;
}

function grokMcpOutput(call: unknown): boolean {
  return asRecord(asRecord(call)?.rawOutput)?.type === "MCP";
}

/** Recognized MCP invocation — not search/startup machinery. */
export function isMcpToolCall(call: unknown): boolean {
  if (!asRecord(call) || isMcpMachineryRow(call)) return false;
  if (hasClaudeMcpMeta(call) || hasCodexMcpMeta(call) || hasGrokUseToolMeta(call)) return true;
  if (grokMcpOutput(call)) return true;
  if (isClaudeMcpTitle(call) || isCodexMcpArgs(call) || isGrokUseToolArgs(call)) return true;
  return false;
}

export function formatMcpArgs(value: unknown): string | null {
  const rec = asRecord(value);
  if (!rec) return null;
  try {
    return JSON.stringify(rec, null, 2);
  } catch {
    return null;
  }
}

function isClaudePendingEmpty(call: unknown, rawIn: Record<string, unknown>): boolean {
  return Object.keys(rawIn).length === 0 && !isSettledStatus(call);
}

function extractClaudeMcpInput(call: unknown, rawIn: Record<string, unknown> | null): string | null {
  if (!rawIn) return null;
  if (isClaudePendingEmpty(call, rawIn)) return null;
  return formatMcpArgs(rawIn);
}

function extractCodexMcpInput(rawIn: Record<string, unknown> | null): string | null {
  if (!rawIn || !("arguments" in rawIn)) return null;
  return formatMcpArgs(rawIn.arguments);
}

function extractGrokMcpInput(rawIn: Record<string, unknown> | null): string | null {
  if (!rawIn || !("tool_input" in rawIn)) return null;
  return formatMcpArgs(rawIn.tool_input);
}

/**
 * Provider-specific IN. Provider metadata is consulted first; argument-key
 * heuristics are last-resort only. Claude pending empty args stay `null`
 * (title-only row). A known-empty object is `{}`.
 */
export function extractMcpInput(call: unknown): string | null {
  const rawIn = asRecord(asRecord(call)?.rawInput);
  if (hasClaudeMcpMeta(call)) return extractClaudeMcpInput(call, rawIn);
  if (hasCodexMcpMeta(call)) return extractCodexMcpInput(rawIn);
  if (hasGrokUseToolMeta(call)) return extractGrokMcpInput(rawIn);
  if (isClaudeMcpTitle(call)) return extractClaudeMcpInput(call, rawIn);
  if (isCodexMcpArgs(call)) return extractCodexMcpInput(rawIn);
  if (isGrokUseToolArgs(call) || grokMcpOutput(call)) return extractGrokMcpInput(rawIn);
  return null;
}

type CappedBuf = {
  chunks: string[];
  used: number;
  max: number;
  truncated: boolean;
};

function createCappedBuf(max: number): CappedBuf {
  return { chunks: [], used: 0, max, truncated: false };
}

function writeBuf(buf: CappedBuf, s: string): boolean {
  if (buf.truncated) return false;
  if (!s) return true;
  const remain = buf.max - buf.used;
  if (s.length <= remain) {
    buf.chunks.push(s);
    buf.used += s.length;
    return true;
  }
  if (remain > 0) {
    buf.chunks.push(s.slice(0, remain));
    buf.used = buf.max;
  }
  buf.truncated = true;
  return false;
}

function bufText(buf: CappedBuf): string {
  return buf.chunks.join("");
}

function writeJsonString(buf: CappedBuf, s: string): boolean {
  if (!writeBuf(buf, "\"")) return false;
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (buf.truncated) return false;
    const c = s.charCodeAt(i);
    if (c === 34) {
      if (!writeBuf(buf, "\\\"")) return false;
      i++;
      continue;
    }
    if (c === 92) {
      if (!writeBuf(buf, "\\\\")) return false;
      i++;
      continue;
    }
    if (c === 8) {
      if (!writeBuf(buf, "\\b")) return false;
      i++;
      continue;
    }
    if (c === 12) {
      if (!writeBuf(buf, "\\f")) return false;
      i++;
      continue;
    }
    if (c === 10) {
      if (!writeBuf(buf, "\\n")) return false;
      i++;
      continue;
    }
    if (c === 13) {
      if (!writeBuf(buf, "\\r")) return false;
      i++;
      continue;
    }
    if (c === 9) {
      if (!writeBuf(buf, "\\t")) return false;
      i++;
      continue;
    }
    if (c < 32) {
      const hex = c.toString(16);
      if (!writeBuf(buf, "\\u" + "0000".slice(hex.length) + hex)) return false;
      i++;
      continue;
    }
    const remain = buf.max - buf.used;
    if (remain <= 0) {
      buf.truncated = true;
      return false;
    }
    let j = i + 1;
    const limit = i + remain < n ? i + remain : n;
    while (j < limit) {
      const d = s.charCodeAt(j);
      if (d < 32 || d === 34 || d === 92) break;
      j++;
    }
    if (!writeBuf(buf, s.slice(i, j))) return false;
    i = j;
  }
  return writeBuf(buf, "\"");
}

/**
 * Pretty-print already-parsed JSON into `buf`, stopping at the remaining
 * budget. Work is proportional to characters written, never to the
 * indented expansion. Throws on the same inputs `JSON.stringify` throws
 * (cycles, BigInt) so the caller can drop the part.
 */
function writePrettyJson(buf: CappedBuf, value: unknown, depth: number, stack: Set<object>): boolean {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (typeof value === "number") {
    return writeBuf(buf, Number.isFinite(value) ? String(value) : "null");
  }
  if (typeof value === "boolean") return writeBuf(buf, value ? "true" : "false");
  if (value === null) return writeBuf(buf, "null");
  if (typeof value === "string") return writeJsonString(buf, value);
  if (typeof value === "bigint") {
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return writeBuf(buf, "null");
  }
  if (typeof value !== "object") return writeBuf(buf, "null");
  if (value instanceof Number) {
    const n = Number(value);
    return writeBuf(buf, Number.isFinite(n) ? String(n) : "null");
  }
  if (value instanceof String) return writeJsonString(buf, String(value));
  if (value instanceof Boolean) return writeBuf(buf, value.valueOf() ? "true" : "false");

  if (stack.has(value)) throw new TypeError("Converting circular structure to JSON");
  stack.add(value);
  try {
    return Array.isArray(value)
      ? writeJsonArray(buf, value, depth, stack)
      : writeJsonObject(buf, value as Record<string, unknown>, depth, stack);
  } finally {
    stack.delete(value);
  }
}

function writeJsonArray(buf: CappedBuf, arr: unknown[], depth: number, stack: Set<object>): boolean {
  if (!writeBuf(buf, "[")) return false;
  if (arr.length === 0) return writeBuf(buf, "]");
  const gap = "  ".repeat(depth + 1);
  const closeGap = "  ".repeat(depth);
  if (!writeBuf(buf, "\n")) return false;
  for (let i = 0; i < arr.length; i++) {
    if (i > 0 && !writeBuf(buf, ",\n")) return false;
    if (!writeBuf(buf, gap)) return false;
    const item = arr[i];
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      if (!writeBuf(buf, "null")) return false;
    } else if (!writePrettyJson(buf, item, depth + 1, stack)) {
      return false;
    }
  }
  return writeBuf(buf, "\n") && writeBuf(buf, closeGap) && writeBuf(buf, "]");
}

function writeJsonObject(
  buf: CappedBuf,
  rec: Record<string, unknown>,
  depth: number,
  stack: Set<object>,
): boolean {
  if (!writeBuf(buf, "{")) return false;
  const keys = Object.keys(rec);
  const gap = "  ".repeat(depth + 1);
  const closeGap = "  ".repeat(depth);
  let first = true;
  for (const key of keys) {
    const val = rec[key];
    if (val === undefined || typeof val === "function" || typeof val === "symbol") continue;
    if (first) {
      if (!writeBuf(buf, "\n")) return false;
      first = false;
    } else if (!writeBuf(buf, ",\n")) {
      return false;
    }
    if (!writeBuf(buf, gap)) return false;
    if (!writeJsonString(buf, key)) return false;
    if (!writeBuf(buf, ": ")) return false;
    if (!writePrettyJson(buf, val, depth + 1, stack)) return false;
  }
  if (!first && !(writeBuf(buf, "\n") && writeBuf(buf, closeGap))) return false;
  return writeBuf(buf, "}");
}

/**
 * Pretty-print structured MCP values under `maxChars`. Strings stay raw so
 * a JSON payload is not re-quoted. Never calls `JSON.stringify` with
 * indent — a hostile nest cannot expand past the budget in memory.
 */
function formatStructured(value: unknown, maxChars: number): { text: string; truncated: boolean } | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return value.length <= maxChars
      ? { text: value, truncated: false }
      : { text: value.slice(0, maxChars), truncated: true };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    return text.length <= maxChars
      ? { text, truncated: false }
      : { text: text.slice(0, maxChars), truncated: true };
  }
  if (typeof value !== "object") return null;
  const buf = createCappedBuf(maxChars);
  try {
    writePrettyJson(buf, value, 0, new Set());
  } catch {
    return null;
  }
  if (buf.used === 0) return null;
  return { text: bufText(buf), truncated: buf.truncated };
}

function appendFormatted(
  buf: CappedBuf,
  started: { value: boolean },
  formatted: { text: string; truncated: boolean } | null,
): void {
  if (!formatted || !formatted.text) {
    if (formatted?.truncated) buf.truncated = true;
    return;
  }
  if (started.value) writeBuf(buf, "\n");
  writeBuf(buf, formatted.text);
  if (formatted.truncated) buf.truncated = true;
  started.value = true;
}

function remainingForPart(buf: CappedBuf, started: { value: boolean }): number {
  const extra = started.value ? 1 : 0;
  return buf.max - buf.used - extra;
}

/**
 * MCP content blocks: text as text, everything else as indented JSON so an
 * image/resource block cannot vanish. Unrecognized non-objects are skipped.
 */
function writeContentBlocks(buf: CappedBuf, content: unknown, started: { value: boolean }): boolean {
  if (!Array.isArray(content)) return started.value;
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "text" && typeof rec.text === "string") {
      appendFormatted(buf, started, rec.text ? { text: rec.text, truncated: false } : null);
      continue;
    }
    const remain = remainingForPart(buf, started);
    if (remain <= 0) {
      buf.truncated = true;
      break;
    }
    appendFormatted(buf, started, formatStructured(rec, remain));
  }
  return started.value;
}

function writeGrokMcpOutput(buf: CappedBuf, rec: Record<string, unknown>): boolean {
  const out = asRecord(rec.output);
  if (!out || typeof out.OkayOutput !== "string") return false;
  const started = { value: false };
  appendFormatted(buf, started, out.OkayOutput ? { text: out.OkayOutput, truncated: false } : null);
  for (const [key, value] of Object.entries(out)) {
    if (key === "OkayOutput") continue;
    const remain = remainingForPart(buf, started);
    if (remain <= 0) {
      buf.truncated = true;
      break;
    }
    appendFormatted(buf, started, formatStructured(value, remain));
  }
  return started.value;
}

function writeCodexMcpOutput(buf: CappedBuf, rec: Record<string, unknown>): boolean {
  const started = { value: false };
  const result = asRecord(rec.result);
  if (result) {
    writeContentBlocks(buf, result.content, started);
    if (result.structuredContent != null) {
      const remain = remainingForPart(buf, started);
      if (remain <= 0) buf.truncated = true;
      else appendFormatted(buf, started, formatStructured(result.structuredContent, remain));
    }
  }
  if (rec.error != null) {
    const remain = remainingForPart(buf, started);
    if (remain <= 0) buf.truncated = true;
    else appendFormatted(buf, started, formatStructured(rec.error, remain));
  }
  return started.value;
}

function finishBuf(buf: CappedBuf, wrote: boolean): { output: string; truncated: boolean } | null {
  if (!wrote || buf.used === 0) return null;
  return { output: bufText(buf), truncated: buf.truncated };
}

/**
 * Provider-specific OUT — the complete measured result, not a chosen field.
 * Unrecognized envelopes return null rather than guessing. Does not read
 * ACP `content` — grok/codex omit it on the completed MCP update, and
 * Claude's copy there is a duplicate of `rawOutput`. Does not read
 * `_meta.claudeCode.toolResponse` (same payload one update earlier).
 *
 * Codex: every `result.content` block plus `structuredContent`; a non-null
 * `error` is shown (a failed call must not look empty). grok: `OkayOutput`
 * and any sibling keys on `output`. Claude: `rawOutput` is polymorphic —
 * a content-block array (plain text; non-text as JSON) or a string shown
 * verbatim (never JSON.parse — integers past 2^53 must survive).
 * Claude has no measured `result`/`structuredContent` envelope — do not
 * invent one.
 */
export function extractMcpOutput(call: unknown): { output: string; truncated: boolean } | null {
  if (!isMcpToolCall(call)) return null;
  const rawOut = asRecord(call)?.rawOutput;

  // Claude structured results arrive as a JSON string. Showing it verbatim
  // is the complete payload; parse-then-stringify would round 64-bit ids.
  if (typeof rawOut === "string") {
    return capCommandOutput(rawOut, false);
  }

  const buf = createCappedBuf(MAX_COMMAND_OUTPUT_CHARS);

  if (Array.isArray(rawOut)) {
    return finishBuf(buf, writeContentBlocks(buf, rawOut, { value: false }));
  }

  const rec = asRecord(rawOut);
  if (!rec) return null;

  if (rec.type === "MCP") {
    return finishBuf(buf, writeGrokMcpOutput(buf, rec));
  }

  if ("result" in rec || rec.error != null) {
    return finishBuf(buf, writeCodexMcpOutput(buf, rec));
  }

  return null;
}

export function mcpCommandOutput(
  call: unknown,
  command: string,
  toolCallId: string,
): CommandOutputPayload | null {
  if (!toolCallId) return null;
  const extracted = extractMcpOutput(call);
  if (!extracted) return null;
  return {
    command,
    toolCallId,
    output: extracted.output,
    exitCode: null,
    truncated: extracted.truncated,
    // Display cap only — the provider already returned the full result.
    agentSawCut: false,
    cancelled: false,
  };
}

/**
 * Host emit decision for one tool_call / tool_call_update.
 *
 * grok `search_tool` is stamped `kind:"search"` so the existing explore
 * group folds it; a later update without the marker stays folded by id.
 * Codex `mcp__<server>__startup` rows drop for their whole lifecycle,
 * with failed status returning a diagnostic for the host log only.
 * Recognized MCP rows always state `detailInput` (`string` or `null`).
 * OUT becomes a `commandOutput` joined by `toolCallId`, never by argument text.
 */
export function prepareMcpToolCall(call: unknown, state: McpPrepareState): PreparedMcpToolCall {
  const rec = asRecord(call);
  if (!rec) return { action: "emit", call: {}, commandOutput: null };

  const id = toolCallIdOf(call);
  const machinery = !!(id && state.machineryIds.has(id)) || isMcpMachineryRow(call);
  if (machinery) {
    if (id) state.machineryIds.add(id);
    const startupServer = (id ? state.startupServerById.get(id) : undefined)
      ?? /^mcp__(.+)__startup$/i.exec(titleOf(call))?.[1];
    if (startupServer) {
      if (id) state.startupServerById.set(id, startupServer);
      if (statusOf(call) !== "failed") return { action: "drop" };
      const text = (Array.isArray(rec.content) ? rec.content : []).map((block: unknown) => {
        const content = asRecord(asRecord(block)?.content);
        return typeof content?.text === "string" ? content.text : "";
      }).filter(Boolean).join(" ");
      return {
        action: "drop",
        logLine: `[mcp] ${startupServer} startup failed${text ? `: ${text}` : ""}`.replace(/[\r\n]+/g, " "),
      };
    }
    const asSearch = isGrokSearchToolRow(call) || !!(id && state.searchIds.has(id));
    if (asSearch && id) state.searchIds.add(id);
    return {
      action: "emit",
      call: asSearch ? foldSearchKind(rec) : rec,
      commandOutput: null,
    };
  }

  const recognized = isMcpToolCall(call) || !!(id && state.mcpIds.has(id));
  if (!recognized) return { action: "emit", call: rec, commandOutput: null };

  if (id) state.mcpIds.add(id);
  const extractedInput = extractMcpInput(call);
  if (extractedInput && id) state.inputById.set(id, extractedInput);
  let detailInput = extractedInput ?? (id ? state.inputById.get(id) ?? null : null);
  // A settled call with OUT but no remembered args is a no-argument tool
  // (or a completed row that omitted rawInput). Invent `{}` so the IN box
  // exists for the id-keyed OUT attach — never drop the result.
  if (detailInput == null && isSettledStatus(call) && extractMcpOutput(call)) {
    detailInput = EMPTY_MCP_ARGS;
  }
  const decorated = { ...rec, detailInput };
  let commandOutput: CommandOutputPayload | null = null;
  if (id && !state.emittedOutputIds.has(id)) {
    commandOutput = mcpCommandOutput(call, detailInput ?? EMPTY_MCP_ARGS, id);
    if (commandOutput) state.emittedOutputIds.add(id);
  }
  return { action: "emit", call: decorated, commandOutput };
}
