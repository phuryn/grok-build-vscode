/**
 * Pure dispatch helpers for the ACP wire protocol.
 *
 * Kept separate from `AcpClient` (which spawns + I/Os) so we can unit-test
 * the line-parsing, response correlation, and update routing without faking
 * a child process.
 */

import { fileUriToPath } from "./file-ref";

export type DispatchEvent =
  | { kind: "response"; id: number | string; result?: any; error?: any }
  | { kind: "session-update"; update: any; meta?: any; sessionId?: string }
  | { kind: "server-request"; id?: number | string; method: string; params: any }
  | { kind: "non-json"; line: string };

export function parseAcpLine(line: string): DispatchEvent | null {
  if (!line.trim()) return null;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return { kind: "non-json", line };
  }
  if (msg.id != null && msg.method == null) {
    return { kind: "response", id: msg.id, result: msg.result, error: msg.error };
  }
  if (msg.method === "session/update") {
    const sessionId = typeof msg.params?.sessionId === "string" && msg.params.sessionId
      ? msg.params.sessionId
      : undefined;
    return { kind: "session-update", update: msg.params?.update, meta: msg.params?._meta, sessionId };
  }
  if (msg.method) {
    return { kind: "server-request", id: msg.id, method: msg.method, params: msg.params };
  }
  return null;
}

/** True when a session/update names a different conversation than this client. */
export function isForeignSessionUpdate(
  updateSessionId: unknown,
  ownerSessionId: unknown,
): updateSessionId is string {
  return typeof updateSessionId === "string" && updateSessionId.length > 0
    && typeof ownerSessionId === "string" && ownerSessionId.length > 0
    && updateSessionId !== ownerSessionId;
}

/** System wake notes and other CLI-hidden user chunks (`update._meta.hideFromScrollback`). */
export function updateHidesFromScrollback(update: unknown): boolean {
  const meta = (update as { _meta?: { hideFromScrollback?: unknown } } | null | undefined)?._meta;
  return meta?.hideFromScrollback === true;
}

/** Original wall-clock time attached by grok to live and replayed updates.
 *  Older CLI builds omit it; invalid/missing values deliberately stay absent. */
export function agentTimestampMsFromMeta(meta: any): number | undefined {
  const value = meta?.agentTimestampMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * A generated-media reference (image or video) normalized out of a tool result.
 * `media` discriminates `<img>` vs `<video>` rendering. `data` is base64 with an
 * inline `mimeType` (renders straight to a data: URI); `path` is a local file
 * (grok writes `/imagine` + `/imagine-video` output into the session dir — the
 * host reads + inlines it); `uri` is a remote/other URL opened as a link.
 */
export type MediaKind = "image" | "video";
export type MediaRef =
  | { media: MediaKind; kind: "data"; mimeType: string; data: string }
  | { media: MediaKind; kind: "path"; path: string; mimeType?: string }
  | { media: MediaKind; kind: "uri"; uri: string; mimeType?: string };

export type UpdateRoute =
  | { event: "messageChunk"; text: string }
  | { event: "userMessageChunk"; text: string }
  | { event: "thoughtChunk"; text: string }
  | { event: "mediaContent"; media: MediaRef }
  | { event: "toolCall"; payload: any }
  | { event: "toolCallUpdate"; payload: any }
  | { event: "plan"; payload: any }
  | { event: "modeChanged"; modeId: string }
  | { event: "configOptionUpdate"; configOptions: any[] }
  | { event: "commandsUpdate"; commands: any[] }
  | { event: "taskBackgrounded"; payload: any }
  | { event: "taskCompleted"; payload: any }
  | { event: "update"; payload: any };

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)$/i;

