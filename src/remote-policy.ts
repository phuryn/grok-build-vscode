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

import type { HostMsg, HostUiCapabilities, WebviewMsg } from "./protocol";
import { isImageChip, type FileChip } from "./chips";
import { isPrimerText } from "./grok-primer";
import { projectMcpServersMessageForRemote } from "./mcp";
import { countsAsUserBubble } from "./plan-restore";
import { historyEventCount } from "./rewind";
import { cwdIsAuthorized } from "./workspace-auth";

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
  // Rearranges the remote's own sidebar and touches nothing on disk beyond a
  // globalState note. Nothing here can reach the workspace.
  setRepoArchived: "full",
  // Host-persisted project colour (globalState / client-state file), same class
  // as archive/pin: rearranges the remote's rail and touches nothing on disk
  // beyond that note.
  setRepoColor: "full",
  // Writes host state (globalState), same as the repo pin — classified with it
  // rather than as a view op, even though nothing is destroyed.
  toggleSessionPin: "full",
  // Retires one empty-state tip machine-wide. Same class as the repo pin: it
  // writes a host note and reaches nothing else. Deliberately NOT host-local —
  // a phone is shown a filtered subset of the same tips, and a reader who can
  // see a tip must be able to be done with it.
  dismissWelcomeTip: "full",
  // Same class, and deliberately NOT host-local: a phone showing a tip is the
  // same person seeing that advice, so it should not come round on the desk an
  // hour later either.
  welcomeTipShown: "full",
  // Making a project is NOT addProjectFolder, and the difference is the
  // whole reason these two are reachable from a phone while that one is
  // not. `addProjectFolder` opens a native picker (nothing for a remote to
  // see) and accepts whatever path comes back. These accept a NAME and a
  // URL; the host derives the destination inside its own single root and
  // refuses anything that resolves outside it (src/project-create.ts). A
  // remote can say what, never where.
  createProject: "full",
  cloneProject: "full",
  // The follow-up when a clone failed on credentials. A remote `auth` runs
  // the same headless device-code flow as `runGrokLogin` and reports the
  // URL and code in the clone form — the person asking is the only one who
  // can see it. Install still opens a terminal (package managers ask for
  // elevation). Signing in is not bound to a conversation.
  setupGithubCli: "full",
  // One `gh repo list` for the clone combobox. Same reach as cloneProject:
  // the URLs it returns are the URLs a clone would fetch. Not a keystroke
  // path — the client fetches once and filters locally.
  listGithubRepos: "full",
  // Same class as agent logout: a phone must not revoke a credential every
  // surface on a desk shares. CLOUD_DISPOSITION admits it on a cloud machine,
  // where the remote is the only surface and a handed-on box otherwise has
  // no remedy.
  githubSignOut: "host-local",
  // A pasted token is a secret crossing the relay, and that is the point of
  // the advanced option on a machine we host: a fine-grained token can be
  // scoped to one repository. The host stores nothing; gh does. Never echo.
  //
  // `full`, and deliberately NOT cloud-gated — a phone driving a desk may paste
  // one too. This was briefly host-local, on a review finding that a compromised
  // relay could inject a token and make a desk laptop act as somebody else. The
  // mechanism is real; the reasoning was not, because it never asked what the
  // attacker already had. A remote at this tier can `send` a prompt AND answer
  // `permissionAnswer`, so it can already run commands here with the
  // credentials sitting on the machine — including pushing this repository
  // somewhere using the user's OWN gh login. Injecting a foreign token grants
  // strictly less than that and mostly just breaks their pushes, which they
  // notice. Gating it bought nothing and cost the fine-grained token — the
  // narrowest credential we can offer — on the surface AFK Pilot is named for.
  githubLoginWithToken: "full",
  resumeSession: "view",
  renameSession: "view",
  // read-only workspace file-name lookup (the composer's @ popover)
  mentionQuery: "view",
  // Project file browse (list dir + open one file). The fence is repoScopeFor
  // + resolveTreePath — not a second root concept. Writes are a separate type
  // (writeProjectFile) at the mutation tier below.
  listProjectDir: "view",
  readProjectFile: "view",
  // input/turn control (propose+)
  send: "propose",
  newSession: "propose",
  cancel: "propose",
  setMode: "propose",
  setEffort: "propose",
  setModel: "propose",
  installCodex: "host-local",
  cancelCodexInstall: "host-local",
  questionAnswer: "propose",
  questionCancel: "propose",
  queueSend: "propose",
  dequeueSend: "propose",
  clearQueuedSends: "propose",
  steerSend: "propose",
  // A thumbs rating is input about the conversation the remote is already
  // driving — same class as steerSend, not a desk-local picker or a destructive
  // approval. The host files it against the live process's current turn
  // (`client_type` is extension/desktop even when a phone clicked).
  turnFeedback: "propose",
  forkSession: "propose",
  // Worktree create/apply/remove: REVERTED to host-local 2026-08-07, hours
  // after being widened to "propose" the same day. The widening was safe in
  // itself — the authorization underneath (git-list, path containment) never
  // changed. What made it wrong is that the handlers did not act on the
  // session that asked: `applyWorktree`/`removeWorktree` ran against
  // `this.focused`, and `newWorktreeSession` against `workspaceRoot()`.
  //
  // The session-identity fix has landed for applyWorktree/removeWorktree:
  // the webview may send an optional `sessionId`, the host refuses a mismatch
  // against the dispatch-resolved session before any await, and the handlers
  // act on that session object (not a later re-lookup). newWorktreeSession
  // remains untargeted — it creates a NEW session; its open question is repo
  // targeting, not session identity. Widening these three back to "propose"
  // is a deliberate separate product decision. Until then the rail's ⋯ menu
  // still hides apply/remove on remote clients, so nothing offers a control
  // the host will drop.
  newWorktreeSession: "host-local",
  applyWorktree: "host-local",
  removeWorktree: "host-local",
  // Rewind and edit-and-resend were `host-local` until 2026-09-01, on the
  // grounds that rewind discards work already on disk and only the careful
  // local surface should be able to ask for it. Two things retired that
  // argument, and the owner made the call:
  //
  //   1. A remote can already tell the agent to rewrite or delete any file in
  //      the repo — that is the product. Refusing the rewind of edits it was
  //      allowed to request is a locked door beside an open one, not a
  //      safeguard.
  //   2. There is no longer a more careful surface to prefer. The confirmation
  //      moved in-chat in 2.0.0 (`confirmInChat` -> `uiConfirmRequest`), so the
  //      desk webview and the browser render the SAME dialog from the same
  //      frame. `host-local` bought a different asker, not a different check.
  //
  // The actor here is the account holder acting on their own machine, so this
  // is a scoping rule, not a security boundary (CLAUDE-ops § Name who is harmed
  // before you harden anything). `propose`, matching forkSession and send.
  rewindSession: "propose",
  // Edit-and-resend is a rewind underneath, so it moves with it.
  editLastMessage: "propose",
  // MUST move in the same commit as rewindSession. `confirmInChat` resolves
  // only when an answer comes back; a client that can be shown the dialog and
  // cannot answer it leaves the promise pending forever, the rewind silently
  // never happens, and the entry leaks in `pendingConfirms`.
  uiConfirmAnswer: "propose",
  // Workflow pause/resume/stop is a slash turn (same class as queueSend/steer).
  workflowControl: "propose",
  // Donut popover re-fetch — read-only meter, no turn / no mutation.
  refreshContextDetails: "view",
  pasteImage: "propose",
  // Host validates the extension/name/bytes before staging under globalStorage.
  uploadFile: "propose",
  // Workspace file mutation — same propose tier as upload/send, NOT view. A
  // read-only remote must not rewrite the desk tree. Existing files only
  // (create/delete/rename are deliberately out of scope).
  writeProjectFile: "propose",
  removeChip: "propose",
  toggleChip: "propose",
  // attaches a chip only after an exact host mention-catalog lookup plus
  // lexical + canonical workspace containment — same composer-state class
  // as removeChip/toggleChip
  addMentionFile: "propose",
  // Durable connection mutation is desk-only. Remote clients may only retry an
  // already-connected provider's session through retryProviderSession.
  recheckConnection: "host-local",
  // Observation only — but it still spawns the desk's CLIs to do it, which is
  // the same reason updateGrok/checkGrokUpdate sit here. A remote already sees
  // every refresh: `providerState` is mirrored, so the phone's Providers page
  // updates the moment the desk re-observes.
  refreshProviders: "host-local",
  retryProviderSession: "propose",
  // approvals + destructive + host-CLI mutations (full only)
  permissionAnswer: "full",
  exitPlanAnswer: "full",
  // Provider accounts belong to the desk. A remote may observe providerState,
  // but it must never clear credentials or open a login terminal on the host.
  logout: "host-local",
  deleteSession: "full",
  clearAllSessions: "full",
  // Host-local, because the handler it reaches is a NATIVE modal and a
  // terminal on the host's own screen. A remote may not see either, so
  // routing it was a promise the code cannot keep — the remote UI already
  // hides the action (found while documenting what works where, 2026-08-31).
  runInstallCmd: "host-local",
  // WAS host-local until 2026-08-26, and the reason it moved is worth being
  // precise about: the POLICY did not soften, the IMPLEMENTATION changed.
  //
  // The old comment said "it must never clear credentials or open a login
  // terminal on the host", and that was exactly right about what the handler
  // did — it spawned an interactive terminal on the desk, which a remote can
  // neither see nor type into, and which nobody should be able to open on
  // someone else's machine from a phone.
  //
  // The handler now branches on origin. A desk request still gets that
  // terminal, unchanged, because at a desk it is the better affordance: the CLI
  // opens the browser for you. A remote request instead runs the CLI's headless
  // device-code flow with pipes and renders the URL and code into the
  // transcript. No terminal is opened, nothing is typed on the host, and the
  // only thing the flow can do is ADD a credential the user obtains themselves
  // from the vendor, in their own browser, against their own account.
  //
  // `logout` stays host-local, and the asymmetry is deliberate rather than an
  // oversight: signing in adds an option, signing out takes one away from every
  // other surface at once.
  runGrokLogin: "full",
  // Stops a flow this same remote started. Refusing it would leave the only
  // party who can see the panel unable to close it.
  cancelDeviceLogin: "full",
  // The paste that finishes the same flow. Refusing it would leave the only
  // party who can see the card unable to finish.
  submitDeviceLoginCode: "full",
  // host-local: native pickers/editors/config/mic on the dev box
  // Replacing the CLI binary belongs here, not in "full" (2026-08-11). The
  // binaries live on the desk machine and only the desk can replace them, so a
  // phone offering it was offering something it has no business doing — and the
  // remote Version & about page is now purely informational for that reason.
  // The status still travels: `grokUpdateStatus` is mirrored, so a phone can
  // see the CLI is out of date while being unable to act on it.
  updateGrok: "host-local",
  checkGrokUpdate: "host-local",
  pickModel: "host-local",
  openFile: "host-local",
  showInFolder: "host-local",
  openUrl: "host-local",
  openText: "host-local",
  openDiff: "host-local",
  exportExpr: "host-local",
  // Opens a native directory picker on the machine running the host. A remote
  // could neither see nor answer that dialog, so it would hang a phone on a
  // control that never resolves.
  addProjectFolder: "host-local",
  // Same reasoning, and one more: closing a folder ends every conversation
  // in it and kills their agents. A remote must never be able to do that to
  // the machine it is borrowing.
  removeProjectFolder: "host-local",
  openGlobalConfig: "host-local",
  openProjectConfig: "host-local",
  // Read-only inventory query through the live Grok ACP session. Same class as
  // refreshContextDetails: no turn, no mutation, no desk-local picker.
  // Mirroring the last fetch is not enough if
  // the desk never opened Settings, so a remote may ask when it opens the page.
  listMcpServers: "view",
  // Reading the page is a view op. Everything that WRITES is "full": a routine
  // schedules unattended agent runs, which is the same class as the other host
  // state a remote may change (pins, archives), not turn control.
  //
  // A phone is exactly where
  // someone thinks "I should get a morning brief", and a remote can already
  // send arbitrary prompts — a routine adds persistence, not reach. Reach is
  // bounded separately, by `cwd` being checked against the authorized set at
  // the point of the write.
  listRoutines: "view",
  saveRoutine: "full",
  deleteRoutine: "full",
  setRoutinePaused: "full",
  runRoutineNow: "full",
  // Machine-wide configuration, like routines. Keys are write-only; remote
  // OAuth is completed manually against the host's own callback listener.
  connectMcpConnector: "full",
  disconnectMcpConnector: "full",
  showLogs: "host-local",
  toggleDevTools: "host-local",
  openSettings: "host-local",
  openSettingsSurface: "host-local",
  closeSettingsSurface: "host-local",
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
  // Phone dictation is first-class: the send phrase and dictionary are the
  // same prefs the remote STT path already consumes. They write host config
  // (like setAppPurpose), not a desk-only account or file action.
  setVoiceSendPhrase: "propose",
  setVoiceKeyterms: "propose",
  // Remote surface is read-only for telemetry; the desk owns the switch.
  setTelemetryEnabled: "host-local",
  // Same class as the other General host prefs: the desk owns the switch,
  // remotes receive the live value and honour it for thumbs.
  setThumbsFeedback: "host-local",
  // Machine-global disclosure preference in ~/.grok/client-state — the web
  // client inherits and may set it (host-owned store, not VS Code settings).
  setAppPurpose: "propose",
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
  // Desktop gear unlink — native confirm then drop THIS machine's device token.
  // A remote must never be able to unlink the desk it is driving.
  unlinkRemoteDevice: "host-local",
  openRemotePortal: "host-local",
  // Desktop update notice click-through — a phone cannot update the desk.
  openUpdateRelease: "host-local",
  restartToUpdate: "host-local",
};

