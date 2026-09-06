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
import type { ConnectorView } from "./mcp-connectors";
import type { RoutineDraft, RoutineModelOption, RoutineProjectOption, RoutineView } from "./routines";

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
  /**
   * Host-normalized MCP argument text (`prepareMcpToolCall`). Always stated
   * on recognized MCP rows: a string shows IN (`{}` is a no-argument call);
   * `null` means pending (do not render an empty IN). Absent on non-MCP
   * rows and older hosts — the client must not invent IN from that absence.
   */
  detailInput?: string | null;
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
  // Queued follow-ups carry their attachments. OPT-IN: absent/false = the
  // webview must not post `queueSend.chips` (a v2.0.4 host would ignore them
  // and silently drop the files). Field presence, not a version check.
  queueSendChips: true,
  // Read-only project file browse for AFK Pilot (phone/browser). Field presence
  // is the gate — never a version check. Local VS Code / desktop webviews
  // receive the flag but must not draw a second explorer; only IS_REMOTE clients
  // mount the in-page browser. Older hosts omit the field → nothing advertised.
  browseProjectFiles: true,
  // Edit+save existing project files from a remote. Separate from browse so a
  // host can offer list/read without a write path. OPT-IN field presence.
  editProjectFiles: true,
  // Whether this host can run an agent's headless sign-in for a remote and
  // report back the URL and code.
  //
  // OPT-IN, and load-bearing rather than tidy. The relay serves the web client,
  // so the client is always as new as the deploy while the extension is
  // whatever the user installed. Every host built before this shipped
  // classifies `runGrokLogin` as `host-local` and DROPS it — no error, no
  // reply, nothing. A client that offered Connect unconditionally would give
  // every 3.18.0 user a button that does nothing at all, which is worse than
  // the dead end it replaced, because a dead end at least tells you where to
  // go. Field presence, never a version check.
  remoteAgentSignIn: true,
  // Same shape, for GitHub in the clone form. Older hosts classify
  // `setupGithubCli` as `host-local` and drop it silently, so the Sign in
  // button must not be offered as a working control until this is present.
  remoteGithubSignIn: true,
  // And again for the two GitHub affordances added after it: pasting a token,
  // and cancelling with `provider: "github"`. `remoteGithubSignIn` cannot stand
  // in for either — it promises only the device-code flow, and every host that
  // advertises it but predates these two would take a pasted credential across
  // the relay and drop it in silence, while a cancel would be read as `grok`
  // (the old handler maps any unrecognised provider to it) and either do
  // nothing or cancel somebody's Grok sign-in instead. One flag covers both
  // because they shipped together and always will.
  remoteGithubToken: true,
  // Same shape again, for Rewind and Edit on user bubbles. Every host built
  // before 4.1.0 classifies `rewindSession` / `editLastMessage` /
  // `uiConfirmAnswer` as host-local and drops them, so a browser client — which
  // is always as new as the relay deploy — would show two controls that do
  // nothing at all for every user who has not updated yet. That window is not
  // hypothetical: the relay ships first, by release-order rule.
  remoteRewind: true,
} as const;

/** Device-code GitHub sign-in carried on `projectSetup`. Additive. */
export type ProjectSetupGithub = {
  status: "starting" | "waiting" | "done" | "failed";
  url?: string;
  code?: string;
  message?: string;
};

/**
 * GitHub connection snapshot. Field presence is the capability: an older host
 * never sends `githubState`, and the Settings row / clone picker stay hidden
 * rather than offering controls that host would drop.
 *
 * Never carries a token. `envTokenInForce` is whether this process has
 * `GH_TOKEN` or `GITHUB_TOKEN` set — not a gh credential-source string,
 * which is not portably readable.
 */
export type GithubState = {
  connected: boolean;
  login?: string;
  envTokenInForce?: boolean;
  error?: boolean;
  cliPresent?: boolean;
  message?: string;
  /** Live device-code card, when sign-in was started from Settings. */
  loginFlow?: ProjectSetupGithub;
};

export type GithubRepoView = {
  nameWithOwner: string;
  isPrivate: boolean;
  updatedAt: string;
};

/** Machine-readable `error.code` for a send abandoned after its userMessage echo. */
export const INTERRUPTED_SEND_CODE = "interrupted-send" as const;

/**
 * Machine-readable `error.code` when a remote tab lost a conversation to an
 * explicit claim from another tab, or when a non-claim resume found that
 * conversation already held. Additive: older clients ignore `code` and still
 * see `resumeFailed`.
 */
export const SESSION_SUPERSEDED_CODE = "session-superseded" as const;

