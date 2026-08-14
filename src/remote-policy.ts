// Remote-control policy (Phase 1) — the per-message classification table for
// remote clients, as code.
//
// Pure: no vscode/fs/network imports. The exhaustive Record maps mirror the
// protocol.ts pattern — adding a message type to HostMsg/WebviewMsg without
// classifying it here is a compile error, so the table can never silently drift
// behind the protocol.
//
// Two directions:
//   - inbound  (remote client -> host): WebviewMsg, gated by capability tier.
//   - outbound (host -> remote client): HostMsg, mirrored / transformed / suppressed.

import type { HostMsg, WebviewMsg } from "./protocol";
import { isImageChip, type FileChip } from "./chips";
import { isPrimerText } from "./grok-primer";
import { countsAsUserBubble } from "./plan-restore";
import { historyEventCount } from "./rewind";

export const REMOTE_HISTORY_USER_LIMIT = 10;
/** Keep reconnect history comfortably below the relay's 36 MiB WS ceiling. */
export const REMOTE_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;

function remoteUserMessageIndexes(buffer: readonly HostMsg[]): number[] {
  const indexes: number[] = [];
  let chunkStart = -1;
  let chunkText = "";
  const finishChunks = () => {
    if (chunkStart >= 0 && !isPrimerText(chunkText) && countsAsUserBubble(chunkText)) {
      indexes.push(chunkStart);
    }
    chunkStart = -1;
    chunkText = "";
  };
  buffer.forEach((msg, index) => {
    if (msg.type === "userMessageChunk") {
      if (chunkStart < 0) chunkStart = index;
      chunkText += msg.text;
      return;
    }
    finishChunks();
    if (msg.type === "userMessage" && !msg.steer) indexes.push(index);
  });
  finishChunks();
  return indexes;
}

type CounterPositioned = {
  afterUserMessage?: number;
  afterHistoryEvent?: number;
  [key: string]: unknown;
};

function shiftCounterEntries(
  entries: readonly unknown[],
  droppedUsers: number,
  droppedHistoryEvents: number,
): unknown[] {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [entry];
    const positioned = entry as CounterPositioned;
    const hasUserPosition = typeof positioned.afterUserMessage === "number";
    const hasHistoryPosition = typeof positioned.afterHistoryEvent === "number";
    if (hasUserPosition && positioned.afterUserMessage! <= droppedUsers) return [];
    if (!hasUserPosition && hasHistoryPosition && positioned.afterHistoryEvent! <= droppedHistoryEvents) return [];
    return [{
      ...positioned,
      ...(hasUserPosition
        ? { afterUserMessage: positioned.afterUserMessage! - droppedUsers }
        : {}),
      ...(hasHistoryPosition
        ? { afterHistoryEvent: positioned.afterHistoryEvent! - droppedHistoryEvents }
        : {}),
    }];
  });
}

function shiftCounterMessage(
  msg: HostMsg,
  droppedUsers: number,
  droppedHistoryEvents: number,
): HostMsg | null {
  if (msg.type === "planHistoryQueue") {
    return {
      ...msg,
      plans: shiftCounterEntries(msg.plans, droppedUsers, droppedHistoryEvents) as typeof msg.plans,
    };
  }
  if (msg.type === "permissionHistoryQueue") {
    return {
      ...msg,
      permissions: shiftCounterEntries(msg.permissions, droppedUsers, droppedHistoryEvents),
    };
  }
  if (msg.type === "usage" && typeof msg.afterUserMessage === "number") {
    if (msg.afterUserMessage <= droppedUsers) return null;
    return {
      ...msg,
      afterUserMessage: msg.afterUserMessage - droppedUsers,
      ...(typeof msg.afterHistoryEvent === "number"
        ? { afterHistoryEvent: msg.afterHistoryEvent - droppedHistoryEvents }
        : {}),
    };
  }
  return msg;
}

