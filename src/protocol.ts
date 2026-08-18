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
import type { McpServerView } from "./mcp";

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
  // Whether `deleteSession` can take the conversation the requester is READING.
  // Older hosts refuse it — the live CLI re-persisted the files the moment they
  // went, so the delete did not stick — and a client that offers the control
  // anyway is offering one that answers with a refusal. Capability, not version.
  deleteActiveSession: true,
  // Read-only project file browse for AFK Pilot (phone/browser). Field presence
  // is the gate — never a version check. Local VS Code / desktop webviews
  // receive the flag but must not draw a second explorer; only IS_REMOTE clients
  // mount the in-page browser. Older hosts omit the field → nothing advertised.
  browseProjectFiles: true,
  // Edit+save existing project files from a remote. Separate from browse so a
  // host can offer list/read without a write path. OPT-IN field presence.
  editProjectFiles: true,
} as const;

/** Machine-readable `error.code` for a send abandoned after its userMessage echo. */
export const INTERRUPTED_SEND_CODE = "interrupted-send" as const;

/** Host-kind affordances merged into `initialState.capabilities` at post time. */
export type HostUiCapabilities = {
  uploadFile: boolean;
  remoteVoice: boolean;
  deleteActiveSession?: boolean;
  /**
   * Read-only project file browse (list dir + read previewable files) for
   * remote clients. OPT-IN: absent/false = hide. Current hosts set true via
   * HOST_CAPABILITIES; the webview still only mounts UI when remote.
   */
  browseProjectFiles?: boolean;
  /**
   * Save edits to existing project text files from a remote client.
   * OPT-IN and independent of {@link browseProjectFiles}: a host may advertise
   * browse without edit. Absent/false = no write UI and no write path.
   * No create/delete/rename in this pass.
   */
  editProjectFiles?: boolean;
  /**
   * Whether generated media is served with honest byte-range responses. This
   * is opt-in: hosts without this capability must keep generated videos lazy.
   */
  servesMediaRanges?: boolean;
  /**
   * Gear → Move view. Opt-out: absent/true = show (older VS Code hosts never
   * sent this flag but always supported the control); false = hide (desktop).
   */
  relocateView?: boolean;
  /**
   * Whether gear → Move view may offer "To Secondary Side Bar". Same opt-out
   * polarity as relocateView, and for the same reason: every extension built
   * before Cursor refused that container sends nothing here and had one.
   * False swaps the two panel destinations for edge-explicit ones.
   */
  secondarySideBar?: boolean;
  /**
   * Show the empty-state hint pointing at the editor's own move-view picker.
   * OPT-IN — absent/false = no hint. Decided entirely by the host: it is true
   * only where the secondary side bar was refused AND the user has not yet
   * opened that picker from anywhere.
   */
  moveViewHint?: boolean;
  /**
   * Gear → Show extension logs. Same opt-out polarity as relocateView —
   * absent/true = show; false = hide (desktop logs to stdout only).
   */
  showOutput?: boolean;
  /**
   * Gear → Toggle Developer Tools. OPT-IN: absent/false = hide. Unpackaged
   * desktop only — never offered on VS Code or packaged builds.
   */
  toggleDevTools?: boolean;
  /**
   * Whether a generated-image click opens a host editor tab (`openFile`).
   * Opt-out: absent/true = yes (older VS Code hosts never sent this flag but
   * always opened editors); false = no editor — the webview uses the in-app
   * lightbox instead (desktop). Remote clients force the lightbox regardless
   * of this flag: the capabilities a phone receives are the desk machine's.
   */
  openInEditor?: boolean;
  /**
   * Whether generated-video hover actions may reveal the file in the host's
   * file manager. OPT-IN: absent/false keeps the existing open-file action.
   */
  showInFolder?: boolean;
  /**
   * Open View-all text and proposed diffs in the shared in-app preview
   * overlay instead of a host editor or bare window. OPT-IN: absent/false
   * keeps the current path (VS Code tabs, older desktop windows, remote
   * inline expand). Desktop advertises this; remotes never receive it.
   */
  previewInApp?: boolean;
  /**
   * Gear → Settings opens a VS Code editor-area tab instead of the
   * in-page overlay. OPT-IN: absent/false = overlay (desktop, remote, older
   * hosts). Remotes never receive it — a phone cannot open a desk editor tab.
   */
  settingsEditor?: boolean;
  /**
   * The rail's "add project folder" control. OPT-IN, unlike the two above:
   * absent/false = hide. A host that never sent it cannot open a folder picker,
   * and VS Code deliberately does not — its workspace is VS Code's to manage.
   */
  addProjectFolder?: boolean;
};

