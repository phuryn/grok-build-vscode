/**
 * Runtime schema validation for renderer → host messages.
 *
 * The Electron renderer is untrusted (preload bridge with ambient authority).
 * A TypeScript cast of arbitrary IPC data to {@link WebviewMsg} is not a
 * security boundary — unknown / malformed messages must be dropped before
 * {@link GrokSidebar} acts on them (openFile, dropFile, logout, prompts, …).
 *
 * Pure module: no Electron, no vscode. VS Code keeps its cast path (sandboxed
 * webview); ElectronWebview.dispatchMessage runs this gate first.
 */
import {
  WEBVIEW_MESSAGE_TYPES,
  type WebviewMsg,
} from "../protocol";

const TYPE_SET = new Set<string>(WEBVIEW_MESSAGE_TYPES);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isStringOrNumber(v: unknown): v is string | number {
  return isString(v) || isNumber(v);
}

/** Optional field: absent, or matching the predicate. */
function opt<T>(v: unknown, pred: (x: unknown) => x is T): boolean {
  return v === undefined || pred(v);
}

/**
 * Validate a raw renderer message. Returns the same object typed as
 * WebviewMsg when shape-ok, or null when it must be dropped.
 *
 * Validation is structural (discriminant + required field types), not a full
 * deep sanitizer of every nested payload — host handlers still apply their
 * own path/auth checks. The point of this gate is to refuse unknown types and
 * messages that lack the fields handlers assume exist.
 */