function snapshotMessages(
  buffer: readonly HostMsg[],
  userIndexes: readonly number[],
  start: number,
): HostMsg[] {
  const droppedUsers = userIndexes.filter((index) => index < start).length;
  const droppedHistoryEvents = historyEventCount(buffer.slice(0, start));
  const preamble = droppedUsers > 0
    ? buffer.slice(0, start)
      .filter((msg) => msg.type === "planHistoryQueue" || msg.type === "permissionHistoryQueue")
      .flatMap((msg) => {
        const shifted = shiftCounterMessage(msg, droppedUsers, droppedHistoryEvents);
        return shifted ? [shifted] : [];
      })
    : [];
  return [
    ...preamble,
    ...buffer.slice(start)
      .filter((msg) => msg.type !== "historyReplay")
      .flatMap((msg) => {
        const shifted = shiftCounterMessage(msg, droppedUsers, droppedHistoryEvents);
        return shifted ? [shifted] : [];
      }),
  ];
}

function historyBatchBytes(messages: readonly HostMsg[]): number {
  return new TextEncoder().encode(JSON.stringify({ type: "historyBatch", messages })).length;
}

/** Mark a reconnect snapshot as replayed UI state. The batch owns one outer
 * bracket pair, so buffered load-session brackets are removed before delivery. */
export function bracketRemoteSnapshot(buffer: readonly HostMsg[]): HostMsg[] {
  const userIndexes = remoteUserMessageIndexes(buffer);
  const droppedUsers = Math.max(0, userIndexes.length - REMOTE_HISTORY_USER_LIMIT);
  let start = droppedUsers > 0 ? userIndexes[droppedUsers] : 0;
  let messages = snapshotMessages(buffer, userIndexes, start);

  // A user boundary is the smallest PREFERRED unit to discard: removing anything
  // inside it makes the replay begin halfway through a turn. Rebuild the
  // counters after every byte-budget cut because the final dropped prefix may
  // contain more user/history events than the turn cap alone did. Bounded by
  // the turn cap, so this runs at most REMOTE_HISTORY_USER_LIMIT times.
  while (historyBatchBytes(messages) > REMOTE_HISTORY_BYTE_LIMIT) {
    const next = userIndexes.find((index) => index > start);
    if (next === undefined) break;
    start = next;
    messages = snapshotMessages(buffer, userIndexes, start);
  }

  // If the newest turn busts the budget on its own, deliver it anyway. The
  // budget exists to keep a phone's reconnect cheap, NOT as a safety mechanism:
  // the relay's frame ceiling is 4.5x this, so an over-budget single turn still
  // arrives intact. Measured before deciding — the largest real conversation on
  // disk is 2.8 MB in total, so anything past 8 MiB in ONE turn is far outside
  // what this codebase has ever seen, and machinery to trim inside a turn cost
  // more surface than the case was worth.
  return [
    { type: "historyReplay", active: true },
    { type: "historyBatch", messages },
    { type: "historyReplay", active: false },
  ];
}

// ---------- inbound: WebviewMsg from a remote client ----------

/** Capability tier of a remote connection (design doc § Trust model). v1 ships
 *  one tier — "full" — but the gate is tier-shaped so the read-only/propose
 *  split lands without reshaping call sites. */
export type RemoteTier = "read-only" | "propose" | "full";

export type InboundDisposition =
  /** Transport-level handshake — the bridge/relay answers it itself; never routed to the host. */
  | "control"
  /** Read-only view ops — allowed at every tier. */
  | "view"
  /** Input/turn control — allowed at propose and full. */
  | "propose"
  /** Approvals, destructive ops, host-CLI mutations — full tier only. */
  | "full"
  /** Acts on the LOCAL VS Code window (native pickers, editors, config, mic) — never valid from a remote. */
  | "host-local";