export type HostMsg =
  | { type: "initialState"; effort: string; cwd: string; useCtrlEnter: boolean; extVersion: string; showThinking: boolean; expandCommandOutputs: boolean; steerByDefault: boolean; soundNotifications: boolean; processingSound: boolean; readRepliesAloud: boolean; /** Global "Use this app for" — absent on older hosts means Knowledge work. */ appPurpose?: "knowledge" | "coding";
      /** VS Code language id for command View all, from the host shell dialect.
       *  Absent on older hosts — View all then omits language. */
      commandLanguage?: string;
      /** Which GUI is on the other end. A phone is looking at neither the
       *  extension nor the desktop app, so it cannot infer this, and its
       *  About page has to name what it is connected to. Optional and
       *  additive: absent means an older host, and the page keeps the local
       *  panel rather than inventing an answer. */
      hostKind?: "extension" | "desktop";
      /** The desk machine's display name — the same string the device list
       *  shows, so "Connected to" names something the user recognises. */
      hostName?: string;
      /** Product telemetry opt-out. Absent on older hosts; remotes treat that
       *  as unknown and show the explanation without an on/off claim. */
      telemetryEnabled?: boolean;
      capabilities: HostUiCapabilities }
  /** Live retraction of `capabilities.moveViewHint`, sent the moment the user
   *  opens the host's move-view picker. `initialState` is not re-sent on a
   *  session swap, so without this the webview keeps a stale true and rebuilds
   *  the hint the user has already acted on. */
  | { type: "moveViewHint"; value: boolean }
  /** Connected agents plus host-observed, view-only version facts. Version
   * fields are additive so an older host/client keeps the connection UI.
   * `needsLogin` is the account that is still configured but answered an
   * auth-shaped failure: every affordance that would otherwise imply it works
   * (a selectable model row, a silently empty history) becomes the same sign-in
   * action the connect flow uses.
   * `checking` is a re-observation in flight (Settings → Providers Refresh). It
   * is the ONLY source of that spinner: a client must never latch it locally,
   * or an older host that ignores `refreshProviders` would spin forever. */
  | { type: "providerState"; providers: { id: "grok" | "codex" | "claude"; connected: boolean; needsLogin?: boolean; cliVersion?: string; adapterVersion?: string; latestCliVersion?: string; updateAvailable?: boolean }[]; checking?: boolean }
  | { type: "mcpServers"; servers: McpServerView[]; loading?: boolean; error?: string; warning: string }
  | { type: "codexInstallProgress"; phase: "downloading" | "verifying" | "installing" | "idle"; receivedBytes?: number; totalBytes?: number; reason?: string }
  /** Plan picker gate. `recheckable` means the version probe failed (not a
   *  verified-old CLI) — the row stays clickable so a later pick re-probes. */
  | { type: "planModeAvailability"; available: boolean; reason?: string; recheckable?: boolean }
  | { type: "showThinking"; value: boolean }
  /** Live update of the global app-purpose preference (Knowledge work / Coding). */
  | { type: "appPurpose"; value: "knowledge" | "coding" }
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
  /** Desktop app update notice (manual download page). Host-local; VS Code
   *  never sends this. Capability = frame arrived; no host flag. Fallback when
   *  the in-app updater cannot check or download. */
  | { type: "updateAvailable"; version: string; url: string }
  /** Desktop in-app update is downloaded and waiting for restart. Host-local. */
  | { type: "updateReady"; version: string }
  | { type: "initialized"; info: { cliPath: string; cwd: string; version: string | null; provider?: "grok" | "codex" | "claude"; init: { protocolVersion?: unknown } } }
  | { type: "cliUpdating" }
  // `worktree` gates the gear's Apply/Remove worktree items to worktree sessions.
  | { type: "session"; sessionId: string; models: ModelInfo[]; currentModelId: string | undefined; worktree?: boolean; provider?: "grok" | "codex" | "claude" }
  // The focused conversation's display name, using the same precedence as a
  // history row. It is separate from `sessions` because VS Code does not keep
  // that browser-only list populated while the history popover is closed.
  // `repoCwd` is the PROJECT this conversation belongs to, which is not always
  // its `cwd`: a worktree session runs in an isolated checkout that is
  // deliberately not a catalog row, so a client resolving the label from `cwd`
  // alone falls back to that directory's leaf — and if the leaf happens to match
  // another project's name, it presents one project's conversation as another's.
  // Optional and additive: a client that never sees it keeps its old fallback.
  | { type: "sessionName"; sessionId: string; name: string; cwd: string; repoCwd?: string }
  | { type: "modelChanged"; modelId: string }
  | { type: "modeChanged"; modeId: string }
  | { type: "openModePopover" }
  | { type: "voiceState"; status: "listening" | "transcribing" | "idle" }
  | { type: "voiceConfigured"; value: boolean; sendPhrase?: string; keyterms?: string[] }
  /** Live `grok.telemetry.enabled` so the settings surface stays in sync. */
  | { type: "telemetryEnabled"; value: boolean }
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
  /**
   * Answer to `listProjectDir` (remote file browse). `cwd` echoes the scoped
   * root; `relPath` is the listed directory ("" = repo root). No absolute host
   * paths — only workspace-relative entry paths.
   */
  | {
      type: "projectDirListing";
      requestId?: string;
      cwd: string;
      relPath: string;
      ok: true;
      entries: Array<{ name: string; kind: "file" | "dir"; relPath: string }>;
      truncated: boolean;
    }
  | { type: "projectDirListing"; requestId?: string; cwd: string; relPath: string; ok: false; reason: string }
  /**
   * Answer to `readProjectFile`. Preview kinds match desktop `classifyFilePreview`
   * (markdown/json/image/text); binary / external / oversize fail with `ok:false`.
   * Caps: {@link FILE_PREVIEW_MAX_BYTES} / {@link FILE_PREVIEW_MAX_IMAGE_BYTES}
   * in `src/file-tree.ts`.
   *
   * When the host advertises `editProjectFiles`, text kinds also carry `stamp`
   * + `absPath` so a later save can prove identity (same file) and version
   * (mtime+size). Image previews never include those fields.
   */
  | {
      type: "projectFileContent";
      requestId?: string;
      cwd: string;
      relPath: string;
      ok: true;
      kind: "markdown" | "json" | "image" | "text";
      text?: string;
      dataUrl?: string;
      pretty?: boolean;
      /** Present for editable text when host advertises edit — mtime+size. */
      stamp?: { mtimeMs: number; size: number };
      /**
       * Absolute path this content was read at. Sent only with edit capability
       * so the save can refuse a cross-project relPath collision (see
       * `writeTreeFile` expectedAbsPath). Round-trip only — never displayed.
       */
      absPath?: string;
    }
  | { type: "projectFileContent"; requestId?: string; cwd: string; relPath: string; ok: false; reason: string }
  /**
   * Answer to `writeProjectFile`. Success returns the new stamp so the client
   * can keep editing without re-reading. Failure reasons mirror `writeTreeFile`
   * (`changed`, `workspace changed`, containment, etc.).
   */
  | {
      type: "projectFileWriteResult";
      requestId?: string;
      cwd: string;
      relPath: string;
      ok: true;
      stamp: { mtimeMs: number; size: number };
    }
  | {
      type: "projectFileWriteResult";
      requestId?: string;
      cwd: string;
      relPath: string;
      ok: false;
      reason: string;
    }
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
  // Context occupancy for the donut. `used` is optional so an adapter can
  // deliver `usage_update.size` (the real window) before any occupancy exists.
  | { type: "contextUsage"; used?: number; window?: number }
  | { type: "agentReset" }
  | { type: "agentError"; text: string }
  | { type: "agentEnd"; meta?: PromptResultMeta }
  | { type: "exit"; code: number | null }
  | { type: "setBusy"; value: boolean; locked?: boolean }
  | { type: "summarizing" }
  | { type: "sessionContext" }
  | { type: "clearMessages" }
  // "provider-connected" is the one SUCCESS state here: a re-check that worked
  // used to leave a bare empty session, indistinguishable from nothing having
  // happened. It clears itself when the first message paints.
  // "no-project" is the desktop empty-open-set state: chat cannot start until
  // the user adds a folder. It replaces the baked "Starting" spinner that
  // otherwise never clears (startSession used to return without unlocking).
  // `launched` says the HOST already opened the login terminal, so the panel can
  // show it as done. Without it an automatically opened terminal leaves the
  // button looking untouched, which reads as "press it again".
  | { type: "onboarding"; state: "connect-agent" | "missing-cli" | "auth-required" | "missing-codex" | "codex-login" | "missing-claude" | "claude-login" | "provider-connected" | "no-project"; platform?: string; reason?: string; provider?: "grok" | "codex" | "claude"; launched?: boolean }
  // resumeFailed is additive: a remote resume refusal names the requested id so
  // the browser outbox can fail closed. Older clients ignore the extra field.
  // code is additive too — a harness must not match user-facing `text`.
  // "interrupted-send" is a send abandoned after its userMessage echo.
  | { type: "error"; text: string; resumeFailed?: { id: string }; code?: typeof INTERRUPTED_SEND_CODE }
  | { type: "hostNotice"; level: "info" | "warning"; text: string }
  | { type: "xaiNotification"; update?: unknown }
  // Persisted xAI lifecycle (method _x.ai/session/update): subagent spawn/finish
  // plus replayed turn_completed, whose timestamp finalizes the agent footer.
  | { type: "subagentUpdate"; update?: unknown; timestampMs?: number }
  /**
   * Live child-session stream demuxed off the parent ACP stdout (#62).
   * Additive: an older webview that ignores this type loses nothing it has today.
   * Child transcripts are not replayed on cold session/load.
   */
  | { type: "childStream"; childSessionId: string; event: "messageChunk"; text: string }
  | { type: "childStream"; childSessionId: string; event: "thoughtChunk"; text: string }
  | { type: "childStream"; childSessionId: string; event: "userMessageChunk"; text: string }
  | { type: "childStream"; childSessionId: string; event: "toolCall"; call: ToolCallPayload }
  | { type: "childStream"; childSessionId: string; event: "toolCallUpdate"; call: ToolCallPayload }
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
  | { type: "sessions"; entries: SessionListEntry[]; activeId?: string | null; dots: Record<string, Dot>; offset: number; total: number; hasMore: boolean; nextOffset: number; providerCursor?: { grokOffset: number; codexHighWater?: { updatedAt: number; id: string } }; query: string }
  // A preview page for ONE repo, answering `listRepoSessions`. Deliberately a
  // separate frame from `sessions`: that one is the focused history list and
  // owns paging/search/auto-open state, so a sibling repo's rows arriving on it
  // would clobber the list the user is actually reading. `cwd` echoes the scope
  // the host resolved, which is also the capability signal — a client that
  // never sees this frame keeps its single-repo fallback.
  | { type: "repoSessions"; cwd: string; entries: SessionListEntry[]; dots: Record<string, Dot>; total: number }
  // Every pinned conversation, across ALL repos — the projects rail's Pinned
  // group. Deliberately not per-repo: a pin is only worth anything if it lifts a
  // conversation OUT of the project you would otherwise have to open first, so
  // no repo-scoped frame can answer it. Entries carry their own `cwd`, which is
  // what lets a row name its repo and reopen in the right checkout.
  | { type: "pinnedSessions"; entries: SessionListEntry[]; dots: Record<string, Dot> }
  // `canAddProject` is how the VS Code projects rail learns it may offer "Add
  // project": that view is resolved on its own and gets no `initialState`, so it
  // has no `capabilities` to read. Optional and additive — a client that never
  // sees the field paints no control, which is the safe way round.
  | {
      type: "repos";
      entries: RepoListEntry[];
      selectedCwd: string;
      activeCwd: string;
      canAddProject?: boolean;
      /**
       * The folder the EDITOR has open, which since history started following
       * the rail is no longer the same thing as `selectedCwd`. The VS Code rail
       * marks this one "Your IDE" and pins it to the top: you can be working in
       * another project while the window stays where it was, and the rail has to
       * be able to say which is which. Optional and additive — a client that
       * never sees it falls back to the selection, as it did before.
       */
      workspaceCwd?: string;
    }
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
  | { type: "usage"; turn?: PromptUsage; session?: PromptUsage; afterUserMessage?: number; afterHistoryEvent?: number };

