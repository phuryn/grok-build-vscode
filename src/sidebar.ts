import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AcpClient, EffortLevel, ExitPlanRequest, PermissionRequest, QuestionRequest } from "./acp";
import { Session, SessionStatus } from "./session";
import { selectReapable, computeDot, Dot } from "./session-pool";
import { resolveVoiceKey, extractGrokAuthKey, parseVoiceCommand, DEFAULT_SEND_PHRASE } from "./voice";
import { VoiceRecorder, transcribeAudio, resolveWindowsAudioDevice } from "./voice-recorder";
import { VoiceStreamer } from "./voice-streamer";
import type { PromptResultMeta } from "./acp-dispatch";
import { MediaRef, addUsage, autoCompactStartedNote, contextUsedFromCompactNotification, errorDetail, gateZeroTokenMeta, isAuthErrorText, isCredentialError, isIncompatibleAgentError, isRateLimitError, isSubagentLifecycleUpdate, parseSessionInfoContext, permissionOutcomeFor, promptErrorText, rateLimitNoticeText, sumUsage, summarizeBackgroundCommand, usageIsRealMeasurement } from "./acp-dispatch";
import { modeToRemember, startsInYolo } from "./mode-prefs";
import { GROK_VIEW_ID, moveViewContainerFor } from "./view-move";
import {
  APTABASE_APP_KEY_PROD,
  buildSessionStartEvent,
  osNameFromPlatform,
  postEvent,
  shouldSendTelemetry,
  OFFICIAL_EXTENSION_ID,
} from "./telemetry";
import { randomUUID } from "node:crypto";
import {
  locateGrokCli,
  extensionWasUpgraded,
  isStdioBrokenGrokVersion,
  parseGrokVersion,
  grokUpdatePolicy,
  shouldReactivelyDowngrade,
  isLockedBinaryError,
  GROK_STDIO_DOWNGRADE_TARGET,
} from "./cli-locator";
import { TerminalManager, grokShellEnvValue, resolvedTerminalShell, setTerminalShellPreference, type ShellPreference } from "./terminal-manager";
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
import { pickRejectOption, shouldRejectPermission } from "./plan-gate";
import { appendPlanEntry, planRestoreSource, truncateResolvedAfter, countsAsUserBubble, decideRestoreState } from "./plan-restore";
import { planReviewFileName, sanitizePlanReviewFilePart } from "./plan-review";
import { GROK_PRIMER, isPrimerText, isPrimerSummary } from "./grok-primer";
import { HostMsg, WebviewMsg } from "./protocol";
import { RemoteUplink } from "./remote-uplink";
import { allowFromRemote, allowRemoteRepoTarget, repoScopeFor, transformHostMsgForRemote, type MediaInlineDeps, type MsgOrigin, type RemoteTier } from "./remote-policy";
import { deviceDisplayName, httpBaseFromRelayUrl, REMOTE_RELAY_URL } from "./remote-frames";
import { KeepAwake, shouldKeepAwake } from "./keep-awake";
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
  normalizeRepoPath,
  readContextUsage,
  readSessionEntries,
  resolveGrokHome,
  sessionsDirFor,
} from "./sessions";
import {
  isGitRepo,
  matchWorktreeForCwd,
  mergeSessionIndexes,
  worktreeCwdsForRepo,
  type WorktreeParentRef,
  normalizeFsPath,
  pathsEqual,
  sanitizeWorktreeLabel,
  worktreeDisplayName,
  worktreesForRepo,
  type WorktreeRecord,
} from "./worktree";
import {
  formatRewindPointDetail,
  formatRewindPointLabel,
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
  archiveTurnBaselines,
  baselineAbsent,
  baselineFromContent,
  baselineToMeta,
  normalizeBaselinePathKey,
  parseShellDeletePaths,
  resolveTurnBaselineMap,
  selectBaselinesForUndo,
  type FileBaseline,
} from "./file-baseline";

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

// History pagination: rows fetched per "page" (initial open + each load-more / search page).
const SESSION_PAGE_SIZE = 100;

// Records the extension version at the last grok-CLI auto-update check, so the
// silent `grok update` fires once per extension upgrade and never on a fresh
// install. See maybeUpdateCliOnUpgrade.
const CLI_UPDATE_VERSION_KEY = "grok.cliUpdateExtVersion";