export const INBOUND_DISPOSITION: Record<WebviewMsg["type"], InboundDisposition> = {
  // transport
  ready: "control",
  // view (read-only+)
  remotePreferences: "view",
  listSessions: "view",
  // Same read as listSessions, aimed at a repo the client is not currently in
  // (the projects rail previews a few sessions per repo). The host resolves the
  // cwd through the repo catalog it already published, so this reaches nothing
  // a read-only remote could not already see by selecting that repo.
  listRepoSessions: "view",
  selectRepo: "view",
  toggleRepoPin: "full",
  resumeSession: "view",
  renameSession: "view",
  // read-only workspace file-name lookup (the composer's @ popover)
  mentionQuery: "view",
  // input/turn control (propose+)
  send: "propose",
  newSession: "propose",
  cancel: "propose",
  setMode: "propose",
  setEffort: "propose",
  setModel: "propose",
  questionAnswer: "propose",
  questionCancel: "propose",
  queueSend: "propose",
  dequeueSend: "propose",
  clearQueuedSends: "propose",
  steerSend: "propose",
  forkSession: "propose",
  // Worktree create/apply/remove and rewind are driven by native VS Code UI on
  // the host (input box for the worktree label, confirms, QuickPick) — a remote
  // tap would stall on a dialog nobody at the desk can see. Desktop-only until
  // the flows get remote-capable UI (2026-07-24; the remote client also hides
  // these gear items).
  newWorktreeSession: "host-local",
  applyWorktree: "host-local",
  removeWorktree: "host-local",
  rewindSession: "host-local",
  // Edit-and-resend is a rewind underneath (native modal confirm), so it carries
  // the same desktop-only restriction — and it discards code, which a remote tap
  // must not trigger against a desk nobody is watching.
  editLastMessage: "host-local",
  // The last gate before a rewind reverts files — only the local webview answers.
  uiConfirmAnswer: "host-local",
  // Workflow pause/resume/stop is a slash turn (same class as queueSend/steer).
  workflowControl: "propose",
  pasteImage: "propose",
  // Host validates the extension/name/bytes before staging under globalStorage.
  uploadFile: "propose",
  removeChip: "propose",
  toggleChip: "propose",
  // attaches a chip only after an exact host mention-catalog lookup plus
  // lexical + canonical workspace containment — same composer-state class
  // as removeChip/toggleChip
  addMentionFile: "propose",
  // recheckConnection restarts the CLI session on the host — turn control, not handshake
  recheckConnection: "propose",
  // approvals + destructive + host-CLI mutations (full only)
  permissionAnswer: "full",
  exitPlanAnswer: "full",
  logout: "full",
  deleteSession: "full",
  clearAllSessions: "full",
  updateGrok: "full",
  checkGrokUpdate: "full",
  runInstallCmd: "full",
  runGrokLogin: "full",
  // host-local: native pickers/editors/config/mic on the dev box
  pickModel: "host-local",
  openFile: "host-local",
  openUrl: "host-local",
  openText: "host-local",
  openDiff: "host-local",
  exportExpr: "host-local",
  openGlobalConfig: "host-local",
  openProjectConfig: "host-local",
  // MCP enable/disable writes the desk's user config — never a remote concern.
  listMcpServers: "host-local",
  setMcpServerEnabled: "host-local",
  showLogs: "host-local",
  moveView: "host-local",
  dropFile: "host-local",
  pickFile: "host-local",
  voiceStart: "host-local",
  voiceStop: "host-local",
  remoteVoiceStart: "propose",
  remoteVoiceChunk: "propose",
  remoteVoiceStop: "propose",
  // these write the HOST user's global config — a remote should get a
  // per-connection view pref instead (not built yet), so they stay host-local
  setShowThinking: "host-local",
  setExpandCommandOutputs: "host-local",
  setSteerByDefault: "host-local",
  setSoundNotifications: "host-local",
  setProcessingSound: "host-local",
  setReadRepliesAloud: "host-local",
  setSummarizeRepliesAloud: "host-local",
  // A remote may spend one extra xAI call to shorten text it is about to speak.
  // The host independently requires that tab's reported TTS + summary prefs.
  summarizeSpeech: "propose",
  // Reads a file, so it looks host-local — but the handle was issued BY the host
  // for a picture it already sent this tab, so it grants no reach the remote did
  // not already have. Path-based would be a different question entirely.
  requestImageFull: "propose",
  composerFocus: "host-local",
  // relay account actions (link/unlink/portal) manage THIS machine's device
  // token — only the local webview may drive them
  remoteSignIn: "host-local",
  remoteSignOut: "host-local",
  openRemotePortal: "host-local",
};

