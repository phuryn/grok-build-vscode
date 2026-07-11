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

import type { ModelInfo, PromptResultMeta, PermissionRequest, ExitPlanRequest, QuestionRequest } from "./acp";
import type { FileChip } from "./chips";
import type { SessionListEntry } from "./sessions";
import type { Dot } from "./session-pool";

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
  planPath?: string;
  planName?: string;
}

/** host -> webview */
export type HostMsg =
  | { type: "initialState"; effort: string; cwd: string; useCtrlEnter: boolean; extVersion: string; showThinking: boolean }
  | { type: "showThinking"; value: boolean }
  | { type: "fontScale"; value: number }
  | { type: "grokUpdateStatus"; current?: string | null; latest?: string | null; updateAvailable?: boolean; policy?: unknown; error?: string }
  | { type: "initialized"; info: { cliPath: string; cwd: string; version: string | null; init: { protocolVersion?: unknown } } }
  | { type: "cliUpdating" }
  | { type: "session"; sessionId: string; models: ModelInfo[]; currentModelId: string | undefined }
  | { type: "modelChanged"; modelId: string }
  | { type: "modeChanged"; modeId: string }
  | { type: "openModePopover" }
  | { type: "voiceState"; status: "listening" | "transcribing" | "idle" }
  | { type: "voiceConfigured"; value: boolean; sendPhrase?: string }
  | { type: "voicePartial"; text: string }
  | { type: "voiceSubmit"; text: string }
  | { type: "voiceTranscript"; text: string; send?: boolean }
  | { type: "voiceError" }
  | { type: "chips"; chips: FileChip[] }
  | { type: "commandsUpdate"; commands: unknown[] }
  | { type: "userMessage"; text: string; chips?: FileChip[] }
  | { type: "agentStart" }
  | { type: "thoughtChunk"; text: string }
  | { type: "messageChunk"; text: string }
  | { type: "media"; media: string; src?: string; url?: string; mimeType?: string; path?: string }
  | { type: "userMessageChunk"; text: string }
  | { type: "historyReplay"; active: boolean }
  | { type: "permissionHistoryQueue"; permissions: unknown[] }
  | { type: "planHistoryQueue"; plans: PlanHistoryItem[] }
  | { type: "planProcessing" }
  | { type: "toolCall"; call: ToolCallPayload }
  | { type: "toolCallUpdate"; call: ToolCallPayload }
  | { type: "permissionRequest"; req: PermissionRequest }
  | { type: "permissionResolved"; requestId: number | string; optionId: string }
  // The host spreads the plan-review snapshot (planPath/planName) into the bare
  // ExitPlanRequest before posting, so the wire shape is wider than acp's type.
  | { type: "exitPlanRequest"; req: ExitPlanRequest & { planPath?: string; planName?: string } }
  | { type: "questionRequest"; req: QuestionRequest }
  | { type: "planNotice"; text: string }
  | { type: "planBlocked"; kind: string; target: string }
  | { type: "promptComplete"; meta: PromptResultMeta }
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
  | { type: "xaiNotification"; update?: unknown }
  | { type: "sessions"; entries: SessionListEntry[]; activeId?: string; dots: Record<string, Dot>; offset: number; total: number; hasMore: boolean; query: string }
  | { type: "sessionDot"; id: string; dot: Dot }
  // The Grok Workspaces tree view is visible — the chat's own history button
  // hides while it is (the panel is the history surface then; New stays).
  | { type: "historyPanelVisible"; value: boolean }
  // Full snapshot of the focused session's host-owned send queue (#37) — the
  // webview renders pending user blocks from this; replay rebuilds them.
  | { type: "queuedSends"; items: string[] };