export type HostErrorCode =
  | typeof INTERRUPTED_SEND_CODE
  | typeof SESSION_SUPERSEDED_CODE;

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
   * Whether this host can run an agent's headless sign-in on a remote's behalf.
   * OPT-IN: absent/false = the remote empty state falls back to "connect it at
   * your computer" instead of offering a control an older host would silently
   * drop. See HOST_CAPABILITIES for why silence is the failure mode.
   */
  remoteAgentSignIn?: boolean;
  /**
   * Whether this host can run `gh auth login` headlessly for a remote and
   * report the URL and code in the clone form. OPT-IN: absent/false = the
   * remote clone form keeps the honest dead-end rather than posting
   * `setupGithubCli` at a host that would drop it.
   */
  remoteGithubSignIn?: boolean;
  /**
   * Whether this host accepts a pasted GitHub token (`githubLoginWithToken`)
   * and understands `cancelDeviceLogin` with `provider: "github"`. OPT-IN:
   * absent/false = the remote hides the token path entirely and does not send
   * the GitHub cancel, because an older host drops the first in silence and
   * misreads the second as `grok`.
   */
  remoteGithubToken?: boolean;
  /**
   * Whether this host accepts Rewind and Edit from a remote. OPT-IN:
   * absent/false = the browser hides both controls rather than offering
   * buttons an older host drops in silence. See HOST_CAPABILITIES.
   */
  remoteRewind?: boolean;
  /**
   * Whether a remote may sign an agent OUT on this host.
   *
   * OPT-IN, and set only where the host IS a cloud environment. `logout` is
   * host-local everywhere else because it revokes a credential every surface on
   * that machine shares, and a phone must not be able to do that to somebody's
   * desk. A cloud environment has no other surface — the remote is the only way
   * in — so a credential you could grant and never revoke would be the worse
   * answer. Field presence, never a version check: a host that does not send it
   * keeps the read-only row.
   */
  remoteAgentSignOut?: boolean;
  /**
   * Settings → Connectors. OPT-IN: absent/false = hide the nav row and keep
   * the page unreachable. Desktop and VS Code set true; remotes inherit the
   * desk machine's capabilities. The webview still keys on this field so an
   * older host that never sent it keeps the page hidden.
   */
  mcpSettings?: boolean;
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
  /** May this surface take a project back OUT of the list?
   *  Separate from addProjectFolder on purpose: that one answers "is the
   *  native picker here", which is false on every remote, and Hide rode on it
   *  until create/clone made it true on remotes and produced a control that
   *  rendered, posted, and was dropped in silence. */
  removeProjectFolder?: boolean;
  /**
   * Add project can also MAKE one: a typed name becomes a folder in the host's
   * project root. OPT-IN — absent/false means the menu offers only the folder
   * picker, which is what every host before this shipped.
   */
  createProject?: boolean;
  /**
   * …and clone one: a repository URL becomes a checkout in the same root.
   * Independent of {@link createProject} so a host can offer one without the
   * other. OPT-IN; absent/false hides the entry entirely.
   */
  cloneProject?: boolean;
  /**
   * `queueSend` / `queuedSends` carry per-item attachments. OPT-IN: absent/false
   * = the webview posts text-only `queueSend` (and refuses to queue when the
   * composer holds a chip — everything or nothing). Older hosts omit the field
   * and would ignore extra `chips` / `queued` keys.
   */
  queueSendChips?: boolean;
};