/**
 * Session-bound remote messages. After a tab's active mapping is removed
 * (another tab claimed the conversation), these are refused until the tab
 * explicitly resumes, selects a repo, or starts a new session. `remoteSessionFor`
 * used to adopt the desk session or mint a blank one when there was no mapping,
 * so a stale Send from a frozen transcript could silently start or target
 * another conversation.
 *
 * Exhaustive on WebviewMsg so a new type cannot land unclassified.
 */
export const REMOTE_REQUIRES_BOUND_SESSION: Record<WebviewMsg["type"], boolean> = {
  ready: false,
  remotePreferences: false,
  listSessions: false,
  listRepoSessions: false,
  selectRepo: false,
  toggleRepoPin: false,
  setRepoArchived: false,
  setRepoColor: false,
  toggleSessionPin: false,
  dismissWelcomeTip: false,
  welcomeTipShown: false,
  createProject: false,
  cloneProject: false,
  setupGithubCli: false,
  listGithubRepos: false,
  githubSignOut: false,
  githubLoginWithToken: false,
  resumeSession: false,
  renameSession: false,
  mentionQuery: true,
  listProjectDir: false,
  readProjectFile: false,
  send: true,
  newSession: false,
  cancel: true,
  setMode: true,
  setEffort: true,
  setModel: true,
  installCodex: false,
  cancelCodexInstall: false,
  questionAnswer: true,
  questionCancel: true,
  queueSend: true,
  dequeueSend: true,
  clearQueuedSends: true,
  steerSend: true,
  turnFeedback: true,
  forkSession: true,
  newWorktreeSession: false,
  applyWorktree: true,
  removeWorktree: true,
  rewindSession: true,
  editLastMessage: true,
  uiConfirmAnswer: true,
  workflowControl: true,
  refreshContextDetails: true,
  pasteImage: true,
  uploadFile: true,
  writeProjectFile: false,
  removeChip: true,
  toggleChip: true,
  addMentionFile: true,
  recheckConnection: false,
  refreshProviders: false,
  retryProviderSession: true,
  permissionAnswer: true,
  exitPlanAnswer: true,
  logout: false,
  deleteSession: false,
  clearAllSessions: false,
  runInstallCmd: false,
  runGrokLogin: false,
  cancelDeviceLogin: false,
  submitDeviceLoginCode: false,
  updateGrok: false,
  checkGrokUpdate: false,
  pickModel: true,
  openFile: false,
  showInFolder: false,
  openUrl: false,
  openText: false,
  openDiff: false,
  exportExpr: false,
  addProjectFolder: false,
  removeProjectFolder: false,
  openGlobalConfig: false,
  openProjectConfig: false,
  listMcpServers: false,
  listRoutines: false,
  saveRoutine: false,
  deleteRoutine: false,
  setRoutinePaused: false,
  runRoutineNow: false,
  connectMcpConnector: false,
  disconnectMcpConnector: false,
  showLogs: false,
  toggleDevTools: false,
  openSettings: false,
  openSettingsSurface: false,
  closeSettingsSurface: false,
  moveView: false,
  dropFile: true,
  pickFile: true,
  voiceStart: true,
  voiceStop: true,
  // Remote voice owns its OWN admission check, per client rather than per
  // session, and refusing a chunk from a client with no live capture is the
  // thing it exists to do — visibly, with a `voiceError` the person can see.
  // Refusing these here instead would swap that visible rejection for a silent
  // one, which is how a phone ends up holding a dead microphone button with no
  // explanation. Voice is not session-bound in the first place.
  remoteVoiceStart: false,
  remoteVoiceChunk: false,
  remoteVoiceStop: false,
  setShowThinking: false,
  setExpandCommandOutputs: false,
  setSteerByDefault: false,
  setSoundNotifications: false,
  setProcessingSound: false,
  setReadRepliesAloud: false,
  setSummarizeRepliesAloud: false,
  setVoiceSendPhrase: false,
  setVoiceKeyterms: false,
  setTelemetryEnabled: false,
  setThumbsFeedback: false,
  setAppPurpose: false,
  summarizeSpeech: true,
  requestImageFull: true,
  composerFocus: false,
  remoteSignIn: false,
  remoteSignOut: false,
  unlinkRemoteDevice: false,
  openRemotePortal: false,
  openUpdateRelease: false,
  restartToUpdate: false,
};