const TIER_RANK: Record<RemoteTier, number> = { "read-only": 0, propose: 1, full: 2 };

/** May this WebviewMsg type, arriving from a remote connection of `tier`, be
 *  routed into the host's onMessage? `control` and `host-local` are never
 *  routed regardless of tier. */
export function allowFromRemote(type: WebviewMsg["type"], tier: RemoteTier): boolean {
  const d = INBOUND_DISPOSITION[type];
  switch (d) {
    case "view":
      return true;
    case "propose":
      return TIER_RANK[tier] >= TIER_RANK.propose;
    case "full":
      return TIER_RANK[tier] >= TIER_RANK.full;
    default:
      return false; // control | host-local
  }
}

/** Cwd-bearing remote messages may only name a catalog the host discovered.
 *  `isKnownCwd` is a predicate rather than a prebuilt set so the host can answer
 *  it lazily: resolving the catalog walks the session store on disk, and this
 *  gate sees every inbound message — including per-keystroke `mentionQuery`. */
export function allowRemoteRepoTarget(msg: WebviewMsg, isKnownCwd: (cwd: string) => boolean): boolean {
  switch (msg.type) {
    case "selectRepo":
    case "toggleRepoPin":
    case "clearAllSessions":
    case "listRepoSessions":
      return isKnownCwd(msg.cwd);
    case "resumeSession":
      return !msg.cwd || isKnownCwd(msg.cwd);
    default:
      return true;
  }
}

export function sessionForRequest<T>(
  origin: MsgOrigin,
  local: T,
  remote: T | undefined,
): T | undefined {
  return origin === "remote" ? remote : local;
}

export function sessionCwdBelongsToRepo(
  actualCwd: string,
  repoCwds: readonly string[],
  sameCwd: (a: string, b: string) => boolean,
): boolean {
  return repoCwds.some((cwd) => sameCwd(actualCwd, cwd));
}

/** The narrow desk-adoption path for a tab that arrives without a session. */
export function shouldAdoptDeskSession(
  deskCwd: string,
  repoCwds: readonly string[],
  deskSessionVisible: boolean,
  sameCwd: (a: string, b: string) => boolean,
): boolean {
  return !deskSessionVisible && sessionCwdBelongsToRepo(deskCwd, repoCwds, sameCwd);
}

/** Which side a webview message came from. */
export type MsgOrigin = "local" | "remote";

/**
 * Which repository a client's history list and *New session* target.
 *
 * `selectedCwd` belongs to one remote client (tracked by RemoteClientState).
 * The local VS Code webview always uses its workspace because it has no repo
 * switcher and owns a separate focused session.
 */
export function repoScopeFor(
  origin: MsgOrigin,
  scopes: { selectedCwd: string; workspaceRoot: string },
): string {
  if (origin === "local") return scopes.workspaceRoot;
  return scopes.selectedCwd || scopes.workspaceRoot;
}

// ---------- outbound: HostMsg to a remote client ----------

export type OutboundDisposition =
  /** Pure data — ferry as-is. */
  | "mirror"
  /** Carries a webview-only asWebviewUri src — must be inlined to base64 first. */
  | "media"
  /** Meaningless/misleading outside the local webview (host mic/voice) — suppress. */
  | "host-local";

