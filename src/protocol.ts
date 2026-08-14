// Single source of truth for the host <-> webview message contract.
//
// Two directions, two discriminated unions:
//   - HostMsg     — posted by the extension host (sidebar.ts) to the webview.
//   - WebviewMsg  — posted by the webview (chat.js) back to the host.
//
// Why this file exists: the host->webview direction used to be `post(msg: any)`,
// so a typo'd field or a renamed shape only surfaced as a silently mis-rendered
// (or dropped) message in the webview — the "post one shape, handle another"
// class of bug this project has hit around restore, history pagination, and
// media. Typing `post`/`emit` against HostMsg turns those into compile errors.
//
// The exhaustive `Record<Union["type"], true>` maps below force the runtime
// *_MESSAGE_TYPES arrays to list exactly the union's discriminants (a missing or
// extra key is a tsc error). A companion test (test/protocol.test.ts) asserts the
// webview's own copy of those arrays (media/webview-helpers.js) matches these, and
// that chat.js actually handles every HostMsg type — closing the loop across the
// TS/JS boundary that tsc can't see.
//
// All payload-shape imports are `import type` so this module carries no runtime
// dependency on vscode/acp/etc. — it compiles to just the two arrays, and the
// test can import it without a VS Code environment.

import type { ModelInfo, PromptResultMeta, PromptUsage, PermissionRequest, ExitPlanRequest, QuestionRequest } from "./acp";
import type { FileChip } from "./chips";
import type { RepoListEntry, SessionListEntry } from "./sessions";
import type { Dot } from "./session-pool";
import type { RunProgressUpdate } from "./run-progress";

/** grok's tool-call payload as it comes off the wire (acp emits it untyped). The
 *  webview reads a handful of fields; the index signature keeps assignment from
 *  the raw payload friction-free. */