export function remoteRequiresBoundSession(type: WebviewMsg["type"]): boolean {
  return REMOTE_REQUIRES_BOUND_SESSION[type];
}

const TIER_RANK: Record<RemoteTier, number> = { "read-only": 0, propose: 1, full: 2 };

/**
 * Dispositions that CHANGE when this host IS a cloud environment.
 *
 * `host-local` means "this acts on the LOCAL machine", and the protection it
 * buys is for the person sitting at that machine. A cloud environment has no
 * such person: the remote client is the only surface it has, and it belongs to
 * the account that rented it. So the argument for holding `logout` back does
 * not merely weaken there, it inverts — a box you can sign IN to and never out
 * of is a box with a credential you cannot revoke from the only place you can
 * reach it. cloud-environments.md called this one out before it was built.
 *
 * Named as an override table rather than folded into INBOUND_DISPOSITION so the
 * desk classification stays readable as the default, and so anything added here
 * has to be added deliberately. Everything not listed keeps its desk answer.
 */
const CLOUD_DISPOSITION: Partial<Record<WebviewMsg["type"], InboundDisposition>> = {
  logout: "full",
  githubSignOut: "full",

  // Re-observing the accounts is host-local on a desk because a phone should
  // not be able to spawn CLI probes on somebody's laptop. On a cloud machine
  // the remote is the ONLY user, and withholding it meant the promotion that
  // makes a sign-in stick never ran there at all: connect an agent, refresh,
  // and the page offered Connect again for an account that was signed in
  // (owner, 2026-08-31). Read-only observation, promoting only on evidence.
  refreshProviders: "full",
  // Preferences about the machine the person is looking at. Read-only on a
  // remote because a desk owner can set them at the desk; on a cloud machine
  // there is no desk, so read-only means never (owner, 2026-08-31).
  setTelemetryEnabled: "full",
  setThumbsFeedback: "full",
};