export const OUTBOUND_DISPOSITION: Record<HostMsg["type"], OutboundDisposition> = {
  media: "media",
  voiceState: "mirror",
  voiceConfigured: "mirror",
  voicePartial: "mirror",
  voiceSubmit: "mirror",
  voiceTranscript: "mirror",
  voiceError: "mirror",
  initialState: "mirror",
  showThinking: "mirror",
  fontScale: "mirror",
  grokUpdateStatus: "mirror",
  initialized: "mirror",
  cliUpdating: "mirror",
  session: "mirror",
  modelChanged: "mirror",
  modeChanged: "mirror",
  planModeAvailability: "mirror",
  openModePopover: "mirror",
  // The MCP manager opens desktop configuration files and is intentionally
  // unavailable in browser clients.
  openMcpServers: "host-local",
  chips: "mirror",
  commandsUpdate: "mirror",
  mentionResults: "mirror",
  userMessage: "mirror",
  agentStart: "mirror",
  thoughtChunk: "mirror",
  messageChunk: "mirror",
  userMessageChunk: "mirror",
  historyReplay: "mirror",
  historyBatch: "mirror",
  permissionHistoryQueue: "mirror",
  planHistoryQueue: "mirror",
  toolCall: "mirror",
  toolCallUpdate: "mirror",
  permissionRequest: "mirror",
  permissionOptions: "mirror",
  permissionResolved: "mirror",
  exitPlanRequest: "mirror",
  planResolved: "mirror",
  questionRequest: "mirror",
  planNotice: "mirror",
  autoCompactNotice: "mirror",
  planBlocked: "mirror",
  promptComplete: "mirror",
  contextUsage: "mirror",
  agentReset: "mirror",
  agentError: "mirror",
  agentEnd: "mirror",
  exit: "mirror",
  setBusy: "mirror",
  summarizing: "mirror",
  sessionContext: "mirror",
  clearMessages: "mirror",
  onboarding: "mirror",
  error: "mirror",
  hostNotice: "mirror",
  xaiNotification: "mirror",
  subagentUpdate: "mirror",
  runProgress: "mirror",
  commandOutput: "mirror",
  expandCommandOutputs: "mirror",
  steerByDefault: "mirror",
  soundNotifications: "mirror",
  processingSound: "host-local",
  readRepliesAloud: "host-local",
  summarizeRepliesAloud: "host-local",
  // Only the shortened text is returned; sidebar targets it to the requester.
  speechSummary: "mirror",
  // Like speechSummary: sidebar targets it at the requesting tab only, so one
  // phone's enlarged picture never lands in another tab's overlay.
  imageFull: "mirror",
  moveComposerCaret: "host-local",
  remoteStatus: "host-local",
  setAllToolDetails: "mirror",
  focusInput: "mirror",
  restoreComposer: "mirror",
  truncateMessages: "mirror",
  uiConfirmRequest: "mirror",
  sessions: "mirror",
  repoSessions: "mirror",
  repos: "mirror",
  sessionDot: "mirror",
  queuedSends: "mirror",
  submitQueuedSend: "mirror",
  steerUnavailable: "mirror",
  usage: "mirror",
  // MCP panel is desk-only (config writes + gear UI); remotes hide the section.
  mcpServers: "host-local",
};

// ---------- media inlining ----------