/** webview -> host */
export type WebviewMsg =
  | { type: "ready"; tabToken?: string }
  // Browser-owned remote preferences reported for session_start telemetry.
  | { type: "remotePreferences"; fontScale: number; readRepliesAloud: boolean; summarizeRepliesAloud?: boolean; usesTouch: boolean }
  | { type: "send"; text: string; chips?: FileChip[]; bare?: boolean; queuedSendId?: string; submissionId?: string }
  // `cwd` names the project to start in, for a client that can SEE which project
  // it is asking for — the VS Code rail's per-project "+". Optional and additive:
  // omitted, the host starts in its own scope exactly as before. The host
  // resolves it through the catalog and ignores anything unknown, and a remote's
  // value is discarded outright (`newRemoteSession` starts in that tab's repo).
  | { type: "newSession"; cwd?: string }
  | { type: "cancel" }
  | { type: "pickModel" }
  | { type: "setMode"; modeId: "agent" | "plan" | "yolo" }
  | { type: "removeChip"; id: string }
  | { type: "toggleChip"; id: string }
  | { type: "openFile"; path: string }
  | { type: "showInFolder"; path: string }
  | { type: "openUrl"; url: string }
  // `language` is optional. Command View all may send the host shell language
  // (`initialState.commandLanguage`: powershell / shellscript / bat). Output
  // omits it so the untitled editor can detect file-shaped content. An absent
  // field must not be rewritten to plaintext.
  //
  // `filename` is an additive save-as hint (basename or a host-joined default
  // path). Absent: untitled / viewer, as before. Present: each host chooses
  // delivery — VS Code still opens an untitled tab; desktop opens the OS save
  // dialog (session Markdown export and the preview overlay's Save As). An
  // older host ignores the field and keeps the untitled/viewer path.
  | { type: "openText"; content: string; language?: string; filename?: string }
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
  | { type: "addProjectFolder" }
  /** Close one project folder. It leaves the rail; nothing leaves the disk. */
  | { type: "removeProjectFolder"; cwd?: string }
  | { type: "openGlobalConfig" }
  | { type: "openProjectConfig" }
  | { type: "listMcpServers" }
  | { type: "setMcpServerEnabled"; name: string; enabled: boolean }
  | { type: "showLogs" }
  /** Unpackaged desktop only — toggle Chromium DevTools (gear / F12). */
  | { type: "toggleDevTools" }
  /** Open the host settings UI (VS Code: workbench settings focused on grok). */
  | { type: "openSettings"; section?: string }
  /** Open the shared Grok settings surface as a VS Code editor tab. */
  | { type: "openSettingsSurface"; category?: string }
  /** Close the Grok settings editor tab (Escape / Close on that page). */
  | { type: "closeSettingsSurface" }
  // `panel-right` / `panel-bottom` dock the panel on that edge before revealing;
  // plain `panel` leaves the layout alone (view-move.ts § panelPositionFor).
  //
  // `pick` maps to no container on purpose, so the host falls through to its own
  // destination picker. That picker targets a LOCATION rather than a container,
  // which is the only way into a dock a host renders for itself — in Cursor it
  // is the difference between reaching the secondary side bar and not.
  | { type: "moveView"; location: "panel" | "panel-right" | "panel-bottom" | "sidebar" | "auxiliarybar" | "pick" }
  | { type: "setShowThinking"; value: boolean }
  /** Persist the global "Use this app for" preference (Knowledge work / Coding). */
  | { type: "setAppPurpose"; value: "knowledge" | "coding" }
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
  /** Persist `grok.voiceSendPhrase`. Empty disables hands-free send. */
  | { type: "setVoiceSendPhrase"; value: string }
  /** Persist `grok.voiceKeyterms` (user dictionary terms only). */
  | { type: "setVoiceKeyterms"; value: string[] }
  /** Persist `grok.telemetry.enabled`. Desktop toggle; remotes do not send this. */
  | { type: "setTelemetryEnabled"; value: boolean }
  /**
   * Attach a user-selected file. VS Code posts a `path` (file URI or absolute)
   * from the webview drag-drop surface. Desktop posts only a host-minted
   * `handle` (see file-selection-registry) — a renderer-invented path is refused.
   */
  | { type: "dropFile"; path?: string; handle?: string; shift: boolean }
  | { type: "permissionAnswer"; requestId: number | string; optionId: string }
  | { type: "exitPlanAnswer"; requestId: number | string; verdict: "approved" | "abandoned" | "rejected"; comment?: string }
  | { type: "questionAnswer"; requestId: number | string; answers?: Record<string, string>; annotations?: Record<string, { notes?: string; preview?: string }> }
  | { type: "questionCancel"; requestId: number | string }
  | { type: "setModel"; modelId: string; provider?: "grok" | "codex" | "claude" }
  | { type: "installCodex" }
  | { type: "cancelCodexInstall" }
  | { type: "runInstallCmd" }
  | { type: "runGrokLogin"; provider?: "grok" | "codex" | "claude" }
  | { type: "logout"; provider?: "grok" | "codex" | "claude" }
  | { type: "checkGrokUpdate" }
  | { type: "updateGrok" }
  | { type: "recheckConnection"; provider?: "grok" | "codex" | "claude" }
  /** Re-observe every account without asserting anything about it. Unlike
   *  `recheckConnection` this never marks a provider connected — it re-runs the
   *  CLI locators and re-probes the credentials of accounts already connected,
   *  so Settings → Providers can be made to tell the truth on demand. */
  | { type: "refreshProviders" }
  | { type: "retryProviderSession"; provider?: "grok" | "codex" | "claude" }
  | { type: "listSessions"; offset?: number; limit?: number; providerCursor?: { grokOffset: number; codexHighWater?: { updatedAt: number; id: string } }; query?: string }
  // Preview rows for a repo the client is NOT currently in — the projects rail
  // shows a few sessions per repo without switching to it. `cwd` is matched
  // against the repo catalog and dropped when it isn't a row, so this never
  // widens what a remote can read beyond the repos it is already shown.
  | { type: "listRepoSessions"; cwd: string; limit?: number }
  // `cwd` names the session's own checkout so the host can find it without
  // assuming it lives in the repo the tab happens to be in — pinning is offered
  // on every rail row, including other projects' conversations.
  | { type: "toggleSessionPin"; id: string; cwd?: string; pinned: boolean }
  | { type: "selectRepo"; cwd: string }
  | { type: "toggleRepoPin"; cwd: string; pinned: boolean }
  // Where a project sits in the remote client's rail. Both answers are sent:
  // `archived: false` means "hold this one in view", which is a different claim
  // from never having said anything (see RepoArchiveChoice). Purely a remote
  // affordance — the VS Code repo picker neither offers it nor reads it.
  | { type: "setRepoArchived"; cwd: string; archived: boolean }
  // Folder-icon colour for a project in the conversation rail. `color` is one of
  // the host's palette ids, or "" for none (the default). Host-persisted and
  // pushed on every `repos` row — same capability pattern as setRepoArchived —
  // so the choice follows the user to a phone rather than living in browser
  // localStorage. Purely a rail affordance; the VS Code repo picker ignores it.
  | { type: "setRepoColor"; cwd: string; color: string }
  // cwd is required to reopen a worktree-isolated session (sessions are keyed
  // by cwd on disk). Omitted → host resolves from meta / workspace root.
  | { type: "resumeSession"; id: string; cwd?: string }
  // cwd names the PROJECT the row belongs to, so a client listing several of
  // them (the browser rail) can act on a conversation without first switching
  // to its repo. Optional and additive: omitted → the host authorizes against
  // the client's selected repo, exactly as before.
  | { type: "renameSession"; id: string; name: string; cwd?: string }
  | { type: "deleteSession"; id: string; name?: string; cwd?: string }
  | { type: "clearAllSessions"; cwd: string }
  | { type: "pickFile" }
  // The composer's `@` file popover: the current token after `@`, posted on
  // every keystroke; answered by `mentionResults`.
  | { type: "mentionQuery"; query: string }
  // A popover pick: attach this workspace-relative file as an explicit chip
  // (same pipeline as drop / the + picker). The `@rel/path` text stays in the
  // composer, so the prompt carries both the prose reference and the chip.
  | { type: "addMentionFile"; relPath: string }
  /**
   * Remote file browse: list one directory under the tab's selected repo
   * (`cwd` must be that scope — see `resolveRemoteFileRoot`). `relPath`
   * optional ("" / omit = repo root). Answered by `projectDirListing`.
   */
  | { type: "listProjectDir"; requestId?: string; cwd: string; relPath?: string }
  /**
   * Remote file open: read one previewable file under the tab's selected repo.
   * Answered by `projectFileContent`. Same fence as list.
   */
  | { type: "readProjectFile"; requestId?: string; cwd: string; relPath: string }
  /**
   * Remote save of an EXISTING text file under the tab's selected repo.
   * No create / delete / rename in this pass — only rewrite content of a file
   * that already exists and was read with stamp + absPath.
   *
   * Both guards are mandatory (same as desktop `writeTreeFile`):
   * - `stamp` — "did this file change under me?" (mtime + size from the read)
   * - `expectedAbsPath` — "is this still the SAME file?" (absolute path at read;
   *   catches a tab that went stale after the desk switched projects)
   *
   * Answered by `projectFileWriteResult`. Capability: `editProjectFiles`.
   */
  | {
      type: "writeProjectFile";
      requestId?: string;
      cwd: string;
      relPath: string;
      text: string;
      stamp: { mtimeMs: number; size: number };
      expectedAbsPath: string;
    }
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
  // `sessionId` is additive: old clients omit it and keep today's path; a
  // present id that is not the dispatch-resolved session is refused.
  | { type: "forkSession"; sessionId?: string }
  // Worktree UI (P2-8): new isolated session / merge back / remove worktree.
  | { type: "newWorktreeSession" }
  | { type: "applyWorktree"; sessionId?: string }
  | { type: "removeWorktree"; sessionId?: string }
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
  /** Desktop gear "Unlink this device…" — host confirms natively, then unlinks. */
  | { type: "unlinkRemoteDevice" }
  | { type: "openRemotePortal"; withHint?: boolean }
  /** Open the desktop release page from the update notice. Host-local — a phone
   *  cannot update the desk. */
  | { type: "openUpdateRelease"; url: string }
  /** Quit and install a downloaded desktop update. Host-local. */
  | { type: "restartToUpdate" };