export interface ToolCallPayload {
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  rawInput?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

/** A single answered plan card replayed on session resume (planHistoryQueue). */
export interface PlanHistoryItem {
  text: string;
  verdict?: "approved" | "rejected" | "abandoned" | undefined;
  afterUserMessage?: number;
  afterInterjection?: number;
  afterHistoryEvent?: number;
  planPath?: string;
  planName?: string;
}

/** host -> webview */
export const HOST_CAPABILITIES = {
  uploadFile: true,
  remoteVoice: true,
} as const;

export type HostMsg =
  | { type: "initialState"; effort: string; cwd: string; useCtrlEnter: boolean; extVersion: string; showThinking: boolean; expandCommandOutputs: boolean; steerByDefault: boolean; soundNotifications: boolean; processingSound: boolean; readRepliesAloud: boolean; capabilities: { uploadFile: boolean; remoteVoice: boolean } }
  | { type: "planModeAvailability"; available: boolean; reason?: string }
  | { type: "showThinking"; value: boolean }
  // grok.soundNotifications — live toggle for the turn-complete/error sound (#59).
  | { type: "soundNotifications"; value: boolean }
  | { type: "processingSound"; value: boolean }
  // grok.readRepliesAloud — local VS Code speech-synthesis preference.
  | { type: "readRepliesAloud"; value: boolean }
  | { type: "summarizeRepliesAloud"; value: boolean }
  | { type: "speechSummary"; requestId: number; text: string }
  | { type: "moveComposerCaret"; direction: "forward" | "previousLine" }
  // Whether this machine holds a relay device token (gear "AFK Pilot" section).
  // Local-webview chrome — never mirrored to remotes.
  | { type: "remoteStatus"; linked: boolean }
  | { type: "fontScale"; value: number }
  | { type: "grokUpdateStatus"; current?: string | null; latest?: string | null; updateAvailable?: boolean; policy?: unknown; error?: string }
  | { type: "initialized"; info: { cliPath: string; cwd: string; version: string | null; init: { protocolVersion?: unknown } } }
  | { type: "cliUpdating" }
  // `worktree` gates the gear's Apply/Remove worktree items to worktree sessions.
  | { type: "session"; sessionId: string; models: ModelInfo[]; currentModelId: string | undefined; worktree?: boolean }
  | { type: "modelChanged"; modelId: string }
  | { type: "modeChanged"; modeId: string }
  | { type: "openModePopover" }
  /** Reveal the MCP management page in the Grok side-bar view. */
  | { type: "openMcpServers" }
  | { type: "voiceState"; status: "listening" | "transcribing" | "idle" }
  | { type: "voiceConfigured"; value: boolean; sendPhrase?: string }
  | { type: "voicePartial"; text: string }
  | { type: "voiceSubmit"; text: string }
  | { type: "voiceTranscript"; text: string; send?: boolean }
  | { type: "voiceError" }
  | { type: "chips"; chips: FileChip[] }
  | { type: "commandsUpdate"; commands: unknown[] }
  // Reply to the webview's `mentionQuery` (the composer's `@` file popover):
  // workspace-relative paths (forward slashes), ranked by src/mention.ts. The
  // echoed `query` lets the webview drop stale replies after further typing.
  | { type: "mentionResults"; query: string; files: string[] }
  /** `steer` marks a mid-turn interjection (#52). It paints a user bubble but is
   *  NOT a prompt and gets no rewind point, so the bubble must not consume a
   *  rewind index — see refreshUserRewindButtons. */
  | { type: "userMessage"; text: string; chips?: FileChip[]; steer?: boolean; submissionId?: string }
  | { type: "agentStart" }
  | { type: "thoughtChunk"; text: string }
  | { type: "messageChunk"; text: string }
  | { type: "media"; media: string; src?: string; url?: string; mimeType?: string; path?: string }
  | {
      type: "userMessageChunk";
      text: string;
      timestampMs?: number;
      images?: Array<{ imageIndex: number; path?: string; previewSrc?: string; fullId?: string }>;
    }
  /** Answer to {@link WebviewMsg} `requestImageFull`. Sent only to the tab that
   *  asked; `src` absent means the source is gone (swept, or deleted). */
  | { type: "imageFull"; fullId: string; src?: string }
  | { type: "historyReplay"; active: boolean }
  /** Remote reconnect snapshot delivered as one browser event. Updated clients
   *  render every nested message synchronously; older per-message frames remain
   *  valid and continue through their existing handlers. */
  | { type: "historyBatch"; messages: HostMsg[] }
  | { type: "permissionHistoryQueue"; permissions: unknown[] }
  | { type: "planHistoryQueue"; plans: PlanHistoryItem[] }
  | { type: "toolCall"; call: ToolCallPayload }
  | { type: "toolCallUpdate"; call: ToolCallPayload }
  | { type: "permissionRequest"; req: PermissionRequest }
  | { type: "permissionOptions"; requestId: number | string; options: PermissionRequest["options"] }
  | { type: "permissionResolved"; requestId: number | string; optionId: string }
  // The host spreads the plan-review snapshot (planPath/planName) into the bare
  // ExitPlanRequest before posting, so the wire shape is wider than acp's type.
  | { type: "exitPlanRequest"; req: ExitPlanRequest & { planPath?: string; planName?: string } }
  | { type: "planResolved"; requestId: number | string; verdict: "approved" | "abandoned" | "rejected" }
  | { type: "questionRequest"; req: QuestionRequest }
  | { type: "planNotice"; text: string }
  | { type: "autoCompactNotice"; text: string }
  | { type: "planBlocked"; kind: string; target: string }
  | { type: "promptComplete"; meta: PromptResultMeta }
  // Context size read from grok's on-disk signals.json — the source that has a
  // real count when the turn meta can't: a cold restore (no turn yet) and a
  // /compact turn (its meta reports 0, stripped by gateZeroTokenMeta).
  | { type: "contextUsage"; used: number; window?: number }
  | { type: "agentReset" }
  | { type: "agentError"; text: string }
  | { type: "agentEnd"; meta?: PromptResultMeta }
  | { type: "exit"; code: number | null }
  | { type: "setBusy"; value: boolean; locked?: boolean }
  | { type: "summarizing" }
  | { type: "sessionContext" }
  | { type: "clearMessages" }
  | { type: "onboarding"; state: "missing-cli" | "auth-required"; platform?: string }
  | { type: "error"; text: string }
  | { type: "hostNotice"; level: "info" | "warning"; text: string }
  | { type: "xaiNotification"; update?: unknown }
  // Persisted xAI lifecycle (method _x.ai/session/update): subagent spawn/finish
  // plus replayed turn_completed, whose timestamp finalizes the agent footer.
  | { type: "subagentUpdate"; update?: unknown; timestampMs?: number }
  // Deep Research / Workflow / Goal progress (P2-10) — normalized from the
  // live `_x.ai/session_notification` rail (`workflow_updated` / `goal_updated`).
  // Cards update in place by `id`; terminal phases stop the live dots.
  | { type: "runProgress"; update: RunProgressUpdate }
  // A finished shell command's full text + captured output (#41) — snapshotted
  // host-side at terminal/release (the extension runs the commands, so the
  // buffer is exactly what grok received). exitCode null = killed/cancelled.
  | { type: "commandOutput"; command: string; output: string; exitCode: number | null; truncated: boolean }
  // grok.expandCommandOutputs — pre-expand every command's IN/OUT detail.
  | { type: "expandCommandOutputs"; value: boolean }
  // grok.steerByDefault — send-while-busy skips the queue and steers (#52).
  | { type: "steerByDefault"; value: boolean }
  // On-demand audit: expand (open:true) / collapse (open:false) EVERY tool group
  // and command IN/OUT box in the focused session at once. Ephemeral (not
  // persisted) — the Command Palette "Grok: Expand/Collapse All Tool Details".
  | { type: "setAllToolDetails"; open: boolean }
  // Move keyboard focus into the composer input (#43) — posted after Send
  // Selection / Send File / @-mention so the user can type a prompt right away.
  // Ephemeral UI action, not session-scoped (goes via `post`, never buffered).
  | { type: "focusInput" }
  /** Put text back in the composer (Edit-and-resend, #56). Posted after the
   *  rewind + reload so it survives the clearMessages/replay that follows. */
  | { type: "restoreComposer"; text: string }
  /** Drop everything after the Nth visible user message (rewind/edit, P2-9).
   *  Replaces the old clearMessages + full reload, which blanked the panel to
   *  the welcome logo and re-rendered the whole conversation. */
  | { type: "truncateMessages"; surviving: number }
  /** Ask the webview to run its own in-chat confirm dialog and report back.
   *  Used where only the HOST knows whether a confirm is warranted (rewind/edit
   *  reverting files), so the webview can't decide to show `uiConfirm` itself.
   *  `id` correlates the answer; the host awaits a promise keyed on it. */
  | { type: "uiConfirmRequest"; id: string; title: string; body?: string; confirmLabel: string; danger?: boolean }
  // nextOffset = the index offset the next load-more should request — ids CONSUMED
  // from the on-disk index, not entries shown (hidden subagent sessions occupy
  // slots without producing rows).
  | { type: "sessions"; entries: SessionListEntry[]; activeId?: string | null; dots: Record<string, Dot>; offset: number; total: number; hasMore: boolean; nextOffset: number; query: string }
  // A preview page for ONE repo, answering `listRepoSessions`. Deliberately a
  // separate frame from `sessions`: that one is the focused history list and
  // owns paging/search/auto-open state, so a sibling repo's rows arriving on it
  // would clobber the list the user is actually reading. `cwd` echoes the scope
  // the host resolved, which is also the capability signal — a client that
  // never sees this frame keeps its single-repo fallback.
  | { type: "repoSessions"; cwd: string; entries: SessionListEntry[]; dots: Record<string, Dot>; total: number }
  | { type: "repos"; entries: RepoListEntry[]; selectedCwd: string; activeCwd: string }
  | { type: "sessionDot"; id: string; dot: Dot }
  // Full snapshot of the focused session's host-owned send queue (#37) — the
  // webview renders pending user blocks from this; replay rebuilds them.
  | { type: "queuedSends"; items: string[] }
  // A remote queued prompt is ready to run. The browser echoes this as an
  // ordinary send carrying the same host-issued id, so relay quota/rate metering
  // applies at dequeue time and replayed/outbox copies are recognisably one send.
  | { type: "submitQueuedSend"; id: string; text: string }
  // Steer (#52) is unavailable on this CLI (`_x.ai/interject` → -32601). Latches
  // the button off for the session; the queue stays as the fallback.
  | { type: "steerUnavailable" }
  // Session-cumulative billing (#53), summed by the host across the session's
  // turns. `turn` is the last prompt's own usage. Both omitted when the CLI sent
  // no `_meta.usage` — the popover then shows only the context row, never zeros.
  | { type: "usage"; turn?: PromptUsage; session?: PromptUsage; afterUserMessage?: number; afterHistoryEvent?: number }
  // MCP servers panel (CLI 0.2.113+). Host-local gear UI; `unsupported` when
  // neither `_x.ai/mcp/list` nor `grok mcp list --json` can supply a catalog.
  // `source` tells the panel whether the rows are live-session or config-only.
  | {
      type: "mcpServers";
      servers: Array<{
        name: string;
        enabled: boolean;
        status?: string;
        source?: string;
        scope?: string;
        type?: string;
        command?: string;
        args?: string[];
        url?: string;
        toolCount?: number;
        error?: string;
      }>;
      unsupported?: boolean;
      source?: "session" | "cli" | "none";
      warning?: string;
    };

/** webview -> host */
export type WebviewMsg =
  | { type: "ready"; tabToken?: string }
  // Browser-owned remote preferences reported for session_start telemetry.
  | { type: "remotePreferences"; fontScale: number; readRepliesAloud: boolean; summarizeRepliesAloud?: boolean; usesTouch: boolean }
  | { type: "send"; text: string; chips?: FileChip[]; bare?: boolean; queuedSendId?: string; submissionId?: string }
  | { type: "newSession" }
  | { type: "cancel" }
  | { type: "pickModel" }
  | { type: "setMode"; modeId: "agent" | "plan" | "yolo" }
  | { type: "removeChip"; id: string }
  | { type: "toggleChip"; id: string }
  | { type: "openFile"; path: string }
  | { type: "openUrl"; url: string }
  | { type: "openText"; content: string; language: string }
  | {
      type: "openDiff";
      path: string;
      oldText: string;
      newText: string;
      requestId?: number | string;
      replaceAll?: boolean;
      sites?: { oldText: string; newText: string; oldLine?: number; newLine?: number }[];
    }
  | { type: "exportExpr"; action: string; kind: string; current?: string; svg?: string; png?: string; svgDark?: string; svgLight?: string }
  | { type: "setEffort"; level: string }
  | { type: "openGlobalConfig" }
  | { type: "openProjectConfig" }
  // Open/refresh the MCP servers gear panel (replaces the old terminal-only list).
  | { type: "listMcpServers" }
  // Persist enable/disable via `grok mcp enable|disable` (global user config).
  | { type: "setMcpServerEnabled"; name: string; enabled: boolean }
  | { type: "showLogs" }
  | { type: "moveView"; location: "panel" | "sidebar" | "auxiliarybar" }
  | { type: "setShowThinking"; value: boolean }
  // grok.soundNotifications gear switch (#59) — persisted globally by the host.
  | { type: "setSoundNotifications"; value: boolean }
  | { type: "setProcessingSound"; value: boolean }
  | { type: "setReadRepliesAloud"; value: boolean }
  | { type: "setSummarizeRepliesAloud"; value: boolean }
  | { type: "summarizeSpeech"; requestId: number; text: string }
  /** Ask the host to render a full-size version of an image it already sent a
   *  thumbnail for. `fullId` is an opaque handle the HOST issued — deliberately
   *  not a path, so a remote can only ask for pictures it was already shown. */
  | { type: "requestImageFull"; fullId: string }
  | { type: "composerFocus"; focused: boolean }
  | { type: "setExpandCommandOutputs"; value: boolean }
  | { type: "setSteerByDefault"; value: boolean }
  | { type: "dropFile"; path: string; shift: boolean }
  | { type: "permissionAnswer"; requestId: number | string; optionId: string }
  | { type: "exitPlanAnswer"; requestId: number | string; verdict: "approved" | "abandoned" | "rejected"; comment?: string }
  | { type: "questionAnswer"; requestId: number | string; answers?: Record<string, string>; annotations?: Record<string, { notes?: string; preview?: string }> }
  | { type: "questionCancel"; requestId: number | string }
  | { type: "setModel"; modelId: string }
  | { type: "runInstallCmd" }
  | { type: "runGrokLogin" }
  | { type: "logout" }
  | { type: "checkGrokUpdate" }
  | { type: "updateGrok" }
  | { type: "recheckConnection" }
  | { type: "listSessions"; offset?: number; limit?: number; query?: string }
  // Preview rows for a repo the client is NOT currently in — the projects rail
  // shows a few sessions per repo without switching to it. `cwd` is matched
  // against the repo catalog and dropped when it isn't a row, so this never
  // widens what a remote can read beyond the repos it is already shown.
  | { type: "listRepoSessions"; cwd: string; limit?: number }
  | { type: "selectRepo"; cwd: string }
  | { type: "toggleRepoPin"; cwd: string; pinned: boolean }
  // cwd is required to reopen a worktree-isolated session (sessions are keyed
  // by cwd on disk). Omitted → host resolves from meta / workspace root.
  | { type: "resumeSession"; id: string; cwd?: string }
  | { type: "renameSession"; id: string; name: string }
  | { type: "deleteSession"; id: string; name?: string }
  | { type: "clearAllSessions"; cwd: string }
  | { type: "pickFile" }
  // The composer's `@` file popover: the current token after `@`, posted on
  // every keystroke; answered by `mentionResults`.
  | { type: "mentionQuery"; query: string }
  // A popover pick: attach this workspace-relative file as an explicit chip
  // (same pipeline as drop / the + picker). The `@rel/path` text stays in the
  // composer, so the prompt carries both the prose reference and the chip.
  | { type: "addMentionFile"; relPath: string }
  | { type: "pasteImage"; mimeType: string; data: string; previewId?: string }
  // Remote browser upload: an untrusted basename plus base64 bytes. The host
  // allowlists/sanitizes/stages it, then routes it through addDroppedFile.
  | { type: "uploadFile"; name: string; data: string }
  | { type: "voiceStart" }
  /** Stop voice input. Manual Send/Queue sets discard so late transcription
   * cannot refill the composer that was just sent. */
  | { type: "voiceStop"; discard?: boolean }
  // AFK Pilot microphone input. Audio remains raw PCM16 LE / 16 kHz / mono;
  // the relay treats these opaque messages like every other WebviewMsg.
  | { type: "remoteVoiceStart" }
  | { type: "remoteVoiceChunk"; data: string }
  | { type: "remoteVoiceStop"; cancel?: boolean }
  // Host-owned send queue mutations (#37): the webview never mutates its local
  // mirror — it posts these and re-renders from the queuedSends snapshot.
  | { type: "queueSend"; text: string }
  | { type: "dequeueSend"; index: number }
  | { type: "clearQueuedSends" }
  // Steer (#52): inject the composed text into the RUNNING turn instead of
  // waiting for it. Host-owned like the queue — the webview never sends the
  // prompt itself, so a -32601 fallback can re-queue the text without losing it.
  | { type: "steerSend"; text: string }
  // Fork (#48): branch this session's conversation into a new one and focus it.
  | { type: "forkSession" }
  // Worktree UI (P2-8): new isolated session / merge back / remove worktree.
  | { type: "newWorktreeSession" }
  | { type: "applyWorktree" }
  | { type: "removeWorktree" }
  // Rewind UI (P2-9): truncate chat + restore files.
  // `userBubbleIndex` (0-based among visible user bubbles) comes from the
  // per-message Rewind button; omit it for the gear QuickPick path.
  /** `text` is the bubble's own cleaned text, sent so the host can hand it back
   *  to the composer — rewind DISCARDS the message it targets, so without this
   *  the user silently loses what they wrote. Absent for the QuickPick path,
   *  which has no bubble to read. */
  | { type: "rewindSession"; userBubbleIndex?: number; text?: string; totalUserBubbles?: number }
  /** Edit-and-resend (#56): rewind past this (latest) user message and hand its
   *  text back to the composer. `text` is the bubble's own cleaned copy text. */
  | { type: "editLastMessage"; userBubbleIndex: number; text: string; totalUserBubbles?: number }
  /** Reply to `uiConfirmRequest`. Host-local only: this is the last gate before
   *  a rewind reverts files, so a remote must never be able to answer one. */
  | { type: "uiConfirmAnswer"; id: string; ok: boolean }
  // Workflow card controls (P2-10): pause / resume / stop by display name.
  | { type: "workflowControl"; action: "pause" | "resume" | "stop"; displayName: string }
  // Relay account (gear "AFK Pilot" section, local webview only): start the
  // device-link flow / drop the device token / open the relay web portal.
  | { type: "remoteSignIn" }
  | { type: "remoteSignOut" }
  | { type: "openRemotePortal"; withHint?: boolean };

// Exhaustive maps: `Record<Union["type"], true>` forces every discriminant to be
// a key (missing -> tsc error) and forbids any extra (excess-property -> tsc
// error). The runtime arrays are just the keys, so they can never drift from the
// union without failing the build.
const HOST_MESSAGE_TYPE_MAP: Record<HostMsg["type"], true> = {
  initialState: true, planModeAvailability: true, showThinking: true, fontScale: true, grokUpdateStatus: true,
  initialized: true, cliUpdating: true, session: true, modelChanged: true,
  modeChanged: true, openModePopover: true, openMcpServers: true, voiceState: true, voiceConfigured: true,
  voicePartial: true, voiceSubmit: true, voiceTranscript: true, voiceError: true,
  chips: true, commandsUpdate: true, mentionResults: true, userMessage: true, agentStart: true,
  thoughtChunk: true, messageChunk: true, media: true, userMessageChunk: true,
  historyReplay: true, historyBatch: true, permissionHistoryQueue: true, planHistoryQueue: true,
  toolCall: true, toolCallUpdate: true, permissionRequest: true, permissionOptions: true,
  permissionResolved: true, exitPlanRequest: true, planResolved: true, questionRequest: true,
  planNotice: true, autoCompactNotice: true, planBlocked: true, promptComplete: true, contextUsage: true, agentReset: true,
  agentError: true, agentEnd: true, exit: true, setBusy: true, summarizing: true,
  sessionContext: true, clearMessages: true, onboarding: true, error: true, hostNotice: true,
  xaiNotification: true, subagentUpdate: true, runProgress: true, commandOutput: true, expandCommandOutputs: true, steerByDefault: true,
  soundNotifications: true, processingSound: true, readRepliesAloud: true, summarizeRepliesAloud: true, speechSummary: true, imageFull: true, moveComposerCaret: true, remoteStatus: true,
  setAllToolDetails: true, focusInput: true, restoreComposer: true, truncateMessages: true, uiConfirmRequest: true,
  sessions: true, repoSessions: true, repos: true, sessionDot: true, queuedSends: true, submitQueuedSend: true,
  steerUnavailable: true, usage: true, mcpServers: true,
};

const WEBVIEW_MESSAGE_TYPE_MAP: Record<WebviewMsg["type"], true> = {
  ready: true, remotePreferences: true, send: true, newSession: true, cancel: true, pickModel: true,
  setMode: true, removeChip: true, toggleChip: true, openFile: true, openUrl: true,
  openText: true, openDiff: true, exportExpr: true, setEffort: true, openGlobalConfig: true,
  openProjectConfig: true, listMcpServers: true, setMcpServerEnabled: true, showLogs: true, moveView: true,
  setShowThinking: true, setExpandCommandOutputs: true, setSteerByDefault: true,
  setSoundNotifications: true, setProcessingSound: true, setReadRepliesAloud: true, setSummarizeRepliesAloud: true, summarizeSpeech: true, requestImageFull: true, composerFocus: true,
  dropFile: true, permissionAnswer: true, exitPlanAnswer: true, questionAnswer: true,
  questionCancel: true, setModel: true, runInstallCmd: true, runGrokLogin: true,
  logout: true, checkGrokUpdate: true, updateGrok: true, recheckConnection: true,
  listSessions: true, listRepoSessions: true, selectRepo: true, toggleRepoPin: true,
  resumeSession: true, renameSession: true, deleteSession: true,
  clearAllSessions: true, pickFile: true, mentionQuery: true, addMentionFile: true,
  pasteImage: true, uploadFile: true, voiceStart: true,
  voiceStop: true, remoteVoiceStart: true, remoteVoiceChunk: true,
  remoteVoiceStop: true, queueSend: true, dequeueSend: true, clearQueuedSends: true,
  steerSend: true, forkSession: true,
  newWorktreeSession: true, applyWorktree: true, removeWorktree: true,
  rewindSession: true, editLastMessage: true, uiConfirmAnswer: true, workflowControl: true,
  remoteSignIn: true, remoteSignOut: true, openRemotePortal: true,
};

export const HOST_MESSAGE_TYPES: readonly HostMsg["type"][] = Object.keys(HOST_MESSAGE_TYPE_MAP) as HostMsg["type"][];
export const WEBVIEW_MESSAGE_TYPES: readonly WebviewMsg["type"][] = Object.keys(WEBVIEW_MESSAGE_TYPE_MAP) as WebviewMsg["type"][];