// An absolute path (Windows drive / `\\?\` extended-length / UNC, or POSIX)
// ending in a known media extension, possibly embedded mid-sentence. Used to
// recover the file path from native-Windows grok's PROSE result ("Image
// generated and saved to <path>.") which — unlike the Linux/macOS JSON result —
// isn't machine-parseable. The trailing lookahead stops at the sentence's
// punctuation/whitespace so a trailing "." isn't swallowed into the path.
const MEDIA_PATH_IN_TEXT_RE =
  /(?:\\\\\?\\)?(?:[A-Za-z]:[\\/]|\/|\\\\)[^\r\n"'<>|?*]*?\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|mov|webm|m4v)(?=$|[\s.,;:)"'\]])/gi;

/** Drop a Windows `\\?\` extended-length prefix so the path is canonical for fs + Uri.file. */
function cleanMediaPath(p: string): string {
  return p.replace(/^\\\\\?\\/, "");
}

function isImageMime(m: unknown): boolean {
  return typeof m === "string" && m.toLowerCase().startsWith("image/");
}

/** Classify a file path/uri as image or video by extension, or null. */
function mediaKindForPath(p: string): MediaKind | null {
  if (IMAGE_EXT_RE.test(p)) return "image";
  if (VIDEO_EXT_RE.test(p)) return "video";
  return null;
}

/** Normalize a file://-or-path URI to a {kind:"path"|"uri"} MediaRef. */
function refFromUri(media: MediaKind, uri: string, mimeType?: string): MediaRef {
  if (uri.startsWith("file://")) {
    try {
      // fileUriToPath, not URL#pathname: the latter yields `/C:/x` for Windows
      // URIs and drops UNC hosts entirely.
      return { media, kind: "path", path: fileUriToPath(uri), mimeType };
    } catch {
      return { media, kind: "path", path: uri.replace(/^file:\/\//, ""), mimeType };
    }
  }
  if (/^[a-z]+:\/\//i.test(uri)) return { media, kind: "uri", uri, mimeType };
  // Bare filesystem path (absolute or relative).
  return { media, kind: "path", path: uri, mimeType };
}

/**
 * Pull an image out of a single ACP content block, or null if it isn't one.
 * grok's `/imagine` doesn't actually use these (it reports a path — see
 * `extractGeneratedMediaPaths`); this is kept as a forward-compatible fallback
 * for the standard ACP `image` block, embedded `resource`, and `resource_link`
 * shapes in case a future grok/tool emits them.
 */
export function extractImageContent(block: any): MediaRef | null {
  if (!block || typeof block !== "object") return null;
  if (block.type === "image" && typeof block.data === "string") {
    return { media: "image", kind: "data", mimeType: block.mimeType || "image/png", data: block.data };
  }
  if (block.type === "resource" && block.resource && typeof block.resource === "object") {
    const r = block.resource;
    if (typeof r.blob === "string" && (isImageMime(r.mimeType) || IMAGE_EXT_RE.test(String(r.uri ?? "")))) {
      return { media: "image", kind: "data", mimeType: isImageMime(r.mimeType) ? r.mimeType : "image/png", data: r.blob };
    }
    if (typeof r.uri === "string" && (isImageMime(r.mimeType) || IMAGE_EXT_RE.test(r.uri))) {
      return refFromUri("image", r.uri, isImageMime(r.mimeType) ? r.mimeType : undefined);
    }
  }
  if (block.type === "resource_link" && typeof block.uri === "string" &&
      (isImageMime(block.mimeType) || IMAGE_EXT_RE.test(block.uri))) {
    return refFromUri("image", block.uri, isImageMime(block.mimeType) ? block.mimeType : undefined);
  }
  return null;
}

/**
 * Collect ACP-standard image blocks out of a tool call's `content` array. Items
 * are either a bare content block or the ACP `{type:"content", content:<block>}`
 * wrapper. Forward-compat fallback — grok's real output path is
 * `extractGeneratedMediaPaths`.
 */
export function collectToolImages(payload: any): MediaRef[] {
  const arr = payload?.content;
  if (!Array.isArray(arr)) return [];
  const out: MediaRef[] = [];
  for (const item of arr) {
    const ref = extractImageContent(item?.type === "content" ? item.content : item);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * True for grok's media-generation tool calls (`/imagine`, `/imagine-video`).
 * The raw tool name and relabeled title differ by build/platform — confirmed
 * live against native-Windows grok 0.2.x AND the Linux 0.2.33 probes:
 *   - `/imagine`       → tool `image_gen`,  title `imagine: <prompt>`,        variant `ImageGen`
 *   - `/imagine` (edit of a reference image) → tool `image_edit`, title `imagine-edit: <prompt>`, variant `ImageEdit`
 *   - `/imagine-video` → tool `video_gen`,  title `imagine-video: <prompt>`,  variant `VideoGen`
 *     (older/Linux builds surfaced this as `image_to_video` / `image-to-video:`)
 *   - `reference_to_video` likewise.
 * See research/image-generation.md. The host tracks these ids so the *completed*
 * update (whose title is null) can still be recognized.
 */
/** MIRRORED in media/webview-helpers.js so the webview can gate a failure hint
 *  without a host rewrite. KEEP THE TWO IN STEP: test/media-gen-mirror.test.ts
 *  drives one fixture set through both and fails if either changes alone. */
export function isMediaGenToolCall(payload: any, provider: "grok" | "codex" | "claude" = "grok"): boolean {
  if (!payload || typeof payload !== "object") return false;
  const title = String(payload.title ?? "");
  if (provider === "codex") {
    return payload.kind === "other" && title === "Image generation";
  }
  if (/^imagine(-video|-edit)?:/i.test(title)) return true;                   // relabeled titles
  if (/^(image_gen|image_edit|video_gen|image_to_video|reference_to_video)\b/i.test(title)) return true; // raw tool names
  if (/^(image-to-video:|reference-to-video:)/i.test(title)) return true;     // legacy relabels
  const ri = payload.rawInput;
  return !!(ri && typeof ri === "object" && typeof ri.variant === "string" &&
    /imagegen|imageedit|videogen|imagetovideo|referencetovideo/i.test(ri.variant));
}

/**
 * Pull generated-media file paths out of a completed image_gen/image_to_video
 * tool result. grok does NOT use an ACP image/resource block — it writes the
 * file to the session dir and reports the path inside a `text` content block, in
 * one of two shapes depending on the build:
 *
 *  - **JSON** (Linux/macOS, older builds): `{"path":"…/images/1.jpg",…}` for
 *    `/imagine`, `{"path":"…/videos/1.mp4",…}` for `/imagine-video`.
 *  - **Prose** (native-Windows grok 0.2.x): a human sentence with the path
 *    embedded, e.g. `Image generated and saved to \\?\C:\…\images\1.jpg.` —
 *    `JSON.parse` can't see this, so we scan the text for an absolute media path.
 *
 * We hand back a path MediaRef (the host inlines it), classifying image vs video
 * by extension. Only paths with a known image/video extension are accepted, so a
 * non-media result can't masquerade as one.
 */
export function extractGeneratedMediaPaths(payload: any): MediaRef[] {
  const arr = payload?.content;
  if (!Array.isArray(arr)) return [];
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const p = cleanMediaPath(raw);
    const media = mediaKindForPath(p);
    if (media && !seen.has(p)) { seen.add(p); out.push({ media, kind: "path", path: p }); }
  };
  for (const item of arr) {
    const block = item?.type === "content" ? item.content : item;
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    let parsed: any;
    try { parsed = JSON.parse(block.text); } catch { /* prose, not JSON */ }
    if (parsed && typeof parsed.path === "string") {
      add(parsed.path);                                   // machine-readable JSON form
    } else if (parsed === undefined) {
      for (const m of block.text.matchAll(MEDIA_PATH_IN_TEXT_RE)) add(m[0]); // prose form
    }
  }
  return out;
}

export function routeSessionUpdate(u: any): UpdateRoute | null {
  if (!u) return null;
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const c = u.content;
      if (c && c.type && c.type !== "text") {
        const media = extractImageContent(c);
        if (media) return { event: "mediaContent", media };
      }
      return { event: "messageChunk", text: c?.text ?? "" };
    }
    case "user_message_chunk":
      if (updateHidesFromScrollback(u)) return null;
      return { event: "userMessageChunk", text: u.content?.text ?? "" };
    case "agent_thought_chunk":
      return { event: "thoughtChunk", text: u.content?.text ?? "" };
    case "tool_call":
      return { event: "toolCall", payload: u };
    case "tool_call_update":
      return { event: "toolCallUpdate", payload: u };
    case "plan":
      return { event: "plan", payload: u };
    case "current_mode_update":
      return { event: "modeChanged", modeId: u.currentModeId };
    case "config_option_update":
      return {
        event: "configOptionUpdate",
        configOptions: Array.isArray(u.configOptions) ? u.configOptions : [],
      };
    case "available_commands_update":
      return { event: "commandsUpdate", commands: u.availableCommands ?? [] };
    case "task_backgrounded":
      return { event: "taskBackgrounded", payload: u };
    case "task_completed":
      return { event: "taskCompleted", payload: u };
    default:
      return { event: "update", payload: u };
  }
}

/**
 * Map a routed child update onto the additive `childStream` host payload.
 * Mode/commands/plan/media stay off this path — they are parent chrome.
 */
export function childStreamFromRoute(
  childSessionId: string,
  route: UpdateRoute,
):
  | { childSessionId: string; event: "messageChunk"; text: string }
  | { childSessionId: string; event: "thoughtChunk"; text: string }
  | { childSessionId: string; event: "userMessageChunk"; text: string }
  | { childSessionId: string; event: "toolCall"; call: any }
  | { childSessionId: string; event: "toolCallUpdate"; call: any }
  | null {
  switch (route.event) {
    case "messageChunk":
    case "thoughtChunk":
    case "userMessageChunk":
      return { childSessionId, event: route.event, text: route.text };
    case "toolCall":
    case "toolCallUpdate":
      return { childSessionId, event: route.event, call: route.payload };
    default:
      return null;
  }
}

/**
 * A prompt's BILLING account — `_meta.usage`, aggregated over the whole prompt
 * (every model call in the turn), not the last call. Distinct from the flat
 * siblings on `PromptResultMeta`, which are the LAST model call only: one probed
 * turn reported flat `outputTokens: 42` against `usage.outputTokens: 158` across
 * `modelCalls: 2`. Also distinct from `totalTokens` (CONTEXT size) — same turn,
 * 16371 context vs 32488 billed. The two never decompose into each other, so the
 * donut arc stays context-only and this drives the popover's usage rows (#53).
 *
 * There is **no cache-CREATION field** anywhere in the grok CLI — only `cachedRead`.
 * Claude/Codex may send `cachedWriteTokens`; keep it when present so occupancy
 * can be derived without inventing grok cache-write rows.
 * Wire capture: research/grok-build-oss-findings.md § 3b.
 */
export interface PromptUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  modelCalls?: number;
  apiDurationMs?: number;
  numTurns?: number;
  /** USD billing in Grok's fixed-point unit: 10^10 ticks = $1. */
  costUsdTicks?: number;
}

export interface PromptResultMeta {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  modelId?: string;
  usage?: PromptUsage;
  /** ACP `session/prompt` `stopReason`, verbatim. Only "cancelled" is acted
   *  on — the turn footer's "Cancelled after …"; everything else reads as a
   *  completed turn. Absent from older CLIs. */
  stopReason?: string;
}

/** How a turn ended, as the turn footer displays it. Carried additively on the
 *  HostMsg that ends the turn (`agentEnd` / `agentError` / `exit`). */
export type TurnEndStatus = "completed" | "cancelled" | "failed";

/** Pull the nested `_meta.usage` (see `PromptUsage`). Returns undefined when the
 *  CLI didn't send one — an older build, or a turn that ran no inference — so a
 *  caller can tell "no data" from "zero", and never invents fields. */
export function extractPromptUsage(meta: any): PromptUsage | undefined {
  const u = meta?.usage;
  if (!u || typeof u !== "object") return undefined;
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: PromptUsage = {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens),
    cachedReadTokens: num(u.cachedReadTokens),
    ...(num(u.cachedWriteTokens) !== undefined ? { cachedWriteTokens: num(u.cachedWriteTokens) } : {}),
    reasoningTokens: num(u.reasoningTokens),
    modelCalls: num(u.modelCalls),
    apiDurationMs: num(u.apiDurationMs),
    numTurns: num(u.numTurns),
    costUsdTicks: num(u.costUsdTicks),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

export function extractPromptMeta(result: any): PromptResultMeta {
  const m = result?._meta ?? {};
  return {
    totalTokens: m.totalTokens,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cachedReadTokens: m.cachedReadTokens,
    cachedWriteTokens: m.cachedWriteTokens,
    reasoningTokens: m.reasoningTokens,
    modelId: m.modelId,
    usage: extractPromptUsage(m),
    stopReason: typeof result?.stopReason === "string" && result.stopReason
      ? result.stopReason
      : undefined,
  };
}

/** How a turn ended, for the footer. The ACP stop reason is the only wire-level
 *  "cancelled" signal; a prompt that THREW never reaches here (the caller
 *  classifies that as "failed" directly). */
export function turnStatusFromPromptResult(meta: PromptResultMeta | undefined): Extract<TurnEndStatus, "completed" | "cancelled"> {
  return meta?.stopReason === "cancelled" ? "cancelled" : "completed";
}

/** Duration for a RESTORED turn's footer, from whatever the persisted rail
 *  carries. Preference order: an explicit `duration_ms` on the `turn_completed`
 *  update (newer CLIs), the same field on the envelope `_meta`, then the
 *  wall-clock gap between the turn's last user-message timestamp and the
 *  turn_completed timestamp (both `_meta.agentTimestampMs`, grok ≥0.2.x).
 *  Undefined when none of these exist — an old transcript simply shows no
 *  duration. Subagent `duration_ms` NEVER passes through here: those are
 *  consumed by the subagent card's own lifecycle handler. Pure. */
export function replayedTurnDuration(
  update: unknown,
  meta: unknown,
  turnStartMs: number | undefined,
): number | undefined {
  const u = update as { duration_ms?: unknown } | null | undefined;
  const m = meta as { duration_ms?: unknown } | null | undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const explicit = num(u?.duration_ms) ?? num(m?.duration_ms);
  if (explicit !== undefined) return explicit;
  if (typeof turnStartMs !== "number" || turnStartMs <= 0) return undefined;
  const endMs = num((meta as { agentTimestampMs?: unknown } | null | undefined)?.agentTimestampMs);
  return endMs !== undefined && endMs > turnStartMs ? endMs - turnStartMs : undefined;
}

/**
 * Sum two prompt usages into the session-cumulative total (#53). grok reports
 * usage per prompt and never a session total, so this number is OURS — the CLI's
 * `signals.json` carries only context size, which is why a cold restore has no
 * breakdown to seed from and we persist our own running total instead.
 *
 * `undefined + undefined` stays undefined (never invents a 0 for a field the CLI
 * doesn't report), but a present field added to an absent one keeps the present
 * value. Cost is stricter: it stays absent unless every contributing turn
 * reported it, because a partial sum must not be presented as a session total.
 * `apiDurationMs` and `numTurns` sum too — both are per-prompt totals.
 */
export function addUsage(a: PromptUsage | undefined, b: PromptUsage | undefined): PromptUsage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  const keys: (keyof PromptUsage)[] = [
    "inputTokens", "outputTokens", "totalTokens", "cachedReadTokens",
    "cachedWriteTokens", "reasoningTokens", "modelCalls", "apiDurationMs",
    "numTurns", "costUsdTicks",
  ];
  const out: PromptUsage = {};
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === undefined && y === undefined) continue;
    // A cost is a truthful total only when every contributing turn reported it.
    if (k === "costUsdTicks" && (x === undefined || y === undefined)) continue;
    out[k] = (x ?? 0) + (y ?? 0);
  }
  return out;
}