// Exhaustive maps: `Record<Union["type"], true>` forces every discriminant to be
// a key (missing -> tsc error) and forbids any extra (excess-property -> tsc
// error). The runtime arrays are just the keys, so they can never drift from the
// union without failing the build.
const HOST_MESSAGE_TYPE_MAP: Record<HostMsg["type"], true> = {
  initialState: true, moveViewHint: true, providerState: true, mcpServers: true, codexInstallProgress: true, planModeAvailability: true, showThinking: true, appPurpose: true, fontScale: true, grokUpdateStatus: true, updateAvailable: true, updateReady: true, telemetryEnabled: true,
  initialized: true, cliUpdating: true, session: true, sessionName: true, modelChanged: true,
  modeChanged: true, openModePopover: true, voiceState: true, voiceConfigured: true,
  voicePartial: true, voiceSubmit: true, voiceTranscript: true, voiceError: true,
  chips: true, commandsUpdate: true, mentionResults: true, projectDirListing: true, projectFileContent: true, projectFileWriteResult: true, userMessage: true, agentStart: true,
  thoughtChunk: true, messageChunk: true, media: true, userMessageChunk: true,
  historyReplay: true, historyBatch: true, permissionHistoryQueue: true, planHistoryQueue: true,
  toolCall: true, toolCallUpdate: true, permissionRequest: true, permissionOptions: true,
  permissionResolved: true, exitPlanRequest: true, planResolved: true, questionRequest: true,
  planNotice: true, autoCompactNotice: true, planBlocked: true, promptComplete: true, contextUsage: true, agentReset: true,
  agentError: true, agentEnd: true, exit: true, setBusy: true, summarizing: true,
  sessionContext: true, clearMessages: true, onboarding: true, error: true, hostNotice: true,
  xaiNotification: true, subagentUpdate: true, childStream: true, runProgress: true, commandOutput: true, expandCommandOutputs: true, steerByDefault: true,
  soundNotifications: true, processingSound: true, readRepliesAloud: true, summarizeRepliesAloud: true, speechSummary: true, imageFull: true, moveComposerCaret: true, remoteStatus: true,
  setAllToolDetails: true, focusInput: true, restoreComposer: true, truncateMessages: true, uiConfirmRequest: true,
  sessions: true, repoSessions: true, pinnedSessions: true, repos: true, sessionDot: true, queuedSends: true, submitQueuedSend: true,
  steerUnavailable: true, usage: true,
};

