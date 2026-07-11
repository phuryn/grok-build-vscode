import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AcpClient, EffortLevel, ExitPlanRequest, PermissionRequest, QuestionRequest } from "./acp";
import { Session, SessionStatus } from "./session";
import { selectReapable, computeDot, Dot } from "./session-pool";
import { resolveVoiceKey, parseVoiceCommand, DEFAULT_SEND_PHRASE } from "./voice";
import { VoiceRecorder, transcribeAudio, resolveWindowsAudioDevice } from "./voice-recorder";
import { VoiceStreamer } from "./voice-streamer";
import { MediaRef, isIncompatibleAgentError, permissionOutcomeFor, summarizeBackgroundCommand } from "./acp-dispatch";
import { modeToRemember, startsInYolo } from "./mode-prefs";
import { GROK_VIEW_ID, moveViewContainerFor } from "./view-move";
import {
  APTABASE_APP_KEY_PROD,
  buildSessionStartEvent,
  osNameFromPlatform,
  postEvent,
  shouldSendTelemetry,
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
import { TerminalManager } from "./terminal-manager";
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
  makeImplicitChip,
  mimeFromPath,
  removeChip,
  toggleChip,
} from "./chips";
import { buildPromptWithImages, type PromptImageInput } from "./prompt-builder";
import { matchSlashCommand } from "./slash-filter";
import { configForcesAlwaysApprove } from "./grok-config";
import { parseFileRef, shouldReadFileInline } from "./file-ref";
import { pickRejectOption, shouldRejectPermission } from "./plan-gate";
import { appendPlanEntry, decideRestoreState } from "./plan-restore";
import { planReviewFileBaseName, sanitizePlanReviewFilePart } from "./plan-review";
import { GROK_PRIMER, isPrimerText } from "./grok-primer";
import { HostMsg, WebviewMsg } from "./protocol";
import { canonicalizeWorkspacePath, mergeSessionIndexes } from "./workspaces";
import {
  SessionListEntry,
  SessionMetaOverrides,
  carrySessionName,
  clearSessions,
  defaultFs,
  deleteSessionDir,
  fallbackName,
  indexSessions,
  isEmptyPrimerSession,
  readSessionEntries,
  resolveGrokHome,
  sessionsDirFor,
} from "./sessions";

// HostMsg (host -> webview) and WebviewMsg (webview -> host) both live in
// src/protocol.ts now — the single source of truth for the message contract,
// imported above. See that file for why.