/** Sum a per-turn usage log back into a session total. Used after a rewind
 *  drops the discarded turns' entries — the total is derived, never patched. */
export function sumUsage(entries: Array<{ usage?: PromptUsage }>): PromptUsage | undefined {
  let out: PromptUsage | undefined;
  for (const e of entries) out = addUsage(out, e.usage);
  return out;
}

/**
 * A dollar SESSION total is honest only when our ledger spans every real user
 * prompt in the conversation. `afterUserMessage` is the replay-stable prompt
 * coordinate shared by live sends and cold `session/load`; entries without
 * usage may deliberately cover successful zero-inference turns such as
 * `/compact`. Missing coordinates remain unknown gaps.
 *
 * Token fields keep their existing best-known aggregate semantics. Only cost is
 * removed when coverage is incomplete; per-turn usage is never passed here and
 * therefore always retains its own honest cost.
 */
export function enforceCompleteSessionCost(
  usage: PromptUsage | undefined,
  entries: readonly { afterUserMessage?: number; usage?: PromptUsage }[],
  userMessageCount: number,
): PromptUsage | undefined {
  if (usage?.costUsdTicks === undefined) return usage;
  const covered = new Set<number>();
  for (const entry of entries) {
    const position = entry.afterUserMessage;
    if (typeof position === "number" && Number.isSafeInteger(position) && position >= 1 && position <= userMessageCount) {
      covered.add(position);
    }
  }
  const complete = userMessageCount > 0 && covered.size === userMessageCount;
  if (complete) return usage;
  const { costUsdTicks: _incompleteCost, ...withoutCost } = usage;
  return withoutCost;
}