/** Base64 expansion is ~4/3; 25MiB of file stays well under a sane ws frame. */
export const MAX_REMOTE_MEDIA_BYTES = 25 * 1024 * 1024;
/** Chip/history previews are decoration, so keep their relay payload small. */
export const MAX_REMOTE_THUMBNAIL_BYTES = 96 * 1024;
const MAX_REMOTE_THUMBNAIL_CACHE_ENTRIES = 32;

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function mediaMimeFromPath(p: string): string {
  const dot = p.lastIndexOf(".");
  const ext = dot >= 0 ? p.slice(dot).toLowerCase() : "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export interface MediaInlineDeps {
  /** Read a file's bytes, or null if unreadable. Injected so the policy stays pure. */
  readFile: (path: string) => Uint8Array | null;
  /** Base64-encode bytes (Buffer.toString("base64") on the host). */
  toBase64: (bytes: Uint8Array) => string;
  maxBytes?: number;
  /** Optional host-native image resizer. It returns the encoded mime alongside
   *  the bytes because the encoder picks per image — a PNG source can come back
   *  as JPEG when that is smaller — and a data: URI labelled with the SOURCE
   *  mime would then describe bytes that are not in that format. A missing
   *  resizer falls back to the thumbnail byte budget and still refuses
   *  oversized source files. */
  thumbnail?: (
    bytes: Uint8Array,
    mimeType: string,
    maxDimension: number,
  ) => { bytes: Uint8Array; mime: string } | null;
  /** Issue (or reuse) the opaque handle a remote can later exchange for a
   *  full-size render of this path. Called only where a thumbnail is actually
   *  being sent, so the set of fetchable images stays exactly the set already
   *  shown. */
  registerFullImage?: (path: string) => string | undefined;
  /** Optional bounded cache supplied by the host for repeated history replays. */
  thumbnailCache?: Map<string, string | null>;
  /** File mtime used with {@link thumbnailCache} to invalidate changed images. */
  mtimeMs?: (path: string) => number | undefined;
}

type MediaMsg = Extract<HostMsg, { type: "media" }>;

/** Rewrite a `media` HostMsg so it renders outside the webview: an
 *  asWebviewUri/file src becomes a base64 data: URI read from `path`.
 *  - videos are NOT transferred to remotes at all (product decision — they can
 *    be tens of MB per message; watch them in VS Code) → null.
 *  - src already a data: URI, or a plain remote url with no src → unchanged.
 *  - no readable path / over the size cap → null (caller drops the message;
 *    a broken <img> is worse than an absent one). */
export function inlineMediaForRemote(msg: MediaMsg, deps: MediaInlineDeps): MediaMsg | null {
  if (msg.media === "video") return null;
  if (msg.src && msg.src.startsWith("data:")) return msg;
  if (!msg.src && msg.url) return msg; // remote URL pass-through — the browser can load it
  if (!msg.path) return null;
  const bytes = deps.readFile(msg.path);
  if (!bytes) return null;
  const cap = deps.maxBytes ?? MAX_REMOTE_MEDIA_BYTES;
  if (bytes.byteLength > cap) return null;
  const mime = msg.mimeType || mediaMimeFromPath(msg.path);
  if (mime.startsWith("video/")) return null; // belt for a mis-tagged media field
  return { ...msg, mimeType: mime, src: `data:${mime};base64,${deps.toBase64(bytes)}` };
}

function thumbnailDataUri(path: string | undefined, mimeType: string | undefined, deps: MediaInlineDeps): string | undefined {
  if (!path) return undefined;
  const mtimeMs = deps.mtimeMs?.(path);
  const cacheKey = mtimeMs !== undefined && Number.isFinite(mtimeMs) ? `${path}\0${mtimeMs}` : undefined;
  if (cacheKey && deps.thumbnailCache?.has(cacheKey)) {
    const cached = deps.thumbnailCache.get(cacheKey);
    if (cached) {
      deps.thumbnailCache.delete(cacheKey);
      deps.thumbnailCache.set(cacheKey, cached);
    }
    return cached ?? undefined;
  }
  const bytes = deps.readFile(path);
  if (!bytes) return undefined;
  const mime = mimeType || mediaMimeFromPath(path);
  if (!mime.startsWith("image/")) return undefined;
  const thumb = deps.thumbnail
    ? deps.thumbnail(bytes, mime, 320)
    : { bytes, mime };
  const result = thumb && thumb.bytes.byteLength > 0 && thumb.bytes.byteLength <= MAX_REMOTE_THUMBNAIL_BYTES
    ? `data:${thumb.mime};base64,${deps.toBase64(thumb.bytes)}`
    : undefined;
  if (cacheKey && deps.thumbnailCache) {
    deps.thumbnailCache.delete(cacheKey);
    deps.thumbnailCache.set(cacheKey, result ?? null);
    while (deps.thumbnailCache.size > MAX_REMOTE_THUMBNAIL_CACHE_ENTRIES) {
      const oldest = deps.thumbnailCache.keys().next().value;
      if (oldest === undefined) break;
      deps.thumbnailCache.delete(oldest);
    }
  }
  return result;
}