const SESSION_META_KEY = "grok.sessionMeta";
/** globalState key for the anonymous per-install telemetry GUID (survives updates). */
const INSTALL_ID_KEY = "grok.installId";

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
  private cliPath?: string;
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

  // Grok Workspaces panel plumbing: the tree refreshes off this event (fired on
  // every catalog change + dot change), and historyPanelVisible mirrors the
  // tree's visibility so the chat's own history button hides while the panel is
  // showing (New stays).
  private readonly sessionsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this.sessionsChangedEmitter.event;
  private historyPanelVisible = false;

  constructor(
    private context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
  ) {
    this.output = output;
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(GROK_DIFF_SCHEME, this.diffProvider),
    );
    void this.sweepImageStaging();
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
      void this.onMessage(m).catch((e) => {
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
      if (e.affectsConfiguration("grok.includeActiveFileByDefault")) {
        // Apply the toggle immediately: disabling removes a visible context
        // chip right away (not on the next editor event), enabling shows it.
        this.refreshImplicitChip(true);
      }
    });
  }

  insertActiveMention(opts?: { selection?: boolean; uri?: vscode.Uri }): void {
    const editor = vscode.window.activeTextEditor;
    const uri = opts?.uri ?? editor?.document.uri;
    if (!uri) return;
    const relPath = vscode.workspace.asRelativePath(uri);
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (opts?.selection && editor && !editor.selection.isEmpty) {
      selStart = editor.selection.start.line + 1;
      selEnd = editor.selection.end.line + 1;
    }
    this.chips.push(makeExplicitChip(uri.fsPath, relPath, selStart, selEnd));
    this.postChips();
    this.reveal();
  }

  newSession(): void {
    void this.newFocusedSession();
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

  /** This window's own (first) workspace folder — the default home for new
   *  sessions, and the scope of the popover list / startup sweep. */
  private activeWorkspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** The workspace a session belongs to. Every disk/config path derived from a
   *  session must go through this, never the window's folder — the pool can hold
   *  sessions from several workspaces (Grok Workspaces panel). Falls back to the
   *  window's folder for a not-yet-started Session. */
  private sessionCwd(session: Session): string {
    return session.cwd || this.activeWorkspaceCwd();
  }

  /** Whether grok's config.toml forces always-approve (#31). The starting
   *  session's project `.grok/config.toml` overrides global
   *  `~/.grok/config.toml` — `cwd` is the SESSION's workspace, so a
   *  cross-workspace session reads its own project config. Read fresh on each
   *  session start — it's a couple of small file reads, and the user may edit
   *  the config between sessions. Any read error → false (treat as normal). */
  private configForcesAutoApprove(cwd: string): boolean {
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
      if (feedback) {
        session.userMessageCount += 1;
        this.emit(session, { type: "userMessage", text: feedback, chips: [] });
      }
      this.emit(session, { type: "planProcessing" }); // indicator while we wait for grok
      const promptToGrok = feedback ? `[Plan approved] ${feedback}` : "[Plan approved]";
      session.afterTurn = async () => {
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
          const e = err as any;
          this.emit(session, { type: "agentError", text: e?.data?.message ?? e?.message ?? String(err) });
          this.setStatus(session, "error");
        }
      };
      return;
    }

    // rejected / abandoned: cancel the in-flight turn and suppress its content
    // so the false-approval response doesn't reach the screen.
    void client.cancel();
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
          text: "Plan rejected — staying in Plan mode. Grok is processing the rejection…",
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
          const e = err as any;
          this.emit(session, { type: "agentError", text: e?.data?.message ?? e?.message ?? String(err) });
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
        text: "Plan abandoned — switched to Agent mode. Grok is processing the cancellation…",
      });
      this.emit(session, { type: "planProcessing" });
    }
    const promptToGrok = feedback ? `[Plan cancelled] ${feedback}` : "[Plan cancelled]";
    session.afterTurn = async () => {
      session.suppressPlanReject = false;
      try { await client.setMode(ACT_MODE_ID); } catch { /* best-effort */ }
      this.emit(session, { type: "agentStart" });
      this.setStatus(session, "working");
      try {
        const meta = await client.prompt(promptToGrok);
        if (gen !== session.gen) return;
        this.emit(session, { type: "agentEnd", meta });
        this.setStatus(session, "done");
      } catch (err) {
        if (gen !== session.gen) return;
        const e = err as any;
        this.emit(session, { type: "agentError", text: e?.data?.message ?? e?.message ?? String(err) });
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
      const root = path.resolve(resolveGrokHome());
      const rel = path.relative(root, path.resolve(p));
      return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
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
    return this.startSession();
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
    const resumeCwd = this.sessionCwd(this.focused); // resume in ITS workspace, not the window's
    // Free the binary: every pooled session's process holds it open (a hard lock
    // on Windows), so tear the whole pool down before the update replaces the
    // executable, then resume the focused session on the fresh binary. Other
    // backgrounded sessions go cold — re-focusing one reloads it from disk.
    // AWAIT the teardown: kill() only *signals*, and on Windows the OS releases
    // the grok.exe lock a beat after the process actually exits — running the
    // update before that loses the rename with "cannot rename locked executable".
    this.focused = new Session();
    this.post({ type: "clearMessages" });
    this.post({ type: "cliUpdating" });
    await this.disposePool();
    await this.runGrokUpdate(cliPath, updateArgs);
    // Respawn on the (possibly) updated binary, resuming the same session.
    await this.startSession(resumeId, resumeCwd);
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
    // A restart-in-place keeps the session's workspace, so the discarded dir
    // lives under the (restarted) focused session's cwd — not necessarily the
    // window's folder.
    const cwd = this.sessionCwd(this.focused);
    const grokHome = resolveGrokHome(process.env);
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id: oldId });
    } catch (e) {
      this.output.appendLine(`[sessions] could not discard empty session ${oldId}: ${(e as Error).message}`);
    }
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    void this.context.globalState.update(SESSION_META_KEY, carrySessionName(overrides, oldId, newId));
    this.dropCacheEntry(oldId);
    this.postSessionsList();
  }

  private async startSession(resumeId?: string, cwdOverride?: string): Promise<AcpClient | undefined> {
    // The session this start (re)builds. Today always the focused one (pool-of-1);
    // Step D passes a pool member. Its handlers close over `session`/`gen` so a
    // backgrounded session's events stay bound to it even after focus moves.
    const session = this.focused;
    const gen = ++session.gen;
    // Stamp the session's workspace FIRST — the config lookup below and the
    // spawn cwd / plan-gate root / .env all derive from it. Explicit override
    // (workspace panel) > the session's existing home (a restart-in-place
    // keeps its workspace) > this window's own folder.
    session.cwd = cwdOverride || session.cwd || this.activeWorkspaceCwd();
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
    const configAutoApprove = this.configForcesAutoApprove(session.cwd);
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

    const cwd = session.cwd; // the session's workspace — closures below capture it
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
      if (!session.inUserMessage) {
        session.userMessageCount += 1;
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
      this.emit(session, { type: "promptComplete", meta });
    });
    client.on("xaiNotification", (u) => {
      if (gen !== session.gen) return;
      this.emit(session, { type: "xaiNotification", update: u });
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
        const saved = overrides[resumeId]?.plans ?? [];
        if (saved.length > 0) {
          this.emit(session, { type: "planHistoryQueue", plans: await this.withPlanReviewPaths(saved, resumeId) });
          session.lastPlanText = saved[saved.length - 1].text;
        } else {
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
      } else {
        await client.newSession(defaultModel || undefined);
        session.activeSessionId = client.sessionId;
      }
      if (gen !== session.gen) { client.dispose(); session.client = undefined; return undefined; }

      if (defaultModel && client.currentModelId && client.currentModelId !== defaultModel) {
        const hasModel = client.availableModels.some((m) => m.modelId === defaultModel);
        if (!hasModel) {
          this.output.appendLine(
            `[startup] Default model '${defaultModel}' is not available in the CLI. Using '${client.currentModelId}' instead.`,
          );
          vscode.window.showWarningMessage(
            `Grok default model '${defaultModel}' is not available. Falling back to '${client.currentModelId}'. Please update your 'grok.defaultModel' setting.`,
          );
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
      if (/auth|unauthor|forbidden|401|403|api[_\s-]?key|credential|sign.?in/i.test(msg)) {
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

  private async onMessage(msg: WebviewMsg): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postInitialState();
        break;
      case "send":
        await this.handleSend(msg.text, msg.bare === true);
        break;
      case "newSession":
        await this.newFocusedSession();
        break;
      case "cancel":
        await this.focused.client?.cancel();
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
        }
        this.chips = removeChip(this.chips, msg.id);
        this.postChips();
        break;
      }
      case "toggleChip":
        this.chips = toggleChip(this.chips, msg.id);
        this.postChips();
        break;
      case "openFile": {
        const ref = parseFileRef(msg.path);
        let p = ref.path;
        if (!path.isAbsolute(p)) {
          // Chat content shows paths relative to the SESSION's workspace (which
          // the workspace panel can point at another folder), not the window's.
          p = path.join(this.sessionCwd(this.focused), p);
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
      case "openDiff":
        await this.openDiffEditor(msg.path, msg.oldText, msg.newText, msg.requestId);
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

        const mode = await this.pickRestartMode("Changing reasoning effort requires restarting the session.");
        if (!mode) break; // dismissed
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
        // "Project" = the focused session's workspace (the config grok actually reads).
        const cwd2 = this.sessionCwd(this.focused);
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
        const mcpCwd = this.focused.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
      case "resumeSession":
        await this.openSession(msg.id);
        break;
      case "renameSession":
        this.renameSession(msg.id, msg.name);
        break;
      case "deleteSession":
        await this.deleteSession(msg.id, msg.name);
        break;
      case "clearAllSessions":
        await this.clearAllSessions();
        break;
      case "pickFile":
        await this.trackAttach(this.pickFileFromComputer());
        break;
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
  private postSessionsList(opts?: { offset?: number; limit?: number; query?: string }): void {
    // The Grok Workspaces tree refreshes off the same triggers as the popover
    // (every catalog mutation funnels through here).
    this.sessionsChangedEmitter.fire();
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const query = (opts?.query ?? "").trim().toLowerCase();
    // The popover always lists THIS window's workspace — other workspaces'
    // histories live in the Grok Workspaces panel.
    const cwd = this.activeWorkspaceCwd();
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const log = (m: string) => this.output.appendLine(m);

    const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
    const mtimeById = new Map(index.map((e) => [e.id, e.mtimeMs]));

    let pageEntries: SessionListEntry[];
    let total: number;
    if (query) {
      // Search needs names for everything, so read (cache-backed) the whole list once, then filter.
      const all = this.readEntriesCached(index.map((e) => e.id), mtimeById, overrides, cwd, grokHome, log);
      all.sort((a, b) => b.updatedAt - a.updatedAt);
      const matched = all.filter((e) => e.displayName.toLowerCase().includes(query));
      total = matched.length;
      pageEntries = matched.slice(offset, offset + limit);
    } else {
      total = index.length;
      const pageIds = index.slice(offset, offset + limit).map((e) => e.id);
      pageEntries = this.readEntriesCached(pageIds, mtimeById, overrides, cwd, grokHome, log);
      // mtime is an approximate sort key; re-order the loaded page by exact updated_at.
      pageEntries.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    // hasMore is governed purely by what's on disk (load-more pages disk-only); compute it before
    // injecting any live-only rows below so an injected entry can't be mistaken for another page.
    const hasMore = offset + pageEntries.length < total;

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
      const cwdKey = canonicalizeWorkspacePath(cwd);
      for (const s of this.pool) {
        const id = s.activeSessionId;
        if (!id || onDisk.has(id) || seen.has(id)) continue;
        // A pool session homed in ANOTHER workspace (Grok Workspaces panel)
        // doesn't belong in this window's popover list.
        if (canonicalizeWorkspacePath(this.sessionCwd(s)) !== cwdKey) continue;
        synthetic.push(this.liveSessionEntry(s, id, cwd, overrides));
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
    this.post({
      type: "sessions",
      entries: pageEntries,
      activeId: this.focused.activeSessionId,
      dots,
      offset,
      total,
      hasMore,
      query: opts?.query ?? "",
    });
  }

  /** Synthesize a list entry for a live session grok hasn't written a `summary.json` for yet (a
   *  brand-new one). The disk-scan index can't see it, so without this the active row would vanish
   *  from history when the popover is opened the instant a session goes live. Uses the best name we
   *  have in memory: a generated/renamed `customName`, else the first user message, else a
   *  placeholder — all of which the next refresh replaces with grok's own summary once it lands. */
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
      const cached = this.sessionCache.get(this.cacheKey(cwd, id));
      if (!cached || cached.mtimeMs !== (mtimeById.get(id) ?? -1)) stale.push(id);
    }
    if (stale.length) {
      const fresh = readSessionEntries({ fs: defaultFs, grokHome, cwd, ids: stale, overrides, log });
      for (const e of fresh) {
        this.sessionCache.set(this.cacheKey(cwd, e.id), { mtimeMs: mtimeById.get(e.id) ?? 0, entry: e });
      }
    }
    return ids
      .map((id) => this.sessionCache.get(this.cacheKey(cwd, id))?.entry)
      .filter((e): e is SessionListEntry => !!e);
  }

  /** Cache key for {@link sessionCache} — cwd-scoped now that several workspaces'
   *  entries share the cache (Grok Workspaces panel). */
  private cacheKey(cwd: string, id: string): string {
    return cwd + "\n" + id;
  }

  /** Invalidate a session's cached entry under EVERY workspace spelling. Ids are
   *  UUIDs, so the suffix match is unambiguous; rename/delete callers don't need
   *  to know which spelling(s) the entry was read under. */
  private dropCacheEntry(id: string): void {
    for (const k of [...this.sessionCache.keys()]) {
      if (k.endsWith("\n" + id)) this.sessionCache.delete(k);
    }
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
    this.dropCacheEntry(id);
    this.postSessionsList();
  }

  /** `cwd` defaults to this window's workspace (the popover's scope); the
   *  workspace panel passes the entry's own storage cwd. */
  private async deleteSession(id: string, name?: string, cwd?: string): Promise<void> {
    const label = name ? `session "${name}"` : "this session";
    const choice = await vscode.window.showWarningMessage(
      `Delete ${label}? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return;
    try {
      deleteSessionDir({
        fs: defaultFs,
        grokHome: resolveGrokHome(process.env),
        cwd: cwd ?? this.activeWorkspaceCwd(),
        id,
      });
    } catch (e) {
      this.output.appendLine(`[sessions] delete failed for ${id}: ${(e as Error).message}`);
    }
    this.dropCacheEntry(id);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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

  /** Webview "Clear all history" — clears this window's workspace store. */
  private async clearAllSessions(): Promise<void> {
    await this.clearWorkspaceSessions([this.activeWorkspaceCwd()]);
  }

  /**
   * Delete a workspace's session history (across every storage spelling),
   * preserving EVERY live pool session homed there — not just the focused one.
   * grok re-persists a live session's dir on its next turn (deleting it wouldn't
   * stick), and a working background agent shouldn't lose its record either.
   * Modal-confirmed with the real counts. Serves both the popover's "Clear all"
   * and the workspace panel's per-workspace "Clear sessions".
   */
  async clearWorkspaceSessions(storageCwds: string[]): Promise<void> {
    const grokHome = resolveGrokHome(process.env);
    const keys = new Set(storageCwds.map((c) => canonicalizeWorkspacePath(c)));
    const liveIds = new Set<string>();
    for (const s of [...this.pool, this.focused]) {
      if (s.activeSessionId && keys.has(canonicalizeWorkspacePath(this.sessionCwd(s)))) {
        liveIds.add(s.activeSessionId);
      }
    }
    // Count via the cheap stat-only index, deduped across spellings (on a
    // case-insensitive fs two spellings can serve the SAME physical dir).
    const index = mergeSessionIndexes(
      storageCwds.map((cwd) => ({ cwd, entries: indexSessions({ fs: defaultFs, grokHome, cwd }) })),
    );
    const clearable = index.filter((e) => !liveIds.has(e.id)).length;
    if (clearable === 0) {
      void vscode.window.showInformationMessage("No history to clear.");
      return;
    }
    const kept = liveIds.size;
    const choice = await vscode.window.showWarningMessage(
      `Delete ${clearable} session${clearable === 1 ? "" : "s"} from this workspace's history?` +
        (kept ? ` ${kept} live session${kept === 1 ? "" : "s"} will be kept.` : "") +
        " This cannot be undone.",
      { modal: true },
      "Delete All",
    );
    if (choice !== "Delete All") return;

    const removed: string[] = [];
    for (const cwd of storageCwds) {
      try {
        removed.push(...clearSessions({ fs: defaultFs, grokHome, cwd, exceptIds: [...liveIds] }));
      } catch (e) {
        this.output.appendLine(`[sessions] clear failed under ${cwd}: ${(e as Error).message}`);
      }
    }

    // Purge our meta overrides + read cache for every removed id.
    if (removed.length) {
      const next = { ...this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {}) };
      let changed = false;
      for (const id of removed) {
        this.dropCacheEntry(id);
        if (next[id]) {
          delete next[id];
          changed = true;
        }
      }
      if (changed) await this.context.globalState.update(SESSION_META_KEY, next);
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
    this.reveal();
  }

  /** Resolve the xAI key for Speech-to-Text: the `grok.voiceApiKey` setting,
   *  else `GROK_VOICE_API_KEY` / `XAI_API_KEY` from the workspace .env or the
   *  host environment. Distinct from the CLI's login — STT is a separate xAI
   *  product (api.x.ai/v1/stt) that wants a console.x.ai developer key. */
  private resolveVoiceApiKey(cwd: string): string | undefined {
    const setting = vscode.workspace.getConfiguration("grok").get<string>("voiceApiKey", "");
    const env = { ...process.env, ...this.readDotEnv(cwd) } as Record<string, string | undefined>;
    return resolveVoiceKey({ setting, env });
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
    const cwd = this.activeWorkspaceCwd();
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
      "Voice control needs an xAI API key (Speech-to-Text) — a separate console.x.ai developer key, not your Grok CLI login. Set grok.voiceApiKey, or GROK_VOICE_API_KEY / XAI_API_KEY in your workspace .env.",
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
    const cwd = this.activeWorkspaceCwd();
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
        vscode.window.showErrorMessage(`Voice transcription failed: ${e.message}`);
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
    const cwd = this.activeWorkspaceCwd();
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
  ): Promise<void> {
    const base = path.basename(filePath);
    // Unique key per diff so sequential edits to the same file don't collide on
    // the content map. The trailing real filename gives VS Code the language.
    const key = String(this.diffSeq++);
    const left = vscode.Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/before/${base}` });
    const right = vscode.Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/after/${base}` });
    this.diffProvider.set(left, oldText);
    this.diffProvider.set(right, newText);
    if (requestId !== undefined) {
      // Auto-open is per pending permission; remember the URIs so the matching
      // tab can be closed (and its content dropped) once the user decides (#21).
      this.closeDiffForRequest(requestId); // drop a stale diff for the same request first
      this.openDiffsByRequest.set(String(requestId), { left, right });
    }
    // preview:true reuses a single preview tab across grok's many small sequential
    // edits; preserveFocus:true keeps focus on the chat so the permission card is
    // immediately clickable.
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `Grok proposed: ${base}`,
      { preview: true, preserveFocus: true } as vscode.TextDocumentShowOptions,
    );
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

  private async createPlanReviewSnapshot(plan: string, sessionId?: string): Promise<{ path: string; name: string }> {
    const content = plan && plan.trim() ? plan : "(empty plan)\n";
    const sessionPart = sanitizePlanReviewFilePart(
      sessionId ?? this.focused.activeSessionId ?? this.focused.client?.sessionId ?? "session",
    ).slice(0, 80);
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, "plan-reviews", sessionPart);
    await vscode.workspace.fs.createDirectory(dir);
    const uri = await this.uniquePlanReviewUri(dir, `${planReviewFileBaseName(content)}.md`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
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

  /** Delete staged images older than 7 days. A pending attachment lives for
   *  minutes; anything week-old is an orphan (pasted, never sent, window
   *  closed). The age gate keeps a second VS Code window's fresh staging
   *  files safe — globalStorage is shared across windows. */
  private async sweepImageStaging(): Promise<void> {
    const dir = this.imageStagingDir();
    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const name of await fs.promises.readdir(dir)) {
        const p = path.join(dir, name);
        try {
          if ((await fs.promises.stat(p)).mtimeMs < cutoff) await fs.promises.unlink(p);
        } catch { /* raced or locked — next sweep gets it */ }
      }
    } catch { /* staging dir doesn't exist yet */ }
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
      this.reveal();
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

  private async addDroppedFile(absPath: string, shiftHeld: boolean): Promise<void> {
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
      const meta = await client.prompt(promptBlocks);
      if (gen !== session.gen) return; // session was switched mid-turn
      if (slashCommand === "compact") {
        // A native /compact streams no agent content (research/compact.md), so
        // the turn would end with a blank bubble and no sign it worked. Paint a
        // live-only confirmation into that empty bubble. Deliberately not
        // persisted: grok's own history has no such message, so re-focus (which
        // replays the session buffer) keeps it but a disk restore won't.
        this.emit(session, { type: "messageChunk", text: "Compacted." });
      }
      // Skip agentEnd if a verdict was clicked mid-turn (afterTurn is queued).
      // Otherwise busy clears here, then the user could send during the brief
      // gap before afterTurn's own client.prompt starts. afterTurn emits its
      // own agentEnd at the end of its prompt, so busy stays true throughout.
      if (!session.afterTurn) {
        this.emit(session, { type: "agentEnd", meta });
        this.setStatus(session, "done");
      }
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
        void this.ensurePrimed(client, session, gen);
      }
    } catch (err) {
      if (gen !== session.gen) return; // prompt rejected because we disposed the old client — don't leak the error into the new session
      const e = err as any;
      const message = e?.data?.message ?? e?.message ?? String(err);
      this.emit(session, { type: "agentError", text: message });
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

  private postInitialState(): void {
    const cfg = vscode.workspace.getConfiguration("grok");
    const cwd = this.activeWorkspaceCwd();
    this.post({
      type: "initialState",
      effort: cfg.get("defaultEffort", ""),
      cwd,
      useCtrlEnter: cfg.get("useCtrlEnterToSend", false),
      extVersion: (this.context.extension.packageJSON as { version?: string })?.version ?? "",
      showThinking: cfg.get("showThinking", false),
    });
    // A fresh/reloaded webview needs the panel-visibility state too — the
    // treeView visibility event fired long before this webview existed.
    if (this.historyPanelVisible) this.post({ type: "historyPanelVisible", value: true });
    // Sync the active-editor context chip into the fresh webview (the config
    // gate + no-editor case live inside refreshImplicitChip).
    this.refreshImplicitChip(true);
    this.postVoiceConfigured();
    // Sweep stale empty primer sessions once the first session is live (so the
    // newly-focused session is excluded from the sweep).
    void this.startSession().then(() => this.sweepEmptyPrimerSessions());
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
    "promptComplete", "xaiNotification", "agentEnd",
  ]);
  // Subset: content only, not lifecycle. Lets promptComplete/agentEnd through so
  // the webview's `busy` state clears when the false-approval turn ends.
  private static readonly PLAN_REJECT_SUPPRESS = new Set([
    "messageChunk", "userMessageChunk", "thoughtChunk", "toolCall", "toolCallUpdate", "xaiNotification",
  ]);

  private post(message: HostMsg): void {
    if (this.focused.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (this.focused.suppressPlanReject && GrokSidebar.PLAN_REJECT_SUPPRESS.has(message.type)) return;
    this.view?.webview.postMessage(message);
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
    if (message.type === "clearMessages") session.buffer = [];
    else session.buffer.push(message);
    if (session === this.focused) this.view?.webview.postMessage(message);
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
    this.postMode();
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
    if (cur.hasHistory || cur.afterTurn || busy) return; // real/active work — keep it parked & alive
    // Empty (primer-only) session being left behind (New Session, or switching to
    // another): tear down its process AND delete its on-disk dir so it doesn't pile
    // up in history (#24). The next focused session becomes the single live "New
    // session"; abandoning this one removes it entirely.
    this.disposeSession(cur);
    this.removeSessionFromDisk(cur.activeSessionId, this.sessionCwd(cur));
    this.postSessionsList();
  }

  /** Delete a session's on-disk dir (under ITS workspace) + drop its meta
   *  override and read-cache entry. Used when an empty (primer-only) session is
   *  abandoned. Best-effort — a locked/already-gone dir is logged, not thrown. */
  private removeSessionFromDisk(id: string | undefined, cwd: string): void {
    if (!id) return;
    const grokHome = resolveGrokHome(process.env);
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
    } catch (e) {
      this.output.appendLine(`[sessions] could not remove empty session ${id}: ${(e as Error).message}`);
    }
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    if (overrides[id]) {
      const next = { ...overrides };
      delete next[id];
      void this.context.globalState.update(SESSION_META_KEY, next);
    }
    this.dropCacheEntry(id);
  }

  /** One-shot cleanup (per activation) of empty, primer-only sessions left on disk by
   *  earlier runs — the "extra sessions I didn't create" of #24. Scans the newest
   *  slice by mtime (bounded, so it stays cheap on a large store), confirms each
   *  candidate is genuinely primer-only by reading its chat history, and deletes it.
   *  Never touches a live session, a renamed one, or a session that isn't ours. */
  private sweepEmptyPrimerSessions(): void {
    if (this.sweptEmptySessions) return;
    this.sweptEmptySessions = true;
    // Deliberately window-scoped: only ever sweep THIS window's workspace store.
    // Other workspaces shown in the panel are never touched on activation.
    const cwd = this.activeWorkspaceCwd();
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
      for (const id of removed) {
        delete next[id];
        this.dropCacheEntry(id);
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
    if (id) {
      this.post({ type: "sessionDot", id, dot: this.dotForId(id) });
      this.sessionsChangedEmitter.fire();
    }
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
    if (id) {
      this.post({ type: "sessionDot", id, dot: this.dotForId(id) });
      this.sessionsChangedEmitter.fire(); // keep the workspace panel's dots live too
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

  /** Start a brand-new session, keeping the current one alive in the background.
   *  `cwd` homes it in another workspace (Grok Workspaces panel); default is this
   *  window's folder. */
  private async newFocusedSession(cwd?: string): Promise<void> {
    this.parkFocused();
    this.focused = new Session();
    await this.startSession(undefined, cwd);
  }

  /**
   * Open the session with grok id `id`. If it's already live in the pool, re-focus
   * it instantly (lossless buffer replay — no reload), whatever workspace it's
   * homed in. Otherwise park the current session and load this one cold from
   * grok's on-disk history into a fresh member — spawned in `cwd` when given
   * (the workspace panel passes the entry's storage cwd), else this window's
   * workspace (the popover's scope).
   */
  private async openSession(id: string, cwd?: string): Promise<void> {
    for (const s of this.pool) {
      if (s.activeSessionId === id && s.client) {
        this.focusSession(s);
        return;
      }
    }
    this.parkFocused();
    this.focused = new Session();
    await this.startSession(id, cwd);
    this.markRead(this.focused); // opening a cold session clears its unread badge
  }

  // ---------- Grok Workspaces panel (tree view) API ----------

  /** The grok id of the session currently shown in the chat. */
  focusedSessionId(): string | undefined {
    return this.focused.activeSessionId;
  }

  /** Append to the extension's output channel (the workspace panel logs here too). */
  log(msg: string): void {
    this.output.appendLine(msg);
  }

  /** Dashboard dot for any session id (live status + persisted unread badge). */
  dotForSession(id: string): Dot {
    return this.dotForId(id);
  }

  /**
   * Newest-first session entries for one workspace — all its storage spellings
   * merged and id-deduped (on a case-insensitive fs two spellings serve the same
   * physical dir), cache-backed like the popover. Mirrors the popover's
   * in-memory overlay: synthesizes a row for a live not-yet-persisted session
   * homed here, and shows a live primer-only session as "New session".
   */
  listWorkspaceSessions(
    storageCwds: string[],
    limit: number,
  ): { entries: Array<SessionListEntry & { storageCwd: string }>; total: number } {
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.context.globalState.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const log = (m: string) => this.output.appendLine(m);
    const index = mergeSessionIndexes(
      storageCwds.map((cwd) => ({ cwd, entries: indexSessions({ fs: defaultFs, grokHome, cwd, log }) })),
    );

    // Read the visible window, grouped by storage spelling (cache keys are cwd-scoped).
    const page = index.slice(0, Math.max(0, limit));
    const idsByCwd = new Map<string, string[]>();
    for (const e of page) {
      const ids = idsByCwd.get(e.storageCwd) ?? [];
      ids.push(e.id);
      idsByCwd.set(e.storageCwd, ids);
    }
    const entryById = new Map<string, SessionListEntry & { storageCwd: string }>();
    for (const [cwd, ids] of idsByCwd) {
      const mtimeById = new Map(
        index.filter((e) => e.storageCwd === cwd).map((e) => [e.id, e.mtimeMs] as const),
      );
      for (const e of this.readEntriesCached(ids, mtimeById, overrides, cwd, grokHome, log)) {
        entryById.set(e.id, { ...e, storageCwd: cwd });
      }
    }
    let entries = page
      .map((e) => entryById.get(e.id))
      .filter((e): e is SessionListEntry & { storageCwd: string } => !!e);
    entries.sort((a, b) => b.updatedAt - a.updatedAt);

    // In-memory overlay, mirroring postSessionsList: live pool sessions homed here.
    const keys = new Set(storageCwds.map((c) => canonicalizeWorkspacePath(c)));
    const onDisk = new Set(index.map((e) => e.id));
    let total = index.length;
    const synthetic: Array<SessionListEntry & { storageCwd: string }> = [];
    const liveEmpty = new Set<string>();
    for (const s of this.pool) {
      const id = s.activeSessionId;
      if (!id || !keys.has(canonicalizeWorkspacePath(this.sessionCwd(s)))) continue;
      if (!s.hasHistory) liveEmpty.add(id);
      if (!onDisk.has(id)) {
        const home = this.sessionCwd(s);
        synthetic.push({ ...this.liveSessionEntry(s, id, home, overrides), storageCwd: home });
        total += 1;
      }
    }
    if (synthetic.length) {
      synthetic.sort((a, b) => b.updatedAt - a.updatedAt);
      entries = [...synthetic, ...entries];
    }
    for (const e of entries) {
      if (!e.customName && liveEmpty.has(e.id)) e.displayName = "New session";
    }
    return { entries, total };
  }

  /** Open a session (possibly homed in another workspace) into the chat panel: a
   *  live pool member re-focuses instantly; anything else cold-loads with grok
   *  spawned in ITS workspace. */
  async openSessionInWorkspace(storageCwd: string, id: string): Promise<void> {
    this.reveal();
    await this.openSession(id, storageCwd);
  }

  /** Start a brand-new session homed in the given workspace. */
  async newSessionInWorkspace(cwd: string): Promise<void> {
    this.reveal();
    await this.newFocusedSession(cwd);
  }

  async deleteSessionInWorkspace(storageCwd: string, id: string, name?: string): Promise<void> {
    await this.deleteSession(id, name, storageCwd);
  }

  /** Rename via the panel — an input box instead of the popover's inline field. */
  async renameSessionFromPanel(id: string, currentName: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "Rename session (leave empty to restore the generated name)",
      value: currentName,
    });
    if (name === undefined) return; // dismissed
    this.renameSession(id, name);
  }

  /** Mirror the workspace panel's visibility into the webview: while the panel is
   *  showing, the chat's own history button hides (New stays). */
  setHistoryPanelVisible(visible: boolean): void {
    this.historyPanelVisible = visible;
    this.post({ type: "historyPanelVisible", value: visible });
  }

  private reveal(): void {
    this.view?.show?.(true);
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
      selStart = editor.selection.start.line + 1;
      selEnd = editor.selection.end.line + 1;
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
    // A selection change on the SAME file keeps the user's eye-off choice;
    // switching files resets it (new file, fresh default).
    if (prev && prev.path === absPath) next.hidden = prev.hidden;
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

    if (Object.keys(dotEnv).length > 0) {
      this.output.appendLine(`[env] loaded ${Object.keys(dotEnv).length} var(s) from .env`);
    }
    return env;
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
<link rel="stylesheet" href="${mediaUri("chat.css")}" />
</head>
<body class="${this.showThinking() ? "" : "thinking-hidden"}" style="--chat-zoom: ${this.chatFontScale()}">

  <header class="top-bar">
    <button id="history-btn" class="toolbar-btn" title="Session history"></button>
    <button id="new-btn" class="toolbar-btn" title="New session"></button>
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
        <div id="input-highlight" class="input-highlight" aria-hidden="true"></div>
        <textarea id="input" placeholder="Ask Grok..." rows="3"></textarea>
        <button id="mic-btn" class="mic-btn" title="Voice control"></button>
      </div>
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <button id="add-btn" class="toolbar-btn" title="Add context"></button>
          <button id="gear-btn" class="toolbar-btn" title="Settings"></button>
          <div class="context-donut" id="donut" title="Context usage">
            <svg width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="5" fill="none" stroke="var(--vscode-editorWidget-border,#444)" stroke-width="3"/>
              <circle id="donut-arc" cx="8" cy="8" r="5" fill="none" stroke="var(--vscode-charts-green,#4ec9b0)" stroke-width="3" stroke-dasharray="0 999" transform="rotate(-90 8 8)"/>
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
    <div id="slash-popover" class="slash-popover" hidden></div>
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