/** One host-owned queued follow-up. `chips` omitted means none. */
export type QueuedSend = {
  text: string;
  chips?: FileChip[];
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
      /**
       * Settings → General "Thumbs feedback to SpaceXAI" (`grok.thumbsFeedback`).
       * Default off. Absent on older hosts — the webview must not invent thumbs
       * from this field; `feedbackAvailability` remains the affordance gate.
       */
      thumbsFeedback?: boolean;
      capabilities: HostUiCapabilities }
  /** Live retraction of `capabilities.moveViewHint`, sent the moment the user
   *  opens the host's move-view picker. `initialState` is not re-sent on a
   *  session swap, so without this the webview keeps a stale true and rebuilds
   *  the hint the user has already acted on. */
  | { type: "moveViewHint"; value: boolean }
  /**
   * Facts the empty-state tip pool needs and the client cannot observe itself,
   * plus the tips the user is done with.
   *
   * Everything else the pool reads — connected agents, app purpose, read-aloud,
   * voice, whether this machine is linked — already reaches the chat client on
   * its own. Routines and connectors do NOT: only the settings surface asks for
   * those, so a chat client that has never opened Settings would otherwise
   * advertise routines to someone running twenty of them. Counts, never
   * contents: the tip only needs to know whether the number is zero.
   *
   * Additive. An older host sends no frame at all, and the client suppresses
   * the two count-dependent tips rather than reading an absent count as zero.
   */
  | {
      type: "welcomeTips";
      routineCount: number;
      connectorCount: number;
      dismissed: string[];
      /**
       * Tips that have already had their turn today, in the HOST's timezone.
       * Additive: an older host omits it and the pool behaves as it did before
       * the once-a-day rule existed.
       */
      shownToday?: string[];
    }
  /**
   * State of the Add project form: where new projects go, and how the last
   * attempt went.
   *
   * One frame for both ways in (a typed name, a cloned URL) because they are
   * the same form with a different field, and splitting them would be two
   * registries to keep in step for no gain.
   *
   * `root` is the DISPLAY form (`~/Grok Build`), never a home path — the client
   * only needs it to show where the folder will land, and a remote has no
   * business learning the desk's home directory. Nothing here carries the
   * created path either: the repo catalog delivers that, already filtered to
   * what the receiving client may reach.
   */
  | {
      type: "projectSetup";
      root: string;
      /** In flight — the form disables and says what it is doing. */
      busy?: "new" | "clone";
      /** Why the last attempt failed. Absent means nothing has gone wrong. */
      error?: string;
      /**
       * A next step we can take FOR them rather than describe. Only ever set
       * for github.com, because `gh auth login` cannot help a GitLab failure.
       */
      fix?: "install-gh" | "auth-gh";
      /** The command `install-gh` would run, so the copy can name it. */
      fixCommand?: string;
      /** A project was actually made — the form closes on this, not on silence. */
      done?: boolean;
      /**
       * Headless GitHub CLI sign-in, shown only inside the clone form.
       * Additive: an older client ignores it and renders the form as before.
       */
      github?: ProjectSetupGithub;
      /**
       * The derived folder name was already taken. Additive: the form then
       * asks for a different name rather than failing the clone as a dead end.
       */
      collision?: string;
    }
  /**
   * GitHub connection for Settings and the clone picker. Additive: an older
   * client ignores it. Never carries a token.
   */
  | { type: "githubState"; github: GithubState }
  /**
   * One page of repositories for the clone combobox. Fetched on form open,
   * filtered on the client — a keystroke must not cross the relay.
   */
  | { type: "githubRepos"; repos: GithubRepoView[]; truncated?: boolean; error?: string }
  /** Connected agents plus host-observed, view-only version facts. Version
   * fields are additive so an older host/client keeps the connection UI.
   * `needsLogin` is the account that is still configured but answered an
   * auth-shaped failure: every affordance that would otherwise imply it works
   * (a selectable model row, a silently empty history) becomes the same sign-in
   * action the connect flow uses.
   * `checking` is a re-observation in flight (Settings → Providers Refresh). It
   * is the ONLY source of that spinner: a client must never latch it locally,
   * or an older host that ignores `refreshProviders` would spin forever. */
  | { type: "providerState"; providers: { id: "grok" | "codex" | "claude" | "gemini"; connected: boolean; needsLogin?: boolean; cliVersion?: string; adapterVersion?: string; latestCliVersion?: string; updateAvailable?: boolean }[]; checking?: boolean }
  /** Grok's grok.com + user-level MCP inventory (`_x.ai/mcp/list`; project-file
   *  servers omitted). The desk keeps launch recipes and `configFile`; remotes
   *  receive `projectMcpServerForRemote` (page fields only — no `tag`).
   *  Config-file editing stays desk-only. */
  | { type: "mcpServers"; servers: McpServerView[]; loading?: boolean; error?: string; warning: string }
  /** Machine-global, secret-free inventory. Presence of remoteConnect enables
   *  remote key writes and manual OAuth; older hosts omit it. */
  | { type: "mcpConnectors"; connectors: ConnectorView[]; remoteConnect?: true }
  /** Targeted to the requesting client only; never part of a broadcast/snapshot. */
  | { type: "mcpConnectorAuthorization"; id: string; attemptId: string; status: "waiting" | "submitted" | "finished"; url?: string; error?: string }
  /**
   * The Routines page, whole. Carries its own pickers rather than leaning on
   * the chat state, because the VS Code settings TAB loads settings.js and
   * nothing else — and because `projects` is then filtered by the same
   * authorization pass that filters `entries`, so a remote cannot be offered a
   * project it may not reach.
   *
   * `error` is the last save/delete refusal, cleared by the next successful
   * write. Folded in here rather than given its own type, matching `mcpServers`.
   */
  | {
      type: "routines";
      entries: RoutineView[];
      projects: RoutineProjectOption[];
      models: RoutineModelOption[];
      error?: string;
      errorId?: string;
    }
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
  | { type: "initialized"; info: { cliPath: string; cwd: string; version: string | null; provider?: "grok" | "codex" | "claude" | "gemini"; init: { protocolVersion?: unknown } } }
  | { type: "cliUpdating" }
  // `worktree` gates the gear's Apply/Remove worktree items to worktree sessions.
  | { type: "session"; sessionId: string; models: ModelInfo[]; currentModelId: string | undefined; worktree?: boolean; provider?: "grok" | "codex" | "claude" | "gemini" }
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
  /** Live `grok.thumbsFeedback` so the settings surface stays in sync. */
  | { type: "thumbsFeedback"; value: boolean }
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
      /** The JSON pretty-printer actually CHANGED the text, so line numbers
       *  here do not describe the file on disk. `pretty` only says it ran. */
      reformatted?: boolean;
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
  /** Answer to {@link WebviewMsg} `revertToolEdit`. `reason` is a short,
   *  user-facing explanation when `ok` is false (conflict, unreadable file,
   *  region no longer found) — never a raw error message. */
  | { type: "toolEditReverted"; toolCallId: string; path: string; ok: boolean; reason?: string }
  | { type: "planNotice"; text: string }
  | { type: "autoCompactNotice"; text: string }
  | { type: "planBlocked"; kind: string; target: string }
  | { type: "promptComplete"; meta: PromptResultMeta }
  // Context occupancy for the donut. `used` is optional so an adapter can
  // deliver `usage_update.size` (the real window) before any occupancy exists.
  // The structured fields are only populated by Grok's `_x.ai/session/info`.
  | {
      type: "contextUsage";
      used?: number;
      window?: number;
      categories?: { label: string; tokens: number; detail?: string }[];
      systemPromptTokens?: number;
      toolDefinitionsTokens?: number;
      toolDefinitionsCount?: number;
      messageTokens?: number;
      freeTokens?: number;
      autoCompactThresholdPercent?: number;
    }
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
  // `device` is the headless sign-in, and it is additive on purpose: a remote
  // gets the same `onboarding` panel it always got, plus a URL and a code when
  // the host is running a device-code flow for it. A client that predates the
  // field ignores it and shows the panel exactly as before, which is the right
  // fallback — it still says which agent needs connecting.
  //
  // Only the REMOTE path ever carries it. At a desk the CLI opens the browser
  // itself and a terminal is the better affordance, so nothing changes there.
  | {
      type: "onboarding";
      state: "connect-agent" | "missing-cli" | "auth-required" | "missing-codex" | "codex-login" | "missing-claude" | "claude-login" | "missing-gemini" | "gemini-login" | "provider-connected" | "no-project";
      platform?: string;
      reason?: string;
      provider?: "grok" | "codex" | "claude" | "gemini";
      launched?: boolean;
      device?: {
        /** starting: spawned, nothing printed yet. waiting: URL and code are on
         *  screen and the CLI is polling (or, with needsCode, waiting for a
         *  paste). done/failed: terminal. unavailable: this provider has no
         *  flow that works without a terminal. */
        status: "starting" | "waiting" | "verifying" | "done" | "failed" | "unavailable";
        url?: string;
        code?: string;
        /** Paste-code flow: the person must type a code into the card. Set from
         *  the plan, not inferred from a missing printed code. Additive. */
        needsCode?: boolean;
        /** The paste was written to the CLI; the card can stop offering input. */
        submitted?: boolean;
        /** Said to the person, not logged — a failure or an explanation. */
        message?: string;
        /**
         * Shown BEFORE the sign-in starts, when it is likely to fail for a
         * reason the person can fix in seconds. Codex device-code login is off
         * by default on every account; telling somebody that after a wait and a
         * failure is telling them too late.
         *
         * Cloud environments only — at a desk the browser flow works and this
         * setting never comes up.
         */
        preflight?: { title?: string; reason: string; steps: string[]; url?: string; continueLabel?: string };
        /** Said BESIDE the code: the vendor page carries a phishing warning and
         *  the reader needs to know it is expected before they meet it. */
        note?: string;
      };
    }
  // resumeFailed is additive: a remote resume refusal names the requested id so
  // the browser outbox can fail closed. Older clients ignore the extra field.
  // code is additive too — a harness must not match user-facing `text`.
  // "interrupted-send" is a send abandoned after its userMessage echo.
  // "session-superseded" is a tab that lost (or failed to restore) a
  // conversation another tab now holds — see resumeSession.claim.
  | { type: "error"; text: string; resumeFailed?: { id: string }; code?: HostErrorCode }
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
  // A finished shell command's full text + captured output (#41). Live grok
  // snapshots at terminal/release; session/load hydrates the same message from
  // the replayed tool_call (`commandOutputForToolCall`). This host always
  // states `cancelled` (true = live `commandDone` with no exit; false = not a
  // kill, including hydrated / Claude "exit not reported"). The field stays
  // optional on the wire because older hosts omit it; the client treats
  // absence as that older rule (`exitCode == null` → [Cancelled]), which was
  // correct then — those hosts never emitted replay-hydrated commandOutput.
  // `toolCallId` is always stated on MCP commandOutput (the ACP id the
  // webview joins IN to OUT by). Shell output omits it — absence means join
  // by `command` (this host's shell path, or an older host).
  // `agentSawCut` is always stated by this host. `true` is a cut the agent
  // already saw (terminal byte cap / CLI `truncated` on a replayed execute).
  // `false` is this host's 100K display cap on an MCP result the provider
  // returned in full. Older hosts omit the field; the client must not
  // attribute that cut either way (do not claim the agent saw it, and do
  // not claim this is display-only).
  | { type: "commandOutput"; command: string; output: string; exitCode: number | null; truncated: boolean; cancelled?: boolean; toolCallId?: string; agentSawCut?: boolean }
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
  /** Open the in-webview find bar (#99). Command Palette + Ctrl/Cmd+F fallback
   *  when the workbench swallows the keystroke inside a WebviewView. Ephemeral
   *  (`post`, never buffered). Host-local — remotes open find from their own ⋯. */
  | { type: "findInSession" }
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
  /** A known conversation was removed. Drop it from every catalog view without
   *  changing the client's active conversation or requesting a fresh list. */
  | { type: "sessionRemoved"; id: string; cwd: string }
  // A preview page for ONE repo, answering `listRepoSessions`. Deliberately a
  // separate frame from `sessions`: that one is the focused history list and
  // owns paging/search/auto-open state, so a sibling repo's rows arriving on it
  // would clobber the list the user is actually reading. `cwd` echoes the scope
  // the host resolved, which is also the capability signal — a client that
  // never sees this frame keeps its single-repo fallback.
  | {
      type: "repoSessions";
      cwd: string;
      entries: SessionListEntry[];
      dots: Record<string, Dot>;
      total: number;
      /** Additive refusal detail. Older clients ignore it and render the empty page. */
      error?: "project-unavailable" | "sessions-unavailable";
    }
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
       * The other two ways in, on the same channel and for the same reason.
       * Optional and additive: a rail that never sees them offers the picker
       * alone, which is what it did before there was anything else.
       */
      canCreateProject?: boolean;
      canCloneProject?: boolean;
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
  // `items` stays string[] so an older webview still renders text. `queued` is
  // additive: same contributions plus per-item chips. A client that never sees
  // it keeps today's text-only block.
  | { type: "queuedSends"; items: string[]; queued?: QueuedSend[] }
  // A remote queued prompt is ready to run. The browser echoes this as an
  // ordinary send carrying the same host-issued id, so relay quota/rate metering
  // applies at dequeue time and replayed/outbox copies are recognisably one send.
  | { type: "submitQueuedSend"; id: string; text: string }
  // Steer (#52) is unavailable on this CLI (`_x.ai/interject` → -32601). Latches
  // the button off for the session; the queue stays as the fallback.
  | { type: "steerUnavailable" }
  /**
   * Grok-only thumbs (#114). Off until the host has a positive signal
   * (`session/new` `_meta.feedbackEnabled` or an advertised `feedback` command)
   * and not latched off by `-32601` / "Feedback is disabled." Older hosts omit
   * the frame — the webview must not invent buttons.
   */
  | { type: "feedbackAvailability"; available: boolean }
  /**
   * Host-confirmed rating for the live-process turn that just finished.
   * `0` clears. Also restores the thumbs affordance after a focus-swap
   * (the only turn that can be rated). Nothing is read back from the agent.
   */
  | { type: "turnFeedbackAck"; rating: -1 | 0 | 1 }
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
  /**
   * Revert one completed edit back to its pre-edit text (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md
   * § 5). The webview sends the diff block it already rendered — `oldText`/
   * `newText`/`sites`/`replaceAll` — rather than a stored id, so the host
   * needs no session-keyed snapshot store: it reconstructs the pre-edit whole
   * file by running the same `expandDiffToWholeFile` machinery the "open
   * diff →" view already uses, against the file's CURRENT (post-edit)
   * content, and writes that back (or deletes the file for a create).
   */
  | {
      type: "revertToolEdit";
      toolCallId: string;
      path: string;
      oldText: string;
      newText: string;
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
  /** Open the Routines page — the host answers with a `routines` frame. */
  | { type: "listRoutines" }
  /** Create when `id` is absent, replace when it is present. The host
   *  validates: a draft that cannot run is refused rather than stored. */
  | { type: "saveRoutine"; id?: string; draft: RoutineDraft }
  | { type: "deleteRoutine"; id: string }
  | { type: "setRoutinePaused"; id: string; paused: boolean }
  /** Fire once, now. Deliberately takes no window key — a manual run must not
   *  consume the scheduled one. */
  | { type: "runRoutineNow"; id: string }
  /** Key is write-only. Remote OAuth returns a targeted sign-in link. */
  | { type: "connectMcpConnector"; id: string; key?: string; readOnly?: boolean }
  | { type: "completeMcpConnectorOAuth"; id: string; attemptId: string; redirectUrl: string }
  /** Drop the id from our list and any HostSecrets key. Does not revoke OAuth,
   * clear ~/.mcp-auth, or remove tools from already running sessions. */
  | { type: "disconnectMcpConnector"; id: string }
  | { type: "showLogs" }
  /** Unpackaged desktop only — toggle Chromium DevTools (gear / F12). */
  | { type: "toggleDevTools" }
  /** Open the host settings UI (VS Code: workbench settings focused on grok). */
  | { type: "openSettings"; section?: string }
  /** Open the shared Grok settings surface as a VS Code editor tab. */
  | { type: "openSettingsSurface"; category?: string }
  /** Close the Grok settings editor tab (Escape / Close on that page). */
  | { type: "closeSettingsSurface" }
  /**
   * Retire one empty-state tip, for good, on this machine.
   *
   * Sent when the reader either acts on a tip or dismisses it — both mean the
   * same thing, which is why there is one message and not two. Most tips retire
   * on their own when the thing they advertise gets set up; this covers the ones
   * that never would (Plan mode, `@` mentions) and the reader who has decided
   * twice that they are not interested.
   */
  | { type: "dismissWelcomeTip"; id: string }
  /**
   * One tip appeared. Recorded against the local day so it does not come round
   * again before tomorrow — the pool is small, and a line seen three times in
   * an afternoon has stopped being advice.
   *
   * Sent at most once per tip per day by the client, which keeps its own copy
   * of the list; the host writes only when the day actually changes.
   */
  | { type: "welcomeTipShown"; id: string }
  /**
   * Make a project folder called `name` inside the host's one project root.
   *
   * A NAME, never a path — which is the entire reason this can be reachable
   * from a phone when `addProjectFolder` never could. The client says what to
   * call it; the host decides where it goes and refuses anything that resolves
   * outside the root. See src/project-create.ts.
   */
  | { type: "createProject"; name: string }
  /**
   * Clone `url` into the same root, under the folder name the URL implies.
   *
   * Same containment: a URL is not a destination. Git's own credential helper
   * does the authenticating — nothing here mints, stores or forwards a token.
   */
  | { type: "cloneProject"; url: string; name?: string }
  /**
   * Install or sign in to the GitHub CLI.
   *
   * Offered after a clone failed in a way `gh` would fix, and from the
   * Settings GitHub row / the clone picker's connect row. A local webview
   * still opens a terminal. A remote `auth` runs the headless device-code flow
   * and reports the URL and code on `projectSetup.github` and `githubState`.
   */
  | { type: "setupGithubCli"; action: "install" | "auth"; surface?: "settings" }
  /**
   * List this account's repositories for the clone combobox. Host runs
   * `gh repo list --limit 200` once; the client filters. A remote may send
   * this: the picker is how a phone clones, and it reveals nothing a clone
   * of those URLs would not already reach.
   */
  | { type: "listGithubRepos" }
  /**
   * Sign out of GitHub on this machine. Same class as agent `logout`: desk
   * remotes must not revoke a credential every surface shares; a cloud
   * machine has no other surface, so CLOUD_DISPOSITION admits it there.
   */
  | { type: "githubSignOut" }
  /**
   * Store a pasted GitHub token via `gh auth login --with-token`. The token
   * is a secret: the host must never echo it, log it, or put it in state the
   * webview can read. A remote may send this — a cloud machine is exactly
   * where a fine-grained token is the narrower credential to be holding.
   */
  | { type: "githubLoginWithToken"; token: string }
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
  /** Persist `grok.thumbsFeedback`. Host-owned; remotes honour the desk value. */
  | { type: "setThumbsFeedback"; value: boolean }
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
  | { type: "setModel"; modelId: string; provider?: "grok" | "codex" | "claude" | "gemini" }
  | { type: "installCodex" }
  | { type: "cancelCodexInstall" }
  | { type: "runInstallCmd" }
  | { type: "runGrokLogin"; provider?: "grok" | "codex" | "claude" | "gemini" }
  // Stop a headless sign-in the host is running. Only reachable while one is in
  // flight, and it kills a child process this same user started moments ago.
  // `github` is the clone-form / Settings `gh auth login --web` child, not an
  // agent; an older host that does not know the value no-ops rather than
  // cancelling Grok.
  | { type: "cancelDeviceLogin"; provider?: "grok" | "codex" | "claude" | "gemini" | "github" }
  // Paste-code half of a headless sign-in: the person typed the vendor's code
  // into the card and we write it to the CLI's stdin. Additive — an older host
  // simply has no handler, and an older client never posts it.
  | { type: "submitDeviceLoginCode"; provider?: "grok" | "codex" | "claude" | "gemini"; code: string }
  | { type: "logout"; provider?: "grok" | "codex" | "claude" | "gemini" }
  | { type: "checkGrokUpdate" }
  | { type: "updateGrok" }
  | { type: "recheckConnection"; provider?: "grok" | "codex" | "claude" | "gemini" }
  /** Re-observe every account without asserting anything about it. Unlike
   *  `recheckConnection` this never marks a provider connected — it re-runs the
   *  CLI locators and re-probes the credentials of accounts already connected,
   *  so Settings → Providers can be made to tell the truth on demand. */
  | { type: "refreshProviders" }
  | { type: "retryProviderSession"; provider?: "grok" | "codex" | "claude" | "gemini" }
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
  //
  // `claim` is additive: only an explicit user action (rail row, history pick,
  // pinned row, Continue here) sets it. A reconnect restore MUST omit it —
  // without that distinction a thawing background tab steals the conversation
  // back from the tab in the user's hand. Absent/false = today's refusal when
  // another tab already holds the session.
  | { type: "resumeSession"; id: string; cwd?: string; claim?: boolean }
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
  // `chips` is additive (capabilities.queueSendChips). `text` stays required so
  // an image-only queue is `{ text: "", chips }` — a v2.0.4 host still accepts
  // the type and no-ops on empty text rather than dropping an unknown message.
  | { type: "queueSend"; text: string; chips?: FileChip[] }
  // Old webviews: `index: 0` is the pending block (every host entry). Chip-aware
  // clients use `clearQueuedSends` for that block; a live host therefore treats
  // this message as the pre-split meaning.
  | { type: "dequeueSend"; index: number }
  // `restore` is additive: Stop/Edit set true so queued chips return to the
  // composer. Absent/false discards them (Remove). Older hosts ignore the field
  // and only empty the queue.
  | { type: "clearQueuedSends"; restore?: boolean }
  // Steer (#52): inject the composed text (and, additively, attachments) into
  // the RUNNING turn instead of waiting. Host-owned like the queue — the
  // webview never sends the prompt itself, so a capability gap can re-queue
  // the whole item without losing it. `chips` is additive (same as queueSend).
  // `fromQueue` marks the pending-block button so the host snapshots
  // `queuedSends` before any await (a following `clearQueuedSends` can race).
  | { type: "steerSend"; text: string; chips?: FileChip[]; fromQueue?: boolean }
  /**
   * Rate the agent turn that just finished in this process. `rating` 0 clears.
   * No bubble index: the host does not reconstruct CLI `turn_number`.
   */
  | { type: "turnFeedback"; rating: -1 | 0 | 1 }
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
  /** Reply to `uiConfirmRequest`. Answerable by whichever client was shown the
   *  dialog, remote included, since 2026-09-01: the confirm moved in-chat in
   *  2.0.0, so `host-local` here did not buy a more careful check — it meant a
   *  remote could be shown a dialog it could never answer, leaving the rewind
   *  pending forever. See remote-policy.ts on rewindSession. */
  | { type: "uiConfirmAnswer"; id: string; ok: boolean }
  // Workflow card controls (P2-10): pause / resume / stop by display name.
  | { type: "workflowControl"; action: "pause" | "resume" | "stop"; displayName: string }
  /** Read-only Grok context snapshot for the open donut popover. */
  | { type: "refreshContextDetails" }
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
  initialState: true, moveViewHint: true, welcomeTips: true, projectSetup: true, githubState: true, githubRepos: true, providerState: true, mcpServers: true, mcpConnectors: true, mcpConnectorAuthorization: true, routines: true, codexInstallProgress: true, planModeAvailability: true, showThinking: true, appPurpose: true, fontScale: true, grokUpdateStatus: true, updateAvailable: true, updateReady: true, telemetryEnabled: true, thumbsFeedback: true,
  initialized: true, cliUpdating: true, session: true, sessionName: true, modelChanged: true,
  modeChanged: true, openModePopover: true, voiceState: true, voiceConfigured: true,
  voicePartial: true, voiceSubmit: true, voiceTranscript: true, voiceError: true,
  chips: true, commandsUpdate: true, mentionResults: true, projectDirListing: true, projectFileContent: true, projectFileWriteResult: true, userMessage: true, agentStart: true,
  thoughtChunk: true, messageChunk: true, media: true, userMessageChunk: true,
  historyReplay: true, historyBatch: true, permissionHistoryQueue: true, planHistoryQueue: true,
  toolCall: true, toolCallUpdate: true, permissionRequest: true, permissionOptions: true,
  permissionResolved: true, exitPlanRequest: true, planResolved: true, questionRequest: true, toolEditReverted: true,
  planNotice: true, autoCompactNotice: true, planBlocked: true, promptComplete: true, contextUsage: true, agentReset: true,
  agentError: true, agentEnd: true, exit: true, setBusy: true, summarizing: true,
  sessionContext: true, clearMessages: true, onboarding: true, error: true, hostNotice: true,
  xaiNotification: true, subagentUpdate: true, childStream: true, runProgress: true, commandOutput: true, expandCommandOutputs: true, steerByDefault: true,
  soundNotifications: true, processingSound: true, readRepliesAloud: true, summarizeRepliesAloud: true, speechSummary: true, imageFull: true, moveComposerCaret: true, remoteStatus: true,
  setAllToolDetails: true, focusInput: true, findInSession: true, restoreComposer: true, truncateMessages: true, uiConfirmRequest: true,
  sessions: true, sessionRemoved: true, repoSessions: true, pinnedSessions: true, repos: true, sessionDot: true, queuedSends: true, submitQueuedSend: true,
  steerUnavailable: true, feedbackAvailability: true, turnFeedbackAck: true, usage: true,
};