/** webview -> host */
export type WebviewMsg =
  | { type: "ready" }
  | { type: "send"; text: string; chips?: FileChip[]; bare?: boolean }
  | { type: "newSession" }
  | { type: "cancel" }
  | { type: "pickModel" }
  | { type: "setMode"; modeId: "agent" | "plan" | "yolo" }
  | { type: "removeChip"; id: string }
  | { type: "toggleChip"; id: string }
  | { type: "openFile"; path: string }
  | { type: "openUrl"; url: string }
  | { type: "openDiff"; path: string; oldText: string; newText: string; requestId?: number | string }
  | { type: "exportExpr"; action: string; kind: string; current?: string; svg?: string; png?: string; svgDark?: string; svgLight?: string }
  | { type: "setEffort"; level: string }
  | { type: "openGlobalConfig" }
  | { type: "openProjectConfig" }
  | { type: "runMcpList" }
  | { type: "showLogs" }
  | { type: "moveView"; location: "panel" | "sidebar" | "auxiliarybar" }
  | { type: "setShowThinking"; value: boolean }
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
  | { type: "resumeSession"; id: string }
  | { type: "renameSession"; id: string; name: string }
  | { type: "deleteSession"; id: string; name?: string }
  | { type: "clearAllSessions" }
  | { type: "pickFile" }
  | { type: "pasteImage"; mimeType: string; data: string }
  | { type: "voiceStart" }
  | { type: "voiceStop" }
  // Host-owned send queue mutations (#37): the webview never mutates its local
  // mirror — it posts these and re-renders from the queuedSends snapshot.
  | { type: "queueSend"; text: string }
  | { type: "dequeueSend"; index: number }
  | { type: "clearQueuedSends" };

// Exhaustive maps: `Record<Union["type"], true>` forces every discriminant to be
// a key (missing -> tsc error) and forbids any extra (excess-property -> tsc
// error). The runtime arrays are just the keys, so they can never drift from the
// union without failing the build.
const HOST_MESSAGE_TYPE_MAP: Record<HostMsg["type"], true> = {
  initialState: true, showThinking: true, fontScale: true, grokUpdateStatus: true,
  initialized: true, cliUpdating: true, session: true, modelChanged: true,
  modeChanged: true, openModePopover: true, voiceState: true, voiceConfigured: true,
  voicePartial: true, voiceSubmit: true, voiceTranscript: true, voiceError: true,
  chips: true, commandsUpdate: true, userMessage: true, agentStart: true,
  thoughtChunk: true, messageChunk: true, media: true, userMessageChunk: true,
  historyReplay: true, permissionHistoryQueue: true, planHistoryQueue: true,
  planProcessing: true, toolCall: true, toolCallUpdate: true, permissionRequest: true,
  permissionResolved: true, exitPlanRequest: true, questionRequest: true,
  planNotice: true, planBlocked: true, promptComplete: true, agentReset: true,
  agentError: true, agentEnd: true, exit: true, setBusy: true, summarizing: true,
  sessionContext: true, clearMessages: true, onboarding: true, error: true,
  xaiNotification: true, sessions: true, sessionDot: true, historyPanelVisible: true,
  queuedSends: true,
};

const WEBVIEW_MESSAGE_TYPE_MAP: Record<WebviewMsg["type"], true> = {
  ready: true, send: true, newSession: true, cancel: true, pickModel: true,
  setMode: true, removeChip: true, toggleChip: true, openFile: true, openUrl: true,
  openDiff: true, exportExpr: true, setEffort: true, openGlobalConfig: true,
  openProjectConfig: true, runMcpList: true, showLogs: true, moveView: true,
  setShowThinking: true,
  dropFile: true, permissionAnswer: true, exitPlanAnswer: true, questionAnswer: true,
  questionCancel: true, setModel: true, runInstallCmd: true, runGrokLogin: true,
  logout: true, checkGrokUpdate: true, updateGrok: true, recheckConnection: true,
  listSessions: true, resumeSession: true, renameSession: true, deleteSession: true,
  clearAllSessions: true, pickFile: true, pasteImage: true, voiceStart: true,
  voiceStop: true, queueSend: true, dequeueSend: true, clearQueuedSends: true,
};

export const HOST_MESSAGE_TYPES: readonly HostMsg["type"][] = Object.keys(HOST_MESSAGE_TYPE_MAP) as HostMsg["type"][];
export const WEBVIEW_MESSAGE_TYPES: readonly WebviewMsg["type"][] = Object.keys(WEBVIEW_MESSAGE_TYPE_MAP) as WebviewMsg["type"][];