/** May this WebviewMsg type, arriving from a remote connection of `tier`, be
 *  routed into the host's onMessage? `control` and `host-local` are never
 *  routed regardless of tier — except where {@link CLOUD_DISPOSITION} says the
 *  answer differs on a host that IS a cloud environment. */
export function allowFromRemote(
  type: WebviewMsg["type"],
  tier: RemoteTier,
  opts: { isCloud?: boolean } = {},
): boolean {
  const d = (opts.isCloud ? CLOUD_DISPOSITION[type] : undefined) ?? INBOUND_DISPOSITION[type];
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
    case "setRepoArchived":
    case "setRepoColor":
    case "clearAllSessions":
    case "listRepoSessions":
    // File browse names a cwd. Without this case the default branch returns
    // true and a remote could claim an arbitrary path that never appeared in
    // the catalog — the exact trap the comment on this function exists for.
    case "listProjectDir":
    case "readProjectFile":
    // Write names a cwd too. Without this case the default branch returns true
    // and a remote could claim an arbitrary path — same trap as list/read.
    case "writeProjectFile":
      return isKnownCwd(msg.cwd);
    case "resumeSession":
    // Same shape as resume: the cwd is optional (the host falls back to its own
    // bounded lookup), but when given it must name a discovered checkout.
    // Host additionally re-checks the resolved pin home against the *live*
    // authorized open set before mutating (closed-project pin hole).
    case "toggleSessionPin":
    // The host discards a remote's `newSession.cwd` outright — newRemoteSession
    // starts in that tab's own repo — so this is belt to that braces. Listed
    // because the default branch below returns TRUE, and a cwd-bearing message
    // that is not named here is one refactor away from being trusted.
    case "newSession":
      return !msg.cwd || isKnownCwd(msg.cwd);
    // Admitted from a remote on cloud (CLOUD_DISPOSITION), so it MUST be named
    // here. The comment on newSession above is the whole reason: the default
    // branch returns true, and a cwd-bearing message that is not listed is one
    // refactor away from being trusted. The host bounds the path too; this is
    // the explicit catalog gate every admitted cwd goes through.
    case "removeProjectFolder":
      // NOT the `!msg.cwd || isKnownCwd(...)` shape used above, and the
      // difference matters: an absent cwd is harmless for newSession, but the
      // host resolves this one as `cwd || workspaceRoot()`, so a bare frame
      // would close whatever the machine currently has open — catalog gate and
      // all. A remote must NAME a project the catalog already knows. The empty
      // string falls back the same way, so it is refused too.
      return !!msg.cwd && isKnownCwd(msg.cwd);
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

/**
 * Capabilities that describe THE DESK MACHINE and would be actively misleading
 * on a phone, so they are removed from the `initialState` a remote receives.
 *
 * - `servesMediaRanges` — the desk host's own byte-range serving. A remote gets
 *   media through the remote media policy instead, so inheriting this would
 *   make the browser preload video the relay never sends.
 * - `showInFolder` — would offer "Show in folder" on a phone for a folder that
 *   only exists on the desk machine.
 * - `settingsEditor` — would post `openSettingsSurface` for a VS Code tab a
 *   phone cannot open; remotes use the in-page overlay instead.
 *
 * A list rather than a destructure at the call site so there is ONE place to
 * look when a capability is added, and so the removal is testable without a
 * whole sidebar. Belt-and-braces: `allowFromRemote` already refuses the
 * messages these unlock. Capabilities a remote genuinely needs — the file
 * browser, for one — must NOT be listed here.
 */
export const DESK_ONLY_CAPABILITIES = [
  "servesMediaRanges",
  // Closing folders stays at the desk; archive is available on every surface.
  "removeProjectFolder",
  "showInFolder",
  "previewInApp",
  "settingsEditor",
] as const satisfies ReadonlyArray<keyof HostUiCapabilities>;

/** `capabilities` as a remote may see them. Pure; see DESK_ONLY_CAPABILITIES. */
export function capabilitiesForRemote(
  capabilities: HostUiCapabilities,
): HostUiCapabilities {
  const out = { ...capabilities };
  for (const key of DESK_ONLY_CAPABILITIES) delete out[key];
  return out;
}

export type OutboundDisposition =
  /** Pure data — ferry as-is. */
  | "mirror"
  /** Carries a webview-only asWebviewUri src — must be inlined to base64 first. */
  | "media"
  /** Allowlisted subset — rewrite before crossing; never ferry the desk object. */
  | "allowlist"
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
  providerState: "mirror",
  // Page fields only (`projectMcpServerForRemote`). Launch recipes stay on
  // the desk. Same machine-global observation as mcpConnectors.
  mcpServers: "allowlist",
  mcpConnectors: "mirror",
  // Consent belongs to the workspace: broadcast and replay it on initial state
  // so the same user's reloaded tab can complete the current id + attemptId.
  mcpConnectorAuthorization: "mirror",
  // Mirrored, but the project-auth pass above trims both cwd-bearing lists
  // first, so a tab sees only routines and projects it may already reach.
  routines: "mirror",
  codexInstallProgress: "host-local",
  // Placement is a property of the machine running the extension, and `moveView`
  // is host-local anyway — a remote could neither act on the hint nor need it.
  moveViewHint: "host-local",
  // Empty-state advice. Mirrored because the pool is per-CLIENT, not per-host:
  // the desk-only entries are filtered by the reader (welcomeTipsFor reads
  // isRemote), and what is left here is two counts and a list of ids the user
  // has finished with. No project data, no payload — see the type.
  welcomeTips: "mirror",
  // Where new projects go and how the last attempt went. `root` is the
  // display form (`~/Grok Build`) and nothing here carries a created path —
  // the repo catalog delivers that, already trimmed to what this client may
  // reach. So there is no project data in the frame to authorize.
  projectSetup: "mirror",
  // Connection snapshot and repo names for the clone picker. No token, no
  // home path, no project cwd — the same class as providerState.
  githubState: "mirror",
  githubRepos: "mirror",
  showThinking: "mirror",
  appPurpose: "mirror",
  fontScale: "mirror",
  telemetryEnabled: "mirror",
  thumbsFeedback: "mirror",
  grokUpdateStatus: "mirror",
  // Desk-only installer notice / restart — a remote has nothing useful to do with it.
  updateAvailable: "host-local",
  updateReady: "host-local",
  initialized: "mirror",
  cliUpdating: "mirror",
  session: "mirror",
  // Conversation names are already exposed in the remote history list, so
  // the focused-name update has the same display-only sensitivity.
  sessionName: "mirror",
  sessionRemoved: "mirror",
  modelChanged: "mirror",
  modeChanged: "mirror",
  planModeAvailability: "mirror",
  openModePopover: "mirror",
  chips: "mirror",
  commandsUpdate: "mirror",
  mentionResults: "mirror",
  // Targeted answers to a phone's list/read/write. absPath on content is
  // edit-meta only (capability-gated host-side) and round-trips on save.
  projectDirListing: "mirror",
  projectFileContent: "mirror",
  projectFileWriteResult: "mirror",
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
  childStream: "mirror",
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
  // Desk/VS Code only — a phone opens find from its own ⋯, and a palette
  // invocation on the desk must not pop a find bar on every linked tab.
  findInSession: "host-local",
  restoreComposer: "mirror",
  truncateMessages: "mirror",
  uiConfirmRequest: "mirror",
  sessions: "mirror",
  repoSessions: "mirror",
  pinnedSessions: "mirror",
  repos: "mirror",
  sessionDot: "mirror",
  queuedSends: "mirror",
  submitQueuedSend: "mirror",
  steerUnavailable: "mirror",
  feedbackAvailability: "mirror",
  turnFeedbackAck: "mirror",
  usage: "mirror",
};

