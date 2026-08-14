import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, EffortLevel, ExitPlanRequest, PermissionRequest, QuestionRequest } from "./acp";
import {
  Session,
  SessionStatus,
  beginQueuedSendCommit,
  createPendingPermission,
  finishQueuedSendCommit,
  pendingPermissionOptions,
  preferredPermissionAllowOption,
  sessionUiSnapshot,
} from "./session";
import { buildReapCandidates, selectReapable, computeDot, Dot } from "./session-pool";
import { resolveVoiceKey, extractGrokAuthKey, parseVoiceCommand, buildSttKeyterms, voiceSettingForRepo, DEFAULT_SEND_PHRASE, MAX_RECORDING_SECONDS } from "./voice";
import { VoiceRecorder, transcribeAudio, resolveWindowsAudioDevice } from "./voice-recorder";
import { PcmVoiceStreamer, VoiceStreamer } from "./voice-streamer";
import { summarizeForSpeech } from "./speech-summary";
import type { PromptResultMeta, PromptUsage } from "./acp-dispatch";
import { MediaRef, agentTimestampMsFromMeta, autoCompactStartedNote, contextUsedFromCompactNotification, enforceCompleteSessionCost, errorDetail, gateZeroTokenMeta, isAuthErrorText, isCredentialError, isIncompatibleAgentError, isRateLimitError, isSubagentLifecycleUpdate, permissionOutcomeFor, promptErrorText, rateLimitNoticeText, sumUsage, summarizeBackgroundCommand, usageIsRealMeasurement } from "./acp-dispatch";
import { modeToRemember, startsInYolo } from "./mode-prefs";
import { beginAuthRecovery, oauthShadowsXaiApiKey } from "./auth-recovery";
import { GROK_VIEW_ID, moveViewContainerFor } from "./view-move";
import {
  APTABASE_APP_KEY_PROD,
  buildSessionStartEvent,
  osNameFromPlatform,
  postEvent,
  sessionStartSurface,
  shouldSendTelemetry,
  OFFICIAL_EXTENSION_ID,
} from "./telemetry";
import { randomUUID } from "node:crypto";
import { execGrokCli } from "./cli-process";
import {
  locateGrokCli,
  extensionWasUpgraded,
  isGrokVersionBelowRequired,
  isStdioBrokenGrokVersion,
  parseGrokVersion,
  grokUpdatePolicy,
  shouldReactivelyDowngrade,
  isLockedBinaryError,
  GROK_REQUIRED_VERSION,
  GROK_STDIO_DOWNGRADE_TARGET,
} from "./cli-locator";
import {
  TerminalManager,
  grokShellEnvValue,
  resolvedTerminalShell,
  resolvedTerminalShellDialect,
  setTerminalShellPreference,
  type ShellPreference,
} from "./terminal-manager";
import {
  FileChip,
  MAX_VISION_IMAGE_BYTES,
  clearImplicitChips,
  consumeChips,
  extFromMime,
  isImageChip,
  isImplicitChip,
  isVisionImagePath,
  isVisionMime,
  makeExplicitChip,
  makeImageChip,
  implicitChipStartsHidden,
  makeImplicitChip,
  mimeFromPath,
  removeChip,
  selectionLineRange,
  toggleChip,
} from "./chips";
import { buildPromptWithImages, type PromptImageInput } from "./prompt-builder";
import { matchSlashCommand } from "./slash-filter";
import {
  MENTION_INDEX_LIMIT,
  MENTION_INDEX_TTL_MS,
  buildExcludeGlob,
  clampMentionIndexLimit,
  filterMentionFiles,
  isMentionPathInsideWorkspace,
  mergeMentionEntries,
  normalizeRelPath,
  orderMentionIndex,
  resolveMentionAttachmentPath,
} from "./mention";
import { configForcesAlwaysApprove } from "./grok-config";
import { fileUriToPath, parseFileRef, shouldReadFileInline } from "./file-ref";
import {
  prepareFileUpload,
  retainedUploadDirectories,
  stagedUploadDirectory,
  unreferencedUploadsForRemovedSessions,
} from "./file-upload";
import { MAX_DIFF_EXPAND_BYTES, expandDiffToWholeFile } from "./diff-view";
import { permissionAnswerAllowed, permissionOptionsForPlan, pickRejectOption, shouldRejectPermission } from "./plan-gate";
import { appendPlanEntry, planRestoreSource, truncateResolvedAfter, countsAsUserBubble, decideRestoreState, isInterjectionText } from "./plan-restore";
import { planReviewFileName, sanitizePlanReviewFilePart } from "./plan-review";
import { isPrimerText, isPrimerSummary } from "./grok-primer";
import { HOST_CAPABILITIES, HostMsg, WebviewMsg } from "./protocol";
import { RemoteUplink } from "./remote-uplink";
import { RemoteClientState, serializesRemoteSessionTransition } from "./remote-client-state";
import { RemotePcmIngress, acceptRemotePcm } from "./remote-voice";
import { SessionRequestState } from "./session-request-state";
import { allowFromRemote, allowRemoteRepoTarget, bracketRemoteSnapshot, repoScopeFor, sessionCwdBelongsToRepo, sessionForRequest, shouldAdoptDeskSession, transformHostMsgForRemote, type MediaInlineDeps, type MsgOrigin, type RemoteTier } from "./remote-policy";
import { deviceDisplayName, httpBaseFromRelayUrl, parseRelayFrame, REMOTE_RELAY_URL } from "./remote-frames";
import { KeepAwake, shouldKeepAwake } from "./keep-awake";
import { thumbnailImage, thumbnailMime } from "./image-thumbnail";
import { historyImagePreviews } from "./image-history";
import {
  SessionListEntry,
  SessionMetaOverrides,
  RepoPins,
  carrySessionName,
  clearSessions,
  defaultFs,
  deleteSessionDir,
  discoverRepos,
  fallbackName,
  forkDisplayName,
  indexSessions,
  isEmptyPrimerSession,
  isPathInside,
  mostRecentSession,
  normalizeRepoPath,
  readContextUsage,
  readSessionEntries,
  resolveGrokHome,
  sessionsDirFor,
} from "./sessions";
import {
  gitRootForPath,
  isGitRepo,
  matchWorktreeForCwd,
  mergeSessionIndexes,
  mergeWorktreeRefresh,
  normalizeFsPath,
  pathsEqual,
  sanitizeWorktreeLabel,
  type WorktreeParentRef,
  type WorktreeRecord,
  worktreeCwdsForRepo,
  worktreeDisplayName,
  worktreesForRepo,
} from "./worktree";
import {
  formatRewindPointDetail,
  formatRewindPointLabel,
  historyEventCount,
  anyFilesAfter,
  bubbleMapIsConsistent,
  editRewindConfirmMessage,
  resolveEditRewindTarget,
  resolveUserBubbleRewind,
  survivingUserMessagesAfterRewind,
  truncateReplayBuffer,
  rewindConfirmMessage,
  selectableRewindPoints,
  userFacingRewindPoints,
} from "./rewind";
import {
  parseRunProgressUpdate,
  workflowControlCommand,
} from "./run-progress";
import {
  MCP_GLOBAL_SCOPE_WARNING,
  mcpToolsRefreshedNote,
  mergeMcpServerLists,
  parseMcpCliList,
  type McpServerView,
} from "./mcp";

// HostMsg (host -> webview) and WebviewMsg (webview -> host) both live in
// src/protocol.ts now — the single source of truth for the message contract,
// imported above. See that file for why.

const SESSION_META_KEY = "grok.sessionMeta";
const REPO_PINS_KEY = "grok.repoPins";
/** globalState key for the anonymous per-install telemetry GUID (survives updates). */
const INSTALL_ID_KEY = "grok.installId";
/** globalState key for the eye-off choice on the active-editor context chip.
 *  The chip is rebuilt from scratch on every file switch, so the user's "don't
 *  send this" has to live outside it or every switch silently re-enables the
 *  file — the #67 complaint. Persisted (not per-session) because a preference
 *  this deliberate should survive a reload, exactly like the setting would. */
const IMPLICIT_CHIP_HIDDEN_KEY = "grok.implicitChipHidden";
/** One helpful warning per install, even though every pooled process initializes. */
const OAUTH_SHADOW_WARNING_KEY = "grok.oauthShadowWarningShown";

interface RemoteVoiceEntry {
  credentialCwd: string;
  session: Session;
  streamer: PcmVoiceStreamer;
  ingress: RemotePcmIngress;
  phrase: string;
  keyterms: string[];
  language?: string;
  finalizing: boolean;
}

interface SessionLoadReservation {
  token: symbol;
  ownerTabToken?: string;
  session?: Session;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface RemoteRequester {
  clientId: string;
  tabToken?: string;
}

/** Resolved at commit time, AFTER any await. Undefined means the tab that asked
 *  is gone and the attachment must be dropped — never redirected. */
type AttachmentOwner = () => Session | undefined;

interface RemoteBrowserPreferences {
  fontScale: number;
  readRepliesAloud: boolean;
  summarizeRepliesAloud: boolean;
  usesTouch: boolean;
}

interface CliCompatibilityResult {
  planModeAvailable: boolean;
  planModeUnavailableReason?: string;
}

// History pagination: rows fetched per "page" (initial open + each load-more / search page).
const SESSION_PAGE_SIZE = 100;

/** Rows a `listRepoSessions` preview returns when the client names no limit —
 *  the projects rail shows a few per repo and links out for the rest. */
const REPO_PREVIEW_SIZE = 3;

// Records the extension version at the last silent CLI-update check. A fresh
// install establishes the baseline; a later extension upgrade updates once.
const CLI_UPDATE_VERSION_KEY = "grok.cliUpdateExtVersion";

// grok's non-plan ("act") mode id on the wire. The CLI reports this via
// current_mode_update after leaving plan mode (verified against grok 0.2.3 —
// see research/plan-mode.md). The UI labels it "Agent"; the wire calls it
// "default".
const ACT_MODE_ID = "default";

// Scheme for the permission-card diff preview's virtual documents. Backing the
// before/after sides with a read-only content provider (rather than untitled
// scratch buffers) means the diff tab never goes "dirty", so closing it doesn't
// prompt to save (issue #21). The path keeps the real filename so VS Code infers
// the language for syntax highlighting.
const GROK_DIFF_SCHEME = "grok-diff";

/**
 * Read-only content provider for the diff-preview virtual documents. Content is
 * stored per-URI and served verbatim; the documents are never editable or dirty,
 * so the diff tab closes without a save prompt. Pure VS Code glue.
 */
class GrokDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
  }
  delete(...uris: vscode.Uri[]): void {
    for (const uri of uris) this.contents.delete(uri.toString());
  }
}

/** Best-effort MIME from a file extension, for inlining generated media. */
function guessMediaMime(p: string): string {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    case "mp4":
    case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    default: return "image/png";
  }
}

export class GrokSidebar implements vscode.WebviewViewProvider {
  public static readonly viewId = "grok.chat";
  private view?: vscode.WebviewView;
  /** A command may arrive before the webview posts `ready`; retain only its intent. */
  private mcpPanelOpenRequested = false;
  private webviewReady = false;
  /** The session currently shown in the chat — one member of {@link pool}. */
  private focused = this.newLocalSession();
  /**
   * Every live session (each a spawned `grok agent stdio` process), including the
   * focused one. Backgrounded members keep streaming into their own buffers, so
   * re-focusing one replays its buffer losslessly — no kill, no reload. A session
   * is added on its first successful start and removed when its client is disposed
   * (switch-away of an empty one, delete, logout, reap, teardown).
   */
  private pool = new Set<Session>();
  /**
   * Cache of parsed session metadata for the history popover, keyed by session id. Each value
   * remembers the `summary.json` mtime it was read at, so a cheap `indexSessions` stat pass can
   * tell which entries are stale and re-read only those — the rest are reused across popover opens,
   * load-more pages, and searches. Invalidated per id on rename/delete; the whole map is disposable
   * (it's just a read cache, never a source of truth).
   */
  private sessionCache = new Map<string, { mtimeMs: number; entry: SessionListEntry }>();
  /**
   * Bounds on the live-session pool (see session-pool.ts). A backgrounded session
   * idle past {@link IDLE_TTL_MS}, or beyond the {@link MAX_LIVE_SESSIONS} LRU cap,
   * is silently reaped (its process killed, its dot going cold) — re-focusing it
   * reloads from grok's on-disk history. Working/needs-you and the focused session
   * are never reaped.
   */
  private static readonly MAX_LIVE_SESSIONS = 8;
  private static readonly IDLE_TTL_MS = 60 * 60 * 1000; // 1h
  private static readonly REAP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 min
  private static readonly STAGING_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // The legacy empty-primer sweep only scans the newest N by mtime, keeping its
  // one-shot compatibility scan bounded on a large store.
  private static readonly SWEEP_SCAN_LIMIT = 300;
  private reaper?: ReturnType<typeof setInterval>;
  /** Guards {@link sweepEmptyPrimerSessions} to one run per activation. */
  private sweptEmptySessions = false;
  private oauthShadowWarningShown = false;
  private output: vscode.OutputChannel;
  private get chips(): FileChip[] { return this.focused.chips; }
  private set chips(value: FileChip[]) { this.focused.chips = value; }
  /** Attachment-staging ops still in flight — see trackAttach. */
  private readonly pendingAttach = new Set<Promise<void>>();
  /** Cached findFiles snapshot for the `@` popover (no open-editor merge).
   *  One snapshot serves {@link MENTION_INDEX_TTL_MS}; concurrent queries share
   *  one in-flight build. Open tabs are layered on at read time. */
  private mentionIndex: { at: number; rels: string[]; absByRel: Map<string, string> } | null = null;
  private mentionIndexPromise: Promise<{ rels: string[]; absByRel: Map<string, string> }> | null = null;
  private readonly remoteMentionIndexes = new Map<string, {
    at: number;
    rels: string[];
    absByRel: Map<string, string>;
  }>();
  private editorWatcher?: vscode.Disposable;
  private terminalManager = new TerminalManager();
  private voiceRecorder = new VoiceRecorder();
  private voiceTempPath?: string;
  private voiceStreamer?: VoiceStreamer;
  private voiceFinalizing = false;
  /** Invalidates async voice callbacks after a manual discard or session swap. */
  private voiceGeneration = 0;
  // Stored so a "grok send" can transparently restart a fresh stream (each
  // message = one clean utterance) without re-resolving the mic device.
  private voiceStreamCtx?: {
    key: string;
    ffmpegPath: string;
    device?: string;
    phrase: string;
    keyterms: string[];
    language?: string;
    generation: number;
  };
  private localVoiceCwd?: string;
  private localVoiceCredentialCwd?: string;
  private readonly remoteVoice = new Map<string, RemoteVoiceEntry>();
  private static readonly MAX_REMOTE_PCM_BYTES = MAX_RECORDING_SECONDS * 16_000 * 2;
  private static readonly MAX_REMOTE_PCM_CHUNK_BYTES = 256 * 1024;
  private configWatcher?: vscode.Disposable;
  // Remote uplink — outbound wss to the relay (REMOTE_RELAY_URL), active only
  // when a device token is stored (the "AFK Pilot: Link this device" / gear
  // sign-in flow). The taps in post()/emit() are no-ops when it's off, so the
  // shipping path is unaffected.
  private uplink?: RemoteUplink;
  private readonly remoteClients: RemoteClientState<Session, RemoteBrowserPreferences>;
  /** Cold session/load claims the persisted id before ACP has emitted `session`. */
  private readonly sessionLoadReservations = new Map<string, SessionLoadReservation>();
  /** Sessions being spawned on a remote tab's behalf — a reconnect burst must
   *  not start the same one twice. */
  private readonly startingForRemote = new WeakSet<Session>();
  private static readonly SESSION_LOAD_RESERVATION_TTL_MS = 10 * 60_000;
  private testSessionStartDelay?: {
    resumeId: string | undefined;
    started: () => void;
    wait: Promise<void>;
  };
  // OS wake lock, held for exactly as long as the uplink is (linked device token
  // + live extension host) so an AFK machine can't idle-suspend out from under a
  // remote turn. `grok.remote.keepAwake` is the opt-out. See src/keep-awake.ts.
  private readonly keepAwake = new KeepAwake((l) => this.output.appendLine(l), process.platform, process.pid, os.release());
  private static readonly DEVICE_GLOBAL_REMOTE_TYPES = new Set<HostMsg["type"]>([
    "showThinking", "fontScale", "grokUpdateStatus", "cliUpdating",
    "onboarding", "expandCommandOutputs", "steerByDefault", "soundNotifications",
  ]);
  private cliPath?: string;
  /** History browsing scope. Deliberately independent of the live session cwd. */
  private selectedRepoCwd?: string;
  // The original update trigger: at most once per activation, and only after an
  // extension-version change (never on the fresh-install baseline).
  private cliUpdateChecked = false;

  // Known-broken Windows builds are checked and pinned at most once per
  // activation after the normal extension-upgrade update has run.
  private brokenCliPinned = false;

  // Re-entrancy guard for the reactive (post-init-failure) downgrade + retry in
  // startSession. Prevents a tight loop if the downgrade "succeeds" but the spawn
  // still fails; it is NOT a permanent latch — it's reset after each retry, so a
  // later manual re-upgrade that breaks again gets downgraded again.
  private reactiveDowngradeInFlight = false;

  // Diff-preview plumbing (issue #21): a read-only content provider backs the
  // before/after sides (no save prompt on close), a monotonic counter keeps each
  // diff's virtual URIs unique, and openDiffsByRequest maps a pending permission
  // request → its diff URIs so the tab can be auto-closed when the user answers.
  private readonly diffProvider = new GrokDiffContentProvider();
  private diffSeq = 0;
  private readonly openDiffsByRequest =
    new SessionRequestState<Session, { left: vscode.Uri; right: vscode.Uri }>();
  /** In-flight in-chat confirms, keyed by request id — see confirmInChat. */
  private readonly pendingConfirms = new Map<string, (ok: boolean) => void>();
  private confirmSeq = 0;

  constructor(
    private context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ) {
    this.output = output;
    this.remoteClients = new RemoteClientState<Session, RemoteBrowserPreferences>(
      this.workspaceRoot(),
      normalizeRepoPath,
    );
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(GROK_DIFF_SCHEME, this.diffProvider),
    );
    // Apply the terminal-shell preference at construction, BEFORE any command
    // (e.g. grok.newSession) can spawn a session — otherwise the first
    // resolvedTerminalShell() (for GROK_SHELL in buildEnv) could cache the
    // default "auto" resolution and diverge from a configured `cmd` pref.
    this.applyTerminalShellPref();
    void this.sweepImageStaging();
    void this.sweepFileStaging();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "resources"),
        vscode.Uri.file(this.imageStagingDir()),
        // grok writes generated media under ~/.grok/sessions/<cwd>/<id>/{images,videos};
        // serving it via asWebviewUri (instead of a base64 data: URI) lets the
        // webview stream a multi-MB video from disk — see postGeneratedMedia.
        vscode.Uri.file(resolveGrokHome()),
      ],
    };
    view.webview.html = this.getHtml(view.webview);
    // Message handlers run async; without this catch a throw (e.g. an fs error
    // in an image-attach path) becomes a silent unhandled rejection and the
    // user's action just... does nothing.
    view.webview.onDidReceiveMessage((m: WebviewMsg) => {
      void this.onMessage(m, "local").catch((e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.output.appendLine(`[webview] ${m.type} failed: ${msg}`);
        void vscode.window.showErrorMessage(`Grok: ${m.type} failed — ${msg}`);
      });
    });
    this.watchActiveEditor();
    // Periodic idle-TTL sweep over the live-session pool (the LRU cap is enforced
    // eagerly on each new start; this catches sessions that simply went stale).
    if (!this.reaper) {
      this.reaper = setInterval(() => this.reapPool(), GrokSidebar.REAP_INTERVAL_MS);
    }
    // Re-tell the webview whether voice is set up when the relevant settings
    // change, so the mic button's "needs setup" hint updates without a reload.
    this.configWatcher?.dispose();
    const configChanges = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("grok.voiceApiKey") ||
        e.affectsConfiguration("grok.ffmpegPath") ||
        e.affectsConfiguration("grok.voiceSendPhrase")
      ) {
        this.postVoiceConfigured();
      }
      if (e.affectsConfiguration("grok.chatFontScale")) {
        this.postFontScale();
      }
      if (e.affectsConfiguration("grok.showThinking")) {
        this.postShowThinking();
      }
      if (e.affectsConfiguration("grok.expandCommandOutputs")) {
        this.post({
          type: "expandCommandOutputs",
          value: vscode.workspace.getConfiguration("grok").get<boolean>("expandCommandOutputs", false),
        });
      }
      if (e.affectsConfiguration("grok.steerByDefault")) {
        this.post({
          type: "steerByDefault",
          value: vscode.workspace.getConfiguration("grok").get<boolean>("steerByDefault", false),
        });
      }
      if (e.affectsConfiguration("grok.soundNotifications")) {
        this.post({
          type: "soundNotifications",
          value: vscode.workspace.getConfiguration("grok").get<boolean>("soundNotifications", false),
        });
      }
      if (e.affectsConfiguration("grok.processingSound")) {
        this.post({
          type: "processingSound",
          value: vscode.workspace.getConfiguration("grok").get<boolean>("processingSound", false),
        });
      }
      if (e.affectsConfiguration("grok.readRepliesAloud")) {
        this.post({
          type: "readRepliesAloud",
          value: vscode.workspace.getConfiguration("grok").get<boolean>("readRepliesAloud", false),
        });
      }
      if (e.affectsConfiguration("grok.summarizeRepliesAloud")) {
        this.post({
          type: "summarizeRepliesAloud",
          value: vscode.workspace.getConfiguration("grok").get<boolean>("summarizeRepliesAloud", true),
        });
      }
      if (e.affectsConfiguration("grok.includeActiveFileByDefault")) {
        // Apply the toggle immediately: disabling removes a visible context
        // chip right away (not on the next editor event), enabling shows it.
        this.refreshImplicitChip(true);
      }
      if (e.affectsConfiguration("grok.mentionIndexLimit")) {
        // Drop the TTL-cached findFiles snapshot so the next `@` rebuilds with
        // the new cap (otherwise a raise would wait up to MENTION_INDEX_TTL_MS).
        this.mentionIndex = null;
        this.remoteMentionIndexes.clear();
      }
      if (e.affectsConfiguration("grok.terminalShell")) {
        this.applyTerminalShellPref();
      }
      if (e.affectsConfiguration("grok.remote.keepAwake")) {
        this.refreshKeepAwake();
      }
    });
    const authWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(resolveGrokHome(process.env), "auth.json"),
    );
    const refreshVoiceConfigured = () => this.postVoiceConfigured();
    authWatcher.onDidCreate(refreshVoiceConfigured);
    authWatcher.onDidChange(refreshVoiceConfigured);
    authWatcher.onDidDelete(refreshVoiceConfigured);
    this.configWatcher = vscode.Disposable.from(configChanges, authWatcher);
    this.applyTerminalShellPref();
    void this.maybeStartUplink();
  }

  /** Push the `grok.terminalShell` preference (#46) into the shared shell
   *  resolver so the next agent command re-resolves cmd vs PowerShell. */
  private applyTerminalShellPref(): void {
    const pref = vscode.workspace.getConfiguration("grok").get<ShellPreference>("terminalShell", "auto");
    setTerminalShellPreference(pref === "cmd" ? "cmd" : "auto");
  }

  insertActiveMention(opts?: { selection?: boolean; uri?: vscode.Uri; pickIfMissing?: boolean }): void {
    const editor = vscode.window.activeTextEditor;
    const uri = opts?.uri ?? editor?.document.uri;
    if (!uri) {
      // Invoked from the Command Palette with no file editor active — no target
      // to attach. Degrade gracefully instead of a silent no-op that also drops
      // focus (#43): Send File opens the file picker; the selection/@-mention
      // commands (which have nothing to reference without an editor) surface a
      // hint so the command visibly did *something*.
      if (opts?.pickIfMissing) {
        void this.trackAttach(this.pickFileFromComputer());
      } else {
        void vscode.window.showInformationMessage(
          "Grok: open a file in the editor first, then run this command.",
        );
      }
      return;
    }
    const relPath = vscode.workspace.asRelativePath(uri);
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (opts?.selection && editor && !editor.selection.isEmpty) {
      const range = selectionLineRange(editor.selection.start, editor.selection.end);
      selStart = range.startLine;
      selEnd = range.endLine;
    }
    this.chips.push(makeExplicitChip(uri.fsPath, relPath, selStart, selEnd));
    this.postChips();
    this.revealAndFocusComposer();
  }

  newSession(): void {
    void this.newFocusedSession("local");
  }

  async pickModel(): Promise<void> {
    if (!this.focused.client || !this.focused.client.availableModels.length) {
      vscode.window.showInformationMessage("Start a session first.");
      return;
    }
    const items = this.focused.client.availableModels.map((m) => ({
      label: m.name ?? m.modelId,
      description: m.modelId === this.focused.client!.currentModelId ? "$(check) current" : "",
      detail: m.description,
      modelId: m.modelId,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Pick a Grok model",
    });
    if (picked) await this.switchModel(picked.modelId);
  }

  /**
   * Switch the active model. Models belong to "agent types" (e.g. grok-build vs
   * cursor for the composer models); the CLI binds the agent at spawn and locks
   * it after the first turn, so a live `set_model` only works within the same
   * agent. When it's rejected for a cross-agent model we persist the choice and
   * restart — `newSession` reapplies it before the first agent turn, while the
   * agent is still rebindable. Same-agent switches stay live (history intact).
   */
  async switchModel(
    modelId: string,
    session: Session = this.focused,
    requester?: RemoteRequester,
  ): Promise<void> {
    const client = session.client;
    // Ignore switches fired during session startup. The webview disables the
    // control while busy; this is the backstop for a click already in flight.
    if (!client || session.priming || modelId === client.currentModelId) return;
    const cfg = vscode.workspace.getConfiguration("grok");
    try {
      await client.setModel(modelId);
      await cfg.update("defaultModel", modelId, vscode.ConfigurationTarget.Global);
    } catch (e) {
      if (!isIncompatibleAgentError(e)) {
        this.reportRequester(requester, "error", `Failed to set model: ${(e as Error).message}`);
        return;
      }
      if (!session.hasHistory) {
        // Empty session (no real conversation): a cross-agent switch restarts it
        // with a fresh grok id. There is nothing to summarize or preserve.
        // Drop it after the restart, carrying over any rename the user made.
        const discardId = session.activeSessionId;
        await cfg.update("defaultModel", modelId, vscode.ConfigurationTarget.Global);
        await this.startSession(undefined, session);
        this.discardRestartedEmptySession(discardId, session);
        return;
      }
      if (requester) {
        this.reportRequester(
          requester,
          "warning",
          "Switching to this model requires restarting the conversation from the VS Code view.",
        );
        return;
      }
      const mode = await this.pickRestartMode("Switching to this model requires a new session.");
      if (!mode) return; // dismissed — keep the current model
      await cfg.update("defaultModel", modelId, vscode.ConfigurationTarget.Global);
      await this.restartSession(mode, session);
    }
  }

  openModePopover(): void {
    this.post({ type: "openModePopover" });
  }

  /** Focus the Grok view and reveal MCP management inside that side bar. */
  async openMcpServers(): Promise<void> {
    this.mcpPanelOpenRequested = true;
    await vscode.commands.executeCommand("workbench.view.extension.grokSidebar");
    this.postMcpPanelWhenReady();
  }

  /**
   * Development / testing helper. Posts a realistic dummy `exitPlanRequest` so
   * the plan-review card (Approve / Reject / Cancel) appears in the webview.
   * Lets you exercise the three options, the feedback textarea, the resolved
   * state, and the downstream notice/mode logic without a live grok process.
   * The "Reject" button is the one labeled "Keep planning" in the real flow.
   */
  debugShowDummyPlan(): void {
    const dummyPlan = `# Refactor authentication helper

## Summary
Introduce a small \`auth.ts\` module and migrate the two call sites in the API layer. No behavior change for end users.

## Detailed steps
1. Create \`src/lib/auth.ts\` exporting \`getSessionToken()\` and \`isTokenExpired()\`.
2. Update \`src/api/client.ts\` (two call sites) to delegate to the new helper.
3. Add unit tests in \`tests/auth.test.ts\` covering expiry + refresh paths.
4. Run the integration suite to confirm nothing regressed.

## Risk / notes
- Token format is unchanged.
- One new (already-transitive) dependency on \`jsonwebtoken\`.

\`\`\`ts
// proposed addition to src/lib/auth.ts
export async function getSessionToken(): Promise<string> {
  const cached = getFromCache();
  if (cached && !isTokenExpired(cached)) return cached;
  return refresh();
}
\`\`\`

See design doc for the full state machine diagram.`;

    this.post({
      type: "exitPlanRequest",
      req: {
        id: "dummy-plan-" + Date.now(),
        sessionId: this.focused.activeSessionId || "dummy-session",
        plan: dummyPlan,
      },
    });

    // Make the bottom mode button reflect Plan during the manual test.
    this.post({ type: "modeChanged", modeId: "plan" });
  }

  /**
   * The mode the UI should show. Plan and YOLO are *client* states that the CLI
   * doesn't model (the CLI only knows agent/plan), so we derive the button label
   * here rather than echoing the CLI's raw mode id.
   */
  private displayMode(session: Session = this.focused): "agent" | "plan" | "yolo" {
    if (session.planActive) return "plan";
    if (session.autoApprove) return "yolo";
    return "agent";
  }

  private postMode(session: Session = this.focused): void {
    const message: HostMsg = { type: "modeChanged", modeId: this.displayMode(session) };
    if (session === this.focused) this.view?.webview.postMessage(message);
    this.sendRemoteSession(session, message);
  }

  /** Whether grok's config.toml forces always-approve (#31). Project
   *  `.grok/config.toml` overrides global `~/.grok/config.toml`. Read fresh on
   *  each session start — it's a couple of small file reads, and the user may
   *  edit the config between sessions. Any read error → false (treat as normal). */
  private configForcesAutoApprove(cwd: string = this.workspaceRoot()): boolean {
    const readSafe = (p?: string): string | undefined => {
      if (!p) return undefined;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const globalPath = home ? path.join(home, ".grok", "config.toml") : undefined;
    const projectPath = cwd ? path.join(cwd, ".grok", "config.toml") : undefined;
    return configForcesAlwaysApprove({ project: readSafe(projectPath), global: readSafe(globalPath) });
  }

  private alwaysApproveNoticeShown = false;

  /** Tell the user once per activation that always-approve is set globally, so
   *  the "Auto accept" mode they see isn't a per-session choice they can undo
   *  from the extension (the CLI reads the global config). */
  private noticeAlwaysApproveOnce(): void {
    if (this.alwaysApproveNoticeShown) return;
    this.alwaysApproveNoticeShown = true;
    const OPEN = "Open config.toml";
    void vscode.window
      .showInformationMessage(
        'Grok: "always-approve" is set in your grok config.toml, so tool actions are auto-approved for every session (CLI and extension). The mode shows "Auto accept" to reflect this — the extension can\'t override a global config setting per-session.',
        OPEN,
      )
      .then((pick) => {
        if (pick !== OPEN) return;
        const home = process.env.HOME || process.env.USERPROFILE || "";
        if (!home) return;
        void vscode.commands.executeCommand(
          "vscode.open",
          vscode.Uri.file(path.join(home, ".grok", "config.toml")),
        );
      });
  }

  /** Toggle the client-enforced plan gate and keep the live client in sync. Only
   *  the focused session drives the mode button — a background session entering
   *  plan mode raises its own gate silently. */
  private setPlanActive(session: Session, v: boolean): void {
    const changed = session.planActive !== v;
    session.planActive = v;
    if (session.client) session.client.planActive = v;
    this.postMode(session);
    if (changed) {
      for (const [requestId, pending] of session.pendingPermissions) {
        this.emit(session, {
          type: "permissionOptions",
          requestId,
          options: pendingPermissionOptions(pending, v),
        });
      }
    }
  }

  async setMode(
    modeId: "agent" | "plan" | "yolo",
    session: Session = this.focused,
    requester?: RemoteRequester,
  ): Promise<void> {
    // Agent/plan/yolo are mutually exclusive. Plan = client write/exec gate;
    // YOLO = auto-approve. Both ride on top of the CLI's agent mode, except
    // Plan which also tells the CLI to plan instead of act. The mode button only
    // ever drives the focused session.
    // Ignore mode changes until the session exists: before session/new the CLI
    // setMode throws "no session" (and for Plan that error is surfaced to the user).
    // The mode button is disabled while busy; this backstops the toggle-mode command.
    if (!session.client || !session.client.sessionId || session.priming) return;
    if (modeId === "plan" && !session.planModeAvailable) {
      this.reportRequester(
        requester,
        "warning",
        session.planModeUnavailableReason ?? "Plan mode is unavailable for this Grok CLI version.",
      );
      return;
    }
    if (!session.planModeAvailable && session.planActive) {
      // An agent-initiated unavailable Plan transition is still being forced
      // back to Agent. Agent/YOLO clicks must not lower the safety gate ahead
      // of that confirmation; once recovered, the user can choose YOLO again.
      this.recoverUnavailablePlanMode(session, session.client, session.gen);
      return;
    }
    // Remember the user's last non-plan mode so new sessions start in it (#25).
    // setMode is only ever called from the webview (user action), so this
    // captures intent, not restore/replay bookkeeping (those use client.setMode
    // directly). `modeToRemember` drops Plan (a transient per-task choice).
    const remember = modeToRemember(modeId);
    if (remember) {
      void vscode.workspace
        .getConfiguration("grok")
        .update("defaultMode", remember, vscode.ConfigurationTarget.Global);
    }
    if (modeId === "yolo") {
      session.autoApprove = true;
      this.setPlanActive(session, false); // posts displayMode → "yolo"
      // Flipping to Auto-accept mid-turn (#64) should unblock the CURRENT prompt,
      // not just future requests: clear any permission card already on screen.
      this.autoApprovePendingPermissions(session);
      if (session.client) {
        try { await session.client.setMode(ACT_MODE_ID); } catch { /* CLI stays put; gate is what matters */ }
      }
      return;
    }
    session.autoApprove = false;
    if (modeId === "plan") {
      this.setPlanActive(session, true); // posts displayMode → "plan"
      if (session.client) {
        try { await session.client.setMode("plan"); }
        catch (e) { this.reportRequester(requester, "error", `Couldn't switch mode: ${(e as Error).message}`); }
      }
      return;
    }
    // agent
    this.setPlanActive(session, false); // posts displayMode → "agent"
    if (session.client) {
      try { await session.client.setMode(ACT_MODE_ID); }
      catch (e) { this.reportRequester(requester, "error", `Couldn't switch mode: ${(e as Error).message}`); }
    }
  }

  /** Resolve a plan-review card inside the ORIGINAL planning turn.
   *
   * Native outcomes drive grok's continuation: approved resumes into
   * implementation, rejected stays in Plan so grok can revise, and abandoned
   * ends the planning turn in Agent mode. Gate + permission state must be
   * settled before the response releases the blocked tool call because
   * implementation can begin immediately. Approve/reject comments are
   * interjected first; abandon comments join the ordinary send queue because
   * the abandoned turn ends without another model step to drain an interjection. */
  private handleExitPlan(
    requestId: number | string,
    verdict: "approved" | "abandoned" | "rejected",
    comment?: string,
    session: Session = this.focused,
  ): void {
    const client = session.client;
    const pending = session.pendingExitPlans.get(requestId);
    if (!client || !pending) return;
    const feedback = comment?.trim();
    const planText = pending.planText;
    const gen = session.gen;
    const sidebar = this;
    const resolveCard = () => this.emit(session, { type: "planResolved", requestId, verdict });
    if (verdict === "approved") {
      // Restore the mode chosen before Plan (#64) before native implementation
      // can raise a permission request in this same turn.
      session.autoApprove = vscode.workspace.getConfiguration("grok").get<string>("defaultMode", "") === "yolo";
      this.setPlanActive(session, false);
    } else if (verdict === "rejected") {
      session.autoApprove = false;
      this.setPlanActive(session, true);
    } else {
      // Preserve the existing safety choice: explicit Cancel lands in Agent,
      // never back in remembered YOLO/Auto-accept.
      session.autoApprove = false;
      this.setPlanActive(session, false);
    }

    if (verdict === "abandoned") {
      // Native abandon ends this turn without another model step, so an
      // interjection would remain undrained. Respond first, then queue any
      // comment while status is still working; handleSend's finally flushes it
      // as a real prompt after the abandoned turn settles.
      if (!client.respondExitPlan(requestId, verdict)) {
        session.autoApprove = false;
        this.setPlanActive(session, true);
        this.setStatus(session, "needs-you");
        return;
      }
      commitVerdict();
      if (feedback) this.divertRacingSend(session, feedback, false);
      resolveCard();
      return;
    }

    // Calling the async method writes before its first await. Keep this call
    // before respondExitPlan so the comment is queued while grok is still
    // blocked on exit_plan_mode; capability handling continues asynchronously.
    const inFlightComment = feedback ? { text: feedback, client, gen } : undefined;
    if (inFlightComment) session.inFlightPlanComments.set(requestId, inFlightComment);
    const commentDelivery = feedback
      ? client.interject(feedback, () => {
          // The response dispatcher invokes this synchronously before resolving
          // the Promise. Acceptance therefore retires exit recovery before a
          // subsequent process-close event can reclaim the same text.
          if (session.inFlightPlanComments.get(requestId) === inFlightComment) {
            session.inFlightPlanComments.delete(requestId);
          }
          if (gen === session.gen && session.client === client) session.interjectionCount += 1;
        })
      : undefined;
    const verdictWritten = client.respondExitPlan(requestId, verdict);
    if (!verdictWritten) {
      void commentDelivery?.catch(() => {});
      session.autoApprove = false;
      this.setPlanActive(session, true);
      this.setStatus(session, "needs-you");
      return;
    }
    commitVerdict();
    resolveCard();

    if (!feedback || !commentDelivery) return;

    void commentDelivery.then((result) => {
      if (!verdictWritten) return;
      // Stale completions never emit into replacement session state. The old
      // process's close handler already reclaimed any still-owned text before
      // bumping gen; accepted text retired that ownership in onResolve above.
      if (gen !== session.gen || session.client !== client) return;
      if (result === "ok") {
        this.emit(session, { type: "userMessage", text: feedback, chips: [], steer: true });
        this.output.appendLine(`[plan-verdict] interjected ${feedback.length} comment chars`);
      } else {
        if (session.inFlightPlanComments.get(requestId) === inFlightComment) {
          session.inFlightPlanComments.delete(requestId);
        }
        this.emit(session, { type: "steerUnavailable" });
        this.divertRacingSend(session, feedback, false);
      }
    }).catch((e: any) => {
      if (!verdictWritten) return;
      if (gen !== session.gen || session.client !== client) return;
      if (session.inFlightPlanComments.get(requestId) === inFlightComment) {
        session.inFlightPlanComments.delete(requestId);
      }
      this.emit(session, {
        type: "error",
        text: `Plan comment steering failed: ${e?.message ?? e}. Your comment was queued instead.`,
      });
      this.divertRacingSend(session, feedback, false);
    });

    function commitVerdict(): void {
      session.pendingExitPlans.delete(requestId);
      sidebar.persistPlanVerdict(session, verdict, planText);
      sidebar.setStatus(session, "working");
      if (verdict === "approved" && session.autoApprove) {
        sidebar.autoApprovePendingPermissions(session);
      }
      if (verdict === "rejected" && !feedback) {
        sidebar.emit(session, { type: "planNotice", text: "Plan rejected — staying in Plan mode." });
      } else if (verdict === "abandoned" && !feedback) {
        sidebar.emit(session, { type: "planNotice", text: "Plan abandoned — switched to Agent mode." });
      }
    }
  }

  /** Move comments still awaiting acceptance into the ordinary queue before a
   * controlled restart replaces their owning process. */
  private queueInFlightPlanCommentsOnExit(session: Session, client: AcpClient, gen: number): void {
    const recovered: string[] = [];
    for (const [requestId, pending] of session.inFlightPlanComments) {
      if (pending.client !== client || pending.gen !== gen) continue;
      session.inFlightPlanComments.delete(requestId);
      recovered.push(pending.text);
    }
    if (!recovered.length) return;
    const text = recovered.join("\n\n");
    if (session.queuedSends.length) session.queuedSends[0] += "\n\n" + text;
    else session.queuedSends.push(text);
  }

  /**
   * An old/unverified CLI may still enter Plan on its own. Keep the client-side
   * write/terminal gate raised until the CLI confirms it returned to Agent.
   * Only the latest attempt may lower the gate, so overlapping mode updates or
   * a defensive exit-plan request cannot let an earlier RPC win a race.
   */
  private recoverUnavailablePlanMode(
    session: Session,
    client: AcpClient,
    gen: number,
    exitPlanRequestId?: number | string,
  ): void {
    const attempt = ++session.planModeRecoveryAttempt;
    if (session.planModeRecovery?.warningTimer) {
      clearTimeout(session.planModeRecovery.warningTimer);
    }
    const recovery = {
      attempt,
      modeConfirmed: false,
      turnSettled: !this.turnInFlight(session),
      warningTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    session.planModeRecovery = recovery;
    session.autoApprove = false;
    this.setPlanActive(session, true);
    if (exitPlanRequestId !== undefined) {
      client.respondExitPlanUnavailable(exitPlanRequestId);
    }
    if (!recovery.turnSettled) {
      // This CLI's verdict behavior is not trusted, so there is no safe native
      // continuation to preserve. Cancel it and wait for client.prompt() to
      // settle; a set_mode acknowledgement alone cannot authorize writes.
      void client.cancel("unavailable Plan recovery");
    }
    this.emit(session, {
      type: "planNotice",
      text:
        `${session.planModeUnavailableReason ?? "Plan mode is unavailable for this Grok CLI version."} ` +
        "Returning to Agent mode; write and terminal actions remain blocked until the planning turn stops and Agent mode is confirmed.",
    });

    recovery.warningTimer = setTimeout(() => {
      if (
        gen !== session.gen ||
        session.client !== client ||
        session.planModeRecovery !== recovery
      ) return;
      this.emit(session, {
        type: "error",
        text:
          "Could not finish leaving unavailable Plan mode promptly. " +
          "Write and terminal actions remain blocked for safety; start a new session if recovery does not complete.",
      });
    }, 10_000);

    void client.setMode(ACT_MODE_ID).then(() => {
      if (
        gen !== session.gen ||
        session.client !== client ||
        session.planModeRecovery !== recovery
      ) return;
      recovery.modeConfirmed = true;
      this.finishUnavailablePlanRecovery(session, client, gen, recovery);
    }).catch((e: any) => {
      if (
        gen !== session.gen ||
        session.client !== client ||
        session.planModeRecovery !== recovery
      ) return;
      if (recovery.warningTimer) clearTimeout(recovery.warningTimer);
      session.planModeRecovery = undefined;
      this.emit(session, {
        type: "error",
        text:
          `Could not leave unavailable Plan mode: ${e?.message ?? e}. ` +
          "Write and terminal actions remain blocked for safety. Update Grok Build or start a new session.",
      });
    });
  }

  private finishUnavailablePlanRecovery(
    session: Session,
    client: AcpClient,
    gen: number,
    recovery: NonNullable<Session["planModeRecovery"]>,
  ): void {
    if (
      gen !== session.gen ||
      session.client !== client ||
      session.planModeRecovery !== recovery ||
      !recovery.modeConfirmed ||
      !recovery.turnSettled
    ) return;
    if (recovery.warningTimer) clearTimeout(recovery.warningTimer);
    session.planModeRecovery = undefined;
    this.setPlanActive(session, false);
    this.emit(session, { type: "planNotice", text: "Returned to Agent mode." });
  }

  private settleUnavailablePlanTurn(session: Session, client: AcpClient, gen: number): void {
    const recovery = session.planModeRecovery;
    if (!recovery || gen !== session.gen || session.client !== client) return;
    recovery.turnSettled = true;
    this.finishUnavailablePlanRecovery(session, client, gen, recovery);
  }

  /** Persist this plan (text + verdict) so the resume view can replay every plan
   *  the user resolved in this session — grok's on-disk plan.md only retains the
   *  latest, so we'd otherwise lose plans the agent overwrote later. */
  /**
   * Drop our own persisted cards for turns a rewind just deleted.
   *
   * grok truncates its history; the plan and permission cards are the
   * EXTENSION's records (the CLI replays neither on `session/load`), so without
   * this they outlive their turns and the next restore dumps them at the bottom
   * of the conversation — cards for messages the user just removed, sitting
   * under the ones that survived. Applies to Rewind and Edit alike.
   *
   * `lastPlanVerdict` is recomputed from the survivors because it drives whether
   * the plan gate goes back up on restore (`decideRestoreState`) — leaving a
   * discarded verdict there would restore plan mode from a turn that no longer
   * exists.
   */
  private async truncateSessionCardsAfterRewind(sessionId: string, surviving: number): Promise<void> {
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sessionId];
    if (!cur) return;
    const boundarySession = [...this.pool].find((session) => session.activeSessionId === sessionId);
    const survivingHistoryEvents = boundarySession
      ? historyEventCount(truncateReplayBuffer(boundarySession.buffer, surviving))
      : undefined;
    const plans = truncateResolvedAfter(cur.plans, surviving, survivingHistoryEvents);
    const permissions = truncateResolvedAfter(cur.permissions, surviving, survivingHistoryEvents);
    const usageLog = truncateResolvedAfter(cur.usageLog, surviving, survivingHistoryEvents);
    const droppedPlans = (cur.plans?.length ?? 0) - plans.length;
    const droppedPerms = (cur.permissions?.length ?? 0) - permissions.length;
    const droppedTurns = (cur.usageLog?.length ?? 0) - usageLog.length;
    if (!droppedPlans && !droppedPerms && !droppedTurns) return;
    // The billing total is DERIVED from the surviving turns, never patched — so
    // rewinding away a turn removes its tokens from the session total instead of
    // leaving the user billed in the UI for a turn that no longer exists. A
    // session with no `usageLog` (recorded before it existed) keeps its stored
    // total rather than dropping to zero: uncorrectable, but not wrong-by-a-lot.
    const rawUsage = cur.usageLog ? sumUsage(usageLog) : cur.usage;
    const usage = enforceCompleteSessionCost(
      rawUsage,
      usageLog,
      surviving,
    );
    this.output.appendLine(
      `[rewind] dropped ${droppedPlans} plan card(s) + ${droppedPerms} permission card(s) + ${droppedTurns} usage turn(s) past user message ${surviving}`,
    );
    await this.context.globalState.update(SESSION_META_KEY, {
      ...overrides,
      [sessionId]: {
        ...cur,
        plans,
        permissions,
        usageLog,
        usage,
        lastPlanVerdict: plans.length ? plans[plans.length - 1].verdict : undefined,
      },
    });
    // Keep the live popover in step with what we just persisted. The ledger
    // itself remains keyed by session id in meta; no live Session copy exists.
    const live = [...this.pool].find((s) => s.activeSessionId === sessionId);
    if (live) {
      this.emit(live, { type: "usage", session: usage, afterUserMessage: surviving, afterHistoryEvent: live.historyEventCount });
    }
  }

  private persistPlanVerdict(
    session: Session,
    verdict: "approved" | "abandoned" | "rejected",
    planText: string,
  ): void {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const plans = appendPlanEntry(cur.plans, {
      text: planText,
      verdict,
      afterUserMessage: session.userMessageCount,
      afterInterjection: session.interjectionCount,
      afterHistoryEvent: session.historyEventCount,
    });
    const next: SessionMetaOverrides = {
      ...overrides,
      [sid]: { ...cur, lastPlanVerdict: verdict, plans },
    };
    void this.context.globalState.update(SESSION_META_KEY, next);
  }

  /** Persist an answered permission card (title + allowed/rejected + position) so
   *  a resumed session can replay it collapsed — the CLI doesn't replay
   *  request_permission on session/load. */
  private persistPermissionAnswer(session: Session, requestId: number | string, optionId: string): void {
    const pending = session.pendingPermissions.get(requestId);
    session.pendingPermissions.delete(requestId);
    if (!pending) return;
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const outcome = permissionOutcomeFor(pending.options, optionId);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const permissions = [
      ...(cur.permissions ?? []),
      { title: pending.title, outcome, toolCallId: pending.toolCallId, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount },
    ];
    void this.context.globalState.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...cur, permissions },
    });
  }

  /** Auto-approve every permission card currently awaiting the user (#64). Fired
   *  when the user switches to Auto-accept mid-turn so on-screen cards resolve
   *  immediately instead of only future requests. Mirrors the `permissionAnswer`
   *  handler for each pending request; a card with no allow option is left for
   *  the user to decide. */
  private autoApprovePendingPermissions(session: Session): void {
    const client = session.client;
    if (!client || session.pendingPermissions.size === 0) return;
    let resolved = 0;
    // Snapshot first — persistPermissionAnswer mutates pendingPermissions.
    for (const [requestId, pending] of [...session.pendingPermissions]) {
      const opt = preferredPermissionAllowOption(pending, session.planActive);
      if (!opt) continue;
      if (!client.respondPermission(requestId, opt.optionId)) continue;
      this.emit(session, { type: "permissionResolved", requestId, optionId: opt.optionId });
      this.persistPermissionAnswer(session, requestId, opt.optionId);
      this.closeDiffForRequest(session, requestId);
      resolved += 1;
    }
    if (resolved > 0) this.setStatus(session, "working"); // the turn resumes
  }

  /**
   * Resolve the session's queued sends (#37) as ONE combined prompt — blank-line
   * separated, so grok gets a single turn with full context — once its turn is
   * truly over. Safe to call opportunistically: it no-ops while a turn is in
   * flight (`working`), while a card awaits the user (`needs-you`), while a
   * during the spawn window (`priming` — no session id to prompt yet), or with
   * no live client. Works
   * for backgrounded sessions too.
   */
  private queuedSendReadyText(session: Session): string | undefined {
    if (!session.queuedSends.length) return undefined;
    if (!session.client || session.priming) return undefined;
    if (session.status === "working" || session.status === "needs-you") return undefined;
    return session.queuedSends.join("\n\n");
  }

  private async maybeFlushQueuedSends(session: Session): Promise<void> {
    const combined = this.queuedSendReadyText(session);
    if (!combined) return;
    if (session.queuedSendCommit) return;
    if (session.queuedSendRequiresRelay) {
      if (this.remoteClients.clientsForActiveValue(session).length === 0) return;
      if (session.queuedSendDispatch) return;
      const dispatch = { id: randomUUID(), text: combined };
      session.queuedSendDispatch = dispatch;
      this.sendRemoteSession(session, { type: "submitQueuedSend", ...dispatch });
      return;
    }
    const claim = beginQueuedSendCommit(session, combined);
    if (!claim) return;
    try {
      await this.handleSend(combined, false, session, "local", claim);
    } finally {
      finishQueuedSendCommit(session, claim, false);
    }
  }

  /**
   * Steer (#52) — inject text into the RUNNING turn instead of waiting for it.
   * Unlike a second `session/prompt` (which kills the in-flight turn), grok's
   * `_x.ai/interject` queues into a buffer the agent drains at its next safe
   * point, so no tool work is lost and the turn still ends normally.
   *
   * Steering carries plain text ONLY: it bypasses `prompt-builder`, so there is
   * no context envelope, no chips, and no `/command` dispatch — the interjection
   * reaches the model as-is. The bubble is painted optimistically before the RPC
   * so the UI feels immediate; a failure re-queues the text rather than losing
   * it, which is the whole point of the host owning this (#37).
   */
  private async steerSend(
    text: string,
    session: Session = this.focused,
    requester?: RemoteRequester,
  ): Promise<void> {
    const body = (text ?? "").trim();
    if (!body) return;
    if (!session.client || !session.activeSessionId) {
      // No live turn to steer — fall back to the queue rather than drop it.
      // Deliberately NOT flagged for a relay round-trip: the relay meters
      // steerSend on ingress exactly like send, so this text is already paid
      // for — re-submitting the queued fallback through the relay would
      // charge it twice. Same for the two fallbacks below.
      session.queuedSends.length ? (session.queuedSends[0] += "\n\n" + body) : session.queuedSends.push(body);
      this.emit(session, { type: "queuedSends", items: [...session.queuedSends] });
      return;
    }
    this.emit(session, { type: "userMessage", text: body, chips: [], steer: true });
    try {
      const client = session.client;
      const gen = session.gen;
      const r = await client.interject(body, () => {
        if (gen === session.gen && session.client === client) session.interjectionCount += 1;
      });
      if (r === "unsupported") {
        // Pre-~0.2.96 CLI: latch the button off and hand the text to the queue,
        // which is exactly the behavior Steer was offering to skip.
        this.emit(session, { type: "steerUnavailable" });
        this.emit(session, { type: "agentReset" });
        session.queuedSends.length ? (session.queuedSends[0] += "\n\n" + body) : session.queuedSends.push(body);
        this.emit(session, { type: "queuedSends", items: [...session.queuedSends] });
        this.reportRequester(
          requester,
          "warning",
          "Steering needs a newer Grok Build CLI — your message was queued instead. Update via the gear menu → Version & about.",
        );
        return;
      }
      this.output.appendLine(`[steer] interjected ${body.length} chars into the running turn`);
    } catch (e: any) {
      this.emit(session, { type: "agentReset" });
      session.queuedSends.length ? (session.queuedSends[0] += "\n\n" + body) : session.queuedSends.push(body);
      this.emit(session, { type: "queuedSends", items: [...session.queuedSends] });
      this.emit(session, { type: "error", text: `Steer failed: ${e?.message ?? e}. Your message was queued instead.` });
    }
  }

  /**
   * Fork (#48) — branch this session's conversation into a new session and focus
   * it. The source session is left completely untouched (verified: its history is
   * byte-identical after a fork), and the workspace is never touched either —
   * grok copies session files only, so **code is not rewound**. Whole-session
   * only, deliberately: `targetPromptIndex` truncates `chat_history` without
   * truncating `updates.jsonl`, so a partial fork would replay a conversation the
   * model has forgotten (see research/grok-build-oss-findings.md § 3a).
   */
  private async forkFocusedSession(session: Session = this.focused, requester?: RemoteRequester): Promise<void> {
    if (!session.client || !session.activeSessionId) {
      this.reportRequester(requester, "warning", "Start a session before forking it.");
      return;
    }
    if (!session.hasHistory) {
      this.reportRequester(requester, "info", "Nothing to fork yet — this session has no conversation.");
      return;
    }
    // Resolve the parent's name BEFORE the fork — it names the fork, so it must
    // be the name the user was looking at when they clicked. Reading it after the
    // await risks a turn landing mid-fork and rewriting summary.json (and with it
    // grok's generated title), naming the fork after something never on screen.
    // forkDisplayName is idempotent, so forking a fork stays "Foo (Fork)".
    const parentName = this.sessionDisplayName(session);
    const forkName = forkDisplayName(parentName);
    try {
      // Fork keeps the same cwd as the source, worktree-isolated ones included.
      const cwd = this.sessionCwd(session);
      const r = await session.client.forkSession(cwd);
      if (r === "unsupported") {
        this.reportRequester(
          requester,
          "warning",
          "Forking needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
        return;
      }
      this.output.appendLine(`[fork] ${session.activeSessionId} → ${r.newSessionId} ("${forkName}")`);
      // Stamp the name before focusing, so neither the history list nor the
      // toolbar ever flashes grok's own generated title for the fork.
      const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const prev = overrides[r.newSessionId] ?? {};
      const parentUploads = overrides[session.activeSessionId]?.uploadedFiles ?? [];
      const carried: SessionMetaOverrides[string] = {
        ...prev,
        customName: forkName,
        uploadedFiles: [...new Set([...(prev.uploadedFiles ?? []), ...parentUploads])],
      };
      // A fork of a worktree session stays in that worktree — carry the binding.
      // It's a second conversation branch sharing the checkout (like the Agent
      // Dashboard's parallel sessions); Remove worktree disposes both.
      if (session.worktree) {
        carried.worktreePath = session.worktree.path;
        carried.worktreeLabel = session.worktree.label;
        carried.sourceGitRoot = session.worktree.sourceGitRoot;
      }
      await this.context.globalState.update(SESSION_META_KEY, {
        ...overrides,
        [r.newSessionId]: carried,
      });
      this.sessionCache.delete(r.newSessionId); // customName changes displayName without touching mtime

      // The fork is on disk but has no live process; openSession loads it into a
      // fresh pool member and focuses it, exactly like clicking a history row.
      if (requester) {
        const currentClientId = this.resolveRemoteRequester(requester);
        if (!currentClientId) return;
        await this.openRemoteSession(currentClientId, r.newSessionId, cwd);
      } else {
        await this.openSession(r.newSessionId, cwd);
      }
      this.reportRequester(
        requester,
        "info",
        `Forked into "${forkName}". The original conversation is unchanged and is in your session history` +
          (parentName ? ` as "${parentName}"` : "") +
          ". Files on disk were not touched.",
      );
    } catch (e: any) {
      this.reportRequester(requester, "error", `Fork failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Rewind (P2-9) — roll the conversation (and file snapshots) back to an
   * earlier user prompt. Primary UX: the Rewind button on a user bubble
   * (`userBubbleIndex`). Fallback: gear / command palette opens a QuickPick.
   * Execute always uses `force:true` + mode `all`; then reloads the same
   * session so the chat matches the truncated history.
   */
  /**
   * Edit-and-resend the latest user message (#56).
   *
   * `execute` DISCARDS its target along with everything after it (probe-verified,
   * research/rewind-semantics-probe.cjs), so removing this message means
   * targeting its OWN point — see `resolveEditRewindTarget`. The tip is a legal
   * target; nothing here needs the predecessor.
   *
   * The text handed back to the composer is the webview's own bubble text rather
   * than the execute result's `prompt_text`. `prompt_text` IS this message (the
   * CLI returns the discarded prompt precisely so a client can restore it), but
   * it's the raw wire form — still carrying the `<vscode-context>` envelope,
   * fenced selection blocks and `[Image #N]` tags. Only the bubble has those
   * peeled off.
   */
  private async editLastMessage(userBubbleIndex: number, text: string, totalUserBubbles?: number): Promise<void> {
    const session = this.focused;
    if (!session.client || !session.activeSessionId) {
      return void vscode.window.showWarningMessage("Start a session before editing a message.");
    }
    if (session.status === "working" || session.status === "needs-you") {
      // Name the state. "Wait for the current turn" is useless when the turn
      // already finished and the status is merely stale — the user can't tell
      // those apart, and neither could I without this line.
      this.output.appendLine(
        `[edit] refused: session.status=${session.status} bubble=${userBubbleIndex}`,
      );
      return void vscode.window.showWarningMessage(
        session.status === "needs-you"
          ? "Answer the pending permission or plan card first, then edit your last message."
          : "Wait for the current turn to finish (or Stop it) before editing your last message.",
      );
    }
    try {
      const points = await session.client.listRewindPoints();
      if (points === "unsupported") {
        return void vscode.window.showWarningMessage(
          "Editing a sent message needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
      }
      // If the wire's user-facing list no longer matches what the user sees, the
      // bubble->point map can't be trusted — refuse instead of reverting a turn
      // we may have mis-identified. See bubbleMapIsConsistent.
      if (!bubbleMapIsConsistent(points, totalUserBubbles)) {
        this.output.appendLine(
          `[rewind] map mismatch: ${userFacingRewindPoints(points).length} wire points vs ${totalUserBubbles} visible messages`,
        );
        return void vscode.window.showWarningMessage(
          "Grok's restore points no longer line up with this conversation, so rewinding could remove the wrong turn. Reload the window and try again.",
        );
      }
      const target = resolveEditRewindTarget(points, userBubbleIndex);
      if (!target) {
        const copy = "Copy text to composer";
        const pick = await vscode.window.showInformationMessage(
          "Grok has no restore point for this message, so it can't be rolled back. You can still copy the text and send it again.",
          copy,
        );
        if (pick === copy) this.emit(session, { type: "restoreComposer", text });
        return;
      }

      // Confirm ONLY when the turn actually changed files on disk. Editing a
      // chat-only turn is reversible in practice (the text comes straight back
      // to the composer), so a modal there is pure friction. Reverting code is
      // not reversible, so that one still asks.
      if (anyFilesAfter(points, target)) {
        const ok = await this.confirmInChat(session, {
          title: "Edit this message?",
          body: editRewindConfirmMessage(target, true),
          confirmLabel: "Edit",
          danger: true,
        });
        if (!ok) return;
      }

      const result = await session.client.executeRewind({
        targetPromptIndex: target.promptIndex,
        mode: "all",
      });
      if (result === "unsupported") {
        return void vscode.window.showWarningMessage(
          "Editing a sent message needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
      }
      if (!result.success) {
        // Surface the CLI's own words — e.g. rewinding past a compaction point.
        return void vscode.window.showErrorMessage(result.error || "Couldn't roll back that message.");
      }

      const nFiles = result.revertedFiles.length;
      this.output.appendLine(
        `[edit] rewound to prompt #${result.targetPromptIndex} (files=${nFiles}, bubble=${userBubbleIndex})`,
      );
      const resumeId = session.activeSessionId;
      const surviving = survivingUserMessagesAfterRewind(points, target);
      await this.truncateSessionCardsAfterRewind(resumeId, surviving);
      this.applyRewindToView(session, surviving);
      this.emit(session, { type: "restoreComposer", text });
      if (nFiles > 0) {
        void vscode.window.showInformationMessage(
          `Message moved back to the composer. Restored ${nFiles} file${nFiles === 1 ? "" : "s"}.`,
        );
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Couldn't edit that message: ${e?.message ?? e}`);
    }
  }

  async rewindFocusedSession(userBubbleIndex?: number, bubbleText?: string, totalUserBubbles?: number): Promise<void> {
    const session = this.focused;
    if (!session.client || !session.activeSessionId) {
      return void vscode.window.showWarningMessage("Start a session before rewinding it.");
    }
    if (session.status === "working" || session.status === "needs-you") {
      return void vscode.window.showWarningMessage(
        "Wait for the current turn to finish (or Stop it) before rewinding.",
      );
    }
    if (!session.hasHistory) {
      return void vscode.window.showInformationMessage("Nothing to rewind yet — this session has no conversation.");
    }
    try {
      const points = await session.client.listRewindPoints();
      if (points === "unsupported") {
        return void vscode.window.showWarningMessage(
          "Rewind needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
      }

      // If the wire's user-facing list no longer matches what the user sees, the
      // bubble->point map can't be trusted — refuse instead of reverting a turn
      // we may have mis-identified. See bubbleMapIsConsistent.
      if (!bubbleMapIsConsistent(points, totalUserBubbles)) {
        this.output.appendLine(
          `[rewind] map mismatch: ${userFacingRewindPoints(points).length} wire points vs ${totalUserBubbles} visible messages`,
        );
        return void vscode.window.showWarningMessage(
          "Grok's restore points no longer line up with this conversation, so rewinding could remove the wrong turn. Reload the window and try again.",
        );
      }
      let target: ReturnType<typeof resolveUserBubbleRewind> = null;
      if (typeof userBubbleIndex === "number") {
        // Bubble button: map visible user bubble → wire prompt_index (skips legacy hidden turns).
        target = resolveUserBubbleRewind(points, userBubbleIndex);
        if (!target) {
          return void vscode.window.showInformationMessage(
            "Can't rewind to this message — it's the latest turn, or the checkpoint is unavailable.",
          );
        }
      } else {
        // Gear / command palette: pick among user-facing points that aren't the tip.
        const facing = userFacingRewindPoints(points);
        const selectable = selectableRewindPoints(facing.length ? facing : points);
        if (selectable.length === 0) {
          return void vscode.window.showInformationMessage(
            facing.length <= 1
              ? "Only one message so far — hover an earlier user message and click Rewind."
              : "No rewind points available.",
          );
        }
        // Number each entry by its place among the user's VISIBLE messages, not
        // by the wire prompt_index — old sessions include hidden primer and
        // marker-only verdict points, so it can render as "#1 #2 … #6 #8": a
        // sequence the user can't match to anything on screen.
        const visiblePosition = new Map(facing.map((p, i) => [p.promptIndex, i + 1]));
        const items = [...selectable]
          .sort((a, b) => b.promptIndex - a.promptIndex)
          .map((p) => ({
            label: formatRewindPointLabel(p, visiblePosition.get(p.promptIndex)),
            description: p.hasFileChanges ? "files" : undefined,
            detail: formatRewindPointDetail(p),
            point: p,
          }));
        const pick = await vscode.window.showQuickPick(items, {
          // Execute discards the chosen message too, not just what follows it.
          placeHolder: "Rewind past which message? (it and everything after it are discarded)",
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        });
        if (!pick) return;
        target = pick.point;
      }

      // Same rule as Edit: ask only when code on disk will be reverted. A
      // conversation-only rewind hands the message back to the composer, so
      // there is nothing unrecoverable to warn about.
      const revertsFiles = anyFilesAfter(points, target);
      if (revertsFiles) {
        const ok = await this.confirmInChat(session, {
          title: "Rewind past this message?",
          body: rewindConfirmMessage(target, "all"),
          confirmLabel: "Rewind",
          danger: true,
        });
        if (!ok) return;
      }

      const result = await session.client.executeRewind({
        targetPromptIndex: target.promptIndex,
        mode: "all",
      });
      if (result === "unsupported") {
        return void vscode.window.showWarningMessage(
          "Rewind needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
      }
      if (!result.success) {
        const err = result.error || "Rewind did not apply (no changes).";
        return void vscode.window.showErrorMessage(err);
      }

      const nFiles = result.revertedFiles.length;
      this.output.appendLine(
        `[rewind] → prompt #${result.targetPromptIndex} (mode=${result.mode}, files=${nFiles}` +
          (typeof userBubbleIndex === "number" ? `, bubble=${userBubbleIndex}` : "") +
          `)`,
      );
      const resumeId = session.activeSessionId;
      // Same as Edit: our plan/permission cards are not grok's, so the rewind
      // doesn't touch them and a replay would resurrect them at the bottom.
      const surviving = survivingUserMessagesAfterRewind(points, target);
      await this.truncateSessionCardsAfterRewind(resumeId, surviving);
      this.applyRewindToView(session, surviving);
      // Rewind DISCARDS the message it targets, so hand its text back exactly
      // as Edit does — otherwise the button silently destroys what the user
      // wrote. After startSession, or the replay would clear it.
      //
      // Deliberately NOT `result.promptText`: the CLI returns the raw prompt,
      // still carrying our <vscode-context> envelope, fenced selection blocks
      // and [Image #N] tags. Only the webview's bubble text has those peeled
      // off. So the QuickPick path (no bubble) restores nothing rather than
      // pasting plumbing into the composer.
      const restored = (bubbleText ?? "").trim();
      if (restored) this.emit(session, { type: "restoreComposer", text: restored });
      // Only speak up when something happened the chat itself doesn't show.
      // The messages vanishing and the text landing in the composer are their
      // own feedback; a toast restating them is noise. Reverted files are NOT
      // visible in the chat, so those still get reported.
      if (nFiles > 0) {
        void vscode.window.showInformationMessage(
          `Rewound. Restored ${nFiles} file${nFiles === 1 ? "" : "s"}.`,
        );
      }
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Rewind failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Pause / resume / stop a background workflow by its display name (P2-10).
   * Sends the matching `/workflow …` slash command as a real turn so the CLI
   * dispatches it (same path as typing the command in the composer).
   */
  private async controlWorkflow(
    action: "pause" | "resume" | "stop",
    displayName: string,
    session: Session = this.focused,
  ): Promise<void> {
    const cmd = workflowControlCommand(action, displayName);
    if (!cmd) {
      return void vscode.window.showWarningMessage("Missing workflow display name.");
    }
    await this.handleSend(cmd, true, session);
  }

  /** Workspace folder root (the main checkout for worktree ops). */
  private workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Effective cwd for a session (worktree path or workspace root). */
  private sessionCwd(session: Session = this.focused): string {
    return session.cwd || this.workspaceRoot();
  }

  private setSessionCwd(session: Session, cwd: string, fallbackSourceGitRoot: string): void {
    session.cwd = cwd;
    session.worktree = undefined;
    const wt = matchWorktreeForCwd(cwd, this.worktreeCache);
    if (!wt) return;
    session.worktree = {
      path: wt.path,
      label: wt.label,
      sourceGitRoot: wt.sourceRepo || fallbackSourceGitRoot,
      id: wt.id,
    };
  }

  private async persistWorktreeBinding(session: Session): Promise<void> {
    const id = session.activeSessionId;
    const wt = session.worktree;
    if (!id || !wt) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    await this.context.globalState.update(SESSION_META_KEY, {
      ...overrides,
      [id]: {
        ...(overrides[id] ?? {}),
        worktreePath: wt.path,
        worktreeLabel: wt.label,
        sourceGitRoot: wt.sourceGitRoot,
      },
    });
  }

  /**
   * New Worktree Session (P2-8) — create an isolated git worktree and open a
   * fresh session whose cwd is that worktree. Edits stay out of the main
   * checkout until the user runs Apply Worktree.
   */
  async newWorktreeSession(): Promise<void> {
    // No worktree-from-worktree — checkouts stay singular. The gear hides this
    // inside a worktree; guard the Command-Palette path too.
    if (this.focused.worktree) {
      return void vscode.window.showInformationMessage(
        "You're already in a worktree. Start a new worktree from a normal session — worktrees don't nest.",
      );
    }
    const sourcePath = this.workspaceRoot();
    if (!isGitRepo(sourcePath, fs)) {
      return void vscode.window.showWarningMessage(
        "Worktree sessions need a git repository. Open a folder that is a git checkout (or run git init).",
      );
    }
    const rawLabel = await vscode.window.showInputBox({
      prompt: "Worktree label (optional)",
      placeHolder: "e.g. feat-auth — leave blank for an auto name",
      ignoreFocusOut: true,
    });
    if (rawLabel === undefined) return; // cancelled
    const label = sanitizeWorktreeLabel(rawLabel);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating git worktree…", cancellable: false },
      async () => {
        try {
          // Create needs a live sessionId. Prefer a workspace-cwd client so we
          // don't pin a worktree to a session that already lives in another wt;
          // otherwise spin a short-lived ACP client just for the create RPC.
          const creator = await this.clientForWorktreeCreate(sourcePath);
          if (!creator) {
            return void vscode.window.showErrorMessage("Could not start Grok to create a worktree.");
          }
          const { client, disposeAfter } = creator;
          let created;
          try {
            created = await client.createWorktree({
              sourcePath,
              label: label || undefined,
            });
          } finally {
            if (disposeAfter) await client.dispose();
          }
          if (created === "unsupported") {
            return void vscode.window.showWarningMessage(
              "Worktrees need a newer Grok Build CLI. Update via the gear menu → Version & about.",
            );
          }
          const wtPath = created.worktreePath;
          const wtLabel = label || path.basename(wtPath);
          this.output.appendLine(`[worktree] created ${wtPath} (label=${wtLabel})`);
          // Refresh cache so history can see sessions under this path.
          this.worktreeCache = this.worktreeCache.filter((w) => !pathsEqual(w.path, wtPath));
          this.worktreeCache.push({
            id: wtLabel,
            path: wtPath,
            sourceRepo: sourcePath,
            repoName: path.basename(sourcePath),
            kind: "session",
            creationMode: "linked",
            gitRef: "HEAD",
            headCommit: "",
            status: "alive",
            label: wtLabel,
            userProvidedLabel: !!label,
          });

          // create is ASYNC — the RPC returns "creating" before git writes the
          // checkout (its dir + `.git` pointer appear a beat later). Spawning a
          // session in a not-yet-existing cwd hangs the whole flow, so wait for
          // the checkout to land before starting the session.
          const ready = await this.waitForWorktreeReady(wtPath, 30000);
          if (!ready) {
            return void vscode.window.showErrorMessage(
              `Worktree "${wtLabel}" was created but its checkout never appeared on disk — the session wasn't started. Try again, or check \`git worktree list\`.`,
            );
          }

          // Open a brand-new session whose process cwd is the worktree.
          this.parkFocused();
          this.focused = this.newLocalSession();
          this.pool.add(this.focused);
          this.focused.cwd = wtPath;
          this.focused.worktree = {
            path: wtPath,
            label: wtLabel,
            sourceGitRoot: created.sourceGitRoot || sourcePath,
          };
          await this.startSession();
          const id = this.focused.activeSessionId;
          if (id) {
            const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
            await this.context.globalState.update(SESSION_META_KEY, {
              ...overrides,
              [id]: {
                ...(overrides[id] ?? {}),
                customName: worktreeDisplayName(wtLabel),
                worktreePath: wtPath,
                worktreeLabel: wtLabel,
                sourceGitRoot: created.sourceGitRoot || sourcePath,
              },
            });
            this.sessionCache.delete(id);
          }
          this.postSessionsList();
          void vscode.window.showInformationMessage(
            `Worktree session ready: ${wtLabel}. Edits stay isolated until you Apply worktree.`,
          );
        } catch (e: any) {
          void vscode.window.showErrorMessage(`Create worktree failed: ${e?.message ?? e}`);
        }
      },
    );
  }

  /** Poll until a freshly-created worktree's checkout exists on disk (its `.git`
   *  pointer file, which `git worktree add` writes). create is async — the RPC
   *  returns "creating" before git finishes — so a session spawned in the cwd
   *  before this would hang. Accepts a bare dir over hanging if `.git` never
   *  shows. */
  private async waitForWorktreeReady(worktreePath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(path.join(worktreePath, ".git"))) return true;
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    try { return fs.existsSync(worktreePath); } catch { return false; }
  }

  /**
   * Get an AcpClient that can call worktree/create against `sourcePath`.
   * Returns `{ disposeAfter:true }` when we spun up a temporary process.
   */
  private async clientForWorktreeCreate(
    sourcePath: string,
  ): Promise<{ client: AcpClient; disposeAfter: boolean } | undefined> {
    // Reuse a live workspace-root session when we have one (cheap + no orphan).
    for (const s of this.pool) {
      if (s.client?.sessionId && pathsEqual(this.sessionCwd(s), sourcePath)) {
        return { client: s.client, disposeAfter: false };
      }
    }
    if (this.focused.client?.sessionId && pathsEqual(this.sessionCwd(this.focused), sourcePath)) {
      return { client: this.focused.client, disposeAfter: false };
    }
    // Temporary client: initialize + session/new, caller disposes after create.
    const cfg = vscode.workspace.getConfiguration("grok");
    const cliPath = locateGrokCli(cfg.get<string>("cliPath", ""));
    if (!cliPath) return undefined;
    const client = new AcpClient({
      cliPath,
      cwd: sourcePath,
      env: this.buildEnv(sourcePath),
      log: (msg) => this.output.appendLine(msg),
    });
    // Minimal handlers so the handshake doesn't hang on server requests.
    client.fsRead = async (p) => fs.readFileSync(p, "utf8");
    client.fsWrite = async () => { /* create-only client */ };
    client.terminal = this.terminalManager;
    await client.start();
    await client.newSession();
    return { client, disposeAfter: true };
  }

  /** Merge the focused worktree's changes back into the main checkout.
   *  `skipConfirm` = the webview's custom confirm dialog already ran. */
  async applyFocusedWorktree(skipConfirm = false): Promise<void> {
    const session = this.focused;
    const wt = session.worktree;
    if (!wt) {
      return void vscode.window.showInformationMessage(
        "This session is not in a worktree. Start one with Grok: New Worktree Session.",
      );
    }
    if (!session.client?.sessionId) {
      return void vscode.window.showWarningMessage("Start the session before applying its worktree.");
    }
    if (!skipConfirm) {
      const ok = await vscode.window.showWarningMessage(
        `Apply worktree "${wt.label}" into the main checkout?\n\n${wt.path}\n→ ${wt.sourceGitRoot || this.workspaceRoot()}`,
        { modal: true },
        "Apply",
      );
      if (ok !== "Apply") return;
    }
    try {
      const r = await session.client.applyWorktree(wt.path);
      if (r === "unsupported") {
        return void vscode.window.showWarningMessage(
          "Apply worktree needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
      }
      const n = r.files?.length ?? 0;
      this.output.appendLine(`[worktree] apply ${wt.path}: ${n} file(s), status=${r.status}`);
      void vscode.window.showInformationMessage(
        n ? `Applied ${n} file${n === 1 ? "" : "s"} from worktree "${wt.label}".` : `Worktree "${wt.label}" applied (no file changes).`,
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Apply worktree failed: ${e?.message ?? e}`);
    }
  }

  /** Remove the focused session's worktree (after disposing processes that use it).
   *  `skipConfirm` = the webview's custom confirm dialog already ran. */
  async removeFocusedWorktree(skipConfirm = false): Promise<void> {
    const session = this.focused;
    const wt = session.worktree;
    if (!wt) {
      return void vscode.window.showInformationMessage("This session is not in a worktree.");
    }
    if (!skipConfirm) {
      const ok = await vscode.window.showWarningMessage(
        `Remove worktree "${wt.label}"?\n\n${wt.path}\n\nThis deletes the isolated checkout. Unapplied edits are lost.`,
        { modal: true },
        "Remove",
      );
      if (ok !== "Remove") return;
    }
    try {
      // Any live process still using the worktree as cwd locks remove on Windows.
      // Remember which remote tabs were attached to those sessions (the focused
      // one included — desk↔remote co-attach): their conversation dies with the
      // checkout, and they must be re-homed once the removal succeeds instead
      // of being left on a dead session whose cwd no longer exists.
      const strandedHolders = new Set<string>();
      for (const s of [...this.pool]) {
        if (s.worktree && pathsEqual(s.worktree.path, wt.path)) {
          for (const holder of this.remoteClients.clientsForActiveValue(s)) strandedHolders.add(holder);
          s.client?.dispose();
          s.client = undefined;
          if (s !== this.focused) this.pool.delete(s);
        }
      }
      // Need a live client for the remove RPC — use focused if still up, else temp.
      let client = this.focused.client;
      let disposeAfter = false;
      if (!client) {
        const tmp = await this.clientForWorktreeCreate(this.workspaceRoot());
        if (!tmp) {
          return void vscode.window.showErrorMessage("Could not start Grok to remove the worktree.");
        }
        client = tmp.client;
        disposeAfter = tmp.disposeAfter;
      }
      let r;
      try {
        r = await client.removeWorktree(wt.path);
      } finally {
        if (disposeAfter) await client.dispose();
      }
      if (r === "unsupported") {
        return void vscode.window.showWarningMessage(
          "Remove worktree needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
      }
      this.worktreeCache = this.worktreeCache.filter((w) => !pathsEqual(w.path, wt.path));
      this.output.appendLine(`[worktree] removed ${wt.path} (removed=${r.removed})`);
      // Clear worktree binding on meta for sessions that pointed here.
      const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      let changed = false;
      const next: SessionMetaOverrides = { ...overrides };
      for (const [id, o] of Object.entries(overrides)) {
        if (o.worktreePath && pathsEqual(o.worktreePath, wt.path)) {
          const { worktreePath: _p, worktreeLabel: _l, sourceGitRoot: _s, ...rest } = o;
          next[id] = rest;
          changed = true;
        }
      }
      if (changed) await this.context.globalState.update(SESSION_META_KEY, next);
      this.focused.worktree = undefined;
      // Leave the chat; start a normal workspace session so the user isn't stuck.
      this.parkFocused();
      this.focused = this.newLocalSession();
      this.pool.add(this.focused);
      this.focused.cwd = this.workspaceRoot();
      await this.startSession();
      this.postSessionsList();
      // Re-home the remote tabs that were on the removed worktree: a fresh
      // snapshot gives each a new conversation in its selected repository —
      // their old Session object is dead and its cwd is gone, so their next
      // send (or a refresh-restore) had nowhere to land.
      for (const holder of strandedHolders) {
        // Cancel any live dictation FIRST: its voice entry still references
        // the destroyed session, and a transcription completing after the
        // re-home would submit old-conversation speech into the new one.
        this.dropRemoteVoice(holder);
        this.remoteClients.deleteActive(holder);
        this.sendRemoteClient(holder, {
          type: "error",
          text: `Worktree "${wt.label}" was removed in VS Code, so that conversation ended. This tab now has a fresh session in its selected repository.`,
        });
        for (const message of this.buildRemoteSnapshot(holder)) this.sendRemoteClient(holder, message);
      }
      void vscode.window.showInformationMessage(`Removed worktree "${wt.label}".`);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Remove worktree failed: ${e?.message ?? e}`);
    }
  }

  /** Cached worktree list for the current repo (refreshed on create/list). */
  private worktreeCache: WorktreeRecord[] = [];

  private async refreshWorktreeCache(): Promise<void> {
    const session = this.focused.client
      ? this.focused
      : [...this.pool].find((candidate) => !!candidate.client);
    const client = session?.client;
    if (!client) return;
    const sourceRepo = session.worktree?.sourceGitRoot || this.sessionCwd(session);
    try {
      const list = await client.listWorktrees({});
      if (list === "unsupported") return;
      this.worktreeCache = mergeWorktreeRefresh(this.worktreeCache, sourceRepo, list);
    } catch (e: any) {
      this.output.appendLine(`[worktree] list failed: ${e?.message ?? e}`);
    }
  }

  private repoCatalog() {
    const pins = this.context.globalState.get<RepoPins>(REPO_PINS_KEY, {});
    const worktreeLabels = new Map<string, string>();
    for (const o of Object.values(this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {}))) {
      if (o.worktreePath && o.worktreeLabel) {
        worktreeLabels.set(normalizeRepoPath(o.worktreePath), o.worktreeLabel);
      }
    }
    for (const wt of this.worktreeCache) {
      worktreeLabels.set(normalizeRepoPath(wt.path), wt.label);
    }
    return discoverRepos({
      fs: defaultFs,
      grokHome: resolveGrokHome(process.env),
      pins,
      tmpDir: os.tmpdir(),
      // The primary workspace is already the extension's local execution scope;
      // keep it as the one trusted return target before its first catalog lands.
      trustedCwds: [this.workspaceRoot()],
      worktreeLabels,
      log: (m) => this.output.appendLine(m),
    });
  }

  private selectedHistoryCwd(): string {
    return this.selectedRepoCwd || this.sessionCwd(this.focused);
  }

  /** Session catalogs to index for a repo row: the checkout itself plus the
   *  isolated worktrees that belong to it. Worktrees are deliberately NOT repo
   *  rows (a worktree is not a checkout you choose between, and `discoverRepos`
   *  excludes `<grokHome>/worktrees` by path), so their sessions have to surface
   *  under the parent — otherwise leaving a worktree session strands it. */
  private sessionCwdsForRepo(repoCwd: string, overrides: SessionMetaOverrides): string[] {
    const cwds: string[] = [];
    const seen = new Set<string>();
    const add = (p?: string) => {
      if (!p) return;
      const key = normalizeFsPath(p);
      if (!key || seen.has(key)) return;
      seen.add(key);
      cwds.push(p);
    };
    add(repoCwd);
    const known: WorktreeParentRef[] = [
      ...Object.values(overrides)
        .filter((o) => o.worktreePath)
        .map((o) => ({ path: o.worktreePath!, sourceGitRoot: o.sourceGitRoot })),
      ...this.worktreeCache.map((wt) => ({ path: wt.path, sourceGitRoot: wt.sourceRepo })),
      ...[...this.pool]
        .filter((s) => s.worktree)
        .map((s) => ({ path: s.worktree!.path, sourceGitRoot: s.worktree!.sourceGitRoot })),
    ];
    for (const p of worktreeCwdsForRepo({
      repoCwd,
      repoGitRoot: gitRootForPath(repoCwd, defaultFs) ?? repoCwd,
      worktrees: known,
    })) {
      add(p);
    }
    return cwds;
  }

  /** Every cwd a remote client may legitimately name: the discovered repos plus
   *  their worktree catalogs (a worktree session is listed, so it must open).
   *  Built on demand — `repoCatalog()` walks `<grokHome>/sessions` on disk, and
   *  the remote gate consults this for `mentionQuery`-rate traffic. */
  private remoteTargetableCwd(cwd: string): boolean {
    const wanted = normalizeRepoPath(cwd);
    if (!wanted) return false;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    for (const repo of this.repoCatalog()) {
      for (const c of this.sessionCwdsForRepo(repo.cwd, overrides)) {
        if (normalizeRepoPath(c) === wanted) return true;
      }
    }
    return false;
  }

  private postRepoCatalog(): void {
    const entries = this.repoCatalog();
    const activeCwd = this.sessionCwd(this.focused);
    const selectedKey = normalizeRepoPath(this.selectedHistoryCwd());
    const selected = entries.find((r) => normalizeRepoPath(r.cwd) === selectedKey);
    // The selection MUST name a row in the catalog. `clearAllSessions` and
    // `selectRepo` both resolve through it and bail when the lookup misses, so
    // a selection that isn't there turns a confirmed "Delete All" into a silent
    // no-op. Falling back to the workspace root is always valid — it's a
    // trusted cwd, so it is always a row.
    const inCatalog = (cwd: string) =>
      !!cwd && entries.some((r) => normalizeRepoPath(r.cwd) === normalizeRepoPath(cwd));
    if (selected) this.selectedRepoCwd = selected.cwd;
    else this.selectedRepoCwd = inCatalog(activeCwd) ? activeCwd : this.workspaceRoot();
    // Same split as the history list: remote clients see (and drive) the global
    // selection, the VS Code webview always reads its own workspace. The chip is
    // hidden locally, but this frame still feeds Clear-all's target and the name
    // in its confirm dialog — so pointing it at a remotely-selected repo would
    // aim a destructive action somewhere the user cannot see.
    this.postLocal({
      type: "repos",
      entries,
      selectedCwd: this.workspaceRoot(),
      activeCwd,
    });
    for (const clientId of this.remoteClients.clients()) {
      const cwd = this.remoteClients.cwd(clientId);
      const remoteActive = this.remoteClients.active(clientId);
      this.sendRemoteClient(clientId, {
        type: "repos",
        entries,
        selectedCwd: cwd,
        activeCwd: remoteActive ? this.sessionCwd(remoteActive) : cwd,
      });
    }
  }

  private sendRemoteRepoCatalog(clientId: string): void {
    const cwd = this.remoteClients.cwd(clientId);
    const active = this.remoteClients.active(clientId);
    this.sendRemoteClient(clientId, {
      type: "repos",
      entries: this.repoCatalog(),
      selectedCwd: cwd,
      activeCwd: active ? this.sessionCwd(active) : cwd,
    });
  }

  /** Answer `listRepoSessions`: the newest few sessions for ONE repo, without
   *  making it the client's selection. `cwd` is matched against the catalog the
   *  client was already sent — an unknown or unavailable path is dropped in
   *  silence rather than answered, so a remote can never turn this into a probe
   *  for which arbitrary paths exist on the host. */
  private sendRepoSessionsPreview(clientId: string, cwd: string, limit?: number): void {
    const hit = this.repoCatalog().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit || !hit.available) return;
    // Clamp: the rail wants a handful, and an unbounded limit would make every
    // repo row a full history read.
    const size = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || REPO_PREVIEW_SIZE));
    const list = this.buildSessionsList(
      hit.cwd,
      { offset: 0, limit: size },
      this.remoteActiveSessionId(clientId),
    );
    if (list.type !== "sessions") return;
    this.sendRemoteClient(clientId, {
      type: "repoSessions",
      // The host's own spelling, not the one the client sent — the rail keys its
      // rows on this, and echoing an arbitrary casing would split one repo into
      // two rail entries.
      cwd: hit.cwd,
      entries: list.entries,
      dots: list.dots,
      total: list.total,
    });
  }

  private selectRepo(cwd: string): void {
    const hit = this.repoCatalog().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit || !hit.available) return;
    this.selectedRepoCwd = hit.cwd;
    this.postRepoCatalog();
    this.postSessionsList();
  }

  private async selectRemoteRepo(clientId: string, cwd: string): Promise<void> {
    const hit = this.repoCatalog().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit || !hit.available) return;
    if (this.remoteVoice.has(clientId)) void this.handleRemoteVoiceStop(clientId, true);
    this.parkRemoteSession(clientId);
    this.remoteClients.select(clientId, hit.cwd);
    this.sendRemoteRepoCatalog(clientId);

    // A deliberate repository switch has its own rule: choose that repository's
    // newest real conversation, or create a fresh one when it has no history.
    // Do not route this through remoteSessionFor(): that method deliberately
    // keeps the desk-adoption behavior for a tab that arrives with nothing of
    // its own (Continue remotely / first visit).
    const history = this.buildSessionsList(
      hit.cwd,
      { limit: Number.MAX_SAFE_INTEGER },
      undefined,
    );
    const live = new Map(
      [...this.pool]
        .filter((session) => session.activeSessionId)
        .map((session) => [session.activeSessionId!, session]),
    );
    const newest = history.type === "sessions"
      ? mostRecentSession(history.entries.filter((entry) => {
          const session = live.get(entry.id);
          // An empty live session is not repository history; selecting a repo
          // with no history should still make a new session.
          return !session || session.hasHistory;
        }))
      : undefined;
    if (newest) await this.openRemoteSession(clientId, newest.id, newest.cwd, false);
    else await this.newRemoteSession(clientId, false);
    this.sendRemoteRepoCatalog(clientId);
  }

  private async toggleRepoPin(cwd: string, pinned: boolean): Promise<void> {
    const hit = this.repoCatalog().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) return;
    const pins = this.context.globalState.get<RepoPins>(REPO_PINS_KEY, {});
    const key = normalizeRepoPath(hit.cwd);
    const next = { ...pins };
    if (pinned) next[key] = { cwd: hit.cwd, pinnedAt: Date.now() };
    else delete next[key];
    await this.context.globalState.update(REPO_PINS_KEY, next);
    this.postRepoCatalog();
  }

  private annotateWorktreeLabels(
    entries: SessionListEntry[],
    overrides: SessionMetaOverrides,
    workspaceCwd: string,
  ): void {
    const repoWts = worktreesForRepo(this.worktreeCache, workspaceCwd, { includeDead: true });
    for (const e of entries) {
      const fromMeta = overrides[e.id]?.worktreeLabel;
      if (fromMeta) {
        e.worktreeLabel = fromMeta;
        continue;
      }
      const hit = matchWorktreeForCwd(e.cwd, repoWts);
      if (hit) e.worktreeLabel = hit.label;
      else if (e.cwd && !pathsEqual(e.cwd, workspaceCwd)) {
        // Session lives outside the workspace (likely a worktree we no longer
        // track) — still surface the basename so the row is distinguishable.
        e.worktreeLabel = path.basename(e.cwd);
      }
    }
  }

  /**
   * Forward generated media (grok's `/imagine` image or `/imagine-video` video)
   * to the webview. Remote URLs pass through as a link. File paths — how grok
   * writes media into its session dir — are served via `asWebviewUri` when they
   * live under a `localResourceRoots` entry (the grok home is one), so the
   * webview streams the file straight from disk. That matters for video: a
   * multi-MB clip base64-inlined into a single `postMessage` was silently
   * dropped, which is why `/imagine-video` never rendered. Files outside the
   * served roots fall back to a base64 `data:` URI. Best-effort: a failure just
   * drops the media rather than breaking the turn.
   */
  private async postGeneratedMedia(m: MediaRef, session: Session, gen: number): Promise<void> {
    try {
      if (m.kind === "data") {
        this.emit(session, { type: "media", media: m.media, src: `data:${m.mimeType};base64,${m.data}` });
        return;
      }
      if (m.kind === "uri") {
        this.emit(session, { type: "media", media: m.media, url: m.uri });
        return;
      }
      const mime = m.mimeType || guessMediaMime(m.path);
      // Served from disk when the file is under a localResourceRoot (grok home):
      // the webview pulls bytes lazily, so even a big video renders.
      const webview = this.view?.webview;
      if (webview && this.isServableFromDisk(m.path)) {
        const src = webview.asWebviewUri(vscode.Uri.file(m.path)).toString();
        this.emit(session, { type: "media", media: m.media, src, mimeType: mime, path: m.path });
        return;
      }
      // Outside the served roots — inline as base64 so it still renders.
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(m.path));
      if (gen !== session.gen) return;
      const b64 = Buffer.from(bytes).toString("base64");
      this.emit(session, { type: "media", media: m.media, src: `data:${mime};base64,${b64}`, path: m.path });
    } catch (e) {
      this.output.appendLine(`[media] failed to forward generated media: ${(e as Error).message}`);
    }
  }

  /** True when `p` resolves inside the grok home — the localResourceRoot grok
   * generated media lives under, so `asWebviewUri` can serve it from disk. */
  private isServableFromDisk(p: string): boolean {
    try {
      return isPathInside(resolveGrokHome(), p);
    } catch {
      return false;
    }
  }

  /**
   * Save or open a math/diagram export from the webview. "open" writes the WYSIWYG
   * PNG into extension storage and opens it in VS Code's image preview. "download"
   * offers a quick-pick — PNG (VS Code theme background) or a transparent SVG tuned
   * for a dark or light background — then a save dialog. The webview pre-renders all
   * variants (the SVG light/dark differ: math recolors, mermaid re-themes).
   */
  private async exportExpr(msg: {
    action: string;
    kind: string;
    current?: string;
    svg?: string;
    png?: string;
    svgDark?: string;
    svgLight?: string;
  }, session: Session): Promise<void> {
    try {
      const base = msg.kind === "mermaid" ? "diagram" : "equation";
      const toBytes = (png?: string) =>
        png ? Buffer.from(png.split(",")[1] ?? "", "base64") : null;

      if (msg.action === "open") {
        const pngBytes = toBytes(msg.png);
        const dir = path.join(this.context.globalStorageUri.fsPath, "exports");
        fs.mkdirSync(dir, { recursive: true });
        const stamp = Date.now();
        const file = path.join(dir, `${base}-${stamp}.${pngBytes ? "png" : "svg"}`);
        fs.writeFileSync(file, pngBytes ?? (msg.svg ?? ""), pngBytes ? undefined : "utf8");
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
        return;
      }

      // download: let the user pick the format/variant (two SVG variants share the
      // .svg extension, so a save-dialog filter can't distinguish them — quick-pick).
      const mark = (which: string) => (msg.current === which ? "  (current theme)" : "");
      const items = [
        { label: "PNG", description: "raster, VS Code theme background", fmt: "png" },
        { label: `SVG — for dark background${mark("dark")}`, description: "transparent, light ink", fmt: "svgDark" },
        { label: `SVG — for light background${mark("light")}`, description: "transparent, dark ink", fmt: "svgLight" },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Export ${base} as…`,
      });
      if (!pick) return;

      const ext = pick.fmt === "png" ? "png" : "svg";
      const defaultName = `${base}.${ext}`;
      const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(this.sessionCwd(session)), defaultName);
      const filters: Record<string, string[]> =
        ext === "png" ? { "PNG image": ["png"] } : { "SVG image": ["svg"] };
      const target = await vscode.window.showSaveDialog({ defaultUri, filters });
      if (!target) return;

      if (pick.fmt === "png") {
        const pngBytes = toBytes(msg.png);
        fs.writeFileSync(target.fsPath, pngBytes ?? Buffer.from(msg.svgDark ?? "", "utf8"));
      } else {
        const svg = pick.fmt === "svgDark" ? msg.svgDark : msg.svgLight;
        fs.writeFileSync(target.fsPath, svg ?? "", "utf8");
      }
    } catch (e) {
      this.output.appendLine(`[export] failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Export failed: ${(e as Error).message}`);
    }
  }

  /**
   * Sign out of the Grok CLI (`grok logout` — clears `~/.grok/auth.json`). The
   * CLI owns auth, so we shell out to it, tear down the live session, and drop
   * the webview back to the auth-required onboarding state. Resolves issue #13.
   */
  async logout(): Promise<void> {
    const cliPath = this.cliPath || locateGrokCli(
      vscode.workspace.getConfiguration("grok").get<string>("cliPath", ""),
    );
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      "Sign out of Grok? This clears the CLI's cached credentials.",
      { modal: true },
      "Sign Out",
    );
    if (choice !== "Sign Out") return;
    // Tear down every live session first so no client's `exit` (or in-flight
    // turn) races the onboarding state we're about to show, then reset focus to a
    // fresh, unstarted session.
    await this.disposePool();
    this.focused = this.newLocalSession();
    // shellPath/shellArgs, not sendText — a quoted path typed into PowerShell
    // is a parser error.
    vscode.window.createTerminal({ name: "Grok Logout", shellPath: cliPath, shellArgs: ["logout"] });
    this.post({ type: "clearMessages" });
    this.post({ type: "onboarding", state: "auth-required" });
  }

  dispose(): void {
    void vscode.commands.executeCommand("setContext", "grok.composerFocus", false);
    if (this.reaper) { clearInterval(this.reaper); this.reaper = undefined; }
    this.uplink?.dispose();
    this.uplink = undefined;
    try { this.keepAwake.stop(); } catch { /* the pid watcher reaps it anyway */ }
    void this.disposePool();
    this.editorWatcher?.dispose();
    this.configWatcher?.dispose();
    this.terminalManager.disposeAll();
    this.stopVoiceInput();
    this.remoteClients.clear();
    try { if (this.voiceTempPath) fs.unlinkSync(this.voiceTempPath); } catch { /* best effort */ }
  }

  moveComposerCaret(direction: "forward" | "previousLine"): void {
    this.post({ type: "moveComposerCaret", direction });
  }

  // ---------- internals ----------

  private async ensureClient(session: Session = this.focused): Promise<AcpClient | undefined> {
    if (session.client) return session.client;
    // After a CLI crash the focused session keeps its grok id but loses its
    // client — respawn by RESUMING that id, so the next send continues the same
    // conversation (a bare startSession would open a blank-context session
    // under the old transcript). Fresh/unstarted sessions have no id and start
    // clean as before.
    return this.startSession(session.activeSessionId, session);
  }

  /** Read `grok --version` for policy checks. Returns "" on failure (logged). */
  private async readGrokVersion(cliPath: string, timeout = 30_000): Promise<string> {
    try {
      const { stdout } = await execGrokCli(cliPath, ["--version"], { timeout });
      return stdout?.trim() ?? "";
    } catch (e) {
      this.output.appendLine(`grok --version failed: ${(e as Error).message}`);
      return "";
    }
  }

  /** Preserve the original silent-update contract: once per extension upgrade,
   * from session start, with a fresh install only establishing the baseline. */
  private async maybeUpdateCliOnUpgrade(cliPath: string): Promise<void> {
    if (this.cliUpdateChecked) return;
    this.cliUpdateChecked = true;
    const current = (this.context.extension.packageJSON as { version?: string })?.version ?? "";
    const lastSeen = this.context.globalState.get<string>(CLI_UPDATE_VERSION_KEY);
    try {
      if (!extensionWasUpgraded(lastSeen, current)) return;
      const policy = grokUpdatePolicy(await this.readGrokVersion(cliPath), process.platform);
      if (!policy.allow) {
        this.output.appendLine(
          `Extension upgraded ${lastSeen} → ${current}; skipping silent CLI update (${policy.note}).`,
        );
        return;
      }
      const args = policy.target ? ["update", "--version", policy.target] : ["update"];
      this.output.appendLine(
        `Extension upgraded ${lastSeen} → ${current}; updating grok CLI (silent: ${args.join(" ")}).`,
      );
      this.post({ type: "cliUpdating" });
      try {
        const { stdout, stderr } = await execGrokCli(cliPath, args, { timeout: 180_000 });
        if (stdout?.trim()) this.output.appendLine(stdout.trim());
        if (stderr?.trim()) this.output.appendLine(stderr.trim());
      } catch (e) {
        this.output.appendLine(`grok update failed (continuing with current binary): ${(e as Error).message}`);
      }
    } finally {
      void this.context.globalState.update(CLI_UPDATE_VERSION_KEY, current);
    }
  }

  /** Read the installed version and decide Plan availability. This deliberately
   * performs no update, availability check, caching, or pool orchestration. */
  private async planModeCompatibility(cliPath: string): Promise<CliCompatibilityResult> {
    const versionOutput = await this.readGrokVersion(cliPath);
    const installed = parseGrokVersion(versionOutput)?.join(".");
    if (!installed) {
      const message = `Could not verify the grok CLI version; this extension requires grok ${GROK_REQUIRED_VERSION} or newer.`;
      this.output.appendLine(`${message} Continuing best-effort with the current binary.`);
      void vscode.window.showWarningMessage(message);
      return {
        planModeAvailable: false,
        planModeUnavailableReason:
          `Plan mode requires Grok CLI ${GROK_REQUIRED_VERSION} or newer; ` +
          "the installed version could not be verified.",
      };
    }
    if (isGrokVersionBelowRequired(versionOutput)) {
      const message = `grok CLI ${installed} is below required version ${GROK_REQUIRED_VERSION}; Plan mode is unavailable.`;
      this.output.appendLine(message);
      void vscode.window.showWarningMessage(message);
      return {
        planModeAvailable: false,
        planModeUnavailableReason:
          `Plan mode requires Grok CLI ${GROK_REQUIRED_VERSION} or newer; installed version is ${installed}.`,
      };
    }
    return { planModeAvailable: true };
  }

  /** Pin the bounded Windows stdio-hang range before spawning ACP. */
  private async maybePinBrokenCli(cliPath: string): Promise<void> {
    if (this.brokenCliPinned) return;
    const versionOutput = await this.readGrokVersion(cliPath);
    if (!versionOutput) return;
    if (!isStdioBrokenGrokVersion(versionOutput, process.platform)) {
      this.brokenCliPinned = true;
      return;
    }
    const detected = parseGrokVersion(versionOutput)?.join(".") ?? versionOutput;
    if (await this.downgradeBrokenCli(cliPath, detected, "proactive")) {
      this.brokenCliPinned = true;
    }
  }

  /**
   * Run `grok update --version <supported>` and notify the user, returning true
   * on success during proactive or reactive recovery from a Windows stdio failure.
   */
  private async downgradeBrokenCli(
    cliPath: string,
    fromVersion: string,
    reason: "proactive" | "reactive",
  ): Promise<boolean> {
    this.output.appendLine(
      `grok CLI ${fromVersion} has the stdio regression (issue #22, ${reason}); ` +
        `pinning to ${GROK_STDIO_DOWNGRADE_TARGET}.`,
    );
    this.post({ type: "cliUpdating" });
    try {
      const { stdout, stderr } = await execGrokCli(
        cliPath,
        ["update", "--version", GROK_STDIO_DOWNGRADE_TARGET],
        { timeout: 180_000 },
      );
      if (stdout?.trim()) this.output.appendLine(stdout.trim());
      if (stderr?.trim()) this.output.appendLine(stderr.trim());
      const detail = reason === "proactive"
        ? `Grok CLI ${fromVersion} has a known Windows startup issue (issue #22). Switched to the supported version ${GROK_STDIO_DOWNGRADE_TARGET}.`
        : `Grok CLI ${fromVersion} failed to start a session (issue #22). Switched to the supported version ${GROK_STDIO_DOWNGRADE_TARGET} and retrying.`;
      void vscode.window.showInformationMessage(detail);
      return true;
    } catch (e) {
      this.output.appendLine(`grok recovery update to ${GROK_STDIO_DOWNGRADE_TARGET} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * On-demand "is a newer grok available?" check for the gear → About panel.
   * Read-only — `grok update --check --json` doesn't touch the binary, so it's
   * safe while a session is live. Posts a grokUpdateStatus back to the webview.
   */
  private async checkGrokUpdate(): Promise<void> {
    const cliPath = this.cliPath || locateGrokCli(
      vscode.workspace.getConfiguration("grok").get<string>("cliPath", ""),
    );
    if (!cliPath) {
      this.post({ type: "grokUpdateStatus", error: "grok CLI not found" });
      return;
    }
    // Compute the update policy from the installed version (issue #22) so the menu
    // can disable the action — with a note — when an update would land on an
    // unsupported Windows build. Independent of the --check result below.
    const policy = grokUpdatePolicy(await this.readGrokVersion(cliPath), process.platform);
    try {
      const { stdout } = await execGrokCli(cliPath, ["update", "--check", "--json"], { timeout: 30_000 });
      const info = JSON.parse(stdout) as {
        currentVersion?: string;
        latestVersion?: string;
        updateAvailable?: boolean;
      };
      this.post({
        type: "grokUpdateStatus",
        current: info.currentVersion ?? null,
        latest: info.latestVersion ?? null,
        updateAvailable: !!info.updateAvailable,
        policy,
      });
    } catch (e) {
      this.output.appendLine(`grok update --check failed: ${(e as Error).message}`);
      this.post({ type: "grokUpdateStatus", error: (e as Error).message, policy });
    }
  }

  /**
   * On-demand "Update Grok Build" from the About panel. grok holds its binary
   * open while running (a hard lock on Windows), so we tear the session down,
   * run `grok update`, then resume the *same* session on the fresh binary —
   * preserving the conversation. The welcome lifecycle (Updating… → Starting… →
   * Connected · v<new>) shows progress.
   */
  private async updateGrokCliOnDemand(): Promise<void> {
    const cliPath = this.cliPath || locateGrokCli(
      vscode.workspace.getConfiguration("grok").get<string>("cliPath", ""),
    );
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform });
      return;
    }
    // Enforce the update policy (issue #22) server-side too — the menu already
    // disables the action when blocked, but never move the CLI onto an
    // unsupported Windows build even if the message arrives some other way.
    const policy = grokUpdatePolicy(await this.readGrokVersion(cliPath), process.platform);
    if (!policy.allow) {
      void vscode.window.showInformationMessage(
        policy.note ?? "Grok CLI updates are paused for compatibility.",
      );
      return;
    }
    const updateArgs = policy.target ? ["update", "--version", policy.target] : ["update"];
    // The update tears down the whole pool (the binary is locked while any session
    // holds it open), so a session that's mid-turn or waiting on you would be
    // interrupted. Warn first if any are — now that several can run at once, this
    // is no longer a non-event. (The silent startup auto-update skips this: it runs
    // before anything is in flight.)
    const busy = [...this.pool].filter(
      (s) => s.status === "working" || s.status === "needs-you",
    ).length;
    if (busy > 0) {
      const choice = await vscode.window.showWarningMessage(
        `Updating the Grok Build CLI will stop ${busy} session${busy === 1 ? "" : "s"} currently in progress. Continue?`,
        { modal: true },
        "Update Anyway",
      );
      if (choice !== "Update Anyway") return;
    }
    const resumeId = this.focused.activeSessionId;
    const resumeCwd = this.focused.cwd;
    const resumeWorktree = this.focused.worktree;
    // Free the binary: every pooled session's process holds it open (a hard lock
    // on Windows), so tear the whole pool down before the update replaces the
    // executable, then resume the focused session on the fresh binary. Other
    // backgrounded sessions go cold — re-focusing one reloads it from disk.
    // AWAIT the teardown: kill() only *signals*, and on Windows the OS releases
    // the grok.exe lock a beat after the process actually exits — running the
    // update before that loses the rename with "cannot rename locked executable".
    this.focused = this.newLocalSession();
    this.focused.cwd = resumeCwd;
    this.focused.worktree = resumeWorktree;
    this.post({ type: "clearMessages" });
    this.post({ type: "cliUpdating" });
    await this.disposePool();
    await this.runGrokUpdate(cliPath, updateArgs);
    // Respawn on the (possibly) updated binary, resuming the same session.
    await this.startSession(resumeId);
  }

  /** Run `grok update`, retrying once on the Windows "locked executable" error.
   *  Even after awaiting the pool teardown a lingering file lock can outlive the
   *  killed processes by a beat (antivirus / handle cleanup); a short pause-and-
   *  retry clears it. Any non-lock failure is real and surfaces immediately. */
  private async runGrokUpdate(
    cliPath: string,
    updateArgs: string[],
    notifyFailure = true,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout, stderr } = await execGrokCli(cliPath, updateArgs, { timeout: 180_000 });
        if (stdout?.trim()) this.output.appendLine(stdout.trim());
        if (stderr?.trim()) this.output.appendLine(stderr.trim());
        return true;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === 0 && isLockedBinaryError(msg)) {
          this.output.appendLine("grok update hit a locked binary; pausing then retrying once…");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        this.output.appendLine(`grok update failed: ${msg}`);
        if (notifyFailure) {
          void vscode.window.showWarningMessage(`Grok Build update failed: ${msg}`);
        }
        return false;
      }
    }
    return false;
  }

  /** Confirm a restart for a setting that only applies on a fresh session
   *  (reasoning effort, cross-agent model). Returns the chosen restart mode, or
   *  undefined if the user dismissed the dialog. */
  private async pickRestartMode(message: string): Promise<"clear" | "summarize" | undefined> {
    const choice = await vscode.window.showInformationMessage(
      message,
      "Summarize & Restart",
      "Just Restart",
    );
    if (!choice) return undefined;
    return choice === "Just Restart" ? "clear" : "summarize";
  }

  /** Restart the session. "clear" drops the visible history; "summarize" first
   *  captures a one-paragraph summary of the conversation and re-injects it as
   *  hidden context after the restart so the new session keeps the thread. */
  private async restartSession(mode: "clear" | "summarize", session: Session = this.focused): Promise<void> {
    if (mode === "clear") {
      this.emit(session, { type: "clearMessages" });
      await this.startSession(undefined, session);
      return;
    }
    const currentClient = session.client;
    this.emit(session, { type: "summarizing" });
    const chunks: string[] = [];
    const captureChunk = (t: string) => chunks.push(t);
    currentClient?.on("messageChunk", captureChunk);
    session.suppressContent = true;
    try {
      await currentClient?.prompt(
        "Summarize our conversation so far in a concise paragraph. Be brief.",
      );
    } catch { /* best effort */ } finally {
      currentClient?.off("messageChunk", captureChunk);
      session.suppressContent = false;
    }
    const summary = chunks.join("").trim();

    await this.startSession(undefined, session); // resets suppressContent

    if (summary && session.client) {
      this.emit(session, { type: "sessionContext" });
      session.suppressContent = true;
      try {
        await session.client.prompt(`[Context from previous session]\n${summary}`);
      } catch { /* best effort */ } finally {
        session.suppressContent = false;
      }
    }
  }

  /** A model/effort switch on an empty session (no real conversation) restarts it with a new
   *  grok session id. grok already persisted the abandoned one, so without this each repeated switch
   *  would pile another empty session into history. Drop the old session's on-disk dir and carry any
   *  user rename (`customName`) onto the new session so the chosen name survives the restart. The
   *  caller must only invoke this when the prior session genuinely had no history. No-op if the ids
   *  match or the old session was never persisted. */
  private discardRestartedEmptySession(oldId: string | undefined, session: Session = this.focused): void {
    const newId = session.activeSessionId;
    if (!oldId || oldId === newId) return;
    // Restart keeps the same session.cwd (workspace or worktree).
    const cwd = this.sessionCwd(session);
    const grokHome = resolveGrokHome(process.env);
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id: oldId });
    } catch (e) {
      this.output.appendLine(`[sessions] could not discard empty session ${oldId}: ${(e as Error).message}`);
    }
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    // carrySessionName only moves customName — also carry worktree binding so a
    // model switch mid-worktree session doesn't lose Apply/Remove.
    let next = carrySessionName(overrides, oldId, newId);
    const oldMeta = overrides[oldId];
    if (newId && oldMeta?.worktreePath) {
      next = {
        ...next,
        [newId]: {
          ...(next[newId] ?? {}),
          worktreePath: oldMeta.worktreePath,
          worktreeLabel: oldMeta.worktreeLabel,
          sourceGitRoot: oldMeta.sourceGitRoot,
        },
      };
    }
    void this.context.globalState.update(SESSION_META_KEY, next);
    this.sessionCache.delete(oldId);
    this.postSessionsList();
  }

  private async startSession(resumeId?: string, target: Session = this.focused): Promise<AcpClient | undefined> {
    // The session this start (re)builds. Today always the focused one (pool-of-1);
    // Step D passes a pool member. Its handlers close over `session`/`gen` so a
    // backgrounded session's events stay bound to it even after focus moves.
    const session = target;
    const replacedClient = session.client;
    if (replacedClient) {
      this.queueInFlightPlanCommentsOnExit(session, replacedClient, session.gen);
    }
    const gen = ++session.gen;
    const testDelay = this.testSessionStartDelay;
    if (testDelay && testDelay.resumeId === resumeId) {
      this.testSessionStartDelay = undefined;
      testDelay.started();
      await testDelay.wait;
      if (gen !== session.gen) return undefined;
    }
    session.buffer = [];
    session.status = "idle";
    // Stop any in-progress voice capture so listening never carries across a
    // new/resumed/restarted session (covers New Session, history resume, and
    // model/effort restarts — all of which route through here).
    this.stopVoiceInput(session);
    session.client = undefined;
    // Detach and dispose as one structural operation. Nothing that can return
    // belongs between these lines: the old ACP callbacks remain live until the
    // process has actually exited.
    if (replacedClient) {
      await replacedClient.dispose();
      if (gen !== session.gen) return undefined;
    }
    // A brand-new session starts in the remembered mode (#25) immediately, so the
    // toolbar shows the right one from the first paint — no Agent → Auto accept
    // flash while the session spins up and primes. Resumed sessions stay
    // verdict-driven (plan-restore decides), so they don't pre-apply it.
    const rememberedYolo = startsInYolo(
      vscode.workspace.getConfiguration("grok").get<string>("defaultMode", ""),
      !!resumeId,
    );
    // grok's own `permission_mode = "always-approve"` (config.toml, set via
    // Shift+Tab or `/always-approve`) auto-approves every session server-side
    // and is invisible over ACP — the CLI still reports plain agent mode. Detect
    // it so the button shows "Auto accept" instead of a misleading "Agent" (#31).
    // Applies to resumed sessions too (the config is global, not per-session).
    const configAutoApprove = this.configForcesAutoApprove(this.sessionCwd(session));
    session.autoApprove = rememberedYolo || configAutoApprove;
    session.planActive = false;
    session.hasHistory = false;
    session.suppressContent = false;
    session.lastPlanText = "";
    session.pendingExitPlans.clear();
    session.inFlightPlanComments.clear();
    if (session.planModeRecovery?.warningTimer) clearTimeout(session.planModeRecovery.warningTimer);
    session.planModeRecovery = undefined;
    session.interjectionCount = 0;
    session.historyEventCount = 0;
    session.replayUserRaw = "";
    session.replayUserCounted = false;
    session.replayUserIsInterjection = false;
    session.userMessageCount = 0;
    session.inUserMessage = false;
    session.activeSessionId = undefined;
    session.titleGenerated = false;
    session.firstUserMessageForTitle = undefined;
    session.priming = true;
    session.queuedSendDispatch = undefined;
    // session.authRecoveryTried deliberately NOT reset here: recoverAuthAndResend
    // calls startSession as its own retry, and a reset would let an entitlement
    // failure (#58) pay a full restart+resend cycle on every prompt. Only a clean
    // turn re-arms it.
    this.emit(session, { type: "modeChanged", modeId: session.autoApprove ? "yolo" : "agent" });
    if (configAutoApprove) this.noticeAlwaysApproveOnce();
    if (resumeId) this.emit(session, { type: "clearMessages" });

    // Lock the composer (spinner, disabled) for start() + newSession()/load so a
    // prompt cannot be sent before the session exists. Success and failure paths
    // both clear this startup lock below.
    this.emit(session, { type: "setBusy", value: true, locked: true });

    const cfg = vscode.workspace.getConfiguration("grok");
    const cliPath = locateGrokCli(cfg.get<string>("cliPath", ""));
    this.cliPath = cliPath || undefined;
    if (!cliPath) {
      if (gen !== session.gen) return undefined;
      this.pool.delete(session);
      session.priming = false;
      this.emit(session, { type: "setBusy", value: false });
      this.emit(session, { type: "onboarding", state: "missing-cli", platform: process.platform });
      return undefined;
    }

    // Keep the established once-per-extension-upgrade update trigger, then read
    // the resulting version solely to decide whether Plan is safe to expose.
    await this.maybeUpdateCliOnUpgrade(cliPath);
    if (gen !== session.gen) return undefined;
    await this.maybePinBrokenCli(cliPath);
    if (gen !== session.gen) return undefined;
    const compatibility = await this.planModeCompatibility(cliPath);
    if (gen !== session.gen) return undefined;
    session.planModeAvailable = compatibility.planModeAvailable;
    session.planModeUnavailableReason = compatibility.planModeUnavailableReason;
    this.emit(session, {
      type: "planModeAvailability",
      available: compatibility.planModeAvailable,
      reason: compatibility.planModeUnavailableReason,
    });

    // Worktree sessions pin cwd at creation/open; everyone else uses the workspace root.
    const cwd = session.cwd || this.workspaceRoot();
    session.cwd = cwd;
    // Re-bind worktree meta from override when resuming (cold open may only have cwd).
    if (!session.worktree && resumeId) {
      const o = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {})[resumeId];
      if (o?.worktreePath) {
        session.worktree = {
          path: o.worktreePath,
          label: o.worktreeLabel || path.basename(o.worktreePath),
          sourceGitRoot: o.sourceGitRoot || this.workspaceRoot(),
        };
      }
    }
    const env = this.buildEnv(cwd);
    const effortStr = cfg.get<string>("defaultEffort", "");
    const effort = effortStr ? (effortStr as EffortLevel) : undefined;
    const client = new AcpClient({
      cliPath,
      cwd,
      env,
      effort,
      log: (msg) => this.output.appendLine(msg),
    });
    session.client = client;
    // Fresh process — wait for its own mcp_initialized before mid-session notices.
    session.mcpInitialized = false;

    // fs handlers (mandatory — the agent calls these to read/write files)
    client.fsRead = async (p: string) => {
      try {
        const uri = vscode.Uri.file(p);
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return fs.readFileSync(p, "utf8");
      }
    };
    client.fsWrite = async (p: string, content: string) => {
      try {
        const uri = vscode.Uri.file(p);
        const dir = vscode.Uri.file(path.dirname(p));
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
      } catch {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    client.terminal = this.terminalManager;

    client.on("initialized", (init) => {
      if (gen !== session.gen) return;
      this.warnOAuthShadowOnce(init?._meta?.defaultAuthMethodId, env);
      this.emit(session, {
        type: "initialized",
        info: {
          cliPath,
          cwd,
          version: init?.serverInfo?.version ?? init?.version ?? null,
          init: { protocolVersion: init?.protocolVersion },
        },
      });
    });
    client.on("session", (res) => {
      if (gen !== session.gen) return;
      if (res?.sessionId) session.activeSessionId = res.sessionId;
      this.emit(session, {
        type: "session",
        sessionId: res.sessionId,
        models: client.availableModels,
        currentModelId: client.currentModelId,
        worktree: !!session.worktree,
      });
    });
    client.on("modelChanged", (id) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "modelChanged", modelId: id });
    });
    client.on("modeChanged", (id) => {
      if (gen !== session.gen) return;
      if (id === "plan") {
        // Raise the safety gate synchronously for every Plan transition. During
        // session/load, current_mode_update events replay before AcpClient has a
        // sessionId, so defer the unavailable-mode set_mode RPC to the existing
        // post-load restore block without ever leaving the gate down.
        session.autoApprove = false;
        this.setPlanActive(session, true);
        if (!session.planModeAvailable) {
          if (session.replaying) return;
          this.recoverUnavailablePlanMode(session, client, gen);
          return;
        }
        // CLI entered plan mode (covers the agent self-initiating it from a
        // natural-language request). Raise our gate so the exit is enforced.
      } else if (session === this.focused) {
        // A non-plan update is descriptive, not authority to lower the safety
        // gate. The verdict handler settles that gate before its response; direct
        // Agent/YOLO choices do so in setMode. Just refresh the button label.
        this.postMode();
      }
    });
    client.on("commandsUpdate", (cmds) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "commandsUpdate", commands: cmds });
    });
    client.on("messageChunk", (text: string) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type: "messageChunk", text });
    });
    client.on("userMessageChunk", (text: string, meta?: any) => {
      if (gen !== session.gen) return;
      // grok ≥0.2.33 echoes the *live* prompt back as user_message_chunk; 0.2.3
      // did not (its comment here read "the agent never echoes them back"). The
      // live bubble + userMessageCount come from send(), so a forwarded live
      // echo would render a duplicate bubble and double-count. Only the CLI's
      // session/load *replay* should drive user bubbles from here.
      if (!session.replaying) return;
      // Older extension sessions contain a hidden primer user turn. Don't count
      // it toward plan positions, but forward it so the webview's matching
      // legacy pattern suppresses the primer bubble and grok's acknowledgement.
      if (!session.inUserMessage && isPrimerText(text)) {
        session.inUserMessage = true;
        this.emit(session, {
          type: "userMessageChunk",
          text,
          timestampMs: agentTimestampMsFromMeta(meta),
          images: historyImagePreviews(text, this.imageStagingDir(), this.sessionCwd(session)),
        });
        return;
      }
      // The first chunk after a non-user chunk marks the start of a new user
      // message — count it so the next persisted plan knows where it lives.
      // Count ONLY turns the webview renders as bubbles (countsAsUserBubble):
      // <system-reminder> turns and marker-only verdicts replay as user
      // messages but paint nothing, and counting them here inflated every
      // post-restore verdict position — those plan/permission cards then
      // landed at the END of the conversation on the next restore.
      if (!session.inUserMessage) {
        session.replayUserRaw = "";
        session.replayUserCounted = countsAsUserBubble(text);
        session.replayUserIsInterjection = false;
        if (session.replayUserCounted) session.userMessageCount += 1;
        session.inUserMessage = true;
      }
      session.replayUserRaw += text;
      if (!session.replayUserIsInterjection && isInterjectionText(session.replayUserRaw)) {
        session.replayUserIsInterjection = true;
        session.interjectionCount += 1;
        if (session.replayUserCounted) {
          session.userMessageCount = Math.max(0, session.userMessageCount - 1);
          session.replayUserCounted = false;
        }
      }
      // Re-seed the session-scoped [Image #N] counter from replayed prompts so
      // images attached after a restore keep monotonically increasing tags
      // instead of colliding with history's numbering.
      for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
        const n = Number(m[1]);
        if (n > session.imageCounter) session.imageCounter = n;
      }
      this.emit(session, {
        type: "userMessageChunk",
        text,
        timestampMs: agentTimestampMsFromMeta(meta),
        images: historyImagePreviews(
          session.replayUserRaw,
          this.imageStagingDir(),
          this.sessionCwd(session),
        ),
      });
    });
    client.on("thoughtChunk", (text: string) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type: "thoughtChunk", text });
    });
    client.on("mediaContent", (m: MediaRef) => {
      if (gen !== session.gen) return;
      void this.postGeneratedMedia(m, session, gen);
    });
    client.on("taskBackgrounded", (u: any) => {
      if (gen !== session.gen) return;
      const cmd = typeof u?.command === "string" ? u.command : "";
      this.output.appendLine(`[task] backgrounded: ${cmd.slice(0, 200)}`);
    });
    client.on("taskCompleted", (u: any) => {
      if (gen !== session.gen) return;
      // A long-running background command finished. Surface it as a one-shot
      // toast, NOT a chat bubble — the CLI separately feeds a <system-reminder>
      // back to grok (the webview drops that on replay). Skipped during replay so
      // a resumed session doesn't re-announce tasks that finished long ago.
      if (session.replaying) return;
      const snap = u?.task_snapshot ?? u ?? {};
      const cmd = typeof snap.command === "string" ? snap.command : "";
      const exit = snap.exit_code ?? snap.exitCode ?? snap.status?.exitCode;
      const ok = exit == null || exit === 0;
      const label = summarizeBackgroundCommand(cmd);
      const text = `Grok background task ${ok ? "completed" : `exited (code ${exit})`}${label ? `: ${label}` : ""}`;
      this.output.appendLine(`[task] ${text}`);
      void vscode.window.showInformationMessage(text, "Show Logs").then((choice) => {
        if (choice === "Show Logs") this.output.show();
      });
    });
    client.on("toolCall", (u) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type: "toolCall", call: u });
    });
    client.on("toolCallUpdate", (u) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type: "toolCallUpdate", call: u });
    });
    client.on("plan", (u) => {
      if (gen !== session.gen) return;
      // Stash plan text — x.ai/exit_plan_mode params are typically empty
      session.lastPlanText =
        (typeof u?.plan === "string" ? u.plan : "") ||
        (typeof u?.planText === "string" ? u.planText : "") ||
        (typeof u?.content === "string" ? u.content : "") ||
        (typeof u?.content?.text === "string" ? u.content.text : "");
      this.output.appendLine(`[plan] event payload keys: ${Object.keys(u ?? {}).join(", ")}`);
    });
    client.on("promptComplete", (meta) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "promptComplete", meta: gateZeroTokenMeta(meta) });
      void this.accumulateUsage(session, meta);
      // A zero report (stripped above) is /compact or /session-info; neither
      // warrants a donut update here. /session-info leaves the context
      // untouched, and after /compact the fresh count comes from the live
      // auto_compact_completed notification (primary; xaiNotification listener)
      // or the live session/update envelope — reading signals.json now would
      // fetch the stale pre-compact count (the CLI recomputes it only at the
      // next inference turn's end; research/signals-refresh-probe.cjs).
    });
    client.on("contextUsage", (used: number) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "contextUsage", used });
    });
    client.on("mcpServersUpdated", () => {
      if (gen !== session.gen) return;
      // Startup always pushes servers_updated before mcp_initialized — stay
      // quiet until the first init lands, then treat later updates as a refresh.
      if (session.mcpInitialized) {
        this.emit(session, {
          type: "hostNotice",
          level: "info",
          text: mcpToolsRefreshedNote(),
        });
        void this.refreshMcpServers(session, { quiet: true });
      }
    });
    client.on("mcpInitialized", (info: { mcpToolCount: number }) => {
      if (gen !== session.gen) return;
      const first = !session.mcpInitialized;
      session.mcpInitialized = true;
      if (!first) {
        this.emit(session, {
          type: "hostNotice",
          level: "info",
          text: mcpToolsRefreshedNote(info.mcpToolCount),
        });
        void this.refreshMcpServers(session, { quiet: true });
      }
    });
    client.on("xaiNotification", (u) => {
      if (gen !== session.gen) return;
      // The post-compaction context size rides this live rail
      // (`_x.ai/session_notification`): `auto_compact_completed.tokens_after` is
      // the fresh count for BOTH a manual /compact and the CLI's automatic
      // compaction. The turn meta reports it as 0 and signals.json won't hold it
      // until the next inference turn, so this notification is the only instant
      // source (research/oss-surfaces-probe.cjs, grok 0.2.101). The donut tracks
      // the window itself (modelChanged), so pushing `used` alone updates it.
      const kind = (u as { sessionUpdate?: string })?.sessionUpdate;
      const compactUsed = contextUsedFromCompactNotification(u);
      if (compactUsed !== null) {
        this.emit(session, { type: "contextUsage", used: compactUsed });
      }
      // Compaction FAILED (either path — compaction.rs emits it on both). The
      // context is unchanged, so the donut needs no refresh; flag it so a manual
      // /compact paints the failure instead of a false "Compacted.", and surface
      // a note.
      if (kind === "auto_compact_failed") {
        session.sawCompactFailed = true;
        const err = (u as { error?: unknown })?.error;
        this.emit(session, {
          type: "autoCompactNotice",
          text: typeof err === "string" && err.trim() ? `Compaction failed: ${err.trim()}` : "Compaction failed.",
        });
      }
      // Subagent lifecycle rides this LIVE rail (not the persist/replay
      // subagentLifecycle channel). Re-route to the same `subagentUpdate` the
      // webview cards already consume — subagent_finished fills duration/output.
      if (isSubagentLifecycleUpdate(u)) this.emit(session, { type: "subagentUpdate", update: u });
      // Deep Research / Workflow / Goal progress (P2-10) — same live rail.
      // Normalized once so the webview only sees a stable card shape.
      const runProg = parseRunProgressUpdate(u);
      if (runProg) this.emit(session, { type: "runProgress", update: runProg });
      // Automatic (context-full) compaction was previously silent — surface a
      // dedicated notice (auto-path only; manual /compact paints "Compacted."
      // from the slash path). Dedicated (not a messageChunk) so it finalizes any
      // active bubble and can't reorder the agent's answer. Not persisted.
      const autoCompactNote = autoCompactStartedNote(u);
      if (autoCompactNote) this.emit(session, { type: "autoCompactNotice", text: autoCompactNote });
      // NB: the raw `xaiNotification` forward to the webview was removed — the
      // webview ignores it, so buffering every notification (incl. ~2s-cadence
      // subagent_progress) only bloated the session replay buffer. The kinds we
      // act on are re-emitted as their own (buffered, consumed) messages above.
    });
    client.on("subagentLifecycle", (u: unknown, meta?: any) => {
      if (gen !== session.gen) return;
      if ((u as { sessionUpdate?: unknown })?.sessionUpdate === "turn_completed") {
        if (session.replaying) {
          this.emit(session, {
            type: "subagentUpdate",
            update: u,
            timestampMs: agentTimestampMsFromMeta(meta),
          });
        }
        return;
      }
      this.emit(session, { type: "subagentUpdate", update: u });
    });
    client.on("commandDone", (info: { command: string; output: string; exitCode: number | null; truncated: boolean }) => {
      if (gen !== session.gen) return;
      // Defensive display cap on top of the terminal's own byte limit — a huge
      // buffer must not stall postMessage/DOM (#41). Grok saw the same capped
      // buffer, so the cut is honest either way.
      const MAX_OUTPUT_CHARS = 100_000;
      const over = info.output.length > MAX_OUTPUT_CHARS;
      this.emit(session, {
        type: "commandOutput",
        command: info.command,
        output: over ? info.output.slice(0, MAX_OUTPUT_CHARS) : info.output,
        exitCode: info.exitCode,
        truncated: info.truncated || over,
      });
    });
    client.on("permissionRequest", (req: PermissionRequest) => {
      if (gen !== session.gen) return;
      // While planning, decline permissions for operations the same fs/terminal
      // policy would block. A read-only execute request falls through to the
      // ordinary permission prompt; Plan mode never grants permission itself.
      if (session.planActive && shouldRejectPermission(req.toolCall, {
        active: true,
        workspaceRoot: cwd,
        grokHome: resolveGrokHome(process.env),
        shellDialect: resolvedTerminalShellDialect(),
      })) {
        const rejectId = pickRejectOption(req.options);
        if (rejectId) {
          client.respondPermission(req.id, rejectId);
        } else {
          client.respondPermissionCancelled(req.id);
        }
        const kind = String(req.toolCall?.kind || "tool").toLowerCase();
        this.emit(session, {
          type: "planNotice",
          text: kind === "execute"
            ? "Plan mode declined this command because it was not verified as safe to run while planning. Question-card answers are unaffected."
            : `Plan mode declined this ${kind} request because workspace changes are blocked while planning. Question-card answers are unaffected.`,
        });
        return;
      }
      if (session.autoApprove) {
        const opt = req.options.find((o) => o.kind === "allow_always") ??
                    req.options.find((o) => o.kind === "allow_once");
        if (opt) { client.respondPermission(req.id, opt.optionId); return; }
      }
      // Remember it so the answer can be persisted for replay on resume.
      const visibleOptions = permissionOptionsForPlan(
        req.options ?? [],
        session.planActive,
        req.toolCall?.kind,
      );
      if (
        session.planActive &&
        String(req.toolCall?.kind ?? "").toLowerCase() === "execute" &&
        visibleOptions.length === 0
      ) {
        client.respondPermissionCancelled(req.id);
        this.emit(session, {
          type: "planNotice",
          text: "Plan mode declined this command because it offered no safe one-time or reject option.",
        });
        return;
      }
      session.pendingPermissions.set(req.id, createPendingPermission({
        title: req.toolCall?.title || `permission: ${req.toolCall?.kind || "tool"}`,
        toolCallId: req.toolCall?.toolCallId,
        toolKind: req.toolCall?.kind,
        options: (req.options ?? []).map((o) => ({
          optionId: o.optionId,
          kind: o.kind,
          name: o.name,
        })),
      }));
      this.emit(session, { type: "permissionRequest", req: { ...req, options: visibleOptions } });
      this.setStatus(session, "needs-you");
    });
    client.on("mutationBlocked", (info: { kind: string; target: string }) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "planBlocked", kind: info.kind, target: info.target });
    });
    client.on("planFileContent", (content: string) => {
      if (gen !== session.gen) return;
      if (typeof content === "string" && content.trim()) session.lastPlanText = content;
    });
    client.on("exitPlanRequest", (req: ExitPlanRequest) => {
      if (gen !== session.gen) return;
      if (!session.planModeAvailable) {
        this.recoverUnavailablePlanMode(session, client, gen, req.id);
        return;
      }
      void this.postExitPlanRequest(req, session, gen);
    });
    client.on("questionRequest", (req: QuestionRequest) => {
      if (gen !== session.gen) return;
      // Questions are read-only and need a human — surface them in every mode
      // (plan/YOLO included); there's no sensible auto-answer.
      this.emit(session, { type: "questionRequest", req });
      this.setStatus(session, "needs-you");
    });
    client.on("exit", (code) => {
      if (gen !== session.gen) return; // suppress exit events from disposed/replaced clients
      this.emit(session, { type: "exit", code });
      if (session.queuedSends.length) {
        session.queuedSendDispatch = undefined;
        session.queuedSendCommit = undefined;
        session.queuedSends = [];
        session.queuedSendRequiresRelay = false;
        this.emit(session, { type: "queuedSends", items: [] });
      }
      this.setStatus(session, "error");
      this.pool.delete(session); // the process is gone; it's no longer a live pool member
      // Drop the dead client too (and bump gen so its other in-flight handlers
      // bail): `handleSend`/`ensureClient` prefer `session.client`, so leaving
      // it set routed every post-crash send into a dead pipe instead of
      // respawning.
      session.gen++;
      session.client = undefined;
      void client.dispose();
    });
    client.on("stderr", (text: string) => this.output.append(text));

    try {
      await client.start();
      if (gen !== session.gen) { client.dispose(); return undefined; }
      const defaultModel = cfg.get<string>("defaultModel", "");
      if (resumeId) {
        // Queue any saved plans BEFORE replay starts so the webview can interleave
        // them inline with user messages as they replay (instead of dumping all
        // cards at the bottom).
        const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
        // Answered permission cards (collapsed) for this session, interleaved
        // inline during replay like the plan cards below.
        const savedPerms = overrides[resumeId]?.permissions ?? [];
        if (savedPerms.length > 0) {
          this.emit(session, { type: "permissionHistoryQueue", permissions: savedPerms });
        }
        // `undefined` means we have NO record for this session (legacy, from
        // before per-plan persistence) — only then is the on-disk fallback
        // right. An EMPTY array is a record saying "no plans", which is exactly
        // what a rewind leaves behind: treating that as legacy re-read grok's
        // plan.md — which rewind doesn't truncate — and resurrected the very
        // plan the user had just removed, labelled "Restored from the previous
        // session".
        const saved = overrides[resumeId]?.plans;
        const planSource = planRestoreSource(saved);
        if (planSource === "saved") {
          this.emit(session, { type: "planHistoryQueue", plans: await this.withPlanReviewPaths(saved!, resumeId) });
          session.lastPlanText = saved![saved!.length - 1].text;
        } else if (planSource === "disk") {
          // Legacy session (no per-plan persistence): fall back to the on-disk
          // latest plan, which we'll render at the bottom after replay.
          const planPath = path.join(sessionsDirFor(resolveGrokHome(process.env), cwd), resumeId, "plan.md");
          if (fs.existsSync(planPath)) {
            try {
              const planText = fs.readFileSync(planPath, "utf8");
              let snapshot: { path: string; name: string } | undefined;
              try {
                snapshot = await this.createPlanReviewSnapshot(planText, resumeId);
              } catch (e) {
                this.output.appendLine(`[plan-review] ${(e as Error).message}`);
              }
              this.emit(session, {
                type: "planHistoryQueue",
                plans: [{
                  text: planText,
                  verdict: undefined as any,
                  planPath: snapshot?.path,
                  planName: snapshot?.name,
                }],
              });
              session.lastPlanText = planText;
            } catch (e) {
              this.output.appendLine(`[plan-restore] ${(e as Error).message}`);
            }
          }
        }

        await this.replayLoadedHistory(session, async () => {
          try {
            await client.loadSession(resumeId, defaultModel || undefined);
          } catch (e) {
            // A resumed session's agent is fixed by its history, so a cross-agent
            // default model (e.g. a Composer model while resuming a grok-build
            // session, or vice-versa) can't be applied with a live set_model — it
            // errors MODEL_SWITCH_INCOMPATIBLE_AGENT. The session itself already
            // loaded and replayed; just keep its own model instead of letting the
            // whole resume crash with "Grok exited (code null)".
            if (!isIncompatibleAgentError(e)) throw e;
            this.output.appendLine(
              `[resume] kept the session's own model; default '${defaultModel}' needs a different agent`,
            );
          }
        });
        session.activeSessionId = resumeId;
        session.titleGenerated = true; // existing session, name already in storage
        session.hasHistory = true;

        // Plan-gate restoration: the CLI replays its own current_mode_update
        // events during loadSession, which our modeChanged handler honors by
        // raising the gate. Override that here with the actual verdict-driven
        // decision (see plan-restore.ts) so a Cancelled or Approved session
        // doesn't come back stuck in Plan mode.
        const decision = decideRestoreState(saved);
        const unavailablePlan = !session.planModeAvailable && (
          decision.planActive || session.planActive || client.currentModeId === "plan"
        );
        if (unavailablePlan) {
          this.recoverUnavailablePlanMode(session, client, gen);
        } else {
          const restorePlan = decision.planActive && session.planModeAvailable;
          this.setPlanActive(session, restorePlan);
          const targetMode = restorePlan ? "plan" : ACT_MODE_ID;
          try { await client.setMode(targetMode); } catch { /* best-effort */ }
        }

        // Seed the context donut from grok's persisted signals.json — no turn
        // has run yet, so without this a restored session shows 0 until the
        // first prompt completes. Emitted after loadSession so it lands after
        // the donut-resetting `session` event in the replay buffer.
        this.emitContextUsage(session);
        // Same reason, for the billing breakdown (#53) — but from OUR store, as
        // grok persists no per-turn usage anywhere.
        this.restoreUsage(session);
      } else {
        await client.newSession(defaultModel || undefined);
        session.activeSessionId = client.sessionId;
      }
      if (gen !== session.gen) { client.dispose(); session.client = undefined; return undefined; }

      if (defaultModel && client.currentModelId && client.currentModelId !== defaultModel) {
        const hasModel = client.availableModels.some((m) => m.modelId === defaultModel);
        if (!hasModel) {
          // The configured default isn't available — grok already fell back to an
          // available model. Heal the (non-empty) setting silently to that model
          // so it stops being stale, and just log it; no popup nag. An EMPTY
          // default means "CLI default" and never reaches here (the `defaultModel &&`
          // guard above), so a fresh install's empty default is left untouched.
          this.output.appendLine(
            `[startup] Default model '${defaultModel}' is not available; switching grok.defaultModel to '${client.currentModelId}'.`,
          );
          const cfg = vscode.workspace.getConfiguration("grok");
          const scope = cfg.inspect<string>("defaultModel");
          const target =
            scope?.workspaceFolderValue !== undefined
              ? vscode.ConfigurationTarget.WorkspaceFolder
              : scope?.workspaceValue !== undefined
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
          void cfg.update("defaultModel", client.currentModelId, target);
        }
      }

      // Session is live — unlock the composer and flush anything typed during
      // the startup window (#37).
      session.priming = false;
      this.pool.add(session);
      this.touch(session);
      this.reapPool(); // enforce the LRU cap now that the pool grew
      this.emit(session, { type: "setBusy", value: false });
      if (gen === session.gen) void this.maybeFlushQueuedSends(session);
    } catch (err) {
      if (gen !== session.gen) { client.dispose(); return undefined; }
      const msg = (err as any).message ?? String(err);
      client.dispose();
      session.client = undefined;
      this.pool.delete(session);
      session.priming = false;
      this.emit(session, { type: "setBusy", value: false });
      // No `403`/`forbidden` here: the CLI deliberately does NOT map 403 to an
      // auth failure (entitlement/policy, which sign-in can't fix — #58); a
      // startup error carrying that wording surfaces as a plain error below.
      if (/auth|unauthor|401|api[_\s-]?key|credential|sign.?in/i.test(msg)) {
        this.emit(session, { type: "onboarding", state: "auth-required" });
      } else if (process.platform === "win32" && /timed out: (initialize|session\/(new|load))|exited \(code null\)/i.test(msg)) {
        // The signature of the Windows stdio regression (issue #22): a startup request
        // hangs because the agent won't read stdin until EOF. It spanned 0.2.61–0.2.70
        // (`initialize` on 0.2.61–0.2.64, `session/new` on 0.2.67/0.2.69/0.2.70) and was
        // fixed in 0.2.71. The universal behavior floor replaces that old bounded
        // proactive pin; this reactive net is the backstop for a future
        // still-broken build above the Windows-verified target. We restore the
        // current supported feature baseline on the observed failure and retry
        // once. A target-or-older build cannot loop through this recovery; a
        // later manual upgrade above the target re-arms it.
        const version = await this.readGrokVersion(cliPath);
        if (!this.reactiveDowngradeInFlight && shouldReactivelyDowngrade(version, process.platform)) {
          this.reactiveDowngradeInFlight = true;
          try {
            const detected = parseGrokVersion(version)?.join(".") ?? version;
            if (await this.downgradeBrokenCli(cliPath, detected, "reactive")) {
              return await this.startSession(resumeId, session); // retry the spawn on the supported build
            }
          } finally {
            this.reactiveDowngradeInFlight = false;
          }
        }
        // Pin unavailable, already attempted, or it didn't help — point the user at
        // the manual workaround instead of a bare timeout.
        this.emit(session, {
          type: "error",
          text:
            `Failed to start Grok: ${msg}. This matches the Grok CLI 0.2.61–0.2.70 stdio ` +
            `regression (issue #22, fixed after 0.2.70). Workaround: run ` +
            `\`grok update --version ${GROK_STDIO_DOWNGRADE_TARGET}\` in a terminal, then start a new session.`,
        });
      } else {
        this.emit(session, { type: "error", text: `Failed to start Grok: ${msg}` });
      }
      return undefined;
    }
    return client;
  }

  private remoteSessionFor(clientId: string): Session {
    const cwd = this.remoteClients.cwd(clientId);
    const active = this.remoteClients.active(clientId);
    if (active) return active;
    // A tab arriving with nothing of its own — "Continue remotely", or a first
    // visit — CONTINUES WHAT THE DESK IS DOING. That is the feature's whole
    // promise, and desk↔remote co-attach is what finally makes it possible:
    // before, a fresh tab got a blank session that had never been started, so
    // it showed "Starting" forever and the first send silently began a
    // SECOND conversation. Only within the tab's selected repo — adopting a
    // session from another checkout would be cross-repo bleed. A tab that
    // remembers its own conversation never reaches here (it resumes), and a
    // deliberate New session still replaces this one.
    const deskSession = this.focused;
    const canAdoptDesk = shouldAdoptDeskSession(
      this.sessionCwd(deskSession),
      this.sessionCwdsForRepo(cwd, this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {})),
      this.remoteClients.isActiveValueVisible(deskSession),
      pathsEqual,
    );
    if (canAdoptDesk) {
      this.remoteClients.setActive(clientId, deskSession);
      return deskSession;
    }
    const session = new Session();
    session.cwd = cwd;
    this.remoteClients.setActive(clientId, session);
    return session;
  }

  private async onMessage(msg: WebviewMsg, origin: MsgOrigin, clientId?: string): Promise<void> {
    const session = origin === "remote" && clientId
      ? msg.type === "selectRepo"
        ? this.remoteClients.active(clientId) ?? this.focused
        : this.remoteSessionFor(clientId)
      : this.focused;
    const requester = origin === "remote" && clientId
      ? this.captureRemoteRequester(clientId)
      : undefined;
    const attachmentOwner: AttachmentOwner = () => this.attachmentOwner(origin, clientId);
    const messageCwd = origin === "remote" && clientId
      ? this.remoteClients.cwd(clientId)
      : this.workspaceRoot();
    switch (msg.type) {
      case "ready":
        this.postInitialState();
        this.postRepoCatalog();
        this.webviewReady = true;
        this.postMcpPanelWhenReady();
        break;
      case "remotePreferences":
        if (origin === "remote" && clientId) {
          if (
            Number.isFinite(msg.fontScale) &&
            msg.fontScale >= 80 &&
            msg.fontScale <= 160
          ) {
            this.remoteClients.setMetadata(clientId, {
              fontScale: msg.fontScale,
              readRepliesAloud: msg.readRepliesAloud,
              summarizeRepliesAloud:
                msg.readRepliesAloud && msg.summarizeRepliesAloud === true,
              usesTouch: msg.usesTouch,
            });
          }
        }
        break;
      case "composerFocus":
        if (origin === "local") {
          await vscode.commands.executeCommand("setContext", "grok.composerFocus", !!msg.focused);
        }
        break;
      case "summarizeSpeech": {
        const remotePreferences = origin === "remote" && clientId
          ? this.remoteClients.metadata(clientId)
          : undefined;
        if (
          origin === "remote" &&
          (!requester ||
            remotePreferences?.readRepliesAloud !== true ||
            remotePreferences?.summarizeRepliesAloud !== true)
        ) break;
        const text = await summarizeForSpeech(
          msg.text,
          this.resolveVoiceApiKey(session.cwd || this.workspaceRoot()),
          (line) => this.output.appendLine(line),
        );
        const response: HostMsg = { type: "speechSummary", requestId: msg.requestId, text };
        if (requester) this.sendRemoteRequester(requester, response);
        else this.postLocal(response);
        break;
      }
      case "requestImageFull": {
        // Local webviews open the real file directly, so this exists for remotes,
        // which otherwise can only enlarge the 320px thumbnail.
        if (origin !== "remote" || !requester) break;
        const source = this.fullImagePaths.get(msg.fullId);
        // Unknown handle: say nothing. The overlay keeps showing the thumbnail,
        // and a probe learns nothing about what does or does not exist on disk.
        if (!source) break;
        const src = await this.renderFullImage(source);
        this.sendRemoteRequester(requester, { type: "imageFull", fullId: msg.fullId, src });
        break;
      }
      case "send":
        let queuedSendCommit: { text: string } | undefined;
        if (origin === "remote" && msg.queuedSendId) {
          if (session.completedQueuedSendIds.includes(msg.queuedSendId)) {
            this.output.appendLine(`[queue] ignored duplicate remote dequeue ${msg.queuedSendId}`);
            break;
          }
          const dispatch = session.queuedSendDispatch;
          if (
            !dispatch ||
            dispatch.id !== msg.queuedSendId ||
            dispatch.text.trim() !== msg.text.trim()
          ) {
            this.output.appendLine(`[queue] ignored stale or mismatched remote dequeue ${msg.queuedSendId}`);
            break;
          }
          session.completedQueuedSendIds.push(dispatch.id);
          if (session.completedQueuedSendIds.length > 32) session.completedQueuedSendIds.shift();
          session.queuedSendDispatch = undefined;
          queuedSendCommit = beginQueuedSendCommit(session, dispatch.text);
          if (!queuedSendCommit) break;
        }
        else if (
          origin === "remote" &&
          session.queuedSendDispatch?.text.trim() === msg.text.trim()
        ) {
          this.output.appendLine("[queue] ignored an unidentifiable legacy dequeue echo");
          break;
        }
        try {
          await this.handleSend(msg.text, msg.bare === true, session, origin, queuedSendCommit, msg.submissionId);
        } finally {
          if (queuedSendCommit) finishQueuedSendCommit(session, queuedSendCommit, false);
        }
        break;
      case "newSession":
        if (origin === "remote" && clientId) await this.newRemoteSession(clientId);
        else await this.newFocusedSession(origin);
        break;
      case "cancel":
        await session.client?.cancel("user Stop click");
        break;
      case "queueSend": {
        // Host-owned per-session queue (#37): the webview renders a mirror from
        // the queuedSends snapshots, so queued messages survive focus switches
        // and flush even while their session is backgrounded. A SINGLE pending
        // message is kept — composing more while one is queued APPENDS to it
        // (blank-line separator, the exact flush format). Separate entries were
        // a fiction: Stop and the flush both collapse them anyway, and per-entry
        // editing broke ordering (an edited entry re-queued at the end).
        const s = session;
        if (typeof msg.text === "string" && msg.text.trim()) {
          s.queuedSendDispatch = undefined;
          // STICKY, never overwritten back to false: with desk↔remote
          // co-attach both views append to ONE queue, and the combined flush
          // is a single submission — if ANY contribution is remote it must
          // round-trip the relay so it gets metered (a local overwrite here
          // would flush remote text through the unmetered local branch).
          if (origin === "remote") s.queuedSendRequiresRelay = true;
          if (s.queuedSends.length) s.queuedSends[0] += "\n\n" + msg.text;
          else s.queuedSends.push(msg.text);
          this.emit(s, { type: "queuedSends", items: [...s.queuedSends] });
          // If the turn ended while this message was in flight, fire it now.
          void this.maybeFlushQueuedSends(s);
        }
        break;
      }
      case "dequeueSend": {
        const s = session;
        if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < s.queuedSends.length) {
          s.queuedSendDispatch = undefined;
          s.queuedSendCommit = undefined;
          s.queuedSends.splice(msg.index, 1);
          if (!s.queuedSends.length) s.queuedSendRequiresRelay = false;
          this.emit(s, { type: "queuedSends", items: [...s.queuedSends] });
        }
        break;
      }
      case "steerSend":
        await this.steerSend(msg.text, session, requester);
        break;
      case "forkSession":
        await this.forkFocusedSession(session, requester);
        break;
      case "newWorktreeSession":
        await this.newWorktreeSession();
        break;
      case "applyWorktree":
        // The webview's custom confirm already ran (native modals stay only on
        // the Command-Palette path).
        await this.applyFocusedWorktree(true);
        break;
      case "removeWorktree":
        await this.removeFocusedWorktree(true);
        break;
      case "remoteSignIn":
        await this.linkRemoteDevice();
        break;
      case "remoteSignOut":
        await this.unlinkRemoteDevice();
        break;
      case "openRemotePortal":
        void vscode.env.openExternal(vscode.Uri.parse(
          httpBaseFromRelayUrl(REMOTE_RELAY_URL) + (msg.withHint ? "/?remoteHint=1" : ""),
        ));
        break;
      case "rewindSession":
        await this.rewindFocusedSession(
          typeof msg.userBubbleIndex === "number" ? msg.userBubbleIndex : undefined,
          msg.text,
        );
        break;
      case "uiConfirmAnswer": {
        const resolve = this.pendingConfirms.get(msg.id);
        if (resolve) {
          this.pendingConfirms.delete(msg.id);
          resolve(msg.ok === true);
        }
        break;
      }
      case "editLastMessage":
        await this.editLastMessage(msg.userBubbleIndex, msg.text, msg.totalUserBubbles);
        break;
      case "workflowControl":
        await this.controlWorkflow(msg.action, msg.displayName, session);
        break;
      case "clearQueuedSends": {
        // Posted by the webview's Stop flow BEFORE the cancel — a halt must not
        // auto-fire queued sends into the cancelled turn's wake.
        const s = session;
        if (s.queuedSends.length) {
          s.queuedSendDispatch = undefined;
          s.queuedSendCommit = undefined;
          s.queuedSends = [];
          s.queuedSendRequiresRelay = false;
          this.emit(s, { type: "queuedSends", items: [] });
        }
        break;
      }
      case "pickModel":
        await this.pickModel();
        break;
      case "setMode":
        await this.setMode(msg.modeId, session, requester);
        break;
      case "removeChip": {
        // A removed image chip's staged file has no other reference — reclaim
        // it now instead of leaving multi-MB orphans until the weekly sweep.
        const removed = session.chips.find((c) => c.id === msg.id);
        if (removed && isImageChip(removed)) {
          void fs.promises.unlink(removed.path).catch(() => {});
        } else if (removed) {
          const uploadDir = stagedUploadDirectory(this.fileStagingDir(), removed.path);
          if (uploadDir) void fs.promises.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
        }
        session.chips = removeChip(session.chips, msg.id);
        this.postChips(session);
        // A queued send retained after attachment validation failed is waiting
        // for exactly this state change. Re-drive only now (not from the send's
        // finally block, which would loop on the same unreadable attachment).
        void this.maybeFlushQueuedSends(session);
        break;
      }
      case "toggleChip": {
        session.chips = toggleChip(session.chips, msg.id);
        // Eye-off on the active-editor chip is a standing "don't send what I'm
        // looking at", not a one-file choice — remember it so the next file
        // switch doesn't quietly re-enable the context (#67).
        const toggled = session.chips.find((c) => c.id === msg.id);
        if (toggled && isImplicitChip(toggled)) {
          void this.context.globalState.update(IMPLICIT_CHIP_HIDDEN_KEY, toggled.hidden);
        }
        this.postChips(session);
        // Hiding an unreadable chip removes it from the next prompt just as
        // deleting it does, so it can unblock a retained idle queue too.
        void this.maybeFlushQueuedSends(session);
        break;
      }
      case "openFile": {
        const ref = parseFileRef(msg.path);
        let p = ref.path;
        if (!path.isAbsolute(p)) p = path.join(this.sessionCwd(session), p);
        const uri = vscode.Uri.file(p);
        if (ref.startLine != null) {
          const startLine = Math.max(0, ref.startLine - 1);
          const endLine = ref.endLine != null ? Math.max(startLine, ref.endLine - 1) : startLine;
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
              selection: new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER),
            });
          } catch {
            void vscode.commands.executeCommand("vscode.open", uri);
          }
        } else {
          void vscode.commands.executeCommand("vscode.open", uri);
        }
        break;
      }
      case "openUrl":
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case "openText": {
        const doc = await vscode.workspace.openTextDocument({
          content: msg.content,
          language: msg.language,
        });
        await vscode.window.showTextDocument(doc);
        break;
      }
      case "openDiff":
        await this.openDiffEditor(
          session,
          msg.path,
          msg.oldText,
          msg.newText,
          msg.requestId,
          msg.replaceAll,
          msg.sites,
        );
        break;
      case "exportExpr":
        await this.exportExpr(msg, session);
        break;
      case "dropFile":
        await this.trackAttach(this.addDroppedFile(msg.path, msg.shift, attachmentOwner));
        break;
      case "pasteImage":
        await this.trackAttach(this.addPastedImage(
          msg.data,
          msg.mimeType,
          attachmentOwner,
          requester,
          msg.previewId,
        ));
        break;
      case "uploadFile":
        await this.trackAttach(this.addUploadedFile(
          msg.name,
          msg.data,
          attachmentOwner,
          requester,
        ));
        break;
      case "permissionAnswer":
        {
          const pending = session.pendingPermissions.get(msg.requestId);
          if (!pending || !permissionAnswerAllowed(
            pendingPermissionOptions(pending, session.planActive),
            msg.optionId,
            session.planActive,
            pending.toolKind,
          )) break;
          if (!session.client?.respondPermission(msg.requestId, msg.optionId)) break;
          // Record the resolution in the session buffer so re-focusing this session
          // replays the card collapsed instead of active (the live collapse is a
          // webview-only DOM mutation that the buffer never captured).
          this.emit(session, { type: "permissionResolved", requestId: msg.requestId, optionId: msg.optionId });
          // Persist it (title + outcome) so a cold reload replays a collapsed card —
          // the CLI doesn't replay request_permission on session/load.
          this.persistPermissionAnswer(session, msg.requestId, msg.optionId);
          this.closeDiffForRequest(session, msg.requestId); // tidy up the auto-opened diff (#21)
          this.setStatus(session, "working"); // turn resumes after the answer
          break;
        }
      case "exitPlanAnswer":
        this.handleExitPlan(msg.requestId, msg.verdict, msg.comment, session);
        break;
      case "questionAnswer":
        if (session.client?.respondQuestion(msg.requestId, msg.answers ?? {}, msg.annotations ?? {})) {
          this.setStatus(session, "working");
        }
        break;
      case "questionCancel":
        if (session.client?.respondQuestionCancelled(msg.requestId)) {
          this.setStatus(session, "working");
        }
        break;
      case "setModel":
        await this.switchModel(msg.modelId, session, requester);
        break;
      case "setEffort": {
        if (session.priming) break; // ignore changes fired mid-session-start (see switchModel)
        const newLevel = msg.level;
        const cfg2 = vscode.workspace.getConfiguration("grok");

        if (!session.hasHistory || !session.client) {
          // As with a model switch on an empty session: restart without the summarize-vs-restart
          // prompt and discard the abandoned empty session — but only when it truly had no
          // history (a dead client on a session WITH history must keep that history).
          const wasEmpty = !session.hasHistory;
          const discardId = session.activeSessionId;
          await cfg2.update("defaultEffort", newLevel, vscode.ConfigurationTarget.Global);
          await this.startSession(undefined, session);
          if (wasEmpty) this.discardRestartedEmptySession(discardId, session);
          break;
        }

        // Live effort switch — no restart — when the CLI honors per-session
        // effort (grok ≥ the build advertising models[]._meta.supportsReasoningEffort
        // + accepting set_model _meta.reasoningEffort; confirmed 0.2.101). Only a
        // real, non-empty effort qualifies — "unset" (back to default) still needs
        // a fresh spawn without --reasoning-effort. Persist `defaultEffort` ONLY
        // after the switch actually lands (live-applied, or restart accepted) — a
        // persist-before that fails + dismissed restart would leave the saved
        // default changed while the session ran at the old effort.
        if (newLevel && session.client.currentModelSupportsEffort()) {
          const applied = await session.client.setReasoningEffort(newLevel).catch(() => false);
          if (applied) {
            await cfg2.update("defaultEffort", newLevel, vscode.ConfigurationTarget.Global);
            break;
          }
        }

        if (origin === "remote" && clientId) {
          this.reportRequester(
            requester,
            "warning",
            "Changing reasoning effort here requires restarting the conversation from the VS Code view.",
          );
          break;
        }
        const mode = await this.pickRestartMode("Changing reasoning effort requires restarting the session.");
        if (!mode) break; // dismissed — leave defaultEffort untouched
        await cfg2.update("defaultEffort", newLevel, vscode.ConfigurationTarget.Global);
        await this.restartSession(mode, session);
        break;
      }
      case "openGlobalConfig": {
        const home = process.env.HOME || process.env.USERPROFILE || "";
        const globalCfg = path.join(home, ".grok", "config.toml");
        if (!fs.existsSync(globalCfg)) {
          fs.mkdirSync(path.dirname(globalCfg), { recursive: true });
          fs.writeFileSync(globalCfg, "# Grok global configuration\n");
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(globalCfg));
        break;
      }
      case "openProjectConfig": {
        const cwd2 = this.sessionCwd(session);
        const projCfg = path.join(cwd2, ".grok", "config.toml");
        if (!fs.existsSync(projCfg)) {
          fs.mkdirSync(path.dirname(projCfg), { recursive: true });
          fs.writeFileSync(projCfg, "# Grok project configuration\n# MCP servers here apply to this workspace only.\n");
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(projCfg));
        break;
      }
      case "listMcpServers": {
        // Gear → MCP servers: in-panel list with enable/disable (CLI 0.2.113+).
        await this.refreshMcpServers(session);
        break;
      }
      case "setMcpServerEnabled": {
        await this.setMcpServerEnabled(session, msg.name, !!msg.enabled);
        break;
      }
      case "showLogs":
        this.output.show();
        break;
      case "moveView": {
        // Gear -> Config & debug -> Move view. Each destination targets an
        // extension-owned container, so the move is direct — no quickpick. An
        // unknown location falls back to the built-in destination picker
        // preselected on our view (the view-id argument also sidesteps the
        // focusedView context, which Cursor never sets for webview views).
        const containerId = moveViewContainerFor(msg.location);
        if (containerId) {
          await vscode.commands.executeCommand("vscode.moveViews", {
            viewIds: [GROK_VIEW_ID],
            destinationId: containerId,
          });
          await vscode.commands.executeCommand(`${GROK_VIEW_ID}.focus`);
        } else {
          await vscode.commands.executeCommand("workbench.action.moveFocusedView", GROK_VIEW_ID);
        }
        break;
      }
      case "setShowThinking":
        // Persist globally (like the other display prefs); the config watcher
        // re-posts the value, keeping every open webview in sync.
        await vscode.workspace
          .getConfiguration("grok")
          .update("showThinking", !!msg.value, vscode.ConfigurationTarget.Global);
        break;
      case "setExpandCommandOutputs":
        await vscode.workspace
          .getConfiguration("grok")
          .update("expandCommandOutputs", !!msg.value, vscode.ConfigurationTarget.Global);
        break;
      case "setSteerByDefault":
        await vscode.workspace
          .getConfiguration("grok")
          .update("steerByDefault", !!msg.value, vscode.ConfigurationTarget.Global);
        break;
      case "setSoundNotifications":
        await vscode.workspace
          .getConfiguration("grok")
          .update("soundNotifications", !!msg.value, vscode.ConfigurationTarget.Global);
        break;
      case "setProcessingSound":
        await vscode.workspace
          .getConfiguration("grok")
          .update("processingSound", !!msg.value, vscode.ConfigurationTarget.Global);
        break;
      case "setReadRepliesAloud":
        await vscode.workspace
          .getConfiguration("grok")
          .update("readRepliesAloud", !!msg.value, vscode.ConfigurationTarget.Global);
        break;
      case "setSummarizeRepliesAloud":
        await vscode.workspace
          .getConfiguration("grok")
          .update("summarizeRepliesAloud", !!msg.value, vscode.ConfigurationTarget.Global);
        break;
      case "runInstallCmd": {
        const term = vscode.window.createTerminal("Install Grok");
        term.show();
        // Windows ships a native CLI installed via PowerShell; the default VS Code
        // terminal there is PowerShell, so use its syntax. Everything else is POSIX.
        const done = "Done. Click 'Re-check connection' in the Grok sidebar.";
        term.sendText(
          process.platform === "win32"
            ? `irm https://x.ai/cli/install.ps1 | iex; Write-Host "\`n${done}"`
            : `curl -fsSL https://x.ai/cli/install.sh | bash && echo "\\n${done}"`,
        );
        break;
      }
      case "runGrokLogin": {
        const cliPath = this.cliPath || locateGrokCli(
          vscode.workspace.getConfiguration("grok").get<string>("cliPath", ""),
        );
        if (!cliPath) {
          this.post({ type: "onboarding", state: "missing-cli" });
          break;
        }
        // shellPath/shellArgs, not sendText — a quoted path typed into
        // PowerShell is a parser error.
        const term = vscode.window.createTerminal({ name: "Grok Login", shellPath: cliPath, shellArgs: ["login"] });
        term.show();
        break;
      }
      case "recheckConnection":
        await this.startSession(session.activeSessionId, session);
        break;
      case "logout":
        await this.logout();
        break;
      case "checkGrokUpdate":
        await this.checkGrokUpdate();
        break;
      case "updateGrok":
        await this.updateGrokCliOnDemand();
        break;
      case "listSessions":
        if (origin === "remote" && clientId) {
          this.sendRemoteClient(clientId, this.buildSessionsList(messageCwd, {
            offset: msg.offset, limit: msg.limit, query: msg.query,
          }, session.activeSessionId));
        } else {
          this.postSessionsList({ offset: msg.offset, limit: msg.limit, query: msg.query });
        }
        break;
      case "listRepoSessions":
        // Preview rows for a repo WITHOUT selecting it (the projects rail).
        // Remote-only: the VS Code webview has no rail and is locked to its own
        // workspace, so answering it locally would be the one path that hands
        // the local view another repo's history.
        if (origin === "remote" && clientId) {
          this.sendRepoSessionsPreview(clientId, msg.cwd, msg.limit);
        }
        break;
      case "selectRepo":
        if (origin === "remote" && clientId) this.selectRemoteRepo(clientId, msg.cwd);
        else this.selectRepo(msg.cwd);
        break;
      case "toggleRepoPin":
        await this.toggleRepoPin(msg.cwd, msg.pinned);
        break;
      case "resumeSession":
        if (origin === "remote" && clientId) {
          await this.openRemoteSession(clientId, msg.id, msg.cwd);
        }
        else await this.openSession(msg.id, msg.cwd);
        break;
       case "renameSession":
          this.renameSession(msg.id, msg.name, origin, clientId);
          break;
      case "deleteSession":
        await this.deleteSession(msg.id, msg.name, origin, clientId);
        break;
      case "clearAllSessions":
        await this.clearAllSessions(msg.cwd, origin, clientId);
        break;
      case "pickFile":
        await this.trackAttach(this.pickFileFromComputer());
        break;
      case "mentionQuery": {
        // Answer from the TTL-cached index; a failed build degrades to an empty
        // list (the popover just hides) rather than an error surface.
        let files: string[] = [];
        try {
          const index = await this.mentionFileIndexForCwd(this.sessionCwd(session));
          files = filterMentionFiles(index.rels, msg.query);
        } catch (e) {
          this.output.appendLine(`[mention] index failed: ${(e as Error).message}`);
        }
        if (requester) {
          this.sendRemoteRequester(requester, { type: "mentionResults", query: msg.query, files });
        } else {
          this.post({ type: "mentionResults", query: msg.query, files });
        }
        break;
      }
      case "addMentionFile": {
        const workspaceRoot = this.sessionCwd(attachmentOwner());
        if (!workspaceRoot) break;

        let catalogMatch: string | undefined;
        let openTabMatch: string | undefined;
        if (origin === "remote") {
          // A remote can only echo a path the host currently exposes through
          // its merged mention catalog. It never gets the local #69 fallback.
          try {
            catalogMatch = (await this.mentionFileIndexForCwd(workspaceRoot)).absByRel.get(msg.relPath);
          } catch (e) {
            this.output.appendLine(`[mention] index failed while validating remote pick: ${(e as Error).message}`);
          }
        } else {
          // Local picks preserve the #69 fallback for a result whose cached/open
          // entry disappeared between rendering and selection.
          try {
            catalogMatch = (await this.mentionFileIndexForCwd(workspaceRoot)).absByRel.get(msg.relPath);
          } catch (e) {
            this.output.appendLine(`[mention] index failed while validating local pick: ${(e as Error).message}`);
          }
          if (pathsEqual(workspaceRoot, this.workspaceRoot())) {
            openTabMatch = this.openWorkspaceFileEntries().find((e) => e.rel === msg.relPath)?.abs;
          }
        }
        const abs = resolveMentionAttachmentPath(
          origin,
          workspaceRoot,
          msg.relPath,
          catalogMatch,
          openTabMatch,
        );
        if (!abs || !isMentionPathInsideWorkspace(workspaceRoot, abs)) break;

        // Lexical containment above handles `..`; canonical containment also
        // rejects an in-workspace symlink whose target is outside the workspace.
        try {
          const [realRoot, realFile] = await Promise.all([
            fs.promises.realpath(workspaceRoot),
            fs.promises.realpath(abs),
          ]);
          if (!isMentionPathInsideWorkspace(realRoot, realFile)) break;
        } catch {
          // Stale/garbage catalog entries remain a no-op, as before.
          break;
        }
        await this.trackAttach(this.addDroppedFile(abs, false, attachmentOwner));
        break;
      }
      case "voiceStart":
        await this.handleVoiceStart(session);
        break;
      case "voiceStop":
        if (msg.discard) this.stopVoiceInput();
        else await this.handleVoiceStop();
        break;
      case "remoteVoiceStart":
        if (origin === "remote" && clientId) await this.handleRemoteVoiceStart(clientId, session);
        break;
      case "remoteVoiceChunk":
        if (origin === "remote" && clientId) this.handleRemoteVoiceChunk(clientId, msg.data);
        break;
      case "remoteVoiceStop":
        if (origin === "remote" && clientId) await this.handleRemoteVoiceStop(clientId, !!msg.cancel);
        break;
    }

  }

  /**
   * Send one page of session history to the webview. The cheap `indexSessions` stat pass orders
   * every session by last activity without reading content; only the visible window (or, for a
   * search, the matched window) is parsed — and even those come from {@link sessionCache} unless
   * their `summary.json` changed. So opening the popover is O(page) reads regardless of how many
   * thousands of sessions exist on disk; the multi-second full-scan stall is gone.
   *
   * `offset === 0` is a fresh list/search (the webview replaces); `offset > 0` is load-more (the
   * webview appends). A non-empty `query` filters by display name across ALL sessions (it warms the
   * cache once so search stays complete, not just over what's already loaded).
   */
  /**
   * The local webview has no repo switcher and always uses the workspace root.
   * Remote callers bypass this legacy audience helper and resolve their own cwd
   * through RemoteClientState.
   */
  private historyCwdFor(origin: MsgOrigin): string {
    return repoScopeFor(origin, {
      selectedCwd: this.selectedHistoryCwd(),
      workspaceRoot: this.workspaceRoot(),
    });
  }

  /** Refresh local history plus each connected remote tab. */
  private postSessionsList(opts?: { offset?: number; limit?: number; query?: string }): void {
    const localCwd = this.historyCwdFor("local");
    const local = this.buildSessionsList(localCwd, opts);
    this.postLocal(local);
    if (opts) return;
    for (const clientId of this.remoteClients.clients()) {
      const cwd = this.remoteClients.cwd(clientId);
      const activeId = this.remoteActiveSessionId(clientId);
      this.sendRemoteClient(
        clientId,
        this.buildSessionsList(cwd, undefined, activeId),
      );
    }
  }

  private buildSessionsList(
    cwd: string,
    opts?: { offset?: number; limit?: number; query?: string },
    activeId: string | null | undefined = this.focused.activeSessionId,
  ): HostMsg {
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const query = (opts?.query ?? "").trim().toLowerCase();
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const log = (m: string) => this.output.appendLine(m);

    // Best-effort refresh so worktree sessions appear without a create this window.
    // Fire-and-forget: a late refresh just needs another list open to show up.
    void this.refreshWorktreeCache();

    // Scoped to the SELECTED repo — that is what makes picking a repo define the
    // history scope. Its worktrees ride along (they are not repo rows of their
    // own), so a worktree session stays reachable after you leave it.
    const repoCwds = this.sessionCwdsForRepo(cwd, overrides);
    const repoCwdKeys = new Set(repoCwds.map(normalizeFsPath));
    const index = mergeSessionIndexes(
      repoCwds.map((c) => ({
        cwd: c,
        entries: indexSessions({ fs: defaultFs, grokHome, cwd: c, log }),
      })),
    );
    const mtimeById = new Map(index.map((e) => [e.id, e.mtimeMs]));
    const cwdById = new Map(index.map((e) => [e.id, e.cwd]));

    // Subagent child sessions (`session_kind: "subagent"` — grok persists every
    // spawn_subagent delegation as a top-level sibling session) are grok's own
    // working state, not user chats: hide them from history or every delegation
    // adds a junk row. They still occupy index slots, so paging advances by ids
    // CONSUMED (nextOffset), never by entries shown — a filtered-out id must not
    // make the next page re-read the same slice.
    let pageEntries: SessionListEntry[];
    let total: number;
    let nextOffset: number;
    if (query) {
      // Search needs names for everything, so read (cache-backed) the whole list once, then filter.
      const all = this.readEntriesCachedMulti(index.map((e) => e.id), mtimeById, cwdById, overrides, grokHome, log)
        .filter((e) => e.kind !== "subagent");
      all.sort((a, b) => b.updatedAt - a.updatedAt);
      const matched = all.filter(
        (e) =>
          e.displayName.toLowerCase().includes(query) ||
          (e.worktreeLabel && e.worktreeLabel.toLowerCase().includes(query)),
      );
      total = matched.length;
      pageEntries = matched.slice(offset, offset + limit);
      nextOffset = offset + pageEntries.length;
    } else {
      total = index.length;
      const pageIds = index.slice(offset, offset + limit).map((e) => e.id);
      pageEntries = this.readEntriesCachedMulti(pageIds, mtimeById, cwdById, overrides, grokHome, log)
        .filter((e) => e.kind !== "subagent");
      // mtime is an approximate sort key; re-order the loaded page by exact updated_at.
      pageEntries.sort((a, b) => b.updatedAt - a.updatedAt);
      nextOffset = offset + pageIds.length;
    }
    this.annotateWorktreeLabels(pageEntries, overrides, cwd);

    // hasMore is governed purely by what's on disk (load-more pages disk-only); compute it before
    // injecting any live-only rows below so an injected entry can't be mistaken for another page.
    const hasMore = nextOffset < total;

    // A brand-new live session has no summary.json yet, so the disk-scan index misses it. Without
    // this, opening history the moment a session goes live drops the active row entirely (and the
    // old top session masquerades as the whole list) until grok flushes the file — exactly the
    // "open too early" glitch. Synthesize a row from in-memory state for any live pool session not
    // yet on disk, pinned newest-first. Only on the first, unfiltered page: later pages are
    // disk-only, and a nameless not-yet-persisted session can't be matched by a search query.
    // These ids are never on disk, so they can't duplicate onto a later page when the user scrolls.
    // Scoped to repoCwdKeys (same set `index` was built from) — a live pool session from a
    // DIFFERENT repo (e.g. the still-focused session right after a remote repo switch) must
    // not leak into this repo's list, or it masquerades as this repo's newest/active row and
    // the remote auto-open shim mistakes it for an already-open match, never resuming/starting
    // the session that actually belongs here.
    if (!query && offset === 0) {
      const onDisk = new Set(index.map((e) => e.id));
      const seen = new Set(pageEntries.map((e) => e.id));
      const synthetic: SessionListEntry[] = [];
      for (const s of this.pool) {
        const id = s.activeSessionId;
        if (!id || onDisk.has(id) || seen.has(id)) continue;
        const sCwd = this.sessionCwd(s);
        if (!repoCwdKeys.has(normalizeFsPath(sCwd))) continue;
        const entry = this.liveSessionEntry(s, id, sCwd, overrides);
        if (s.worktree) entry.worktreeLabel = s.worktree.label;
        synthetic.push(entry);
        seen.add(id);
      }
      if (synthetic.length) {
        synthetic.sort((a, b) => b.updatedAt - a.updatedAt);
        pageEntries = [...synthetic, ...pageEntries];
      }
    }

    // A live, still-empty session must read "New session", never a stale disk-derived
    // summary — even after grok flushes summary.json. The truth is in
    // memory (hasHistory), so override the disk-derived name here. This is the single
    // untitled session the user starts from; abandoning it deletes it (parkFocused).
    const liveEmpty = new Set<string>();
    for (const s of this.pool) {
      if (s.activeSessionId && !s.hasHistory) liveEmpty.add(s.activeSessionId);
    }
    if (liveEmpty.size) {
      for (const e of pageEntries) {
        if (!e.customName && liveEmpty.has(e.id)) e.displayName = "New session";
      }
    }

    // Dashboard dot per grok-session-id (live status + persisted unread badge) for the rows we send,
    // plus any live pool member not yet written to disk (a brand-new session has no summary.json).
    const dots: Record<string, Dot> = {};
    for (const e of pageEntries) dots[e.id] = this.dotForId(e.id);
    for (const s of this.pool) {
      if (s.activeSessionId && !(s.activeSessionId in dots)) {
        dots[s.activeSessionId] = this.dotForId(s.activeSessionId);
      }
    }
    return {
      type: "sessions",
      entries: pageEntries,
      activeId,
      dots,
      offset,
      total,
      hasMore,
      nextOffset,
      query: opts?.query ?? "",
    };
  }

  /** Synthesize a list entry for a live session grok hasn't written a `summary.json` for yet (a
   *  brand-new one). The disk-scan index can't see it, so without this the active row would vanish
   *  from history when the popover is opened the instant a session goes live. Uses the best name we
   *  have in memory: a generated/renamed `customName`, else the first user message, else a
   *  placeholder — all of which the next refresh replaces with grok's own summary once it lands. */
  /** The name this session shows in the history list — what the user actually
   *  reads, which is what a fork should be named after (#48).
   *
   *  Precedence mirrors the list itself: the rename/auto-generated `customName`
   *  first (that IS the row's label for any session that has one), then grok's
   *  own `session_summary` from disk, then the first user message.
   *
   *  The one deliberate departure: a **legacy primer-derived** summary is
   *  skipped. Older builds sent the primer as message #1, so inheriting that
   *  invisible internal title into a fork would propagate it forever.
   *  `isPrimerSummary` rejects it and we fall through to something real. */
  private sessionDisplayName(session: Session): string {
    const id = session.activeSessionId;
    if (!id) return "";
    const custom = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]?.customName?.trim();
    if (custom) return custom;
    try {
      const cwd = this.sessionCwd(session);
      const raw = fs.readFileSync(
        path.join(sessionsDirFor(resolveGrokHome(process.env), cwd), id, "summary.json"),
        "utf8",
      );
      const summary = (JSON.parse(raw)?.session_summary as string | undefined)?.trim();
      if (summary && !isPrimerSummary(summary)) return fallbackName(summary, Date.now());
    } catch {
      // No summary yet (grok flushes it at turn end) — fall through.
    }
    // Same last resort the history list uses ("Untitled (<date>)"), so a fork of
    // a nameless session reads like a row rather than a bare "(Fork)".
    const first = (session.firstUserMessageForTitle || "").trim();
    return fallbackName(first, Date.now());
  }

  private liveSessionEntry(
    session: Session,
    id: string,
    cwd: string,
    overrides: SessionMetaOverrides,
  ): SessionListEntry {
    const now = Date.now();
    const customName = overrides[id]?.customName?.trim() || undefined;
    const firstMsg = (session.firstUserMessageForTitle || "").trim();
    const displayName = customName || (firstMsg ? fallbackName(firstMsg, now) : "New session");
    const ts = session.lastActiveAt || now;
    return {
      id,
      cwd,
      displayName,
      rawSummary: firstMsg,
      customName,
      updatedAt: ts,
      createdAt: ts,
      numMessages: session.userMessageCount,
      modelId: undefined,
    };
  }

  /** Read entries for the given ids, serving unchanged ones from {@link sessionCache} and re-reading
   *  only those whose `summary.json` mtime moved (or that aren't cached). Keeps the popover's
   *  steady-state cost near zero across opens, load-more, and search. */
  private readEntriesCached(
    ids: string[],
    mtimeById: Map<string, number>,
    overrides: SessionMetaOverrides,
    cwd: string,
    grokHome: string,
    log: (m: string) => void,
  ): SessionListEntry[] {
    const stale: string[] = [];
    for (const id of ids) {
      const cached = this.sessionCache.get(id);
      if (!cached || cached.mtimeMs !== (mtimeById.get(id) ?? -1)) stale.push(id);
    }
    if (stale.length) {
      const fresh = readSessionEntries({ fs: defaultFs, grokHome, cwd, ids: stale, overrides, log });
      for (const e of fresh) {
        this.sessionCache.set(e.id, { mtimeMs: mtimeById.get(e.id) ?? 0, entry: e });
      }
    }
    return ids.map((id) => this.sessionCache.get(id)?.entry).filter((e): e is SessionListEntry => !!e);
  }

  /**
   * Like {@link readEntriesCached} but each id may live under a different cwd
   * (workspace vs worktree). Groups stale ids by cwd so we still batch the
   * disk reads per catalog.
   */
  private readEntriesCachedMulti(
    ids: string[],
    mtimeById: Map<string, number>,
    cwdById: Map<string, string>,
    overrides: SessionMetaOverrides,
    grokHome: string,
    log: (m: string) => void,
  ): SessionListEntry[] {
    const staleByCwd = new Map<string, string[]>();
    for (const id of ids) {
      const cached = this.sessionCache.get(id);
      if (cached && cached.mtimeMs === (mtimeById.get(id) ?? -1)) continue;
      const c = cwdById.get(id) || this.workspaceRoot();
      const list = staleByCwd.get(c) ?? [];
      list.push(id);
      staleByCwd.set(c, list);
    }
    for (const [c, stale] of staleByCwd) {
      const fresh = readSessionEntries({ fs: defaultFs, grokHome, cwd: c, ids: stale, overrides, log });
      for (const e of fresh) {
        this.sessionCache.set(e.id, { mtimeMs: mtimeById.get(e.id) ?? 0, entry: e });
      }
    }
    return ids.map((id) => this.sessionCache.get(id)?.entry).filter((e): e is SessionListEntry => !!e);
  }

  private remoteAuthorizedSessionCwd(
    clientId: string,
    id: string,
    overrides: SessionMetaOverrides,
  ): string | undefined {
    const selectedCwd = this.remoteClients.cwd(clientId);
    const allowedCwds = this.sessionCwdsForRepo(selectedCwd, overrides);
    const live = [...this.pool].find((session) => session.activeSessionId === id);
    if (live) {
      const cwd = this.sessionCwd(live);
      if (sessionCwdBelongsToRepo(cwd, allowedCwds, pathsEqual)) return cwd;
    }

    const candidates = [...new Set([
      overrides[id]?.worktreePath,
      this.sessionCache.get(id)?.entry.cwd,
      ...allowedCwds,
    ].filter((cwd): cwd is string =>
      !!cwd && sessionCwdBelongsToRepo(cwd, allowedCwds, pathsEqual)
    ))];
    const grokHome = resolveGrokHome(process.env);
    return candidates.find((cwd) =>
      indexSessions({ fs: defaultFs, grokHome, cwd })
        .some((entry) => entry.id === id)
    );
  }

  private reportUnauthorizedSessionTarget(clientId: string, action: "rename" | "delete", id: string): void {
    this.output.appendLine(`[remote] refused ${action}Session for ${id} (session is outside selected repo)`);
    this.sendRemoteClient(clientId, {
      type: "error",
      text: `Could not ${action} this conversation because it does not belong to this tab's selected repository.`,
    });
  }

  private renameSession(
    id: string,
    name: string,
    origin: MsgOrigin,
    clientId?: string,
  ): void {
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    if (origin === "remote" && clientId && !this.remoteAuthorizedSessionCwd(clientId, id, overrides)) {
      this.reportUnauthorizedSessionTarget(clientId, "rename", id);
      return;
    }
    const trimmed = (name || "").trim();
    const next: SessionMetaOverrides = { ...overrides };
    if (!trimmed) {
      const cur = next[id];
      if (cur) {
        const { customName: _drop, ...rest } = cur;
        if (Object.keys(rest).length === 0) delete next[id];
        else next[id] = rest;
      }
    } else {
      next[id] = { ...(next[id] ?? {}), customName: trimmed };
    }
    void this.context.globalState.update(SESSION_META_KEY, next);
    // A rename changes displayName but not summary.json's mtime, so the mtime-keyed cache would
    // otherwise keep serving the old name. Drop it so the next read rebuilds the entry.
    this.sessionCache.delete(id);
    this.postSessionsList();
  }

  // No native confirm here: the webview shows its own confirm dialog before
  // posting deleteSession (works in the browser client too, where a host-side
  // modal would stall invisibly).
  private sessionHasLiveOwner(session: Session): boolean {
    return session === this.focused || this.remoteClients.isActiveValueVisible(session);
  }

  private reportProtectedSession(origin: MsgOrigin, clientId: string | undefined, action: "delete" | "clear"): void {
    const text = action === "delete"
      ? "This conversation is open in another tab or the VS Code view. Close it there before deleting it."
      : "Open conversations were kept. Close them in their tabs or the VS Code view before clearing them.";
    if (origin === "remote" && clientId) {
      this.sendRemoteClient(clientId, { type: "error", text });
    } else {
      void vscode.window.showInformationMessage(text);
    }
  }

  private captureRemoteRequester(clientId: string): RemoteRequester {
    return { clientId, tabToken: this.remoteClients.tabToken(clientId) };
  }

  private resolveRemoteRequester(requester: RemoteRequester): string | undefined {
    if (requester.tabToken) {
      return this.remoteClients.clientForTabToken(requester.tabToken);
    }
    return this.remoteClients.isCurrent(requester.clientId)
      && this.remoteClients.cwdIfPresent(requester.clientId)
      ? requester.clientId
      : undefined;
  }

  private sendRemoteRequester(requester: RemoteRequester, message: HostMsg): void {
    const clientId = this.resolveRemoteRequester(requester);
    if (clientId) this.sendRemoteClient(clientId, message);
  }

  private reportRequester(
    requester: RemoteRequester | undefined,
    level: "info" | "warning" | "error",
    text: string,
  ): void {
    if (requester) {
      this.sendRemoteRequester(
        requester,
        level === "error" ? { type: "error", text } : { type: "hostNotice", level, text },
      );
      return;
    }
    if (level === "error") void vscode.window.showErrorMessage(text);
    else if (level === "warning") void vscode.window.showWarningMessage(text);
    else void vscode.window.showInformationMessage(text);
  }

  private async deleteSession(
    id: string,
    _name: string | undefined,
    origin: MsgOrigin,
    clientId?: string,
  ): Promise<void> {
    const overridesNow = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const authorizedRemoteCwd = origin === "remote" && clientId
      ? this.remoteAuthorizedSessionCwd(clientId, id, overridesNow)
      : undefined;
    if (origin === "remote" && clientId && !authorizedRemoteCwd) {
      this.reportUnauthorizedSessionTarget(clientId, "delete", id);
      return;
    }
    if (this.isSessionLoadReserved(id)) {
      this.output.appendLine(`[sessions] refused delete of reserved session ${id}`);
      this.reportProtectedSession(origin, clientId, "delete");
      return;
    }
    const liveForCwd = [...this.pool].find((s) => s.activeSessionId === id);
    if (liveForCwd && this.sessionHasLiveOwner(liveForCwd)) {
      this.output.appendLine(`[sessions] refused delete of owned live session ${id}`);
      this.reportProtectedSession(origin, clientId, "delete");
      return;
    }
    // Last-resort cwd — and this one deletes files, so it resolves in the
    // ASKER's scope. A delete from VS Code must never fall back to a repo that
    // some remote client happens to have selected.
    const cwd =
      authorizedRemoteCwd ||
      liveForCwd?.cwd ||
      overridesNow[id]?.worktreePath ||
      this.sessionCache.get(id)?.entry.cwd ||
      this.historyCwdFor(origin);
    try {
      deleteSessionDir({
        fs: defaultFs,
        grokHome: resolveGrokHome(process.env),
        cwd,
        id,
      });
    } catch (e) {
      this.output.appendLine(`[sessions] delete failed for ${id}: ${(e as Error).message}`);
    }
    this.sessionCache.delete(id);
    this.removePlanReviews(id); // snapshots live outside grok's session dir
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    await this.removeUploadsForSessions([id], overrides);
    if (overrides[id]) {
      const next = { ...overrides };
      delete next[id];
      void this.context.globalState.update(SESSION_META_KEY, next);
    }
    // Tear down the live process if this session is in the pool (focused or
    // backgrounded), then re-home focus if we just killed the visible one.
    const live = [...this.pool].find((s) => s.activeSessionId === id);
    if (live) {
      const wasFocused = live === this.focused;
      this.disposeSession(live);
      if (wasFocused) {
        this.focused = this.newLocalSession();
        await this.startSession();
      }
    }
    this.postSessionsList();
  }

  /** Delete every inactive session in the requested repo's history. Every session
   *  currently owned by a remote tab or the local VS Code view is kept: deleting a
   *  watched session would strand that owner's rendered transcript over a blank
   *  replacement process. The webview confirms first (custom dialog). */
  private async clearAllSessions(
    requestedCwd: string,
    origin: MsgOrigin,
    clientId?: string,
  ): Promise<void> {
    const selectedCwd = origin === "remote" && clientId
      ? this.remoteClients.cwd(clientId)
      : requestedCwd;
    if (origin === "remote" && !pathsEqual(requestedCwd, selectedCwd)) {
      this.output.appendLine("[remote] dropped clearAllSessions (cwd does not match selected repo)");
      return;
    }
    const repo = this.repoCatalog().find((r) => pathsEqual(r.cwd, selectedCwd));
    if (!repo) return;
    const cwd = repo.cwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const repoCwds = this.sessionCwdsForRepo(cwd, overrides);
    const protectedIds = new Set(
      [...this.pool]
        .filter((session) => this.sessionHasLiveOwner(session))
        .map((session) => session.activeSessionId)
        .filter((id): id is string => !!id),
    );
    for (const id of this.reservedSessionIds()) protectedIds.add(id);
    const requester = sessionForRequest(
      origin,
      this.focused,
      origin === "remote" && clientId ? this.remoteClients.active(clientId) : undefined,
    );
    const requesterId = requester?.activeSessionId;
    // Count via the cheap stat-only index — no need to parse every summary just to confirm.
    const repoEntries = mergeSessionIndexes(repoCwds.map((sessionCwd) => ({
      cwd: sessionCwd,
      entries: indexSessions({ fs: defaultFs, grokHome, cwd: sessionCwd }),
    })));
    const keptForAnotherOwner = repoEntries.some(
      (entry) => protectedIds.has(entry.id) && entry.id !== requesterId,
    );
    const clearableCount = repoEntries.filter((entry) => !protectedIds.has(entry.id)).length;
    if (clearableCount === 0) {
      if (keptForAnotherOwner) this.reportProtectedSession(origin, clientId, "clear");
      else this.reportRequester(
        origin === "remote" && clientId ? this.captureRemoteRequester(clientId) : undefined,
        "info",
        "No history to clear.",
      );
      return;
    }
    // Confirm lives in the webview (custom dialog) — see deleteSession.

    const removedIds = new Set<string>();
    for (const sessionCwd of repoCwds) {
      try {
        for (const id of clearSessions({
          fs: defaultFs,
          grokHome,
          cwd: sessionCwd,
          exceptIds: protectedIds,
        })) removedIds.add(id);
      } catch (e) {
        this.output.appendLine(
          `[sessions] clear-all failed for ${sessionCwd}: ${(e as Error).message}`,
        );
      }
    }
    const removed = [...removedIds];

    // Purge our meta overrides + read cache for every removed id.
    if (removed.length) {
      await this.removeUploadsForSessions(removed, overrides);
      const next = { ...overrides };
      let changed = false;
      for (const id of removed) {
        this.sessionCache.delete(id);
        this.removePlanReviews(id);
        if (next[id]) {
          delete next[id];
          changed = true;
        }
      }
      if (changed) await this.context.globalState.update(SESSION_META_KEY, next);
    }

    // Tear down only ownerless live pool members whose history was deleted.
    const gone = new Set(removed);
    let removedFocused = false;
    for (const s of [...this.pool]) {
      if (s.activeSessionId && gone.has(s.activeSessionId)) {
        removedFocused ||= s === this.focused;
        this.disposeSession(s);
      }
    }
    if (removedFocused) {
      this.focused = this.newLocalSession();
      await this.startSession();
    }
    this.postSessionsList();
    if (keptForAnotherOwner) this.reportProtectedSession(origin, clientId, "clear");
  }

  private async pickFileFromComputer(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Add to chat",
    });
    if (!picked || picked.length === 0) return;
    for (const uri of picked) {
      try {
        await this.addDroppedFile(uri.fsPath, false);
      } catch (e) {
        // Per-file: one unreadable pick must not abort the rest of a multi-select.
        this.output.appendLine(`[image] could not attach ${uri.fsPath}: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(`Grok: could not attach ${path.basename(uri.fsPath)} — ${(e as Error).message}`);
      }
    }
    this.revealAndFocusComposer();
  }

  /** The `@` popover's file index, rebuilt at most once per
   *  {@link MENTION_INDEX_TTL_MS}. Keystrokes during a cold build all await the
   *  same findFiles pass instead of stacking one per key. Open editors that the
   *  findFiles cap missed are merged in on every read (not cached) so a newly
   *  opened tab is mentionable immediately, and closing it drops it again (#69). */
  private async mentionFileIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const base = await this.mentionFindFilesIndex();
    const merged = mergeMentionEntries(base.absByRel, this.openWorkspaceFileEntries());
    if (merged === base.absByRel) return base;
    return { rels: orderMentionIndex([...merged.keys()]), absByRel: merged };
  }

  /** TTL-cached `findFiles` snapshot only — no open-editor injection. */
  private async mentionFindFilesIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const cached = this.mentionIndex;
    if (cached && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached;
    if (!this.mentionIndexPromise) {
      this.mentionIndexPromise = this.buildMentionIndex()
        .then((idx) => {
          this.mentionIndex = { at: Date.now(), ...idx };
          return idx;
        })
        .finally(() => { this.mentionIndexPromise = null; });
    }
    return this.mentionIndexPromise;
  }

  private async buildMentionIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const cfg = vscode.workspace.getConfiguration();
    // findFiles' default excludes are files.exclude ONLY — node_modules lives in
    // search.exclude, so both must be merged in or the index is dependency soup.
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    // Cap is user-tunable (`grok.mentionIndexLimit`) — large monorepos that hit
    // the default 5000 can miss files from `@` autocomplete (#69).
    const limit = clampMentionIndexLimit(
      vscode.workspace.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await vscode.workspace.findFiles("**/*", exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      // Default asRelativePath prefixes the folder name only in a multi-root
      // workspace — exactly when the prefix is needed to disambiguate.
      const rel = normalizeRelPath(vscode.workspace.asRelativePath(uri));
      if (!absByRel.has(rel)) absByRel.set(rel, uri.fsPath);
    }
    return { rels: orderMentionIndex([...absByRel.keys()]), absByRel };
  }

  /** Currently open workspace text tabs as `{rel, abs}` for mention merge.
   *  Non-file schemes and paths outside the workspace are skipped. */
  private openWorkspaceFileEntries(): Array<{ rel: string; abs: string }> {
    const out: Array<{ rel: string; abs: string }> = [];
    const seen = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText)) continue;
        const uri = input.uri;
        if (uri.scheme !== "file") continue;
        if (!vscode.workspace.getWorkspaceFolder(uri)) continue;
        const abs = uri.fsPath;
        if (seen.has(abs)) continue;
        seen.add(abs);
        out.push({
          rel: normalizeRelPath(vscode.workspace.asRelativePath(uri)),
          abs,
        });
      }
    }
    return out;
  }

  /** Resolve the xAI key for Speech-to-Text: the `grok.voiceApiKey` setting,
   *  else `GROK_VOICE_API_KEY` / `XAI_API_KEY` from the workspace .env or the
   *  host environment, else the reusable token the CLI stored at `grok login`
   *  (`~/.grok/auth.json`) — so Voice works out of the box for a signed-in user,
   *  no separate console.x.ai key needed (#51). */
  private resolveVoiceApiKey(cwd: string): string | undefined {
    const setting = vscode.workspace.getConfiguration("grok").get<string>("voiceApiKey", "");
    const env = { ...process.env, ...this.readDotEnv(cwd) } as Record<string, string | undefined>;
    // Explicit config wins and short-circuits — only touch the credential file
    // when nothing explicit is set (least-privilege; the login token is a
    // last-resort fallback, #51).
    const explicit = resolveVoiceKey({ setting, env });
    if (explicit) return explicit;
    try {
      return extractGrokAuthKey(fs.readFileSync(path.join(resolveGrokHome(process.env), "auth.json"), "utf8"));
    } catch { /* not logged in / unreadable — no key available */ }
    return undefined;
  }

  /** Tell the webview whether a voice API key is resolvable, so the mic button
   *  can show a "needs setup" hint up front instead of only failing on click. */
  /** Chat-panel zoom factor (1.0 = 100%). Clamped to the declared 60–300% range. */
  private chatFontScale(): number {
    const pct = vscode.workspace.getConfiguration("grok").get<number>("chatFontScale", 100);
    const n = Number.isFinite(pct) ? (pct as number) : 100;
    return Math.min(300, Math.max(60, n)) / 100;
  }

  private postFontScale(): void {
    this.post({ type: "fontScale", value: this.chatFontScale() });
  }

  /** Command Palette: expand (open:true) / collapse (open:false) every tool group
   *  and command IN/OUT box in the focused session. Per-session, in-memory: it's
   *  `emit`ted (not `post`ed) so it lands in the session's replay buffer and a
   *  warm re-focus re-applies the latch; a cold reopen (no buffer) falls back to
   *  the persisted grok.expandCommandOutputs default. Never persisted to disk. */
  setAllToolDetails(open: boolean): void {
    this.emit(this.focused, { type: "setAllToolDetails", open });
  }

  /** grok.showThinking (#26) — whether grok's reasoning traces are shown. Off by
   *  default; hidden traces are replaced by a lightweight "Thinking…" indicator. */
  private showThinking(): boolean {
    return vscode.workspace.getConfiguration("grok").get<boolean>("showThinking", false);
  }

  private postShowThinking(): void {
    this.post({ type: "showThinking", value: this.showThinking() });
  }

  /**
   * MCP servers panel (CLI 0.2.113+). Prefer the live `_x.ai/mcp/list` catalog
   * (status + tools); fall back to `grok mcp list --json` for config-only rows
   * when the RPC is missing or the session isn't up yet. Merges both when both
   * succeed so CLI `scope` survives next to session status.
   */
  private async refreshMcpServers(
    session: Session,
    opts?: { quiet?: boolean },
  ): Promise<void> {
    const cwd = this.sessionCwd(session);
    const cliPath = this.cliPath || locateGrokCli(
      vscode.workspace.getConfiguration("grok").get<string>("cliPath", ""),
    );

    let sessionServers: McpServerView[] | undefined;
    let sessionUnsupported = false;
    if (session.client) {
      try {
        const listed = await session.client.listMcpServers();
        if (listed === "unsupported") sessionUnsupported = true;
        else sessionServers = listed.servers;
      } catch (e) {
        this.output.appendLine(`[mcp] list RPC failed: ${(e as Error).message}`);
      }
    }

    let cliServers: McpServerView[] | undefined;
    let cliFailed = false;
    if (cliPath) {
      try {
        const { stdout } = await execGrokCli(cliPath, ["mcp", "list", "--json"], {
          cwd,
          timeout: 15_000,
        });
        cliServers = parseMcpCliList(stdout).servers;
      } catch (e) {
        cliFailed = true;
        this.output.appendLine(`[mcp] grok mcp list --json failed: ${(e as Error).message}`);
      }
    } else {
      cliFailed = true;
    }

    let servers: McpServerView[] = [];
    let source: "session" | "cli" | "none" = "none";
    if (sessionServers && cliServers) {
      servers = mergeMcpServerLists(sessionServers, cliServers);
      source = "session";
    } else if (sessionServers) {
      servers = [...sessionServers].sort((a, b) => a.name.localeCompare(b.name));
      source = "session";
    } else if (cliServers) {
      servers = [...cliServers].sort((a, b) => a.name.localeCompare(b.name));
      source = "cli";
    }

    const unsupported = source === "none" && (sessionUnsupported || cliFailed);
    // Host-local (gear UI) — post, don't emit into the session replay buffer.
    this.post({
      type: "mcpServers",
      servers,
      unsupported: unsupported || undefined,
      source,
      warning: MCP_GLOBAL_SCOPE_WARNING,
    });
    if (!opts?.quiet && unsupported) {
      this.output.appendLine("[mcp] no MCP catalog available on this CLI/install");
    }
  }

  /**
   * Enable/disable via `grok mcp enable|disable <name>` — persists to the user
   * config (global side effect; the panel warning states that). No ACP RPC
   * exists for this (-32601). Re-lists afterward so the panel flips.
   */
  private async setMcpServerEnabled(
    session: Session,
    name: string,
    enabled: boolean,
  ): Promise<void> {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    const cliPath = this.cliPath || locateGrokCli(
      vscode.workspace.getConfiguration("grok").get<string>("cliPath", ""),
    );
    if (!cliPath) {
      this.post({
        type: "hostNotice",
        level: "warning",
        text: "Grok CLI not found — can't change MCP servers.",
      });
      return;
    }
    const cwd = this.sessionCwd(session);
    const action = enabled ? "enable" : "disable";
    try {
      const { stdout, stderr } = await execGrokCli(cliPath, ["mcp", action, trimmed], {
        cwd,
        timeout: 20_000,
      });
      const detail = (stdout || stderr || "").trim();
      this.output.appendLine(`[mcp] ${action} ${trimmed}${detail ? `: ${detail}` : ""}`);
      this.post({
        type: "hostNotice",
        level: "info",
        text: enabled
          ? `Enabled MCP server "${trimmed}" (global).`
          : `Disabled MCP server "${trimmed}" (global).`,
      });
    } catch (e: any) {
      const detail = String(e?.stderr || e?.stdout || e?.message || e).trim();
      this.output.appendLine(`[mcp] ${action} ${trimmed} failed: ${detail}`);
      this.post({
        type: "hostNotice",
        level: "warning",
        text: detail
          ? `Could not ${action} MCP server "${trimmed}": ${detail}`
          : `Could not ${action} MCP server "${trimmed}".`,
      });
    }
    await this.refreshMcpServers(session, { quiet: true });
  }

  /** Anonymous, per-install GUID — generated once and kept in globalState (so it
   *  survives extension updates). It's an opaque random id, not tied to any
   *  account or the grok login; it's sent only as an event property so distinct
   *  installs can be counted without identifying anyone. */
  private installId(): string {
    let id = this.context.globalState.get<string>(INSTALL_ID_KEY);
    if (!id) {
      id = randomUUID();
      void this.context.globalState.update(INSTALL_ID_KEY, id);
    }
    return id;
  }

  /** Fire the single `session_start` telemetry event for the first real user
   *  message of `session` (callers gate on isFirstSend, so empty sessions
   *  never reach here). Respects VS Code's global telemetry setting + our own
   *  `grok.telemetry.enabled`; fully fire-and-forget. */
  private reportSessionStart(session: Session, origin: MsgOrigin): void {
    // Telemetry must NEVER affect the user's turn. Build the event synchronously
    // (so it captures THIS session's mode/model/effort — focus could move during
    // the turn's awaits), then fire it asynchronously off the send path and
    // swallow any error silently. The PROD project always (dev host / local
    // installs included — only the probe script uses DEV).
    try {
      const enabled = shouldSendTelemetry(
        vscode.env.isTelemetryEnabled,
        vscode.workspace.getConfiguration("grok").get<boolean>("telemetry.enabled", true),
        this.context.extension.id === OFFICIAL_EXTENSION_ID,
      );
      if (!enabled) return;
      const cfg = vscode.workspace.getConfiguration("grok");
      const appVersion = (this.context.extension.packageJSON as { version?: string })?.version ?? "";
      const remoteClientId = origin === "remote"
        ? this.remoteClients.clientsForActiveValue(session)[0]
        : undefined;
      const remotePreferences = remoteClientId
        ? this.remoteClients.metadata(remoteClientId)
        : undefined;
      const event = buildSessionStartEvent(
        {
          installId: this.installId(),
          mode: this.displayMode(session),
          model: session.client?.currentModelId || cfg.get<string>("defaultModel", "") || "",
          effort: cfg.get<string>("defaultEffort", ""),
          // The three feature flags + the host app. Config values only — the same
          // class of anonymous property as mode/model/effort, never content.
          showThinking: cfg.get<boolean>("showThinking", false),
          expandToolDetails: cfg.get<boolean>("expandCommandOutputs", false),
          steerByDefault: cfg.get<boolean>("steerByDefault", false),
          chatFontScale: Math.round(this.chatFontScale() * 100),
          readRepliesAloud: cfg.get<boolean>("readRepliesAloud", false),
          soundNotifications: cfg.get<boolean>("soundNotifications", false),
          remoteFontScale: remotePreferences?.fontScale,
          remoteReadRepliesAloud: remotePreferences?.readRepliesAloud,
          ...sessionStartSurface(origin, remotePreferences?.usesTouch),
          host: vscode.env.appName || undefined,
        },
        {
          appVersion,
          osName: osNameFromPlatform(process.platform),
          osVersion: os.release(),
          locale: vscode.env.language || "",
          isDebug: this.context.extensionMode !== vscode.ExtensionMode.Production,
        },
        randomUUID(),
        new Date().toISOString(),
      );
      // Off the send path entirely; postEvent is itself non-blocking + self-guarding.
      setImmediate(() => postEvent(APTABASE_APP_KEY_PROD, event));
    } catch {
      // Silent — a telemetry failure must never surface to or affect the user.
    }
  }

  private postVoiceConfigured(): void {
    const cwd = this.sessionCwd(this.focused);
    this.postLocal({
      type: "voiceConfigured",
      value: !!this.resolveVoiceApiKey(cwd),
      sendPhrase: this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE),
    });
    for (const clientId of this.remoteClients.clients()) {
      const remoteCwd = this.sessionCwd(this.remoteSessionFor(clientId));
      this.sendRemoteClient(clientId, {
        type: "voiceConfigured",
        value: !!this.resolveVoiceApiKey(remoteCwd),
        sendPhrase: this.voiceSetting(remoteCwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE),
      });
    }
  }

  private voiceSetting<T>(cwd: string, key: string, fallback: T): T {
    const resource = vscode.Uri.file(cwd);
    const cfg = vscode.workspace.getConfiguration("grok", resource);
    return voiceSettingForRepo(
      cfg.get<T>(key),
      cfg.inspect<T>(key),
      !!vscode.workspace.getWorkspaceFolder(resource),
      fallback,
    );
  }

  private async mentionFileIndexForCwd(cwd: string): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    if (pathsEqual(cwd, this.workspaceRoot())) return this.mentionFileIndex();
    const key = normalizeRepoPath(cwd);
    const cached = this.remoteMentionIndexes.get(key);
    if (cached && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached;
    const cfg = vscode.workspace.getConfiguration();
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    const limit = clampMentionIndexLimit(
      vscode.workspace.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(cwd, "**/*"), exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      const rel = normalizeRelPath(path.relative(cwd, uri.fsPath));
      if (rel && !absByRel.has(rel)) absByRel.set(rel, uri.fsPath);
    }
    const value = { at: Date.now(), rels: orderMentionIndex([...absByRel.keys()]), absByRel };
    this.remoteMentionIndexes.set(key, value);
    return value;
  }

  /** Show actionable guidance for setting up the voice API key. */
  private async promptVoiceKeySetup(): Promise<void> {
    const pick = await vscode.window.showErrorMessage(
      "Voice control needs an xAI Speech-to-Text key. Sign in with `grok login` and it reuses that token automatically — or set grok.voiceApiKey, or GROK_VOICE_API_KEY / XAI_API_KEY in your workspace .env for a dedicated console.x.ai key.",
      "Open Settings",
      "Get a Key",
    );
    if (pick === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "grok.voiceApiKey");
    } else if (pick === "Get a Key") {
      await vscode.env.openExternal(vscode.Uri.parse("https://console.x.ai"));
    }
  }

  /** Begin recording the microphone (in the extension host — the webview can't
   *  reach the mic). The webview has already flipped its button to "listening";
   *  on any setup failure we send `voiceError` to reset it. */
  private rejectVoiceStart(clientId?: string): void {
    const message = clientId
      ? "Voice control is already active in this browser tab."
      : "Voice control is already active.";
    if (clientId) {
      this.sendRemoteClient(clientId, { type: "voiceError" });
      this.sendRemoteClient(clientId, { type: "error", text: message });
    } else {
      this.postLocal({ type: "voiceError" });
      void vscode.window.showWarningMessage(message);
    }
  }

  private claimVoice(cwd: string): boolean {
    if (this.localVoiceCwd) return false;
    this.localVoiceCwd = cwd;
    return true;
  }

  private releaseVoice(cwd?: string): void {
    if (!cwd || cwd === this.localVoiceCwd) this.localVoiceCwd = undefined;
  }

  private async handleVoiceStart(session: Session = this.focused): Promise<void> {
    const generation = ++this.voiceGeneration;
    const cwd = this.sessionCwd(session);
    const credentialCwd = this.sessionCwd(session);
    const key = this.resolveVoiceApiKey(credentialCwd);
    if (!key) {
      void this.promptVoiceKeySetup();
      this.postLocal({ type: "voiceError" });
      return;
    }
    if (!this.claimVoice(cwd)) {
      this.rejectVoiceStart();
      return;
    }
    this.localVoiceCredentialCwd = credentialCwd;
    const cfg = vscode.workspace.getConfiguration("grok");
    const ffmpegPath = cfg.get<string>("ffmpegPath", "") || "ffmpeg";
    const device = cfg.get<string>("voiceInputDevice", "") || undefined;

    // Streaming (default): live transcription over the STT WebSocket, so "grok
    // send" can submit hands-free without a stop-click. Batch is the fallback.
    if (cfg.get<boolean>("voiceStreaming", true)) {
      await this.startVoiceStream(key, ffmpegPath, device, cwd, generation);
      return;
    }

    const tmp = path.join(os.tmpdir(), `grok-voice-${Date.now()}.wav`);
    try {
      await this.voiceRecorder.start({ ffmpegPath, outputPath: tmp, device, log: (m) => this.output.appendLine(m) });
      if (generation !== this.voiceGeneration) {
        this.voiceRecorder.cancel();
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        return;
      }
      this.voiceTempPath = tmp;
      this.postLocal({ type: "voiceState", status: "listening" });
    } catch (e) {
      if (generation !== this.voiceGeneration) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        return;
      }
      const msg = (e as Error).message;
      this.output.appendLine(`[voice] start failed: ${msg}`);
      // ffmpeg-missing is the common, fixable case — offer a jump to its setting.
      if (/ffmpeg/i.test(msg)) {
        const pick = await vscode.window.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "grok.ffmpegPath");
        }
      } else {
        vscode.window.showErrorMessage(msg);
      }
      this.releaseVoice(cwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.postLocal({ type: "voiceError" });
    }
  }

  /** Begin a hands-free streaming session. Resolves the mic device once, then
   *  opens a stream; each "grok send" commits the message and restarts a fresh
   *  stream so the mic keeps listening with zero clicks. */
  private async startVoiceStream(
    key: string,
    ffmpegPath: string,
    device: string | undefined,
    cwd: string,
    generation: number,
  ): Promise<void> {
    const phrase = this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
    const keyterms = buildSttKeyterms(
      phrase,
      this.voiceSetting<string[]>(cwd, "voiceKeyterms", []),
    );
    const language = this.voiceSetting(cwd, "voiceLanguage", "").trim() || undefined;
    // Resolve the Windows mic once so per-message restarts don't re-enumerate.
    let resolved = device;
    if (process.platform === "win32" && !resolved) {
      try { resolved = await resolveWindowsAudioDevice(ffmpegPath, (m) => this.output.appendLine(m)); } catch { /* streamer surfaces it */ }
    }
    if (generation !== this.voiceGeneration) return;
    this.voiceStreamCtx = { key, ffmpegPath, device: resolved, phrase, keyterms, language, generation };
    this.voiceFinalizing = false;
    await this.openVoiceStream();
  }

  /** Open (or re-open after a "grok send") a streaming session from the stored
   *  context. Late events from a superseded streamer are ignored via identity. */
  private async openVoiceStream(): Promise<void> {
    const ctx = this.voiceStreamCtx;
    if (!ctx) return;
    // Re-resolve the credential on each (re)open so a "grok send" hands-free
    // reconnect picks up a token the CLI refreshed mid-session, rather than
    // reusing a possibly-stale cached one (Codex #7). Keep the old key if the
    // fresh read comes back empty — it'll 401 with the source-aware guidance.
    const cwd = this.localVoiceCredentialCwd ?? this.workspaceRoot();
    const fresh = this.resolveVoiceApiKey(cwd);
    if (fresh) ctx.key = fresh;
    const streamer = new VoiceStreamer();
    this.voiceStreamer = streamer;
    const isCurrent = () =>
      this.voiceStreamer === streamer && ctx.generation === this.voiceGeneration;

    streamer.on("partial", (ev: { text: string; speechFinal: boolean }) => {
      if (!isCurrent()) return;
      this.postLocal({ type: "voicePartial", text: ev.text });
      // A finished utterance ending in the send phrase → submit + keep listening.
      if (ev.speechFinal && ctx.phrase) {
        const parsed = parseVoiceCommand(ev.text, ctx.phrase);
        if (parsed.send) this.commitVoiceStream(parsed.text);
      }
    });
    streamer.on("ended", () => {
      // Stream ended on its own (long silence hit the ffmpeg cap, or a device
      // drop): finalize whatever we have and go idle. The user re-clicks to resume.
      if (isCurrent()) void this.finalizeVoiceStream();
    });
    streamer.on("error", (e: Error) => {
      if (!isCurrent()) return;
      streamer.cancel();
      this.output.appendLine(`[voice] stream error: ${e.message}`);
      if (!this.voiceFinalizing) {
        if (/\b(401|403)\b|rejected/i.test(e.message)) {
          void vscode.window.showErrorMessage(e.message, "Open Settings").then((pick) => {
            if (pick === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", "grok.voiceApiKey");
          });
        } else {
          vscode.window.showErrorMessage(`Voice transcription failed: ${e.message}`);
        }
        this.postLocal({ type: "voiceError" });
      }
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
    });

    try {
      await streamer.start({
        ffmpegPath: ctx.ffmpegPath,
        apiKey: ctx.key,
        device: ctx.device,
        keyterms: ctx.keyterms,
        language: ctx.language,
        log: (m) => this.output.appendLine(m),
      });
      if (!isCurrent()) { streamer.cancel(); return; }
      this.postLocal({ type: "voiceState", status: "listening" });
    } catch (e) {
      if (!isCurrent()) return;
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
      const msg = (e as Error).message;
      this.output.appendLine(`[voice] stream start failed: ${msg}`);
      if (/ffmpeg/i.test(msg)) {
        const pick = await vscode.window.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "grok.ffmpegPath");
        }
      } else if (/\b(401|403)\b|rejected/i.test(msg)) {
        // Auth handshake rejection — msg is already the source-aware guidance
        // (re-login or set a dedicated key); offer the settings shortcut.
        const pick = await vscode.window.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "grok.voiceApiKey");
        }
      } else {
        vscode.window.showErrorMessage(msg);
      }
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.postLocal({ type: "voiceError" });
    }
  }

  /** "grok send": submit the message and KEEP listening by restarting a fresh
   *  stream (each message = one clean utterance). No clicks needed. */
  private commitVoiceStream(text: string): void {
    const ctx = this.voiceStreamCtx;
    if (!ctx || ctx.generation !== this.voiceGeneration) return;
    const old = this.voiceStreamer;
    this.voiceStreamer = undefined; // detach so late events are ignored
    old?.cancel();
    this.postLocal({ type: "voiceSubmit", text: text.trim() });
    void this.openVoiceStream(); // reuses cached device → fast restart
  }

  /** Stop streaming entirely (manual click, or a self-ended stream): finalize the
   *  remaining transcript and return to idle. */
  private async finalizeVoiceStream(): Promise<void> {
    if (this.voiceFinalizing) return;
    const generation = this.voiceGeneration;
    this.voiceFinalizing = true;
    const streamer = this.voiceStreamer;
    this.voiceStreamer = undefined;
    this.voiceStreamCtx = undefined;
    if (!streamer) { this.voiceFinalizing = false; return; }
    this.postLocal({ type: "voiceState", status: "transcribing" });
    let finalText = "";
    try { finalText = await streamer.stop(); } catch { finalText = streamer.transcript; }
    if (generation !== this.voiceGeneration) {
      this.voiceFinalizing = false;
      return;
    }
    const cwd = this.localVoiceCredentialCwd ?? this.workspaceRoot();
    const phrase = this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
    const { text, send } = parseVoiceCommand(finalText, phrase);
    this.voiceFinalizing = false;
    this.releaseVoice(this.localVoiceCwd);
    this.localVoiceCwd = undefined;
    this.localVoiceCredentialCwd = undefined;
    if (!text && !send) {
      this.postLocal({ type: "voiceError" });
      return;
    }
    this.postLocal({ type: "voiceTranscript", text, send });
  }

  /** Hard-stop any voice capture (no transcript) and reset the mic to idle.
   *  Called on session switch/restart so listening never bleeds across sessions. */
  private stopVoiceInput(session?: Session): void {
    if (!session || session === this.focused) {
      const wasActive =
        !!this.voiceStreamer ||
        !!this.voiceStreamCtx ||
        this.voiceRecorder.active ||
        this.voiceFinalizing ||
        !!this.voiceTempPath;
      this.voiceGeneration += 1;
      this.voiceStreamer?.cancel();
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
      this.voiceFinalizing = false;
      this.voiceRecorder.cancel();
      try { if (this.voiceTempPath) fs.unlinkSync(this.voiceTempPath); } catch { /* best effort */ }
      this.voiceTempPath = undefined;
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      if (wasActive) this.postLocal({ type: "voiceState", status: "idle" });
    }
    for (const [clientId, remote] of [...this.remoteVoice]) {
      if (session && remote.session !== session) continue;
      remote.ingress.close();
      remote.streamer.cancel();
      this.remoteVoice.delete(clientId);
      this.sendRemoteClient(clientId, { type: "voiceState", status: "idle" });
    }
  }

  /** Stop recording, transcribe via xAI STT, and send the text to the composer. */
  private async handleVoiceStop(): Promise<void> {
    const generation = this.voiceGeneration;
    // Streaming path: finalize the live stream.
    if (this.voiceStreamer) {
      await this.finalizeVoiceStream();
      return;
    }
    if (!this.voiceRecorder.active) {
      this.postLocal({ type: "voiceError" });
      return;
    }
    const cwd = this.localVoiceCredentialCwd ?? this.workspaceRoot();
    const key = this.resolveVoiceApiKey(cwd);
    if (!key) {
      this.voiceRecorder.cancel();
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.postLocal({ type: "voiceError" });
      return;
    }
    let wavPath: string;
    try {
      wavPath = await this.voiceRecorder.stop();
      if (generation !== this.voiceGeneration) {
        try { fs.unlinkSync(wavPath); } catch { /* best effort */ }
        return;
      }
    } catch (e) {
      if (generation !== this.voiceGeneration) return;
      this.output.appendLine(`[voice] stop failed: ${(e as Error).message}`);
      vscode.window.showErrorMessage(`Voice recording failed: ${(e as Error).message}`);
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.postLocal({ type: "voiceError" });
      return;
    }
    const tempPath = this.voiceTempPath;
    this.postLocal({ type: "voiceState", status: "transcribing" });
    try {
      const raw = await transcribeAudio(wavPath, key, (m) => this.output.appendLine(m));
      if (generation !== this.voiceGeneration) return;
      // Strip a trailing "grok send" (configurable) so dictation can submit
      // hands-free. The webview inserts `text` and, if `send`, fires the send.
      const sendPhrase = this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
      const { text, send } = parseVoiceCommand(raw, sendPhrase);
      if (!text && !send) {
        vscode.window.showInformationMessage("Voice control: nothing was transcribed (silence?).");
        this.postLocal({ type: "voiceError" });
        return;
      }
      this.postLocal({ type: "voiceTranscript", text, send });
    } catch (e) {
      if (generation !== this.voiceGeneration) return;
      this.output.appendLine(`[voice] transcription failed: ${(e as Error).message}`);
      vscode.window.showErrorMessage((e as Error).message);
      this.postLocal({ type: "voiceError" });
    } finally {
      try { if (tempPath) fs.unlinkSync(tempPath); } catch { /* best effort */ }
      if (this.voiceTempPath === tempPath) this.voiceTempPath = undefined;
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
    }
  }

  private async startRemotePcm(
    clientId: string,
    entry: RemoteVoiceEntry,
  ): Promise<void> {
    const key = this.resolveVoiceApiKey(entry.credentialCwd);
    if (!key) throw new Error("Voice control needs an xAI Speech-to-Text key on the host.");
    const streamer = new PcmVoiceStreamer();
    entry.streamer = streamer;
    const current = () => this.remoteVoice.get(clientId) === entry && entry.streamer === streamer;
    streamer.on("partial", (ev: { text: string; speechFinal: boolean }) => {
      if (!current()) return;
      this.sendRemoteClient(clientId, { type: "voicePartial", text: ev.text });
      if (ev.speechFinal && entry.phrase) {
        const parsed = parseVoiceCommand(ev.text, entry.phrase);
        if (parsed.send) void this.commitRemoteVoice(clientId, parsed.text);
      }
    });
    streamer.on("ended", () => {
      if (current()) void this.handleRemoteVoiceStop(clientId, false);
    });
    streamer.on("error", (e: Error) => {
      if (!current() || entry.finalizing) return;
      this.output.appendLine(`[remote-voice] stream error: ${e.message}`);
      this.failRemoteVoice(clientId, e.message);
    });
    await streamer.start({
      apiKey: key,
      keyterms: entry.keyterms,
      language: entry.language,
      log: (m) => this.output.appendLine(`[remote] ${m}`),
    });
    if (!current()) {
      streamer.cancel();
      return;
    }
    const pending = entry.ingress.ready();
    for (const bytes of pending) {
      if (!streamer.writePcm(bytes)) {
        this.failRemoteVoice(clientId, "The Speech-to-Text stream did not accept buffered microphone audio.");
        return;
      }
    }
    this.sendRemoteClient(clientId, { type: "voiceState", status: "listening" });
  }

  private async handleRemoteVoiceStart(clientId: string, session: Session): Promise<void> {
    const credentialCwd = this.sessionCwd(session);
    if (!this.resolveVoiceApiKey(credentialCwd)) {
      this.sendRemoteClient(clientId, { type: "voiceConfigured", value: false });
      this.sendRemoteClient(clientId, { type: "voiceError" });
      this.sendRemoteClient(clientId, { type: "error", text: "Voice control needs an xAI Speech-to-Text key on the host." });
      return;
    }
    if (this.remoteVoice.has(clientId)) {
      this.rejectVoiceStart(clientId);
      return;
    }
    const phrase = this.voiceSetting(credentialCwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
    const keyterms = buildSttKeyterms(
      phrase,
      this.voiceSetting<string[]>(credentialCwd, "voiceKeyterms", []),
    );
    const language = this.voiceSetting(credentialCwd, "voiceLanguage", "").trim() || undefined;
    let entry!: RemoteVoiceEntry;
    const ingress = new RemotePcmIngress(
      GrokSidebar.MAX_REMOTE_PCM_CHUNK_BYTES,
      GrokSidebar.MAX_REMOTE_PCM_BYTES,
      MAX_RECORDING_SECONDS * 1000,
      () => { void this.handleRemoteVoiceStop(clientId, false); },
    );
    entry = {
      credentialCwd,
      session,
      streamer: new PcmVoiceStreamer(),
      ingress,
      phrase,
      keyterms,
      language,
      finalizing: false,
    };
    this.remoteVoice.set(clientId, entry);
    try {
      await this.startRemotePcm(clientId, entry);
    } catch (e) {
      if (this.remoteVoice.get(clientId) !== entry) return;
      this.failRemoteVoice(clientId, (e as Error).message);
    }
  }

  private handleRemoteVoiceChunk(clientId: string, data: string): void {
    const entry = this.remoteVoice.get(clientId);
    if (entry?.finalizing) return;
    const accepted = acceptRemotePcm(entry?.ingress, data);
    switch (accepted.kind) {
      case "unowned":
        this.sendRemoteClient(clientId, { type: "voiceError" });
        return;
      case "invalid":
        this.failRemoteVoice(clientId, "The browser sent an invalid microphone audio chunk.");
        return;
      case "limit":
        void this.handleRemoteVoiceStop(clientId, false);
        return;
      case "buffered":
        return;
      case "write":
        if (!entry!.streamer.writePcm(accepted.bytes)) {
          this.failRemoteVoice(clientId, "The Speech-to-Text stream is not ready for microphone audio.");
        }
    }
  }

  private async commitRemoteVoice(clientId: string, text: string): Promise<void> {
    const entry = this.remoteVoice.get(clientId);
    if (!entry || entry.finalizing) return;
    if (!entry.ingress.restarting()) return;
    const old = entry.streamer;
    old.cancel();
    this.sendRemoteClient(clientId, { type: "voiceSubmit", text: text.trim() });
    try {
      await this.startRemotePcm(clientId, entry);
    } catch (e) {
      if (this.remoteVoice.get(clientId) !== entry) return;
      this.failRemoteVoice(clientId, (e as Error).message);
    }
  }

  private async handleRemoteVoiceStop(clientId: string, cancel: boolean): Promise<void> {
    const entry = this.remoteVoice.get(clientId);
    // A cancelled stream can still emit an ended/error callback while its stop
    // promise is settling. Its entry identity is the generation guard; do not
    // turn that late completion into a new client-visible event.
    if (!entry || entry.finalizing) return;
    entry.finalizing = true;
    entry.ingress.close();
    this.sendRemoteClient(clientId, { type: "voiceState", status: cancel ? "idle" : "transcribing" });
    let transcript = "";
    if (cancel) entry.streamer.cancel();
    else {
      try { transcript = await entry.streamer.stop(); } catch { transcript = entry.streamer.transcript; }
    }
    if (this.remoteVoice.get(clientId) !== entry) return;
    this.remoteVoice.delete(clientId);
    if (cancel) return;
    const { text, send } = parseVoiceCommand(transcript, entry.phrase);
    if (!text && !send) {
      this.sendRemoteClient(clientId, { type: "voiceError" });
      return;
    }
    if (send) {
      this.sendRemoteClient(clientId, { type: "voiceSubmit", text: text.trim() });
      this.sendRemoteClient(clientId, { type: "voiceState", status: "idle" });
    } else {
      this.sendRemoteClient(clientId, { type: "voiceTranscript", text, send: false });
    }
  }

  private dropRemoteVoice(clientId: string): void {
    const entry = this.remoteVoice.get(clientId);
    if (!entry) return;
    entry.ingress.close();
    entry.streamer.cancel();
    this.remoteVoice.delete(clientId);
    this.sendRemoteClient(clientId, { type: "voiceState", status: "idle" });
  }

  private failRemoteVoice(clientId: string, detail: string): void {
    const entry = this.remoteVoice.get(clientId);
    if (entry) {
      entry.ingress.close();
      entry.streamer.cancel();
      this.remoteVoice.delete(clientId);
      this.sendRemoteClient(clientId, { type: "voiceError" });
    } else {
      this.sendRemoteClient(clientId, { type: "voiceError" });
    }
    this.sendRemoteClient(clientId, { type: "error", text: `Voice transcription failed: ${detail}` });
  }

  private async openDiffEditor(
    session: Session,
    filePath: string,
    oldText: string,
    newText: string,
    requestId?: number | string,
    replaceAll?: boolean,
    sites?: { oldText: string; newText: string; oldLine?: number; newLine?: number }[],
  ): Promise<void> {
    const base = path.basename(filePath);
    // grok's diff block carries only the replaced region, which opens as a
    // context-free two-line tab. Expand it against the file on disk so the tab
    // shows the whole file and lands on the change (#66); a pending permission
    // hasn't been written yet, so there the file on disk is the "before".
    const sides = expandDiffToWholeFile({
      diskText: this.readFileForDiff(filePath),
      oldRegion: oldText,
      newRegion: newText,
      diskIsBefore: requestId !== undefined,
      replaceAll,
      sites,
    });
    // Unique key per diff so sequential edits to the same file don't collide on
    // the content map. The trailing real filename gives VS Code the language.
    const key = String(this.diffSeq++);
    const left = vscode.Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/before/${base}` });
    const right = vscode.Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/after/${base}` });
    this.diffProvider.set(left, sides.oldText);
    this.diffProvider.set(right, sides.newText);
    if (requestId !== undefined) {
      // Auto-open is per pending permission; remember the URIs so the matching
      // tab can be closed (and its content dropped) once the user decides (#21).
      const stale = this.openDiffsByRequest.set(session, requestId, { left, right });
      if (stale) this.closeDiffUris(stale);
    }
    // preview:true reuses a single preview tab across grok's many small sequential
    // edits; preserveFocus:true keeps focus on the chat so the permission card is
    // immediately clickable. `selection` opens a whole-file diff on the edit
    // instead of at line 1 (#66) — harmless at 0 when expansion fell back.
    const at = sides.firstChangedLine;
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `Grok proposed: ${base}`,
      {
        preview: true,
        preserveFocus: true,
        selection: new vscode.Range(at, 0, at, 0),
      } as vscode.TextDocumentShowOptions,
    );
  }

  /**
   * The file's current content, for whole-file diff expansion (#66). Undefined
   * when it can't be read — a create whose file doesn't exist yet, a file
   * deleted since, or one too big to hold twice — which leaves the diff at the
   * region-only fallback rather than failing the open.
   */
  private readFileForDiff(filePath: string): string | undefined {
    try {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(this.sessionCwd(), filePath);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_DIFF_EXPAND_BYTES) return undefined;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }

  /** Close the diff tab opened for a pending permission request and free its
   *  virtual content (issue #21). No-op if the user already closed it. */
  private closeDiffForRequest(session: Session, requestId: number | string): void {
    const uris = this.openDiffsByRequest.take(session, requestId);
    if (!uris) return;
    this.closeDiffUris(uris);
  }

  private closeDiffUris(uris: { left: vscode.Uri; right: vscode.Uri }): void {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.original.toString() === uris.left.toString() &&
          input.modified.toString() === uris.right.toString()
        ) {
          void vscode.window.tabGroups.close(tab);
        }
      }
    }
    this.diffProvider.delete(uris.left, uris.right);
  }

  private async postExitPlanRequest(req: ExitPlanRequest, session: Session, gen: number): Promise<void> {
    const plan = req.plan || session.lastPlanText;
    let snapshot: { path: string; name: string } | undefined;
    try {
      snapshot = await this.createPlanReviewSnapshot(plan);
    } catch (e) {
      this.output.appendLine(`[plan-review] ${(e as Error).message}`);
    }
    if (gen !== session.gen) return;
    // Host ownership begins only after the snapshot's generation check. Re-focus
    // can replay the card without consuming this pending request.
    session.pendingExitPlans.set(req.id, { planText: plan });
    session.lastPlanText = "";
    this.emit(session, {
      type: "exitPlanRequest",
      req: { ...req, plan, planPath: snapshot?.path, planName: snapshot?.name },
    });
    this.setStatus(session, "needs-you");
  }

  private async withPlanReviewPaths<T extends { text: string }>(
    plans: T[],
    sessionId?: string,
  ): Promise<Array<T & { planPath?: string; planName?: string }>> {
    const out: Array<T & { planPath?: string; planName?: string }> = [];
    for (const plan of plans) {
      try {
        const snapshot = await this.createPlanReviewSnapshot(plan.text, sessionId);
        out.push({ ...plan, planPath: snapshot.path, planName: snapshot.name });
      } catch (e) {
        this.output.appendLine(`[plan-review] ${(e as Error).message}`);
        out.push(plan);
      }
    }
    return out;
  }

  /** Delete a session's plan-review snapshots. They live under globalStorage,
   *  outside grok's session dir, so `deleteSessionDir` never touched them and
   *  every deleted session left its plan Markdown behind forever. Best-effort:
   *  losing a scratch snapshot is never worth failing a delete over. */
  private removePlanReviews(sessionId: string): void {
    const dir = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      "plan-reviews",
      sanitizePlanReviewFilePart(sessionId).slice(0, 80),
    );
    void vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }).then(
      undefined,
      () => { /* never existed, or already gone */ },
    );
  }

  /**
   * Apply a completed rewind to the live view WITHOUT reloading the session.
   *
   * The CLI has already truncated its own history, and the surviving messages
   * are still correct on screen — so there is nothing to rebuild. The old path
   * (`clearMessages` + `startSession`) blanked the panel to the welcome logo and
   * re-rendered the entire conversation for what is a tail deletion.
   *
   * The replay buffer is cut to the same point, or a focus-swap would rebuild
   * the chat from the pre-rewind history and resurrect every discarded turn.
   */
  private applyRewindToView(session: Session, surviving: number): void {
    session.buffer = truncateReplayBuffer(session.buffer, surviving);
    session.userMessageCount = surviving;
    session.historyEventCount = historyEventCount(session.buffer);
    // Positions for anything persisted after this point are counted against the
    // same number the webview now holds.
    this.emit(session, { type: "truncateMessages", surviving });
  }

  /**
   * Confirm via the webview's own in-chat dialog instead of a native modal.
   *
   * Every other destructive confirm moved in-chat in 2.0.0 so it behaves the
   * same in the sidebar and the AFK Pilot browser client; rewind/edit were left
   * on `showWarningMessage`. They can't simply call `uiConfirm` themselves,
   * because only the HOST knows whether files are at stake — hence the
   * round-trip.
   *
   * Resolves false if the webview goes away before answering (reload, session
   * teardown): a lost confirm must fail closed, never silently revert files.
   */
  private confirmInChat(
    session: Session,
    opts: { title: string; body?: string; confirmLabel: string; danger?: boolean },
  ): Promise<boolean> {
    const id = `confirm-${++this.confirmSeq}`;
    return new Promise<boolean>((resolve) => {
      this.pendingConfirms.set(id, resolve);
      this.emit(session, { type: "uiConfirmRequest", id, ...opts });
    });
  }

  private async createPlanReviewSnapshot(plan: string, sessionId?: string): Promise<{ path: string; name: string }> {
    const content = plan && plan.trim() ? plan : "(empty plan)\n";
    const sessionPart = sanitizePlanReviewFilePart(
      sessionId ?? this.focused.activeSessionId ?? this.focused.client?.sessionId ?? "session",
    ).slice(0, 80);
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, "plan-reviews", sessionPart);
    await vscode.workspace.fs.createDirectory(dir);
    // Content-addressed, so re-snapshotting the same plan on every restore
    // reuses one file instead of writing a new one forever.
    const uri = vscode.Uri.joinPath(dir, planReviewFileName(content));
    let existing: string | undefined;
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch { /* first time for this plan */ }
    if (existing !== content) {
      // Different content under the same name means a hash collision — fall back
      // to a unique name rather than overwriting someone else's plan.
      const target = existing === undefined ? uri : await this.uniquePlanReviewUri(dir, planReviewFileName(content));
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      return { path: target.fsPath, name: path.basename(target.fsPath) };
    }
    return { path: uri.fsPath, name: path.basename(uri.fsPath) };
  }

  private async uniquePlanReviewUri(dir: vscode.Uri, fileName: string): Promise<vscode.Uri> {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    for (let i = 0; i < 100; i += 1) {
      const suffix = i === 0 ? "" : `-${i + 1}`;
      const uri = vscode.Uri.joinPath(dir, `${stem}${suffix}${ext}`);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        return uri;
      }
    }
    return vscode.Uri.joinPath(dir, `${stem}-${Date.now()}${ext}`);
  }

  /** Track an in-flight attachment-staging op (paste / drop / pick). Message
   *  ordering only guarantees an op posted before send has STARTED handling —
   *  its fs awaits can still be mid-flight when handleSend runs (VS Code does
   *  not serialize async onDidReceiveMessage handlers), so handleSend settles
   *  this set before snapshotting chips: the chip must make THIS send, not the
   *  next one. */
  private trackAttach(op: Promise<unknown>): Promise<void> {
    const tracked = op.then(() => undefined);
    this.pendingAttach.add(tracked);
    const done = () => { this.pendingAttach.delete(tracked); };
    void tracked.then(done, done);
    return tracked;
  }

  /** Resolve attachment ownership at commit time. Session transitions can
   * replace the active session while staging is awaiting the filesystem; a
   * captured Session would then deliver the chip to the conversation the tab
   * has already left.
   *
   * Returns undefined when the asking tab is gone, and callers MUST drop the
   * attachment rather than pick somewhere for it. Falling back to `this.focused`
   * looks harmless and is not: a phone that uploads and then reconnects gets a
   * new relay id, so the staging that was still awaiting resolves to no client
   * and the image lands in whatever conversation the DESK happens to be showing.
   * That is content crossing conversations, which is worse than losing it.
   *
   * The ephemeral relay id is resolved through `currentClient`, which follows
   * the tab across a reconnect via its stable token — so the ordinary
   * refresh-mid-upload keeps working and only a genuinely departed tab drops. */
  private attachmentOwner(origin: MsgOrigin, clientId?: string): Session | undefined {
    if (origin !== "remote") return this.focused;
    const current = clientId ? this.remoteClients.currentClient(clientId) : undefined;
    return current ? this.remoteClients.active(current) : undefined;
  }

  /**
   * Session-NEUTRAL staging dir for images waiting in the composer. Deliberately
   * NOT the grok session dir: composer chips are provider-level state that
   * outlives sessions, while a session dir is deleted by the empty-session
   * cleanup (parkFocused / discardRestartedEmptySession / history delete), which
   * would kill a pasted screenshot before it was ever sent. Staging also works
   * with no live session at all (paste during startup/onboarding just works).
   */
  private imageStagingDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "image-staging");
  }

  private fileStagingDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "file-staging");
  }

  /** Delete staged images older than 7 days. A pending attachment lives for
   *  minutes; anything week-old is an orphan (pasted, never sent, window
   *  closed). The age gate keeps a second VS Code window's fresh staging
   *  files safe — globalStorage is shared across windows. */
  private async sweepImageStaging(): Promise<void> {
    const dir = this.imageStagingDir();
    try {
      const cutoff = Date.now() - GrokSidebar.STAGING_ORPHAN_TTL_MS;
      for (const name of await fs.promises.readdir(dir)) {
        const p = path.join(dir, name);
        try {
          if ((await fs.promises.stat(p)).mtimeMs < cutoff) await fs.promises.unlink(p);
        } catch { /* raced or locked — next sweep gets it */ }
      }
    } catch { /* staging dir doesn't exist yet */ }
  }

  /** Keep sent documents for their session's lifetime; only abandoned staging
   * directories use the seven-day orphan policy shared with images. */
  private async sweepFileStaging(): Promise<void> {
    const root = this.fileStagingDir();
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const retained = retainedUploadDirectories(root, overrides);
    try {
      const cutoff = Date.now() - GrokSidebar.STAGING_ORPHAN_TTL_MS;
      for (const name of await fs.promises.readdir(root)) {
        const dir = path.join(root, name);
        // Reuse the owned-path validator with a synthetic leaf: unknown entries
        // in globalStorage are not ours to remove.
        const owned = stagedUploadDirectory(root, path.join(dir, "_"));
        if (!owned) continue;
        const key = process.platform === "win32" ? path.resolve(owned).toLowerCase() : path.resolve(owned);
        if (retained.has(key)) continue;
        try {
          if ((await fs.promises.stat(owned)).mtimeMs < cutoff) {
            await fs.promises.rm(owned, { recursive: true, force: true });
          }
        } catch { /* raced or locked — next activation gets it */ }
      }
    } catch { /* staging dir doesn't exist yet */ }
  }

  /** Validate and stage one remote browser document, then mint the exact same
   * explicit path chip as a local drag-and-drop. */
  private async addUploadedFile(
    suppliedName: string,
    data: string,
    owner: AttachmentOwner = () => this.focused,
    requester?: RemoteRequester,
  ): Promise<void> {
    const prepared = prepareFileUpload(suppliedName, data, MAX_VISION_IMAGE_BYTES);
    if (!prepared.ok) {
      const detail = prepared.reason === "unsupported-extension"
        ? "supported types are .md, .txt, .pdf, .csv, .xlsx, and .docx"
        : prepared.reason === "too-large"
          ? "the file exceeds the 20 MiB attachment limit"
          : prepared.reason === "empty"
            ? "the file is empty"
            : "the file data is invalid";
      this.output.appendLine(`[upload] rejected ${suppliedName}: ${detail}`);
      this.reportRequester(requester, "error", `Could not attach document — ${detail}.`);
      return;
    }

    const dir = path.join(this.fileStagingDir(), randomUUID());
    const absPath = path.join(dir, prepared.name);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(absPath, prepared.bytes, { flag: "wx" });
      const session = await this.addDroppedFile(absPath, false, owner);
      if (session === this.focused) this.revealAndFocusComposer();
    } catch (e) {
      void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.output.appendLine(`[upload] staging failed for ${prepared.name}: ${(e as Error).message}`);
      this.reportRequester(requester, "error", `Could not attach document — ${(e as Error).message}`);
    }
  }

  private async retainUploadedFilesForSession(session: Session, chips: FileChip[]): Promise<void> {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const uploaded = chips
      .filter((chip) => !chip.hidden && !!stagedUploadDirectory(this.fileStagingDir(), chip.path))
      .map((chip) => chip.path);
    if (!uploaded.length) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const files = [...new Set([...(cur.uploadedFiles ?? []), ...uploaded])];
    await this.context.globalState.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...cur, uploadedFiles: files },
    });
  }

  /** Remove UUID upload directories owned only by the sessions being deleted.
   * Shared source/fork references keep the file alive. */
  private async removeUploadsForSessions(
    ids: Iterable<string>,
    overrides: SessionMetaOverrides,
  ): Promise<void> {
    const files = unreferencedUploadsForRemovedSessions(overrides, ids);
    const dirs = new Set(
      files
        .map((file) => stagedUploadDirectory(this.fileStagingDir(), file))
        .filter((dir): dir is string => !!dir),
    );
    for (const dir of dirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (e) {
        this.output.appendLine(`[upload] could not remove staged document directory: ${(e as Error).message}`);
      }
    }
  }

  /** Write image bytes into staging and attach the chip. The `[Image #N]`
   *  index is session-scoped (Session.imageCounter) so tags stay unique across
   *  the whole conversation, not just one composer batch. */
  private async stageImageAttachment(
    bytes: Buffer,
    mimeType: string,
    originPath?: string,
    owner: AttachmentOwner = () => this.focused,
    previewId?: string,
  ): Promise<Session | undefined> {
    const dir = this.imageStagingDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `image-${randomUUID()}${extFromMime(mimeType)}`);
    await fs.promises.writeFile(absPath, bytes);
    const session = owner();
    if (!session) {
      // The asking tab left while this was writing. Delivering it anywhere else
      // would put its image in someone else's conversation; the staged copy is
      // left for the seven-day sweep rather than deleted, in case the write
      // raced a reconnect that is about to come back.
      return undefined;
    }
    const rel = originPath
      ? normalizeRelPath(path.relative(this.sessionCwd(session), originPath))
      : undefined;
    // asRelativePath returns the input unchanged for files outside the
    // workspace — only carry the origin when it's a real workspace-relative path.
    const originRelPath = rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)
      ? rel
      : undefined;
    const imageIndex = ++session.imageCounter;
    session.chips.push(makeImageChip(absPath, imageIndex, mimeType, originRelPath, previewId));
    this.postChips(session);
    return session;
  }

  /** Clipboard paste from the webview (base64 + mime, already prefiltered to
   *  raster image types there — re-checked here since the webview isn't a
   *  trust boundary). */
  private async addPastedImage(
    base64: string,
    mimeType: string,
    owner: AttachmentOwner = () => this.focused,
    requester?: RemoteRequester,
    previewId?: string,
  ): Promise<void> {
    try {
      if (!isVisionMime(mimeType)) {
        this.reportRequester(requester, "error", `Grok: unsupported image type ${mimeType} — use PNG, JPEG, GIF, or WebP.`);
        return;
      }
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) return;
      if (bytes.length > MAX_VISION_IMAGE_BYTES) {
        this.reportRequester(requester, "error", "Grok: pasted image exceeds the 20 MiB vision limit.");
        return;
      }
      const session = await this.stageImageAttachment(bytes, mimeType, undefined, owner, previewId);
      if (session === this.focused) this.revealAndFocusComposer();
    } catch (e) {
      this.output.appendLine(`[image] paste failed: ${(e as Error).message}`);
      this.reportRequester(requester, "error", `Grok: could not attach the pasted image — ${(e as Error).message}`);
    }
  }

  /** Copy an on-disk raster image into staging as a vision attachment, keeping
   *  the workspace-relative origin so the prompt tag can carry the real file
   *  identity. Three outcomes, and they are not interchangeable: the owning
   *  session when it attached, `false` when the file should stay a plain path
   *  chip (oversized, or unreadable as a regular file), and `undefined` when the
   *  asking tab left — which must drop the attachment rather than degrade it to
   *  a path chip in someone else's conversation. */
  private async importImageFromDisk(
    srcPath: string,
    owner: AttachmentOwner = () => this.focused,
  ): Promise<Session | false | undefined> {
    const stat = await fs.promises.stat(srcPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_VISION_IMAGE_BYTES) return false;
    const bytes = await fs.promises.readFile(srcPath);
    return this.stageImageAttachment(bytes, mimeFromPath(srcPath), srcPath, owner);
  }

  private async addDroppedFile(
    dropped: string,
    shiftHeld: boolean,
    owner: AttachmentOwner = () => this.focused,
  ): Promise<Session | undefined> {
    // The webview posts the raw file:// URI (it has no path library); accept a
    // plain path too so older webview builds degrade instead of breaking.
    let absPath = dropped;
    if (/^file:\/\//i.test(dropped)) {
      try {
        absPath = fileUriToPath(dropped);
      } catch {
        return;
      }
    }
    if (!fs.existsSync(absPath)) return;
    if (!shiftHeld && isVisionImagePath(absPath)) {
      try {
        const imported = await this.importImageFromDisk(absPath, owner);
        if (imported === undefined) return undefined; // tab gone — not a path chip either
        if (imported) return imported;
      } catch (e) {
        this.output.appendLine(`[image] import failed for ${absPath}: ${(e as Error).message}`);
      }
      // Oversized / unreadable-as-image → fall through to a plain path chip,
      // the pre-vision behavior (grok decides how to consume the path).
    }
    const session = owner();
    if (!session) return undefined; // asking tab gone — drop, never redirect
    const relPath = normalizeRelPath(path.relative(this.sessionCwd(session), absPath));
    if (shiftHeld) {
      // Only read the whole file (to count lines for an inline selection) when
      // it's small enough not to freeze the host thread. Large files fall back
      // to a plain no-selection chip.
      let totalLines: number | undefined;
      try {
        if (shouldReadFileInline(fs.statSync(absPath).size)) {
          totalLines = fs.readFileSync(absPath, "utf8").split("\n").length;
        }
      } catch {
        /* fall back to a no-selection chip */
      }
      session.chips.push(
        totalLines != null
          ? makeExplicitChip(absPath, relPath, 1, totalLines)
          : makeExplicitChip(absPath, relPath),
      );
    } else {
      session.chips.push(makeExplicitChip(absPath, relPath));
    }
    this.postChips(session);
    return session;
  }

  /** A prompt is running or pending user action — a new prompt now would
   *  cancel it (a second `session/prompt` kills the in-flight turn). */
  private turnInFlight(session: Session): boolean {
    return session.status === "working" || session.status === "needs-you";
  }

  /** A send that raced into a running turn (desk↔remote co-attach: the other
   *  view learns `busy` only after agentStart crosses the relay). Ordinary
   *  sends join the host-owned queue — what the sender's own chat.js does
   *  when it knows in time. Bare slash turns (/compact, /workflow …) can't be
   *  queued (their text would corrupt the combined queued prompt) and must
   *  not cancel the running turn either, so they are rejected visibly.
   *
   *  Known limitation: a raced remote send's `submissionId` is lost here.
   *  The queue intentionally collapses contributions into one string, so
   *  retaining one id would falsely acknowledge the others when several
   *  views race. This can leave a refresh-correctable duplicate, not lose
   *  delivery. Revisit when queued state can track every contribution id and
   *  one committed message can acknowledge all of them without changing the
   *  relay dequeue handshake. */
  private divertRacingSend(session: Session, text: string, bare: boolean): void {
    if (bare) {
      this.emit(session, {
        type: "error",
        text: "Grok is mid-turn — that command was not run. Try again when the turn finishes.",
      });
      return;
    }
    session.queuedSendDispatch = undefined;
    if (session.queuedSends.length) session.queuedSends[0] += "\n\n" + text;
    else session.queuedSends.push(text);
    this.emit(session, { type: "queuedSends", items: [...session.queuedSends] });
    void this.maybeFlushQueuedSends(session);
  }

  private async handleSend(
    text: string,
    bare = false,
    target?: Session,
    origin: MsgOrigin = "local",
    queuedSendCommit?: { text: string },
    submissionId?: string,
  ): Promise<void> {
    // `target` lets a queued-send flush fire into a BACKGROUNDED session (its
    // turn ended while another was focused). Only the focused session may spawn
    // a client on demand; a background target without one has nothing to talk to.
    const session = target ?? this.focused;
    // Desk↔remote co-attach: the OTHER view only learns `busy` once the
    // mirrored agentStart crosses the relay, so a send can race through that
    // window into a turn that is already running — and a second
    // `session/prompt` cancels the in-flight turn (see steerIntoTurn's note).
    // Serialize host-side: such a send joins the queued-send path, which is
    // what the sender's own chat.js does when it knows in time. A remote send
    // was already metered on ingress, so the flag stays as-is (queueSend's
    // sticky rule governs unmetered contributions). This entry check is the
    // fast path only — the awaits below can suspend past it, so the SAME
    // check runs again at the commit point, where everything through
    // setStatus("working") is synchronous.
    // maybeFlushQueuedSends can never re-enter this branch: it only flushes
    // when the turn is over (queuedSendReadyText).
    if (this.turnInFlight(session)) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare);
      return;
    }
    const client = session.client ?? await this.ensureClient(session);
    if (!client) return;
    const gen = session.gen;

    // An attachment posted before send has started staging (message ordering),
    // but its fs awaits can still be mid-flight — a paste is ms, a 20MiB drop
    // import is tens of ms. Settle the in-flight set so its chip makes THIS
    // send. One-shot snapshot on purpose: an op starting during this await was
    // posted after send, so it belongs to the next turn.
    const staging = [...this.pendingAttach];
    if (staging.length) {
      await Promise.allSettled(staging);
      if (gen !== session.gen) return;
    }

    // Snapshot the HOST's chips — the webview copy is a render mirror of these
    // (every mutation routes through us + postChips).
    // `bare` sends (gear-menu /compact) deliberately carry no attachments, and
    // a background flush must not consume the FOCUSED view's composer chips.
    const chips = bare ? [] : [...session.chips];

    // Pre-read every visible image BEFORE anything is cleared or sent. Any
    // failure blocks the whole send with the chips intact — never a prompt
    // whose [Image #N] tag has no image block behind it (a dangling tag sends
    // grok hunting the workspace for an image it was never given).
    const images: PromptImageInput[] = [];
    for (const chip of chips) {
      if (chip.hidden || !isImageChip(chip)) continue;
      try {
        const bytes = await fs.promises.readFile(chip.path);
        if (bytes.length === 0) throw new Error("file is empty");
        images.push({
          index: chip.imageIndex!,
          mimeType: chip.mimeType ?? "image/png",
          data: bytes.toString("base64"),
          path: chip.path,
          relPath: chip.originRelPath,
        });
      } catch (e) {
        if (gen !== session.gen) return;
        this.emit(session, {
          type: "agentError",
          text: `Could not read ${chip.relPath} (${(e as Error).message}). Remove the attachment and try again.`,
        });
        return;
      }
    }
    // Mirror the failure path's guard: if the client was torn down during the
    // pre-read awaits, bail BEFORE consuming chips / unlinking staged files —
    // the composer keeps its attachments for the session that replaced us.
    if (gen !== session.gen) return;

    // A leading context envelope knocks a slash command off position 0 of the
    // text block, and the CLI then routes it to the LLM instead of dispatching
    // it (a /compact that *grew* the context 6x in testing — see
    // research/compact.md). Confirmed commands flip the prompt order so the
    // command keeps position 0 and the context trails it.
    const slashCommand = matchSlashCommand(
      text,
      client.availableCommands.map((c) => c.name),
    );
    const { blocks: promptBlocks } = buildPromptWithImages(
      text,
      chips,
      images,
      {
        readFile: (p) => fs.readFileSync(p, "utf8"),
        extName: (p) => path.extname(p),
      },
      slashCommand != null,
    );

    // Unlike images, document bytes are read lazily by Grok from the path in
    // the prompt. Persist ownership before consuming the chip or sending.
    await this.retainUploadedFilesForSession(session, chips);
    if (gen !== session.gen) return;

    // COMMIT-POINT re-check: that was the last await before this send turns
    // into a prompt — everything from here through setStatus("working") is
    // synchronous. Without this, two views' sends could both pass the entry
    // check while one was still reading attachments, and the second prompt
    // would cancel the first turn. Runs before chips are consumed, so a
    // diverted send leaves its attachments staged for the queued flush.
    if (this.turnInFlight(session)) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare);
      return;
    }

    if (queuedSendCommit) {
      if (!finishQueuedSendCommit(session, queuedSendCommit, true)) return;
      this.emit(session, { type: "queuedSends", items: [...session.queuedSends] });
    }

    if (bare) {
      this.postChips(session);
    } else {
      // One-shot attachments are consumed by the send; the implicit context
      // chip mirrors IDE state and stays resident (like Claude Code's). Keep
      // it through the clear so refreshImplicitChip sees `prev` — preserving
      // the user's eye-off choice and no-op-diffing against the live editor.
      // Consume by id, not wholesale: a chip staged after the snapshot (while
      // images were pre-reading) belongs to the next turn and must survive.
      session.chips = consumeChips(session.chips, chips);
      if (session === this.focused) this.refreshImplicitChip(true);
      else this.postChips(session);
    }
    // Keep staged image sources until the seven-day orphan sweeper. The prompt
    // carries each path so live and restored history can render a thumbnail;
    // a missing/expired source simply falls back to the image tag.

    const isFirstSend = !session.hasHistory;
    session.hasHistory = true;
    if (isFirstSend) {
      // Image-only first message: leave the title source empty so grok's own
      // generated summary shows through, instead of pinning a permanent
      // "[Image #1]" customName over every screenshot-first session.
      session.firstUserMessageForTitle = text;
      // One `session_start` per session, on the first real user message.
      this.reportSessionStart(session, origin);
    }
    const sentChips = chips.filter((c) => !c.hidden);
    session.userMessageCount += 1;
    session.inUserMessage = false; // live send isn't part of the streamed-chunk count path
    this.emit(session, { type: "userMessage", text, chips: sentChips, submissionId });
    this.emit(session, { type: "agentStart" });
    this.setStatus(session, "working");

    try {
      // Arm the compact-notification watch BEFORE the prompt: the live
      // auto_compact_completed / auto_compact_failed land DURING this turn.
      if (slashCommand === "compact") {
        session.sawCompactFailed = false;
      }
      const meta = await client.prompt(promptBlocks);
      if (gen !== session.gen) return; // session was switched mid-turn
      if (slashCommand === "compact") {
        // A native /compact streams no agent content (research/compact.md), so
        // the turn would end with a blank bubble and no sign it worked. Paint a
        // live-only confirmation into that empty bubble — UNLESS compaction failed
        // (auto_compact_failed set sawCompactFailed), in which case the failure
        // note already showed and a "Compacted." would contradict it. Deliberately
        // not persisted: grok's own history has no such message, so re-focus keeps
        // it but a disk restore won't.
        if (!session.sawCompactFailed) this.emit(session, { type: "messageChunk", text: "Compacted." });
      }
      this.emit(session, { type: "agentEnd", meta });
      this.setStatus(session, "done");
      session.authRecoveryTried = false; // a clean turn re-arms token auto-recovery
      this.maybeGenerateTitle(session);
    } catch (err) {
      if (gen !== session.gen) return; // prompt rejected because we disposed the old client — don't leak the error into the new session
      const e = err as any;
      // A rate/usage-limit failure (ACP -32003, or limit phrasing) is not a
      // credential problem: skip the auth recovery — its retry would end on
      // the login screen, which can't fix a limit — and show a clear limit
      // notice instead (#57).
      if (isRateLimitError(e)) {
        this.emit(session, { type: "agentError", text: rateLimitNoticeText(e) });
        this.setStatus(session, "error");
        return;
      }
      // An expired-token error wedges only THIS long-lived process (the CLI shares
      // ~/.grok/auth.json across the pool + sibling `grok login`); transparently
      // reload the process and resend before surfacing the error (see method doc).
      if (await this.recoverAuthAndResend(session, e, text, sentChips, promptBlocks)) return;
      // Recovery declined (already retried this streak, or not auth-shaped):
      // promptErrorText keeps the copy consistent — the entitlement notice for
      // billing-flavored wording (#58), the raw detail otherwise.
      this.emit(session, { type: "agentError", text: promptErrorText(e) });
      this.setStatus(session, "error");
    } finally {
      // The turn is fully over — fire anything queued during it (#37).
      if (gen === session.gen) {
        this.settleUnavailablePlanTurn(session, client, gen);
        void this.maybeFlushQueuedSends(session);
      }
    }
  }

  /**
   * Recover from an expired-token turn failure without a manual sign-out. A
   * pooled `grok agent stdio` process can wedge on an expired OAuth token when
   * its 401-refresh loses a rotation race with the sibling processes / `grok
   * login` that share `~/.grok/auth.json`. A FRESH process re-reads the current
   * disk token — exactly what re-login does, minus the sign-out — so we
   * transparently restart the owning session (`startSession` respawns +
   * `session/load`s to preserve history) and RE-SEND the failed prompt once.
   * Guarded by `authRecoveryTried` (reset on any clean turn) so a genuine
   * dead-auth / entitlement error can't loop. The resend's failure is the
   * decision point (#58): only a CREDENTIAL failure (`isCredentialError` — the
   * CLI's -32000 auth_required, or unambiguous credential wording) earns the
   * sign-in overlay; billing/entitlement wording that a fresh process couldn't
   * clear is NOT fixable by login (the CLI maps 403 to a plain error precisely
   * because the credential was accepted) and shows the in-chat entitlement
   * notice instead. Returns true when it handled the error (caller must not
   * also show it).
   */
  private async recoverAuthAndResend(
    session: Session,
    err: unknown,
    displayText: string,
    chips: FileChip[],
    promptBlocks: Parameters<AcpClient["prompt"]>[0],
  ): Promise<boolean> {
    const errorText = errorDetail(err);
    if (!isAuthErrorText(errorText) && !isCredentialError(err)) return false;
    const resumeId = beginAuthRecovery(session);
    if (!resumeId) return false;
    this.output.appendLine(`[auth] recoverable token error — reloading session + resending: ${errorText}`);

    // Fresh process, current disk token. Rebuild this same pool member and replay
    // its history from disk. Its generation + authRecoveryTried guards are both
    // session-scoped, so unrelated local/remote turns remain independent.
    const client = await this.startSession(resumeId, session);
    if (!client || session.client !== client) return true; // startSession surfaced its own failure/onboarding
    const gen = session.gen;
    if (gen !== session.gen) return true;

    session.userMessageCount += 1;
    this.emit(session, { type: "userMessage", text: displayText, chips });
    this.emit(session, { type: "agentStart" });
    this.setStatus(session, "working");
    try {
      const meta = await client.prompt(promptBlocks);
      if (gen !== session.gen) return true;
      this.emit(session, { type: "agentEnd", meta });
      this.setStatus(session, "done");
      session.authRecoveryTried = false; // recovered — re-arm for a future expiry
      this.maybeGenerateTitle(session);
    } catch (err2) {
      if (gen !== session.gen) return true;
      const e2 = err2 as any;
      // The resend ran into a usage limit — that's the real story, not auth
      // (#57): a fresh process with a fresh token hit the same wall.
      if (isRateLimitError(e2)) {
        this.emit(session, { type: "agentError", text: rateLimitNoticeText(e2) });
        this.setStatus(session, "error");
        return true;
      }
      if (isCredentialError(e2)) {
        // A fresh process still can't authenticate → auth.json genuinely dead →
        // the honest ask is a re-login. The agentError FIRST: its webview
        // handler is what clears the busy/"Grokking" indicator and leaves a
        // truthful transcript (the overlay alone froze both — #58). The overlay
        // itself is post()ed, not emit()ed: live-only, so it can't resurrect
        // from the replay buffer on a later focus switch after the user has
        // already re-authed.
        this.emit(session, { type: "agentError", text: errorDetail(e2) });
        this.setStatus(session, "error");
        this.post({ type: "onboarding", state: "auth-required" });
      } else {
        // Entitlement/billing wording (or anything else) on a fresh process is
        // not a sign-in problem — promptErrorText shows the entitlement notice
        // with the CLI's own actionable advice in chat (#58), never the login
        // overlay, which can't fix it.
        this.emit(session, { type: "agentError", text: promptErrorText(e2) });
        this.setStatus(session, "error");
      }
    }
    return true;
  }

  private maybeGenerateTitle(session: Session): void {
    if (session.titleGenerated) return;
    const sid = session.client?.sessionId ?? session.activeSessionId;
    const first = session.firstUserMessageForTitle;
    if (!sid || !first) return;
    session.titleGenerated = true;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    if (overrides[sid]?.customName) return;
    const cleaned = first.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    const title = cleaned.length > 50 ? cleaned.slice(0, 47) + "…" : cleaned;
    const next: SessionMetaOverrides = {
      ...overrides,
      [sid]: { ...(overrides[sid] ?? {}), customName: title },
    };
    void this.context.globalState.update(SESSION_META_KEY, next);
  }

  private buildInitialStateMsg(): HostMsg {
    const cfg = vscode.workspace.getConfiguration("grok");
    const cwd = this.workspaceRoot();
    return {
      type: "initialState",
      effort: cfg.get("defaultEffort", ""),
      cwd,
      useCtrlEnter: cfg.get("useCtrlEnterToSend", false),
      extVersion: (this.context.extension.packageJSON as { version?: string })?.version ?? "",
      showThinking: cfg.get("showThinking", false),
      expandCommandOutputs: cfg.get("expandCommandOutputs", false),
      steerByDefault: cfg.get("steerByDefault", false),
      soundNotifications: cfg.get("soundNotifications", false),
      processingSound: cfg.get("processingSound", false),
      readRepliesAloud: cfg.get("readRepliesAloud", false),
      capabilities: HOST_CAPABILITIES,
    };
  }

  private postInitialState(): void {
    this.post(this.buildInitialStateMsg());
    this.post({
      type: "summarizeRepliesAloud",
      value: vscode.workspace.getConfiguration("grok").get<boolean>("summarizeRepliesAloud", true),
    });
    // Sync the active-editor context chip into the fresh webview (the config
    // gate + no-editor case live inside refreshImplicitChip).
    this.refreshImplicitChip(true);
    this.postVoiceConfigured();
    void this.postRemoteStatus();
    // Sweep legacy empty-primer sessions once the first session is live (so the
    // newly-focused session is excluded from the sweep).
    void this.startSession().then(() => {
      this.sweepEmptyPrimerSessions();
    });
  }

  private postChips(session: Session = this.focused): void {
    const remoteMessage: HostMsg = { type: "chips", chips: session.chips };
    if (session === this.focused && this.view) {
      const webview = this.view.webview;
      const localMessage: HostMsg = { type: "chips", chips: this.localPreviewChips(session, webview) };
      void webview.postMessage(localMessage);
    }
    this.sendRemoteSession(session, remoteMessage);
  }

  private localPreviewChips(session: Session, webview: vscode.Webview): FileChip[] {
    return session.chips.map((chip) => isImageChip(chip)
      ? { ...chip, previewSrc: webview.asWebviewUri(vscode.Uri.file(chip.path)).toString() }
      : chip);
  }

  private localizeHistoryMessage(message: HostMsg, webview: vscode.Webview): HostMsg {
    if (message.type === "userMessage" && message.chips) {
      return { ...message, chips: message.chips.map((chip) => isImageChip(chip)
        ? { ...chip, ...(fs.existsSync(chip.path)
          ? { previewSrc: webview.asWebviewUri(vscode.Uri.file(chip.path)).toString() }
          : {}) }
        : chip) };
    }
    if (message.type === "userMessageChunk" && message.images) {
      return {
        ...message,
        images: message.images.map((image) => image.path && fs.existsSync(image.path)
          ? { ...image, previewSrc: webview.asWebviewUri(vscode.Uri.file(image.path)).toString() }
          : image),
      };
    }
    return message;
  }

  // grok's output for hidden summary/context-injection turns, dropped from both
  // the session buffer and live view. User input/lifecycle messages are excluded.
  private static readonly SUPPRESS_TYPES = new Set([
    "messageChunk", "userMessageChunk", "thoughtChunk", "toolCall", "toolCallUpdate",
    "promptComplete", "xaiNotification", "subagentUpdate", "runProgress", "commandOutput", "agentEnd",
  ]);
  private post(message: HostMsg): void {
    if (this.focused.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    this.view?.webview.postMessage(message);
    if (GrokSidebar.DEVICE_GLOBAL_REMOTE_TYPES.has(message.type)) {
      this.broadcastRemoteDevice(message);
    } else {
      this.sendRemoteSession(this.focused, message);
    }
  }

  /** Deliver a command-palette MCP request only after this webview can receive it. */
  private postMcpPanelWhenReady(): void {
    if (!this.mcpPanelOpenRequested || !this.webviewReady) return;
    this.mcpPanelOpenRequested = false;
    this.post({ type: "openMcpServers" });
  }

  /** Post to the VS Code webview only. */
  private postLocal(message: HostMsg): void {
    this.postTap?.("local", message);
    this.view?.webview.postMessage(message);
  }

  /** Target one opaque relay clientId. */
  private sendRemoteClient(clientId: string, message: HostMsg): void {
    this.postTap?.("remote", message, [clientId]);
    const out = transformHostMsgForRemote(message, this.remoteMediaDeps);
    if (out) this.uplink?.broadcastTo([clientId], out);
  }

  private sendRemoteRepo(cwd: string, message: HostMsg): void {
    const clientIds = this.remoteClients.clientsForCwd(cwd);
    this.postTap?.("remote", message, clientIds);
    const out = transformHostMsgForRemote(message, this.remoteMediaDeps);
    if (!out) return;
    this.uplink?.broadcastTo(clientIds, out);
  }

  private sendRemoteSession(session: Session, message: HostMsg): void {
    for (const clientId of this.remoteClients.clients()) {
      if (this.remoteClients.active(clientId) === session) {
        this.sendRemoteClient(clientId, message);
      }
    }
  }

  private sendRemoteHistorySnapshot(session: Session): void {
    const clientIds = this.remoteClients.clientsForActiveValue(session);
    if (clientIds.length === 0) return;
    const snapshot = bracketRemoteSnapshot(session.buffer);
    for (const clientId of clientIds) {
      for (const message of snapshot) this.sendRemoteClient(clientId, message);
    }
  }

  private broadcastRemoteDevice(message: HostMsg): void {
    this.postTap?.("remote", message, this.remoteClients.clients());
    const out = transformHostMsgForRemote(message, this.remoteMediaDeps);
    if (out) this.uplink?.broadcast(out);
  }

  /** Test-only tap on the split posts. Never assigned in a released build:
   *  `extension.ts` hands out `installTestHooks` only under
   *  `ExtensionMode.Test`, which VS Code sets exclusively for a test runner. */
  private postTap?: (dest: MsgOrigin, message: HostMsg, clientIds?: string[]) => void;

  /**
   * Test-only seam for the integration suite. It exists because one property of
   * the local/remote split is unreachable from any pure unit test: that the
   * LOCAL payload reaches the webview and the REMOTE payload the uplink.
   * `repoScopeFor` proves WHICH cwd each audience should get; only this proves
   * the two are not wired to the wrong destinations — a swap that all 1386 unit
   * tests still pass (verified by performing it).
   */
  installTestHooks(): {
    onPost(fn: (dest: MsgOrigin, message: HostMsg, clientIds?: string[]) => void): void;
    fromRemote(message: WebviewMsg, clientId?: string): void;
    fromRelayFrame(raw: string): void;
    emitRemote(clientId: string, message: HostMsg): void;
    replayRemote(clientId: string, messages: HostMsg[], during?: () => void, fail?: boolean): Promise<void>;
    seedRemoteSession(
      clientId: string,
      id: string,
      cwd: string,
      messages?: HostMsg[],
      hasHistory?: boolean,
      chips?: FileChip[],
    ): void;
    seedLocalBackgroundSession(id: string, cwd: string): void;
    openLocalSession(id: string, cwd: string): Promise<void>;
    seedWorktree(record: WorktreeRecord): void;
    seedWorktreeRefresh(sourceRepo: string, records: WorktreeRecord[]): void;
    seedRemoteUnstartedSession(clientId: string, cwd: string): void;
    seedRemoteStartingSession(clientId: string, id: string, cwd: string, queuedText: string): void;
    seedRemoteQueuedDispatch(
      clientId: string,
      id: string,
      cwd: string,
      queuedText: string,
      chips?: FileChip[],
    ): { promptCount(): number; queuedSends(): string[] };
    finishRemoteStartup(clientId: string): void;
    seedRemoteVoice(clientId: string): { cancelled(): boolean };
    emitContextUsage(clientId: string): void;
    seedUsageLedger(
      clientId: string,
      entries: { afterUserMessage: number; afterHistoryEvent?: number; usage?: PromptUsage }[],
      userMessageCount: number,
    ): Promise<void>;
    restartUsageSession(
      clientId: string,
      id: string,
      mode: "clear" | "summarize",
      summaryUsage?: PromptUsage,
    ): Promise<void>;
    rewindUsageLedger(clientId: string, surviving: number): Promise<void>;
    completeUsageTurn(clientId: string, usage: PromptUsage): Promise<void>;
    reloadUsageLedger(clientId: string, userMessageCount: number): {
      usageLog: NonNullable<SessionMetaOverrides[string]["usageLog"]>;
      sessionUsage: PromptUsage | undefined;
    };
    delayNextSessionStart(resumeId?: string): { started: Promise<void>; release(): void };
    waitForSessionLoad(id: string): Promise<void>;
    setSessionStatus(id: string, status: SessionStatus): void;
    activeRemoteSessionId(clientId: string): string | undefined;
    activeRemoteWorktree(clientId: string): Session["worktree"];
    focusedSessionId(): string | undefined;
    hasLiveSession(id: string): boolean;
    remoteClientLeft(clientId: string): void;
    remoteClientRoster(clientIds: string[]): void;
    workspaceRoot(): string;
  } {
    return {
      onPost: (fn) => {
        this.postTap = fn;
      },
      fromRemote: (message, clientId = "test-client") => this.handleRemoteMessage(clientId, message),
      fromRelayFrame: (raw) => {
        const frame = parseRelayFrame(raw);
        if (frame?.t !== "client-ready") return;
        this.handleRemoteClientReady(frame.clientId, frame.tabToken);
        for (const message of this.buildRemoteSnapshot(frame.clientId)) {
          this.sendRemoteClient(frame.clientId, message);
        }
      },
      emitRemote: (clientId, message) => {
        const session = this.remoteSessionFor(clientId);
        this.emit(session, message);
      },
      replayRemote: async (clientId, messages, during, fail = false) => {
        const session = this.remoteSessionFor(clientId);
        await this.replayLoadedHistory(session, async () => {
          for (const message of messages) this.emit(session, message);
          during?.();
          if (fail) throw new Error("synthetic session/load failure");
        });
      },
      seedRemoteSession: (clientId, id, cwd, messages = [], hasHistory = false, chips = []) => {
        this.remoteClients.ready(clientId);
        this.remoteClients.select(clientId, cwd);
        const session = new Session();
        session.cwd = cwd;
        session.activeSessionId = id;
        session.client = { dispose() {} } as AcpClient;
        session.hasHistory = hasHistory;
        session.chips = chips;
        session.buffer.push(...messages);
        this.pool.add(session);
        this.remoteClients.setActive(clientId, session);
      },
      seedLocalBackgroundSession: (id, cwd) => {
        const session = this.newLocalSession();
        session.cwd = cwd;
        session.activeSessionId = id;
        session.client = { dispose() {} } as AcpClient;
        session.hasHistory = true;
        this.pool.add(session);
      },
      openLocalSession: (id, cwd) => this.openSession(id, cwd),
      seedWorktree: (record) => {
        this.worktreeCache = this.worktreeCache.filter((wt) => !pathsEqual(wt.path, record.path));
        this.worktreeCache.push(record);
      },
      seedWorktreeRefresh: (sourceRepo, records) => {
        this.worktreeCache = mergeWorktreeRefresh(this.worktreeCache, sourceRepo, records);
      },
      seedRemoteUnstartedSession: (clientId, cwd) => {
        this.remoteClients.ready(clientId);
        this.remoteClients.select(clientId, cwd);
        const session = new Session();
        this.setSessionCwd(session, cwd, this.workspaceRoot());
        this.remoteClients.setActive(clientId, session);
      },
      seedRemoteStartingSession: (clientId, id, cwd, queuedText) => {
        this.remoteClients.ready(clientId);
        this.remoteClients.select(clientId, cwd);
        const session = new Session();
        session.cwd = cwd;
        session.activeSessionId = id;
        session.client = { dispose() {} } as AcpClient;
        session.priming = true;
        session.queuedSends = [queuedText];
        session.queuedSendRequiresRelay = true;
        this.pool.add(session);
        this.remoteClients.setActive(clientId, session);
      },
      seedRemoteQueuedDispatch: (clientId, id, cwd, queuedText, chips = []) => {
        this.remoteClients.ready(clientId);
        this.remoteClients.select(clientId, cwd);
        let prompts = 0;
        const session = new Session();
        session.cwd = cwd;
        session.activeSessionId = id;
        session.client = {
          availableCommands: [],
          dispose() {},
          prompt: async (_blocks: Parameters<AcpClient["prompt"]>[0]) => {
            prompts += 1;
            return {};
          },
        } as unknown as AcpClient;
        session.hasHistory = true;
        session.status = "done";
        session.chips = chips;
        session.queuedSends = [queuedText];
        session.queuedSendRequiresRelay = true;
        this.pool.add(session);
        this.remoteClients.setActive(clientId, session);
        void this.maybeFlushQueuedSends(session);
        return {
          promptCount: () => prompts,
          queuedSends: () => [...session.queuedSends],
        };
      },
      finishRemoteStartup: (clientId) => {
        const session = this.remoteClients.active(clientId);
        if (!session) return;
        session.priming = false;
        session.queuedSendDispatch = undefined;
        session.queuedSends = [];
        session.queuedSendRequiresRelay = false;
      },
      seedRemoteVoice: (clientId) => {
        const session = this.remoteSessionFor(clientId);
        let cancelled = false;
        const ingress = new RemotePcmIngress(
          GrokSidebar.MAX_REMOTE_PCM_CHUNK_BYTES,
          GrokSidebar.MAX_REMOTE_PCM_BYTES,
          MAX_RECORDING_SECONDS * 1000,
          () => {},
        );
        const streamer = {
          cancel: () => { cancelled = true; },
        } as PcmVoiceStreamer;
        this.remoteVoice.set(clientId, {
          credentialCwd: this.sessionCwd(session),
          session,
          streamer,
          ingress,
          phrase: DEFAULT_SEND_PHRASE,
          keyterms: buildSttKeyterms(DEFAULT_SEND_PHRASE),
          finalizing: false,
        });
        return { cancelled: () => cancelled };
      },
      emitContextUsage: (clientId) => this.emitContextUsage(this.remoteSessionFor(clientId)),
      seedUsageLedger: async (clientId, entries, userMessageCount) => {
        const session = this.remoteSessionFor(clientId);
        const id = session.activeSessionId;
        if (!id) throw new Error("Seeded usage session has no id");
        session.userMessageCount = userMessageCount;
        const usageLog = entries.map((entry) => ({
          ...entry,
          usage: entry.usage ? { ...entry.usage } : undefined,
        }));
        const usage = enforceCompleteSessionCost(
          sumUsage(usageLog),
          usageLog,
          userMessageCount,
        );
        const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
        await this.context.globalState.update(SESSION_META_KEY, {
          ...overrides,
          [id]: {
            ...(overrides[id] ?? {}),
            usage,
            usageLog,
          },
        });
      },
      restartUsageSession: async (clientId, id, mode, summaryUsage) => {
        const session = this.remoteSessionFor(clientId);
        session.activeSessionId = id;
        session.userMessageCount = 0;
        session.historyEventCount = 0;
        if (mode === "summarize" && summaryUsage) {
          await this.accumulateUsage(session, { totalTokens: 1, usage: summaryUsage });
        }
      },
      rewindUsageLedger: async (clientId, surviving) => {
        const session = this.remoteSessionFor(clientId);
        if (!session.activeSessionId) throw new Error("Seeded usage session has no id");
        await this.truncateSessionCardsAfterRewind(session.activeSessionId, surviving);
        session.userMessageCount = surviving;
      },
      completeUsageTurn: async (clientId, usage) => {
        const session = this.remoteSessionFor(clientId);
        session.userMessageCount += 1;
        await this.accumulateUsage(session, { totalTokens: 1, usage });
      },
      reloadUsageLedger: (clientId, userMessageCount) => {
        const current = this.remoteSessionFor(clientId);
        const id = current.activeSessionId;
        if (!id) return { usageLog: [], sessionUsage: undefined };
        const ledger = this.persistedUsageLedger(id, userMessageCount);
        return { usageLog: ledger.usageLog, sessionUsage: ledger.usage };
      },
      delayNextSessionStart: (resumeId) => {
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const wait = new Promise<void>((resolve) => { release = resolve; });
        this.testSessionStartDelay = { resumeId, started: markStarted, wait };
        return { started, release };
      },
      waitForSessionLoad: (id) => {
        const reservation = this.sessionLoadReservations.get(id);
        return reservation
          ? reservation.completion
          : Promise.reject(new Error(`No in-flight session load for ${id}`));
      },
      setSessionStatus: (id, status) => {
        const session = [...this.pool].find((candidate) => candidate.activeSessionId === id);
        if (session) this.setStatus(session, status);
      },
      activeRemoteSessionId: (clientId) => this.remoteActiveSessionId(clientId) ?? undefined,
      activeRemoteWorktree: (clientId) => this.remoteClients.active(clientId)?.worktree,
      focusedSessionId: () => this.focused.activeSessionId,
      hasLiveSession: (id) => [...this.pool].some((session) =>
        session.activeSessionId === id && !!session.client
      ),
      remoteClientLeft: (clientId) => this.releaseRemoteClient(clientId),
      remoteClientRoster: (clientIds) => this.retainRemoteClients(clientIds),
      workspaceRoot: () => this.workspaceRoot(),
    };
  }

  /**
   * Session-scoped post. Records the message in that session's view buffer (so a
   * focus switch can rebuild its chat losslessly — clearMessages + replay) and,
   * when the session is the focused one, forwards it to the webview. Per-session
   * suppress flags drop hidden summary/context content from BOTH buffer and live
   * view (so they never reappear on replay). `clearMessages` resets the buffer —
   * the replay path issues its own clear before replaying, and a (re)started
   * session begins empty. Background sessions buffer silently; nothing reaches
   * the webview until they're focused. (Pool-of-1 today: session is always the
   * focused one, so this is behaviorally identical to `post`.)
   */
  private emit(session: Session, message: HostMsg): void {
    if (session.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (message.type === "clearMessages") session.buffer = [];
    else session.buffer.push(message);
    if (session === this.focused) {
      this.postTap?.("local", message);
      const webview = this.view?.webview;
      if (webview) webview.postMessage(this.localizeHistoryMessage(message, webview));
    }
    if (!session.replaying) this.sendRemoteSession(session, message);
  }

  private async replayLoadedHistory(session: Session, load: () => Promise<void>): Promise<void> {
    session.replaying = true;
    this.emit(session, { type: "historyReplay", active: true });
    try {
      await load();
    } finally {
      this.emit(session, { type: "historyReplay", active: false });
      session.replaying = false;
      this.sendRemoteHistorySnapshot(session);
    }
  }

  // ---------- session pool ----------

  /**
   * Make `session` the visible one and rebuild the chat from its buffer. The
   * buffer holds every post that built that session's view (in order), so a
   * clear + replay reconstructs it losslessly — including a turn still in flight
   * (its still-wired handlers keep emitting straight to the webview once focused).
   * Bypasses `emit` deliberately: we post the buffer's contents to the webview
   * without re-running the suppress/clearMessages bookkeeping (that already ran
   * when each message was first buffered).
   */
  private newLocalSession(): Session {
    return new Session();
  }

  private reserveSessionLoad(
    id: string,
    ownerTabToken?: string,
  ): { reservation: SessionLoadReservation; joined: boolean } | undefined {
    const existing = this.sessionLoadReservations.get(id);
    if (existing && existing.expiresAt > Date.now()) {
      return ownerTabToken && existing.ownerTabToken === ownerTabToken
        ? { reservation: existing, joined: true }
        : undefined;
    }
    if (existing) {
      clearTimeout(existing.timer);
      this.sessionLoadReservations.delete(id);
    }
    const token = Symbol(id);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void completion.catch(() => undefined);
    const timer = setTimeout(() => {
      const current = this.sessionLoadReservations.get(id);
      if (current?.token === token) this.sessionLoadReservations.delete(id);
    }, GrokSidebar.SESSION_LOAD_RESERVATION_TTL_MS);
    timer.unref?.();
    const reservation: SessionLoadReservation = {
      token,
      ownerTabToken,
      completion,
      resolve,
      reject,
      expiresAt: Date.now() + GrokSidebar.SESSION_LOAD_RESERVATION_TTL_MS,
      timer,
    };
    this.sessionLoadReservations.set(id, reservation);
    return { reservation, joined: false };
  }

  private bindSessionLoad(id: string, reservation: SessionLoadReservation, session: Session): void {
    const current = this.sessionLoadReservations.get(id);
    if (current?.token === reservation.token) current.session = session;
  }

  private releaseSessionLoad(
    id: string,
    reservation: SessionLoadReservation,
    error?: unknown,
  ): void {
    if (error === undefined) reservation.resolve();
    else reservation.reject(error);
    const current = this.sessionLoadReservations.get(id);
    if (current?.token !== reservation.token) return;
    clearTimeout(current.timer);
    this.sessionLoadReservations.delete(id);
  }

  private isSessionLoadReserved(id: string): boolean {
    const current = this.sessionLoadReservations.get(id);
    if (!current) return false;
    if (current.expiresAt > Date.now()) return true;
    clearTimeout(current.timer);
    this.sessionLoadReservations.delete(id);
    return false;
  }

  private reservedSessionIds(): string[] {
    return [...this.sessionLoadReservations.keys()].filter((id) => this.isSessionLoadReserved(id));
  }

  private remoteActiveSessionId(clientId: string): string | null {
    const session = this.remoteClients.active(clientId);
    if (session?.activeSessionId) return session.activeSessionId;
    if (!session) return null;
    for (const [id, reservation] of this.sessionLoadReservations) {
      if (reservation.session === session && this.isSessionLoadReserved(id)) return id;
    }
    return null;
  }

  private sendRemoteSessionList(session: Session, ownerTabToken?: string): void {
    const currentOwner = ownerTabToken
      ? this.remoteClients.clientForTabToken(ownerTabToken)
      : undefined;
    const clientIds = ownerTabToken
      ? currentOwner && this.remoteClients.active(currentOwner) === session
        ? [currentOwner]
        : []
      : this.remoteClients.clientsForActiveValue(session);
    for (const clientId of clientIds) {
      this.sendRemoteClient(
        clientId,
        this.buildSessionsList(
          this.remoteClients.cwd(clientId),
          undefined,
          this.remoteActiveSessionId(clientId),
        ),
      );
    }
  }

  private focusSession(session: Session): void {
    if (session === this.focused) return;
    this.focused = session;
    this.touch(session);
    this.markRead(session); // opening it clears any unread (green/red) badge
    const wv = this.view?.webview;
    if (wv) {
      wv.postMessage({ type: "clearMessages" });
      wv.postMessage({ type: "historyReplay", active: true });
      for (const m of session.buffer) wv.postMessage(this.localizeHistoryMessage(m, wv));
      wv.postMessage({ type: "historyReplay", active: false });
      for (const m of sessionUiSnapshot(
        session,
        this.displayMode(session),
        this.localPreviewChips(session, wv),
      )) wv.postMessage(m);
    }
    // Remote clients don't share the webview, so replay the same clear + buffer
    // to them over the uplink — otherwise re-focusing a session that's still
    // live in the pool (this path) reloads only the local webview while the
    // remote keeps showing the previous session (switching a session in history
    // didn't always reload on the browser client). Cold loads go through
    // emit()/post(), which already mirror; this path deliberately bypasses them.
    // The targeted send applies the normal remote transform; the calls below
    // refresh current mode, repository, and history chrome independently.
    if (this.uplink) {
      const replay: HostMsg[] = [
        { type: "clearMessages" },
        ...bracketRemoteSnapshot(session.buffer),
      ];
      for (const m of replay) {
        this.sendRemoteSession(session, m);
      }
    }
    this.postMode();
    this.postRepoCatalog();
    this.postSessionsList();
  }

  /**
   * Leave the focused session running in the pool so it can be re-focused later
   * — unless it's an untouched, idle session, which isn't worth a live process,
   * so we tear it down. Called before switching focus to a new/other session.
   */
  private parkFocused(): void {
    const cur = this.focused;
    const busy = cur.status === "working" || cur.status === "needs-you";
    // A worktree session backs a real git checkout the user explicitly created —
    // never auto-delete it as an empty session, even before the first
    // message (that's what made creating/leaving a worktree replace the current
    // one). It's removed only via Remove worktree.
    if (cur.hasHistory || busy || cur.chips.length > 0 || cur.worktree) return; // real/active work — keep it parked & alive
    // Co-attached: a remote tab still shows this session — not ours to tear down.
    if (this.remoteClients.clientsForActiveValue(cur).length > 0) return;
    // Empty session being left behind (New Session, or switching to
    // another): tear down its process AND delete its on-disk dir so it doesn't pile
    // up in history (#24). The next focused session becomes the single live "New
    // session"; abandoning this one removes it entirely.
    this.disposeSession(cur);
    this.removeSessionFromDisk(cur.activeSessionId, cur.cwd);
    this.postSessionsList();
  }

  /** Remote counterpart of parkFocused: abandoning an empty tab session
   * must not leave an ownerless process or history row behind. */
  private parkRemoteSession(clientId: string, next?: Session): void {
    const current = this.remoteClients.active(clientId);
    if (!current || current === next) return;
    const busy = current.status === "working" || current.status === "needs-you";
    if (
      current.hasHistory ||
      busy ||
      current.priming ||
      current.queuedSends.length > 0 ||
      current.chips.length > 0 ||
      current.worktree
    ) return;
    // Co-attached elsewhere (the VS Code view, or — defensively — another
    // tab): the session is still on screen there; only this tab lets go.
    if (current === this.focused) return;
    if (this.remoteClients.clientsForActiveValue(current).some((ownerId) => ownerId !== clientId)) return;
    const id = current.activeSessionId;
    const cwd = current.cwd;
    this.disposeSession(current);
    this.removeSessionFromDisk(id, cwd);
  }

  /** The sole remote-client release path: abandon its session before deleting ownership. */
  private releaseRemoteClient(clientId: string): void {
    const current = this.remoteClients.active(clientId);
    const preserveLogicalTab = !!current && (
      current.priming ||
      current.queuedSends.length > 0 ||
      current.chips.length > 0
    );
    this.parkRemoteSession(clientId);
    this.dropRemoteVoice(clientId);
    if (preserveLogicalTab) this.remoteClients.detachClient(clientId);
    else this.remoteClients.deleteClient(clientId);
  }

  private retainRemoteClients(clientIds: Iterable<string>): void {
    const keep = new Set(clientIds);
    for (const clientId of this.remoteClients.clients()) {
      if (!keep.has(clientId)) this.releaseRemoteClient(clientId);
    }
  }

  /** Delete a session's on-disk dir + drop its meta override and read-cache entry.
   *  Used when an empty session is abandoned or a legacy primer-only session is swept. Best-effort —
   *  a locked/already-gone dir is logged, not thrown. */
  private removeSessionFromDisk(id: string | undefined, sessionCwd?: string): void {
    if (!id) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cwd =
      sessionCwd ||
      overrides[id]?.worktreePath ||
      this.sessionCache.get(id)?.entry.cwd ||
      this.workspaceRoot();
    const grokHome = resolveGrokHome(process.env);
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
    } catch (e) {
      this.output.appendLine(`[sessions] could not remove empty session ${id}: ${(e as Error).message}`);
    }
    if (overrides[id]) {
      void this.removeUploadsForSessions([id], overrides);
      const next = { ...overrides };
      delete next[id];
      void this.context.globalState.update(SESSION_META_KEY, next);
    }
    this.sessionCache.delete(id);
  }

  /** One-shot cleanup (per activation) of empty, primer-only sessions left on disk by
   *  earlier runs — the "extra sessions I didn't create" of #24. Scans the newest
   *  slice by mtime (bounded, so it stays cheap on a large store), confirms each
   *  candidate is genuinely primer-only by reading its chat history, and deletes it.
   *  Never touches a live session, a renamed one, or a session that isn't ours. */
  private sweepEmptyPrimerSessions(): void {
    if (this.sweptEmptySessions) return;
    this.sweptEmptySessions = true;
    const cwd = this.workspaceRoot();
    const grokHome = resolveGrokHome(process.env);
    const log = (m: string) => this.output.appendLine(m);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const liveIds = new Set<string>();
    for (const s of this.pool) if (s.activeSessionId) liveIds.add(s.activeSessionId);
    if (this.focused.activeSessionId) liveIds.add(this.focused.activeSessionId);

    const sessDir = sessionsDirFor(grokHome, cwd);
    const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
    const removed: string[] = [];
    for (const { id } of index.slice(0, GrokSidebar.SWEEP_SCAN_LIMIT)) {
      if (liveIds.has(id) || overrides[id]?.customName?.trim()) continue;
      let raw: any;
      try {
        raw = JSON.parse(defaultFs.readFileSync(path.join(sessDir, id, "summary.json"), "utf8"));
      } catch {
        continue;
      }
      const numMessages = typeof raw?.num_messages === "number" ? raw.num_messages : 0;
      // Read the chat history and let the content check decide — do NOT skip on a high
      // num_messages. A primer-only session whose agentic primer turn ballooned past
      // the gate (e.g. 74 messages, zero real queries) would otherwise survive forever.
      // Real sessions are already cheaply skipped above via their customName override.
      let chatHistory: string | undefined;
      try {
        chatHistory = defaultFs.readFileSync(path.join(sessDir, id, "chat_history.jsonl"), "utf8");
      } catch {
        chatHistory = undefined;
      }
      const empty = isEmptyPrimerSession({
        numMessages,
        summary: typeof raw?.session_summary === "string" ? raw.session_summary : "",
        generatedTitle: typeof raw?.generated_title === "string" ? raw.generated_title : "",
        chatHistory,
      });
      if (!empty) continue;
      try {
        deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
        removed.push(id);
      } catch (e) {
        log(`[sessions] could not sweep ${id}: ${(e as Error).message}`);
      }
    }
    if (removed.length) {
      const next = { ...overrides };
      void this.removeUploadsForSessions(removed, overrides);
      for (const id of removed) {
        delete next[id];
        this.sessionCache.delete(id);
      }
      void this.context.globalState.update(SESSION_META_KEY, next);
      log(`[sessions] swept ${removed.length} empty primer session(s) from history`);
      this.postSessionsList();
    }
  }

  /** Tear down one session's live process and drop it from the pool. Bumps its
   *  generation so any in-flight handlers/awaits bound to the old client bail.
   *  Recomputes the dot after removal — a reaped session that's still unread stays
   *  green; an idle/read one goes gray. */
  private disposeSession(session: Session): void {
    const id = session.activeSessionId;
    session.gen++;
    session.client?.dispose();
    session.client = undefined;
    this.pool.delete(session);
    this.remoteClients.deleteActiveValue(session);
    if (id) this.post({ type: "sessionDot", id, dot: this.dotForId(id) });
  }

  /** Stamp a session's recency for LRU/TTL reaping (created / focused / made busy). */
  private touch(session: Session): void {
    session.lastActiveAt = Date.now();
  }

  /**
   * Enforce the pool bounds (idle TTL + LRU cap). Silently tears down whatever the
   * pure policy selects — never the focused session, never a working/needs-you one.
   * Called eagerly after each new start (cap) and on the periodic timer (TTL).
   */
  private reapPool(): void {
    const candidates = buildReapCandidates(
      this.pool,
      this.focused,
      (session) => this.remoteClients.isActiveValueVisible(session),
    );
    const doomed = selectReapable(candidates, {
      maxLive: GrokSidebar.MAX_LIVE_SESSIONS,
      idleTtlMs: GrokSidebar.IDLE_TTL_MS,
      now: Date.now(),
    });
    for (const c of doomed) {
      const visibleClients = this.remoteClients.clientsForActiveValue(c.session);
      this.disposeSession(c.session);
      for (const clientId of visibleClients) {
        this.remoteClients.setActive(clientId, c.session);
        for (const message of this.buildRemoteSnapshot(clientId)) this.sendRemoteClient(clientId, message);
        this.sendRemoteClient(clientId, {
          type: "error",
          text: "This session was unloaded to keep the live session pool bounded. It will reload automatically when you next send.",
        });
      }
    }
  }

  /**
   * Update a session's dashboard status and push just that dot to the webview
   * (cheap — no disk read, unlike postSessionsList). The history dropdown colors
   * each live session's row by this; a cold session (not in the pool) shows no
   * dot. Only emits when the value actually changes and the session has a grok id
   * to key the dot on.
   */
  private setStatus(session: Session, status: SessionStatus): void {
    if (session.status === status) return;
    session.status = status;
    // Activity refreshes the LRU/TTL clock so a busy session never ages out.
    if (status === "working" || status === "needs-you") this.touch(session);
    // Unread metadata is global per conversation, while visibility is per view.
    // Define the badge as "completed while nobody was looking": if VS Code or any
    // remote tab owns this session, at least one view watched the result arrive.
    if ((status === "done" || status === "error") && !this.sessionHasLiveOwner(session)) {
      this.setMetaUnread(session.activeSessionId, true, status === "error");
    }
    this.pushDot(session);
  }

  /** Push just this session's recomputed dot to the webview (cheap — no disk read
   *  beyond the small meta object). Used on status changes, read/unread changes,
   *  and on reaping (where the session has left the pool but may stay green). */
  private pushDot(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const message: HostMsg = { type: "sessionDot", id, dot: this.dotForId(id) };
    this.view?.webview.postMessage(message);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const sent = new Set<string>();
    for (const clientId of this.remoteClients.clients()) {
      const repoCwd = this.remoteClients.cwd(clientId);
      const key = normalizeRepoPath(repoCwd);
      if (sent.has(key)) continue;
      if (!this.sessionCwdsForRepo(repoCwd, overrides).some((cwd) => pathsEqual(cwd, this.sessionCwd(session)))) continue;
      sent.add(key);
      this.sendRemoteRepo(repoCwd, message);
    }
  }

  /** The dashboard dot for a grok-session id, from live status (if it's a live pool
   *  member) plus the persisted unread badge (which outlives the live process). */
  private dotForId(id: string): Dot {
    const live = [...this.pool].find((s) => s.activeSessionId === id);
    const meta = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    return computeDot({ liveStatus: live?.status, unread: meta?.unread, unreadError: meta?.unreadError });
  }

  /** Persist (or clear) a session's unread badge in globalState session-meta. */
  private setMetaUnread(id: string | undefined, unread: boolean, error: boolean): void {
    if (!id) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    const next: SessionMetaOverrides = { ...overrides };
    if (unread) {
      if (cur.unread && !!cur.unreadError === error) return; // unchanged
      next[id] = { ...cur, unread: true, unreadError: error || undefined };
    } else {
      if (!cur.unread && !cur.unreadError) return; // nothing to clear
      const { unread: _u, unreadError: _e, ...rest } = cur;
      if (Object.keys(rest).length === 0) delete next[id];
      else next[id] = rest;
    }
    void this.context.globalState.update(SESSION_META_KEY, next);
  }

  /**
   * Fold a finished turn's billing into the session total and push both to the
   * webview (#53). Skips turns whose usage isn't a real measurement — a
   * `/compact` replays the previous turn's numbers verbatim, so counting them
   * would double-bill that turn into the total on every compact.
   *
   * The total is persisted per session id because nothing on disk can rebuild
   * it: grok reports usage per prompt and `signals.json` keeps only context size.
   */
  private accumulateUsage(session: Session, meta: PromptResultMeta): PromiseLike<void> | undefined {
    const measured = usageIsRealMeasurement(meta);
    // totalTokens:0 is the CLI's reliable no-inference result for native slash
    // turns such as /compact. Record that successful prompt as covered without
    // counting its stale usage siblings. A real inference with missing usage is
    // NOT covered: its cost is unknown, so the aggregate must remain withheld.
    if (!measured && meta.totalTokens !== 0) return;
    const id = session.activeSessionId;
    if (!id) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    const usageLog = [
      ...(cur.usageLog ?? []),
      {
        afterUserMessage: session.userMessageCount,
        afterHistoryEvent: session.historyEventCount,
        usage: measured ? meta.usage : undefined,
      },
    ];
    const sessionUsage = enforceCompleteSessionCost(
      sumUsage(usageLog),
      usageLog,
      session.userMessageCount,
    );
    if (measured) {
      this.emit(session, { type: "usage", turn: meta.usage, session: sessionUsage, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount });
    }
    return this.context.globalState.update(SESSION_META_KEY, {
      ...overrides,
      [id]: { ...cur, usage: sessionUsage, usageLog },
    });
  }

  private persistedUsageLedger(sessionId: string, userMessageCount: number): {
    usageLog: NonNullable<SessionMetaOverrides[string]["usageLog"]>;
    usage: PromptUsage | undefined;
  } {
    const persisted = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {})[sessionId];
    const usageLog = [...(persisted?.usageLog ?? [])];
    const rawUsage = persisted?.usageLog ? sumUsage(usageLog) : persisted?.usage;
    return {
      usageLog,
      usage: enforceCompleteSessionCost(rawUsage, usageLog, userMessageCount),
    };
  }

  /** Seed a (re)opened session's cumulative billing from our own globalState and
   *  push it, so the popover survives a reload. No stored total (an older session
   *  or a pre-usage CLI) posts nothing — the popover shows context only. */
  private restoreUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    // Re-derive from the id-keyed ledger instead of trusting an aggregate that may have summed
    // cost-bearing turns over historical turns where cost was not recorded.
    const stored = this.persistedUsageLedger(id, session.userMessageCount).usage;
    if (!stored) return;
    this.emit(session, { type: "usage", session: stored, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount });
  }

  /** Push the context size from grok's on-disk signals.json to the webview —
   *  chiefly the cold-restore source before any turn has run. Best-effort: no
   *  readable count, no message (the donut keeps whatever it has). */
  private emitContextUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const cwd = this.sessionCwd(session);
    const usage = readContextUsage({ fs: defaultFs, grokHome: resolveGrokHome(process.env), cwd, id });
    if (usage) this.emit(session, { type: "contextUsage", used: usage.used, window: usage.window });
  }

  /** Clear a session's unread badge (it's being opened/viewed) and refresh its dot. */
  private markRead(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const meta = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    if (!meta?.unread && !meta?.unreadError) return;
    this.setMetaUnread(id, false, false);
    this.pushDot(session);
  }

  /** Tear down every live session (logout, CLI update, extension teardown).
   *  Resolves once every process has actually exited — the CLI-update path awaits
   *  this so `grok update` doesn't race a still-locked grok.exe (see dispose()).
   *  Fire-and-forget callers (the sync VS Code disposable) can drop the promise. */
  private disposePool(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const s of this.pool) {
      s.gen++;
      if (s.client) closing.push(s.client.dispose());
      s.client = undefined;
    }
    this.pool.clear();
    return Promise.all(closing).then(() => undefined);
  }

  /** Start a brand-new session, keeping the current one alive in the background. */
  private async newFocusedSession(origin: MsgOrigin): Promise<void> {
    // Repo selection only changes history scope; New Session is the deliberate
    // second action that starts Grok in the selected cwd — deliberate only for
    // the client that can SEE the selection. From VS Code, where the switcher
    // is hidden, this always means the open workspace: otherwise a phone that
    // switched repos hours ago would silently point the local New-session
    // button at another checkout, and Grok would write files there.
    const targetCwd = this.historyCwdFor(origin);
    this.parkFocused();
    this.focused = this.newLocalSession();
    this.setSessionCwd(this.focused, targetCwd, this.workspaceRoot());
    // The webview toolbar button clears its own DOM before posting newSession,
    // but the Command Palette command lands here directly — without this clear
    // the old transcript stayed onscreen under the fresh session. (The toolbar
    // path just clears twice, a no-op.)
    this.emit(this.focused, { type: "clearMessages" });
    await this.startSession();
    await this.persistWorktreeBinding(this.focused);
    this.postRepoCatalog();
  }

  private focusRemoteSession(clientId: string, session: Session, notifyCatalog = true): void {
    const cwd = this.remoteClients.cwd(clientId);
    this.remoteClients.setActive(clientId, session);
    this.touch(session);
    this.markRead(session);
    this.sendRemoteClient(clientId, { type: "clearMessages" });
    for (const msg of bracketRemoteSnapshot(session.buffer)) this.sendRemoteClient(clientId, msg);
    for (const msg of sessionUiSnapshot(session, this.displayMode(session))) this.sendRemoteClient(clientId, msg);
    if (notifyCatalog) this.postRepoCatalog();
    this.sendRemoteClient(clientId, this.buildSessionsList(cwd, undefined, this.remoteActiveSessionId(clientId)));
  }

  private async newRemoteSession(clientId: string, notifyCatalog = true): Promise<void> {
    const ownerTabToken = this.remoteClients.tabToken(clientId);
    const cwd = this.remoteClients.cwd(clientId);
    this.parkRemoteSession(clientId);
    this.dropRemoteVoice(clientId);
    const session = new Session();
    this.setSessionCwd(session, cwd, this.workspaceRoot());
    this.remoteClients.setActive(clientId, session);
    this.emit(session, { type: "clearMessages" });
    await this.startSession(undefined, session);
    await this.persistWorktreeBinding(session);
    if (notifyCatalog) this.postRepoCatalog();
    this.sendRemoteSessionList(session, ownerTabToken);
  }

  private async openRemoteSession(
    clientId: string,
    id: string,
    sessionCwd?: string,
    notifyCatalog = true,
  ): Promise<void> {
    const claim = this.reserveSessionLoad(id, this.remoteClients.tabToken(clientId));
    if (!claim) {
      const selectedCwd = this.remoteClients.cwd(clientId);
      this.output.appendLine(`[remote] dropped resumeSession (session load is reserved by another view)`);
      this.sendRemoteClient(clientId, {
        type: "error",
        text: "Could not restore this conversation because it is already being opened in another tab or the VS Code view.",
      });
      this.sendRemoteClient(
        clientId,
        this.buildSessionsList(
          selectedCwd,
          undefined,
          this.remoteActiveSessionId(clientId),
        ),
      );
      return;
    }
    if (claim.joined) {
      this.output.appendLine(`[remote] joined in-flight session load for the same logical tab`);
      await claim.reservation.completion;
      return;
    }
    let failure: unknown;
    try {
      await this.openRemoteSessionReserved(clientId, id, claim.reservation, sessionCwd, notifyCatalog);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.releaseSessionLoad(id, claim.reservation, failure);
    }
  }

  /** The repo scope a remote `resumeSession` should run under. Normally the tab's
   *  own selection; when the named session cwd belongs to a different catalog
   *  repo, the tab is moved there first and told about it. Returns the scope to
   *  use. A cwd owned by no catalog repo leaves the selection untouched, so the
   *  caller's existing "not found in selected repo" refusal still fires. */
  private adoptRepoForRemoteSession(
    clientId: string,
    sessionCwd: string | undefined,
    overrides: SessionMetaOverrides,
  ): string {
    const selectedCwd = this.remoteClients.cwd(clientId);
    if (!sessionCwd) return selectedCwd;
    if (sessionCwdBelongsToRepo(sessionCwd, this.sessionCwdsForRepo(selectedCwd, overrides), pathsEqual)) {
      return selectedCwd;
    }
    const owner = this.repoCatalog().find((repo) =>
      repo.available &&
      sessionCwdBelongsToRepo(sessionCwd, this.sessionCwdsForRepo(repo.cwd, overrides), pathsEqual),
    );
    if (!owner) return selectedCwd;
    if (this.remoteVoice.has(clientId)) void this.handleRemoteVoiceStop(clientId, true);
    this.parkRemoteSession(clientId);
    this.remoteClients.select(clientId, owner.cwd);
    this.sendRemoteRepoCatalog(clientId);
    return owner.cwd;
  }

  private async openRemoteSessionReserved(
    clientId: string,
    id: string,
    reservation: SessionLoadReservation,
    sessionCwd?: string,
    notifyCatalog = true,
  ): Promise<void> {
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    // A remote may name a session that lives in a DIFFERENT repo of the catalog
    // it was shown — the projects rail lists every repo's sessions at once, so
    // "open that conversation over there" is now an ordinary click. Move the
    // tab's selection to the owning repo as part of THIS operation instead of
    // refusing it.
    //
    // Deliberately not two messages: `selectRepo` opens that repo's newest
    // session on its own, so a client that switched and then resumed would race
    // its own switch and load a session the user did not pick. The isolation
    // this replaces is unchanged in substance — the cwd must still belong to a
    // repo in the catalog (`remoteTargetableCwd` already gated it inbound), and
    // a cwd owned by no catalog repo still falls through to the refusal below.
    const selectedCwd = this.adoptRepoForRemoteSession(clientId, sessionCwd, overrides);
    const allowedCwds = this.sessionCwdsForRepo(selectedCwd, overrides);
    const conflictingOwner = this.remoteClients.clients().find((ownerId) =>
      ownerId !== clientId && this.remoteClients.active(ownerId)?.activeSessionId === id
    );
    // Tabs stay mutually exclusive: each browser tab is its own conversation,
    // and the duplicate-tab theft guard builds on that. The VS Code view is
    // NOT a rival tab — a session open (or parked) at the desk is joined, not
    // refused: emit() fans every frame of a session to the focused webview and
    // to each remote holder, so the desk and the phone stay in sync.
    if (conflictingOwner) {
      this.output.appendLine(`[remote] dropped resumeSession (session is open in another tab)`);
      this.sendRemoteClient(clientId, {
        type: "error",
        text: "Could not restore this conversation because it is already open in another tab.",
      });
      this.sendRemoteClient(
        clientId,
        this.buildSessionsList(
          selectedCwd,
          undefined,
          this.remoteActiveSessionId(clientId),
        ),
      );
      return;
    }
    for (const session of this.pool) {
      if (session.activeSessionId === id && session.client) {
        if (!sessionCwdBelongsToRepo(this.sessionCwd(session), allowedCwds, pathsEqual)) {
          this.output.appendLine(`[remote] dropped resumeSession (session cwd does not match selected repo)`);
          this.sendRemoteClient(clientId, {
            type: "error",
            text: "Could not restore this tab's conversation because its repository is no longer selected or available.",
          });
          this.sendRemoteClient(
            clientId,
            this.buildSessionsList(
              selectedCwd,
              undefined,
              this.remoteActiveSessionId(clientId),
            ),
          );
          return;
        }
        this.parkRemoteSession(clientId, session);
        this.dropRemoteVoice(clientId);
        this.focusRemoteSession(clientId, session, notifyCatalog);
        return;
      }
    }
    const cachedCwd = this.sessionCache.get(id)?.entry.cwd;
    const candidates = [...new Set([
      ...(sessionCwd ? [sessionCwd] : []),
      ...(cachedCwd ? [cachedCwd] : []),
      ...allowedCwds,
    ])].filter((cwd) => sessionCwdBelongsToRepo(cwd, allowedCwds, pathsEqual));
    const actualCwd = candidates.find((cwd) =>
      indexSessions({ fs: defaultFs, grokHome: resolveGrokHome(process.env), cwd })
        .some((entry) => entry.id === id),
    );
    if (!actualCwd) {
      this.output.appendLine(`[remote] dropped resumeSession (session was not found in selected repo)`);
      this.sendRemoteClient(clientId, {
        type: "error",
        text: "Could not restore this tab's previous conversation. It may have been deleted, or its repository may no longer be available. Start a new session explicitly to continue.",
      });
      this.sendRemoteClient(
        clientId,
        this.buildSessionsList(
          selectedCwd,
          undefined,
          this.remoteActiveSessionId(clientId),
        ),
      );
      return;
    }
    const current = this.remoteClients.active(clientId);
    // Mirror of the desk-side adoption: if the DESK still holds this
    // conversation as a clientless object (crashed / reaped focused session),
    // resume INTO that object rather than forking the session directory into
    // a second live process. Other tabs' objects can't reach here — the
    // conflictingOwner guard above refused them regardless of client state.
    const session = current?.activeSessionId === id
      ? current
      : this.focused.activeSessionId === id
        ? this.focused
        : [...this.pool].find((candidate) => candidate.activeSessionId === id && !candidate.client)
          ?? new Session();
    const savedWorktree = overrides[id];
    if (savedWorktree?.worktreePath) {
      session.cwd = actualCwd;
      session.worktree = {
        path: savedWorktree.worktreePath,
        label: savedWorktree.worktreeLabel || path.basename(savedWorktree.worktreePath),
        sourceGitRoot: savedWorktree.sourceGitRoot || selectedCwd,
      };
    } else if (!session.worktree) {
      this.setSessionCwd(session, actualCwd, selectedCwd);
    } else {
      session.cwd = actualCwd;
    }
    this.pool.add(session);
    this.parkRemoteSession(clientId, session);
    this.dropRemoteVoice(clientId);
    this.remoteClients.setActive(clientId, session);
    this.bindSessionLoad(id, reservation, session);
    this.sendRemoteClient(clientId, { type: "clearMessages" });
    await this.startSession(id, session);
    this.markRead(session);
    if (notifyCatalog) this.postRepoCatalog();
    this.sendRemoteSessionList(session, reservation.ownerTabToken);
  }

  /**
   * Open the session with grok id `id`. If it's already live in the pool, re-focus
   * it instantly (lossless buffer replay — no reload). Otherwise park the current
   * session and load this one cold from grok's on-disk history into a fresh member.
   */
  private async openSession(id: string, sessionCwd?: string): Promise<void> {
    const claim = this.reserveSessionLoad(id);
    if (!claim) {
      this.output.appendLine(`[sessions] refused local resume (session load is reserved by another view)`);
      void vscode.window.showInformationMessage(
        "This conversation is already being opened in another tab or view.",
      );
      return;
    }
    let failure: unknown;
    try {
      await this.openSessionReserved(id, sessionCwd);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.releaseSessionLoad(id, claim.reservation, failure);
    }
  }

  private async openSessionReserved(id: string, sessionCwd?: string): Promise<void> {
    // A session held by a remote tab is not off-limits here: the desk JOINS it
    // — focusSession replays the shared buffer into the webview and already
    // mirrors the replay to remote holders, and emit() keeps serving both
    // views from then on.
    for (const s of this.pool) {
      if (s.activeSessionId === id && s.client) {
        this.focusSession(s);
        return;
      }
    }
    this.parkFocused();
    // A remote tab may still hold this conversation as a CLIENTLESS object
    // (its CLI crashed, or it was LRU-reaped — the mapping deliberately
    // survives so the tab reloads on its next send). Cold-loading a NEW
    // object here would hand the same Grok session directory to two live
    // processes the moment both views touch it — adopt the held object
    // instead, so this restart lands in BOTH views.
    const held = this.remoteClients.clients()
      .map((clientId) => this.remoteClients.active(clientId))
      .find((s): s is Session => !!s && s.activeSessionId === id);
    this.focused = held ?? this.newLocalSession();
    this.pool.add(this.focused);
    // Resolve cwd: explicit (history row) → meta worktree → cache → workspace.
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const o = overrides[id];
    const cwd =
      sessionCwd ||
      o?.worktreePath ||
      this.sessionCache.get(id)?.entry.cwd ||
      this.workspaceRoot();
    this.focused.cwd = cwd;
    if (o?.worktreePath) {
      this.focused.worktree = {
        path: o.worktreePath,
        label: o.worktreeLabel || path.basename(o.worktreePath),
        sourceGitRoot: o.sourceGitRoot || this.workspaceRoot(),
      };
    } else {
      const hit = matchWorktreeForCwd(cwd, worktreesForRepo(this.worktreeCache, this.workspaceRoot(), { includeDead: true }));
      if (hit) {
        this.focused.worktree = {
          path: hit.path,
          label: hit.label,
          sourceGitRoot: hit.sourceRepo || this.workspaceRoot(),
          id: hit.id,
        };
      }
    }
    await this.startSession(id);
    this.markRead(this.focused); // opening a cold session clears its unread badge
    this.postRepoCatalog();
  }

  /** Reveal the panel AND move keyboard focus into the composer, so every flow
   *  that adds an attachment (Send Selection / Send File / @-mention, the "+"
   *  file picker, image paste) leaves the user ready to type a prompt (#43).
   *  show(false) takes focus to the view; the focusInput message then lands the
   *  caret in the textarea itself. This matters even for the picker/paste flows:
   *  the native file dialog returns focus to the editor on close, and a plain
   *  Send Selection would otherwise leave focus in the editor. */
  private revealAndFocusComposer(): void {
    this.view?.show?.(false);
    this.post({ type: "focusInput" });
  }

  private watchActiveEditor(): void {
    this.editorWatcher?.dispose();
    this.editorWatcher = vscode.Disposable.from(
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshImplicitChip()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        // Split editors can hold several TextEditors on one document — only the
        // active one's selection drives the context chip.
        if (e.textEditor !== vscode.window.activeTextEditor) return;
        this.refreshImplicitChip();
      }),
    );
  }

  /** The remembered eye-off choice for the active-editor context chip (#67).
   *  Defaults to visible — this only ever reflects an explicit click. */
  private implicitChipHidden(): boolean {
    return this.context.globalState.get<boolean>(IMPLICIT_CHIP_HIDDEN_KEY, false);
  }

  /** Mirror the active editor (file + live selection line range) onto the
   *  implicit context chip. No-op diffing keeps this silent for plain cursor
   *  movement — selection events fire on every caret change, but an empty
   *  selection compares equal to the previous empty one, so nothing is posted.
   *  `forcePost` is for a fresh webview, which needs the current state even
   *  when it hasn't changed. */
  private refreshImplicitChip(forcePost = false): void {
    const includeActive = vscode.workspace
      .getConfiguration("grok")
      .get<boolean>("includeActiveFileByDefault", true);
    const prev = this.chips.find(isImplicitChip);
    const editor = vscode.window.activeTextEditor;

    if (!includeActive || !editor || editor.document.uri.scheme !== "file") {
      // No chip to show — and if one is lingering, the webview must hear about
      // its removal (the old code cleared host-side but never posted).
      this.chips = clearImplicitChips(this.chips);
      if (prev || forcePost) this.postChips();
      return;
    }

    const absPath = editor.document.uri.fsPath;
    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (!editor.selection.isEmpty) {
      const range = selectionLineRange(editor.selection.start, editor.selection.end);
      selStart = range.startLine;
      selEnd = range.endLine;
    }

    if (
      prev &&
      prev.path === absPath &&
      prev.relPath === relPath &&
      prev.selectionStart === selStart &&
      prev.selectionEnd === selEnd
    ) {
      if (forcePost) this.postChips();
      return;
    }

    const next = makeImplicitChip(absPath, relPath, selStart, selEnd);
    next.hidden = implicitChipStartsHidden(prev, this.implicitChipHidden());
    this.chips = clearImplicitChips(this.chips);
    this.chips.push(next);
    this.postChips();
  }

  /** Parse the workspace `.env` into a plain map (no process.env merge). Used by
   *  both the CLI env builder and the voice key resolver. */
  private readDotEnv(cwd: string): Record<string, string> {
    const dotEnv: Record<string, string> = {};
    try {
      const content = fs.readFileSync(path.join(cwd, ".env"), "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key) dotEnv[key] = val;
      }
    } catch { /* no .env — fine */ }
    return dotEnv;
  }

  private warnOAuthShadowOnce(defaultAuthMethodId: unknown, env: NodeJS.ProcessEnv): void {
    if (!oauthShadowsXaiApiKey(defaultAuthMethodId, env)) return;
    if (this.oauthShadowWarningShown || this.context.globalState.get<boolean>(OAUTH_SHADOW_WARNING_KEY, false)) return;
    this.oauthShadowWarningShown = true;
    void this.context.globalState.update(OAUTH_SHADOW_WARNING_KEY, true);
    void vscode.window.showWarningMessage(
      "Grok is using its cached OAuth session, so XAI_API_KEY is currently ignored. To use the API key, run `grok logout`, then start a new session.",
    );
  }

  private buildEnv(cwd: string): NodeJS.ProcessEnv {
    const dotEnv = this.readDotEnv(cwd);
    const env: NodeJS.ProcessEnv = { ...process.env, ...dotEnv };

    // XAI_API_KEY is the generic xAI key name; grok CLI needs GROK_CODE_XAI_API_KEY.
    // Map from either source (workspace .env or the user's shell environment).
    if (env["XAI_API_KEY"] && !env["GROK_CODE_XAI_API_KEY"]) {
      env["GROK_CODE_XAI_API_KEY"] = env["XAI_API_KEY"];
    }

    // Tell the agent which shell dialect to write for — match the shell we
    // actually run its commands under (#46, §2.9). Presence check (not truthiness)
    // so an explicitly-empty user GROK_SHELL ("let grok detect") is honored, not
    // overridden. Frozen at spawn: a mid-session `grok.terminalShell` toggle
    // updates the shell we RUN commands under (cache cleared) but not this env,
    // so the dialect hint realigns on the next session — acceptable for a rare
    // escape-hatch toggle.
    if (!("GROK_SHELL" in env)) {
      const grokShell = grokShellEnvValue(resolvedTerminalShell(), process.platform);
      if (grokShell) env["GROK_SHELL"] = grokShell;
    }

    if (Object.keys(dotEnv).length > 0) {
      this.output.appendLine(`[env] loaded ${Object.keys(dotEnv).length} var(s) from .env`);
    }
    return env;
  }

  // ---------- remote control (thin client only — the relay server and web
  // client are a separate project) ----------

  /** v1 ships one capability tier — every paired remote is fully trusted
   *  (decision 2026-07-16). The policy module supports read-only/propose for a
   *  later per-device setting. */
  private static readonly REMOTE_TIER: RemoteTier = "full";

  /** Longest edge of the render a remote gets when it taps a thumbnail. Big
   *  enough to read a screenshot on a phone, small enough not to push a
   *  multi-megabyte frame over a mobile connection for a single tap. */
  private static readonly FULL_IMAGE_MAX_EDGE = 1600;
  private static readonly FULL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
  /** How many enlargeable images a session remembers. Bounded because the map
   *  is keyed by a handle we mint per path and never otherwise expire. */
  private static readonly FULL_IMAGE_HANDLE_LIMIT = 300;

  /** handle -> path, and its inverse so the same picture keeps one handle
   *  across replays instead of minting a new one on every reconnect. */
  private readonly fullImagePaths = new Map<string, string>();
  private readonly fullImageHandles = new Map<string, string>();

  /** Mint (or reuse) the handle for a path we are about to show a remote. */
  private registerFullImage(imagePath: string): string {
    const existing = this.fullImageHandles.get(imagePath);
    if (existing) return existing;
    const handle = randomUUID().replace(/-/g, "");
    this.fullImageHandles.set(imagePath, handle);
    this.fullImagePaths.set(handle, imagePath);
    while (this.fullImagePaths.size > GrokSidebar.FULL_IMAGE_HANDLE_LIMIT) {
      const oldest = this.fullImagePaths.keys().next().value;
      if (oldest === undefined) break;
      const stalePath = this.fullImagePaths.get(oldest);
      this.fullImagePaths.delete(oldest);
      if (stalePath && this.fullImageHandles.get(stalePath) === oldest) {
        this.fullImageHandles.delete(stalePath);
      }
    }
    return handle;
  }

  /** Render a bigger version for a remote's tap. Undefined when the source is
   *  gone (the seven-day sweep, or a deleted original) or will not fit — the
   *  browser then keeps the thumbnail it already has rather than blanking. */
  private async renderFullImage(imagePath: string): Promise<string | undefined> {
    try {
      const bytes = await fs.promises.readFile(imagePath);
      const thumb = thumbnailImage(bytes, guessMediaMime(imagePath), GrokSidebar.FULL_IMAGE_MAX_EDGE);
      if (!thumb || thumb.byteLength === 0 || thumb.byteLength > GrokSidebar.FULL_IMAGE_MAX_BYTES) {
        return undefined;
      }
      return `data:${thumbnailMime(thumb)};base64,${Buffer.from(thumb).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  /** Impure half of the media inline transform (the decision logic is the pure
   *  remote-policy). Sync read keeps broadcast ordering; media is rare + capped.
   *  Per-instance rather than static: the full-image handles it issues belong to
   *  this provider, and a shared registry would let one window hand out handles
   *  into another's files. */
  private readonly remoteMediaDeps: MediaInlineDeps = {
    registerFullImage: (p) => this.registerFullImage(p),
    thumbnailCache: new Map<string, string | null>(),
    readFile: (p) => {
      try {
        return fs.readFileSync(p);
      } catch {
        return null;
      }
    },
    toBase64: (bytes) => Buffer.from(bytes).toString("base64"),
    thumbnail: (bytes, mimeType, maxDimension) => {
      const thumb = thumbnailImage(bytes, mimeType, maxDimension);
      return thumb ? { bytes: thumb, mime: thumbnailMime(thumb) } : null;
    },
    mtimeMs: (p) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return undefined;
      }
    },
  };

  /** The single inbound choke point for remote clients: capability-gate, then
   *  route into the normal onMessage switch. */
  private handleRemoteMessage(clientId: string, m: WebviewMsg): void {
    try {
      // Compatibility path for a relay/browser pair that still forwards the raw
      // webview ready message in addition to client-ready.
      if (m.type === "ready") {
        this.handleRemoteClientReady(clientId, m.tabToken);
        if (!this.remoteClients.isCurrent(clientId)) return;
        for (const message of this.buildRemoteSnapshot(clientId)) {
          this.sendRemoteClient(clientId, message);
        }
        return;
      }
      if (!allowFromRemote(m.type, GrokSidebar.REMOTE_TIER)) {
        this.output.appendLine(`[remote] dropped ${m.type} (not allowed from a remote client)`);
        return;
      }
      if (!allowRemoteRepoTarget(m, (cwd) => this.remoteTargetableCwd(cwd))) {
        this.output.appendLine(`[remote] dropped ${m.type} (cwd was not discovered)`);
        return;
      }
      if (!this.remoteClients.isCurrent(clientId)) {
        this.output.appendLine(`[remote] dropped ${m.type} from a superseded tab connection`);
        this.sendRemoteClient(clientId, {
          type: "error",
          text: "This page's remote connection was replaced by another tab. Open AFK Pilot in a new tab to reconnect independently.",
        });
        return;
      }
      this.remoteClients.ready(clientId);
      const requester = this.captureRemoteRequester(clientId);
      const transition = async (currentClientId: string) => {
        if (m.type === "newSession") {
          await this.newRemoteSession(currentClientId);
        } else if (m.type === "resumeSession") {
          await this.openRemoteSession(currentClientId, m.id, m.cwd);
        } else if (m.type === "selectRepo") {
          await this.selectRemoteRepo(currentClientId, m.cwd);
        }
      };
      const operation = serializesRemoteSessionTransition(m.type)
        ? this.remoteClients.runSessionTransition(
            clientId,
            m.type === "resumeSession" ? m.id : undefined,
            transition,
          )
        : m.type === "send"
          ? this.remoteClients.runAfterSessionTransition(
              clientId,
              (currentClientId) => this.onMessage(m, "remote", currentClientId),
            )
          : this.onMessage(m, "remote", clientId);
      void operation.catch((e) => {
        const detail = (e as Error)?.message ?? String(e);
        this.output.appendLine(`[remote] ${m.type} failed: ${detail}`);
        this.sendRemoteRequester(requester, {
          type: "error",
          text: `Grok: ${m.type} failed — ${detail}`,
        });
      });
    } catch (e) {
      this.output.appendLine(`[remote] dropped malformed frame: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  private handleRemoteClientReady(clientId: string, tabToken?: string): void {
    if (tabToken) {
      const superseded = this.remoteClients.identify(clientId, tabToken);
      if (superseded) {
        this.dropRemoteVoice(superseded);
        this.sendRemoteClient(superseded, {
          type: "error",
          text: "This page's remote connection was replaced by another tab. Open AFK Pilot in a new tab to reconnect independently.",
        });
        this.output.appendLine(`[remote] handed tab ownership from ${superseded} to ${clientId}`);
      }
    }
    if (!this.remoteClients.isCurrent(clientId)) return;
    // A ready client has rebuilt its page and therefore has no live capture to
    // feed an older host ingress. Drop it before buildRemoteSnapshot inspects
    // remoteVoice, so reconnect cannot resurrect a host-only listening state.
    this.dropRemoteVoice(clientId);
    this.remoteClients.ready(clientId);
    const session = this.remoteSessionFor(clientId);
    // A tab attached to a session with no live process would sit on "Starting"
    // forever — nothing ever emits `initialized`, and the first send would
    // quietly spawn a DIFFERENT conversation. Bring the process up (resuming
    // its id when it has one, so a crashed/reaped conversation reloads its
    // own history). Deferred: the caller sends this client's snapshot
    // synchronously right after we return, and the start's frames must land
    // after it, not race it.
    if (!session.client) {
      setTimeout(() => {
        if (this.remoteClients.active(clientId) !== session) return; // moved on
        if (session.client || this.startingForRemote.has(session)) return;
        this.startingForRemote.add(session);
        this.pool.add(session);
        void this.startSession(session.activeSessionId, session)
          .finally(() => this.startingForRemote.delete(session));
      }, 0);
    }
  }

  private static readonly DEVICE_TOKEN_SECRET = "grok.remoteControl.deviceToken";

  /** Start the relay uplink when a device token is stored (from the link flow).
   *  Idempotent. */
  private async maybeStartUplink(): Promise<void> {
    if (this.uplink) return;
    const token = await this.context.secrets.get(GrokSidebar.DEVICE_TOKEN_SECRET);
    if (!token) return; // not linked yet — the link command starts the uplink itself
    const uplink = new RemoteUplink({
      relayUrl: REMOTE_RELAY_URL,
      token,
      deviceName: deviceDisplayName(os.hostname(), process.platform, os.release()),
      snapshot: (clientId) => this.buildRemoteSnapshot(clientId),
      onClientReady: (clientId, tabToken) => this.handleRemoteClientReady(clientId, tabToken),
      onClientLeft: (clientId) => {
        this.releaseRemoteClient(clientId);
      },
      onClientRoster: (clientIds) => this.retainRemoteClients(clientIds),
      onCredentialRevoked: () => {
        void this.handleRemoteCredentialRevoked(token, uplink);
      },
      onClientMessage: (clientId, m) => this.handleRemoteMessage(clientId, m),
      log: (l) => this.output.appendLine(l),
    });
    this.uplink = uplink;
    uplink.start();
    this.refreshKeepAwake();
  }

  private async handleRemoteCredentialRevoked(
    revokedToken: string,
    revokedUplink: RemoteUplink,
  ): Promise<void> {
    // A replaced/disposed uplink may deliver a late close event. Only the
    // currently-owned connection is allowed to clear the credential it used.
    if (this.uplink !== revokedUplink) return;
    const storedToken = await this.context.secrets.get(GrokSidebar.DEVICE_TOKEN_SECRET);
    if (this.uplink !== revokedUplink || storedToken !== revokedToken) return;

    this.clearRemoteRuntime();
    this.post({ type: "remoteStatus", linked: false });
    try {
      await this.context.secrets.delete(GrokSidebar.DEVICE_TOKEN_SECRET);
    } catch (e) {
      this.output.appendLine(`[remote] failed to clear revoked device token: ${(e as Error)?.message ?? e}`);
      const retry = "Retry unlink";
      void vscode.window.showErrorMessage(
        "AFK Pilot access was revoked, but the stored device token could not be cleared.",
        retry,
      ).then((choice) => {
        if (choice === retry) void vscode.commands.executeCommand("grok.unlinkRemote");
      });
      return;
    }

    const relink = "Link this device again";
    void vscode.window.showWarningMessage(
      "AFK Pilot access for this device was revoked, so it has been unlinked. Link it again to continue remotely.",
      relink,
    ).then((choice) => {
      if (choice === relink) void vscode.commands.executeCommand("grok.linkRemote");
    });
  }

  private clearRemoteRuntime(): void {
    this.uplink?.dispose();
    this.uplink = undefined;
    this.stopVoiceInput();
    this.remoteClients.clear();
    this.refreshKeepAwake();
  }

  /** Re-assert the wake lock against the current (setting, linked) state. Called
   *  after every event that can change either; both start and stop are
   *  idempotent, so callers never have to know the previous state. Wrapped
   *  because keeping the machine awake is never worth failing a link/unlink or a
   *  config change over. */
  private refreshKeepAwake(): void {
    try {
      const enabled = vscode.workspace.getConfiguration("grok").get<boolean>("remote.keepAwake", true);
      if (shouldKeepAwake({ enabled, linked: !!this.uplink })) this.keepAwake.start();
      else this.keepAwake.stop();
    } catch (e) {
      this.output.appendLine(`[keep-awake] skipped: ${(e as Error)?.message ?? e}`);
    }
  }

  /** "AFK Pilot: Link this device" — the device-code flow against the relay's REST
   *  edge: start a link, open the browser for the (mock for now) approval, poll
   *  until the relay hands back a long-lived device token, store it in secrets,
   *  connect. Mirrors how a CLI links to a web account. */
  async linkRemoteDevice(): Promise<void> {
    const base = httpBaseFromRelayUrl(REMOTE_RELAY_URL);
    try {
      const name = deviceDisplayName(os.hostname(), process.platform, os.release());
      const installId = this.installId();
      // installId() keeps telemetry's synchronous call site; explicitly await
      // the same value here so a first-ever link cannot outrun persistence.
      await this.context.globalState.update(INSTALL_ID_KEY, installId);
      const startRes = await fetch(`${base}/api/link/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Stable per install so the relay can relink this machine instead of
        // minting duplicate device rows for the same hostname.
        body: JSON.stringify({ name, installId }),
      });
      if (!startRes.ok) throw new Error(`link/start ${startRes.status}`);
      const { code } = (await startRes.json()) as { code: string };
      void vscode.env.openExternal(vscode.Uri.parse(`${base}/link?code=${encodeURIComponent(code)}`));
      const token = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Approve this device in the browser (code ${code})…`, cancellable: true },
        (_p, cancel) => this.pollLinkApproval(base, code, cancel),
      );
      if (!token) return; // cancelled / expired — poll loop already surfaced why
      await this.context.secrets.store(GrokSidebar.DEVICE_TOKEN_SECRET, token);
      this.uplink?.dispose();
      this.uplink = undefined;
      await this.maybeStartUplink();
      this.post({ type: "remoteStatus", linked: true });
      void vscode.window.showInformationMessage("Remote device linked — this workspace is now reachable from the web client.");
    } catch (e) {
      void vscode.window.showErrorMessage(`Remote link failed: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  private async pollLinkApproval(base: string, code: string, cancel: vscode.CancellationToken): Promise<string | undefined> {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && !cancel.isCancellationRequested) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`${base}/api/link/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { status: string; token?: string };
      if (body.status === "approved" && body.token) return body.token;
      if (body.status === "expired" || body.status === "unknown") {
        void vscode.window.showErrorMessage("Remote link code expired — run the link command again.");
        return undefined;
      }
    }
    return undefined;
  }

  /** "AFK Pilot: Unlink this device" — drop the token + connection. */
  async unlinkRemoteDevice(): Promise<void> {
    // Best-effort server-side revoke first: without it the device row lingers
    // on the account and keeps counting against the relay's device cap (a
    // locally-unlinked machine used to block relinking at the free tier's
    // 1-device limit). Local unlink proceeds regardless — offline stays a
    // working kill-switch.
    const token = await this.context.secrets.get(GrokSidebar.DEVICE_TOKEN_SECRET);
    if (token) {
      try {
        await fetch(`${httpBaseFromRelayUrl(REMOTE_RELAY_URL)}/api/device/unlink`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        this.output.appendLine(`[remote] server-side unlink failed (local unlink continues): ${(e as Error)?.message ?? e}`);
      }
    }
    await this.context.secrets.delete(GrokSidebar.DEVICE_TOKEN_SECRET);
    this.clearRemoteRuntime();
    this.post({ type: "remoteStatus", linked: false });
    void vscode.window.showInformationMessage("Remote device unlinked.");
  }

  /** Tell the webview whether this machine holds a relay device token (drives
   *  the gear "AFK Pilot" section's sign-in vs account/sign-out items). */
  private async postRemoteStatus(): Promise<void> {
    const token = await this.context.secrets.get(GrokSidebar.DEVICE_TOKEN_SECRET);
    this.post({ type: "remoteStatus", linked: !!token });
  }

  /** Ordered catch-up built from this client's cwd and active remote session. */
  private buildRemoteSnapshot(clientId: string): HostMsg[] {
    const cwd = this.remoteClients.cwd(clientId);
    const session = this.remoteSessionFor(clientId);
    const entries = this.repoCatalog();
    const initial = { ...this.buildInitialStateMsg(), cwd };
    const sessionCwd = this.sessionCwd(session);
    const phrase = this.voiceSetting(sessionCwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
    const snap: HostMsg[] = [];
    snap.push(initial);
    snap.push({ type: "clearMessages" });
    if (!session.replaying) snap.push(...bracketRemoteSnapshot(session.buffer));
    snap.push(...sessionUiSnapshot(session, this.displayMode(session)));
    if (session.queuedSendRequiresRelay && !session.queuedSendDispatch) {
      const text = this.queuedSendReadyText(session);
      if (text) session.queuedSendDispatch = { id: randomUUID(), text };
    }
    if (session.queuedSendDispatch) {
      snap.push({ type: "submitQueuedSend", ...session.queuedSendDispatch });
    }
    snap.push({
      type: "voiceConfigured",
      value: !!this.resolveVoiceApiKey(sessionCwd),
      sendPhrase: phrase,
    });
    const activeVoice = this.remoteVoice.get(clientId);
    if (activeVoice) {
      snap.push({ type: "voiceState", status: activeVoice.finalizing ? "transcribing" : "listening" });
    }
    snap.push({
      type: "repos",
      entries,
      selectedCwd: cwd,
      activeCwd: this.sessionCwd(session),
    });
    snap.push(this.buildSessionsList(cwd, undefined, this.remoteActiveSessionId(clientId)));
    const out: HostMsg[] = [];
    for (const m of snap) {
      const t = transformHostMsgForRemote(m, this.remoteMediaDeps);
      if (t) out.push(t);
    }
    return out;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mediaUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
    const resourceUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "resources", file));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<style>
  /* Critical pre-stylesheet paint. VS Code serves chat.css through its webview
     service worker, which can cold-start a beat after the HTML renders — that
     gap otherwise flashes the welcome screen unstyled on a white background.
     Paint the theme background immediately and hold the welcome invisible;
     chat.css re-reveals it (visibility: visible on .welcome). */
  html, body { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  .welcome { visibility: hidden; }
</style>
<link rel="stylesheet" href="${mediaUri("chat.css")}" />
</head>
<body class="${this.showThinking() ? "" : "thinking-hidden"}" style="--chat-zoom: ${this.chatFontScale()}">

  <header class="top-bar">
    <button id="repo-btn" class="repo-chip" type="button" title="Choose repository"></button>
    <button id="remote-btn" class="icon-btn remote-btn" title="Continue remotely" hidden></button>
    <button id="history-btn" class="icon-btn" title="Session history"></button>
    <button id="new-btn" class="icon-btn" title="New session"></button>
    <div id="repo-popover" class="toolbar-popover repo-popover" hidden></div>
    <div id="history-popover" class="toolbar-popover history-popover" hidden></div>
  </header>

  <main id="messages" class="messages">
    <div class="welcome" id="welcome">
      <span class="welcome-mark" role="img" aria-label="Grok" style="--welcome-mark:url('${resourceUri("grok-icon.svg")}')"></span>
      <h2>Grok Build (Community)</h2>
      <p class="welcome-byline muted">by Paweł Huryn (<a href="https://www.productcompass.pm/" class="muted-link">The Product Compass</a>)</p>
      <p id="welcome-version" class="muted welcome-status-busy"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>Starting</span></p>
      <div id="welcome-onboarding"></div>
    </div>
  </main>

  <footer class="composer">
    <button id="scroll-bottom-btn" class="scroll-bottom-btn" type="button" title="Scroll to bottom"></button>
    <div class="composer-card">
      <div id="attachments" class="attachments"></div>
      <div class="composer-input-wrap">
        <div id="input-highlight" class="input-highlight" aria-hidden="true" dir="auto"></div>
        <textarea id="input" placeholder="Ask Grok..." rows="2" dir="auto"></textarea>
        <button id="mic-btn" class="mic-btn" title="Voice control"></button>
      </div>
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <button id="add-btn" class="icon-btn" title="Add context"></button>
          <button id="gear-btn" class="icon-btn" title="Settings"></button>
          <div class="context-donut" id="donut" title="Context usage">
            <svg width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" fill="none" stroke="var(--vscode-editorWidget-border,#444)" stroke-width="3"/>
              <circle id="donut-arc" cx="8" cy="8" r="6" fill="none" stroke="var(--vscode-charts-green,#4ec9b0)" stroke-width="3" stroke-dasharray="0 999" transform="rotate(-90 8 8)"/>
            </svg>
            <span id="donut-label" class="small muted">0%</span>
          </div>
          <div id="chips"></div>
        </div>
        <div class="toolbar-right">
          <button id="mode-btn" class="toolbar-btn" title="Pick mode"></button>
          <button id="send-btn" class="send"></button>
        </div>
      </div>
    </div>
    <div id="mode-popover" class="toolbar-popover" hidden></div>
    <div id="gear-popover" class="toolbar-popover gear-popover" hidden></div>
    <div id="add-popover" class="toolbar-popover" hidden></div>
    <div id="context-popover" class="toolbar-popover" hidden></div>
    <div id="slash-popover" class="slash-popover" hidden></div>
    <div id="mention-popover" class="slash-popover mention-popover" hidden></div>
  </footer>

  <script nonce="${nonce}">
    // Configure MathJax before its bundle loads. We drive typesetting manually
    // via MathJax.tex2svg (startup.typeset:false), so it never scans the page.
    // svg.fontCache:'local' makes each equation's SVG embed its own glyph paths
    // (self-contained — required for the upcoming SVG/PNG export). enableMenu:false
    // drops the right-click menu (its assets would need network/CSP exceptions).
    // enableAssistiveMml:false is critical: by default MathJax appends a hidden
    // <mjx-assistive-mml> MathML copy of every equation, normally hidden by CSS
    // that MathJax injects when it manages the page. We drive it manually via
    // tex2svg + outerHTML, so that hiding CSS isn't applied and Chromium renders
    // the MathML natively — a visible *second* copy of every equation.
    window.MathJax = {
      tex: { processEnvironments: true, processRefs: true },
      svg: { fontCache: "local" },
      options: { enableMenu: false, enableAssistiveMml: false },
      startup: { typeset: false }
    };
  </script>
  <script nonce="${nonce}" src="${mediaUri("mathjax/tex-svg-full.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("mermaid/mermaid.min.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("webview-helpers.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("chat.js")}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