/**
 * Whether a turn's usage is a real measurement worth counting (#53).
 *
 * A `/compact` (or `/session-info`) turn runs no inference of its own, and grok
 * captures `_meta` BEFORE the slash-command match — so it replays the PREVIOUS
 * turn's input/output/cache numbers verbatim. `gateZeroTokenMeta` already strips
 * the bogus `totalTokens: 0` those turns carry, and that same 0 is the tell here:
 * counting the stale siblings would double-bill the prior turn into the session
 * total on every compact.
 */
export function usageIsRealMeasurement(meta: PromptResultMeta): boolean {
  return meta.totalTokens !== 0 && !!meta.usage;
}

/**
 * A JSON-RPC `-32601 method not found` — the CLI doesn't dispatch this method at
 * all. The `_x.ai/*` RPCs we use for Steer (#52) and Fork (#48) ship unadvertised,
 * so an older build answers -32601 and the feature must hide itself rather than
 * error at the user. `acp.ts` rejects with the RAW JSON-RPC error object (not an
 * Error), so the code survives; the message check is a belt-and-braces fallback.
 *
 * Note -32602 (`invalid params`) deliberately does NOT count: that means the
 * method EXISTS and we sent the wrong shape — a bug to fix, not a capability gap.
 */
export function isMethodNotFoundError(e: any): boolean {
  if (!e) return false;
  if (e.code === -32601) return true;
  return /method not found|method_not_found/i.test(String(e.message ?? e));
}

/**
 * Strip a turn's `totalTokens: 0` report — it is never a real measurement
 * (#39). grok reports 0 both for `/session-info` (context untouched — the 0
 * zeroed the donut) and for `/compact` (context SHRUNK, not emptied — 0 is
 * wrong there too; the "Compacted." bubble is the it-worked signal, and the
 * next turn reports the true post-compact size). `undefined` means "no
 * update": the donut keeps its last real value. Non-zero counts pass through.
 */
export function gateZeroTokenMeta(meta: PromptResultMeta): PromptResultMeta {
  if (meta.totalTokens !== 0) return meta;
  return { ...meta, totalTokens: undefined };
}

/**
 * The trustworthy live context count is carried by each `session/update`
 * envelope's `_meta.totalTokens`, not the prompt result (which can be a
 * placeholder zero). Invalid values leave the last real donut value intact.
 */
export function contextUsedFromUpdateEnvelope(meta: unknown): number | null {
  const used = (meta as { totalTokens?: unknown } | null | undefined)?.totalTokens;
  return typeof used === "number" && Number.isFinite(used) && used > 0 ? used : null;
}

/**
 * Adapter occupancy is the prompt actually sent this call: uncached input plus
 * cache read and cache write. Those three partitions are disjoint on both
 * Claude and Codex. `usage.totalTokens` / `usage_update.used` add output and
 * are a billing sum, not conversation occupancy.
 *
 * When the parts are missing, `totalTokens - outputTokens` is the same
 * quantity (verified against Claude 0.69.0 and a live Codex 5.6 turn).
 *
 * Claude's PromptResponse.usage is the SUM of every call in the turn — do
 * not pass that figure here and treat the result as occupancy. Reduce a
 * turn with `occupancyFromAdapterTurn`.
 */
export function adapterContextOccupancy(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
} | null | undefined): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const billed = num(usage.totalTokens);
  const cacheRead = num(usage.cachedReadTokens) ?? 0;
  const cacheWrite = num(usage.cachedWriteTokens) ?? 0;
  if (input !== undefined) return input + cacheRead + cacheWrite;
  if (billed !== undefined && output !== undefined) return Math.max(0, billed - output);
  return billed;
}

function positiveTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Occupancy for one adapter turn. Claude's PromptResponse.usage is
 * `accumulatedUsage` — the SUM of every model call — so
 * `adapterContextOccupancy(result)` is larger than the conversation.
 * `usage_update.used` is the current call's billed total. Occupancy is
 * the largest of those, never the sum. When the result does not exceed
 * that max it is a single/last call and excludes output, so it wins.
 *
 * Without per-call observations the wire cannot tell a sum from a
 * single call; the result is the honest fallback.
 * Measurement: research/claude-acp.md, adapter-usage-probe.cjs.
 */
export function occupancyFromAdapterTurn(
  resultOccupancy: number | undefined,
  perCallUsed: readonly number[] | undefined,
): number | undefined {
  let callMax: number | undefined;
  for (const used of perCallUsed ?? []) {
    const n = positiveTokens(used);
    if (n === undefined) continue;
    callMax = callMax === undefined ? n : Math.max(callMax, n);
  }
  const result = positiveTokens(resultOccupancy);
  if (callMax === undefined) return result;
  if (result === undefined) return callMax;
  return result > callMax ? callMax : result;
}

/**
 * Per-session adapter occupancy. The prompt sent on a call *is* the
 * conversation at that moment (every call re-sends it). Feed
 * `occupancyFromAdapterTurn`, not Claude's summed PromptResponse. A later
 * smaller prompt without a compact is a different-shaped call (subagent,
 * tool follow-up) and must not replace the conversation figure — that is
 * the 135k↔389k swing. Compaction is the only reset.
 */
export interface ContextOccupancyState {
  used?: number;
  window?: number;
  pendingCompact?: boolean;
}

export interface ContextOccupancyEvent {
  occupancy?: number;
  window?: number;
  /** Compact started or /compact — the next prompt size may be lower. */
  compacted?: boolean;
  /** Compaction failed; keep the stored figure and stop waiting. */
  compactFailed?: boolean;
}

export function applyContextOccupancy(
  state: ContextOccupancyState,
  event: ContextOccupancyEvent,
): ContextOccupancyState {
  const window = positiveTokens(event.window) ?? state.window;
  if (event.compactFailed) {
    return { used: state.used, window, pendingCompact: false };
  }
  const pendingCompact = event.compacted ? true : !!state.pendingCompact;
  const occupancy = positiveTokens(event.occupancy);
  if (occupancy === undefined) {
    return { used: state.used, window, pendingCompact };
  }
  if (pendingCompact || state.used === undefined) {
    return { used: occupancy, window, pendingCompact: false };
  }
  return { used: Math.max(state.used, occupancy), window, pendingCompact: false };
}

export function occupancyFromUsageLog(
  entries: readonly { contextUsed?: number; compacted?: boolean }[] | undefined,
): ContextOccupancyState {
  let state: ContextOccupancyState = {};
  for (const entry of entries ?? []) {
    state = applyContextOccupancy(state, {
      occupancy: entry.contextUsed,
      compacted: entry.compacted,
    });
  }
  return state;
}

/**
 * Claude emits exact status strings; Codex stamps `_meta.contextCompaction`.
 * Title matching is the Codex fallback only — a grep titled "compact" is
 * not a compaction.
 */