function dataUriFitsThumbnailBudget(src: string): boolean {
  const comma = src.indexOf(",");
  if (comma < 0) return false;
  const payload = src.slice(comma + 1);
  if (/;base64$/i.test(src.slice(0, comma))) {
    return Math.ceil(payload.length * 3 / 4) <= MAX_REMOTE_THUMBNAIL_BYTES;
  }
  return payload.length <= MAX_REMOTE_THUMBNAIL_BYTES;
}

function inlineChipPreviewForRemote(chip: FileChip, deps: MediaInlineDeps): FileChip {
  if (!isImageChip(chip)) return chip;
  const src = chip.previewSrc?.startsWith("data:image/") && dataUriFitsThumbnailBudget(chip.previewSrc)
    ? chip.previewSrc
    : thumbnailDataUri(chip.path, chip.mimeType, deps);
  if (!src) {
    const { previewSrc: _previewSrc, ...withoutPreview } = chip;
    return withoutPreview;
  }
  // The handle rides ALONGSIDE the thumbnail: a tab may only enlarge a picture
  // it was actually shown, so issuing it anywhere else would widen that reach.
  const fullId = deps.registerFullImage?.(chip.path);
  return { ...chip, previewSrc: src, ...(fullId ? { fullId } : {}) };
}

type HistoryImage = { imageIndex: number; path?: string; previewSrc?: string; fullId?: string };

function inlineHistoryImageForRemote(image: HistoryImage, deps: MediaInlineDeps): HistoryImage {
  const src = image.previewSrc?.startsWith("data:image/") && dataUriFitsThumbnailBudget(image.previewSrc)
    ? image.previewSrc
    : thumbnailDataUri(image.path, undefined, deps);
  if (!src) {
    const { previewSrc: _previewSrc, ...withoutPreview } = image;
    return withoutPreview;
  }
  const fullId = image.path ? deps.registerFullImage?.(image.path) : undefined;
  return { ...image, previewSrc: src, ...(fullId ? { fullId } : {}) };
}

/** The single outbound choke point: what (if anything) crosses to a remote for
 *  this HostMsg. Returns the message to send, or null to suppress. */
export function transformHostMsgForRemote(msg: HostMsg, deps: MediaInlineDeps): HostMsg | null {
  if (msg.type === "historyBatch") {
    return {
      ...msg,
      messages: msg.messages.flatMap((nested) => {
        const transformed = transformHostMsgForRemote(nested, deps);
        return transformed ? [transformed] : [];
      }),
    };
  }
  if (msg.type === "chips") {
    return { ...msg, chips: msg.chips.map((chip) => inlineChipPreviewForRemote(chip, deps)) };
  }
  if (msg.type === "userMessage") {
    return {
      ...msg,
      ...(msg.chips ? { chips: msg.chips.map((chip) => inlineChipPreviewForRemote(chip, deps)) } : {}),
    };
  }
  if (msg.type === "userMessageChunk") {
    return {
      ...msg,
      ...(msg.images
        ? { images: msg.images.map((image) => inlineHistoryImageForRemote(image, deps)) }
        : {}),
    };
  }
  switch (OUTBOUND_DISPOSITION[msg.type]) {
    case "mirror":
      return msg;
    case "media":
      return inlineMediaForRemote(msg as MediaMsg, deps);
    default:
      return null; // host-local
  }
}