/**
 * Whether delivering this HostMsg to a remote client requires a live authorized
 * project scope (open folder / worktree). Independent of {@link OUTBOUND_DISPOSITION}
 * (mirror vs host-local): a mirrored transcript is still project data.
 *
 * - `none` — device prefs, errors, UI chrome with no project path fields. Always OK.
 * - `scope` — conversation/session payload; caller must pass the session or
 *   repo cwd, which must be in the live authorized set.
 * - `entries` — list frames; every entry's `cwd` must be authorized (empty list OK).
 * - `message-cwd` — frame carries its own `cwd` field that must be authorized.
 * - `repos-catalog` — `repos` frame: every entry cwd authorized; selectedCwd /
 *   activeCwd authorized or empty (empty = unbound after rehome; closed ≠ empty).
 * - `optional-cwd` — frame carries a `cwd` that is authorized or empty (no
 *   closed-project leak via reconnect shell).
 *
 * Exhaustive over HostMsg so a new type cannot ship without a classification.
 */
export type OutboundProjectAuth =
  | "none"
  | "scope"
  | "entries"
  | "message-cwd"
  | "repos-catalog"
  | "optional-cwd";

export const OUTBOUND_PROJECT_AUTH: Record<HostMsg["type"], OutboundProjectAuth> = {
  // Device-global / host chrome — not project data.
  moveViewHint: "none",
  welcomeTips: "none",
  projectSetup: "none",
  githubState: "none",
  githubRepos: "none",
  showThinking: "none",
  appPurpose: "none",
  fontScale: "none",
  telemetryEnabled: "none",
  thumbsFeedback: "none",
  grokUpdateStatus: "none",
  updateAvailable: "none",
  updateReady: "none",
  cliUpdating: "none",
  onboarding: "none",
  providerState: "none",
  mcpServers: "none",
  mcpConnectors: "none",
  mcpConnectorAuthorization: "none",
  routines: "entries",
  codexInstallProgress: "none",
  expandCommandOutputs: "none",
  steerByDefault: "none",
  soundNotifications: "none",
  processingSound: "none",
  readRepliesAloud: "none",
  summarizeRepliesAloud: "none",
  moveComposerCaret: "none",
  remoteStatus: "none",
  error: "none",
  hostNotice: "none",
  focusInput: "none",
  findInSession: "none",
  openModePopover: "none",
  // Open-folder catalog — project-bearing selectedCwd/activeCwd/entries validated.
  repos: "repos-catalog",
  // Safe wipe — no project path fields.
  clearMessages: "none",
  // Reconnect shell carries cwd; empty or authorized only.
  initialState: "optional-cwd",
  // Session-start chrome; delivered via emit → sendRemoteSession with scope.
  initialized: "scope",
  // voiceConfigured is project-scoped (sendPhrase / key resolution per cwd) —
  // a closed or re-homed tab must not keep the prior project's voice prefs.
  // Content-bearing voiceSubmit / voiceTranscript / voicePartial use scope so a
  // closed-project capture cannot land after rehome. voiceState / voiceError are
  // control chrome without project metadata.
  voiceState: "none",
  voiceConfigured: "scope",
  voicePartial: "scope",
  voiceSubmit: "scope",
  voiceTranscript: "scope",
  voiceError: "none",
  // History / session lists — empty entries are fine; a closed cwd in an entry is not.
  sessions: "entries",
  pinnedSessions: "entries",
  repoSessions: "message-cwd",
  sessionName: "message-cwd",
  sessionRemoved: "message-cwd",
  // Session-scoped live + restore payload — requires authorized session/repo cwd.
  session: "scope",
  sessionDot: "scope",
  chips: "scope",
  modelChanged: "scope",
  modeChanged: "scope",
  planModeAvailability: "scope",
  commandsUpdate: "scope",
  mentionResults: "scope",
  // Carry the scoped repo cwd; authorize against that field (message-cwd) so a
  // closed project cannot keep answering file reads after rehome.
  projectDirListing: "message-cwd",
  projectFileContent: "message-cwd",
  projectFileWriteResult: "message-cwd",
  userMessage: "scope",
  agentStart: "scope",
  thoughtChunk: "scope",
  messageChunk: "scope",
  userMessageChunk: "scope",
  media: "scope",
  imageFull: "scope",
  speechSummary: "scope",
  historyReplay: "scope",
  historyBatch: "scope",
  permissionHistoryQueue: "scope",
  planHistoryQueue: "scope",
  toolCall: "scope",
  toolCallUpdate: "scope",
  permissionRequest: "scope",
  permissionOptions: "scope",
  permissionResolved: "scope",
  exitPlanRequest: "scope",
  planResolved: "scope",
  questionRequest: "scope",
  planNotice: "scope",
  autoCompactNotice: "scope",
  planBlocked: "scope",
  promptComplete: "scope",
  contextUsage: "scope",
  agentReset: "scope",
  agentError: "scope",
  agentEnd: "scope",
  exit: "scope",
  setBusy: "scope",
  summarizing: "scope",
  sessionContext: "scope",
  xaiNotification: "scope",
  subagentUpdate: "scope",
  childStream: "scope",
  runProgress: "scope",
  commandOutput: "scope",
  setAllToolDetails: "scope",
  restoreComposer: "scope",
  truncateMessages: "scope",
  uiConfirmRequest: "scope",
  queuedSends: "scope",
  submitQueuedSend: "scope",
  steerUnavailable: "scope",
  feedbackAvailability: "scope",
  turnFeedbackAck: "scope",
  usage: "scope",
};