export function adapterCompactSignal(update: unknown): "started" | "completed" | "failed" | null {
  if (typeof update === "string") {
    const text = update.trim();
    if (/compacting failed/i.test(text)) return "failed";
    if (/compacting completed/i.test(text)) return "completed";
    if (/^compacting\.\.\.$/i.test(text)) return "started";
    return null;
  }
  if (!update || typeof update !== "object") return null;
  const u = update as {
    sessionUpdate?: unknown;
    content?: { text?: unknown };
    title?: unknown;
    status?: unknown;
    _meta?: { contextCompaction?: unknown };
  };
  if (typeof u.content?.text === "string") {
    const fromText = adapterCompactSignal(u.content.text);
    if (fromText) return fromText;
  }
  if (u._meta?.contextCompaction === true) {
    if (u.status === "failed") return "failed";
    if (u.status === "completed") return "completed";
    return "started";
  }
  return null;
}

/**
 * The fresh post-compaction context size from an `_x.ai/session_notification`
 * update, or `null` when the update isn't a compaction-completed event or
 * carries no usable count. grok fires `auto_compact_completed` on BOTH a manual
 * `/compact` and the CLI's automatic compaction; `tokens_after` is the
 * post-compact used-token count. This live notification is the only instant
 * source of that number — the compact turn's own meta reports 0 (see
 * `gateZeroTokenMeta`) and signals.json keeps the pre-compact count until the
 * next inference turn's flush (research/oss-surfaces-probe.cjs, grok 0.2.101).
 * The donut tracks the context window itself (from `modelChanged`), so only
 * `used` is returned; a zero/negative/non-numeric `tokens_after` yields `null`
 * (the donut keeps its last real value).
 */
export function contextUsedFromCompactNotification(update: unknown): number | null {
  const u = update as { sessionUpdate?: unknown; tokens_after?: unknown } | null | undefined;
  if (!u || u.sessionUpdate !== "auto_compact_completed") return null;
  const used = u.tokens_after;
  return typeof used === "number" && Number.isFinite(used) && used > 0 ? used : null;
}

/**
 * True when an `_x.ai/session_notification` update is a subagent lifecycle event
 * the webview's cards ACT ON — `subagent_spawned` (tags the card with the child
 * id) or `subagent_finished` (fills `duration_ms` + the child's output, which the
 * Composer agent's tool-channel completion lacks). These ride the LIVE
 * notification rail; the webview's `subagentUpdate` handler was historically fed
 * by the persist/replay `_x.ai/session/update` rail (which never carried them
 * live — grok 0.2.93 only logged them), so re-routing the live events there
 * activates the existing card logic. **`subagent_progress` is deliberately
 * EXCLUDED** — the webview has no behavior for it, and upstream can emit it every
 * ~2s, so routing it would only pile up no-op entries in the session replay
 * buffer.
 */
export function isSubagentLifecycleUpdate(update: unknown): boolean {
  const k = (update as { sessionUpdate?: unknown } | null | undefined)?.sessionUpdate;
  return k === "subagent_spawned" || k === "subagent_finished";
}

/**
 * A user-facing note for the CLI's AUTOMATIC (context-full) compaction, or null
 * when the update isn't an `auto_compact_started`. This fires ONLY on the
 * auto-compaction path (`compaction.rs` — `run_compact` for a manual `/compact`
 * emits only `auto_compact_completed`, never `_started`), so it cleanly
 * distinguishes the two: a manual `/compact` already paints "Compacted." from
 * the slash-command path, while automatic compaction was previously silent — the
 * turn's context would just shrink with no explanation. Auto-compaction runs
 * before a sampling attempt — usually at a turn's start, but possibly between
 * tool-loop passes — so the host renders it as a dedicated notice (not a message
 * chunk) that finalizes any active bubble first. Plain text (styled as a notice);
 * percentage included when present.
 */
export function autoCompactStartedNote(update: unknown): string | null {
  const u = update as { sessionUpdate?: unknown; percentage?: unknown } | null | undefined;
  if (!u || u.sessionUpdate !== "auto_compact_started") return null;
  const pct = typeof u.percentage === "number" && Number.isFinite(u.percentage) ? u.percentage : null;
  return pct != null
    ? `Auto-compacting context (${pct}% full)…`
    : `Auto-compacting context…`;
}

/** Parse the context line returned by the legacy `/session-info` command. */
export function parseSessionInfoContext(text: string): { used: number; window: number } | null {
  const match = /context:\*{0,2}\s*([\d][\d,]*)\s*\/\s*([\d][\d,]*)\s*tokens/i.exec(text ?? "");
  if (!match) return null;
  const number = (value: string) => Number(value.replace(/,/g, ""));
  const used = number(match[1]);
  const window = number(match[2]);
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(window) || window <= 0) return null;
  return { used, window };
}

export interface ContextUsageCategory {
  label: string;
  tokens: number;
  detail?: string;
}

/** Structured context snapshot returned by `_x.ai/session/info`. */
export interface SessionInfoContext {
  used: number;
  window: number;
  categories?: ContextUsageCategory[];
  systemPromptTokens?: number;
  toolDefinitionsTokens?: number;
  toolDefinitionsCount?: number;
  messageTokens?: number;
  freeTokens?: number;
  autoCompactThresholdPercent?: number;
}

/** Keep a popover re-open from issuing another control-plane RPC immediately. */
export const SESSION_INFO_TTL_MS = 3000;

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseSessionInfoCategories(raw: unknown): ContextUsageCategory[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const categories: ContextUsageCategory[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const category = row as { label?: unknown; tokens?: unknown; detail?: unknown };
    if (typeof category.label !== "string" || !category.label.trim()) continue;
    if (typeof category.tokens !== "number" || !Number.isFinite(category.tokens) || category.tokens < 0) continue;
    const parsed: ContextUsageCategory = { label: category.label.trim(), tokens: category.tokens };
    if (typeof category.detail === "string" && category.detail.trim()) parsed.detail = category.detail.trim();
    categories.push(parsed);
  }
  return categories.length ? categories : undefined;
}

/**
 * Normalize `_x.ai/session/info` into the context snapshot consumed by the
 * donut and popover. Unlike a prompt result's `totalTokens: 0`, an RPC
 * `context.used: 0` is a valid authoritative reading.
 */
export function parseSessionInfoRpcResult(raw: unknown): SessionInfoContext | null {
  if (!raw || typeof raw !== "object") return null;
  let body = raw as Record<string, unknown>;
  const nested = body.result;
  if (nested && typeof nested === "object" && (nested as { context?: unknown }).context != null && body.context == null) {
    body = nested as Record<string, unknown>;
  }
  const context = body.context;
  if (!context || typeof context !== "object") return null;
  const values = context as Record<string, unknown>;
  const used = finiteNonNegative(values.used);
  const window = values.total;
  if (used === undefined || typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;

  const parsed: SessionInfoContext = { used, window };
  const categories = parseSessionInfoCategories(values.usageCategories);
  if (categories) parsed.categories = categories;
  const system = finiteNonNegative(values.systemPromptTokens);
  if (system !== undefined) parsed.systemPromptTokens = system;
  const tools = finiteNonNegative(values.toolDefinitionsTokens);
  if (tools !== undefined) parsed.toolDefinitionsTokens = tools;
  const toolCount = finiteNonNegative(values.toolDefinitionsCount);
  if (toolCount !== undefined) parsed.toolDefinitionsCount = toolCount;
  const messages = finiteNonNegative(values.messageTokens);
  if (messages !== undefined) parsed.messageTokens = messages;
  const free = finiteNonNegative(values.freeTokens);
  if (free !== undefined) parsed.freeTokens = free;
  const threshold = values.autoCompactThresholdPercent;
  if (typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0) {
    parsed.autoCompactThresholdPercent = threshold;
  }
  return parsed;
}

export function sessionInfoCacheFresh(fetchedAt: number, now: number, ttlMs = SESSION_INFO_TTL_MS): boolean {
  return fetchedAt > 0 && now - fetchedAt < ttlMs;
}

export function makePermissionResponse(id: number | string, optionId: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: { outcome: { outcome: "selected", optionId } },
  };
}