const WEBVIEW_MESSAGE_TYPE_MAP: Record<WebviewMsg["type"], true> = {
  ready: true, remotePreferences: true, send: true, newSession: true, cancel: true, pickModel: true,
  setMode: true, removeChip: true, toggleChip: true, openFile: true, showInFolder: true, openUrl: true,
  openText: true, openDiff: true, revertToolEdit: true, exportExpr: true, setEffort: true, openGlobalConfig: true,
  addProjectFolder: true, removeProjectFolder: true, createProject: true, cloneProject: true, setupGithubCli: true, listGithubRepos: true, githubSignOut: true, githubLoginWithToken: true,
  openProjectConfig: true, listMcpServers: true, connectMcpConnector: true, disconnectMcpConnector: true, completeMcpConnectorOAuth: true,
  listRoutines: true, saveRoutine: true, deleteRoutine: true, setRoutinePaused: true, runRoutineNow: true, showLogs: true, toggleDevTools: true, openSettings: true, openSettingsSurface: true, closeSettingsSurface: true, dismissWelcomeTip: true, welcomeTipShown: true, moveView: true,
  setShowThinking: true, setAppPurpose: true, setExpandCommandOutputs: true, setSteerByDefault: true,
  setSoundNotifications: true, setProcessingSound: true, setReadRepliesAloud: true, setSummarizeRepliesAloud: true, setVoiceSendPhrase: true, setVoiceKeyterms: true, setTelemetryEnabled: true, setThumbsFeedback: true, summarizeSpeech: true, requestImageFull: true, composerFocus: true,
  dropFile: true, permissionAnswer: true, exitPlanAnswer: true, questionAnswer: true,
  questionCancel: true, setModel: true, installCodex: true, cancelCodexInstall: true, runInstallCmd: true, runGrokLogin: true,
  cancelDeviceLogin: true, submitDeviceLoginCode: true,
  logout: true, checkGrokUpdate: true, updateGrok: true, recheckConnection: true, refreshProviders: true, retryProviderSession: true,
  listSessions: true, listRepoSessions: true, selectRepo: true, toggleRepoPin: true, toggleSessionPin: true,
  setRepoArchived: true, setRepoColor: true,
  resumeSession: true, renameSession: true, deleteSession: true,
  clearAllSessions: true, pickFile: true, mentionQuery: true, addMentionFile: true,
  listProjectDir: true, readProjectFile: true, writeProjectFile: true,
  pasteImage: true, uploadFile: true, voiceStart: true,
  voiceStop: true, remoteVoiceStart: true, remoteVoiceChunk: true,
  remoteVoiceStop: true, queueSend: true, dequeueSend: true, clearQueuedSends: true,
  steerSend: true, turnFeedback: true, forkSession: true,
  newWorktreeSession: true, applyWorktree: true, removeWorktree: true,
  rewindSession: true, editLastMessage: true, uiConfirmAnswer: true, workflowControl: true,
  refreshContextDetails: true,
  remoteSignIn: true, remoteSignOut: true, unlinkRemoteDevice: true, openRemotePortal: true,
  openUpdateRelease: true, restartToUpdate: true,
};

export const HOST_MESSAGE_TYPES: readonly HostMsg["type"][] = Object.keys(HOST_MESSAGE_TYPE_MAP) as HostMsg["type"][];
export const WEBVIEW_MESSAGE_TYPES: readonly WebviewMsg["type"][] = Object.keys(WEBVIEW_MESSAGE_TYPE_MAP) as WebviewMsg["type"][];