/**
 * Frames that carry their own authorization cwd and are therefore ABOUT a
 * project rather than payload FROM the recipient's conversation.
 *
 * This distinction is not cosmetic. The uplink filters recipients to the tab
 * that owns a delivery's scope, which is right for transcript and wrong here:
 * the projects rail asks for a preview of a SIBLING project on purpose, so
 * "the recipient does not own this cwd" is the normal case, not an attack.
 * Treating them alike silently dropped every `repoSessions` answer over the
 * relay — the phone's rail then sat on its update-Grok-Build note forever
 * against a host that was perfectly current and had already answered.
 *
 * Authorization is unchanged either way: {@link mayDeliverRemoteHostMsg} checks
 * the frame's OWN `cwd` against the live authorized set and ignores the scope
 * argument for these types.
 */
export function isSelfScopedOutbound(type: HostMsg["type"]): boolean {
  return OUTBOUND_PROJECT_AUTH[type] === "message-cwd";
}

/**
 * Sole authorization predicate for remote HostMsg delivery. Callers pass the
 * session/repo cwd as `scopeCwd` for `scope` types; list frames are checked
 * against their entries (and `message-cwd` against the frame's own field).
 *
 * Returns false when project/session/transcript data would leave for a closed
 * folder — independent of whether revoke already cleared per-tab mappings.
 */