export function makePermissionCancelledResponse(id: number | string) {
  return {
    jsonrpc: "2.0",
    id,
    result: { outcome: { outcome: "cancelled" } },
  };
}

export function makeExitPlanResponse(
  id: number | string,
  verdict: "approved" | "abandoned" | "rejected",
) {
  const outcome = verdict === "rejected" ? "cancelled" : verdict;
  return { jsonrpc: "2.0", id, result: { outcome } };
}

/** Fail a stray plan-exit request when this session's CLI is below (or could
 * not be verified against) the native-verdict floor. A successful outcome is
 * unsafe here: older CLIs can interpret every success as approval. */
export function makeExitPlanUnavailableResponse(id: number | string) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: "Plan mode is unavailable for this Grok CLI version",
    },
  };
}

/**
 * Response to grok's `x.ai/ask_user_question` request (Rust struct
 * `AskUserQuestionExtResponse` — an internally-tagged enum on field `outcome`,
 * variants `accepted` | `chat_about_this` | `skip_interview` | `cancelled`).
 * The `accepted` variant carries `answers` (question text → chosen option label,
 * multi-select labels joined) and `annotations` (question text → { notes,
 * preview }). The old catch-all replied with a bare `{}`, which grok's
 * deserializer rejects with "missing field `outcome` at line 1 column 2" so the
 * tool reports failure (issue #12).
 */
export function makeQuestionResponse(
  id: number | string,
  answers: Record<string, string>,
  annotations: Record<string, { notes?: string; preview?: string }> = {},
) {
  return { jsonrpc: "2.0", id, result: { outcome: "accepted", answers, annotations } };
}

/** User dismissed the question without answering → grok's `cancelled` outcome. */
export function makeQuestionCancelledResponse(id: number | string) {
  return { jsonrpc: "2.0", id, result: { outcome: "cancelled" } };
}

export function makeAckResponse(id: number | string, result: any = {}) {
  return { jsonrpc: "2.0", id, result };
}

export function makeRequest(id: number, method: string, params: any) {
  return { jsonrpc: "2.0", id, method, params };
}

/** Classify a permission answer as allowed vs rejected from the chosen option's
 *  kind (`allow_once`/`allow_always` → allowed, `reject_*`/`deny_*` → rejected).
 *  Used to persist the answer so a resumed session can replay the collapsed card. */
export function permissionOutcomeFor(
  options: { optionId: string; kind: string }[] | undefined,
  optionId: string,
): "allowed" | "rejected" {
  const opt = (options ?? []).find((o) => o.optionId === optionId);
  return opt && /reject|deny/i.test(opt.kind) ? "rejected" : "allowed";
}

/** Compress a (possibly huge) background shell command into a one-line label for
 *  a notification — collapse whitespace and clip to a readable length. */
