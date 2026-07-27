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
  listSessions: "view",
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
  // File baselines undo/view write or open host disk — desktop only.
  viewTurnBaseline: "host-local",
  undoTurnFiles: "host-local",
  exportExpr: "host-local",
  openGlobalConfig: "host-local",
  openProjectConfig: "host-local",
  runMcpList: "host-local",
  showLogs: "host-local",
  moveView: "host-local",
  dropFile: "host-local",
  pickFile: "host-local",
  voiceStart: "host-local",
  voiceStop: "host-local",
  // these write the HOST user's global config — a remote should get a
  // per-connection view pref instead (not built yet), so they stay host-local
  setShowThinking: "host-local",
  setExpandCommandOutputs: "host-local",
  setSteerByDefault: "host-local",
  setSoundNotifications: "host-local",
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
      return isKnownCwd(msg.cwd);
    case "resumeSession":
      return !msg.cwd || isKnownCwd(msg.cwd);
    default:
      return true;
  }
}

/** Which side a webview message came from. */
export type MsgOrigin = "local" | "remote";

/**
 * Which repository a client's history list and *New session* target.
 *
 * The repo selection is **global**, and deliberately so — that IS the remote
 * feature: one phone drives whichever project you pick, and every remote client
 * agrees on it. But the VS Code webview hides the switcher, because that window
 * already IS a repository. It can therefore neither show the selection nor
 * change it, which makes following it strictly harmful: a phone that switched
 * repos would silently re-scope the local history list, and point the local
 * *New session* button at a different checkout — where Grok would then write
 * files. So a local client reads its own workspace and ignores the selection.
 *
 * Restore this to a single global value only if/when VS Code grows the switcher
 * too; the split exists to match the affordance, not the transport.
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
  voiceState: "host-local",
  voiceConfigured: "host-local",
  voicePartial: "host-local",
  voiceSubmit: "host-local",
  voiceTranscript: "host-local",
  voiceError: "host-local",
  initialState: "mirror",
  showThinking: "mirror",
  fontScale: "mirror",
  grokUpdateStatus: "mirror",
  initialized: "mirror",
  cliUpdating: "mirror",
  session: "mirror",
  modelChanged: "mirror",
  modeChanged: "mirror",
  openModePopover: "mirror",
  chips: "mirror",
  commandsUpdate: "mirror",
  mentionResults: "mirror",
  userMessage: "mirror",
  agentStart: "mirror",
  turnBaselines: "mirror",
  thoughtChunk: "mirror",
  messageChunk: "mirror",
  userMessageChunk: "mirror",
  historyReplay: "mirror",
  permissionHistoryQueue: "mirror",
  planHistoryQueue: "mirror",
  planProcessing: "mirror",
  toolCall: "mirror",
  toolCallUpdate: "mirror",
  permissionRequest: "mirror",
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
  xaiNotification: "mirror",
  subagentUpdate: "mirror",
  runProgress: "mirror",
  commandOutput: "mirror",
  expandCommandOutputs: "mirror",
  steerByDefault: "mirror",
  soundNotifications: "mirror",
  remoteStatus: "host-local",
  setAllToolDetails: "mirror",
  focusInput: "mirror",
  restoreComposer: "mirror",
  truncateMessages: "mirror",
  uiConfirmRequest: "mirror",
  sessions: "mirror",
  repos: "mirror",
  sessionDot: "mirror",
  queuedSends: "mirror",
  steerUnavailable: "mirror",
  usage: "mirror",
};

// ---------- media inlining ----------

/** Base64 expansion is ~4/3; 25MiB of file stays well under a sane ws frame. */
export const MAX_REMOTE_MEDIA_BYTES = 25 * 1024 * 1024;

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

/** The single outbound choke point: what (if anything) crosses to a remote for
 *  this HostMsg. Returns the message to send, or null to suppress. */
export function transformHostMsgForRemote(msg: HostMsg, deps: MediaInlineDeps): HostMsg | null {
  switch (OUTBOUND_DISPOSITION[msg.type]) {
    case "mirror":
      return msg;
    case "media":
      return inlineMediaForRemote(msg as MediaMsg, deps);
    default:
      return null; // host-local
  }
}