export function mayDeliverRemoteHostMsg(
  msg: HostMsg,
  authorizedCwds: readonly string[],
  scopeCwd: string | undefined,
  sameCwd: (a: string, b: string) => boolean,
): boolean {
  if (msg.type === "historyBatch") {
    return msg.messages.every((nested) =>
      mayDeliverRemoteHostMsg(nested, authorizedCwds, scopeCwd, sameCwd),
    );
  }
  switch (OUTBOUND_PROJECT_AUTH[msg.type]) {
    case "none":
      return true;
    case "entries": {
      // `routines` carries TWO cwd-bearing lists — the rows and the project
      // picker feeding the form. Checking only `entries` would hand a remote
      // the name of every project on the machine through the dropdown.
      if (msg.type === "routines") {
        return (
          msg.entries.every(
            (e) =>
              cwdIsAuthorized(e.cwd, authorizedCwds, sameCwd) &&
              // A retained run can name a project the routine no longer points
              // at, so the entry's own cwd does not vouch for it.
              e.runs.every((run) => !run.cwd || cwdIsAuthorized(run.cwd, authorizedCwds, sameCwd)),
          ) && msg.projects.every((p) => cwdIsAuthorized(p.cwd, authorizedCwds, sameCwd))
        );
      }
      const entries =
        msg.type === "sessions" || msg.type === "pinnedSessions"
          ? msg.entries
          : [];
      return entries.every(
        (e) => !e.cwd || cwdIsAuthorized(e.cwd, authorizedCwds, sameCwd),
      );
    }
    case "repos-catalog": {
      if (msg.type !== "repos") return false;
      // Empty selected/active is intentional after rehome (unbound tab). A
      // non-empty closed path is a leak — refuse rather than mirror builders.
      if (msg.selectedCwd && !cwdIsAuthorized(msg.selectedCwd, authorizedCwds, sameCwd)) {
        return false;
      }
      if (msg.activeCwd && !cwdIsAuthorized(msg.activeCwd, authorizedCwds, sameCwd)) {
        return false;
      }
      return msg.entries.every(
        (e) => !e.cwd || cwdIsAuthorized(e.cwd, authorizedCwds, sameCwd),
      );
    }
    case "optional-cwd": {
      if (msg.type !== "initialState") return false;
      return !msg.cwd || cwdIsAuthorized(msg.cwd, authorizedCwds, sameCwd);
    }
    case "message-cwd": {
      if (msg.type === "repoSessions") {
        // A refusal only echoes the cwd the requester supplied and carries no
        // host data. Let it return even when that cwd is not authorized so an
        // invalid request gets a coarse answer instead of silence.
        if (msg.error) {
          return msg.entries.length === 0 && Object.keys(msg.dots).length === 0 && msg.total === 0;
        }
        if (!cwdIsAuthorized(msg.cwd, authorizedCwds, sameCwd)) return false;
        return msg.entries.every(
          (e) => !e.cwd || cwdIsAuthorized(e.cwd, authorizedCwds, sameCwd),
        );
      }
      if (msg.type === "sessionName" || msg.type === "sessionRemoved") {
        return cwdIsAuthorized(msg.cwd, authorizedCwds, sameCwd);
      }
      // The file-browser answers. They were classified `message-cwd` above but
      // never handled here, so all three fell through to `false` and every one
      // was dropped: the panel just sat on "Loading…" forever. The whole remote
      // file browser was dead at this gate, and nothing caught it because the
      // button that opens it was separately invisible on the client.
      //
      // Same rule as the two above, and the reason this classification exists at
      // all: a project closed between the request and the answer must not still
      // be answering reads, so the cwd is authorized against the LIVE set here
      // rather than trusted from when the request was let in.
      if (
        msg.type === "projectDirListing" ||
        msg.type === "projectFileContent" ||
        msg.type === "projectFileWriteResult"
      ) {
        return cwdIsAuthorized(msg.cwd, authorizedCwds, sameCwd);
      }
      return false;
    }
    case "scope":
      return cwdIsAuthorized(scopeCwd, authorizedCwds, sameCwd);
    default:
      return false;
  }
}

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
  if (msg.type === "queuedSends" && msg.queued) {
    return {
      ...msg,
      queued: msg.queued.map((item) => ({
        ...item,
        ...(item.chips
          ? { chips: item.chips.map((chip) => inlineChipPreviewForRemote(chip, deps)) }
          : {}),
      })),
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
    case "allowlist":
      return allowlistHostMsgForRemote(msg);
    default:
      return null; // host-local
  }
}