export function summarizeBackgroundCommand(cmd: string, max = 80): string {
  const flat = (cmd || "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

/** Display cap shared by the live terminal snapshot and session/load restore. */
export const MAX_COMMAND_OUTPUT_CHARS = 100_000;

export type CommandOutputPayload = {
  command: string;
  output: string;
  exitCode: number | null;
  truncated: boolean;
  /**
   * Always stated by this host. `true` is a live terminal kill (`commandDone`
   * with no exit). `false` is everything else, including session/load
   * hydration whose null exit means "not reported". Older hosts omit the
   * field; the client treats that absence as the previous null-exit rule.
   */
  cancelled: boolean;
  /**
   * Always stated on MCP `commandOutput` (the ACP `toolCallId`). The webview
   * joins IN to OUT by this id. Shell `commandOutput` omits the field —
   * absence means join by `command`.
   */
  toolCallId?: string;
  /**
   * Always stated by this host. `true` is a cut the agent already saw
   * (terminal byte cap, or the CLI's own `truncated` on a replayed
   * execute). `false` is this host's 100K display cap applied after the
   * provider returned the full result (MCP). Older hosts omit the field;
   * the client must not attribute that cut either way.
   */
  agentSawCut?: boolean;
};

export function capCommandOutput(
  output: string,
  truncated: boolean,
  maxChars = MAX_COMMAND_OUTPUT_CHARS,
): { output: string; truncated: boolean } {
  const over = output.length > maxChars;
  return {
    output: over ? output.slice(0, maxChars) : output,
    truncated: truncated || over,
  };
}

/** Live `terminal/release` snapshot. Null exit is a real cancel, not a missing report. */
export function commandOutputFromLiveTerminal(info: {
  command: string;
  output: string;
  exitCode: number | null;
  truncated: boolean;
}): CommandOutputPayload {
  const capped = capCommandOutput(info.output, info.truncated);
  return {
    command: info.command,
    output: capped.output,
    exitCode: info.exitCode,
    truncated: capped.truncated,
    cancelled: info.exitCode == null,
    agentSawCut: true,
  };
}

function commandStringFromToolCall(call: any): string {
  const rawIn = call?.rawInput;
  if (rawIn && typeof rawIn === "object") {
    if (typeof rawIn.command === "string" && rawIn.command.trim()) return rawIn.command.trim();
    if (typeof rawIn.cmd === "string" && rawIn.cmd.trim()) return rawIn.cmd.trim();
  }
  const rawOut = call?.rawOutput;
  if (rawOut && typeof rawOut === "object" && typeof rawOut.command === "string" && rawOut.command.trim()) {
    return rawOut.command.trim();
  }
  return "";
}

function toolCallIdOf(call: unknown): string {
  const id = (call as { toolCallId?: unknown } | null | undefined)?.toolCallId;
  return typeof id === "string" ? id : "";
}

function executeKindOf(call: unknown): string {
  const kind = (call as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === "string" ? kind.toLowerCase() : "";
}

/** Claude's completed update has no rawInput; the command lives on the earlier tool_call. */
function rememberReplayedExecuteCommand(
  remembered: Map<string, string>,
  call: unknown,
): void {
  if (!call || typeof call !== "object") return;
  const kind = executeKindOf(call);
  if (kind && kind !== "execute") return;
  const id = toolCallIdOf(call);
  if (!id) return;
  const title = typeof (call as { title?: unknown }).title === "string"
    ? (call as { title: string }).title.trim()
    : "";
  const command = commandStringFromToolCall(call) || title;
  if (command) remembered.set(id, command);
}

function recognizedRawOutput(ro: unknown): {
  output: unknown;
  formatted: unknown;
  exitCode: number | null;
  truncated: boolean;
} | null {
  if (!ro || typeof ro !== "object") return null;
  const rec = ro as Record<string, unknown>;
  const exitCode =
    typeof rec.exit_code === "number" ? rec.exit_code
    : typeof rec.exitCode === "number" ? rec.exitCode
    : null;
  const hasOutput =
    typeof rec.output === "string"
    || Array.isArray(rec.output)
    || ArrayBuffer.isView(rec.output)
    || typeof rec.formatted_output === "string";
  if (exitCode == null && !hasOutput) return null;
  return {
    output: rec.output,
    formatted: rec.formatted_output,
    exitCode,
    truncated: rec.truncated === true,
  };
}

function textFromToolContent(call: any): string | undefined {
  if (!Array.isArray(call?.content)) return undefined;
  const block = call.content.find((b: any) => b && b.content && typeof b.content.text === "string");
  return block ? block.content.text as string : undefined;
}

function decodeCommandOutputBytes(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  try {
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (Array.isArray(value)) return new TextDecoder().decode(Uint8Array.from(value));
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Hydrate a `commandOutput` payload from a replayed execute tool_call.
 *
 * Provider fields are inverted (research/replay-shapes.md):
 * - grok: `content` is raw stdout; never read `rawOutput.output_for_prompt`
 *   (it prefixes `exit: N`).
 * - claude: `rawOutput` is a plain string; `content` is either the tool
 *   description (first row) or stdout wrapped in a ```console fence
 *   (completed update). Prefer the string. No exit code is reported.
 * - A completed Claude update has no `rawInput`; pass the command remembered
 *   from the earlier `tool_call` by `toolCallId`.
 * Unknown / unmeasured shapes return null. Always states `cancelled: false`
 * — a hydrated null exit is "not reported", not a live kill. Omitting the
 * field would be indistinguishable from an older host's live kill.
 */
export function commandOutputFromReplayedToolCall(
  call: unknown,
  rememberedCommands?: ReadonlyMap<string, string>,
): CommandOutputPayload | null {
  if (!call || typeof call !== "object") return null;
  const kind = executeKindOf(call);
  if (kind && kind !== "execute") return null;
  const id = toolCallIdOf(call);
  const command = commandStringFromToolCall(call)
    || (id && rememberedCommands ? rememberedCommands.get(id) ?? "" : "");
  if (!command) return null;
  const rawOutput = (call as { rawOutput?: unknown }).rawOutput;
  // Measured Claude restore: stdout is the string itself. Do not fall through
  // to content (fenced on the completed row, a description on the first).
  if (typeof rawOutput === "string") {
    const capped = capCommandOutput(rawOutput, false);
    return { command, exitCode: null, ...capped, cancelled: false, agentSawCut: true };
  }
  const raw = recognizedRawOutput(rawOutput);
  if (!raw) return null;
  const fromContent = textFromToolContent(call);
  const output =
    fromContent !== undefined ? fromContent
    : typeof raw.output === "string" ? raw.output
    : typeof raw.formatted === "string" ? raw.formatted
    : decodeCommandOutputBytes(raw.output) ?? "";
  const capped = capCommandOutput(output, raw.truncated);
  return { command, exitCode: raw.exitCode, ...capped, cancelled: false, agentSawCut: true };
}

/** Live turns must not emit from the tool_call — only session/load replay. */
export function commandOutputForToolCall(
  call: unknown,
  opts: { replaying: boolean; rememberedCommands?: Map<string, string> },
): CommandOutputPayload | null {
  if (!opts.replaying) return null;
  if (opts.rememberedCommands) rememberReplayedExecuteCommand(opts.rememberedCommands, call);
  return commandOutputFromReplayedToolCall(call, opts.rememberedCommands);
}

/**
 * True when `session/set_model` was rejected because the target model belongs
 * to a different agent than the one this session is bound to. The CLI binds the
 * agent at spawn time and locks it after the first turn, so the model can only
 * be applied on a fresh session — `newSession` sets it before that turn, while
 * the agent is still rebindable. The host
 * uses this to fall back to a restart instead of surfacing the raw error.
 */
export function isIncompatibleAgentError(err: any): boolean {
  if (err?.data?.code === "MODEL_SWITCH_INCOMPATIBLE_AGENT") return true;
  // Fallback if a future CLI keeps the message but drops the structured code.
  return /requires agent .+ but the active agent/i.test(err?.message ?? "");
}

/**
 * True when a turn error looks like an expired/invalid credential rather than a
 * real fault. A long-lived pooled `grok agent stdio` process can wedge on an
 * expired OAuth access token when its 401-refresh loses a rotation race with the
 * sibling processes (or `grok login`) that share `~/.grok/auth.json`; a fresh
 * process re-reads the current disk token, so the host transparently restarts
 * the wedged process instead of making the user sign out and back in. Kept
 * deliberately broad — this is ONLY the gate for that one guarded reload+retry,
 * never for what the retry's failure ultimately shows (that split is
 * `isCredentialError` vs `entitlementNoticeText`, #58): a false match costs one
 * reload, then the real error surfaces on the retry.
 * A rate/usage-limit message yields to `isRateLimitErrorText` first (#57): a
 * weekly-limit error carries the same billing-flavored wording, but routing it
 * here ends on the login screen, which can't fix a limit.
 */
export function isAuthErrorText(msg: unknown): boolean {
  const s = String(msg ?? "");
  if (isRateLimitErrorText(s)) return false;
  if (/\b(401|403)\b|unauthor|forbidden|\bcredential|\bapi[_\s-]?key\b|not (?:signed|logged) ?in|(?:sign|log) ?in again|re-?login|authenticat\w*\s*(?:failed|required|error|expired)|token (?:has )?expired|expired\s+token|session (?:has )?expired/i.test(s)) return true;
  // Billing/entitlement wording joins the retry gate: it CAN be a wedged token,
  // and if it isn't, the retry's failure shows the entitlement notice instead.
  return /\bpay(?:ment)?\b|\bbilling\b|\bsubscription\b|\bentitl\w+|\bunpaid\b|\bcredits?\s+(?:exhaust|remain|requir)/i.test(s);
}

/**
 * ACP error code for a genuine credential failure (`auth_required`). The CLI
 * funnels EVERY prompt-turn auth failure (HTTP 401 / its internal Auth error)
 * through this code with one of two fixed "Session expired… / Authentication
 * failed… run `grok login`" strings (OSS `session_setup.rs` `to_acp_error` +
 * `auth_method.rs`), which makes the code the authoritative credential signal.
 */
export const AUTH_REQUIRED_ERROR_CODE = -32000;

/**
 * True when a turn failure is a genuine CREDENTIAL problem — the thing a
 * re-login can actually fix — as opposed to the billing/entitlement family that
 * merely *sounds* like one (#58). Primary signal: the structured
 * `AUTH_REQUIRED_ERROR_CODE`; the text branch is the fallback for surfaces that
 * flatten the error. The text branch deliberately EXCLUDES `403`/`forbidden`
 * (the CLI maps 403 to a plain internal error precisely because the credential
 * was accepted — entitlement/content-policy, not auth), bare "api key" (the
 * CLI's 403-subscription message can embed "You have an API key set
 * (XAI_API_KEY)… run `grok logout`" — advice the login overlay would invert),
 * and all billing wording. Only this classifier may route to the sign-in
 * overlay; everything else shows in chat.
 */
export function isCredentialError(err: unknown): boolean {
  const e = err as any;
  if (e?.code === AUTH_REQUIRED_ERROR_CODE) return true;
  const s = errorDetail(e);
  if (isRateLimitErrorText(s)) return false;
  return /\b401\b|unauthor|\bcredential|not (?:signed|logged) ?in|(?:sign|log) ?in again|re-?login|authenticat\w*\s*(?:failed|required|error|expired)|token (?:has )?expired|expired\s+token|session (?:has )?expired|invalid\s+api[_\s-]?key|api[_\s-]?key\s+(?:is\s+)?(?:invalid|expired|revoked|missing)/i.test(s);
}

/**
 * ACP error code the CLI uses for HTTP 429 rate-limit failures. Its documented
 * contract (OSS `sampling/error.rs`): clients suppress the error detail and
 * show a friendly limit message instead of a generic failure.
 */
export const RATE_LIMITED_ERROR_CODE = -32003;

/** The CLI's own OAuth-plan rate-limit copy, reused verbatim when a -32003
 *  arrives with no usable detail. */
const GENERIC_RATE_LIMIT_TEXT =
  "You\u{2019}ve hit the rate limit for your plan. Upgrade your account or try again later.";

/** The human detail a grok ACP error carries: `data` is either the bare detail
 *  string or a `{message}` object (the CLI's attach_prompt_usage wrapper).
 *  Exported so host error surfaces read the same field order — the ad-hoc
 *  `e?.data?.message ?? e?.message` they used dropped the bare-string `data`
 *  shape, classifying real detail as the generic "Internal error" envelope. */
export function errorDetail(err: any): string {
  const d = err?.data;
  if (typeof d === "string") return d;
  if (typeof d?.message === "string") return d.message;
  return typeof err?.message === "string" ? err.message : String(err ?? "");
}

/**
 * True when a message reads as a rate/usage-limit rather than a real fault.
 * Phrasings mirror the CLI's own copy (OSS `sampling/error.rs` + pager
 * `billing.rs`): "rate limit" (OAuth/API-key/plain "Rate limited"), the
 * weekly/usage-limit and spending-cap upsells, the well-known
 * `subscription:free-usage-exhausted` code, and raw HTTP-429 phrasing.
 * Deliberately NOT a bare "limit reached/exceeded" — a context-window overflow
 * must not read as a usage limit.
 */
export function isRateLimitErrorText(msg: unknown): boolean {
  const s = String(msg ?? "");
  return /rate.?limit|too many requests|\b429\b|(?:usage|weekly|monthly|daily)\s+limit|spending\s+(?:cap|limit)|free.usage.exhausted/i.test(s);
}

/**
 * True when a turn failure is a rate/usage-limit: the structured -32003 code
 * wins regardless of wording; the text classifier is the fallback for
 * surfaces that flatten the error to a string (retry-exhaustion notes).
 */
export function isRateLimitError(err: unknown): boolean {
  const e = err as any;
  if (e?.code === RATE_LIMITED_ERROR_CODE) return true;
  return isRateLimitErrorText(errorDetail(e));
}

/**
 * User-facing notice for a rate-limited turn (#57). Leads with the
 * not-a-sign-in clarification (the reported confusion was exactly "limit
 * reached → login screen"), then the wire detail when it says anything (the
 * bare "Rate limited" doesn't), else the CLI's own generic copy. No reset date
 * is shown because none exists on the wire — the quota window is
 * backend-config-driven and the CLI deliberately promises no duration.
 */
export function rateLimitNoticeText(err: unknown): string {
  const raw = errorDetail(err)
    .replace(/^subscription:free-usage-exhausted:?\s*/i, "")
    .trim();
  const body = raw && !/^rate ?limited\.?$/i.test(raw) ? raw : GENERIC_RATE_LIMIT_TEXT;
  return `Usage limit reached \u{2014} not a sign-in issue. ${body}`;
}

/**
 * User-facing notice for a billing/entitlement-flavored turn failure that is
 * NOT a credential problem (#58). Leads with the not-a-sign-in clarification —
 * the reported loop was exactly "no entitlement → sign-in screen → sign-in
 * can't fix it". The "no Grok Build access" diagnosis is added only when the
 * wording actually says subscription/entitlement (a generic billing message
 * must not be over-diagnosed). The CLI's own text carries the actionable
 * advice — including its "API key shadowed by cached OAuth session → run
 * `grok logout`" hint — so it's shown verbatim.
 */
export function entitlementNoticeText(err: unknown): string {
  const detail = errorDetail(err).trim();
  const noAccess = /\bsubscription\b|\bentitl/i.test(detail)
    ? "This account doesn't have Grok Build access (it needs SuperGrok or X Premium+ — or sign out to use an XAI_API_KEY instead). "
    : "";
  return `Not a sign-in issue \u{2014} signing in again won't fix this. ${noAccess}${detail}`;
}

/**
 * The text a failed prompt turn surfaces in chat: the friendly limit notice
 * for a rate-limited error, the entitlement notice for billing-flavored
 * wording that is not a credential failure (#58), else the error's own
 * message.
 */
export function promptErrorText(err: unknown): string {
  if (isRateLimitError(err)) return rateLimitNoticeText(err);
  const detail = errorDetail(err);
  if (!isCredentialError(err) && isAuthErrorText(detail)) return entitlementNoticeText(err);
  return detail;
}

/**
 * Map a model id reported by grok onto the id present in `availableModels`.
 * grok's `session/set_model` (and, on some builds, session load) echoes a
 * **versioned** id — e.g. it resolves a request for `grok-build` to
 * `grok-build-0.1` — but the model *list* still uses the base `grok-build`.
 * Left unreconciled, `currentModelId` matches nothing, so the toolbar shows the
 * raw id instead of "Grok Build" and the context-window lookup falls back to the
 * default (200K instead of grok-build's 512K). Exact match wins; otherwise a
 * base-id prefix match (`grok-build-0.1` → `grok-build`); otherwise the input is
 * returned unchanged. The prefix match prefers the **longest** (most specific)
 * candidate, so a future `grok-build-mini-0.1` resolves to `grok-build-mini`, not
 * `grok-build`. Pure.
 */
export function resolveModelId(
  id: string | undefined,
  availableModels: { modelId: string }[] | undefined,
): string | undefined {
  if (!id || !availableModels?.length) return id;
  if (availableModels.some((m) => m.modelId === id)) return id;
  let best: string | undefined;
  for (const m of availableModels) {
    if (id.startsWith(m.modelId) || m.modelId.startsWith(id)) {
      if (!best || m.modelId.length > best.length) best = m.modelId;
    }
  }
  return best ?? id;
}