const execFileAsync = promisify(execFile);

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
  /** The session currently shown in the chat — one member of {@link pool}. */
  private focused = new Session();
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
  // The empty-session sweep only scans the newest N by mtime — empty primer
  // sessions accumulate at the top (a fresh one each open), so this catches them
  // while keeping the one-shot scan bounded on a large store.
  private static readonly SWEEP_SCAN_LIMIT = 300;
  private reaper?: ReturnType<typeof setInterval>;
  /** Guards {@link sweepEmptyPrimerSessions} to one run per activation. */
  private sweptEmptySessions = false;
  private output: vscode.OutputChannel;
  private chips: FileChip[] = [];
  /** Attachment-staging ops still in flight — see trackAttach. */
  private readonly pendingAttach = new Set<Promise<void>>();
  /** Cached findFiles snapshot for the `@` popover (no open-editor merge).
   *  One snapshot serves {@link MENTION_INDEX_TTL_MS}; concurrent queries share
   *  one in-flight build. Open tabs are layered on at read time. */
  private mentionIndex: { at: number; rels: string[]; absByRel: Map<string, string> } | null = null;
  private mentionIndexPromise: Promise<{ rels: string[]; absByRel: Map<string, string> }> | null = null;
  private editorWatcher?: vscode.Disposable;
  private terminalManager = new TerminalManager();
  private voiceRecorder = new VoiceRecorder();
  private voiceTempPath?: string;
  private voiceStreamer?: VoiceStreamer;
  private voiceFinalizing = false;
  // Stored so a "grok send" can transparently restart a fresh stream (each
  // message = one clean utterance) without re-resolving the mic device.
  private voiceStreamCtx?: { key: string; ffmpegPath: string; device?: string; phrase: string; keyterms: string[] };
  private configWatcher?: vscode.Disposable;
  // Remote uplink — outbound wss to the relay (REMOTE_RELAY_URL), active only
  // when a device token is stored (the "Grok: Link Remote Device" / gear
  // sign-in flow). The taps in post()/emit() are no-ops when it's off, so the
  // shipping path is unaffected.
  private uplink?: RemoteUplink;
  // OS wake lock, held for exactly as long as the uplink is (linked device token
  // + live extension host) so an AFK machine can't idle-suspend out from under a
  // remote turn. `grok.remote.keepAwake` is the opt-out. See src/keep-awake.ts.
  private readonly keepAwake = new KeepAwake((l) => this.output.appendLine(l), process.platform, process.pid, os.release());
  // Last-seen "chrome" messages (labels, donut, lists, config echoes) that live
  // OUTSIDE Session.buffer — the buffer replays the chat, this replays the shell.
  // A new remote client's snapshot = these + clearMessages + the focused buffer.
  private stickyChrome = new Map<HostMsg["type"], HostMsg>();
  private static readonly STICKY_CHROME_TYPES = new Set<HostMsg["type"]>([
    "initialState", "session", "modelChanged", "modeChanged", "chips",
    "contextUsage", "sessions", "repos", "queuedSends", "onboarding", "commandsUpdate",
    "grokUpdateStatus", "voiceConfigured", "fontScale", "showThinking", "expandCommandOutputs",
    "soundNotifications",
  ]);
  private cliPath?: string;
  /** History browsing scope. Deliberately independent of the live session cwd. */
  private selectedRepoCwd?: string;
  // Guards the silent grok-CLI auto-update so it runs at most once per activation.
  private cliUpdateChecked = false;
  // Guards the broken-CLI pin (issue #22) so the version probe + downgrade runs
  // at most once per activation. Set only once the CLI is confirmed not-broken or
  // a downgrade succeeds — a failed downgrade leaves it false so a manual restart
  // can retry.
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
  private readonly openDiffsByRequest = new Map<string, { left: vscode.Uri; right: vscode.Uri }>();
  /** In-flight in-chat confirms, keyed by request id — see confirmInChat. */
  private readonly pendingConfirms = new Map<string, (ok: boolean) => void>();
  private confirmSeq = 0;

  constructor(
    private context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ) {
    this.output = output;
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
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "resources"),
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
    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
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
      if (e.affectsConfiguration("grok.includeActiveFileByDefault")) {
        // Apply the toggle immediately: disabling removes a visible context
        // chip right away (not on the next editor event), enabling shows it.
        this.refreshImplicitChip(true);
      }
      if (e.affectsConfiguration("grok.mentionIndexLimit")) {
        // Drop the TTL-cached findFiles snapshot so the next `@` rebuilds with
        // the new cap (otherwise a raise would wait up to MENTION_INDEX_TTL_MS).
        this.mentionIndex = null;
      }
      if (e.affectsConfiguration("grok.terminalShell")) {
        this.applyTerminalShellPref();
      }
      if (e.affectsConfiguration("grok.remote.keepAwake")) {
        this.refreshKeepAwake();
      }
    });
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
   * restart — `newSession` re-applies it before the primer runs, while the agent
   * is still rebindable. Same-agent switches stay live (history intact).
   */
  async switchModel(modelId: string): Promise<void> {
    const client = this.focused.client;
    // Ignore switches fired during the session-start window: the live set_model
    // would race the hidden primer (sometimes landing before the agent locks,
    // sometimes after — see research/model-switch-race-probe.cjs), making the
    // outcome unpredictable. The webview disables the control while busy; this
    // is the backstop for a click already in flight.
    if (!client || this.focused.priming || modelId === client.currentModelId) return;
    const cfg = vscode.workspace.getConfiguration("grok");
    try {
      await client.setModel(modelId);
      await cfg.update("defaultModel", modelId, vscode.ConfigurationTarget.Global);
    } catch (e) {
      if (!isIncompatibleAgentError(e)) {
        vscode.window.showErrorMessage(`Failed to set model: ${(e as Error).message}`);
        return;
      }
      if (!this.focused.hasHistory) {
        // Primer-only session (no real conversation): a cross-agent switch restarts it with a fresh
        // grok id. There's nothing to summarize, so we never prompt here — and we don't leave the
        // abandoned primer-only session cluttering history (repeated switches would pile them up).
        // Drop it after the restart, carrying over any rename the user made.
        const discardId = this.focused.activeSessionId;
        await cfg.update("defaultModel", modelId, vscode.ConfigurationTarget.Global);
        await this.startSession();
        this.discardRestartedEmptySession(discardId);
        return;
      }
      const mode = await this.pickRestartMode("Switching to this model requires a new session.");
      if (!mode) return; // dismissed — keep the current model
      await cfg.update("defaultModel", modelId, vscode.ConfigurationTarget.Global);
      await this.restartSession(mode);
    }
  }

  openModePopover(): void {
    this.post({ type: "openModePopover" });
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
  private displayMode(): "agent" | "plan" | "yolo" {
    if (this.focused.planActive) return "plan";
    if (this.focused.autoApprove) return "yolo";
    return "agent";
  }

  private postMode(): void {
    this.post({ type: "modeChanged", modeId: this.displayMode() });
  }

  /** Whether grok's config.toml forces always-approve (#31). Project
   *  `.grok/config.toml` overrides global `~/.grok/config.toml`. Read fresh on
   *  each session start — it's a couple of small file reads, and the user may
   *  edit the config between sessions. Any read error → false (treat as normal). */
  private configForcesAutoApprove(): boolean {
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    session.planActive = v;
    if (session.client) session.client.planActive = v;
    if (session === this.focused) this.postMode();
  }

  async setMode(modeId: "agent" | "plan" | "yolo"): Promise<void> {
    // Agent/plan/yolo are mutually exclusive. Plan = client write/exec gate;
    // YOLO = auto-approve. Both ride on top of the CLI's agent mode, except
    // Plan which also tells the CLI to plan instead of act. The mode button only
    // ever drives the focused session.
    const session = this.focused;
    // Ignore mode changes until the session exists: before session/new the CLI
    // setMode throws "no session" (and for Plan that error is surfaced to the user).
    // The mode button is disabled while busy; this backstops the toggle-mode command.
    if (!session.client || !session.client.sessionId || session.priming) return;
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
        catch (e) { vscode.window.showErrorMessage(`Couldn't switch mode: ${(e as Error).message}`); }
      }
      return;
    }
    // agent
    this.setPlanActive(session, false); // posts displayMode → "agent"
    if (session.client) {
      try { await session.client.setMode(ACT_MODE_ID); }
      catch (e) { vscode.window.showErrorMessage(`Couldn't switch mode: ${(e as Error).message}`); }
    }
  }

  /**
   * Resolve a plan-review card. The CLI's `exit_plan_mode` treats *any* response
   * as approval, so the protocol verdict is cosmetic — our gate is the real
   * decision. Crucially, this fires *during* the planning prompt's turn, so we
   * only respond here and defer any new prompt/set_mode to `afterTurn`, which
   * runs once that turn completes (handleSend).
   *
   * Three verdicts:
   *  - `approved`: drop gate, return CLI to act mode, send "implement now".
   *  - `rejected`: keep gate up. If the user left a comment, send it as a plain
   *    user message after the turn ends and let grok decide what to do next
   *    (re-plan, ask clarifying questions, etc.) — we don't force a specific
   *    "revise the plan" framing.
   *  - `abandoned`: drop gate (exit plan mode entirely), no follow-up prompt.
   *    The user wants to back out and continue freely.
   *
   * `rejected`/`abandoned` cut off the CLI's false-approval continuation via
   * `cancel()` + a content-only suppression flag. Lifecycle events
   * (`promptComplete`, `agentEnd`) still reach the webview so `busy` clears and
   * the send button re-enables when the cancelled turn finally ends.
   */
  private handleExitPlan(
    requestId: number | string,
    verdict: "approved" | "abandoned" | "rejected",
    comment?: string,
  ): void {
    const session = this.focused;
    const client = session.client;
    if (!client) return;
    const gen = session.gen;
    client.respondExitPlan(requestId, verdict);
    this.persistPlanVerdict(session, verdict);
    // Record the resolution in the session buffer (mirrors permissionResolved)
    // so a re-focus replays the plan card collapsed with its verdict instead of
    // actionable — the live collapse is a webview-only DOM mutation the buffer
    // never captured.
    this.emit(session, { type: "planResolved", requestId, verdict });
    this.setStatus(session, "working"); // a verdict always triggers a follow-up turn

    const feedback = comment?.trim();

    if (verdict === "approved") {
      // Drop the gate now, then once the planning turn ends, return the CLI to
      // act mode and have it implement. The wire-level prompt uses the same
      // [Plan approved] marker the primer trained grok to recognize, so all
      // three verdicts speak a consistent protocol. If the user attached a
      // comment, post it as their user bubble immediately and append it to the
      // wire-level prompt — same pattern as reject/cancel.
      this.setPlanActive(session, false);
      // Responding unblocked grok's planning turn (the CLI treats ANY
      // exit_plan_mode response as approval), and the primer-trained
      // continuation is contentless by design ("I'll wait for your verdict…").
      // Cancel + content-suppress it exactly like reject/cancel do — grok
      // doesn't persist it into replayed history, so live must hide it too;
      // the [Plan approved] follow-up below is the real continuation. No
      // agentReset here (unlike reject): pre-card narration the user already
      // read stays on screen.
      void client.cancel("plan-verdict approved");
      session.suppressPlanReject = true;
      if (feedback) {
        session.userMessageCount += 1;
        this.emit(session, { type: "userMessage", text: feedback, chips: [] });
      }
      this.emit(session, { type: "planProcessing" }); // indicator while we wait for grok
      const promptToGrok = feedback ? `[Plan approved] ${feedback}` : "[Plan approved]";
      session.afterTurn = async () => {
        session.suppressPlanReject = false;
        // Return to the mode the user was in BEFORE planning (#64): if that was
        // Auto-accept, implementation runs without re-prompting; otherwise Agent.
        // `defaultMode` is the last non-plan mode (Plan is never remembered), so
        // it holds exactly the pre-plan choice. The gate was already dropped above.
        const prePlanYolo = vscode.workspace.getConfiguration("grok").get<string>("defaultMode", "") === "yolo";
        session.autoApprove = prePlanYolo;
        this.emit(session, { type: "modeChanged", modeId: prePlanYolo ? "yolo" : "agent" });
        try { await client.setMode(ACT_MODE_ID); } catch { /* CLI usually auto-exits already */ }
        this.emit(session, { type: "agentStart" });
        this.setStatus(session, "working");
        try {
          await this.ensurePrimed(client, session, gen);
          if (gen !== session.gen) return;
          const meta = await client.prompt(promptToGrok);
          if (gen !== session.gen) return;
          this.emit(session, { type: "agentEnd", meta });
          this.setStatus(session, "done");
        } catch (err) {
          if (gen !== session.gen) return;
          this.emit(session, { type: "agentError", text: promptErrorText(err) });
          this.setStatus(session, "error");
        }
      };
      return;
    }

    // rejected / abandoned: cancel the in-flight turn and suppress its content
    // so the false-approval response doesn't reach the screen.
    void client.cancel(`plan-verdict ${verdict}`);
    this.emit(session, { type: "agentReset" });
    session.suppressPlanReject = true;

    // If the user attached a comment, post it as their user bubble IMMEDIATELY
    // (not deferred to afterTurn) so it lands in the conversation right after
    // the verdict click. Same text gets sent to grok later, verbatim — what the
    // user sees IS what grok receives, no wire-level boilerplate prefix.
    if (feedback) {
      session.userMessageCount += 1;
      this.emit(session, { type: "userMessage", text: feedback, chips: [] });
      this.emit(session, { type: "planProcessing" }); // grok will process this comment
    }

    if (verdict === "rejected") {
      // Stay in plan mode. The wire-level prompt is always prefixed with the
      // [Plan rejected] marker the primer trained grok to recognize — even when
      // the user typed a comment, grok needs the unambiguous verdict tag in
      // front of it to distinguish "Reject + free-form note" from a regular
      // user message. The webview's user bubble (posted earlier in this
      // function) still shows just the user's words.
      this.setPlanActive(session, true);
      if (!feedback) {
        this.emit(session, {
          type: "planNotice",
          text: "Plan rejected — staying in Plan mode.",
        });
        this.emit(session, { type: "planProcessing" });
      }
      const promptToGrok = feedback ? `[Plan rejected] ${feedback}` : "[Plan rejected]";
      session.afterTurn = async () => {
        session.suppressPlanReject = false;
        try { await client.setMode("plan"); } catch { /* gate still enforces */ }
        this.emit(session, { type: "agentStart" });
        this.setStatus(session, "working");
        try {
          await this.ensurePrimed(client, session, gen);
          if (gen !== session.gen) return;
          const meta = await client.prompt(promptToGrok);
          if (gen !== session.gen) return;
          this.emit(session, { type: "agentEnd", meta });
          this.setStatus(session, "done");
        } catch (err) {
          if (gen !== session.gen) return;
          this.emit(session, { type: "agentError", text: promptErrorText(err) });
          this.setStatus(session, "error");
        }
      };
      return;
    }

    // abandoned: drop the gate, return to agent mode. The wire-level prompt is
    // always prefixed with the [Plan cancelled] marker (per the primer
    // contract). With a comment, the marker precedes the user's words; without
    // one, the marker stands alone.
    this.setPlanActive(session, false);
    if (!feedback) {
      this.emit(session, {
        type: "planNotice",
        text: "Plan abandoned — switched to Agent mode.",
      });
    }
    const promptToGrok = feedback ? `[Plan cancelled] ${feedback}` : "[Plan cancelled]";
    session.afterTurn = async () => {
      try { await client.setMode(ACT_MODE_ID); } catch { /* best-effort */ }
      if (!feedback) {
        // Plain cancel: the notice above is the whole UX — no dots, no
        // follow-up bubble. The wire-level [Plan cancelled] still goes out
        // (the primer contract needs the verdict), but grok's ack reply is
        // noise: suppressPlanReject stays up through the turn so nothing
        // paints, and agentEnd just releases the composer.
        this.setStatus(session, "working");
        try {
          const meta = await client.prompt(promptToGrok);
          if (gen !== session.gen) return;
          this.emit(session, { type: "agentEnd", meta });
        } catch (err) {
          if (gen !== session.gen) return;
          this.output.appendLine(`[plan-cancel] hidden ack turn failed: ${(err as Error).message}`);
          this.emit(session, { type: "agentEnd" });
        }
        this.setStatus(session, "done");
        return;
      }
      session.suppressPlanReject = false;
      this.emit(session, { type: "agentStart" });
      this.setStatus(session, "working");
      try {
        const meta = await client.prompt(promptToGrok);
        if (gen !== session.gen) return;
        this.emit(session, { type: "agentEnd", meta });
        this.setStatus(session, "done");
      } catch (err) {
        if (gen !== session.gen) return;
        this.emit(session, { type: "agentError", text: promptErrorText(err) });
        this.setStatus(session, "error");
      }
    };
  }

  /** Send the extension's standing instructions ("primer") to grok exactly once
   *  per grok session — teaching it the plan-verdict protocol the CLI's buggy
   *  exit_plan_mode can't convey. It fires EAGERLY and NON-BLOCKING the moment a
   *  session goes live (startSession kicks this off), so the composer is never
   *  held: the user can send immediately, and their first real prompt awaits this
   *  same promise (grok can't run two turns at once) — released the instant the
   *  silent primer acks. The primer's turn is hidden from live chat
   *  (suppressContent drops grok's "ok"); the user's own message bubble + the
   *  Grokking indicator are NOT suppressed (they're not in SUPPRESS_TYPES), so a
   *  send that overlaps the still-running primer shows as sent right away.
   *
   *  Idempotent: returns the existing in-flight promise so a fast send doesn't
   *  start a second primer; resolves immediately once primed. Best-effort — a
   *  failed primer clears the promise so the next send retries, and never throws
   *  to the caller (the plan-gate, not the primer, is the actual enforcement). */
  private ensurePrimed(client: AcpClient, session: Session, gen: number): Promise<void> {
    if (session.primed) return Promise.resolve();
    if (session.primingPromise) return session.primingPromise;
    const promise = (async () => {
      session.suppressContent = true;
      try {
        await client.prompt(GROK_PRIMER);
        if (gen === session.gen) session.primed = true;
      } catch (e) {
        this.output.appendLine(`[primer] failed: ${(e as Error).message}`);
      } finally {
        if (gen === session.gen) session.suppressContent = false;
        // On failure leave the session unprimed and drop the promise so the next
        // outbound prompt retries instead of awaiting a dead one.
        if (!session.primed) session.primingPromise = undefined;
      }
    })();
    session.primingPromise = promise;
    return promise;
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
  private truncateSessionCardsAfterRewind(sessionId: string, surviving: number): void {
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sessionId];
    if (!cur) return;
    const plans = truncateResolvedAfter(cur.plans, surviving);
    const permissions = truncateResolvedAfter(cur.permissions, surviving);
    const usageLog = truncateResolvedAfter(cur.usageLog, surviving);
    const droppedPlans = (cur.plans?.length ?? 0) - plans.length;
    const droppedPerms = (cur.permissions?.length ?? 0) - permissions.length;
    const droppedTurns = (cur.usageLog?.length ?? 0) - usageLog.length;
    if (!droppedPlans && !droppedPerms && !droppedTurns) return;
    // The billing total is DERIVED from the surviving turns, never patched — so
    // rewinding away a turn removes its tokens from the session total instead of
    // leaving the user billed in the UI for a turn that no longer exists. A
    // session with no `usageLog` (recorded before it existed) keeps its stored
    // total rather than dropping to zero: uncorrectable, but not wrong-by-a-lot.
    const usage = cur.usageLog ? sumUsage(usageLog) : cur.usage;
    this.output.appendLine(
      `[rewind] dropped ${droppedPlans} plan card(s) + ${droppedPerms} permission card(s) + ${droppedTurns} usage turn(s) past user message ${surviving}`,
    );
    void this.context.globalState.update(SESSION_META_KEY, {
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
    // Keep the live session + popover in step with what we just persisted.
    const live = [...this.pool].find((s) => s.activeSessionId === sessionId);
    if (live) {
      live.sessionUsage = usage;
      live.lastTurnUsage = undefined;
      this.emit(live, { type: "usage", session: usage });
    }
  }

  private persistPlanVerdict(session: Session, verdict: "approved" | "abandoned" | "rejected"): void {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const planText = session.pendingPlanText || "";
    session.pendingPlanText = "";
    const plans = appendPlanEntry(cur.plans, {
      text: planText,
      verdict,
      afterUserMessage: session.userMessageCount,
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
      { title: pending.title, outcome, toolCallId: pending.toolCallId, afterUserMessage: session.userMessageCount },
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
      const opt = pending.options.find((o) => o.kind === "allow_always")
                ?? pending.options.find((o) => o.kind === "allow_once");
      if (!opt) continue;
      client.respondPermission(requestId, opt.optionId);
      this.emit(session, { type: "permissionResolved", requestId, optionId: opt.optionId });
      this.persistPermissionAnswer(session, requestId, opt.optionId);
      this.closeDiffForRequest(requestId);
      resolved += 1;
    }
    if (resolved > 0) this.setStatus(session, "working"); // the turn resumes
  }

  /** Run and clear any deferred post-turn action set by `handleExitPlan`. */
  private async runAfterTurn(session: Session): Promise<void> {
    const fn = session.afterTurn;
    if (!fn) return;
    session.afterTurn = undefined;
    await fn();
  }

  /**
   * Fire the session's queued sends (#37) as ONE combined prompt — blank-line
   * separated, so grok gets a single turn with full context — once its turn is
   * truly over. Safe to call opportunistically: it no-ops while a turn is in
   * flight (`working`), while a card awaits the user (`needs-you`), while a
   * verdict follow-up is pending (`afterTurn`), during the spawn window
   * (`priming` — no session id to prompt yet), or with no live client. Works
   * for backgrounded sessions too: the flush emits into the session buffer
   * like any other turn, so its bubbles are there when the user swaps back.
   */
  private async maybeFlushQueuedSends(session: Session): Promise<void> {
    if (!session.queuedSends.length) return;
    if (!session.client || session.priming || session.afterTurn) return;
    if (session.status === "working" || session.status === "needs-you") return;
    const combined = session.queuedSends.join("\n\n");
    session.queuedSends = [];
    this.emit(session, { type: "queuedSends", items: [] });
    await this.handleSend(combined, false, session);
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
  private async steerSend(text: string): Promise<void> {
    const session = this.focused;
    const body = (text ?? "").trim();
    if (!body) return;
    if (!session.client || !session.activeSessionId) {
      // No live turn to steer — fall back to the queue rather than drop it.
      return void this.onMessage({ type: "queueSend", text: body }, "local");
    }
    this.emit(session, { type: "userMessage", text: body, chips: [], steer: true });
    try {
      const r = await session.client.interject(body);
      if (r === "unsupported") {
        // Pre-~0.2.96 CLI: latch the button off and hand the text to the queue,
        // which is exactly the behavior Steer was offering to skip.
        this.emit(session, { type: "steerUnavailable" });
        this.emit(session, { type: "agentReset" });
        session.queuedSends.length ? (session.queuedSends[0] += "\n\n" + body) : session.queuedSends.push(body);
        this.emit(session, { type: "queuedSends", items: [...session.queuedSends] });
        void vscode.window.showWarningMessage(
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
  private async forkFocusedSession(): Promise<void> {
    const session = this.focused;
    if (!session.client || !session.activeSessionId) {
      return void vscode.window.showWarningMessage("Start a session before forking it.");
    }
    if (!session.hasHistory) {
      return void vscode.window.showInformationMessage("Nothing to fork yet — this session has no conversation.");
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
        return void vscode.window.showWarningMessage(
          "Forking needs a newer Grok Build CLI. Update via the gear menu → Version & about.",
        );
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
      await this.openSession(r.newSessionId, cwd);
      void vscode.window.showInformationMessage(
        `Forked into "${forkName}". The original conversation is unchanged and is in your session history` +
          (parentName ? ` as "${parentName}"` : "") +
          ". Files on disk were not touched.",
      );
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Fork failed: ${e?.message ?? e}`);
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
    // The hidden primer is a real in-flight prompt that never sets `status`, and
    // grok runs one turn at a time — so without this an Edit clicked just after
    // a reload raced the primer. Await it rather than refusing: it's short, and
    // the user's click was legitimate.
    if (session.primingPromise) {
      await session.primingPromise.catch(() => {});
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
      this.truncateSessionCardsAfterRewind(resumeId, surviving);
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
    // Same race Edit guards: the hidden primer is a real in-flight prompt that
    // never sets `status`, and grok runs one turn at a time.
    if (session.primingPromise) await session.primingPromise.catch(() => {});
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
        // Bubble button: map visible user bubble → wire prompt_index (skips primer).
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
        // by the wire prompt_index — that index counts the hidden primer and
        // marker-only plan verdicts, so it renders as "#1 #2 … #6 #8": a
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
      this.truncateSessionCardsAfterRewind(resumeId, surviving);
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
  ): Promise<void> {
    const cmd = workflowControlCommand(action, displayName);
    if (!cmd) {
      return void vscode.window.showWarningMessage("Missing workflow display name.");
    }
    await this.handleSend(cmd, true);
  }

  /** Workspace folder root (the main checkout for worktree ops). */
  private workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Effective cwd for a session (worktree path or workspace root). */
  private sessionCwd(session: Session = this.focused): string {
    return session.cwd || this.workspaceRoot();
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
          this.focused = new Session();
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
      for (const s of [...this.pool]) {
        if (s.worktree && pathsEqual(s.worktree.path, wt.path)) {
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
      this.focused = new Session();
      this.pool.add(this.focused);
      this.focused.cwd = this.workspaceRoot();
      await this.startSession();
      this.postSessionsList();
      void vscode.window.showInformationMessage(`Removed worktree "${wt.label}".`);
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Remove worktree failed: ${e?.message ?? e}`);
    }
  }

  /** Cached worktree list for the current repo (refreshed on create/list). */
  private worktreeCache: WorktreeRecord[] = [];

  private async refreshWorktreeCache(): Promise<void> {
    const client =
      this.focused.client ||
      [...this.pool].map((s) => s.client).find((c) => !!c);
    if (!client) return;
    try {
      const list = await client.listWorktrees({});
      if (list === "unsupported") return;
      this.worktreeCache = list;
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
    for (const p of worktreeCwdsForRepo({ repoCwd, workspaceRoot: this.workspaceRoot(), worktrees: known })) {
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
    this.postRemote({
      type: "repos",
      entries,
      selectedCwd: this.selectedHistoryCwd(),
      activeCwd,
    });
  }

  private selectRepo(cwd: string): void {
    const hit = this.repoCatalog().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit || !hit.available) return;
    this.selectedRepoCwd = hit.cwd;
    this.postRepoCatalog();
    this.postSessionsList();
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
  }): Promise<void> {
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
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const defaultUri = folder
        ? vscode.Uri.joinPath(folder, defaultName)
        : vscode.Uri.file(defaultName);
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
    this.focused = new Session();
    // shellPath/shellArgs, not sendText — a quoted path typed into PowerShell
    // is a parser error (see runMcpList).
    vscode.window.createTerminal({ name: "Grok Logout", shellPath: cliPath, shellArgs: ["logout"] });
    this.post({ type: "clearMessages" });
    this.post({ type: "onboarding", state: "auth-required" });
  }

  dispose(): void {
    if (this.reaper) { clearInterval(this.reaper); this.reaper = undefined; }
    this.uplink?.dispose();
    this.uplink = undefined;
    try { this.keepAwake.stop(); } catch { /* the pid watcher reaps it anyway */ }
    void this.disposePool();
    this.editorWatcher?.dispose();
    this.configWatcher?.dispose();
    this.terminalManager.disposeAll();
    this.voiceRecorder.cancel();
    this.voiceStreamer?.cancel();
    try { if (this.voiceTempPath) fs.unlinkSync(this.voiceTempPath); } catch { /* best effort */ }
  }

  // ---------- internals ----------

  private async ensureClient(): Promise<AcpClient | undefined> {
    if (this.focused.client) return this.focused.client;
    // After a CLI crash the focused session keeps its grok id but loses its
    // client — respawn by RESUMING that id, so the next send continues the same
    // conversation (a bare startSession would open a blank-context session
    // under the old transcript). Fresh/unstarted sessions have no id and start
    // clean as before.
    return this.startSession(this.focused.activeSessionId);
  }

  /** Read `grok --version` for the policy checks. Returns "" on failure (logged). */
  private async readGrokVersion(cliPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(cliPath, ["--version"], { timeout: 30_000 });
      return stdout?.trim() ?? "";
    } catch (e) {
      this.output.appendLine(`grok --version failed: ${(e as Error).message}`);
      return "";
    }
  }

  /**
   * Silently update the grok CLI when *our extension* was upgraded since the last
   * run (the user opted into silent updates). Runs once per activation, before we
   * spawn grok — so no grok process holds the binary open (matters on Windows) and
   * the next `initialize` reports the new version on the welcome screen. Never on a
   * fresh install (no prior version recorded), never blocking: a failed/slow update
   * is logged and we proceed with the current binary. Respects the update policy
   * (issue #22) so it never pulls the CLI onto an unsupported build on Windows.
   */
  private async maybeUpdateCliOnUpgrade(cliPath: string): Promise<void> {
    if (this.cliUpdateChecked) return;
    this.cliUpdateChecked = true;
    const current = (this.context.extension.packageJSON as { version?: string })?.version ?? "";
    const lastSeen = this.context.globalState.get<string>(CLI_UPDATE_VERSION_KEY);
    try {
      if (extensionWasUpgraded(lastSeen, current)) {
        const policy = grokUpdatePolicy(await this.readGrokVersion(cliPath), process.platform);
        if (!policy.allow) {
          // Already at/above the supported ceiling on Windows — updating would land
          // on a broken build (#22). Skip; maybePinBrokenCli corrects a broken one.
          this.output.appendLine(
            `Extension upgraded ${lastSeen} → ${current}; skipping silent CLI update (${policy.note}).`,
          );
        } else {
          const args = policy.target ? ["update", "--version", policy.target] : ["update"];
          this.output.appendLine(
            `Extension upgraded ${lastSeen} → ${current}; updating grok CLI (silent: ${args.join(" ")}).`,
          );
          this.post({ type: "cliUpdating" });
          try {
            const { stdout, stderr } = await execFileAsync(cliPath, args, { timeout: 180_000 });
            if (stdout?.trim()) this.output.appendLine(stdout.trim());
            if (stderr?.trim()) this.output.appendLine(stderr.trim());
          } catch (e) {
            this.output.appendLine(`grok update failed (continuing with current binary): ${(e as Error).message}`);
          }
        }
      }
    } finally {
      // Record the current version regardless, so a fresh install sets the baseline
      // (no update) and the *next* upgrade is the one that triggers.
      void this.context.globalState.update(CLI_UPDATE_VERSION_KEY, current);
    }
  }

  /**
   * Pin the grok CLI to the supported version when it's on a build with the Windows
   * `agent stdio` regression (issue #22) — 0.2.61–0.2.70 hang at startup (the agent
   * doesn't read stdin until EOF, which never comes for a live client), so a session
   * can't start at all. We detect that bounded range from `grok --version` *before*
   * spawning and run `grok update --version <supported>` to move onto the fixed build
   * (0.2.72). Runs at most once per activation; best-effort — a failed probe or pin is
   * logged and we proceed (the user still gets the actionable start-failure error).
   * Once a newer Windows-verified build ships, bump `GROK_STDIO_DOWNGRADE_TARGET` and
   * widen the broken range to include the now-superseded builds.
   */
  private async maybePinBrokenCli(cliPath: string): Promise<void> {
    if (this.brokenCliPinned) return;
    const versionOutput = await this.readGrokVersion(cliPath);
    if (!versionOutput) {
      // Couldn't read the version — don't block startup; let the spawn proceed.
      return;
    }
    if (!isStdioBrokenGrokVersion(versionOutput, process.platform)) {
      this.brokenCliPinned = true; // healthy build — no need to re-probe this activation
      return;
    }
    const detected = parseGrokVersion(versionOutput)?.join(".") ?? versionOutput;
    // A failed downgrade leaves brokenCliPinned false so a manual restart can retry.
    if (await this.downgradeBrokenCli(cliPath, detected, "proactive")) this.brokenCliPinned = true;
  }

  /**
   * Run `grok update --version <supported>` (0.2.72) and notify the user, returning
   * true on success. Shared by the proactive pin (`maybePinBrokenCli`, before spawn —
   * moves a 0.2.61–0.2.70 build *up* to 0.2.72) and the reactive recovery (after an
   * observed startup failure on a future build *above* 0.2.72 — a downgrade).
   * Best-effort: a failure is logged and returns false. Every pin surfaces a one-time
   * notification.
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
      const { stdout, stderr } = await execFileAsync(
        cliPath,
        ["update", "--version", GROK_STDIO_DOWNGRADE_TARGET],
        { timeout: 180_000 },
      );
      if (stdout?.trim()) this.output.appendLine(stdout.trim());
      if (stderr?.trim()) this.output.appendLine(stderr.trim());
      void vscode.window.showInformationMessage(
        reason === "reactive"
          ? `Grok CLI ${fromVersion} failed to start a session (issue #22). Switched to the ` +
              `supported version ${GROK_STDIO_DOWNGRADE_TARGET} and retrying.`
          : `Grok CLI ${fromVersion} has the issue #22 stdio bug that prevents the extension from ` +
              `starting a session. Pinned to the supported version ${GROK_STDIO_DOWNGRADE_TARGET}.`,
      );
      return true;
    } catch (e) {
      this.output.appendLine(`grok downgrade to ${GROK_STDIO_DOWNGRADE_TARGET} failed: ${(e as Error).message}`);
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
      const { stdout } = await execFileAsync(cliPath, ["update", "--check", "--json"], { timeout: 30_000 });
      const info = JSON.parse(stdout) as { currentVersion?: string; latestVersion?: string; updateAvailable?: boolean };
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
   * Connected · v<new>) shows progress. cliUpdateChecked is already set, so
   * startSession's silent path won't re-run the update.
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
    this.focused = new Session();
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
  private async runGrokUpdate(cliPath: string, updateArgs: string[]): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout, stderr } = await execFileAsync(cliPath, updateArgs, { timeout: 180_000 });
        if (stdout?.trim()) this.output.appendLine(stdout.trim());
        if (stderr?.trim()) this.output.appendLine(stderr.trim());
        return;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === 0 && isLockedBinaryError(msg)) {
          this.output.appendLine("grok update hit a locked binary; pausing then retrying once…");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        this.output.appendLine(`grok update failed: ${msg}`);
        void vscode.window.showWarningMessage(`Grok Build update failed: ${msg}`);
        return;
      }
    }
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
  private async restartSession(mode: "clear" | "summarize"): Promise<void> {
    if (mode === "clear") {
      this.emit(this.focused, { type: "clearMessages" });
      await this.startSession();
      return;
    }
    const currentClient = this.focused.client;
    this.emit(this.focused, { type: "summarizing" });
    const chunks: string[] = [];
    const captureChunk = (t: string) => chunks.push(t);
    currentClient?.on("messageChunk", captureChunk);
    this.focused.suppressContent = true;
    try {
      await currentClient?.prompt(
        "Summarize our conversation so far in a concise paragraph. Be brief.",
      );
    } catch { /* best effort */ } finally {
      currentClient?.off("messageChunk", captureChunk);
      this.focused.suppressContent = false;
    }
    const summary = chunks.join("").trim();

    await this.startSession(); // resets suppressContent + eagerly kicks off the primer

    if (summary && this.focused.client) {
      // Await the eager primer FIRST (it manages its own suppression and ends with
      // suppressContent=false), THEN re-assert suppression for the hidden summary
      // injection. Doing it the other way round would let the primer's completion
      // clear the flag mid-summary and leak "[Context from previous session]".
      await this.ensurePrimed(this.focused.client, this.focused, this.focused.gen);
      this.emit(this.focused, { type: "sessionContext" });
      this.focused.suppressContent = true;
      try {
        await this.focused.client.prompt(`[Context from previous session]\n${summary}`);
      } catch { /* best effort */ } finally {
        this.focused.suppressContent = false;
      }
    }
  }

  /** A model/effort switch on a primer-only session (no real conversation) restarts it with a new
   *  grok session id. grok already persisted the abandoned one, so without this each repeated switch
   *  would pile another empty session into history. Drop the old session's on-disk dir and carry any
   *  user rename (`customName`) onto the new session so the chosen name survives the restart. The
   *  caller must only invoke this when the prior session genuinely had no history. No-op if the ids
   *  match or the old session was never persisted. */
  private discardRestartedEmptySession(oldId: string | undefined): void {
    const newId = this.focused.activeSessionId;
    if (!oldId || oldId === newId) return;
    // Restart keeps the same session.cwd (workspace or worktree).
    const cwd = this.sessionCwd(this.focused);
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

  private async startSession(resumeId?: string): Promise<AcpClient | undefined> {
    // The session this start (re)builds. Today always the focused one (pool-of-1);
    // Step D passes a pool member. Its handlers close over `session`/`gen` so a
    // backgrounded session's events stay bound to it even after focus moves.
    const session = this.focused;
    const gen = ++session.gen;
    session.buffer = [];
    session.status = "idle";
    // Stop any in-progress voice capture so listening never carries across a
    // new/resumed/restarted session (covers New Session, history resume, and
    // model/effort restarts — all of which route through here).
    this.stopVoiceInput();
    session.client?.dispose();
    session.client = undefined;
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
    const configAutoApprove = this.configForcesAutoApprove();
    session.autoApprove = rememberedYolo || configAutoApprove;
    session.planActive = false;
    session.afterTurn = undefined;
    session.hasHistory = false;
    session.primed = false;
    session.primingPromise = undefined;
    session.suppressContent = false;
    session.suppressPlanReject = false;
    session.lastPlanText = "";
    session.pendingPlanText = "";
    session.userMessageCount = 0;
    session.inUserMessage = false;
    session.activeSessionId = undefined;
    session.titleGenerated = false;
    session.firstUserMessageForTitle = undefined;
    session.priming = true;
    // session.authRecoveryTried deliberately NOT reset here: recoverAuthAndResend
    // calls startSession as its own retry, and a reset would let an entitlement
    // failure (#58) pay a full restart+resend cycle on every prompt. Only a clean
    // turn re-arms it.
    this.emit(session, { type: "modeChanged", modeId: session.autoApprove ? "yolo" : "agent" });
    if (configAutoApprove) this.noticeAlwaysApproveOnce();
    if (resumeId) this.emit(session, { type: "clearMessages" });

    // Lock the composer (spinner, disabled) for the session-start window —
    // start() + newSession()/load — so a prompt can't be sent before the session
    // exists, which would otherwise throw "no session". The primer is NOT sent
    // here; it's deferred to the first real send (ensurePrimed). The success path
    // unlocks once the session is live (below); the failure paths clear it too.
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

    // If our extension was upgraded, silently bring the CLI up to date *before*
    // spawning it (once per activation). Bail if a newer start superseded us.
    await this.maybeUpdateCliOnUpgrade(cliPath);
    if (gen !== session.gen) return undefined;

    // If the (possibly just-updated) CLI is on a build with the Windows stdio
    // regression (issue #22, builds 0.2.61–0.2.70), pin it to the supported version
    // (0.2.72) before we spawn — otherwise the ACP handshake hangs forever. Runs after
    // the silent update so it corrects an upgrade that landed on a still-broken build.
    await this.maybePinBrokenCli(cliPath);
    if (gen !== session.gen) return undefined;

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
      // First-touch baseline before the write mutates disk (undo / openDiff).
      await this.captureFileBaseline(session, p);
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
    // Wrap the shared terminal manager so shell deletes pre-read paths *before*
    // the command runs (async would race Remove-Item — use sync reads here).
    const tm = this.terminalManager;
    client.terminal = {
      create: (params) => {
        this.captureDeleteBaselinesSync(session, params.command || "");
        return tm.create(params);
      },
      output: (id) => tm.output(id),
      waitForExit: (id) => tm.waitForExit(id),
      kill: (id) => tm.kill(id),
      release: (id) => tm.release(id),
    };

    client.on("initialized", (init) => {
      if (gen !== session.gen) return;
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
        // CLI entered plan mode (covers the agent self-initiating it from a
        // natural-language request). Raise our gate so the exit is enforced.
        session.autoApprove = false;
        this.setPlanActive(session, true);
      } else if (session === this.focused) {
        // CLI reports a non-plan mode. Do NOT auto-drop the gate here: the buggy
        // exit_plan_mode emits "default" even when the user chose to keep
        // planning. The gate is lowered only by explicit user action (approve,
        // or pick Agent/YOLO). Just refresh the button label.
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
      // Hidden host-initiated turns (the pre-rail post-/compact /session-info
      // fallback) need the reply text; the emit below is suppressed for them
      // (suppressContent).
      if (session.captureAgentText !== undefined) session.captureAgentText += text;
      this.emit(session, { type: "messageChunk", text });
    });
    client.on("userMessageChunk", (text: string) => {
      if (gen !== session.gen) return;
      // grok ≥0.2.33 echoes the *live* prompt back as user_message_chunk; 0.2.3
      // did not (its comment here read "the agent never echoes them back"). The
      // live bubble + userMessageCount come from send(), so a forwarded live
      // echo would render a duplicate bubble and double-count. Only the CLI's
      // session/load *replay* should drive user bubbles from here.
      if (!session.replaying) return;
      // Our own hidden primer(s) replay as user messages. Don't count them toward
      // plan positions (the webview hides them too, via its matching
      // PRIMER_PATTERN) but DO forward so the webview can suppress the whole
      // primer turn (its bubble + grok's ack). We deliberately do NOT mark the
      // session primed from this: a primer buried in replayed history isn't
      // reliably honored by grok (a /compact can drop it), so the first
      // post-restore send re-primes instead of trusting the replay.
      if (!session.inUserMessage && isPrimerText(text)) {
        session.inUserMessage = true;
        this.emit(session, { type: "userMessageChunk", text });
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
        if (countsAsUserBubble(text)) session.userMessageCount += 1;
        session.inUserMessage = true;
      }
      // Re-seed the session-scoped [Image #N] counter from replayed prompts so
      // images attached after a restore keep monotonically increasing tags
      // instead of colliding with history's numbering.
      for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
        const n = Number(m[1]);
        if (n > session.imageCounter) session.imageCounter = n;
      }
      this.emit(session, { type: "userMessageChunk", text });
    });
    client.on("thoughtChunk", (text: string) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
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
      this.emit(session, { type: "toolCall", call: u });
    });
    client.on("toolCallUpdate", (u) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
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
      this.accumulateUsage(session, meta);
      // A zero report (stripped above) is /compact or /session-info; neither
      // warrants a donut update here. /session-info leaves the context
      // untouched, and after /compact the fresh count comes from the live
      // auto_compact_completed notification (primary; xaiNotification listener)
      // or the hidden /session-info fallback — reading signals.json now would
      // fetch the stale pre-compact count (the CLI recomputes it only at the
      // next inference turn's end; research/signals-refresh-probe.cjs).
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
        // Mark the live rail as authoritative for the in-flight manual /compact
        // so the pre-rail /session-info fallback + signals.json backup stand down.
        session.sawCompactNotification = true;
      }
      // Compaction FAILED (either path — compaction.rs emits it on both). The
      // context is unchanged, so the donut needs no refresh; mark handled so the
      // /session-info fallback doesn't run, flag it so a manual /compact paints
      // the failure instead of a false "Compacted.", and surface a note.
      if (kind === "auto_compact_failed") {
        session.sawCompactNotification = true;
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
    client.on("subagentLifecycle", (u: unknown) => {
      if (gen !== session.gen) return;
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
      // While planning, decline any mutating permission outright. Agent mode
      // skips this prompt for edits it deems safe — the fs/terminal gate is the
      // real backstop — but if the CLI *does* ask, we say no without bothering
      // the user.
      if (session.planActive && shouldRejectPermission(req.toolCall?.kind, {
        active: true,
        workspaceRoot: cwd,
      })) {
        const rejectId = pickRejectOption(req.options);
        if (rejectId) {
          client.respondPermission(req.id, rejectId);
          this.emit(session, {
            type: "planNotice",
            text: `Plan mode declined a ${req.toolCall?.kind ?? "tool"} request — approve the plan first.`,
          });
          return;
        }
        // No decline option offered — fall through and let the user decide.
      }
      if (session.autoApprove) {
        const opt = req.options.find((o) => o.kind === "allow_always") ??
                    req.options.find((o) => o.kind === "allow_once");
        if (opt) { client.respondPermission(req.id, opt.optionId); return; }
      }
      // Remember it so the answer can be persisted for replay on resume.
      session.pendingPermissions.set(req.id, {
        title: req.toolCall?.title || `permission: ${req.toolCall?.kind || "tool"}`,
        toolCallId: req.toolCall?.toolCallId,
        options: (req.options ?? []).map((o) => ({ optionId: o.optionId, kind: o.kind })),
      });
      this.emit(session, { type: "permissionRequest", req });
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
      // The process is dead — anything queued for it can never send.
      if (session.queuedSends.length) {
        session.queuedSends = [];
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

        // Bracket the replay so the webview can render finalized "Thought"
        // headers (no elapsed time — the original timing isn't in the stream).
        this.emit(session, { type: "historyReplay", active: true });
        session.replaying = true;
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
        } finally {
          session.replaying = false;
          this.emit(session, { type: "historyReplay", active: false });
        }
        session.activeSessionId = resumeId;
        session.titleGenerated = true; // existing session, name already in storage
        session.hasHistory = true;

        // Plan-gate restoration: the CLI replays its own current_mode_update
        // events during loadSession, which our modeChanged handler honors by
        // raising the gate. Override that here with the actual verdict-driven
        // decision (see plan-restore.ts) so a Cancelled or Approved session
        // doesn't come back stuck in Plan mode.
        const decision = decideRestoreState(saved);
        this.setPlanActive(session, decision.planActive);
        const targetMode = decision.cliMode === "plan" ? "plan" : ACT_MODE_ID;
        try { await client.setMode(targetMode); } catch { /* best-effort */ }

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

      // Session is live — unlock the composer now. The "system prompt" (primer)
      // that teaches grok the plan-verdict protocol fires here EAGERLY and in the
      // BACKGROUND (not awaited), on a new OR restored session, so the composer is
      // never blocked waiting on it. The user can send immediately; their first
      // real prompt awaits the same priming promise (ensurePrimed) and is released
      // the instant the silent primer acks. A glance-only restore costs only one
      // cheap background round-trip (the v4 primer no longer explores). See
      // src/grok-primer.ts.
      session.priming = false;
      this.pool.add(session);
      this.touch(session);
      this.reapPool(); // enforce the LRU cap now that the pool grew
      this.emit(session, { type: "setBusy", value: false });
      // After the eager primer acks, fire anything type-ahead-queued during the
      // startup window (#37). ensurePrimed never throws.
      void this.ensurePrimed(client, session, gen).then(() => {
        if (gen === session.gen) void this.maybeFlushQueuedSends(session);
      });
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
        // fixed in 0.2.71. The proactive pin (maybePinBrokenCli) covers that bounded
        // range before spawning; this reactive net is the backstop for a *future*
        // still-broken build above 0.2.72, or when the proactive pin couldn't run
        // (version read failed, or the binary was locked so `grok update` couldn't
        // rename it). We switch to 0.2.72 on the observed failure and retry the spawn
        // once. After the pin the version is 0.2.72, so shouldReactivelyDowngrade()
        // can't loop; a later manual re-upgrade above 0.2.72 re-arms the recovery.
        const version = await this.readGrokVersion(cliPath);
        if (!this.reactiveDowngradeInFlight && shouldReactivelyDowngrade(version, process.platform)) {
          this.reactiveDowngradeInFlight = true;
          try {
            const detected = parseGrokVersion(version)?.join(".") ?? version;
            if (await this.downgradeBrokenCli(cliPath, detected, "reactive")) {
              return await this.startSession(resumeId); // retry the spawn on the supported build
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
            `regression (issue #22, fixed in ${GROK_STDIO_DOWNGRADE_TARGET}). Workaround: run ` +
            `\`grok update --version ${GROK_STDIO_DOWNGRADE_TARGET}\` in a terminal, then start a new session.`,
        });
      } else {
        this.emit(session, { type: "error", text: `Failed to start Grok: ${msg}` });
      }
      return undefined;
    }
    return client;
  }

  private async onMessage(msg: WebviewMsg, origin: MsgOrigin): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postInitialState();
        this.postRepoCatalog();
        break;
      case "send":
        await this.handleSend(msg.text, msg.bare === true);
        break;
      case "newSession":
        await this.newFocusedSession(origin);
        break;
      case "cancel":
        await this.focused.client?.cancel("user Stop click");
        break;
      case "queueSend": {
        // Host-owned per-session queue (#37): the webview renders a mirror from
        // the queuedSends snapshots, so queued messages survive focus switches
        // and flush even while their session is backgrounded. A SINGLE pending
        // message is kept — composing more while one is queued APPENDS to it
        // (blank-line separator, the exact flush format). Separate entries were
        // a fiction: Stop and the flush both collapse them anyway, and per-entry
        // editing broke ordering (an edited entry re-queued at the end).
        const s = this.focused;
        if (typeof msg.text === "string" && msg.text.trim()) {
          if (s.queuedSends.length) s.queuedSends[0] += "\n\n" + msg.text;
          else s.queuedSends.push(msg.text);
          this.emit(s, { type: "queuedSends", items: [...s.queuedSends] });
          // If the turn ended while this message was in flight, fire it now.
          void this.maybeFlushQueuedSends(s);
        }
        break;
      }
      case "dequeueSend": {
        const s = this.focused;
        if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < s.queuedSends.length) {
          s.queuedSends.splice(msg.index, 1);
          this.emit(s, { type: "queuedSends", items: [...s.queuedSends] });
        }
        break;
      }
      case "steerSend":
        await this.steerSend(msg.text);
        break;
      case "forkSession":
        await this.forkFocusedSession();
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
        void vscode.env.openExternal(vscode.Uri.parse(httpBaseFromRelayUrl(REMOTE_RELAY_URL)));
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
        await this.controlWorkflow(msg.action, msg.displayName);
        break;
      case "clearQueuedSends": {
        // Posted by the webview's Stop flow BEFORE the cancel — a halt must not
        // auto-fire queued sends into the cancelled turn's wake.
        const s = this.focused;
        if (s.queuedSends.length) {
          s.queuedSends = [];
          this.emit(s, { type: "queuedSends", items: [] });
        }
        break;
      }
      case "pickModel":
        await this.pickModel();
        break;
      case "setMode":
        await this.setMode(msg.modeId);
        break;
      case "removeChip": {
        // A removed image chip's staged file has no other reference — reclaim
        // it now instead of leaving multi-MB orphans until the weekly sweep.
        const removed = this.chips.find((c) => c.id === msg.id);
        if (removed && isImageChip(removed)) {
          void fs.promises.unlink(removed.path).catch(() => {});
        } else if (removed) {
          const uploadDir = stagedUploadDirectory(this.fileStagingDir(), removed.path);
          if (uploadDir) void fs.promises.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
        }
        this.chips = removeChip(this.chips, msg.id);
        this.postChips();
        break;
      }
      case "toggleChip": {
        this.chips = toggleChip(this.chips, msg.id);
        // Eye-off on the active-editor chip is a standing "don't send what I'm
        // looking at", not a one-file choice — remember it so the next file
        // switch doesn't quietly re-enable the context (#67).
        const toggled = this.chips.find((c) => c.id === msg.id);
        if (toggled && isImplicitChip(toggled)) {
          void this.context.globalState.update(IMPLICIT_CHIP_HIDDEN_KEY, toggled.hidden);
        }
        this.postChips();
        break;
      }
      case "openFile": {
        const ref = parseFileRef(msg.path);
        let p = ref.path;
        if (!path.isAbsolute(p)) {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (root) p = path.join(root, p);
        }
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
          msg.path,
          msg.oldText,
          msg.newText,
          msg.requestId,
          msg.replaceAll,
          msg.sites,
        );
        break;
      case "viewTurnBaseline":
        await this.viewTurnBaseline(msg.turnId, msg.path);
        break;
      case "undoTurnFiles":
        await this.undoTurnFiles(msg.turnId, msg.paths);
        break;
      case "exportExpr":
        await this.exportExpr(msg);
        break;
      case "dropFile":
        await this.trackAttach(this.addDroppedFile(msg.path, msg.shift));
        break;
      case "pasteImage":
        await this.trackAttach(this.addPastedImage(msg.data, msg.mimeType));
        break;
      case "uploadFile":
        await this.trackAttach(this.addUploadedFile(msg.name, msg.data));
        break;
      case "permissionAnswer":
        this.focused.client?.respondPermission(msg.requestId, msg.optionId);
        // Record the resolution in the session buffer so re-focusing this session
        // replays the card collapsed instead of active (the live collapse is a
        // webview-only DOM mutation that the buffer never captured).
        this.emit(this.focused, { type: "permissionResolved", requestId: msg.requestId, optionId: msg.optionId });
        // Persist it (title + outcome) so a cold reload replays a collapsed card —
        // the CLI doesn't replay request_permission on session/load.
        this.persistPermissionAnswer(this.focused, msg.requestId, msg.optionId);
        this.closeDiffForRequest(msg.requestId); // tidy up the auto-opened diff (#21)
        this.setStatus(this.focused, "working"); // turn resumes after the answer
        break;
      case "exitPlanAnswer":
        this.handleExitPlan(msg.requestId, msg.verdict, msg.comment);
        break;
      case "questionAnswer":
        this.focused.client?.respondQuestion(msg.requestId, msg.answers ?? {}, msg.annotations ?? {});
        this.setStatus(this.focused, "working");
        break;
      case "questionCancel":
        this.focused.client?.respondQuestionCancelled(msg.requestId);
        this.setStatus(this.focused, "working");
        break;
      case "setModel":
        await this.switchModel(msg.modelId);
        break;
      case "setEffort": {
        if (this.focused.priming) break; // ignore changes fired mid-session-start (see switchModel)
        const newLevel = msg.level;
        const cfg2 = vscode.workspace.getConfiguration("grok");

        if (!this.focused.hasHistory || !this.focused.client) {
          // As with a model switch on an empty session: restart without the summarize-vs-restart
          // prompt and discard the abandoned primer-only session — but only when it truly had no
          // history (a dead client on a session WITH history must keep that history).
          const wasEmpty = !this.focused.hasHistory;
          const discardId = this.focused.activeSessionId;
          await cfg2.update("defaultEffort", newLevel, vscode.ConfigurationTarget.Global);
          await this.startSession();
          if (wasEmpty) this.discardRestartedEmptySession(discardId);
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
        if (newLevel && this.focused.client.currentModelSupportsEffort()) {
          const applied = await this.focused.client.setReasoningEffort(newLevel).catch(() => false);
          if (applied) {
            await cfg2.update("defaultEffort", newLevel, vscode.ConfigurationTarget.Global);
            break;
          }
        }

        const mode = await this.pickRestartMode("Changing reasoning effort requires restarting the session.");
        if (!mode) break; // dismissed — leave defaultEffort untouched
        await cfg2.update("defaultEffort", newLevel, vscode.ConfigurationTarget.Global);
        await this.restartSession(mode);
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
        const cwd2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        const projCfg = path.join(cwd2, ".grok", "config.toml");
        if (!fs.existsSync(projCfg)) {
          fs.mkdirSync(path.dirname(projCfg), { recursive: true });
          fs.writeFileSync(projCfg, "# Grok project configuration\n# MCP servers here apply to this workspace only.\n");
        }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(projCfg));
        break;
      }
      case "runMcpList": {
        // Run grok as the terminal's own process (shellPath/shellArgs) rather than
        // typing a quoted path into the user's shell. On Windows the default
        // terminal is PowerShell, which parses `"C:\…\grok.exe" mcp list` as a
        // string literal and errors "Unexpected token". Launching the binary
        // directly sidesteps shell quoting entirely and behaves the same on
        // PowerShell, cmd, and POSIX shells.
        const mcpCli = this.cliPath || locateGrokCli(
          vscode.workspace.getConfiguration("grok").get<string>("cliPath", ""),
        );
        const mcpCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const term = mcpCli
          ? vscode.window.createTerminal({ name: "Grok MCP", shellPath: mcpCli, shellArgs: ["mcp", "list"], cwd: mcpCwd })
          : vscode.window.createTerminal("Grok MCP");
        term.show();
        if (!mcpCli) term.sendText("grok mcp list");
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
        // PowerShell is a parser error (see runMcpList).
        const term = vscode.window.createTerminal({ name: "Grok Login", shellPath: cliPath, shellArgs: ["login"] });
        term.show();
        break;
      }
      case "recheckConnection":
        await this.startSession();
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
        this.postSessionsList({ offset: msg.offset, limit: msg.limit, query: msg.query });
        break;
      case "selectRepo":
        this.selectRepo(msg.cwd);
        break;
      case "toggleRepoPin":
        await this.toggleRepoPin(msg.cwd, msg.pinned);
        break;
      case "resumeSession":
        await this.openSession(msg.id, msg.cwd);
        break;
      case "renameSession":
        this.renameSession(msg.id, msg.name);
        break;
      case "deleteSession":
        await this.deleteSession(msg.id, msg.name, origin);
        break;
      case "clearAllSessions":
        await this.clearAllSessions(msg.cwd);
        break;
      case "pickFile":
        await this.trackAttach(this.pickFileFromComputer());
        break;
      case "mentionQuery": {
        // Answer from the TTL-cached index; a failed build degrades to an empty
        // list (the popover just hides) rather than an error surface.
        let files: string[] = [];
        try {
          files = filterMentionFiles((await this.mentionFileIndex()).rels, msg.query);
        } catch (e) {
          this.output.appendLine(`[mention] index failed: ${(e as Error).message}`);
        }
        this.post({ type: "mentionResults", query: msg.query, files });
        break;
      }
      case "addMentionFile": {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) break;

        let catalogMatch: string | undefined;
        let openTabMatch: string | undefined;
        if (origin === "remote") {
          // A remote can only echo a path the host currently exposes through
          // its merged mention catalog. It never gets the local #69 fallback.
          try {
            catalogMatch = (await this.mentionFileIndex()).absByRel.get(msg.relPath);
          } catch (e) {
            this.output.appendLine(`[mention] index failed while validating remote pick: ${(e as Error).message}`);
          }
        } else {
          // Local picks preserve the #69 fallback for a result whose cached/open
          // entry disappeared between rendering and selection.
          catalogMatch = this.mentionIndex?.absByRel.get(msg.relPath);
          openTabMatch = this.openWorkspaceFileEntries().find((e) => e.rel === msg.relPath)?.abs;
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
        await this.trackAttach(this.addDroppedFile(abs, false));
        break;
      }
      case "voiceStart":
        await this.handleVoiceStart();
        break;
      case "voiceStop":
        await this.handleVoiceStop();
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
   * The repo selection is GLOBAL — that is the whole point of the remote
   * switcher: one phone drives whichever project you pick. But VS Code hides
   * that switcher (the window already IS a repository), so a window has no way
   * to show the selection, no way to change it, and no business following it.
   * A remote client tapping another repo must not silently re-scope the local
   * history list or retarget the local *New session* button at a different
   * checkout. So the local webview reads the workspace root and ignores the
   * global selection entirely; only remote clients honour it.
   */
  private historyCwdFor(origin: MsgOrigin): string {
    return repoScopeFor(origin, {
      selectedCwd: this.selectedHistoryCwd(),
      workspaceRoot: this.workspaceRoot(),
    });
  }

  /** Refresh history for both audiences. Each sees its own scope (above), and
   *  the second scan is skipped whenever the two resolve to the same cwd —
   *  which is the normal case, until someone switches repos from a phone. */
  private postSessionsList(opts?: { offset?: number; limit?: number; query?: string }): void {
    const localCwd = this.historyCwdFor("local");
    const remoteCwd = this.historyCwdFor("remote");
    const local = this.buildSessionsList(localCwd, opts);
    this.postLocal(local);
    this.postRemote(pathsEqual(localCwd, remoteCwd) ? local : this.buildSessionsList(remoteCwd, opts));
  }

  private buildSessionsList(
    cwd: string,
    opts?: { offset?: number; limit?: number; query?: string },
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
    const index = mergeSessionIndexes(
      this.sessionCwdsForRepo(cwd, overrides).map((c) => ({
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
    if (!query && offset === 0) {
      const onDisk = new Set(index.map((e) => e.id));
      const seen = new Set(pageEntries.map((e) => e.id));
      const synthetic: SessionListEntry[] = [];
      for (const s of this.pool) {
        const id = s.activeSessionId;
        if (!id || onDisk.has(id) || seen.has(id)) continue;
        const entry = this.liveSessionEntry(s, id, this.sessionCwd(s), overrides);
        if (s.worktree) entry.worktreeLabel = s.worktree.label;
        synthetic.push(entry);
        seen.add(id);
      }
      if (synthetic.length) {
        synthetic.sort((a, b) => b.updatedAt - a.updatedAt);
        pageEntries = [...synthetic, ...pageEntries];
      }
    }

    // A live, still-empty (primer-only) session must read "New session", never grok's
    // primer-derived summary — even after grok flushes summary.json. The truth is in
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
      activeId: this.focused.activeSessionId,
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
   *  The one deliberate departure: a **primer-derived** summary is skipped. We
   *  prime every session with a hidden message, and grok titles the session from
   *  it, so `session_summary` is routinely "… Primer v4 Plan Mode …" — an
   *  internal name for a message the user cannot even see. Inheriting that into a
   *  fork's name propagates the noise forever (fork-of-a-fork), so `isPrimerSummary`
   *  rejects it and we fall through to something real. */
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

  private renameSession(id: string, name: string): void {
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
  private async deleteSession(id: string, _name: string | undefined, origin: MsgOrigin): Promise<void> {
    const overridesNow = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const liveForCwd = [...this.pool].find((s) => s.activeSessionId === id);
    // Last-resort cwd — and this one deletes files, so it resolves in the
    // ASKER's scope. A delete from VS Code must never fall back to a repo that
    // some remote client happens to have selected.
    const cwd =
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
        this.focused = new Session();
        await this.startSession();
      }
    }
    this.postSessionsList();
  }

  /** Delete every session in this workspace's history except the live/focused one (grok
   *  re-persists that, so deleting it wouldn't stick). The webview confirms first (custom
   *  dialog). Tears down any backgrounded live members it deletes and purges their overrides. */
  private async clearAllSessions(requestedCwd: string): Promise<void> {
    const repo = this.repoCatalog().find((r) => pathsEqual(r.cwd, requestedCwd));
    if (!repo) return;
    const cwd = repo.cwd;
    const grokHome = resolveGrokHome(process.env);
    const exceptId = this.focused?.activeSessionId;
    // Count via the cheap stat-only index — no need to parse every summary just to confirm.
    const clearableCount = indexSessions({ fs: defaultFs, grokHome, cwd }).filter(
      (e) => e.id !== exceptId,
    ).length;
    if (clearableCount === 0) {
      void vscode.window.showInformationMessage("No history to clear.");
      return;
    }
    // Confirm lives in the webview (custom dialog) — see deleteSession.

    let removed: string[] = [];
    try {
      removed = clearSessions({ fs: defaultFs, grokHome, cwd, exceptId });
    } catch (e) {
      this.output.appendLine(`[sessions] clear-all failed: ${(e as Error).message}`);
    }

    // Purge our meta overrides + read cache for every removed id.
    if (removed.length) {
      const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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

    // Tear down any backgrounded live pool members we just deleted (the focused one is kept).
    const gone = new Set(removed);
    for (const s of [...this.pool]) {
      if (s !== this.focused && s.activeSessionId && gone.has(s.activeSessionId)) {
        this.disposeSession(s);
      }
    }
    this.postSessionsList();
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
   *  message of `session` (callers gate on isFirstSend, so primers/empty sessions
   *  never reach here). Respects VS Code's global telemetry setting + our own
   *  `grok.telemetry.enabled`; fully fire-and-forget. */
  private reportSessionStart(session: Session): void {
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
      const event = buildSessionStartEvent(
        {
          installId: this.installId(),
          mode: this.displayMode(),
          model: session.client?.currentModelId || cfg.get<string>("defaultModel", "") || "",
          effort: cfg.get<string>("defaultEffort", ""),
          // The three feature flags + the host app. Config values only — the same
          // class of anonymous property as mode/model/effort, never content.
          showThinking: cfg.get<boolean>("showThinking", false),
          expandToolDetails: cfg.get<boolean>("expandCommandOutputs", false),
          steerByDefault: cfg.get<boolean>("steerByDefault", false),
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const cfg = vscode.workspace.getConfiguration("grok");
    this.post({
      type: "voiceConfigured",
      value: !!this.resolveVoiceApiKey(cwd),
      sendPhrase: cfg.get<string>("voiceSendPhrase", DEFAULT_SEND_PHRASE),
    });
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
  private async handleVoiceStart(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const key = this.resolveVoiceApiKey(cwd);
    if (!key) {
      void this.promptVoiceKeySetup();
      this.post({ type: "voiceError" });
      return;
    }
    const cfg = vscode.workspace.getConfiguration("grok");
    const ffmpegPath = cfg.get<string>("ffmpegPath", "") || "ffmpeg";
    const device = cfg.get<string>("voiceInputDevice", "") || undefined;

    // Streaming (default): live transcription over the STT WebSocket, so "grok
    // send" can submit hands-free without a stop-click. Batch is the fallback.
    if (cfg.get<boolean>("voiceStreaming", true)) {
      await this.startVoiceStream(key, ffmpegPath, device, cfg);
      return;
    }

    const tmp = path.join(os.tmpdir(), `grok-voice-${Date.now()}.wav`);
    try {
      await this.voiceRecorder.start({ ffmpegPath, outputPath: tmp, device, log: (m) => this.output.appendLine(m) });
      this.voiceTempPath = tmp;
      this.post({ type: "voiceState", status: "listening" });
    } catch (e) {
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
      this.post({ type: "voiceError" });
    }
  }

  /** Begin a hands-free streaming session. Resolves the mic device once, then
   *  opens a stream; each "grok send" commits the message and restarts a fresh
   *  stream so the mic keeps listening with zero clicks. */
  private async startVoiceStream(
    key: string,
    ffmpegPath: string,
    device: string | undefined,
    cfg: vscode.WorkspaceConfiguration,
  ): Promise<void> {
    const phrase = cfg.get<string>("voiceSendPhrase", DEFAULT_SEND_PHRASE);
    // Bias the model toward the send phrase + "Grok" so it spells them right
    // (fixes the "grok send" → "gronsent" mishearing).
    const keyterms = [...new Set([phrase, "Grok"].map((s) => (s || "").trim()).filter(Boolean))];
    // Resolve the Windows mic once so per-message restarts don't re-enumerate.
    let resolved = device;
    if (process.platform === "win32" && !resolved) {
      try { resolved = await resolveWindowsAudioDevice(ffmpegPath, (m) => this.output.appendLine(m)); } catch { /* streamer surfaces it */ }
    }
    this.voiceStreamCtx = { key, ffmpegPath, device: resolved, phrase, keyterms };
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const fresh = this.resolveVoiceApiKey(cwd);
    if (fresh) ctx.key = fresh;
    const streamer = new VoiceStreamer();
    this.voiceStreamer = streamer;
    const isCurrent = () => this.voiceStreamer === streamer;

    streamer.on("partial", (ev: { text: string; speechFinal: boolean }) => {
      if (!isCurrent()) return;
      this.post({ type: "voicePartial", text: ev.text });
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
      this.output.appendLine(`[voice] stream error: ${e.message}`);
      if (!this.voiceFinalizing) {
        if (/\b(401|403)\b|rejected/i.test(e.message)) {
          void vscode.window.showErrorMessage(e.message, "Open Settings").then((pick) => {
            if (pick === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", "grok.voiceApiKey");
          });
        } else {
          vscode.window.showErrorMessage(`Voice transcription failed: ${e.message}`);
        }
        this.post({ type: "voiceError" });
      }
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
    });

    try {
      await streamer.start({ ffmpegPath: ctx.ffmpegPath, apiKey: ctx.key, device: ctx.device, keyterms: ctx.keyterms, log: (m) => this.output.appendLine(m) });
      if (!isCurrent()) { streamer.cancel(); return; }
      this.post({ type: "voiceState", status: "listening" });
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
      this.post({ type: "voiceError" });
    }
  }

  /** "grok send": submit the message and KEEP listening by restarting a fresh
   *  stream (each message = one clean utterance). No clicks needed. */
  private commitVoiceStream(text: string): void {
    const old = this.voiceStreamer;
    this.voiceStreamer = undefined; // detach so late events are ignored
    old?.cancel();
    if (text.trim()) this.post({ type: "voiceSubmit", text: text.trim() });
    void this.openVoiceStream(); // reuses cached device → fast restart
  }

  /** Stop streaming entirely (manual click, or a self-ended stream): finalize the
   *  remaining transcript and return to idle. */
  private async finalizeVoiceStream(): Promise<void> {
    if (this.voiceFinalizing) return;
    this.voiceFinalizing = true;
    const streamer = this.voiceStreamer;
    this.voiceStreamer = undefined;
    this.voiceStreamCtx = undefined;
    if (!streamer) { this.voiceFinalizing = false; return; }
    this.post({ type: "voiceState", status: "transcribing" });
    let finalText = "";
    try { finalText = await streamer.stop(); } catch { finalText = streamer.transcript; }
    const phrase = vscode.workspace.getConfiguration("grok").get<string>("voiceSendPhrase", DEFAULT_SEND_PHRASE);
    const { text, send } = parseVoiceCommand(finalText, phrase);
    this.voiceFinalizing = false;
    if (!text && !send) {
      this.post({ type: "voiceError" });
      return;
    }
    this.post({ type: "voiceTranscript", text, send });
  }

  /** Hard-stop any voice capture (no transcript) and reset the mic to idle.
   *  Called on session switch/restart so listening never bleeds across sessions. */
  private stopVoiceInput(): void {
    const wasActive = !!this.voiceStreamer || this.voiceRecorder.active;
    this.voiceStreamer?.cancel();
    this.voiceStreamer = undefined;
    this.voiceStreamCtx = undefined;
    this.voiceFinalizing = false;
    this.voiceRecorder.cancel();
    try { if (this.voiceTempPath) fs.unlinkSync(this.voiceTempPath); } catch { /* best effort */ }
    this.voiceTempPath = undefined;
    if (wasActive) this.post({ type: "voiceState", status: "idle" });
  }

  /** Stop recording, transcribe via xAI STT, and send the text to the composer. */
  private async handleVoiceStop(): Promise<void> {
    // Streaming path: finalize the live stream.
    if (this.voiceStreamer) {
      await this.finalizeVoiceStream();
      return;
    }
    if (!this.voiceRecorder.active) {
      this.post({ type: "voiceError" });
      return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const key = this.resolveVoiceApiKey(cwd);
    if (!key) {
      this.voiceRecorder.cancel();
      this.post({ type: "voiceError" });
      return;
    }
    let wavPath: string;
    try {
      wavPath = await this.voiceRecorder.stop();
    } catch (e) {
      this.output.appendLine(`[voice] stop failed: ${(e as Error).message}`);
      vscode.window.showErrorMessage(`Voice recording failed: ${(e as Error).message}`);
      this.post({ type: "voiceError" });
      return;
    }
    this.post({ type: "voiceState", status: "transcribing" });
    try {
      const raw = await transcribeAudio(wavPath, key, (m) => this.output.appendLine(m));
      // Strip a trailing "grok send" (configurable) so dictation can submit
      // hands-free. The webview inserts `text` and, if `send`, fires the send.
      const sendPhrase = vscode.workspace.getConfiguration("grok").get<string>("voiceSendPhrase", DEFAULT_SEND_PHRASE);
      const { text, send } = parseVoiceCommand(raw, sendPhrase);
      if (!text && !send) {
        vscode.window.showInformationMessage("Voice control: nothing was transcribed (silence?).");
        this.post({ type: "voiceError" });
        return;
      }
      this.post({ type: "voiceTranscript", text, send });
    } catch (e) {
      this.output.appendLine(`[voice] transcription failed: ${(e as Error).message}`);
      vscode.window.showErrorMessage((e as Error).message);
      this.post({ type: "voiceError" });
    } finally {
      try { if (this.voiceTempPath) fs.unlinkSync(this.voiceTempPath); } catch { /* best effort */ }
      this.voiceTempPath = undefined;
    }
  }

  private async openDiffEditor(
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
      this.closeDiffForRequest(requestId); // drop a stale diff for the same request first
      this.openDiffsByRequest.set(String(requestId), { left, right });
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
  private closeDiffForRequest(requestId: number | string): void {
    const k = String(requestId);
    const uris = this.openDiffsByRequest.get(k);
    if (!uris) return;
    this.openDiffsByRequest.delete(k);
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
    // Hold onto the plan text until the user picks a verdict so persistPlanVerdict
    // can save it. Cleared (via resolved/pending) so the next plan starts fresh.
    session.pendingPlanText = plan;
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
  private trackAttach(op: Promise<void>): Promise<void> {
    this.pendingAttach.add(op);
    const done = () => { this.pendingAttach.delete(op); };
    void op.then(done, done);
    return op;
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
  private async addUploadedFile(suppliedName: string, data: string): Promise<void> {
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
      this.post({ type: "error", text: `Could not attach document — ${detail}.` });
      return;
    }

    const dir = path.join(this.fileStagingDir(), randomUUID());
    const absPath = path.join(dir, prepared.name);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(absPath, prepared.bytes, { flag: "wx" });
      await this.addDroppedFile(absPath, false);
      this.revealAndFocusComposer();
    } catch (e) {
      void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.output.appendLine(`[upload] staging failed for ${prepared.name}: ${(e as Error).message}`);
      this.post({ type: "error", text: `Could not attach document — ${(e as Error).message}` });
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
    originRelPath?: string,
  ): Promise<void> {
    const dir = this.imageStagingDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `image-${randomUUID()}${extFromMime(mimeType)}`);
    await fs.promises.writeFile(absPath, bytes);
    const imageIndex = ++this.focused.imageCounter;
    this.chips.push(makeImageChip(absPath, imageIndex, mimeType, originRelPath));
    this.postChips();
  }

  /** Clipboard paste from the webview (base64 + mime, already prefiltered to
   *  raster image types there — re-checked here since the webview isn't a
   *  trust boundary). */
  private async addPastedImage(base64: string, mimeType: string): Promise<void> {
    try {
      if (!isVisionMime(mimeType)) {
        void vscode.window.showErrorMessage(`Grok: unsupported image type ${mimeType} — use PNG, JPEG, GIF, or WebP.`);
        return;
      }
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) return;
      if (bytes.length > MAX_VISION_IMAGE_BYTES) {
        void vscode.window.showErrorMessage("Grok: pasted image exceeds the 20 MiB vision limit.");
        return;
      }
      await this.stageImageAttachment(bytes, mimeType);
      this.revealAndFocusComposer();
    } catch (e) {
      this.output.appendLine(`[image] paste failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Grok: could not attach the pasted image — ${(e as Error).message}`);
    }
  }

  /** Copy an on-disk raster image into staging as a vision attachment, keeping
   *  the workspace-relative origin so the prompt tag can carry the real file
   *  identity. Returns false when the file should stay a plain path chip
   *  (oversized, or unreadable as a regular file). */
  private async importImageFromDisk(srcPath: string): Promise<boolean> {
    const stat = await fs.promises.stat(srcPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_VISION_IMAGE_BYTES) return false;
    const bytes = await fs.promises.readFile(srcPath);
    const uri = vscode.Uri.file(srcPath);
    const rel = vscode.workspace.asRelativePath(uri);
    // asRelativePath returns the input unchanged for files outside the
    // workspace — only carry the origin when it's a real workspace-relative path.
    const originRelPath = rel !== srcPath && rel !== uri.fsPath ? rel : undefined;
    await this.stageImageAttachment(bytes, mimeFromPath(srcPath), originRelPath);
    return true;
  }

  private async addDroppedFile(dropped: string, shiftHeld: boolean): Promise<void> {
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
        if (await this.importImageFromDisk(absPath)) return;
      } catch (e) {
        this.output.appendLine(`[image] import failed for ${absPath}: ${(e as Error).message}`);
      }
      // Oversized / unreadable-as-image → fall through to a plain path chip,
      // the pre-vision behavior (grok decides how to consume the path).
    }
    const uri = vscode.Uri.file(absPath);
    const relPath = vscode.workspace.asRelativePath(uri);
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
      this.chips.push(
        totalLines != null
          ? makeExplicitChip(absPath, relPath, 1, totalLines)
          : makeExplicitChip(absPath, relPath),
      );
    } else {
      this.chips.push(makeExplicitChip(absPath, relPath));
    }
    this.postChips();
  }

  private async handleSend(text: string, bare = false, target?: Session): Promise<void> {
    // `target` lets a queued-send flush fire into a BACKGROUNDED session (its
    // turn ended while another was focused). Only the focused session may spawn
    // a client on demand; a background target without one has nothing to talk to.
    const session = target ?? this.focused;
    const client = session.client ?? (session === this.focused ? await this.ensureClient() : undefined);
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
    const chips = bare || session !== this.focused ? [] : [...this.chips];

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

    if (bare || session !== this.focused) {
      if (bare) this.postChips();
    } else {
      // One-shot attachments are consumed by the send; the implicit context
      // chip mirrors IDE state and stays resident (like Claude Code's). Keep
      // it through the clear so refreshImplicitChip sees `prev` — preserving
      // the user's eye-off choice and no-op-diffing against the live editor.
      // Consume by id, not wholesale: a chip staged after the snapshot (while
      // images were pre-reading) belongs to the next turn and must survive.
      this.chips = consumeChips(this.chips, chips);
      this.refreshImplicitChip(true);
    }
    // Staged files are one-shot: their bytes ride the prompt inline now.
    for (const chip of chips) {
      if (isImageChip(chip)) void fs.promises.unlink(chip.path).catch(() => {});
    }

    const isFirstSend = !session.hasHistory;
    session.hasHistory = true;
    if (isFirstSend) {
      // Image-only first message: leave the title source empty so grok's own
      // generated summary shows through, instead of pinning a permanent
      // "[Image #1]" customName over every screenshot-first session.
      session.firstUserMessageForTitle = text;
      // One `session_start` per session, on the first real user message — never
      // the primer (that takes a separate prompt path that doesn't set hasHistory).
      this.reportSessionStart(session);
    }
    const sentChips = chips.filter((c) => !c.hidden);
    session.userMessageCount += 1;
    session.inUserMessage = false; // live send isn't part of the streamed-chunk count path
    this.emit(session, { type: "userMessage", text, chips: sentChips });
    this.emit(session, { type: "agentStart" });
    this.setStatus(session, "working");

    try {
      // The hidden primer was kicked off eagerly when the session went live, so
      // this usually just awaits an already-settled promise. If the user sent
      // before it acked, we hold the real prompt here until it does (grok runs one
      // turn at a time) — the user's bubble already shows as sent and the Grokking
      // indicator covers the gap. If the eager primer failed, this retries it.
      await this.ensurePrimed(client, session, gen);
      if (gen !== session.gen) return;
      // Arm the compact-notification watch BEFORE the prompt: the live
      // auto_compact_completed / auto_compact_failed land DURING this turn.
      if (slashCommand === "compact") {
        session.sawCompactNotification = false;
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
        // Donut refresh, dynamic by CLI capability: the fresh post-compact size
        // lands DURING this turn on the live `_x.ai/session_notification` rail
        // (auto_compact_completed.tokens_after → the xaiNotification listener,
        // which sets sawCompactNotification). If that rail didn't fire — a CLI
        // that predates it, e.g. the Windows downgrade target 0.2.72 — fall back
        // to the hidden /session-info scrape (exact, CLI-local, before agentEnd).
        if (!session.sawCompactNotification) {
          await this.refreshContextAfterCompact(client, session, gen);
          if (gen !== session.gen) return;
        }
      }
      // Skip agentEnd if a verdict was clicked mid-turn (afterTurn is queued).
      // Otherwise busy clears here, then the user could send during the brief
      // gap before afterTurn's own client.prompt starts. afterTurn emits its
      // own agentEnd at the end of its prompt, so busy stays true throughout.
      if (!session.afterTurn) {
        this.emit(session, { type: "agentEnd", meta });
        this.setStatus(session, "done");
      }
      session.authRecoveryTried = false; // a clean turn re-arms token auto-recovery
      this.maybeGenerateTitle(session);
      if (slashCommand === "compact") {
        // A native compact rewrites the history around a summary, which can fold
        // the hidden primer away with everything else — silently breaking the
        // plan-verdict protocol for the rest of the session. Re-prime eagerly
        // (non-blocking, same as session start); this must run AFTER the compact
        // turn's own agentEnd above, or the primer's suppressContent window
        // would swallow it. Both flags reset: a settled primingPromise would
        // otherwise short-circuit ensurePrimed without sending anything.
        session.primed = false;
        session.primingPromise = undefined;
        // The re-prime doubles as the donut BACKUP for /compact, but only when
        // it can be TRUSTED: skip it if the live rail already gave us the exact
        // count (sawCompactNotification), and require a SUCCESSFUL primer
        // (session.primed) — a failed primer means no inference turn ended, so
        // signals.json still holds the STALE pre-compact count and reading it
        // would clobber the good value. When it does run, the CLI has recomputed
        // signals.json at the primer turn's end (research/signals-refresh-probe.cjs).
        void this.ensurePrimed(client, session, gen).then(() => {
          if (gen === session.gen && !session.sawCompactNotification && session.primed) {
            this.emitContextUsageSoon(session, gen);
          }
        });
      }
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
      // If the user approved/declined a plan mid-turn, the follow-up action was
      // deferred until now (a new prompt can't overlap the one above).
      try { await this.runAfterTurn(session); }
      finally { session.suppressPlanReject = false; } // safety net for plan-reject suppression
      // The turn (incl. any verdict follow-up) is fully over — fire anything
      // queued during it (#37). No-ops when the queue is empty or the session
      // was torn down mid-turn.
      if (gen === session.gen) void this.maybeFlushQueuedSends(session);
    }
  }

  /**
   * Recover from an expired-token turn failure without a manual sign-out. A
   * pooled `grok agent stdio` process can wedge on an expired OAuth token when
   * its 401-refresh loses a rotation race with the sibling processes / `grok
   * login` that share `~/.grok/auth.json`. A FRESH process re-reads the current
   * disk token — exactly what re-login does, minus the sign-out — so we
   * transparently restart the focused session (`startSession` respawns +
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
    if (session !== this.focused) return false;   // only the active session is safe to reload here
    if (!session.activeSessionId) return false;   // need an id to session/load history back
    if (session.authRecoveryTried) return false;  // already retried this streak → let it surface
    session.authRecoveryTried = true;
    this.output.appendLine(`[auth] recoverable token error — reloading session + resending: ${errorText}`);

    // Fresh process, current disk token. Rebuilds this.focused (same object) and
    // replays history from disk — which drops the un-persisted failed turn, so we
    // re-add the user's bubble below before resending.
    const client = await this.startSession(session.activeSessionId);
    if (!client || this.focused !== session) return true; // startSession surfaced its own failure/onboarding
    await (session.primingPromise ?? Promise.resolve()); // grok runs one turn at a time
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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
      capabilities: { uploadFile: true },
    };
  }

  private postInitialState(): void {
    this.post(this.buildInitialStateMsg());
    // Sync the active-editor context chip into the fresh webview (the config
    // gate + no-editor case live inside refreshImplicitChip).
    this.refreshImplicitChip(true);
    this.postVoiceConfigured();
    void this.postRemoteStatus();
    // Sweep stale empty primer sessions once the first session is live (so the
    // newly-focused session is excluded from the sweep).
    void this.startSession().then(() => {
      this.postRepoCatalog();
      this.sweepEmptyPrimerSessions();
    });
  }

  private postChips(): void {
    this.post({ type: "chips", chips: this.chips });
  }

  // grok's OUTPUT for a hidden turn (primer / summary injection) — dropped from
  // both the buffer and the live view. Deliberately excludes `userMessage` and
  // `agentStart`: those are the user's own input bubble + the "grok is starting"
  // lifecycle marker, emitted only by genuine user-initiated turns. With the
  // eager non-blocking primer, a user send can overlap the still-running silent
  // primer; suppressing those two would swallow the user's own message and the
  // Grokking indicator. The primer/summary injections never emit them, so leaving
  // them out costs those flows nothing.
  private static readonly SUPPRESS_TYPES = new Set([
    "messageChunk", "userMessageChunk", "thoughtChunk", "toolCall", "toolCallUpdate",
    "promptComplete", "xaiNotification", "subagentUpdate", "runProgress", "commandOutput", "agentEnd",
  ]);
  // Subset: content only, not lifecycle. Lets promptComplete/agentEnd through so
  // the webview's `busy` state clears when the false-approval turn ends.
  private static readonly PLAN_REJECT_SUPPRESS = new Set([
    "messageChunk", "userMessageChunk", "thoughtChunk", "toolCall", "toolCallUpdate", "xaiNotification", "subagentUpdate", "runProgress", "commandOutput",
  ]);

  private post(message: HostMsg): void {
    if (this.focused.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (this.focused.suppressPlanReject && GrokSidebar.PLAN_REJECT_SUPPRESS.has(message.type)) return;
    this.view?.webview.postMessage(message);
    this.mirrorToRemote(message);
  }

  /** Post to the VS Code webview only. Used where the two audiences must see
   *  DIFFERENT payloads — repo-scoped chrome, where the local window ignores the
   *  global selection (see `historyCwdFor`). Both are chrome, never content, so
   *  the suppress gates in `post` don't apply. */
  private postLocal(message: HostMsg): void {
    this.postTap?.("local", message);
    this.view?.webview.postMessage(message);
  }

  /** Post to remote clients only. Also records sticky chrome, so a client that
   *  connects later replays the REMOTE variant — never the local one. */
  private postRemote(message: HostMsg): void {
    this.postTap?.("remote", message);
    this.mirrorToRemote(message);
  }

  /** Test-only tap on the split posts. Never assigned in a released build:
   *  `extension.ts` hands out `installTestHooks` only under
   *  `ExtensionMode.Test`, which VS Code sets exclusively for a test runner. */
  private postTap?: (dest: MsgOrigin, message: HostMsg) => void;

  /**
   * Test-only seam for the integration suite. It exists because one property of
   * the local/remote split is unreachable from any pure unit test: that the
   * LOCAL payload reaches the webview and the REMOTE payload the uplink.
   * `repoScopeFor` proves WHICH cwd each audience should get; only this proves
   * the two are not wired to the wrong destinations — a swap that all 1386 unit
   * tests still pass (verified by performing it).
   */
  installTestHooks(): {
    onPost(fn: (dest: MsgOrigin, message: HostMsg) => void): void;
    fromRemote(message: WebviewMsg): void;
    workspaceRoot(): string;
  } {
    return {
      onPost: (fn) => {
        this.postTap = fn;
      },
      fromRemote: (message) => this.handleRemoteMessage(message),
      workspaceRoot: () => this.workspaceRoot(),
    };
  }

  /**
   * Session-scoped post. Records the message in that session's view buffer (so a
   * focus switch can rebuild its chat losslessly — clearMessages + replay) and,
   * when the session is the focused one, forwards it to the webview. Per-session
   * suppress flags drop primer/summary content from BOTH the buffer and the live
   * view (so they never reappear on replay). `clearMessages` resets the buffer —
   * the replay path issues its own clear before replaying, and a (re)started
   * session begins empty. Background sessions buffer silently; nothing reaches
   * the webview until they're focused. (Pool-of-1 today: session is always the
   * focused one, so this is behaviorally identical to `post`.)
   */
  private emit(session: Session, message: HostMsg): void {
    if (session.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (session.suppressPlanReject && GrokSidebar.PLAN_REJECT_SUPPRESS.has(message.type)) return;

    // Turn-level file baselines: stamp a turnId on agentStart and archive the
    // previous turn's map so view-deleted / undo still work after the next turn.
    let out = message;
    if (message.type === "agentStart") {
      if (session.turnBaselineId > 0 && session.turnBaselines.size > 0) {
        archiveTurnBaselines(
          session.turnBaselineArchive,
          session.turnBaselineId,
          session.turnBaselines,
        );
      }
      session.turnBaselineId += 1;
      session.turnBaselines = new Map();
      out = { type: "agentStart", turnId: session.turnBaselineId };
    }

    if (out.type === "clearMessages") session.buffer = [];
    else session.buffer.push(out);
    if (session === this.focused) {
      this.view?.webview.postMessage(out);
      this.mirrorToRemote(out);
    }

    // After a turn ends, push baseline *metadata* (content stays host-side) so
    // the summary card can enable View / Undo.
    if (out.type === "agentEnd" || out.type === "agentError") {
      this.pushTurnBaselineMeta(session);
    }
  }

  /** Host→webview baseline meta only (no file content). */
  private pushTurnBaselineMeta(session: Session): void {
    if (session.turnBaselineId <= 0 || session.turnBaselines.size === 0) return;
    const message: HostMsg = {
      type: "turnBaselines",
      turnId: session.turnBaselineId,
      files: [...session.turnBaselines.values()].map(baselineToMeta),
    };
    session.buffer.push(message);
    if (session === this.focused) {
      this.view?.webview.postMessage(message);
      this.mirrorToRemote(message);
    }
  }

  private resolveBaselineAbsPath(session: Session, p: string): string {
    if (path.isAbsolute(p)) return p;
    const root =
      session.cwd ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      process.cwd();
    return path.resolve(root, p);
  }

  /**
   * First-touch snapshot of `absPath` for this turn (no-op if already captured).
   * Call before any mutation so delete/edit undo still has the pre-state.
   */
  private async captureFileBaseline(session: Session, rawPath: string): Promise<void> {
    if (session.turnBaselineId <= 0) return;
    const absPath = this.resolveBaselineAbsPath(session, rawPath);
    const key = normalizeBaselinePathKey(absPath);
    if (!key || session.turnBaselines.has(key)) return;

    let baseline: FileBaseline;
    try {
      const st = await fs.promises.stat(absPath);
      if (!st.isFile()) {
        baseline = baselineAbsent(absPath);
      } else {
        const buf = await fs.promises.readFile(absPath);
        baseline = baselineFromContent(absPath, buf.toString("utf8"), buf.byteLength);
      }
    } catch {
      baseline = baselineAbsent(absPath);
    }
    session.turnBaselines.set(key, baseline);
    this.pushTurnBaselineMeta(session);
  }

  /** Sync first-touch baselines for shell deletes (must finish before spawn). */
  private captureDeleteBaselinesSync(session: Session, command: string): void {
    if (session.turnBaselineId <= 0) return;
    for (const raw of parseShellDeletePaths(command)) {
      const abs = this.resolveBaselineAbsPath(session, raw);
      const key = normalizeBaselinePathKey(abs);
      if (!key || session.turnBaselines.has(key)) continue;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) session.turnBaselines.set(key, baselineAbsent(abs));
        else {
          const buf = fs.readFileSync(abs);
          session.turnBaselines.set(
            key,
            baselineFromContent(abs, buf.toString("utf8"), buf.byteLength),
          );
        }
      } catch {
        session.turnBaselines.set(key, baselineAbsent(abs));
      }
      this.pushTurnBaselineMeta(session);
    }
  }

  private async viewTurnBaseline(turnId: number, rawPath: string): Promise<void> {
    const session = this.focused;
    const map = resolveTurnBaselineMap(
      turnId,
      session.turnBaselineId,
      session.turnBaselines,
      session.turnBaselineArchive,
    );
    if (!map) {
      void vscode.window.showWarningMessage("No saved baseline for this turn.");
      return;
    }
    const key = normalizeBaselinePathKey(this.resolveBaselineAbsPath(session, rawPath));
    const b = map.get(key) ?? map.get(normalizeBaselinePathKey(rawPath));
    if (!b) {
      void vscode.window.showWarningMessage("No baseline for that file.");
      return;
    }
    if (b.kind === "content" && typeof b.content === "string") {
      const doc = await vscode.workspace.openTextDocument({
        content: b.content,
        language: path.extname(b.path).slice(1) || "plaintext",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    if (b.kind === "absent") {
      void vscode.window.showInformationMessage(
        `${path.basename(b.path)} did not exist before this turn (nothing to show).`,
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `Baseline for ${path.basename(b.path)} was not kept (${b.reason || "omitted"}).`,
    );
  }

  private async undoTurnFiles(turnId: number, paths?: string[]): Promise<void> {
    const session = this.focused;
    const map = resolveTurnBaselineMap(
      turnId,
      session.turnBaselineId,
      session.turnBaselines,
      session.turnBaselineArchive,
    );
    if (!map || map.size === 0) {
      void vscode.window.showWarningMessage("No file baselines to restore for this turn.");
      return;
    }
    const targets = selectBaselinesForUndo(map, paths);
    if (!targets.length) {
      void vscode.window.showWarningMessage("No matching file baselines to restore.");
      return;
    }
    const label =
      targets.length === 1
        ? path.basename(targets[0].path)
        : `${targets.length} files`;
    const ok = await vscode.window.showWarningMessage(
      `Restore ${label} to the state before this turn? Current disk content will be overwritten.`,
      { modal: true },
      "Restore",
    );
    if (ok !== "Restore") return;

    let restored = 0;
    let deleted = 0;
    let skipped = 0;
    for (const b of targets) {
      try {
        if (b.kind === "content" && typeof b.content === "string") {
          const uri = vscode.Uri.file(b.path);
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(b.path)));
          await vscode.workspace.fs.writeFile(uri, Buffer.from(b.content, "utf8"));
          restored++;
        } else if (b.kind === "absent") {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(b.path), { useTrash: true });
            deleted++;
          } catch {
            // Already gone — counts as success for "undo create".
            deleted++;
          }
        } else {
          skipped++;
        }
      } catch (e) {
        this.output.appendLine(`[baseline-undo] ${b.path}: ${(e as Error).message}`);
        skipped++;
      }
    }
    const parts: string[] = [];
    if (restored) parts.push(`restored ${restored}`);
    if (deleted) parts.push(`removed ${deleted} created`);
    if (skipped) parts.push(`skipped ${skipped}`);
    void vscode.window.showInformationMessage(
      parts.length ? `Undo: ${parts.join(", ")}.` : "Nothing to restore.",
    );
  }

  /** Record sticky chrome + fan the (already-un-suppressed, focused) message out
   *  to remote clients. No-op unless the uplink is running. Shared focus:
   *  remote mirrors exactly what the local webview sees. Outbound policy applies
   *  here: host-local messages (voice) + video are suppressed, image `media` is
   *  base64-inlined (an asWebviewUri src only resolves inside the local webview). */
  private mirrorToRemote(message: HostMsg): void {
    if (GrokSidebar.STICKY_CHROME_TYPES.has(message.type)) this.stickyChrome.set(message.type, message);
    if (!this.uplink) return;
    const out = transformHostMsgForRemote(message, GrokSidebar.REMOTE_MEDIA_DEPS);
    if (!out) return;
    this.uplink.broadcast(out);
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
  private focusSession(session: Session): void {
    if (session === this.focused) return;
    this.focused = session;
    this.touch(session);
    this.markRead(session); // opening it clears any unread (green/red) badge
    const wv = this.view?.webview;
    if (wv) {
      wv.postMessage({ type: "clearMessages" });
      for (const m of session.buffer) wv.postMessage(m);
    }
    // Remote clients don't share the webview, so replay the same clear + buffer
    // to them over the uplink — otherwise re-focusing a session that's still
    // live in the pool (this path) reloads only the local webview while the
    // remote keeps showing the previous session (switching a session in history
    // didn't always reload on the browser client). Cold loads go through
    // emit()/post(), which already mirror; this path deliberately bypasses them.
    // Transform by hand (image inlining, host-local/video drop) but skip
    // mirrorToRemote's sticky-chrome recording — this is chat content, and
    // postMode()/postSessionsList() below refresh the remote's chrome.
    if (this.uplink) {
      const replay: HostMsg[] = [{ type: "clearMessages" }, ...session.buffer];
      for (const m of replay) {
        const out = transformHostMsgForRemote(m, GrokSidebar.REMOTE_MEDIA_DEPS);
        if (out) this.uplink.broadcast(out);
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
    // never auto-delete it as an "empty primer session", even before the first
    // message (that's what made creating/leaving a worktree replace the current
    // one). It's removed only via Remove worktree.
    if (cur.hasHistory || cur.afterTurn || busy || cur.worktree) return; // real/active work — keep it parked & alive
    // Empty (primer-only) session being left behind (New Session, or switching to
    // another): tear down its process AND delete its on-disk dir so it doesn't pile
    // up in history (#24). The next focused session becomes the single live "New
    // session"; abandoning this one removes it entirely.
    this.disposeSession(cur);
    this.removeSessionFromDisk(cur.activeSessionId, cur.cwd);
    this.postSessionsList();
  }

  /** Delete a session's on-disk dir + drop its meta override and read-cache entry.
   *  Used when an empty (primer-only) session is abandoned or swept. Best-effort —
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
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
    const candidates = [...this.pool].map((session) => ({
      session,
      status: session.status,
      lastActiveAt: session.lastActiveAt,
      focused: session === this.focused,
    }));
    const doomed = selectReapable(candidates, {
      maxLive: GrokSidebar.MAX_LIVE_SESSIONS,
      idleTtlMs: GrokSidebar.IDLE_TTL_MS,
      now: Date.now(),
    });
    for (const c of doomed) this.disposeSession(c.session);
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
    // A turn that finishes while the user is looking at a *different* session
    // becomes "unread" (green/red dot) until they open it. If it's the focused
    // session, they watched it happen — no badge.
    if ((status === "done" || status === "error") && session !== this.focused) {
      this.setMetaUnread(session.activeSessionId, true, status === "error");
    }
    this.pushDot(session);
  }

  /** Push just this session's recomputed dot to the webview (cheap — no disk read
   *  beyond the small meta object). Used on status changes, read/unread changes,
   *  and on reaping (where the session has left the pool but may stay green). */
  private pushDot(session: Session): void {
    const id = session.activeSessionId;
    if (id) this.post({ type: "sessionDot", id, dot: this.dotForId(id) });
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
  private accumulateUsage(session: Session, meta: PromptResultMeta): void {
    if (!usageIsRealMeasurement(meta)) return;
    session.lastTurnUsage = meta.usage;
    session.sessionUsage = addUsage(session.sessionUsage, meta.usage);
    this.emit(session, { type: "usage", turn: session.lastTurnUsage, session: session.sessionUsage });
    const id = session.activeSessionId;
    if (!id || !session.sessionUsage) return;
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    // Log the turn as well as the total: a rewind must be able to subtract the
    // discarded turns, and a running total alone can't be undone.
    const usageLog = [
      ...(cur.usageLog ?? []),
      { afterUserMessage: session.userMessageCount, usage: meta.usage! },
    ];
    void this.context.globalState.update(SESSION_META_KEY, {
      ...overrides,
      [id]: { ...cur, usage: session.sessionUsage, usageLog },
    });
  }

  /** Seed a (re)opened session's cumulative billing from our own globalState and
   *  push it, so the popover survives a reload. No stored total (an older session
   *  or a pre-usage CLI) posts nothing — the popover shows context only. */
  private restoreUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const stored = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]?.usage;
    if (!stored) return;
    session.sessionUsage = stored;
    this.emit(session, { type: "usage", session: stored });
  }

  /** Push the context size from grok's on-disk signals.json to the webview —
   *  the source that has a real count when the ACP turn meta can't: a cold
   *  restore (no turn has run), the hidden post-/compact re-prime (its meta is
   *  suppressed), and zero-reporting turns like /session-info (stripped by
   *  gateZeroTokenMeta). Best-effort: no readable count, no message (the
   *  donut keeps whatever it has). */
  private emitContextUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const usage = readContextUsage({ fs: defaultFs, grokHome: resolveGrokHome(process.env), cwd, id });
    if (usage) this.emit(session, { type: "contextUsage", used: usage.used, window: usage.window });
  }

  /** emitContextUsage now + once more after the CLI's turn-end file flush has
   *  certainly landed (the write races the ACP response by a beat). */
  private emitContextUsageSoon(session: Session, gen: number): void {
    this.emitContextUsage(session);
    setTimeout(() => {
      if (gen === session.gen) this.emitContextUsage(session);
    }, 1500);
  }

  /** Pre-rail fallback for the post-/compact donut: fetch the fresh context size
   *  via a hidden /session-info turn. Runs ONLY when the live
   *  auto_compact_completed notification didn't fire (a CLI older than that rail,
   *  e.g. the Windows downgrade target). The turn is CLI-local (~25ms, no model
   *  call) and is NOT persisted to chat history, so nothing shows live or on
   *  restore; its reply text is the only place the fresh count exists this early
   *  on such builds (research/signals-refresh-probe.cjs). Runs before the compact
   *  turn's agentEnd clears busy, so no user send can interleave. Parse failure is
   *  silent — the post-compact re-prime's signals.json read is the second backup. */
  private async refreshContextAfterCompact(client: AcpClient, session: Session, gen: number): Promise<void> {
    // Drift guard: if a future CLI stops advertising /session-info, sending it
    // anyway would become a REAL inference turn (and a restore-visible bubble).
    // Skip entirely — a donut that lags until the next turn beats that.
    if (!client.availableCommands.some((c) => c?.name === "session-info")) return;
    session.suppressContent = true;
    session.captureAgentText = "";
    try {
      await client.prompt("/session-info");
      if (gen !== session.gen) return;
      // parseSessionInfoContext is null-safe and never throws: a reply-format
      // change means no donut update (it lags until the next turn), never an
      // error surfaced to the user.
      const parsed = parseSessionInfoContext(session.captureAgentText ?? "");
      if (parsed) this.emit(session, { type: "contextUsage", used: parsed.used, window: parsed.window });
    } catch (e) {
      // Even a failed hidden turn stays silent — log-only, no error bubble.
      this.output.appendLine(`[compact] hidden /session-info failed: ${(e as Error).message}`);
    } finally {
      if (gen === session.gen) session.suppressContent = false;
      session.captureAgentText = undefined;
    }
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
    this.focused = new Session();
    this.focused.cwd = targetCwd;
    this.focused.worktree = undefined;
    const wt = matchWorktreeForCwd(
      this.focused.cwd,
      worktreesForRepo(this.worktreeCache, this.workspaceRoot(), { includeDead: true }),
    );
    if (wt) {
      this.focused.worktree = {
        path: wt.path,
        label: wt.label,
        sourceGitRoot: wt.sourceRepo || this.workspaceRoot(),
        id: wt.id,
      };
    }
    // The webview toolbar button clears its own DOM before posting newSession,
    // but the Command Palette command lands here directly — without this clear
    // the old transcript stayed onscreen under the fresh session. (The toolbar
    // path just clears twice, a no-op.)
    this.emit(this.focused, { type: "clearMessages" });
    await this.startSession();
    if (this.focused.activeSessionId && this.focused.worktree) {
      const id = this.focused.activeSessionId;
      const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      await this.context.globalState.update(SESSION_META_KEY, {
        ...overrides,
        [id]: {
          ...(overrides[id] ?? {}),
          worktreePath: this.focused.worktree.path,
          worktreeLabel: this.focused.worktree.label,
          sourceGitRoot: this.focused.worktree.sourceGitRoot,
        },
      });
    }
    this.postRepoCatalog();
  }

  /**
   * Open the session with grok id `id`. If it's already live in the pool, re-focus
   * it instantly (lossless buffer replay — no reload). Otherwise park the current
   * session and load this one cold from grok's on-disk history into a fresh member.
   */
  private async openSession(id: string, sessionCwd?: string): Promise<void> {
    for (const s of this.pool) {
      if (s.activeSessionId === id && s.client) {
        this.focusSession(s);
        return;
      }
    }
    this.parkFocused();
    this.focused = new Session();
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

  /** Impure half of the media inline transform (the decision logic is the pure
   *  remote-policy). Sync read keeps broadcast ordering; media is rare + capped. */
  private static readonly REMOTE_MEDIA_DEPS: MediaInlineDeps = {
    readFile: (p) => {
      try {
        return fs.readFileSync(p);
      } catch {
        return null;
      }
    },
    toBase64: (bytes) => Buffer.from(bytes).toString("base64"),
  };

  /** The single inbound choke point for remote clients: capability-gate, then
   *  route into the normal onMessage switch. */
  private handleRemoteMessage(m: WebviewMsg): void {
    if (!allowFromRemote(m.type, GrokSidebar.REMOTE_TIER)) {
      this.output.appendLine(`[remote] dropped ${m.type} (not allowed from a remote client)`);
      return;
    }
    if (!allowRemoteRepoTarget(m, (cwd) => this.remoteTargetableCwd(cwd))) {
      this.output.appendLine(`[remote] dropped ${m.type} (cwd was not discovered)`);
      return;
    }
    void this.onMessage(m, "remote").catch((e) =>
      this.output.appendLine(`[remote] ${m.type} failed: ${(e as Error)?.message ?? String(e)}`),
    );
  }

  private static readonly DEVICE_TOKEN_SECRET = "grok.remoteControl.deviceToken";

  /** Start the relay uplink when a device token is stored (from the link flow).
   *  Idempotent. */
  private async maybeStartUplink(): Promise<void> {
    if (this.uplink) return;
    const token = await this.context.secrets.get(GrokSidebar.DEVICE_TOKEN_SECRET);
    if (!token) return; // not linked yet — the link command starts the uplink itself
    this.uplink = new RemoteUplink({
      relayUrl: REMOTE_RELAY_URL,
      token,
      deviceName: deviceDisplayName(os.hostname(), process.platform, os.release()),
      snapshot: () => this.buildRemoteSnapshot(),
      onClientMessage: (m) => this.handleRemoteMessage(m),
      log: (l) => this.output.appendLine(l),
    });
    this.uplink.start();
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

  /** "Grok: Link Remote Device" — the device-code flow against the relay's REST
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

  /** "Grok: Unlink Remote Device" — drop the token + connection. */
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
    this.uplink?.dispose();
    this.uplink = undefined;
    this.refreshKeepAwake();
    this.post({ type: "remoteStatus", linked: false });
    void vscode.window.showInformationMessage("Remote device unlinked.");
  }

  /** Tell the webview whether this machine holds a relay device token (drives
   *  the gear "AFK Pilot" section's sign-in vs account/sign-out items). */
  private async postRemoteStatus(): Promise<void> {
    const token = await this.context.secrets.get(GrokSidebar.DEVICE_TOKEN_SECRET);
    this.post({ type: "remoteStatus", linked: !!token });
  }

  /** Ordered catch-up for a newly-`ready` client: initialState first (so chat.js
   *  initializes), then clearMessages + the focused chat buffer, then the rest of
   *  the sticky chrome (labels/donut/lists — order among them is moot). All of it
   *  through the outbound policy (media inlined, host-local suppressed). */
  private buildRemoteSnapshot(): HostMsg[] {
    const snap: HostMsg[] = [];
    snap.push(this.stickyChrome.get("initialState") ?? this.buildInitialStateMsg());
    snap.push({ type: "clearMessages" });
    for (const m of this.focused.buffer) snap.push(m);
    for (const [type, m] of this.stickyChrome) {
      if (type === "initialState") continue;
      snap.push(m);
    }
    const out: HostMsg[] = [];
    for (const m of snap) {
      const t = transformHostMsgForRemote(m, GrokSidebar.REMOTE_MEDIA_DEPS);
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
      <p id="welcome-version" class="muted loading-dots">Starting</p>
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