/** Omit absent projects and redact retained runs from removed projects. */
export function routinesMessageForRemote(
  msg: Extract<HostMsg, { type: "routines" }>,
  authorizedCwds: readonly string[],
  sameCwd: (a: string, b: string) => boolean,
): Extract<HostMsg, { type: "routines" }> {
  return {
    ...msg,
    entries: msg.entries
      .filter((e) => cwdIsAuthorized(e.cwd, authorizedCwds, sameCwd))
      .map((e) => ({ ...e, runs: e.runs.map((run) => redactRun(run, authorizedCwds, sameCwd)) })),
    projects: msg.projects.filter((p) => cwdIsAuthorized(p.cwd, authorizedCwds, sameCwd)),
  };
}

/** Filter unauthorized rows rather than suppressing an entire repo preview. */
export function repoSessionsMessageForRemote(
  msg: Extract<HostMsg, { type: "repoSessions" }>,
  authorizedCwds: readonly string[],
  sameCwd: (a: string, b: string) => boolean,
): Extract<HostMsg, { type: "repoSessions" }> {
  if (msg.error) return msg;
  const entries = msg.entries.filter(
    (entry) => !entry.cwd || cwdIsAuthorized(entry.cwd, authorizedCwds, sameCwd),
  );
  if (entries.length === msg.entries.length) return msg;
  const keptIds = new Set(entries.map((entry) => entry.id));
  return {
    ...msg,
    entries,
    dots: Object.fromEntries(Object.entries(msg.dots).filter(([id]) => keptIds.has(id))),
    total: entries.length,
  };
}

/**
 * A run whose own project is out of reach keeps only the fact that it happened.
 *
 * A routine's project can be edited, so its retained runs can name a DIFFERENT
 * project from the one it points at now — and that older project may since have
 * been removed. Filtering the routine's current cwd is then not enough: the
 * entry passes under its new project while a retained run still carries the old
 * path, its session id, and a `detail` string that may quote either.
 *
 * Redacted rather than dropped, because the run DID happen and the health count
 * beside it is computed host-side from the full list. Removing the row would
 * make the strip disagree with its own total; blanking its identity leaves the
 * strip honest and the tick simply unclickable, which is what it should be when
 * it points somewhere this connection may not go.
 */
function redactRun<T extends { cwd?: string; sessionId?: string; detail?: string }>(
  run: T,
  authorizedCwds: readonly string[],
  sameCwd: (a: string, b: string) => boolean,
): T {
  // No cwd at all is a record written before runs carried one. Its session
  // resolves against the routine's current project, which is already checked.
  if (!run.cwd || cwdIsAuthorized(run.cwd, authorizedCwds, sameCwd)) return run;
  const { cwd: _cwd, sessionId: _sessionId, detail: _detail, ...rest } = run;
  return rest as T;
}

/** Fail closed: an `allowlist` type with no rewriter is dropped, not ferried. */
function allowlistHostMsgForRemote(msg: HostMsg): HostMsg | null {
  if (msg.type === "mcpServers") return projectMcpServersMessageForRemote(msg);
  return null;
}