const WEBVIEW_MESSAGE_TYPE_MAP: Record<WebviewMsg["type"], true> = {
  ready: true, remotePreferences: true, send: true, newSession: true, cancel: true, pickModel: true,
  setMode: true, removeChip: true, toggleChip: true, openFile: true, showInFolder: true, openUrl: true,
  openText: true, openDiff: true, exportExpr: true, setEffort: true, openGlobalConfig: true,
  addProjectFolder: true, removeProjectFolder: true,
  openProjectConfig: true, listMcpServers: true, setMcpServerEnabled: true, showLogs: true, toggleDevTools: true, openSettings: true, openSettingsSurface: true, closeSettingsSurface: true, moveView: true,
  setShowThinking: true, setAppPurpose: true, setExpandCommandOutputs: true, setSteerByDefault: true,
  setSoundNotifications: true, setProcessingSound: true, setReadRepliesAloud: true, setSummarizeRepliesAloud: true, setVoiceSendPhrase: true, setVoiceKeyterms: true, setTelemetryEnabled: true, summarizeSpeech: true, requestImageFull: true, composerFocus: true,
  dropFile: true, permissionAnswer: true, exitPlanAnswer: true, questionAnswer: true,
  questionCancel: true, setModel: true, installCodex: true, cancelCodexInstall: true, runInstallCmd: true, runGrokLogin: true,
  logout: true, checkGrokUpdate: true, updateGrok: true, recheckConnection: true, refreshProviders: true, retryProviderSession: true,
  listSessions: true, listRepoSessions: true, selectRepo: true, toggleRepoPin: true, toggleSessionPin: true,
  setRepoArchived: true, setRepoColor: true,
  resumeSession: true, renameSession: true, deleteSession: true,
  clearAllSessions: true, pickFile: true, mentionQuery: true, addMentionFile: true,
  listProjectDir: true, readProjectFile: true, writeProjectFile: true,
  pasteImage: true, uploadFile: true, voiceStart: true,
  voiceStop: true, remoteVoiceStart: true, remoteVoiceChunk: true,
  remoteVoiceStop: true, queueSend: true, dequeueSend: true, clearQueuedSends: true,
  steerSend: true, forkSession: true,
  newWorktreeSession: true, applyWorktree: true, removeWorktree: true,
  rewindSession: true, editLastMessage: true, uiConfirmAnswer: true, workflowControl: true,
  remoteSignIn: true, remoteSignOut: true, unlinkRemoteDevice: true, openRemotePortal: true,
  openUpdateRelease: true, restartToUpdate: true,
};

export const HOST_MESSAGE_TYPES: readonly HostMsg["type"][] = Object.keys(HOST_MESSAGE_TYPE_MAP) as HostMsg["type"][];
export const WEBVIEW_MESSAGE_TYPES: readonly WebviewMsg["type"][] = Object.keys(WEBVIEW_MESSAGE_TYPE_MAP) as WebviewMsg["type"][];