export function parseWebviewMsg(raw: unknown): WebviewMsg | null {
  if (!isObject(raw)) return null;
  const type = raw.type;
  if (!isString(type) || !TYPE_SET.has(type)) return null;

  switch (type as WebviewMsg["type"]) {
    case "ready":
      if (!opt(raw.tabToken, isString)) return null;
      break;
    case "remotePreferences":
      if (!isNumber(raw.fontScale) || !isBoolean(raw.readRepliesAloud) || !isBoolean(raw.usesTouch)) {
        return null;
      }
      if (!opt(raw.summarizeRepliesAloud, isBoolean)) return null;
      break;
    case "send":
      if (!isString(raw.text)) return null;
      if (!opt(raw.bare, isBoolean)) return null;
      if (!opt(raw.queuedSendId, isString)) return null;
      if (!opt(raw.submissionId, isString)) return null;
      // chips: host re-validates; only require array-or-absent
      if (raw.chips !== undefined && !Array.isArray(raw.chips)) return null;
      break;
    case "newSession":
    case "cancel":
    case "pickModel":
    case "addProjectFolder":
    case "removeProjectFolder":
    case "openGlobalConfig":
    case "openProjectConfig":
    case "listMcpServers":
    case "showLogs":
    case "toggleDevTools":
    case "restartToUpdate":
    case "openSettings":
      if (type === "openSettings" && raw.section !== undefined && !isString(raw.section)) return null;
      break;
    case "setMcpServerEnabled":
      if (!isString(raw.name) || !isBoolean(raw.enabled)) return null;
      break;
    case "openSettingsSurface":
      if (raw.category !== undefined && !isString(raw.category)) return null;
      break;
    case "closeSettingsSurface":
      break;
    case "runInstallCmd":
    case "installCodex":
    case "cancelCodexInstall":
    case "checkGrokUpdate":
    case "updateGrok":
    case "refreshProviders":
    case "pickFile":
    case "voiceStart":
    case "remoteVoiceStart":
    case "clearQueuedSends":
    case "forkSession":
    case "newWorktreeSession":
    case "applyWorktree":
    case "removeWorktree":
    case "remoteSignIn":
    case "remoteSignOut":
    case "unlinkRemoteDevice":
      break;
    case "runGrokLogin":
    case "logout":
    case "recheckConnection":
    case "retryProviderSession":
      if (raw.provider !== undefined && raw.provider !== "grok" && raw.provider !== "codex" && raw.provider !== "claude") return null;
      break;
    case "setMode":
      if (raw.modeId !== "agent" && raw.modeId !== "plan" && raw.modeId !== "yolo") {
        return null;
      }
      break;
    case "removeChip":
    case "toggleChip":
      if (!isString(raw.id)) return null;
      break;
    case "openFile":
    case "showInFolder":
      if (!isString(raw.path)) return null;
      break;
    case "dropFile":
      // VS Code: path (file URI / abs). Desktop: host-minted handle only.
      // Schema allows either; authorization decides which is accepted.
      if (!isBoolean(raw.shift)) return null;
      if (!isString(raw.path) && !isString(raw.handle)) return null;
      if (raw.path !== undefined && !isString(raw.path)) return null;
      if (raw.handle !== undefined && !isString(raw.handle)) return null;
      break;
    case "openUrl":
    case "openUpdateRelease":
      if (!isString(raw.url)) return null;
      break;
    case "openText":
      if (!isString(raw.content)) return null;
      if (!opt(raw.language, isString)) return null;
      if (!opt(raw.filename, isString)) return null;
      break;
    case "openDiff":
      if (!isString(raw.path) || !isString(raw.oldText) || !isString(raw.newText)) return null;
      if (!opt(raw.requestId, isStringOrNumber)) return null;
      if (!opt(raw.replaceAll, isBoolean)) return null;
      if (raw.sites !== undefined && !Array.isArray(raw.sites)) return null;
      break;
    case "exportExpr":
      if (!isString(raw.action) || !isString(raw.kind)) return null;
      break;
    case "setEffort":
      if (!isString(raw.level)) return null;
      break;
    case "moveView":
      if (raw.location !== "panel" && raw.location !== "sidebar" && raw.location !== "auxiliarybar") {
        return null;
      }
      break;
    case "setShowThinking":
    case "setSoundNotifications":
    case "setProcessingSound":
    case "setReadRepliesAloud":
    case "setSummarizeRepliesAloud":
    case "setExpandCommandOutputs":
    case "setSteerByDefault":
    case "setTelemetryEnabled":
    case "composerFocus":
      if (type === "composerFocus") {
        if (!isBoolean(raw.focused)) return null;
      } else if (!isBoolean(raw.value)) {
        return null;
      }
      break;
    case "setVoiceSendPhrase":
      if (!isString(raw.value)) return null;
      break;
    case "setVoiceKeyterms":
      if (!Array.isArray(raw.value) || raw.value.some((item) => !isString(item))) return null;
      break;
    case "setAppPurpose":
      if (raw.value !== "knowledge" && raw.value !== "coding") return null;
      break;
    case "summarizeSpeech":
      if (!isNumber(raw.requestId) || !isString(raw.text)) return null;
      break;
    case "requestImageFull":
      if (!isString(raw.fullId)) return null;
      break;
    case "permissionAnswer":
      if (!isStringOrNumber(raw.requestId) || !isString(raw.optionId)) return null;
      break;
    case "exitPlanAnswer":
      if (!isStringOrNumber(raw.requestId)) return null;
      if (raw.verdict !== "approved" && raw.verdict !== "abandoned" && raw.verdict !== "rejected") {
        return null;
      }
      if (!opt(raw.comment, isString)) return null;
      break;
    case "questionAnswer":
      if (!isStringOrNumber(raw.requestId)) return null;
      break;
    case "questionCancel":
      if (!isStringOrNumber(raw.requestId)) return null;
      break;
    case "setModel":
      if (!isString(raw.modelId)) return null;
      if (raw.provider !== undefined && raw.provider !== "grok" && raw.provider !== "codex" && raw.provider !== "claude") return null;
      break;
    case "listSessions":
      if (!opt(raw.offset, isNumber) || !opt(raw.limit, isNumber) || !opt(raw.query, isString)) {
        return null;
      }
      if (raw.providerCursor !== undefined) {
        if (!isObject(raw.providerCursor)) return null;
        if (!isNumber(raw.providerCursor.grokOffset) || raw.providerCursor.grokOffset < 0) return null;
        if (raw.providerCursor.codexHighWater !== undefined) {
          if (!isObject(raw.providerCursor.codexHighWater)) return null;
          if (!isNumber(raw.providerCursor.codexHighWater.updatedAt)) return null;
          if (!isString(raw.providerCursor.codexHighWater.id)) return null;
        }
      }
      break;
    case "listRepoSessions":
      if (!isString(raw.cwd)) return null;
      if (!opt(raw.limit, isNumber)) return null;
      break;
    case "toggleSessionPin":
      if (!isString(raw.id) || !isBoolean(raw.pinned)) return null;
      if (!opt(raw.cwd, isString)) return null;
      break;
    case "selectRepo":
      if (!isString(raw.cwd)) return null;
      break;
    case "toggleRepoPin":
      if (!isString(raw.cwd) || !isBoolean(raw.pinned)) return null;
      break;
    case "setRepoArchived":
      if (!isString(raw.cwd) || !isBoolean(raw.archived)) return null;
      break;
    case "setRepoColor":
      if (!isString(raw.cwd) || !isString(raw.color)) return null;
      break;
    case "resumeSession":
      if (!isString(raw.id)) return null;
      if (!opt(raw.cwd, isString)) return null;
      break;
    case "renameSession":
      if (!isString(raw.id) || !isString(raw.name)) return null;
      if (!opt(raw.cwd, isString)) return null;
      break;
    case "deleteSession":
      if (!isString(raw.id)) return null;
      if (!opt(raw.name, isString) || !opt(raw.cwd, isString)) return null;
      break;
    case "clearAllSessions":
      if (!isString(raw.cwd)) return null;
      break;
    case "mentionQuery":
      if (!isString(raw.query)) return null;
      break;
    case "addMentionFile":
      if (!isString(raw.relPath)) return null;
      break;
    case "listProjectDir":
      if (!isString(raw.cwd)) return null;
      if (!opt(raw.relPath, isString)) return null;
      break;
    case "readProjectFile":
      if (!isString(raw.cwd) || !isString(raw.relPath)) return null;
      break;
    case "writeProjectFile": {
      if (
        !isString(raw.cwd) ||
        !isString(raw.relPath) ||
        !isString(raw.text) ||
        !isString(raw.expectedAbsPath)
      ) {
        return null;
      }
      const stamp = raw.stamp;
      if (
        !isObject(stamp) ||
        !isNumber(stamp.mtimeMs) ||
        !isNumber(stamp.size)
      ) {
        return null;
      }
      break;
    }
    case "pasteImage":
      if (!isString(raw.mimeType) || !isString(raw.data)) return null;
      if (!opt(raw.previewId, isString)) return null;
      break;
    case "uploadFile":
      if (!isString(raw.name) || !isString(raw.data)) return null;
      break;
    case "voiceStop":
      if (!opt(raw.discard, isBoolean)) return null;
      break;
    case "remoteVoiceChunk":
      if (!isString(raw.data)) return null;
      break;
    case "remoteVoiceStop":
      if (!opt(raw.cancel, isBoolean)) return null;
      break;
    case "queueSend":
    case "steerSend":
      if (!isString(raw.text)) return null;
      break;
    case "dequeueSend":
      if (!isNumber(raw.index)) return null;
      break;
    case "rewindSession":
      if (!opt(raw.userBubbleIndex, isNumber)) return null;
      if (!opt(raw.text, isString)) return null;
      if (!opt(raw.totalUserBubbles, isNumber)) return null;
      break;
    case "editLastMessage":
      if (!isNumber(raw.userBubbleIndex) || !isString(raw.text)) return null;
      if (!opt(raw.totalUserBubbles, isNumber)) return null;
      break;
    case "uiConfirmAnswer":
      if (!isString(raw.id) || !isBoolean(raw.ok)) return null;
      break;
    case "workflowControl":
      if (raw.action !== "pause" && raw.action !== "resume" && raw.action !== "stop") {
        return null;
      }
      if (!isString(raw.displayName)) return null;
      break;
    case "openRemotePortal":
      if (!opt(raw.withHint, isBoolean)) return null;
      break;
    default:
      return null;
  }

  return raw as WebviewMsg;
}

/** True when a raw IPC payload is a known, shape-valid WebviewMsg. */
export function isValidWebviewMsg(raw: unknown): raw is WebviewMsg {
  return parseWebviewMsg(raw) !== null;
}
