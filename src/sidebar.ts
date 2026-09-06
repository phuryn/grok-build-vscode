import type {
  Host,
  HostCancellationToken,
  HostContext,
  HostDisposable,
  HostTextDocumentContentProvider,
  HostWebview,
  HostWebviewView,
  HostEditorWebview,
} from "./host";
import { Uri, disposeAll, formatRemoteInstallId, shouldRehydrateOnWebviewReady } from "./host";
import { isCanonicallyInsideRoot } from "./file-tree";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { AcpClient, EffortLevel, ExitPlanRequest, PermissionRequest, QuestionRequest } from "./acp";
import type { AcpProvider, BackendSessionListEntry } from "./acp-backend";
import { isAdapterProvider, isAcpProvider, ACP_PROVIDERS } from "./acp-backend";
import { CODEX_ACP_ADAPTER_VERSION, CodexBackend, isCodexCredentialError } from "./codex-backend";
import { locateCodexCli, resolveCodexHome } from "./codex-cli-locator";
import { CODEX_MANAGED_VERSION, installManagedCodex } from "./codex-managed-installer";
import { warmCodexModelCache } from "./codex-model-cache";
import { CLAUDE_ACP_ADAPTER_VERSION, ClaudeBackend, isClaudeCredentialError } from "./claude-backend";
import { locateClaudeCli, parseClaudeVersionOutput } from "./claude-cli-locator";
import { warmClaudeModelCache } from "./claude-model-cache";
import {
  adapterEntriesEligibleForClear,
  adapterListEntry,
  connectedProviderIds,
  usableProviderIds,
  findCachedAdapterSession,
  mergeProviderHistoryPage,
  mergeProviderSessionEntries,
  missingProviderState,
  modelsForConnectedProviders,
  parseCodexVersionOutput,
  projectProviderKey,
  providerDisplayName,
  providerLoginState,
  versionIsOlder,
  type ProjectProviderDefaults,
  type ProviderConnections,
  type ProviderModelCache,
  type ProviderModelInfo,
  type ProviderHistoryCursor,
} from "./provider-ui";
import {
  nextWakeAt,
  ROUTINES_KEY,
  routineWindow,
  toRoutineView,
  validateRoutine,
  manualWindowKey,
  routineSessionName,
  type Routine,
  type RoutineModelOption,
  type RoutineProjectOption,
  type RoutineRun,
} from "./routines";
import { RoutineRunStore } from "./routine-store";
import { routinesMessageForRemote } from "./remote-policy";
import { PersistedState } from "./persisted-state";
import {
  Session,
  SessionStartIntent,
  SessionStatus,
  INTERRUPTED_SEND_TEXT,
  beginQueuedSendCommit,
  beginTurn,
  createPendingPermission,
  decideSessionStart,
  endTurn,
  finishQueuedSendCommit,
  runExclusiveHistoryLoad,
  pendingPermissionOptions,
  preferredPermissionAllowOption,
  rehydrateBusyChrome,
  sessionHasWorkInFlight,
  sessionReadyForPrompt,
  sessionUiSnapshot,
  turnIsInFlight,
} from "./session";
import { buildReapCandidates, selectReapable, computeDot, Dot } from "./session-pool";
import { resolveVoiceKey, extractGrokAuthKey, parseVoiceCommand, buildSttKeyterms, voiceSettingForRepo, voiceSettingWriteTarget, sanitizeVoiceSendPhrase, sanitizeVoiceKeyterms, voiceConfiguredFingerprint, DEFAULT_SEND_PHRASE, MAX_RECORDING_SECONDS } from "./voice";
import { VoiceRecorder, transcribeAudio, resolveWindowsAudioDevice } from "./voice-recorder";
import { PcmVoiceStreamer, VoiceStreamer } from "./voice-streamer";
import { summarizeForSpeech } from "./speech-summary";
import type { PromptResultMeta, PromptUsage, SessionInfoContext } from "./acp-dispatch";
import { MediaRef, adapterCompactSignal, adapterContextOccupancy, agentTimestampMsFromMeta, autoCompactStartedNote, childStreamFromRoute, commandOutputForToolCall, commandOutputFromLiveTerminal, contextUsedFromCompactNotification, enforceCompleteSessionCost, errorDetail, gateZeroTokenMeta, isAuthErrorText, isCredentialError, isIncompatibleAgentError, isResumeNotFound, isRateLimitError, isSubagentLifecycleUpdate, occupancyFromAdapterTurn, parseSessionInfoContext, permissionOutcomeFor, promptErrorText, rateLimitNoticeText, sessionInfoCacheFresh, sumUsage, summarizeBackgroundCommand, usageIsRealMeasurement, type UpdateRoute } from "./acp-dispatch";
import { createMcpPrepareState, prepareMcpToolCall } from "./mcp-tool";
import { modeToRemember, startsInYolo } from "./mode-prefs";
import { beginAuthRecovery, oauthShadowsXaiApiKey } from "./auth-recovery";
import {
  WELCOME_TIPS_KEY,
  WELCOME_TIPS_SHOWN_KEY,
  localDayKey,
  parseDismissedTips,
  shownOn,
  withDismissedTip,
  withShownTip,
} from "./welcome-tips";
import { commandOnPath, runGitClone } from "./git-clone";
import {
  DISCONNECTED_GITHUB,
  githubEnvTokenBlocksSignOutMessage,
  githubEnvTokenName,
  listGithubRepositories,
  loginGithubWithToken,
  logoutGithub,
  readGithubAuthState,
  type GithubAuthState,
} from "./github-auth";
import {
  deviceLoginFailureText,
  deviceLoginPlan,
  deviceLoginPreflight,
  deviceLoginCodeNote,
  noRemoteSignInMessage,
  deviceLoginUnavailable,
} from "./device-login";
import { probeClaudeAuthStatus, runDeviceLogin, type DeviceLoginHandle } from "./device-login-run";
import {
  GITHUB_CLI_BIN,
  githubDeviceLoginFailureText,
  isGithubCliMissing,
  runGithubDeviceLogin,
} from "./github-device-login";
import {
  GITHUB_CLI_DOWNLOAD,
  classifyCloneFailure,
  cloneDestination,
  cloneFailureText,
  cloneUrlError,
  normalizeCloneUrl,
  displayPath,
  githubCliInstallCommand,
  githubFixFor,
  githubSignInCommand,
  offersGithubSetup,
  projectDestination,
  projectNameError,
  PROJECT_ROOT_CHOICE_KEY,
  legacyProjectRootPath,
  projectRoot,
  rememberedRootFor,
  shouldUseLegacyRoot,
} from "./project-create";
import {
  GROK_VIEW_ID,
  MOVE_VIEW_HINT_USED_KEY,
  moveViewContainerFor,
  panelPositionFor,
  shouldShowMoveViewHint,
} from "./view-move";
import {
  APTABASE_APP_KEY_PROD,
  buildSessionStartEvent,
  osNameFromPlatform,
  postEvent,
  sessionStartHostKind,
  sessionStartSurface,
  shouldSendTelemetry,
  OFFICIAL_EXTENSION_ID,
} from "./telemetry";
import { randomUUID } from "node:crypto";
import { execGrokCli } from "./cli-process";
import { listGitWorktreePaths } from "./git-worktree-list";
import {
  locateGrokCli,
  extensionWasUpgraded,
  isStdioBrokenGrokVersion,
  parseGrokVersion,
  grokUpdatePolicy,
  shouldReactivelyDowngrade,
  isLockedBinaryError,
  readCliBinaryIdentity,
  resolvePlanModeAvailability,
  CLI_VERSION_CACHE_KEY,
  GROK_REQUIRED_VERSION,
  GROK_STDIO_DOWNGRADE_TARGET,
  type CliVersionCache,
} from "./cli-locator";
import { OpenClock } from "./open-timing";
import {
  TerminalManager,
  commandLanguageForDialect,
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
  allocateImageIndex,
} from "./chips";
import { buildPromptWithImages, buildQueuedPromptWithImages, type PromptImageInput, type QueuedPromptContribution } from "./prompt-builder";
import {
  chipsForQueueSend,
  claimQueuedSendDispatch,
  cloneChipForQueue,
  dequeueQueuedSends,
  enqueueQueuedSend,
  explicitVisibleChips,
  queuedFlushText,
  queuedSendsContainChipIds,
  queuedSendsHaveContent,
  queuedSendsMessage,
  queuedSendsText,
  restoreQueuedChips,
  type QueuedSendEntry,
} from "./queued-send";

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
import {
  alwaysApproveSource,
  configForcesAlwaysApprove,
  globalConfigPath,
  projectConfigPath,
} from "./grok-config";
import { sessionScopedRoots } from "./auth-roots";
import { fileUriToPath, parseFileRef, shouldReadFileInline } from "./file-ref";
import {
  prepareFileUpload,
  retainedUploadDirectories,
  stagedUploadDirectory,
  unreferencedUploadsForRemovedSessions,
} from "./file-upload";
import { MAX_DIFF_EXPAND_BYTES, expandDiffToWholeFile } from "./diff-view";
import { applyAgentModeToHostPlan, effectivePlanActive, isPlanReviewPermission, permissionAnswerAllowed, permissionOptionsForPlan, pickRejectOption, planReviewVerdictForOption, planTextFromPermissionToolCall, shouldRejectPermission } from "./plan-gate";
import { appendPlanEntry, planRestoreSource, truncateResolvedAfter, countsAsUserBubble, decideRestoreState, isInterjectionText } from "./plan-restore";
import {
  planReviewFileName,
  planReviewSessionDirectoryName,
} from "./plan-review";
import { isPrimerText } from "./grok-primer";
import { AsyncSerialQueue } from "./async-serial";
import { HOST_CAPABILITIES, HostMsg, INTERRUPTED_SEND_CODE, SESSION_SUPERSEDED_CODE, WebviewMsg, type GithubState, type ProjectSetupGithub } from "./protocol";
import { withoutArchiveFields } from "./project-discovery";
import { RemoteUplink } from "./remote-uplink";
import { RemoteClientState, serializesRemoteSessionTransition } from "./remote-client-state";
import { RemotePcmIngress, acceptRemotePcm } from "./remote-voice";
import { SessionRequestState } from "./session-request-state";
import { allowFromRemote, capabilitiesForRemote, allowRemoteRepoTarget, bracketRemoteSnapshot, mayDeliverRemoteHostMsg, remoteRequiresBoundSession, repoScopeFor, repoSessionsMessageForRemote, sessionCwdBelongsToRepo, sessionForRequest, shouldAdoptDeskSession, transformHostMsgForRemote, type MediaInlineDeps, type MsgOrigin, type RemoteTier } from "./remote-policy";
import {
  listRemoteProjectDir,
  projectFileContentForWire,
  readRemoteProjectFile,
  resolveRemoteFileRoot,
  writeRemoteProjectFile,
} from "./remote-files";
import {
  isCloudEnvironment,
  CLOUD_ENVIRONMENT_ENV, buildLinkStartBody, deviceDisplayName, httpBaseFromRelayUrl, parseRelayFrame, RELAY_DEVICE_TOKEN_SECRET, resolveRelayUrl } from "./remote-frames";
import { KeepAwake, shouldKeepAwake } from "./keep-awake";

/**
 * How long an unanswered card keeps a cloud machine awake.
 *
 * A backstop, not the main signal: a command that is still RUNNING keeps the
 * machine awake for as long as it runs, however long that is. This covers the
 * rest — an agent that has genuinely stopped and is waiting on a person. Long
 * enough not to punish somebody who steps away mid-thought, short enough that a
 * card nobody comes back to tonight stops costing money. Local wake locks are
 * unaffected; this is only about a machine somebody else is paying for.
 */
const NEEDS_YOU_KEEP_AWAKE_MS = 20 * 60 * 1000;

/**
 * Is this session actually holding work open?
 *
 * The status alone is not enough, and the gap is a real one: worktree teardown
 * detaches and disposes a session's client while leaving its row in the pool
 * with `working` still on it. That ghost then keeps the OS wake lock — and, on
 * a rented machine, the keep-awake heartbeat — running for the rest of the
 * session, long after everything it described was killed.
 *
 * Checking the CLIENT rather than patching that one caller is deliberate: a
 * session with no client has no agent, so it cannot be working whatever its
 * status says, and any other path that disposes a client without updating a
 * status is covered by the same line.
 */
function hasLiveWork(s: { status: string; client?: unknown }): boolean {
  if (!s.client) return false;
  return s.status === "working" || s.status === "needs-you";
}
import { thumbnailImage, thumbnailMime } from "./image-thumbnail";
import { historyImagePreviews } from "./image-history";
import {
  SessionListEntry,
  SessionMetaOverrides,
  RepoArchives,
  RepoColors,
  RepoListEntry,
  RepoPins,
  capAutoName,
  capUsageLog,
  capSessionMetaAutoNames,
  carrySessionName,
  clearSessions,
  cliSessionTitle,
  defaultFs,
  deleteSessionDir,
  discoverRepos,
  fallbackName,
  findSessionCatalogCwd,
  forkDisplayName,
  indexSessions,
  isEmptySession,
  isPathInside,
  isRepoColor,
  REPO_COLOR_IDS,
  mostRecentSession,
  neighbourAfterDelete,
  normalizeRepoPath,
  orderedResumeCwdCandidates,
  persistSessionContext,
  persistedContextUsage,
  contextUsageFromLog,
  readContextUsage,
  relativePathWithin,
  readSessionEntries,
  expiredArchiveChoiceKeys,
  newestTranscriptMtime,
  resolveGrokHome,
  sessionCatalogDirs,
  sessionDirFor,
} from "./sessions";
import {
  base64DecodedByteLength,
  isTrustedCodexGeneratedImagePath,
  isTrustedGeneratedMediaPath,
  MAX_INLINE_MEDIA_BYTES,
  resolveChatOpenFilePath,
} from "./media-serve";
import { isExecutableOpenTarget, revalidateOpenFileForUse } from "./desktop/desktop-policy";
import {
  describeFfmpegProblem,
  ffmpegInstallHint,
  resolveConfiguredFfmpeg,
  type FfmpegResolution,
} from "./ffmpeg-locate";
import {
  CLONE_WORKTREE_SOURCE_MARKER,
  cloneWorktreeSourceMatches,
  filterWorktreesForSourceRepo,
  gitRootForPath,
  isGitRepo,
  matchWorktreeForCwd,
  mergeSessionIndexes,
  mergeWorktreeRefresh,
  normalizeFsPath,
  pathsEqual,
  sanitizeWorktreeLabel,
  WorktreeCreateSlots,
  type WorktreeCreateOutcome,
  worktreeStatusIsForCreate,
  worktreeStatusVerdict,
  worktreePathAuthorizedForRepo,
  type WorktreeParentRef,
  type WorktreeRecord,
  worktreeCwdsForRepo,
  worktreeDisplayName,
  worktreesForRepo,
} from "./worktree";
import {
  authorizedListCwd,
  cwdIsAuthorized,
  filterEntriesByAuthorizedCwd,
  imageHandlesToRevoke,
  imagePathStillAuthorized,
  pathBoundToClosedFolder,
  remoteBoundCwdStillAuthorized,
  sessionBoundToClosedFolder,
} from "./workspace-auth";
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
  commandsAdvertiseFeedback,
  decideFeedbackAvailability,
  feedbackClientType,
  isThumbsRating,
  parseFeedbackEnabledMeta,
} from "./feedback";
import {
  parseRunProgressUpdate,
  workflowControlCommand,
} from "./run-progress";
import {
  APP_PURPOSE_KEY,
  DEFAULT_APP_PURPOSE,
  parseAppPurpose,
  type AppPurpose,
} from "./app-purpose";
import { MCP_GLOBAL_SCOPE_WARNING, mergeMcpNotification, parseMcpListResponse, mcpSettingsServersForCwd, type McpServerView } from "./mcp";
import {
  MCP_CONNECTORS_KEY,
  MAX_CONNECTOR_KEY_CHARS,
  TIER1_CONNECTORS,
  bearerAuthorizationHeader,
  collectMcpNameFiles,
  collectMcpNameLayers,
  collectReservedMcpIdentity,
  connectConnector,
  connectorById,
  connectorViews,
  disconnectConnector,
  hostMcpServers,
  isConnectorId,
  isKeyConnector,
  mcpConfigLayer,
  mcpConfigPaths,
  mcpConnectorSecretKey,
  mcpRemoteArgs,
  mergeReserved,
  parseConnectedConnectorStore,
  reservedFromMcpInventory,
  withAuthHeaderEnv,
  type ConnectedConnectorStore,
  type ConnectorDef,
  type ConnectorId,
  type ReservedMcpIdentity,
} from "./mcp-connectors";
import {
  authorizeMcpRemote,
  connectorsLackingOAuthToken,
  npxSpawnPlan,
  persistConnectorOAuthClientMetadata,
  writeOAuthClientMetadataFile,
} from "./mcp-connector-auth";

// HostMsg (host -> webview) and WebviewMsg (webview -> host) both live in
// src/protocol.ts now — the single source of truth for the message contract,
// imported above. See that file for why.

const SESSION_META_KEY = "grok.sessionMeta";
const PROVIDER_CONNECTIONS_KEY = "grok.providerConnections";
const PROVIDER_MODEL_CACHE_KEY = "grok.providerModelCache";
const PROJECT_PROVIDER_DEFAULTS_KEY = "grok.projectProviderDefaults";
const REPO_PINS_KEY = "grok.repoPins";
/** Timestamped archive choices, stored under ~/.grok/client-state rather than
 *  per-client so the choice follows you to a phone and survives a cleared
 *  browser — archiving is curation of your projects, not a preference about one
 *  sidebar. Every rail reads it; the VS Code repo picker ignores it entirely. */
const REPO_ARCHIVES_KEY = "grok.repoArchives";
/** Shared client-state key for per-project folder colours in the conversation
 *  rail. Stored under ~/.grok/client-state so the choice follows you to a phone
 *  and survives a cleared browser — same home as pins/archives. */
const REPO_COLORS_KEY = "grok.repoColors";
/**
 * Folders the user added to the rail by hand, on a host that cannot open them.
 *
 * Desktop "Add project" changes the app's OWN workspace, so it needs no list —
 * `workspaceFolders()` is the list. VS Code's workspace belongs to VS Code, and
 * adding a folder to it converts a single-folder window into a multi-root one
 * and reloads the extension host, which is a violent answer to "show me this
 * project in the rail". So VS Code records the folder here instead: it joins
 * `trustedCwds` and appears as an ordinary catalog row, VS Code's own Explorer
 * is untouched, and nothing reloads.
 *
 * **It does grant reach, and that is the point.** An earlier version of this
 * comment claimed otherwise on the grounds that `localTrustedSessionCwds`
 * already trusts the whole discovered catalog — true, but the folder this
 * feature adds is precisely the one Grok has NEVER run in, so it was not in
 * that catalog and is now. It becomes selectable, and through the phone,
 * browsable and editable like any other project. That is what the user asked
 * for by picking it. What it must therefore also be is REVOCABLE — see
 * {@link GrokSidebar.forgetExtraProjectFolder}, reachable from the rail's ⋯
 * menu on exactly the rows that came from here.
 *
 * Absent from `DISK_KEYS`, so it lives in `globalState` rather than the shared
 * `~/.grok/client-state` that pins and colours use. Deliberate: pins and colours
 * are curation you want to follow you to the phone, this is a workaround for one
 * editor's inability to show a folder it has not opened. Desktop filters it out
 * anyway (`localRepoCatalogEntries` keeps only open folders there), so sharing
 * it would move bytes around for no effect.
 */
const EXTRA_PROJECT_FOLDERS_KEY = "grok.extraProjectFolders";
/**
 * Folders the user has explicitly REMOVED from the rail, which stay removed.
 *
 * Dropping the added-folder record was not enough to make "Hide project" mean
 * anything. VS Code's catalog is discovered from Grok's own session history, so
 * the moment anything ran in that folder the row came back on its own — and a
 * phone selecting the project is enough to create that history, because
 * `selectRemoteRepo` opens or starts a session there. So a remote could make its
 * own access permanent by selecting a newly added project before the user
 * thought better of it, and the returning row carried no `added` marker, so the
 * rail no longer offered to remove it.
 *
 * A tombstone is the only thing that survives that. Nothing on disk is touched
 * and no conversation is deleted — the project is simply not listed, and
 * therefore not trusted, until the user adds the folder again, which clears it.
 * VS Code-local like its counterpart: absent from `DISK_KEYS`, so it lives in
 * `globalState` rather than the shared client-state.
 */
const REMOVED_PROJECT_FOLDERS_KEY = "grok.removedProjectFolders";
/** Shared client-state key for the anonymous per-install telemetry GUID (survives
 *  updates and identifies this machine across clients).
 *
 *  This is MACHINE identity, not DEVICE identity. The relay REVOKES every device
 *  row carrying the same install id when a link is approved (that is how a
 *  re-link retires its own stale predecessor instead of hitting the free tier's
 *  device cap). So a second client on this machine must NOT send this value
 *  verbatim to `/api/link/start` — it would revoke the extension's device and
 *  drop its uplink, and re-linking here would revoke that client's in turn.
 *  Send a discriminated form (`<id>:desktop`) and leave the bare id to the
 *  extension, whose already-linked rows store it bare. */
const INSTALL_ID_KEY = "grok.installId";
/** VS Code-local globalState key for the eye-off choice on the active-editor context chip.
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

type RemoteResumeTarget =
  | { kind: "conflict"; selectedCwd: string; ownerId: string; session: Session }
  | { kind: "repo-mismatch"; selectedCwd: string }
  | { kind: "live"; selectedCwd: string; session: Session }
  | { kind: "disk"; selectedCwd: string; actualCwd: string; provider: AcpProvider }
  | { kind: "missing"; selectedCwd: string };

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
  /** True only after a live parseable `--version`. A cache stand-in stays false. */
  planModeVersionVerified: boolean;
  /** True when Plan availability came from `grok.cliVersionCache`, not a live `--version`. */
  usedCache?: boolean;
  /**
   * Parseable `X.Y.Z` from this probe (live or cache). Absent when unknown.
   * Display / Plan only — initialize must not see this unless
   * `planModeVersionVerified` is true.
   */
  cliVersion?: string;
}

interface SessionsListOptions {
  offset?: number;
  limit?: number;
  query?: string;
  providerCursor?: ProviderHistoryCursor;
}

type GrokSessionsListOptions = Omit<SessionsListOptions, "providerCursor">;
type GrokSessionsListMessage = Extract<HostMsg, { type: "sessions" }>;

// History pagination: rows fetched per "page" (initial open + each load-more / search page).
const SESSION_PAGE_SIZE = 100;

/** Rows a `listRepoSessions` preview returns when the client names no limit —
 *  the projects rail shows a few per repo and links out for the rest. */
const REPO_PREVIEW_SIZE = 3;

/** How long a cancelled turn may go unanswered before the host settles it
 *  itself. Generous: an honoured cancel comes back well inside a second, so this
 *  only ever fires when the turn was going to wedge anyway. */
const CANCEL_SETTLE_GRACE_MS = 10_000;

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
 * so the diff tab closes without a save prompt. Host-registered via
 * {@link Host.registerTextDocumentContentProvider}.
 */
class GrokDiffContentProvider implements HostTextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  provideTextDocumentContent(uri: Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
  set(uri: Uri, content: string): void {
    this.contents.set(uri.toString(), content);
  }
  delete(...uris: Uri[]): void {
    for (const uri of uris) this.contents.delete(uri.toString());
  }
}

/**
 * What a path is, without throwing. Distinguishing "file" from "dir" is the
 * point: pointing grok.ffmpegPath at a directory fails with EACCES rather than
 * ENOENT, which reads as a permissions problem and is not one.
 */
function statKindSafe(p: string): "file" | "dir" | "none" {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "none";
  } catch {
    return "none";
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

export class GrokSidebar {
  public static readonly viewId = "grok.chat";
  /** Primary side bar projects rail — separate webview, not a second chat client. */
  public static readonly projectsViewId = "grok.projects";
  private view?: HostWebviewView;
  /** Second local consumer of catalog-shaped host messages. Absent until resolved. */
  private projectsRail?: HostWebviewView;
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
  /** Adapter catalogs come from ACP session/list rather than Grok's disk index. */
  private codexSessionCache = new Map<string, SessionListEntry[]>();
  private codexSessionCacheAt = new Map<string, number>();
  private codexSessionRefresh = new Map<string, Promise<void>>();
  private claudeSessionCache = new Map<string, SessionListEntry[]>();
  private claudeSessionCacheAt = new Map<string, number>();
  private claudeSessionRefresh = new Map<string, Promise<void>>();
  private codexInstallAbort?: AbortController;
  private providerConnectionState: ProviderConnections = {};
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
  // The empty-session sweep only scans the newest N by mtime, keeping it bounded
  // on a large store.
  private static readonly SWEEP_SCAN_LIMIT = 300;
  // …and leaves recent ones alone entirely. Parking is what removes the empty
  // session you just walked away from; the sweep exists for the ones nothing was
  // there to park, and those are never minutes old. A session grok registered
  // recently may not have written its history yet, and — the case this is really
  // sized for — may be open in ANOTHER VS Code window, whose live processes this
  // one cannot see. That window's session would be empty (nothing else is ever
  // swept) and grok re-persists it on its next turn, so the cost is bounded; the
  // delay is what keeps it from being routine. Costs nothing in return: an orphan
  // is stamped when its window opened, so by the next activation it is already old.
  private static readonly SWEEP_MIN_AGE_MS = 30 * 60 * 1000;
  /** How often the sweep may actually walk, per repo. Well under
   *  SWEEP_MIN_AGE_MS, so a shell waits at most SWEEP_MIN_AGE_MS + this before
   *  it is collected — while the walk stops being something a click pays for. */
  private static readonly SWEEP_INTERVAL_MS = 10 * 60 * 1000;
  /** Last real sweep per repo, for SWEEP_INTERVAL_MS. */
  private readonly lastSweepAt = new Map<string, number>();
  /** A whole-list refresh is already queued for this tick. See postSessionsList. */
  private sessionsListScheduled = false;
  /** Providers whose device-login preflight advice has been shown this
   *  activation. Advice, not a gate - see startDeviceLogin. */
  private readonly deviceLoginPreflightShown = new Set<AcpProvider>();
  private reaper?: ReturnType<typeof setInterval>;
  private oauthShadowWarningShown = false;
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
  private editorWatcher?: HostDisposable;
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
  private configWatcher?: HostDisposable;
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
  /**
   * Per-Session start tail. Boot, client-ready, resume, and ensureClient all
   * share it with handleSend so a send cannot commit an echo while a start
   * is still replacing the process.
   */
  private sessionStartTails?: WeakMap<Session, Promise<void>>;
  private static readonly SESSION_LOAD_RESERVATION_TTL_MS = 10 * 60_000;
  private testSessionStartDelay?: {
    resumeId: string | undefined;
    started: () => void;
    wait: Promise<void>;
  };
  /**
   * Test-only latch. When set, Grok discovery stops after an explicit cached
   * path (provisionFakeGrok). Config and PATH are not searched, so a developer
   * box cannot silently pick up a real CLI. Production never sets this.
   */
  private testForceMissingGrokCli = false;
  /** First full boot pass — repo catalog AND the deferred session-list — finished. */
  private firstBootScanStarted = false;
  private firstBootScanCompleted = false;
  private resolveFirstBootScan: () => void = () => {};
  private firstBootScanDone = new Promise<void>((resolve) => {
    this.resolveFirstBootScan = resolve;
  });
  /** Test hook: parks the first boot pass after catalog, before session-list. */
  private testCatalogHold?: {
    started: () => void;
    wait: Promise<void>;
    release: () => void;
  };
  /** Stalled boot must not hang a resume; the miss then stands as a real refusal. */
  private static readonly FIRST_BOOT_SCAN_WAIT_MS = 8_000;
  // OS wake lock, held for exactly as long as the uplink is (linked device token
  // + live extension host) so an AFK machine can't idle-suspend out from under a
  // remote turn. `grok.remote.keepAwake` is the opt-out. See src/keep-awake.ts.
  private readonly keepAwake = new KeepAwake((l) => this.host.appendLine(l), process.platform, process.pid, os.release());
  private static readonly DEVICE_GLOBAL_REMOTE_TYPES = new Set<HostMsg["type"]>([
    "showThinking", "appPurpose", "fontScale", "grokUpdateStatus", "cliUpdating",
    "onboarding", "providerState", "mcpServers", "mcpConnectors", "expandCommandOutputs", "steerByDefault", "soundNotifications",
    "mcpConnectorAuthorization",
    // Device-global, not session-scoped: a phone reading conversation B asked
    // for the routines page and must get it, even though the desk is focused on
    // conversation A. Without this, `post` routes the answer through the
    // FOCUSED session and the requesting tab stays empty for ever.
    "routines",
    "telemetryEnabled",
    "thumbsFeedback",
    // Device-global for the same reason as routines: the counts and the retired
    // list describe the MACHINE, not the conversation a tab happens to be
    // reading, so routing them through the focused session would leave a
    // second tab's welcome screen permanently without advice.
    "welcomeTips",
    // Same reason: the Add project form is a property of the machine, and a
    // phone that opened it while the desk is focused elsewhere must still
    // get the answer to what it just asked for.
    "projectSetup",
    "githubState",
    "githubRepos",
  ]);
  private cliPath?: string;
  private codexCliPath?: string;
  private claudeCliPath?: string;
  private readonly providerCliVersions: Partial<Record<AcpProvider, string>> = {};
  /** Accounts that are configured but answered an auth-shaped failure. Not the
   *  same as disconnected: the CLI is installed and the user meant to use it,
   *  so the answer is a sign-in action, not hiding the agent. */
  private providerNeedsLogin: Partial<Record<AcpProvider, boolean>> = {};
  /** Last `providerState` refresh. `reportSessionStart` reads these flags; it
   *  never rediscovers CLIs on the first-send path. Null until the first
   *  refresh so an unsnapshotted send OMITS the flags instead of reporting a
   *  constructor default as a measurement. */
  private lastProviderConnected: { grok: boolean; codex: boolean; claude: boolean } | null = null;
  /** Last `postVoiceConfigured` result per normalized cwd. Same send-path
   *  rule: a cwd with no entry is unknown and the field is omitted, never
   *  coerced to false. Rebuilt on each refresh so removed keys cannot serve
   *  stale `true` forever. */
  private lastVoiceConfiguredByCwd = new Map<string, boolean>();
  /**
   * Last posted `voiceConfigured` fingerprint per destination (`local` or
   * `remote:<clientId>`). The auth.json watcher matches a null filename, so
   * every grok write under `~/.grok` used to fan identical frames to every
   * phone. Writers seed or invalidate: snapshot and credential-failure seed
   * so a skipped watcher post cannot starve a fresh tab or swallow a later
   * genuine change; a replaced renderer drops its entry (`forgetPostedVoiceConfigured`)
   * because the new JS state starts unconfigured.
   */
  private lastPostedVoiceConfigured = new Map<string, string>();
  /** VS Code settings tab. Desktop/remote keep the in-page overlay. */
  private settingsEditor?: HostEditorWebview;
  private static readonly SETTINGS_PANEL_TYPES = new Set<WebviewMsg["type"]>([
    "openSettingsSurface",
    "closeSettingsSurface",
    // The standalone VS Code Settings tab is a first-class surface for this
    // page — it loads settings.js and nothing else. Without these five it
    // posts `listRoutines`, gets "[settings] ignored", and shows an empty
    // Routines page with no projects, no models and no way to create one.
    "listRoutines",
    "saveRoutine",
    "deleteRoutine",
    "setRoutinePaused",
    "runRoutineNow",
    "setShowThinking",
    "setAppPurpose",
    "setExpandCommandOutputs",
    "setSteerByDefault",
    "setSoundNotifications",
    "setProcessingSound",
    "setReadRepliesAloud",
    "setSummarizeRepliesAloud",
    "setVoiceSendPhrase",
    "setVoiceKeyterms",
    "setTelemetryEnabled",
    "setThumbsFeedback",
    "openGlobalConfig",
    "openProjectConfig",
    "listMcpServers",
    "connectMcpConnector",
    "disconnectMcpConnector",
    "showLogs",
    "toggleDevTools",
    "openSettings",
    "openUrl",
    "moveView",
    "logout",
    "setupGithubCli",
    "githubSignOut",
    "githubLoginWithToken",
    "runGrokLogin",
    "refreshProviders",
    // Both halves of a terminal sign-in started FROM this page. Without them
    // the buttons were dead and said nothing: `recheckConnection` is what an
    // agent row's "Re-check connection" sends, and `cancelDeviceLogin` is what
    // either row's Cancel sends. GitHub's Re-check happened to work only
    // because it asks for `refreshProviders`, which was already listed — two
    // identical-looking buttons, one alive, and no way to tell from the page.
    "recheckConnection",
    "cancelDeviceLogin",
    "checkGrokUpdate",
    "updateGrok",
    "openRemotePortal",
    "remoteSignIn",
    "unlinkRemoteDevice",
  ]);
  private readonly loginReprobeTimers = new Map<AcpProvider, ReturnType<typeof setTimeout>>();
  /** Headless sign-ins in flight, one per provider, with the remote client that
   *  asked. Keyed by provider rather than by client because the CREDENTIAL is
   *  per-provider: two phones both connecting Grok want one flow and one code,
   *  not two codes racing to write the same file.
   *
   *  A reconnecting tab (new socket, same tab token, already showing a code) is
   *  adopted; an explicit Connect press starts over. See
   *  {@link shouldAdoptInFlightDeviceLogin}. */
  private readonly deviceLogins = new Map<
    AcpProvider,
    {
      handle: DeviceLoginHandle;
      clientId?: string;
      /** The TAB that started this, which outlives the socket that did: a phone
       *  reconnects on every trip to the vendor's code page, and `identify`
       *  re-points this token at the new client. */
      tabToken?: string;
      /** What the flow last told its client, so a re-tap — usually a client
       *  that RECONNECTED while visiting the vendor's code page — can be
       *  shown the same code instead of silence. */
      last?: Extract<HostMsg, { type: "onboarding" }>["device"];
      /** Sends to whichever client currently owns the flow. */
      send: (device: Extract<HostMsg, { type: "onboarding" }>["device"]) => void;
    }
  >();
  /**
   * Headless GitHub sign-in for the clone form / Settings. One at a time.
   * Same adopt-vs-restart rule as `deviceLogins`: a reconnecting tab is
   * adopted into the live flow; an explicit Connect press starts over.
   * Separate map because that one is keyed by agent provider.
   */
  private githubLoginGen = 0;
  private githubDeviceLogin?: {
    gen: number;
    handle?: DeviceLoginHandle;
    clientId?: string;
    tabToken?: string;
    last?: ProjectSetupGithub;
    source?: "clone" | "settings";
    send: (github: ProjectSetupGithub) => void;
  };
  /** Last `gh api user` snapshot. Refreshed after connect / sign-out. */
  private githubConnection?: GithubAuthState;
  /** A Settings → Providers refresh in flight. Reported on `providerState` so
   *  the button can say it is working, and guards re-entry: a second click (or
   *  the page's own open-refresh landing on top of a click) must not start a
   *  second round of CLI probes. */
  private providerRefreshInFlight = false;
  /** Complete Grok inventory from the last `_x.ai/mcp/list`. Unfiltered — `hostMcpServers` dedup still needs project servers. */
  private mcpServers: McpServerView[] = [];
  /**
   * Workspace the current `mcpServers` was read from. Classification uses this
   * at read time only; the stored global-only view is then rendered anywhere.
   */
  private mcpServersCwd: string | undefined;
  /**
   * Global-only tagged view of the last catalog read. Project-file rows were
   * filtered against `mcpServersCwd`; this is safe to render for any workspace.
   */
  private mcpServersView: McpServerView[] = [];
  private mcpListSupported: boolean | undefined;
  private grokMcpReserved: ReservedMcpIdentity = { names: [], urls: [] };
  private mcpConnectingId: ConnectorId | undefined;
  private mcpRemoteAuthorization: {
    id: ConnectorId;
    attemptId: string;
    status: "waiting" | "submitted";
    url?: string;
    complete?: (redirectUrl: string) => Promise<void>;
  } | undefined;
  private mcpConnectError: { id: ConnectorId; message: string } | undefined;
  /** In-memory PAT cache for key-auth connectors. Never written to PersistedState. */
  private readonly mcpConnectorKeys = new Map<string, string>();
  private readonly mcpConnectorKeysReady: Promise<void>;
  /** Overlapping Connectors reads share one lazy Grok start. */
  private grokSessionForMcpListInFlight: Promise<Session | undefined> | undefined;
  private grokVersionProbe?: Promise<string>;
  private codexVersionProbe?: Promise<string>;
  private claudeVersionProbe?: Promise<string>;
  /** History browsing scope. Deliberately independent of the live session cwd. */
  private selectedRepoCwd?: string;
  /**
   * Serializes local project-folder switches (desktop multi-folder). Renderer
   * `repoSwitchPending` is not a trust boundary — two concurrent `selectRepo`
   * messages must not interleave host-side openSession against a mutated
   * focused session (cross-repo bleed).
   */
  private readonly localWorkspaceSwitchQueue = new AsyncSerialQueue();
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
    new SessionRequestState<Session, { left: Uri; right: Uri }>();
  /**
   * In-flight in-chat confirms, keyed by request id — see confirmInChat.
   *
   * The SESSION is stored with the resolver because the id alone is not an
   * authorization: it is a sequential `confirm-N`, the map is host-global, and
   * `uiConfirmAnswer` stopped being host-local when Rewind was opened to
   * remotes. Without this, an answer sent while bound to conversation B
   * resolves conversation A's confirm — and the thing on the other side of
   * that confirm reverts files on disk.
   */
  private readonly pendingConfirms = new Map<string, { session: Session; resolve: (ok: boolean) => void }>();
  private confirmSeq = 0;

  /** Session names, pins, archives and the install id — held in `~/.grok` so a
   *  non-VS-Code client of this machine reads the same state. Everything else
   *  still lands in `globalState`; see persisted-state.ts. */
  private readonly state: PersistedState;

  /** Run records, and the exclusive-create claim that makes a due run happen
   *  exactly once across every host sharing this `~/.grok`. */
  private readonly routineRuns: RoutineRunStore;
  private routineTimer?: ReturnType<typeof setInterval>;
  /** Last wake time the relay accepted. `undefined` = never published, which is
   *  distinct from `null` = published "nothing scheduled". */
  private publishedWakeAt: number | null | undefined;
  /** Routines whose session is live right now, so a slow turn cannot be
   *  overlapped by the next tick even though its window is still current. */
  private readonly routinesInFlight = new Set<string>();
  private routineError?: { id?: string; message: string };

  constructor(
    private context: HostContext,
    /** Effectful host surface — VS Code supplies createVsCodeHost; a desktop app injects its own. */
    private readonly host: Host,
  ) {
    // Before anything can read it: the loss case is an empty read followed by a
    // write, so this must not be deferred to an async init.
    this.state = new PersistedState(
      context.globalState,
      path.join(resolveGrokHome(process.env), "client-state"),
      fs,
      (line) => this.host.appendLine(line),
    );
    this.providerConnectionState = this.migrateProviderConnections();
    this.focused.provider = this.defaultProviderForProject(this.workspaceRoot());
    this.remoteClients = new RemoteClientState<Session, RemoteBrowserPreferences>(
      this.workspaceRoot(),
      normalizeRepoPath,
    );
    context.subscriptions.push(
      this.host.registerTextDocumentContentProvider(GROK_DIFF_SCHEME, this.diffProvider),
    );
    // Apply the terminal-shell preference at construction, BEFORE any command
    // (e.g. grok.newSession) can spawn a session — otherwise the first
    // resolvedTerminalShell() (for GROK_SHELL in buildEnv) could cache the
    // default "auto" resolution and diverge from a configured `cmd` pref.
    this.applyTerminalShellPref();
    this.mcpConnectorKeysReady = this.loadMcpConnectorKeys();
    this.routineRuns = new RoutineRunStore({
      dir: `${path.join(resolveGrokHome(process.env), "client-state").replace(/\\/g, "/")}/routine-runs`,
      fs,
      log: (line) => this.host.appendLine(line),
    });
    void this.sweepImageStaging();
    void this.sweepFileStaging();
    this.startRoutineScheduler();
  }

  /* ------------------------------------------------------------ routines */

  /**
   * A record map keyed by id, NOT an array — twice over.
   *
   * `PersistedState.validValue` accepts a string or a record map and nothing
   * else, so an array is rejected on load AND on the globalState shadow read:
   * every routine would vanish on the next restart. And the write path is a
   * three-way `mergeRecord` against the disk snapshot, which is what lets two
   * hosts each add a routine without clobbering each other. An array would have
   * broken that too, silently, and only for people running two editors.
   */
  private loadRoutines(): Routine[] {
    const raw = this.state.get<Record<string, Routine>>(ROUTINES_KEY, {});
    return Object.values(raw || {})
      .filter((r) => r && typeof r.id === "string" && typeof r.cwd === "string")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private async saveRoutines(routines: readonly Routine[]): Promise<void> {
    const map: Record<string, Routine> = {};
    for (const routine of routines) map[routine.id] = routine;
    await this.state.update(ROUTINES_KEY, map);
  }

  /**
   * One tick for every routine.
   *
   * Deliberately NOT aligned to any particular boundary: the schedule lives in
   * the window key, so the tick only has to be finer than the smallest cadence
   * (15 minutes). A minute is comfortably that, and costs one `routineWindow`
   * call plus at most one `EEXIST` per routine.
   */
  private startRoutineScheduler(): void {
    // Sweep first: a record left `running` belonged to a host that died
    // mid-run, and must not sit in the strip pretending to be live.
    const now = Date.now();
    for (const routine of this.loadRoutines()) this.routineRuns.sweepInterrupted(routine.id, now);

    this.routineTimer = setInterval(() => void this.tickRoutines(), 60_000);
    // `unref` so a pending tick never holds the process open — the desktop app
    // quitting with all its windows is the normal end of a session, not
    // something to delay by up to a minute.
    this.routineTimer.unref?.();
  }

  private async tickRoutines(): Promise<void> {
    const now = Date.now();
    for (const routine of this.loadRoutines()) {
      if (routine.paused) continue;
      if (this.routinesInFlight.has(routine.id)) continue;
      const { key } = routineWindow(routine, now);
      if (!key) continue;
      // The claim IS the mutual exclusion. Losing it is the normal outcome for
      // every host that did not win, and for this host on every later tick
      // inside the same window.
      const claimed = this.routineRuns.claim(routine.id, key, {
        routineId: routine.id,
        windowKey: key,
        startedAt: now,
        outcome: "running",
      });
      if (!claimed) continue;
      await this.runRoutine(routine, key, now);
    }
  }

  /**
   * Fire one routine: open a background session in its project and send its
   * prompt. Never focuses — a routine that steals the desk while you are typing
   * is worse than one that does not run.
   */
  private async runRoutine(routine: Routine, windowKey: string, startedAt: number): Promise<void> {
    this.routinesInFlight.add(routine.id);
    const finish = (outcome: RoutineRun["outcome"], extra: Partial<RoutineRun> = {}): void => {
      this.routineRuns.finish({
        routineId: routine.id,
        windowKey,
        startedAt,
        endedAt: Date.now(),
        outcome,
        cwd: routine.cwd,
        ...extra,
      });
      this.routineRuns.prune(routine.id);
      this.routinesInFlight.delete(routine.id);
      this.postRoutines();
    };

    // The model gate, and the reason a skip is a first-class outcome rather
    // than a failure: "Claude was not connected at 06:00" is a fact about the
    // machine, and the strip should say so plainly.
    // Gate on the PROVIDER, never on an exact model.
    //
    // The model list is a picker concern and its contents move: a provider with
    // an empty cache contributes one "<Provider> default" row carrying an empty
    // modelId, and once discovery populates the cache it contributes concrete
    // models instead. Matching a saved routine against that list meant a
    // routine created on a fresh host ran ONCE — populating the cache as it went
    // — and then skipped every later firing, reporting "was not connected" about
    // a provider that was connected the whole time.
    //
    // What actually decides whether a run can happen is whether the provider is
    // usable. The model is a preference, applied below and harmless if it no
    // longer exists.
    //
    // A review asked for the exact gate back for CONCRETE models, so that a
    // routine pinned to a retired model skips rather than running on the
    // agent's default. Declined, deliberately, and this note exists so it is
    // not re-litigated every round. The two failure modes are not symmetric:
    // the exact gate skips FOREVER and blames a provider that is connected,
    // triggered by an ordinary cache refresh; the provider gate produces one
    // run on a slightly different model, triggered only when a vendor retires
    // a model the user pinned. Interactive sessions fall back the same way when
    // that happens, so this is the product behaving consistently rather than an
    // exception. A routine that quietly stops for months is the failure a user
    // actually notices, and only after it has cost them something.
    if (!this.usableProviders().includes(routine.provider)) {
      finish("skipped", { detail: `Skipped — ${providerDisplayName(routine.provider)} was not connected` });
      return;
    }
    if (!this.resolveLocalRepoTarget(routine.cwd)) {
      finish("skipped", { detail: "Skipped — the project is no longer available" });
      return;
    }

    try {
      const session = this.newLocalSession();
      this.pool.add(session);
      this.setSessionCwd(session, routine.cwd, this.workspaceRoot());
      session.provider = routine.provider;
      const client = await this.startSession(undefined, session);
      if (!client) {
        finish("failed", { detail: "Failed — the agent could not start" });
        return;
      }
      // Empty means "this agent's default" — the session already has it, and
      // asking to switch TO nothing is not a request the picker can serve.
      if (routine.model) await this.switchModel(routine.model, session, undefined, routine.provider);
      // Recorded BEFORE the turn: the session exists and is the run's result
      // even if the prompt errors, and a link to a half-finished conversation
      // beats a run with nothing to open.
      const sessionId = session.client?.sessionId;
      this.routineRuns.finish({
        routineId: routine.id,
        windowKey,
        startedAt,
        outcome: "running",
        cwd: routine.cwd,
        ...(sessionId ? { sessionId } : {}),
      });
      // Name it before the turn, not after. A run that errors or is interrupted
      // still leaves a session in the rail, and an untitled one is the hardest
      // to account for — "why is this here" is exactly the question the tag
      // answers.
      if (sessionId) {
        const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
        await this.state.update(SESSION_META_KEY, {
          ...overrides,
          [sessionId]: {
            ...(overrides[sessionId] ?? {}),
            customName: routineSessionName(routine.title),
          },
        });
        this.sessionCache.delete(sessionId);
        this.postSessionName(session);
      }
      this.postRepoCatalog();
      this.postSessionsList();
      this.postRoutines();

      await this.handleSend(routine.prompt, false, session, "local");
      // `handleSend` CATCHES a failed turn — it renders the error and resolves
      // normally — so awaiting it says nothing about whether the turn worked.
      // Reporting every one of those as a success would put a green tick on the
      // strip for a rate-limited run, which is precisely the lie this page
      // exists to prevent.
      const failed = session.status === "error";
      // Re-read rather than reusing the id captured above: a session that had
      // to restart mid-start carries a different id by now, and the run must
      // link to the conversation that actually holds the answer.
      finish(failed ? "failed" : "ran", {
        cwd: routine.cwd,
        ...(session.client?.sessionId ? { sessionId: session.client.sessionId } : {}),
        ...(failed ? { detail: "Failed — the turn ended in an error" } : {}),
      });
    } catch (e) {
      finish("failed", { detail: `Failed — ${(e as Error).message}` });
    }
  }

  /** Connected models, in the shape the Routines form needs. */
  private routineModelOptions(): RoutineModelOption[] {
    // `usableProviders`, not merely connected: a provider that cannot answer
    // must not be offerable, or a routine saves against a model that will skip
    // every time it fires.
    //
    // Ordered PROVIDER BY PROVIDER, each provider's "<X> default" row first and
    // its concrete models after. Emitting all the default rows and then all the
    // models put every provider in the list twice, and the client groups by
    // consecutive provider — so the picker showed six headings for three agents.
    //
    // The default row is always sent. Whether it is DISPLAYED is the client's
    // call: it is meaningless clutter beside real models (the composer does not
    // offer it either), but it must exist for a routine already saved with an
    // empty model, or editing one would silently re-point it.
    const cache = this.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const providers = this.usableProviders();
    const all = modelsForConnectedProviders(providers, cache);
    const out: RoutineModelOption[] = [];
    for (const provider of providers) {
      out.push({ provider, model: "", label: `${providerDisplayName(provider)} default` });
      for (const m of all) {
        if (m.provider !== provider || !m.modelId) continue;
        out.push({ provider, model: m.modelId, label: m.name || m.modelId });
      }
    }
    return out;
  }

  private routineProjectOptions(): RoutineProjectOption[] {
    // Archived projects stay in this list on purpose. Archiving hides a project
    // from the RAIL; a routine is not the rail, and one already scheduled
    // against an archived project must keep running. `resolveLocalRepoTarget`
    // does not filter on `archived` either, so the run path agrees.
    return this.localRepoCatalogEntries().map((entry) => ({
      cwd: entry.cwd,
      label: entry.label,
      defaultProvider: this.defaultProviderForProject(entry.cwd),
      ...(entry.archived ? { archived: true } : {}),
    }));
  }

  private buildRoutinesMessage(): Extract<HostMsg, { type: "routines" }> {
    const now = Date.now();
    const projects = this.routineProjectOptions();
    const byCwd = new Map(projects.map((p) => [normalizeRepoPath(p.cwd), p]));
    return {
      type: "routines",
      entries: this.loadRoutines().map((routine) =>
        toRoutineView(
          routine,
          this.routineRuns.list(routine.id),
          now,
          byCwd.get(normalizeRepoPath(routine.cwd)),
        ),
      ),
      projects,
      models: this.routineModelOptions(),
      ...(this.routineError
        ? { error: this.routineError.message, ...(this.routineError.id ? { errorId: this.routineError.id } : {}) }
        : {}),
    };
  }

  /** Remote routines omit projects outside the host's current trusted set. */
  private postRoutines(): void {
    const message = this.buildRoutinesMessage();
    this.postLocal(message);
    void this.settingsEditor?.webview.postMessage(message);
    this.broadcastRemoteDevice(
      routinesMessageForRemote(message, this.authorizedSessionCwds(), pathsEqual),
    );
    // The routine count is one of the two facts the empty-state tip pool cannot
    // observe for itself, and it just changed. Posted from here rather than
    // from each of the seven call sites above, so the two can never disagree.
    this.postWelcomeTips();
    // Same reasoning, one layer out: this is the single choke point where the
    // schedule can change, so it is the only honest place to tell the relay
    // when this machine next needs to be awake.
    void this.publishWakeAt();
  }

  /**
   * Tell the relay when this environment next needs to be awake.
   *
   * ONLY a cloud environment does this, and only ever a timestamp. A laptop
   * needs no such thing — it fires its own routines because somebody opened it
   * — and sending one from a desk machine would put a schedule in a database
   * that deliberately holds no payloads, for no benefit at all.
   *
   * `null` is a real and necessary value: a user who pauses or deletes their
   * last routine must clear the standing wake, or the machine keeps starting up
   * nightly for something that no longer exists.
   *
   * Best-effort by design. A relay that is unreachable, older than this
   * endpoint, or serving no environments answers 404 or nothing, and the
   * correct response is silence: routines still run when the machine is up, and
   * catch-up is arithmetic. A failure here delays a routine; it never loses
   * one, and it must never interrupt anybody.
   */
  private async publishWakeAt(): Promise<void> {
    if (!isCloudEnvironment()) return;
    // Through relayUrl(), like every other consumer: half the app on staging
    // and half on production fails in a way that looks like a relay bug.
    const base = httpBaseFromRelayUrl(this.relayUrl());
    const token = await this.readDeviceToken().catch(() => undefined);
    if (!base || !token) return;
    const wakeAt = nextWakeAt(this.loadRoutines(), Date.now());
    if (wakeAt === this.publishedWakeAt) return;
    try {
      const res = await fetch(`${base}/api/environment/wake-at`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ wakeAt }),
      });
      // Remembered only on success, so a transient failure is retried by the
      // next schedule change rather than being assumed delivered.
      if (res.ok) this.publishedWakeAt = wakeAt;
    } catch {
      /* the relay is unreachable; routines still run when this host is up */
    }
  }

  /**
   * Facts for the empty-state tip pool: the two counts the chat client never
   * receives on its own, plus the tips this machine is finished with.
   *
   * Counts, deliberately — not the routines or the connector list. A tip only
   * asks whether the number is zero, and the chat client has no other reason to
   * hold either list (only the settings surface requests them). Sending the
   * lists here would put routine prompts on the wire for a client that never
   * asked for them.
   */
  private welcomeTipsMessage(): Extract<HostMsg, { type: "welcomeTips" }> {
    return {
      type: "welcomeTips",
      routineCount: this.loadRoutines().length,
      connectorCount: Object.keys(this.connectedConnectorStore()).length,
      dismissed: parseDismissedTips(this.state.get(WELCOME_TIPS_KEY, {})),
      shownToday: shownOn(this.state.get(WELCOME_TIPS_SHOWN_KEY, {}), localDayKey(new Date())),
    };
  }

  private postWelcomeTips(): void {
    this.post(this.welcomeTipsMessage());
  }

  /**
   * May this connection point a routine at `cwd`?
   *
   * At the desk, any project in the catalog — archived included, because the
   * rail hiding a project is a view decision and a routine is not the rail.
   * From a remote, only the authorized set, which is the SAME set that decides
   * whether that tab could open the project's conversations at all. Creating a
   * routine is not the escalation; reaching a new project would be.
   */
  private mayTargetRoutineCwd(cwd: string, origin: MsgOrigin, clientId?: string): boolean {
    if (!cwd) return false;
    if (origin !== "remote") return !!this.resolveLocalRepoTarget(cwd);
    void clientId;
    return cwdIsAuthorized(cwd, this.authorizedSessionCwds(), pathsEqual);
  }

  private providerConnections(): ProviderConnections {
    return this.providerConnectionState;
  }

  /** Session-start snapshot of `grok.acp.*` timeouts (#117). */
  private acpClientTimeouts() {
    const cfg = this.host.getConfiguration("grok");
    return {
      promptIdleTimeoutMs: cfg.get<number>("acp.promptIdleTimeoutMs"),
      promptAbsoluteTimeoutMs: cfg.get<number>("acp.promptAbsoluteTimeoutMs"),
      requestTimeoutMs: cfg.get<number>("acp.requestTimeoutMs"),
    };
  }

  private locateProvider(provider: AcpProvider): string | undefined {
    if (provider === "grok") {
      if (this.cliPath && fs.existsSync(this.cliPath)) return this.cliPath;
      if (this.testForceMissingGrokCli) {
        this.cliPath = undefined;
        return undefined;
      }
      const located = locateGrokCli(this.host.getConfiguration("grok").get<string>("cliPath", "")) || undefined;
      this.cliPath = located;
      return located;
    }
    if (provider === "codex") {
      if (this.codexCliPath && fs.existsSync(this.codexCliPath)) return this.codexCliPath;
      const located = locateCodexCli({
        configuredPath: this.host.getConfiguration("grok").get<string>("codexCliPath", ""),
        managedStorageRoot: this.context.globalStorageUri.fsPath,
        arch: process.arch,
      });
      this.codexCliPath = located;
      return located;
    }
    if (this.claudeCliPath && fs.existsSync(this.claudeCliPath)) return this.claudeCliPath;
    const located = locateClaudeCli({
      configuredPath: this.host.getConfiguration("grok").get<string>("claudeCliPath", ""),
    });
    this.claudeCliPath = located;
    return located;
  }

  private locatedProviders(): Partial<Record<AcpProvider, boolean>> {
    return {
      grok: !!this.locateProvider("grok"),
      codex: !!this.locateProvider("codex"),
      claude: !!this.locateProvider("claude"),
    };
  }

  private adapterHistory(provider: AcpProvider): {
    cache: Map<string, SessionListEntry[]>;
    at: Map<string, number>;
    refresh: Map<string, Promise<void>>;
  } | undefined {
    if (provider === "codex") {
      return { cache: this.codexSessionCache, at: this.codexSessionCacheAt, refresh: this.codexSessionRefresh };
    }
    if (provider === "claude") {
      return { cache: this.claudeSessionCache, at: this.claudeSessionCacheAt, refresh: this.claudeSessionRefresh };
    }
    return undefined;
  }

  private allAdapterCatalogs(): Iterable<readonly SessionListEntry[]> {
    return [...this.codexSessionCache.values(), ...this.claudeSessionCache.values()];
  }

  private createProviderBackend(provider: AcpProvider): CodexBackend | ClaudeBackend | undefined {
    if (provider === "codex") return new CodexBackend();
    if (provider === "claude") return new ClaudeBackend();
    return undefined;
  }

  private connectedProviders(): AcpProvider[] {
    return connectedProviderIds(this.providerConnections(), this.locatedProviders());
  }

  /** Connected AND able to answer — see usableProviderIds. Use this to decide who
   *  runs a turn or which onboarding to show; use connectedProviders() to decide
   *  what to say ABOUT a provider, which still wants the lapsed ones. */
  private usableProviders(): AcpProvider[] {
    return usableProviderIds(this.providerConnections(), this.locatedProviders(), this.providerNeedsLogin ?? {});
  }

  /**
   * The onboarding panel a session should show when it cannot run.
   *
   * With nothing CONNECTED, offer the choice of all three rather than one
   * provider's sign-in instructions: a session can carry a stale `provider`
   * inherited from a project default, and telling someone who has connected
   * nothing to "Complete codex login" names an agent they may never have picked.
   *
   * A conversation WITH history is different, and never gets the chooser: its
   * provider is pinned after the first turn, so there is nothing to choose. If
   * that agent's credentials die mid-session, its own sign-in is the only
   * correct panel — offering three would trade an answer for a question about
   * something the session cannot change anyway.
   *
   * Otherwise it depends on whether anything can answer. With NONE available,
   * the provider on an empty session is only a guess — a project default, or
   * whatever was used last — so naming one agent's sign-in presents a decision
   * as though it had already been made; offer all three and ask honestly. With
   * something available the session's own provider is the specific gap to
   * close, so show that.
   */
  private onboardingForSession(session: Session): "connect-agent" | "auth-required" | "codex-login" | "claude-login" {
    if (session.hasHistory) return providerLoginState(session.provider);
    return this.usableProviders().length ? providerLoginState(session.provider) : "connect-agent";
  }

  private migrateProviderConnections(): ProviderConnections {
    const existing = this.state.get<ProviderConnections>(PROVIDER_CONNECTIONS_KEY);
    if (existing !== undefined) return existing;
    const home = resolveGrokHome(process.env);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const configured = !!this.host.getConfiguration("grok").get<string>("cliPath", "").trim();
    const usedBefore = configured || Object.keys(overrides).length > 0 || [
      path.join(home, "auth.json"),
      path.join(home, "config.toml"),
      path.join(home, "sessions"),
    ].some((candidate) => fs.existsSync(candidate));
    const migrated: ProviderConnections = {
      grok: usedBefore && !!this.locateProvider("grok"),
      codex: false,
      claude: false,
    };
    void this.state.update(PROVIDER_CONNECTIONS_KEY, migrated);
    return migrated;
  }

  private setProviderConnectedInMemory(provider: AcpProvider, connected: boolean): void {
    const current = this.providerConnections();
    this.providerConnectionState = { ...current, [provider]: connected };
    if (!connected && isAdapterProvider(provider)) {
      const history = this.adapterHistory(provider);
      history?.cache.clear();
      // A reconnect must re-list immediately. Keeping the old freshness stamp
      // after dropping the rows creates a fresh-but-empty cache for ten seconds.
      history?.at.clear();
    }
    this.postProviderState();
    if (connected) void this.probeProviderVersion(provider);
  }

  private async persistProviderConnections(): Promise<void> {
    await this.state.update(PROVIDER_CONNECTIONS_KEY, this.providerConnectionState);
  }

  private async setProviderConnected(provider: AcpProvider, connected: boolean): Promise<void> {
    this.setProviderConnectedInMemory(provider, connected);
    await this.persistProviderConnections();
  }

  /**
   * An agent that is installed and configured but will not authenticate.
   *
   * Disconnecting it would be the wrong hammer — that hides every conversation
   * it owns and tears down live sessions for a fault one sign-in fixes. This is
   * a view-only flag: the account still counts as connected, and every surface
   * that would otherwise degrade silently (a bare "<Agent> default" row in the
   * model picker, a history list that just comes back empty) shows the same
   * sign-in action the connect flow uses.
   *
   * Only the provider's credential classifier may raise it: adapter probes use
   * that backend's `isCredentialError`, while Grok uses `isCredentialError`.
   * The billing/entitlement family must never route to a login screen (#58).
   */
  private setProviderNeedsLogin(provider: AcpProvider, needsLogin: boolean): void {
    const current = this.providerNeedsLogin ?? {};
    if (!!current[provider] === needsLogin) return;
    this.providerNeedsLogin = { ...current, [provider]: needsLogin };
    // A recovered account must be able to re-list at once; the freshness stamp
    // would otherwise hold the empty catalog for its full back-off window.
    if (!needsLogin && isAdapterProvider(provider)) this.adapterHistory(provider)?.at.clear();
    this.postProviderState();
  }

  private async warmConnectedCodexModels(): Promise<boolean> {
    const cliPath = this.locateProvider("codex");
    if (!cliPath) return false;
    try {
      await warmCodexModelCache({
        cliPath,
        onModels: (models, currentModelId) => this.cacheProviderModels("codex", models, currentModelId),
        log: (message) => this.host.appendLine(message),
        // Codex answered "Internal error" for a session in a bare temp dir on
        // Windows, so the cache never filled and a freshly connected Codex was
        // missing from the picker until a real session created one. The
        // workspace is the cwd a real session uses, so it is known to work.
        fallbackCwd: this.workspaceRoot() || undefined,
      });
      this.setProviderNeedsLogin("codex", false);
      return true;
    } catch (error) {
      this.host.appendLine(`[codex] model-cache warm-up failed: ${(error as Error).message}`);
      // The warm-up is the first thing that talks to the agent after a connect,
      // so its failure is the earliest honest answer about the credentials —
      // but only when the failure IS about credentials.
      if (isCodexCredentialError(error)) {
        this.setProviderNeedsLogin("codex", true);
      } else {
        // Anything else says nothing about the sign-in, and leaving a stale
        // needs-login standing made Codex permanently unusable: it never
        // cleared, so it stayed out of the model picker and out of the
        // "connected" confirmation, no matter how many times the user signed
        // in. Observed as `Internal error` from session/new, which is not a
        // credential failure at all.
        this.setProviderNeedsLogin("codex", false);
      }
      return false;
    }
  }

  private async warmConnectedClaudeModels(): Promise<boolean> {
    const cliPath = this.locateProvider("claude");
    if (!cliPath) return false;
    try {
      await warmClaudeModelCache({
        cliPath,
        onModels: (models, currentModelId) => this.cacheProviderModels("claude", models, currentModelId),
        log: (message) => this.host.appendLine(message),
        // Same refusal Codex saw: `session/new` answering "Internal error" for
        // a session in a bare temp directory on Windows, so the cache never
        // filled and Claude never appeared connected (#146). The workspace is
        // the cwd a real session uses, so it is known to work.
        fallbackCwd: this.workspaceRoot() || undefined,
      });
      this.setProviderNeedsLogin("claude", false);
      return true;
    } catch (error) {
      this.host.appendLine(`[claude] model-cache warm-up failed: ${(error as Error).message}`);
      if (isClaudeCredentialError(error)) {
        this.setProviderNeedsLogin("claude", true);
      } else {
        // Anything else says nothing about the sign-in, and a stale needs-login
        // left standing made Codex permanently unusable in exactly this way: it
        // never cleared, so the account stayed out of the model picker and out
        // of the "connected" confirmation however many times the user signed
        // in. Claude had no such branch until #146.
        this.setProviderNeedsLogin("claude", false);
      }
      return false;
    }
  }

  /** Explicit credential observation. Unlike history refresh this never obeys
   * the listing freshness clock, so a completed sign-in is visible at once. */
  private async reprobeProviderCredentials(provider: AcpProvider): Promise<boolean> {
    if (provider === "codex") return this.warmConnectedCodexModels();
    if (provider === "claude") return this.warmConnectedClaudeModels();
    const cliPath = this.locateProvider("grok");
    if (!cliPath) return false;
    // session/new is what actually proves the account, but grok has no ACP
    // session/delete (AcpClient.deleteSession always throws for this provider).
    // A leftover lands in ~/.grok/sessions/<urlencoded-cwd>/ as a summary-only
    // directory the catalog lists as "Untitled" and the CLI cannot load.
    // Probe in a scratch cwd so a failed cleanup cannot appear in the user's
    // project; still delete the dir after the process exits.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cred-probe-"));
    const envCwd = this.workspaceRoot() || scratch;
    const client = new AcpClient({
      cliPath,
      cwd: scratch,
      env: this.buildEnv(envCwd),
      log: (message) => this.host.appendLine(message),
      grokVersion: this.providerCliVersions.grok,
    });
    try {
      await client.start();
      await client.newSession();
      this.setProviderNeedsLogin("grok", false);
      return true;
    } catch (error) {
      this.host.appendLine(`[grok] credential re-probe failed: ${errorDetail(error)}`);
      if (client.isCredentialError(error) || isCredentialError(error)) {
        this.setProviderNeedsLogin("grok", true);
      }
      return false;
    } finally {
      const probeId = client.sessionId;
      await client.dispose();
      if (probeId) this.removeSessionFromDisk(probeId, scratch);
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* leftover temp dir is harmless */ }
    }
  }

  /**
   * The remote half of connecting an agent: run the CLI's headless sign-in and
   * report the URL and code it prints.
   *
   * Sends only to the client that asked. A code is for the person holding that
   * device, and broadcasting it to a desk webview nobody is sitting at would be
   * both useless and, for something that is briefly a bearer credential, worse
   * than useless.
   *
   * The panel is posted BEFORE the flow starts. `starting` is a real state with
   * a real duration — a cold CLI takes a second or two to say anything — and
   * without it a phone shows nothing at all between the tap and the code, which
   * reads as a button that did not work.
   */
  private async startDeviceLogin(
    provider: AcpProvider,
    cliPath: string,
    clientId?: string,
  ): Promise<void> {
    const displayName = providerDisplayName(provider);
    // The entry is created before the runner so `send` reads the CURRENT
    // client off it: a phone that visits the vendor's code page and comes
    // back has reconnected under a fresh clientId, and the re-tap path below
    // re-binds this entry to it.
    const entry: {
      handle?: DeviceLoginHandle;
      clientId?: string;
      tabToken?: string;
      last?: Extract<HostMsg, { type: "onboarding" }>["device"];
      preflight?: Extract<HostMsg, { type: "onboarding" }>["device"] extends infer D
        ? D extends { preflight?: infer P } ? P : never
        : never;
      note?: string;
      send: (device: Extract<HostMsg, { type: "onboarding" }>["device"]) => void;
    } = {
      clientId,
      tabToken: clientId ? this.remoteClients.tabToken(clientId) : undefined,
      send: (device) => {
        // The setting-to-check travels with every card of this flow, so it is
        // still on screen when the code is.
        if (device && entry.preflight && !device.preflight) {
          device = { ...device, preflight: entry.preflight };
        }
        if (device && entry.note && device.status === "waiting" && !device.note) {
          device = { ...device, note: entry.note };
        }
        entry.last = device;
        const message: HostMsg = {
          type: "onboarding",
          state: providerLoginState(provider),
          platform: process.platform,
          provider,
          launched: true,
          device,
        };
        if (entry.clientId) this.sendRemoteClient(entry.clientId, message);
        else this.post(message);
      },
    };
    const send = entry.send;

    const isCloud = isCloudEnvironment();
    const unavailable = deviceLoginUnavailable(provider, { isCloud });
    const plan = deviceLoginPlan(provider);
    // Before anything is spawned. A person who reads this fixes a setting in
    // fifteen seconds; a person who reads the failure afterwards has already
    // waited for it.
    // ONCE, then get out of the way.
    //
    // This used to return unconditionally, which made the flow impossible to
    // finish: the panel's own "I've turned it on - connect" button posts
    // `runGrokLogin` again, landed here again, and re-rendered the identical
    // card. The button could never do anything, and to the person clicking it
    // nothing happened at all (owner, on a cloud environment).
    //
    // The advice is still worth showing before the first attempt - it saves a
    // wait for a failure almost everyone gets. It is advice, though, not a gate,
    // so the second attempt runs. If the setting is still off, the real failure
    // is classified and says so (classifyDeviceLoginFailure).
    // Advice that RIDES ALONG with the flow rather than replacing it. It used
    // to be sent on its own and return, so connecting Codex took two clicks:
    // one to read the advice, another to actually start (owner, 2026-08-31).
    // Now the first click starts the sign-in and the card carries the setting
    // to check, which is the only ordering where the advice arrives in time to
    // be useful — the code is worthless until that setting is on.
    // Step 1 of 2, and it is a GATE on purpose. The code is worthless until
    // the account setting is on, and a person who has just been handed a code
    // does not go and read a settings page first. It shows once per provider
    // per session; the button posts `runGrokLogin` again and lands past here.
    const preflight = deviceLoginPreflight(provider, { isCloud });
    if (preflight && !this.deviceLoginPreflightShown.has(provider)) {
      this.deviceLoginPreflightShown.add(provider);
      send({
        status: "unavailable",
        message: preflight.reason,
        preflight: { ...preflight, steps: [...preflight.steps] },
      });
      return;
    }
    // Step 2 keeps the setting visible next to the code it gates, and adds the
    // heads-up about the vendor's own security warning.
    entry.preflight = preflight ? { ...preflight, steps: [...preflight.steps] } : undefined;
    entry.note = deviceLoginCodeNote(provider);
    if (unavailable || !plan) {
      // Not an error, and it must not read as one: the agent can still be
      // connected, just not from here. Saying which is the difference between
      // a dead end and a next step.
      send({
        status: "unavailable",
        message: unavailable ?? noRemoteSignInMessage(displayName, { isCloud }),
      });
      return;
    }

    // One flow per provider. A second tap while the first is polling would
    // spawn a second child racing the first to write the same credential file,
    // and would replace a code the user may already be typing.
    //
    // A reconnecting phone (new socket, same tab, already has a code) is
    // adopted so the card comes back. An explicit Connect press — including a
    // tap while the flow is still on `starting` — starts over: repeating a
    // wedged starting card is how clone-form GitHub sat for 899s.
    const running = this.deviceLogins.get(provider);
    if (running) {
      if (this.shouldAdoptInFlightDeviceLogin(running, clientId)) {
        running.clientId = clientId;
        if (clientId) running.tabToken = this.remoteClients.tabToken(clientId) ?? running.tabToken;
        if (running.last) running.send(running.last);
        this.host.appendLine(`[${provider}] device login already in flight; repeated its state to the new tap`);
        return;
      }
      this.deviceLogins.delete(provider);
      try { running.handle.cancel(); } catch { /* already gone */ }
      this.host.appendLine(`[${provider}] device login restarted by an explicit press`);
    }

    send({ status: "starting" });
    this.host.appendLine(`[${provider}] device login started`);
    // Before the CLI is even spawned: the window that kills these flows opens
    // immediately, while the person is walking to the vendor's page. Held until
    // the credential is verified, not merely until the CLI exits.
    const workId = this.beginDeviceLoginWork();
    const startedAt = Date.now();
    // Set once onDone has run, which can happen SYNCHRONOUSLY on a spawn
    // failure — and registering the entry after that would park a settled
    // flow in the map forever, silently blocking every later attempt.
    let settled = false;
    let handle: DeviceLoginHandle | undefined;
    handle = runDeviceLogin(cliPath, plan.args, {
      onPrompt: (prompt) => {
        send({
          status: "waiting",
          url: prompt.url,
          code: prompt.code,
          ...(prompt.needsCode ? { needsCode: true } : {}),
        });
      },
      onDone: (result) => {
        settled = true;
        if (this.deviceLogins.get(provider)?.handle === handle) {
          this.deviceLogins.delete(provider);
        }
        // The hold is NOT released here on success: confirmDeviceLogin is still
        // to come, it probes the CLI, and a machine paused underneath that is
        // the same failure one step later. Its `finally` is the single exit.
        // Cancellation arrives here too (runDeviceLogin settles `cancelled`),
        // so this covers the cancel path without the handler knowing the token.
        if (!result.ok) this.endDeviceLoginWork(workId);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (!result.ok && "cancelled" in result) {
          // Every settle leaves a line. The first real cloud test needed
          // shell access to the machine to learn a flow had ended at all.
          this.host.appendLine(`[${provider}] device login cancelled after ${elapsed}s`);
          return;
        }
        if (result.ok) {
          // The CLI exiting 0 says the vendor approved the code. It does NOT
          // say a credential landed: codex 0.147 exited 0 on a flow that wrote
          // no auth.json, and announcing "done" here told the user Connected
          // while Settings said disconnected. Verify first, announce after.
          // The card is still on "waiting", whose own copy promises the flow
          // finishes on its own.
          this.host.appendLine(`[${provider}] device login approved by the vendor after ${elapsed}s; verifying the credential`);
          // The page must change when the vendor approves — "nothing happened"
          // during a silent 30s probe was the owner's very first retest note.
          send({ status: "verifying" });
          void this.confirmDeviceLogin(provider, send, displayName, workId,
            () => ({ clientId: entry.clientId, tabToken: entry.tabToken }));
          return;
        }
        this.host.appendLine(`[${provider}] device login failed (${result.failure}) after ${elapsed}s: ${result.output.slice(-2000)}`);
        send({
          status: "failed",
          message: deviceLoginFailureText(provider, result.failure, displayName),
        });
      },
    }, undefined, undefined, { needsCode: !!plan.needsCode });
    if (!settled) {
      if (handle) {
        entry.handle = handle;
        this.deviceLogins.set(provider, entry as typeof entry & { handle: DeviceLoginHandle });
      }
    }
  }

  /**
   * Reconnecting tab vs an explicit Connect press.
   *
   * A phone that left for the vendor's page comes back under a new client id
   * with the same tab token. That tap is the same attempt, so adopt it and
   * repeat the code — but only once there IS a code. Repeating `starting`
   * is how a wedged flow sat on "Asking the CLI for a sign-in code" for the
   * full device-code window.
   *
   * Any other tap (same socket, no code yet, a different tab) starts over.
   */
  private shouldAdoptInFlightDeviceLogin(
    running: { clientId?: string; tabToken?: string; last?: { status?: string; url?: string } } | undefined,
    clientId?: string,
  ): boolean {
    if (!running || !clientId) return false;
    const incomingTab = this.remoteClients.tabToken(clientId);
    const sameTab = !!(incomingTab && running.tabToken && incomingTab === running.tabToken);
    const sameClient = running.clientId === clientId;
    const last = running.last;
    const hasPrompt = !!(last && last.status === "waiting" && typeof last.url === "string" && last.url);
    return hasPrompt && sameTab && !sameClient;
  }

  /**
   * Announce a device login only once the credential is USABLE on this host.
   *
   * Bounded retries, because vendors write the file a beat after the CLI
   * exits; a verdict either way, because "Connected" with no credential and
   * silence were the two halves of the first real cloud test's worst bug.
   * Runs detached from the flow entry — by the time this fails, offering the
   * user a fresh attempt must not be blocked by the old one.
   */
  /**
   * The tab that started a device login, wherever its socket is now.
   *
   * Resolved through the tab token, because a phone reconnects on every trip to
   * the vendor's code page and the starting client id is usually gone by the
   * time this is asked. Falls back to the focused session rather than throwing:
   * `remoteClients.cwd()` refuses an unknown client, and a sign-in that has
   * already succeeded must not end in an exception.
   */
  private deviceLoginSession(clientId?: string, tabToken?: string): Session {
    const live = tabToken ? this.remoteClients.clientForTabToken(tabToken) : undefined;
    const id = live ?? clientId;
    if (!id || this.remoteClients.cwdIfPresent(id) === undefined) return this.focused;
    return this.remoteSessionFor(id);
  }

  private async confirmDeviceLogin(
    provider: AcpProvider,
    send: (device: Extract<HostMsg, { type: "onboarding" }>["device"]) => void,
    displayName: string,
    workId: number,
    currentClient: () => { clientId?: string; tabToken?: string },
  ): Promise<void> {
    try {
      await this.confirmDeviceLoginInner(provider, send, displayName, currentClient);
    } finally {
      // One door out, whatever happened above — and only this operation's.
      this.endDeviceLoginWork(workId);
    }
  }

  private async confirmDeviceLoginInner(
    provider: AcpProvider,
    send: (device: Extract<HostMsg, { type: "onboarding" }>["device"]) => void,
    displayName: string,
    currentClient: () => { clientId?: string; tabToken?: string } = () => ({}),
  ): Promise<void> {
    const delays = [0, 2_000, 5_000, 10_000, 20_000];
    for (const delay of delays) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (provider === "claude"
        ? await this.deviceLoginCredentialReady(provider)
        : await this.reprobeProviderCredentials(provider)) {
        this.host.appendLine(`[${provider}] device login: credential verified`);
        // Promote on evidence, exactly as the Providers refresh does. The probe
        // just proved the account works; without this the persisted `connected`
        // flag stays false, so Settings keeps offering Connect and never offers
        // Sign out for an account that is plainly signed in (owner, 2026-08-31).
        await this.setProviderConnected(provider, true);
        send({ status: "done" });
        // The same follow-through Settings' "Check again" runs. Promoting the
        // account is not the job — putting an agent on the screen that just
        // signed in is, and until this call the tab kept an empty model picker
        // and a card still offering to connect until it was reloaded (owner, on
        // a fresh cloud machine, 2026-08-31).
        try {
          const flow = currentClient();
          await this.adoptSessionsForConnectedProvider(
            provider,
            this.deviceLoginSession(flow.clientId, flow.tabToken),
          );
        } catch (error) {
          // The sign-in itself SUCCEEDED and has already been announced. A
          // failure to start the session afterwards is a worse screen, not a
          // worse account — and this runs under `void` on a machine with
          // nobody at it, where an unhandled rejection is the only trace.
          this.host.appendLine(`[${provider}] connected, but starting the session failed: ${errorDetail(error)}`);
        }
        return;
      }
    }
    // Two very different failures share this exit, and the message must not
    // blame the credential when the credential is fine: the first real cloud
    // test's sign-in was valid the whole time — the PROBE was failing (a
    // session/delete quirk) while the verdict said "no usable credential".
    if (this.providerCredentialFilePresent(provider)) {
      this.host.appendLine(`[${provider}] device login: credential present but the probe never passed`);
      send({
        status: "failed",
        message: `${displayName} is signed in, but the agent did not answer this machine's check yet. Try again in a moment — the sign-in itself does not need repeating.`,
      });
      return;
    }
    this.host.appendLine(`[${provider}] device login: vendor approved, but no usable credential landed on this machine`);
    send({
      status: "failed",
      message: `${displayName} approved the sign-in, but no usable credential landed on this machine. Try connecting again.`,
    });
  }

  /**
   * Whether this host can treat the sign-in as landed.
   *
   * Grok and Codex still go through the ACP probe. Claude's file is in the
   * keychain (or `~/.claude/`), so presence-of-auth.json cannot speak for it —
   * `claude auth status` `{ loggedIn: true }` is the authority. An unreadable
   * status falls back to the ACP probe rather than failing closed on a CLI
   * that printed something we have not seen.
   */
  private async deviceLoginCredentialReady(provider: AcpProvider): Promise<boolean> {
    if (provider === "claude") {
      const cliPath = this.locateProvider("claude");
      if (!cliPath) return false;
      const loggedIn = await probeClaudeAuthStatus(cliPath);
      if (loggedIn === true) return true;
      if (loggedIn === false) return false;
      return this.reprobeProviderCredentials(provider);
    }
    return this.reprobeProviderCredentials(provider);
  }

  /** Does the provider's own credential file exist? Deliberately shallow —
   *  presence only, no validity claim: it separates "sign-in never landed"
   *  from "landed, but our probe is unhappy", which lead a person to
   *  different next actions. */
  private providerCredentialFilePresent(provider: AcpProvider): boolean {
    try {
      if (provider === "codex") return fs.existsSync(path.join(resolveCodexHome(), "auth.json"));
      // GROK_HOME, not a hardcoded ~/.grok: the CLI honours it and so does the
      // rest of this host, so hardcoding made the fallback miss a credential
      // that was plainly there and tell the user to sign in again (review).
      if (provider === "grok") return fs.existsSync(path.join(resolveGrokHome(process.env), "auth.json"));
      return false;
    } catch {
      return false;
    }
  }

  /** Stop every headless sign-in. Called on dispose so a child polling a device
   *  endpoint does not outlive the window that started it. */
  private cancelAllDeviceLogins(): void {
    for (const { handle } of this.deviceLogins.values()) handle.cancel();
    this.deviceLogins.clear();
    this.githubDeviceLogin?.handle?.cancel();
    this.githubDeviceLogin = undefined;
  }

  /** Observe an interactive terminal login without requiring a reload. Terminal
   * APIs do not expose CLI completion portably, so retry on a short bounded
   * cadence and stop at the first authenticated probe. */
  private watchProviderLogin(provider: AcpProvider): void {
    const previous = this.loginReprobeTimers.get(provider);
    if (previous) clearTimeout(previous);
    const delays = [0, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000];
    const attempt = async (index: number): Promise<void> => {
      this.loginReprobeTimers.delete(provider);
      if (await this.reprobeProviderCredentials(provider)) return;
      const delay = delays[index + 1];
      if (delay === undefined) return;
      const timer = setTimeout(() => void attempt(index + 1), delay);
      this.loginReprobeTimers.set(provider, timer);
    };
    void attempt(0);
  }

  private async installManagedCodexCli(): Promise<void> {
    if (this.codexInstallAbort) return;
    const alreadyLocated = this.locateProvider("codex");
    if (alreadyLocated) {
      this.postLocal({ type: "onboarding", state: "codex-login", platform: process.platform });
      return;
    }

    const controller = new AbortController();
    this.codexInstallAbort = controller;
    try {
      const binary = await installManagedCodex({
        storageRoot: this.context.globalStorageUri.fsPath,
        signal: controller.signal,
        onProgress: (phase, value) => this.postLocal({
          type: "codexInstallProgress",
          phase,
          receivedBytes: value?.receivedBytes,
          totalBytes: value?.totalBytes,
        }),
      });
      this.codexCliPath = binary;
      this.postProviderState();
      this.postLocal({ type: "codexInstallProgress", phase: "idle" });
      this.postLocal({ type: "onboarding", state: "codex-login", platform: process.platform });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const reason = cancelled
        ? "Codex installation was cancelled."
        : `Codex installation failed: ${errorDetail(error)}`;
      this.host.appendLine(`[codex] managed install failed: ${reason}`);
      this.postLocal({ type: "codexInstallProgress", phase: "idle", reason });
      this.postLocal({ type: "onboarding", state: "missing-codex", platform: process.platform, reason, provider: "codex" });
    } finally {
      if (this.codexInstallAbort === controller) this.codexInstallAbort = undefined;
    }
  }

  private providerStateMessage(): Extract<HostMsg, { type: "providerState" }> {
    const connected = this.providerConnections();
    const located = this.locatedProviders();
    const versions = this.providerCliVersions ?? {};
    const needsLogin = this.providerNeedsLogin ?? {};
    const grokConnected = connected.grok === true && located.grok === true;
    const codexConnected = connected.codex === true && located.codex === true;
    const claudeConnected = connected.claude === true && located.claude === true;
    this.lastProviderConnected = { grok: grokConnected, codex: codexConnected, claude: claudeConnected };
    return {
      type: "providerState",
      providers: [
        {
          id: "grok",
          connected: grokConnected,
          ...(grokConnected && versions.grok ? { cliVersion: versions.grok } : {}),
          ...(grokConnected && needsLogin.grok ? { needsLogin: true } : {}),
        },
        {
          id: "codex",
          connected: codexConnected,
          ...(codexConnected && needsLogin.codex ? { needsLogin: true } : {}),
          ...(codexConnected && versions.codex ? { cliVersion: versions.codex } : {}),
          ...(codexConnected ? {
            adapterVersion: CODEX_ACP_ADAPTER_VERSION,
            latestCliVersion: CODEX_MANAGED_VERSION,
            ...(versions.codex ? { updateAvailable: versionIsOlder(versions.codex, CODEX_MANAGED_VERSION) } : {}),
          } : {}),
        },
        {
          id: "claude",
          connected: claudeConnected,
          ...(claudeConnected && needsLogin.claude ? { needsLogin: true } : {}),
          ...(claudeConnected && versions.claude ? { cliVersion: versions.claude } : {}),
          ...(claudeConnected ? { adapterVersion: CLAUDE_ACP_ADAPTER_VERSION } : {}),
        },
      ],
      ...(this.providerRefreshInFlight ? { checking: true } : {}),
    };
  }

  /** Chat, the projects rail, remotes — and the VS Code settings tab, which
   *  reads `providerState` but sits outside `post()`. Without this line that
   *  tab's Providers page only ever showed the snapshot it booted with, so a
   *  sign-in completed elsewhere never reached it. Same shape as
   *  {@link postGrokUpdateStatus}. */
  private postProviderState(): void {
    const message = this.providerStateMessage();
    this.post(message);
    void this.settingsEditor?.webview.postMessage(message);
  }

  /**
   * Re-observe every account, asserting nothing about any of them.
   *
   * Settings → Providers is derived from a persisted connection flag, a cached
   * CLI path and the last credential probe — none of which re-check themselves.
   * Sign out inside a terminal, install a CLI, let a token lapse, and the page
   * keeps repeating what it last heard. This is the way to make it tell the
   * truth, and it runs both from the page's Refresh button and when the page
   * is opened.
   *
   * Every INSTALLED agent is probed, not just the ones already marked connected.
   * Signing in happens outside this extension — a browser OAuth approval, a
   * `grok login` in any terminal — and the desk has no way to hear about it.
   * Probing only the already-connected set made the button useless in exactly
   * the case people press it: approve Grok in the browser, press Refresh, and
   * it skipped Grok because the stale flag said "not connected" (owner, and it
   * meant opening the chat and pressing Check instead).
   *
   * A provider whose CLI is not installed is still skipped — there is nothing
   * to run and nothing to learn.
   *
   * Still NOT `recheckConnection`: that marks its provider connected BEFORE
   * probing, so a failed sign-in leaves an account the user never had. Here the
   * probe comes first and only a SUCCESS promotes — evidence, not assumption.
   * A failure never demotes: a lapsed account keeps its row and gets the
   * sign-in action (see setProviderNeedsLogin), and one that was never
   * connected simply stays that way.
   */
  private async refreshProviderStates(): Promise<void> {
    if (this.providerRefreshInFlight) return;
    this.providerRefreshInFlight = true;
    // Say it started before the slow part. The button reads `checking` off this
    // frame, so posting it first is what makes the click feel answered.
    this.postProviderState();
    try {
      // Drop the located paths so the locators genuinely re-run. `locateProvider`
      // only invalidates a cached path when the file is gone, so a CLI installed
      // or repointed since boot would otherwise stay invisible.
      if (!this.testForceMissingGrokCli) this.cliPath = undefined;
      this.codexCliPath = undefined;
      this.claudeCliPath = undefined;
      // Read AFTER dropping the paths, so a CLI that appeared since boot counts.
      const located = this.locatedProviders();
      const installed = ACP_PROVIDERS.filter((provider) => located[provider]);
      const connectedBefore = this.providerConnections();
      // Failures are the answer here, not an error: a rejected probe is how a
      // lapsed account gets its needsLogin flag. reprobeProviderCredentials
      // already classifies and records that, so nothing is swallowed.
      //
      // Versions are deliberately not re-probed. They are read once per
      // activation by design, they do not appear on this page, and every
      // connected account already probes its version when it connects.
      await Promise.all(installed.map(async (provider) => {
        const authenticated = await this.reprobeProviderCredentials(provider).catch(() => false);
        // Promote on a SUCCESSFUL probe only. This is the sign-in that happened
        // somewhere the desk could not see; the probe is what makes it a fact
        // rather than a guess. Persisted, so it survives a reload the way the
        // connect flow's own state does.
        if (authenticated && connectedBefore[provider] !== true) {
          await this.setProviderConnected(provider, true);
        }
      }));
    } finally {
      this.providerRefreshInFlight = false;
      // Always the last word, however the probes went — a spinner that outlives
      // its refresh is worse than a stale row, because it never resolves.
      this.postProviderState();
      void this.refreshGithubState();
    }
  }

  // USABLE, not merely connected. A provider whose credentials have lapsed is
  // still connected and still located, so it used to win connected[0] and
  // capture every new session — the owner had Grok and Claude unconnected and
  // Codex connected-but-expired, and a fresh session dropped him into "Complete
  // codex login" rather than letting him pick. Grok stays the fallback when
  // nothing can answer, which is what the empty case already did.
  private defaultProviderForProject(cwd: string): AcpProvider {
    const usable = this.usableProviders();
    const saved = this.state.get<ProjectProviderDefaults>(PROJECT_PROVIDER_DEFAULTS_KEY, {})[
      projectProviderKey(cwd)
    ];
    if (saved && usable.includes(saved.provider)) return saved.provider;
    return usable[0] ?? "grok";
  }

  private providerDefaultForProject(cwd: string, provider: AcpProvider): string | undefined {
    const saved = this.state.get<ProjectProviderDefaults>(PROJECT_PROVIDER_DEFAULTS_KEY, {})[
      projectProviderKey(cwd)
    ];
    if (saved?.provider === provider) return saved.modelId || undefined;
    return provider === "grok"
      ? this.host.getConfiguration("grok").get<string>("defaultModel", "") || undefined
      : undefined;
  }

  private async rememberProjectProvider(cwd: string, provider: AcpProvider, modelId?: string): Promise<void> {
    const current = this.state.get<ProjectProviderDefaults>(PROJECT_PROVIDER_DEFAULTS_KEY, {});
    await this.state.update(PROJECT_PROVIDER_DEFAULTS_KEY, {
      ...current,
      [projectProviderKey(cwd)]: { provider, ...(modelId ? { modelId } : {}) },
    } satisfies ProjectProviderDefaults);
  }

  private cacheProviderModels(
    provider: AcpProvider,
    models: readonly ProviderModelInfo[] | readonly any[],
    currentModelId?: string,
  ): PromiseLike<void> {
    const current = this.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const clean = models.map(({ provider: _provider, defaultImplied: _default, ...model }: any) => model);
    const stored = this.state.update(PROVIDER_MODEL_CACHE_KEY, {
      ...current,
      [provider]: { models: clean, currentModelId, seenAt: Date.now() },
    } satisfies ProviderModelCache);
    // The picker reads this cache, and an adapter's models arrive
    // ASYNCHRONOUSLY — the warm-up runs after the connect returns. Re-posting
    // only at connect time therefore published an empty list, and the newly
    // connected agent appeared in the picker only after a New session, which is
    // exactly what the owner saw with Codex. Push the catalog again once the
    // models actually exist.
    // A provider the cache had NOTHING for is a newly connected agent, and it
    // must appear in the picker of the conversation the person is looking at —
    // not only in an empty one. The owner connected Codex from a session with
    // history and it stayed missing until he reloaded (2026-08-31). Adding
    // options cannot disturb a live thread: the current model is re-sent
    // unchanged, so nothing about the running conversation moves.
    const providerIsNew = !current[provider] || (current[provider].models ?? []).length === 0;
    void Promise.resolve(stored).then(() => {
      const sessions = providerIsNew
        ? this.sessionsForModelRefresh()
        : this.emptySessionsForModelRefresh();
      for (const session of sessions) this.postSessionModels(session);
    });
    return stored;
  }

  /** Sessions whose picker may be refreshed in place: no history, so there is
   *  nothing a changed model list could disturb. */
  /** Every session with a live client. Used only when a provider appears for
   *  the first time, where the change is purely additive. */
  private sessionsForModelRefresh(): Session[] {
    const seen = new Set<Session>();
    for (const session of [this.focused, ...this.pool]) {
      if (!session || seen.has(session)) continue;
      seen.add(session);
    }
    return [...seen].filter((session) => session.client?.sessionId);
  }

  private emptySessionsForModelRefresh(): Session[] {
    const seen = new Set<Session>();
    for (const session of [this.focused, ...this.pool]) {
      if (!session || seen.has(session)) continue;
      seen.add(session);
    }
    return [...seen].filter((session) => !session.hasHistory && session.client?.sessionId);
  }

  /**
   * Re-post the model catalog for a session already on screen.
   *
   * Connecting a second agent used to leave the picker stale until the user
   * clicked New session — on a session that was already new. An empty
   * conversation has nothing to protect, so its catalog is refreshed in place;
   * one with history is left alone, because changing the model list under a
   * live thread is a different thing entirely.
   */
  /**
   * The identity frame for a conversation that is already live.
   *
   * Re-focusing one replays its transcript and its UI snapshot and, until
   * 2026-09-01, stopped there. `sessionUiSnapshot` carries `modelChanged`, so
   * the model PICKER updated — but `session` is the only frame that sets the
   * provider, and it was never sent on this path. Switching from a Grok
   * conversation to a live Codex one therefore left the client believing it was
   * still on Grok: the composer said "Ask Grok", the working indicator said
   * "grokking", the model list stayed the old session's, and steering was
   * attempted against a CLI that has no such method (owner, from a phone,
   * 2026-09-01 — the model picker showing the right model while everything
   * around it showed the wrong agent is exactly this frame's absence).
   *
   * The same omission the `sessionName` note in focusSession records, one field
   * over: send the small identity frame the client needs, rather than rebuild a
   * catalog to carry it.
   *
   * `newSession: false` — a re-focus is not a new conversation, matching what
   * startSession passes for a resume.
   */
  private sessionIdentityFrame(session: Session): HostMsg | undefined {
    const client = session.client;
    if (!client?.sessionId) return undefined;
    return {
      type: "session",
      sessionId: client.sessionId,
      // `?? []` is load-bearing. A session can have a sessionId before its
      // model list arrives — a phone JOINING a conversation the desk already
      // holds is the ordinary case — and `modelsForSession` maps over this
      // array unconditionally. Without the fallback it threw here, after
      // `clearMessages` had already gone out, so the client was left cleared
      // with an error instead of a transcript. Ten integration tests said so
      // and I had not run them.
      models: this.modelsForSession(session, client.availableModels ?? [], client.currentModelId, false),
      currentModelId: client.currentModelId,
      worktree: !!session.worktree,
      provider: session.provider,
    };
  }

  private postSessionModels(session: Session): void {
    const client = session.client;
    // `hasHistory` no longer disqualifies a session: a NEW provider's models
    // are additive and the selection is re-sent unchanged (see
    // cacheProviderModels). Callers decide which sessions to refresh.
    if (!client?.sessionId) return;
    this.emit(session, {
      type: "session",
      sessionId: client.sessionId,
      models: this.modelsForSession(session, client.availableModels, client.currentModelId, true),
      currentModelId: client.currentModelId,
      worktree: !!session.worktree,
      provider: session.provider,
    });
  }

  private modelsForSession(session: Session, ownModels: readonly any[], currentModelId?: string, newSession = false): ProviderModelInfo[] {
    if (!newSession) return ownModels.map((model) => ({ ...model, provider: session.provider }));
    return modelsForConnectedProviders(
      // Usable, not connected: a provider that cannot answer contributes no
      // rows to the picker, so its heading and its stale cached models go with
      // it (owner, 2026-08-17: "Not connected => Not visible").
      this.usableProviders(),
      this.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {}),
      { provider: session.provider, models: ownModels, currentModelId },
    );
  }

  private providerForRequestedModel(modelId: string, fallback: AcpProvider): AcpProvider {
    if (!modelId) return fallback;
    const cache = this.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const matches = (["grok", "codex", "claude"] as const).filter((provider) =>
      cache[provider]?.models.some((model) => model.modelId === modelId));
    return matches.length === 1 ? matches[0] : fallback;
  }

  resolveWebviewView(view: HostWebviewView): void {
    this.view = view;
    // Assigning html boots a new renderer. The `local` cache entry belonged
    // to the previous JS state and must not suppress the next identical frame.
    this.forgetPostedVoiceConfigured("local");
    view.webview.options = {
      enableScripts: true,
      // Extension assets keep extensionUri identity (vscode-remote on remote hosts).
      // Staging + grok home are genuinely local disk paths → Uri.file.
      localResourceRoots: this.chatLocalResourceRoots(),
    };
    view.webview.html = this.getHtml(view.webview);
    // Message handlers run async; without this catch a throw (e.g. an fs error
    // in an image-attach path) becomes a silent unhandled rejection and the
    // user's action just... does nothing.
    view.webview.onDidReceiveMessage((raw) => {
      const m = raw as WebviewMsg;
      void this.onMessage(m, "local").catch((e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.host.appendLine(`[webview] ${m.type} failed: ${msg}`);
        void this.host.showErrorMessage(`Grok: ${m.type} failed — ${msg}`);
      });
    });
    this.restorePersistedDraft(this.focused);
    this.watchActiveEditor();
    // Periodic idle-TTL sweep over the live-session pool (the LRU cap is enforced
    // eagerly on each new start; this catches sessions that simply went stale).
    if (!this.reaper) {
      this.reaper = setInterval(() => {
        this.reapPool();
        // The only thing that re-evaluates keep-awake on the CLOCK rather than
        // on an event. `needs-you` holds a cloud machine awake for a bounded
        // window, and nothing else would ever notice that window closing —
        // the heartbeat would run until the next status change, which on an
        // abandoned permission card is never.
        this.refreshKeepAwake();
      }, GrokSidebar.REAP_INTERVAL_MS);
    }
    // Re-tell the webview whether voice is set up when the relevant settings
    // change, so the mic button's "needs setup" hint updates without a reload.
    this.configWatcher?.dispose();
    const configChanges = this.host.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("grok.voiceApiKey") ||
        e.affectsConfiguration("grok.ffmpegPath") ||
        e.affectsConfiguration("grok.voiceSendPhrase") ||
        e.affectsConfiguration("grok.voiceKeyterms")
      ) {
        this.postVoiceConfigured();
      }
      if (e.affectsConfiguration("grok.chatFontScale")) {
        this.postFontScale();
      }
      if (e.affectsConfiguration("grok.showThinking")) {
        this.postShowThinking();
      }
      if (e.affectsConfiguration("grok.codexCliPath")) {
        this.codexCliPath = undefined;
        this.postProviderState();
      }
      if (e.affectsConfiguration("grok.claudeCliPath")) {
        this.claudeCliPath = undefined;
        this.postProviderState();
      }
      if (e.affectsConfiguration("grok.expandCommandOutputs")) {
        this.post({
          type: "expandCommandOutputs",
          value: this.host.getConfiguration("grok").get<boolean>("expandCommandOutputs", false),
        });
      }
      if (e.affectsConfiguration("grok.steerByDefault")) {
        this.post({
          type: "steerByDefault",
          value: this.host.getConfiguration("grok").get<boolean>("steerByDefault", false),
        });
      }
      if (e.affectsConfiguration("grok.soundNotifications")) {
        this.post({
          type: "soundNotifications",
          value: this.host.getConfiguration("grok").get<boolean>("soundNotifications", false),
        });
      }
      if (e.affectsConfiguration("grok.processingSound")) {
        this.post({
          type: "processingSound",
          value: this.host.getConfiguration("grok").get<boolean>("processingSound", false),
        });
      }
      if (e.affectsConfiguration("grok.readRepliesAloud")) {
        this.post({
          type: "readRepliesAloud",
          value: this.host.getConfiguration("grok").get<boolean>("readRepliesAloud", false),
        });
      }
      if (e.affectsConfiguration("grok.summarizeRepliesAloud")) {
        this.post({
          type: "summarizeRepliesAloud",
          value: this.host.getConfiguration("grok").get<boolean>("summarizeRepliesAloud", true),
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
      if (e.affectsConfiguration("grok.telemetry.enabled")) {
        this.post({
          type: "telemetryEnabled",
          value: this.host.getConfiguration("grok").get<boolean>("telemetry.enabled", true),
        });
      }
      if (e.affectsConfiguration("grok.thumbsFeedback")) {
        this.postThumbsFeedback();
        for (const session of [this.focused, ...this.pool]) {
          this.refreshFeedbackAvailability(session);
        }
      }
    });
    const authWatcher = this.host.createFileSystemWatcher(
      resolveGrokHome(process.env),
      "auth.json",
    );
    const refreshVoiceConfigured = () => this.postVoiceConfigured();
    authWatcher.onDidCreate(refreshVoiceConfigured);
    authWatcher.onDidChange(refreshVoiceConfigured);
    authWatcher.onDidDelete(refreshVoiceConfigured);
    this.configWatcher = disposeAll(configChanges, authWatcher);
    this.applyTerminalShellPref();
    void this.maybeStartUplink();
  }

  /**
   * Primary side bar projects rail. Same catalog stream as the chat webview
   * (`repos` / `sessions` / `repoSessions` / `pinnedSessions` / `sessionDot`),
   * never chat traffic — a second `chat.js` client would double-own sessions.
   */
  resolveProjectsRailView(view: HostWebviewView): void {
    this.projectsRail = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, "media"),
        Uri.joinPath(this.context.extensionUri, "resources"),
      ],
    };
    view.webview.html = this.getProjectsRailHtml(view.webview);
    view.webview.onDidReceiveMessage((raw) => {
      const m = raw as WebviewMsg;
      void this.onProjectsRailMessage(m).catch((e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.host.appendLine(`[projects-rail] ${m.type} failed: ${msg}`);
        void this.host.showErrorMessage(`Grok Projects: ${m.type} failed — ${msg}`);
      });
    });
  }

  /** Drop the rail handle when the view is disposed (or re-created). */
  disposeProjectsRailView(): void {
    this.projectsRail = undefined;
  }

  private chatLocalResourceRoots(): Uri[] {
    return [
      Uri.joinPath(this.context.extensionUri, "media"),
      Uri.joinPath(this.context.extensionUri, "resources"),
      Uri.file(this.imageStagingDir()),
      // grok writes generated media under ~/.grok/sessions/<cwd>/<id>/{images,videos};
      // serving it via asWebviewUri (instead of a base64 data: URI) lets the
      // webview stream a multi-MB video from disk — see postGeneratedMedia.
      Uri.file(resolveGrokHome()),
      Uri.file(resolveCodexHome()),
    ];
  }

  /**
   * Rail actions only. `ready` pushes catalog — never postInitialState / startSession
   * (those belong to the chat view). Everything else reuses onMessage so there is
   * one host path for resume/pin/rename/delete.
   */
  private async onProjectsRailMessage(msg: WebviewMsg): Promise<void> {
    if (msg.type === "ready") {
      this.pushProjectsRailCatalog();
      return;
    }
    if (!GrokSidebar.PROJECTS_RAIL_WEBVIEW_TYPES.has(msg.type)) {
      this.host.appendLine(`[projects-rail] ignored ${msg.type}`);
      return;
    }
    await this.onMessage(msg, "local");
    // Opening a conversation from the rail is someone saying which conversation
    // they want to be in, so put them in it. The rail lives in its own activity
    // bar container, so without this the chat can stay behind another view and
    // the click looks like it did nothing.
    //
    // Only these two, and only from the RAIL: renaming, pinning or deleting a
    // row is housekeeping done while looking at the list, and yanking the view
    // out from under that would be the opposite of helpful. This handler is
    // rail-only, so the chat asking for its own session never lands here.
    if (msg.type === "resumeSession" || msg.type === "newSession") {
      await this.host.revealChatView();
    }
  }

  /** Catalog snapshot for a freshly-resolved rail (or its ready handshake). */
  private pushProjectsRailCatalog(): void {
    if (!this.projectsRail) return;
    this.mirrorToProjectsRail(this.providerStateMessage());
    this.postRepoCatalog();
    this.postSessionsList();
  }

  /** Push the `grok.terminalShell` preference (#46) into the shared shell
   *  resolver so the next agent command re-resolves cmd vs PowerShell. */
  private applyTerminalShellPref(): void {
    const pref = this.host.getConfiguration("grok").get<ShellPreference>("terminalShell", "auto");
    setTerminalShellPreference(pref === "cmd" ? "cmd" : "auto");
  }

  insertActiveMention(opts?: { selection?: boolean; uri?: Uri; pickIfMissing?: boolean }): void {
    const editor = this.host.getActiveTextEditor();
    // Prefer a full Uri end-to-end (scheme + authority) so asRelativePath matches
    // remote workspace folders. Explorer Send File passes the explorer Uri via
    // the adapter; never flatten to fsPath and rebuild with Uri.file.
    const pathUri = opts?.uri ?? editor?.document.uri;
    const absPath = pathUri?.fsPath;
    if (!absPath || !pathUri) {
      // Invoked from the Command Palette with no file editor active — no target
      // to attach. Degrade gracefully instead of a silent no-op that also drops
      // focus (#43): Send File opens the file picker; the selection/@-mention
      // commands (which have nothing to reference without an editor) surface a
      // hint so the command visibly did *something*.
      if (opts?.pickIfMissing) {
        void this.trackAttach(this.pickFileFromComputer());
      } else {
        void this.host.showInformationMessage(
          "Grok: open a file in the editor first, then run this command.",
        );
      }
      return;
    }
    // Same fence as the implicit chip, and for the same reason: the attachment
    // has to belong to the CONVERSATION, not to the window. Once the rail could
    // put a project-B conversation on screen inside a window opened on A, "Add
    // Selection to Grok" on an A file handed A's source to B — and with a
    // selection the prompt builder reads that absolute path and embeds the text
    // under an innocuous A-relative name like `src/foo.ts`.
    //
    // Also where the relative path comes from. `asRelativePath` resolves against
    // VS Code's workspace folders, and a project reached through the rail is
    // deliberately not one of them, so it would have labelled an ordinary file
    // with its full absolute path.
    const sessionRoot = this.sessionCwd(this.focused);
    const relPath = this.conversationRelPath(absPath);
    if (relPath === undefined) {
      void this.host.showWarningMessage(
        `That file is outside ${path.basename(sessionRoot) || "this project"}, which is where ` +
          "this conversation is running. Open a conversation in its project first.",
      );
      return;
    }
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (opts?.selection && editor && !editor.selection.isEmpty) {
      const range = selectionLineRange(editor.selection.start, editor.selection.end);
      selStart = range.startLine;
      selEnd = range.endLine;
    }
    this.chips.push(makeExplicitChip(absPath, relPath, selStart, selEnd));
    this.postChips();
    this.revealAndFocusComposer();
  }

  newSession(): void {
    void this.newFocusedSession("local");
  }

  async pickModel(): Promise<void> {
    if (!this.focused.client || !this.focused.client.availableModels.length) {
      this.host.showInformationMessage("Start a session first.");
      return;
    }
    const models = this.modelsForSession(
      this.focused,
      this.focused.client.availableModels,
      this.focused.client.currentModelId,
      !this.focused.hasHistory,
    );
    const items = models.map((m) => ({
      label: `${providerDisplayName(m.provider)} · ${m.name ?? m.modelId}`,
      description: m.provider === this.focused.provider && m.modelId === this.focused.client!.currentModelId ? "$(check) current" : "",
      detail: m.description,
      modelId: m.modelId,
      provider: m.provider,
    }));
    const picked = await this.host.showQuickPick(items, {
      placeHolder: this.focused.hasHistory ? "Pick a model" : "Pick an agent and model",
    });
    if (picked) await this.switchModel(picked.modelId, this.focused, undefined, picked.provider);
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
    provider: AcpProvider = session.provider,
  ): Promise<void> {
    const client = session.client;
    // Ignore switches fired during session startup. The webview disables the
    // control while busy; this is the backstop for a click already in flight.
    if (!client || session.priming) return;
    if (provider !== session.provider) {
      if (session.hasHistory) {
        const current = providerDisplayName(session.provider);
        const requested = providerDisplayName(provider);
        this.reportRequester(
          requester,
          "warning",
          `This ${current} conversation can only use ${current} models. Start a new conversation to switch to ${requested}.`,
        );
        return;
      }
      if (!this.connectedProviders().includes(provider)) {
        this.reportRequester(requester, "warning", `${providerDisplayName(provider)} is not connected.`);
        return;
      }
      const oldProvider = session.provider;
      const discardId = session.activeSessionId;
      if (isAdapterProvider(oldProvider) && discardId) {
        try { await client.deleteSession(discardId); }
        catch (error) { this.host.appendLine(`[${oldProvider}] could not discard empty session ${discardId}: ${(error as Error).message}`); }
      }
      session.provider = provider;
      await this.rememberProjectProvider(this.sessionCwd(session), provider, modelId || undefined);
      await this.startSession(undefined, session);
      if (oldProvider === "grok") this.discardRestartedEmptySession(discardId, session);
      return;
    }
    if (modelId === client.currentModelId) return;
    const cfg = this.host.getConfiguration("grok");
    if (!modelId) {
      if (session.hasHistory) return;
      const discardId = session.activeSessionId;
      await this.rememberProjectProvider(this.sessionCwd(session), provider, undefined);
      if (provider === "grok") await cfg.update("defaultModel", "", "global");
      else if (isAdapterProvider(provider)) await this.discardAdapterEmptySession(provider, discardId, this.sessionCwd(session), client);
      await this.startSession(undefined, session);
      if (provider === "grok") this.discardRestartedEmptySession(discardId, session);
      return;
    }
    try {
      await client.setModel(modelId);
      await this.rememberProjectProvider(this.sessionCwd(session), provider, modelId);
      if (provider === "grok") await cfg.update("defaultModel", modelId, "global");
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
        await cfg.update("defaultModel", modelId, "global");
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
      await cfg.update("defaultModel", modelId, "global");
      await this.restartSession(mode, session);
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
  /**
   * Confirmation for the handful of messages that make the host RUN something.
   *
   * The desktop dispatcher authorizes on "this came from the main window's main
   * frame", which proves origin but not intent — there is no user-gesture
   * notion, so anything able to post a message can trigger these. A per-
   * capability model is the real answer; until then these two get a dialog the
   * renderer cannot draw or dismiss, which is what makes it worth anything.
   */
  private async confirmHostExecute(
    title: string,
    detail: string,
    confirmLabel: string,
  ): Promise<boolean> {
    const ok = await this.host.showWarningMessage(
      `${title}

${detail}`,
      { modal: true },
      confirmLabel,
    );
    return ok === confirmLabel;
  }

  /** Which config forced always-approve, if any. See alwaysApproveSource. */
  private autoApproveSource(cwd: string = this.workspaceRoot()): "project" | "global" | undefined {
    const readSafe = (p?: string): string | undefined => {
      if (!p) return undefined;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    return alwaysApproveSource({
      project: cwd ? readSafe(projectConfigPath(cwd)) : undefined,
      global: readSafe(globalConfigPath()),
    });
  }

  /** Roots whose repo-supplied always-approve the user has accepted this run. */
  private readonly autoApproveConsented = new Set<string>();

  /**
   * Consent for a repository that ships its own always-approve config, asked
   * once per project root per run.
   *
   * This is the one setting a *repository* can use to switch off every
   * permission prompt the agent would otherwise hit before writing files or
   * running commands — and cloning the repo is enough to carry it, because a
   * project .grok/config.toml overrides the user's own.
   *
   * grok applies the file itself, server-side, so declining cannot un-apply it.
   * Declining therefore refuses to start the session at all, which is the only
   * honest option available from here.
   */
  private async confirmRepoForcedAutoApprove(cwd: string): Promise<boolean> {
    if (!cwd || this.autoApproveSource(cwd) !== "project") return true;
    const key = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    if (this.autoApproveConsented.has(key)) return true;
    const ok = await this.host.showWarningMessage(
      `"${path.basename(cwd)}" turns off every permission prompt.

` +
        `This project ships a .grok/config.toml setting permission_mode = "always-approve", which ` +
        `overrides your own setting. The agent will edit files and run commands here without asking ` +
        `you first.

Only continue if you trust this code.`,
      { modal: true },
      "Continue anyway",
    );
    if (ok !== "Continue anyway") {
      this.host.appendLine(`[trust] declined: ${cwd} forces always-approve`);
      return false;
    }
    this.autoApproveConsented.add(key);
    return true;
  }

  private configForcesAutoApprove(cwd: string = this.workspaceRoot()): boolean {
    const readSafe = (p?: string): string | undefined => {
      if (!p) return undefined;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    const globalPath = globalConfigPath();
    const projectPath = cwd ? projectConfigPath(cwd) : undefined;
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
    void this.host.showInformationMessage(
      'Grok: "always-approve" is set in your grok config.toml, so tool actions are auto-approved for every session (CLI and extension). The mode shows "Auto accept" to reflect this — the extension can\'t override a global config setting per-session.',
      OPEN,
    ).then((pick) => {
      if (pick !== OPEN) return;
      void this.host.openGlobalConfig();
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
      // Unverified probe: re-check now rather than forcing a session restart.
      // A verified-old CLI is latched and stays refused.
      if (!session.planModeVersionVerified) {
        const rechecked = await this.recheckPlanModeAvailability(session);
        if (!rechecked || !session.planModeAvailable) {
          this.reportRequester(
            requester,
            "warning",
            session.planModeUnavailableReason ?? "Plan mode is unavailable for this Grok CLI version.",
          );
          return;
        }
        // Probe succeeded — fall through and enter Plan on this same click.
      } else {
        this.reportRequester(
          requester,
          "warning",
          session.planModeUnavailableReason ?? "Plan mode is unavailable for this Grok CLI version.",
        );
        return;
      }
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
      void this.host.getConfiguration("grok")
        .update("defaultMode", remember, "global");
    }
    if (modeId === "yolo") {
      session.autoApprove = true;
      this.setPlanActive(session, false); // posts displayMode → "yolo"
      // Flipping to Auto-accept mid-turn (#64) should unblock the CURRENT prompt,
      // not just future requests: clear routine tool cards already on screen.
      // Plan-review stays — that card is not a routine grant.
      this.autoApprovePendingPermissions(session);
      if (session.client) {
        try {
          if (session.provider === "codex") {
            await session.client.setMode("default");
            await session.client.setMode("agent-full-access");
          } else if (session.provider === "claude") {
            await session.client.setMode("yolo");
          } else {
            await session.client.setMode(ACT_MODE_ID);
          }
        } catch { /* CLI stays put; gate is what matters */ }
      }
      return;
    }
    if (modeId === "plan") {
      // Raise only after the agent accepts Plan. Doing it first left the badge
      // claiming Plan when set_mode failed — Claude/Codex have no client gate,
      // and grok's native writes can skip the partial delegated-command one.
      // The client commits its own gate in the set_mode response hook so a
      // same-chunk terminal/create cannot observe the window this await leaves.
      if (session.client) {
        try {
          await session.client.setMode("plan");
          session.autoApprove = false;
          this.setPlanActive(session, true);
        } catch (e) {
          this.reportRequester(requester, "error", `Couldn't switch mode: ${(e as Error).message}`);
        }
      }
      return;
    }
    session.autoApprove = false;
    // agent
    this.setPlanActive(session, false); // posts displayMode → "agent"
    if (session.client) {
      try {
        if (session.provider === "codex") {
          await session.client.setMode("default");
          await session.client.setMode("agent");
        } else if (session.provider === "claude") {
          await session.client.setMode("agent");
        } else {
          await session.client.setMode(ACT_MODE_ID);
        }
      }
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
      session.autoApprove = this.host.getConfiguration("grok").get<string>("defaultMode", "") === "yolo";
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
        this.host.appendLine(`[plan-verdict] interjected ${feedback.length} comment chars`);
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
      // Same rule as answering a permission or a question: a plan verdict is
      // activity, but it only resumes the turn if nothing else is outstanding.
      sidebar.noteAnswered(session);
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
    session.queuedSends = enqueueQueuedSend(session.queuedSends, recovered.join("\n\n"), []);
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
      const cancelled = session.turnToken;
      void client.cancel("unavailable Plan recovery");
      // "Wait for client.prompt() to settle" is the assumption that wedged
      // sessions in the first place — a cancel is a request, not an outcome.
      // This path cancels a CLI already known to be misbehaving, so it is the
      // LAST one that should be trusted to answer. Same recovery as a user Stop.
      if (cancelled) this.armCancelRecovery(session, cancelled);
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
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
    const occupancy = contextUsageFromLog(usageLog, cur.contextWindow);
    this.host.appendLine(
      `[rewind] dropped ${droppedPlans} plan card(s) + ${droppedPerms} permission card(s) + ${droppedTurns} usage turn(s) past user message ${surviving}`,
    );
    await this.state.update(SESSION_META_KEY, {
      ...overrides,
      [sessionId]: {
        ...cur,
        plans,
        permissions,
        usageLog,
        usage,
        lastPlanVerdict: plans.length ? plans[plans.length - 1].verdict : undefined,
        contextUsed: occupancy.used,
        contextWindow: occupancy.window ?? cur.contextWindow,
        contextPendingCompact: occupancy.pendingCompact || undefined,
      },
    });
    // Keep the live popover in step with what we just persisted. The ledger
    // itself remains keyed by session id in meta; no live Session copy exists.
    const live = [...this.pool].find((s) => s.activeSessionId === sessionId);
    if (live) {
      this.emit(live, { type: "usage", session: usage, afterUserMessage: surviving, afterHistoryEvent: live.historyEventCount });
      if (occupancy.used) {
        this.emit(live, {
          type: "contextUsage",
          used: occupancy.used,
          ...(occupancy.window ? { window: occupancy.window } : {}),
        });
      }
    }
  }

  private persistPlanVerdict(
    session: Session,
    verdict: "approved" | "abandoned" | "rejected",
    planText: string,
  ): void {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
    void this.state.update(SESSION_META_KEY, next);
  }

  /**
   * Mark a conversation as used NOW, and re-push the lists that order by it.
   *
   * Called when a message is sent and when a session is created — the two
   * moments a person would expect their conversation to jump to the top. The
   * lists order by the recency clock (`updates.jsonl` mtime for grok; host
   * `activeAt` for adapters), and grok writes that file about 2.1 seconds
   * after a send (measured), so without this the row sits still through
   * the whole wait and a brand-new conversation is missing entirely.
   *
   * Every project and every session is treated the same; there is no special
   * case for archived, which is a client presentation concept and has no
   * business in the activity path.
   */
  private noteSessionActivity(session: Session): void {
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid) return;
    const activeAt = Date.now();
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    void this.state.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...(overrides[sid] ?? {}), activeAt },
    });
    for (const provider of (["codex", "claude"] as const)) {
      const history = this.adapterHistory(provider);
      if (!history) continue;
      for (const [key, entries] of history.cache) {
        history.cache.set(key, entries.map((entry) =>
          entry.id === sid ? { ...entry, updatedAt: activeAt } : entry));
      }
    }
    const cwd = this.sessionCwd(session);
    this.postSessionsList();
    if (cwd) this.sendLocalRepoSessionsPreview(cwd);
    // Once per connected client. This was `refreshRemoteRepoPreview(undefined,
    // cwd)`, and that method opens with `if (!clientId || !cwd) return` — so it
    // returned immediately, every time, and no remote rail was ever told that a
    // project OTHER than the one it is looking at had just become active. The
    // currently-viewed project still refreshed (via postSessionsList above),
    // which is exactly why this went unnoticed.
    for (const clientId of this.remoteClients.clients()) {
      this.refreshRemoteRepoPreview(clientId, cwd);
    }
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
    const chosen = pending.options.find((option) => option.optionId === optionId);
    // A switch_mode card with no plan text is a mode question, not a plan
    // review — persist the option they picked, not "Ready to code?".
    const title = isPlanReviewPermission(pending.toolKind) && !pending.plan?.trim()
      ? (chosen?.name || pending.title)
      : pending.title;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const permissions = [
      ...(cur.permissions ?? []),
      { title, outcome, toolCallId: pending.toolCallId, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount },
    ];
    void this.state.update(SESSION_META_KEY, {
      ...overrides,
      [sid]: { ...cur, permissions },
    });
  }

  /**
   * Decide a live `session/request_permission`. The Plan bit comes from
   * `effectivePlanActive` so a same-chunk request cannot still see Auto
   * accept after a successful Plan RPC. Grok also refuses mutating tools
   * through the client gate; Codex/Claude do not — their Plan is
   * adapter-enforced, but the permission card still has to reach a human.
   */
  private handlePermissionRequest(
    session: Session,
    client: AcpClient,
    req: PermissionRequest,
    cwd: string,
  ): void {
    const planActive = effectivePlanActive(
      client.usesClientPlanGate,
      client.planActive,
      session.planActive,
    );
    // While planning, decline permissions for operations the same fs/terminal
    // policy would block. A read-only execute request falls through to the
    // ordinary permission prompt; Plan mode never grants permission itself.
    if (client.usesClientPlanGate && planActive && shouldRejectPermission(req.toolCall, {
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
    // Auto accept is not a verdict on a plan-review card. Same rule as
    // autoApprovePendingPermissions, including after a failed mode RPC
    // that already cleared the Plan bit.
    if (session.autoApprove && !planActive && !isPlanReviewPermission(req.toolCall?.kind)) {
      const opt = req.options.find((o) => o.kind === "allow_always") ??
                  req.options.find((o) => o.kind === "allow_once");
      if (opt) { client.respondPermission(req.id, opt.optionId); return; }
    }
    // Remember it so the answer can be persisted for replay on resume.
    const visibleOptions = permissionOptionsForPlan(
      req.options ?? [],
      planActive,
      req.toolCall?.kind,
    );
    if (
      planActive &&
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
    const plan = isPlanReviewPermission(req.toolCall?.kind)
      ? planTextFromPermissionToolCall(req.toolCall)
      : undefined;
    session.pendingPermissions.set(req.id, createPendingPermission({
      title: req.toolCall?.title || `permission: ${req.toolCall?.kind || "tool"}`,
      toolCallId: req.toolCall?.toolCallId,
      toolKind: req.toolCall?.kind,
      plan,
      options: (req.options ?? []).map((o) => ({
        optionId: o.optionId,
        kind: o.kind,
        name: o.name,
      })),
    }));
    this.emit(session, {
      type: "permissionRequest",
      req: {
        ...req,
        options: visibleOptions,
        ...(plan !== undefined ? { plan } : {}),
      },
    });
    this.setStatus(session, "needs-you");
  }

  /** Auto-approve routine permission cards currently awaiting the user (#64).
   *  Fired when the user switches to Auto-accept mid-turn so on-screen tool
   *  cards resolve immediately instead of only future requests. Plan-review
   *  / `switch_mode` cards are excluded: that flip is not a verdict on an
   *  unread plan, and the card must stay answerable. A card with no allow
   *  option is left for the user as well. */
  private autoApprovePendingPermissions(session: Session): void {
    const client = session.client;
    if (!client || session.pendingPermissions.size === 0) return;
    let resolved = 0;
    // Snapshot first — persistPermissionAnswer mutates pendingPermissions.
    for (const [requestId, pending] of [...session.pendingPermissions]) {
      if (isPlanReviewPermission(pending.toolKind)) continue;
      const opt = preferredPermissionAllowOption(pending, session.planActive);
      if (!opt) continue;
      if (!client.respondPermission(requestId, opt.optionId)) continue;
      this.emit(session, { type: "permissionResolved", requestId, optionId: opt.optionId });
      this.persistPermissionAnswer(session, requestId, opt.optionId);
      this.closeDiffForRequest(session, requestId);
      resolved += 1;
    }
    // A leftover plan-review, question, or a card with no allow option still
    // needs the user — `noteAnswered` is the one place that knows all three.
    if (resolved > 0) this.noteAnswered(session);
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
    // Same readiness as handleSend — client without sessionId is still priming.
    if (!sessionReadyForPrompt(session)) return undefined;
    if (session.status === "working" || session.status === "needs-you") return undefined;
    // `""` is a ready image-only queue; `undefined` is "do not flush".
    return queuedFlushText(session.queuedSends);
  }

  private emitQueuedSends(session: Session): void {
    this.emit(session, queuedSendsMessage(session.queuedSends));
  }

  private async maybeFlushQueuedSends(session: Session): Promise<void> {
    const combined = this.queuedSendReadyText(session);
    if (combined === undefined) return;
    if (session.queuedSendCommit) return;
    if (session.queuedSendRequiresRelay) {
      if (this.remoteClients.clientsForActiveValue(session).length === 0) return;
      const dispatch = claimQueuedSendDispatch(
        session.queuedSendDispatch,
        combined,
        () => randomUUID(),
      );
      if (!dispatch || session.queuedSendDispatch) return;
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
   * Steer (#52) — inject text (and attachments) into the RUNNING turn instead
   * of waiting. Unlike a second `session/prompt` (which kills the in-flight
   * turn), grok's `_x.ai/interject` queues into a buffer the agent drains at
   * its next safe point, so no tool work is lost and the turn still ends
   * normally.
   *
   * Images ride additive `content` blocks built by `buildPromptWithImages` —
   * the same encoder as `session/prompt`. A CLI old enough to ignore `content`
   * never sees a silent drop: the whole item is queued instead. File chips
   * stay in the text block and work on that legacy wire.
   *
   * The queue / composer snapshot is synchronous (VS Code does not serialize
   * async webview handlers; a following `clearQueuedSends` can race). A
   * failure restores that snapshot rather than losing the message.
   */
  private async steerSend(
    text: string,
    session: Session = this.focused,
    requester?: RemoteRequester,
    requestedChips?: FileChip[],
    fromQueue = false,
  ): Promise<void> {
    const authored = text ?? "";
    const takeQueue = (fromQueue && queuedSendsHaveContent(session.queuedSends))
      || queuedSendsContainChipIds(session.queuedSends, requestedChips);

    if (!session.client || !session.activeSessionId) {
      // No live turn to steer — fall back to the queue rather than drop it.
      // Deliberately NOT flagged for a relay round-trip: the relay meters
      // steerSend on ingress exactly like send, so this text is already paid
      // for — re-submitting the queued fallback through the relay would
      // charge it twice. Same for the two fallbacks below.
      if (takeQueue) return;
      const chips = chipsForQueueSend(session.chips, requestedChips);
      if (!authored.trim() && !chips.length) return;
      session.queuedSends = enqueueQueuedSend(session.queuedSends, authored, chips);
      if (chips.length) {
        session.chips = consumeChips(session.chips, chips);
        if (session === this.focused) this.refreshImplicitChip(true);
        else this.postChips(session);
      }
      this.emitQueuedSends(session);
      return;
    }

    const relayFlag = session.queuedSendRequiresRelay;
    let contributions: QueuedSendEntry[];
    let fromComposer = false;
    if (takeQueue) {
      contributions = session.queuedSends.map((item) => ({
        text: item.text,
        chips: item.chips.map(cloneChipForQueue),
      }));
      session.queuedSends = [];
      session.queuedSendDispatch = undefined;
      session.queuedSendCommit = undefined;
      this.emitQueuedSends(session);
    } else {
      const chips = chipsForQueueSend(session.chips, requestedChips);
      if (!authored.trim() && !chips.length) return;
      contributions = [{ text: authored, chips }];
      if (chips.length) {
        fromComposer = true;
        session.chips = consumeChips(session.chips, chips);
        if (session === this.focused) this.refreshImplicitChip(true);
        else this.postChips(session);
      }
    }

    const putBackOnQueue = (): void => {
      if (takeQueue) {
        session.queuedSends = [...contributions, ...session.queuedSends];
        session.queuedSendRequiresRelay = relayFlag;
      } else {
        for (const item of contributions) {
          session.queuedSends = enqueueQueuedSend(session.queuedSends, item.text, item.chips);
        }
      }
      this.emitQueuedSends(session);
    };
    const putBackOnComposer = (): void => {
      if (takeQueue) {
        session.queuedSends = [...contributions, ...session.queuedSends];
        session.queuedSendRequiresRelay = relayFlag;
        this.emitQueuedSends(session);
        return;
      }
      if (fromComposer) {
        session.chips = restoreQueuedChips(session.chips, contributions);
        if (session === this.focused) this.refreshImplicitChip(true);
        else this.postChips(session);
      }
    };

    const client = session.client;
    const gen = session.gen;
    const promptDeps = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      extName: (p: string) => path.extname(p),
    };

    const builtContributions: QueuedPromptContribution[] = [];
    for (const item of contributions) {
      const itemImages: PromptImageInput[] = [];
      for (const chip of item.chips) {
        if (chip.hidden || !isImageChip(chip)) continue;
        const read = await this.readImageChip(chip, session, gen);
        if (read === "gone") {
          putBackOnComposer();
          return;
        }
        if (read === "failed") {
          putBackOnComposer();
          return;
        }
        itemImages.push(read);
      }
      builtContributions.push({ text: item.text, chips: item.chips, images: itemImages });
    }
    if (gen !== session.gen || session.client !== client) {
      putBackOnComposer();
      return;
    }

    const images = builtContributions.flatMap((item) => item.images);
    if (images.length && !client.honorsInterjectContent()) {
      // 0.2.x / unverified: interject still works, but `content` is ignored
      // and the pixels would vanish. Queue the whole item instead.
      putBackOnQueue();
      this.reportRequester(
        requester,
        "warning",
        "This Grok CLI cannot steer attachments mid-turn — your message was queued instead. It will send when the turn finishes.",
      );
      return;
    }

    const implicitChips = session.chips.filter((chip) => isImplicitChip(chip));
    const slashCommand = matchSlashCommand(
      queuedSendsText(contributions) || authored,
      client.availableCommands.map((c) => c.name),
    );
    const built = builtContributions.length === 1
      ? buildPromptWithImages(
        builtContributions[0].text,
        [...builtContributions[0].chips, ...implicitChips],
        builtContributions[0].images,
        promptDeps,
        slashCommand != null,
      )
      : buildQueuedPromptWithImages(builtContributions, implicitChips, promptDeps, slashCommand != null);

    await this.retainUploadedFilesForSession(
      session,
      contributions.flatMap((item) => item.chips),
    );
    if (gen !== session.gen || session.client !== client) {
      putBackOnComposer();
      return;
    }

    const displayText = queuedSendsText(contributions);
    const displayChips = contributions.flatMap((item) => item.chips);
    this.emit(session, {
      type: "userMessage",
      text: displayText,
      chips: displayChips,
      steer: true,
    });
    if (!session.queuedSends.length) session.queuedSendRequiresRelay = false;

    const rpcText = images.length ? displayText : built.text;
    try {
      const r = await client.interject(rpcText, () => {
        if (gen === session.gen && session.client === client) session.interjectionCount += 1;
      }, images.length ? built.blocks : undefined);
      if (r === "unsupported") {
        // Pre-~0.2.96 CLI: latch the button off and hand the item to the queue,
        // which is exactly the behavior Steer was offering to skip.
        this.emit(session, { type: "steerUnavailable" });
        this.emit(session, { type: "agentReset" });
        putBackOnQueue();
        this.reportRequester(
          requester,
          "warning",
          "Steering needs a newer Grok Build CLI — your message was queued instead. Update via Settings → About.",
        );
        return;
      }
      this.host.appendLine(
        images.length
          ? `[steer] interjected ${rpcText.length} chars + ${images.length} image(s) into the running turn`
          : `[steer] interjected ${rpcText.length} chars into the running turn`,
      );
    } catch (e: any) {
      this.emit(session, { type: "agentReset" });
      putBackOnQueue();
      this.emit(session, { type: "error", text: `Steer failed: ${e?.message ?? e}. Your message was queued instead.` });
    }
  }

  private refreshFeedbackAvailability(session: Session): void {
    const available = decideFeedbackAvailability({
      provider: session.provider,
      metaEnabled: session.feedbackMetaEnabled,
      commandsAdvertise: session.feedbackCommandsAdvertise,
      latchedUnsupported: session.feedbackUnsupported,
      userEnabled: this.thumbsFeedbackEnabled(),
    });
    if (session.feedbackAvailable === available) return;
    session.feedbackAvailable = available;
    this.emit(session, { type: "feedbackAvailability", available });
  }

  private latchFeedbackUnavailable(session: Session): void {
    session.feedbackUnsupported = true;
    this.refreshFeedbackAvailability(session);
  }

  private ackTurnFeedback(session: Session, rating: -1 | 0 | 1): void {
    if (!session.liveFeedbackEligible) return;
    session.turnRating = rating === 1 || rating === -1 ? rating : 0;
    this.emit(session, { type: "turnFeedbackAck", rating });
  }

  /**
   * A live (non-replay) prompt settled in this process. Thumbs may rate that
   * turn and no earlier one; a cold `session/load` never sets this.
   */
  private noteLiveTurnEnded(session: Session): void {
    // The turn is over, so nothing it asked is outstanding any more — whether
    // it ended by finishing or by being cancelled. Without this, a question
    // card left on screen after Stop still passes the "is it outstanding" check
    // when somebody answers it, and `noteAnswered` drags a settled session back
    // to `working` with no turn left that could ever end it. On a rented
    // machine that holds it awake and billing for good.
    // NOTHING the ended turn asked is outstanding any more — whichever kind of
    // card it was. Clearing only one kind is worse than clearing none: with a
    // question and a permission both on screen after Stop, emptying the
    // question set alone means answering the leftover permission finds every
    // map empty and marks the settled session `working`, with no turn left that
    // could ever end it. Both other paths already refuse a card they cannot
    // find, so clearing here is what makes a stale card inert rather than
    // merely mis-scored.
    //
    // ONLY when no newer turn has started, though. This runs from a completion
    // path that can resume after an await — /compact yields while it refreshes
    // context — and by then another tab or a remote send may have begun a turn
    // of its own. Clearing then would delete a LIVE turn's cards, and the host
    // would refuse to answer the card still on the reader's screen, leaving
    // that agent blocked with no way back short of restarting the session.
    if (!turnIsInFlight(session)) {
      session.pendingQuestions.clear();
      session.pendingPermissions.clear();
      session.pendingExitPlans.clear();
    }
    if (session.replaying || session.suppressContent) return;
    session.liveFeedbackEligible = true;
    session.turnRating = 0;
  }

  /**
   * Per-turn thumbs (#114). Rates the turn that just finished in this process.
   * Does not send `turn_number` — the agent attributes the rating from its own
   * session tracking. See research/turn-feedback.md.
   */
  private async handleTurnFeedback(
    rating: unknown,
    session: Session,
    requester?: RemoteRequester,
  ): Promise<void> {
    const previous = session.turnRating;
    const revert = () => this.ackTurnFeedback(session, previous);
    if (!isThumbsRating(rating)) {
      revert();
      return;
    }
    // Setting off is not a capability gap — do not latch unsupported, or
    // turning the opt-in on later could never restore thumbs.
    if (!this.thumbsFeedbackEnabled()) {
      revert();
      return;
    }
    if (session.provider !== "grok" || !session.feedbackAvailable) {
      this.latchFeedbackUnavailable(session);
      revert();
      return;
    }
    if (!session.liveFeedbackEligible) {
      revert();
      this.reportRequester(requester, "warning", "Only the latest reply in this session can be rated.");
      return;
    }
    const client = session.client;
    if (!client?.sessionId) {
      revert();
      this.reportRequester(requester, "warning", "Start a Grok session before rating a turn.");
      return;
    }
    try {
      const result = await client.submitFeedback({
        ratingValue: rating,
        clientType: feedbackClientType(!!this.host.canSwitchWorkspaceFolder),
        clientVersion: this.context.extensionVersion,
      });
      if (result === "unsupported") {
        this.latchFeedbackUnavailable(session);
        revert();
        this.reportRequester(
          requester,
          "warning",
          "Turn ratings need a Grok Build CLI that accepts feedback.",
        );
        return;
      }
      // A later send already took the affordance. The RPC rated the turn that
      // was current at click time; do not paint the next footer.
      if (!session.liveFeedbackEligible) return;
      this.ackTurnFeedback(session, rating);
    } catch (e: any) {
      revert();
      this.reportRequester(requester, "error", `Couldn't send that rating: ${e?.message ?? e}`);
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
          "Forking needs a newer Grok Build CLI. Update via Settings → About.",
        );
        return;
      }
      this.host.appendLine(`[fork] ${session.activeSessionId} → ${r.newSessionId} ("${forkName}")`);
      // Stamp the name before focusing, so neither the history list nor the
      // toolbar ever flashes grok's own generated title for the fork.
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const prev = overrides[r.newSessionId] ?? {};
      const parentUploads = overrides[session.activeSessionId]?.uploadedFiles ?? [];
      const parentMeta = overrides[session.activeSessionId] ?? {};
      const carried: SessionMetaOverrides[string] = {
        ...prev,
        customName: forkName,
        uploadedFiles: [...new Set([...(prev.uploadedFiles ?? []), ...parentUploads])],
        contextUsed: parentMeta.contextUsed,
        contextWindow: parentMeta.contextWindow,
        contextPendingCompact: parentMeta.contextPendingCompact,
      };
      // A fork of a worktree session stays in that worktree — carry the binding.
      // It's a second conversation branch sharing the checkout (like the Agent
      // Dashboard's parallel sessions); Remove worktree disposes both.
      if (session.worktree) {
        carried.worktreePath = session.worktree.path;
        carried.worktreeLabel = session.worktree.label;
        carried.sourceGitRoot = session.worktree.sourceGitRoot;
      }
      await this.state.update(SESSION_META_KEY, {
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
  /**
   * `session` and `requester` are explicit since rewind/edit became reachable
   * from a remote (2026-09-01). Both are load-bearing:
   *
   * - the session, because a phone driving a different repo must not rewind
   *   whatever happens to be focused at the desk — that is exactly the bug that
   *   forced the worktree rollback on 2026-08-07;
   * - the requester, because every message below used to be a native modal on
   *   the host. On a cloud machine there is nobody at that screen, and one of
   *   them was awaited, so the handler simply hung.
   */
  private async editLastMessage(
    userBubbleIndex: number,
    text: string,
    totalUserBubbles?: number,
    session: Session = this.focused,
    requester?: RemoteRequester,
  ): Promise<void> {
    if (!session.client || !session.activeSessionId) {
      return void this.reportRequester(requester, "warning", "Start a session before editing a message.");
    }
    if (session.status === "working" || session.status === "needs-you") {
      // Name the state. "Wait for the current turn" is useless when the turn
      // already finished and the status is merely stale — the user can't tell
      // those apart, and neither could I without this line.
      this.host.appendLine(
        `[edit] refused: session.status=${session.status} bubble=${userBubbleIndex}`,
      );
      return void this.reportRequester(
        requester,
        "warning",
        session.status === "needs-you"
          ? "Answer the pending permission or plan card first, then edit your last message."
          : "Wait for the current turn to finish (or Stop it) before editing your last message.",
      );
    }
    const { client, gen, activeSessionId, userMessageCount } = session;
    try {
      const points = await client.listRewindPoints();
      if (points === "unsupported") {
        return void this.reportRequester(
          requester,
          "warning",
          "Editing a sent message needs a newer Grok Build CLI. Update via Settings → About.",
        );
      }
      // If the wire's user-facing list no longer matches what the user sees, the
      // bubble->point map can't be trusted — refuse instead of reverting a turn
      // we may have mis-identified. See bubbleMapIsConsistent.
      if (!bubbleMapIsConsistent(points, totalUserBubbles)) {
        this.host.appendLine(
          `[rewind] map mismatch: ${userFacingRewindPoints(points).length} wire points vs ${totalUserBubbles} visible messages`,
        );
        return void this.reportRequester(
          requester,
          "warning",
          "Grok's restore points no longer line up with this conversation, so rewinding could remove the wrong turn. Reload the window and try again.",
        );
      }
      const target = resolveEditRewindTarget(points, userBubbleIndex);
      if (!target) {
        // Was a modal offering "Copy text to composer" and awaiting the click.
        // Nobody can click it on a cloud machine, so the handler hung there —
        // and the button was the only sensible answer anyway. Do it, and say so.
        this.restoreComposerFor(session, requester, text);
        return void this.reportRequester(
          requester,
          "info",
          "Grok has no restore point for that message, so it can't be rolled back. Its text is back in the composer.",
        );
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

      // Another view can start a turn or replace the client while we await
      // the points or confirmation. The count catches even a finished turn;
      // the old target must not reach that work.
      if (
        session.client !== client || session.gen !== gen || session.activeSessionId !== activeSessionId ||
        session.userMessageCount !== userMessageCount ||
        ["working", "needs-you"].includes(session.status)
      ) {
        return void this.reportRequester(
          requester, "warning",
          "Edit cancelled because the conversation changed or another turn started. Nothing was rewound. Try Edit again when the conversation is idle.",
        );
      }
      const result = await client.executeRewind({
        targetPromptIndex: target.promptIndex,
        mode: "all",
      });
      if (result === "unsupported") {
        return void this.reportRequester(
          requester,
          "warning",
          "Editing a sent message needs a newer Grok Build CLI. Update via Settings → About.",
        );
      }
      if (!result.success) {
        // Surface the CLI's own words — e.g. rewinding past a compaction point.
        return void this.reportRequester(requester, "error", result.error || "Couldn't roll back that message.");
      }

      const reportedFiles = result.revertedFiles.length;
      this.host.appendLine(
        `[edit] rewound to prompt #${result.targetPromptIndex} (reported_files=${reportedFiles}, bubble=${userBubbleIndex})`,
      );
      const resumeId = session.activeSessionId;
      const surviving = survivingUserMessagesAfterRewind(points, target);
      await this.truncateSessionCardsAfterRewind(resumeId, surviving);
      this.applyRewindToView(session, surviving);
      this.restoreComposerFor(session, requester, text);
      if (reportedFiles > 0) {
        this.reportRequester(
          requester,
          "info",
          "Message moved back to the composer. Files were rolled back — anything created after that point may still be on disk.",
        );
      }
    } catch (e: any) {
      this.reportRequester(requester, "error", `Couldn't edit that message: ${e?.message ?? e}`);
    }
  }

  /**
   * Hand a rewound message back to the surface that ASKED for it, and only that
   * one.
   *
   * `restoreComposer` APPENDS to whatever is already typed — deliberately, since
   * silently destroying a draft is the bug Edit exists to fix. Sent through
   * `emit` it reaches the focused desk webview and every remote holder of the
   * session, so a phone tapping Edit would paste its message on top of an unsent
   * draft at the computer and steal focus there. Nobody at that desk asked for
   * it, and the appended text is the thing the usage model calls unacceptable.
   *
   * Reachable from a remote only since rewind/edit were widened, which is what
   * makes it a defect this change introduced; the desk-to-phone mirror of it was
   * always possible and is fixed by the same narrowing.
   *
   * The SESSION check is the half a first attempt at this dropped, and the
   * review caught it: `emit` delivered locally only while that session was
   * focused and remotely only to clients still holding it, so replacing it with
   * a plain "send to whoever asked" opened a worse hole than the one being
   * closed. Rewind is an RPC to the CLI and takes seconds; switching
   * conversation while it runs is ordinary impatience, not an exotic race, and
   * the text would have landed in a different conversation's composer — a
   * different REPOSITORY's, at that.
   */
  private restoreComposerFor(
    session: Session,
    requester: RemoteRequester | undefined,
    text: string,
  ): void {
    if (!text) return;
    const message: HostMsg = { type: "restoreComposer", text };
    if (requester) {
      // Resolve through the tab, so a phone that reconnected while the rewind
      // was in flight still receives its own text — then check the tab is still
      // ON this conversation. `sendRemoteRequester` alone would deliver to
      // whatever that tab is showing NOW.
      const clientId = this.resolveRemoteRequester(requester);
      if (clientId && this.remoteClients.active(clientId) === session) {
        this.sendRemoteClient(clientId, message);
        return;
      }
    } else if (this.focused === session) {
      // Same check for the desk: postLocal posts to the focused webview
      // whatever it is displaying.
      this.postLocal(message);
      return;
    }
    // The asking surface has moved to another conversation. Refusing to deliver
    // is only half an answer: the rewind has ALREADY removed the message from
    // the transcript, so dropping it here loses the user's text outright — the
    // failure the previous attempt traded the cross-session paste for.
    //
    // Park it on the conversation it belongs to instead. `rememberQueuedDraft`
    // exists for exactly this and says so: a conversation is the only place a
    // draft can be handed back without guessing who is watching what.
    const id = session.activeSessionId;
    if (!id) return;
    // APPEND, never replace. The slot holds one string, so a second rewind
    // parked before the first was collected would overwrite it — and the first
    // message is already gone from the transcript, so that loses it outright.
    // The webview's own `restoreComposer` appends for exactly this reason
    // ("anything already typed is the user's"); the store follows the same rule
    // rather than being the one place that silently drops a message.
    const parked = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]?.queuedDraft;
    void this.rememberQueuedDraft(id, parked ? `${parked}\n\n${text}` : text);
  }

  /** See {@link editLastMessage} for why `session` and `requester` are explicit. */
  async rewindFocusedSession(
    userBubbleIndex?: number,
    bubbleText?: string,
    totalUserBubbles?: number,
    session: Session = this.focused,
    requester?: RemoteRequester,
  ): Promise<void> {
    if (!session.client || !session.activeSessionId) {
      return void this.reportRequester(requester, "warning", "Start a session before rewinding it.");
    }
    if (session.status === "working" || session.status === "needs-you") {
      return void this.reportRequester(
        requester,
        "warning",
        "Wait for the current turn to finish (or Stop it) before rewinding.",
      );
    }
    if (!session.hasHistory) {
      return void this.reportRequester(requester, "info", "Nothing to rewind yet — this session has no conversation.");
    }
    const { client, gen, activeSessionId, userMessageCount } = session;
    try {
      const points = await client.listRewindPoints();
      if (points === "unsupported") {
        return void this.reportRequester(
          requester,
          "warning",
          "Rewind needs a newer Grok Build CLI. Update via Settings → About.",
        );
      }

      // If the wire's user-facing list no longer matches what the user sees, the
      // bubble->point map can't be trusted — refuse instead of reverting a turn
      // we may have mis-identified. See bubbleMapIsConsistent.
      if (!bubbleMapIsConsistent(points, totalUserBubbles)) {
        this.host.appendLine(
          `[rewind] map mismatch: ${userFacingRewindPoints(points).length} wire points vs ${totalUserBubbles} visible messages`,
        );
        return void this.reportRequester(
          requester,
          "warning",
          "Grok's restore points no longer line up with this conversation, so rewinding could remove the wrong turn. Reload the window and try again.",
        );
      }
      let target: ReturnType<typeof resolveUserBubbleRewind> = null;
      if (typeof userBubbleIndex === "number") {
        // Bubble button: map visible user bubble → wire prompt_index (skips legacy hidden turns).
        target = resolveUserBubbleRewind(points, userBubbleIndex);
        if (!target) {
          return void this.reportRequester(
            requester,
            "info",
            "Can't rewind to this message — it's the latest turn, or the checkpoint is unavailable.",
          );
        }
      } else if (requester) {
        // The picker below is a host QuickPick, which a remote cannot see or
        // answer — and on a cloud machine nobody can. Every remote rewind comes
        // from a bubble button and carries its index, so this is unreachable in
        // practice; it exists so that a future caller without one fails loudly
        // instead of opening a dialog on an empty screen.
        return void this.reportRequester(
          requester,
          "info",
          "Pick the message to rewind to using the Rewind button on that message.",
        );
      } else {
        // Gear / command palette: pick among user-facing points that aren't the tip.
        const facing = userFacingRewindPoints(points);
        const selectable = selectableRewindPoints(facing.length ? facing : points);
        if (selectable.length === 0) {
          return void this.host.showInformationMessage(
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
        const pick = await this.host.showQuickPick(items, {
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

      if (
        session.client !== client || session.gen !== gen || session.activeSessionId !== activeSessionId ||
        session.userMessageCount !== userMessageCount ||
        ["working", "needs-you"].includes(session.status)
      ) {
        return void this.reportRequester(
          requester, "warning",
          "Rewind cancelled because the conversation changed or another turn started. Nothing was rewound. Try Rewind again when the conversation is idle.",
        );
      }
      const result = await client.executeRewind({
        targetPromptIndex: target.promptIndex,
        mode: "all",
      });
      if (result === "unsupported") {
        return void this.reportRequester(
          requester,
          "warning",
          "Rewind needs a newer Grok Build CLI. Update via Settings → About.",
        );
      }
      if (!result.success) {
        const err = result.error || "Rewind did not apply (no changes).";
        return void this.reportRequester(requester, "error", err);
      }

      const reportedFiles = result.revertedFiles.length;
      this.host.appendLine(
        `[rewind] → prompt #${result.targetPromptIndex} (mode=${result.mode}, reported_files=${reportedFiles}` +
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
      if (restored) this.restoreComposerFor(session, requester, restored);
      // Only speak up when something happened the chat itself doesn't show.
      // The messages vanishing and the text landing in the composer are their
      // own feedback; a toast restating them is noise. Reverted files are NOT
      // visible in the chat, so those still get reported.
      if (reportedFiles > 0) {
        this.reportRequester(
          requester,
          "info",
          "Rewound. Files were rolled back — anything created after that point may still be on disk.",
        );
      }
    } catch (e: any) {
      this.reportRequester(requester, "error", `Rewind failed: ${e?.message ?? e}`);
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
      return void this.host.showWarningMessage("Missing workflow display name.");
    }
    await this.handleSend(cmd, true, session);
  }

  /** Workspace folder root (the main checkout for worktree ops). */
  private workspaceRoot(): string {
    const root = this.host.workspaceRoot();
    if (root) return root;
    // Desktop with an empty open set has no root — do not fall back to the
    // process cwd (that would create sessions under the install directory).
    if (this.host.canSwitchWorkspaceFolder) return "";
    return process.cwd();
  }

  /** Effective cwd for a session (worktree path or workspace root). */
  private sessionCwd(session: Session = this.focused): string {
    return session.cwd || this.workspaceRoot();
  }

  /** Resolve the same workspace/media path used by the chat openFile action. */
  private resolveChatOpenPath(session: Session, rawPath: string): {
    ref: ReturnType<typeof parseFileRef>;
    path: string;
  } {
    const ref = parseFileRef(rawPath);
    const { grokHome, sessionDir } = this.desktopOpenMediaContext(session);
    const resolved = resolveChatOpenFilePath({
      rawPath: ref.path,
      workspaceRoots: [this.sessionCwd(session)],
      sessionDir,
      grokHome,
      exists: (abs) => {
        try {
          return fs.statSync(abs).isFile();
        } catch {
          return false;
        }
      },
      realpath: (candidate) => fs.realpathSync(candidate),
      homeDir: os.homedir(),
    });
    return { ref, path: resolved };
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
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    await this.state.update(SESSION_META_KEY, {
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
  /**
   * Create an isolated worktree session. Authorization (git worktree list /
   * path containment) is unchanged for remote callers — only the label prompt
   * is skipped when `fromRemote` is true so a phone tap never stalls on a desk
   * input box (auto-named worktree instead).
   */
  async newWorktreeSession(opts?: { fromRemote?: boolean }): Promise<void> {
    // No worktree-from-worktree — checkouts stay singular. The gear hides this
    // inside a worktree; guard the Command-Palette path too.
    if (this.focused.worktree) {
      return void this.host.showInformationMessage(
        "You're already in a worktree. Start a new worktree from a normal session — worktrees don't nest.",
      );
    }
    // The CONVERSATION's repository — not the open folder, and not the rail's
    // selection either.
    //
    // Not the open folder, because a project-B conversation can be on screen in
    // a window opened on A: that made an A worktree out of a B conversation, and
    // Apply Worktree would later merge it into A. Not the selection, because
    // selecting a project in the rail changes the history scope and leaves the
    // focused conversation exactly where it was — "Continue in a worktree" is an
    // id-less action about the conversation in front of you, so a selection made
    // since would have branched from a checkout you never mentioned.
    //
    // One rule for every caller: a worktree is cut from the conversation it
    // continues. The Command Palette lands here too, and `focused` is the
    // conversation open there as well.
    const sourcePath = this.sessionCwd(this.focused);
    if (!isGitRepo(sourcePath, fs)) {
      return void this.host.showWarningMessage(
        "Worktree sessions need a git repository. Open a folder that is a git checkout (or run git init).",
      );
    }
    // One at a time. Creation reuses whatever live client the project already
    // has, and the CLI's progress notifications carry no worktree path — only
    // the terminal one does — so two overlapping creates on one client produce
    // events that cannot be told apart. Serialising is the honest fix; trying
    // to correlate uncorrelatable events is not. Nothing legitimate wants two
    // at once: this is a deliberate action, and only the desk can start it
    // (remote-policy keeps `newWorktreeSession` host-local).
    if (this.worktreeCreateInFlight) {
      return void this.host.showWarningMessage(
        "A worktree is already being created. Wait for it to finish before starting another.",
      );
    }
    this.worktreeCreateInFlight = true;
    try {
      await this.createWorktreeSession(sourcePath, opts);
    } finally {
      this.worktreeCreateInFlight = false;
    }
  }

  /** Guards {@link newWorktreeSession} against overlapping creates. */
  private worktreeCreateInFlight = false;

  /** The body of {@link newWorktreeSession}, run under its single-flight guard. */
  private async createWorktreeSession(
    sourcePath: string,
    opts?: { fromRemote?: boolean },
  ): Promise<void> {
    // Remote origin: skip the host input box (invisible to the phone). Local
    // and Command Palette still prompt for an optional label.
    let label = "";
    if (!opts?.fromRemote) {
      const rawLabel = await this.host.showInputBox({
        prompt: "Worktree label (optional)",
        placeHolder: "e.g. feat-auth — leave blank for an auto name",
        ignoreFocusOut: true,
      });
      if (rawLabel === undefined) return; // cancelled
      label = sanitizeWorktreeLabel(rawLabel);
    }

    await this.host.withProgress(
      { title: "Creating git worktree…", cancellable: false },
      async () => {
        try {
          // Create needs a live sessionId. Prefer a workspace-cwd client so we
          // don't pin a worktree to a session that already lives in another wt;
          // otherwise spin a short-lived ACP client just for the create RPC.
          const creator = await this.clientForWorktreeCreate(sourcePath);
          if (!creator) {
            return void this.host.showErrorMessage("Could not start Grok to create a worktree.");
          }
          const { client, disposeAfter } = creator;
          // Disposed after the LAST validation query, not here and not at the
          // end. Not here, because validation asks this same client for its
          // worktree list and killing it first made that call reject every time
          // — invisible for a linked worktree, which local git lists anyway,
          // and fatal for a clone-mode one, which only the ACP list mentions.
          // Not at the end either: a temporary `grok.exe` still running while
          // the new session starts holds the executable's file lock on Windows,
          // and the first session after an extension upgrade is when the silent
          // CLI updater runs — it would fail, and then record the version
          // anyway, so the update would be skipped for the whole release.
          let created;
          let creatorDisposed = false;
          const releaseCreator = async () => {
            if (creatorDisposed || !disposeAfter) return;
            creatorDisposed = true;
            const probeId = client.sessionId;
            await client.dispose();
            if (probeId) this.removeSessionFromDisk(probeId, sourcePath);
          };
          try {
            // The authoritative set BEFORE creating anything. Without it,
            // "is this path a worktree of this repo" is the only question the
            // validator can answer — and an existing SIBLING worktree passes
            // it. A response naming one would have been cached, opened,
            // persisted, made remotely targetable, and later applied or
            // removed as though we had just made it.
            const preExisting = await this.listAuthoritativeWorktreePaths(
              client,
              sourcePath,
              gitRootForPath(sourcePath, defaultFs) || sourcePath,
            );
            // Watch BEFORE the RPC. `createWorktree` returns while the status
            // is still "creating" and completion rides an event, so a small
            // repo can finish before the call even resolves — a listener
            // attached afterwards waits for something that already happened.
            const watch = this.watchWorktreeCreate(client);
            try {
              created = await client.createWorktree({
                sourcePath,
                label: label || undefined,
              });
            } catch (createErr) {
              watch.cancel();
              throw createErr;
            }
            if (created === "unsupported") {
              watch.cancel();
              return void this.host.showWarningMessage(
                "Worktrees need a newer Grok Build CLI. Update via Settings → About.",
              );
            }
            const wtPath = created.worktreePath;
            const wtLabel = label || path.basename(wtPath);
            this.host.appendLine(`[worktree] created ${wtPath} (label=${wtLabel})`);

            // Wait for the CLI to say it is DONE, not merely for the checkout
            // to exist. Registration happens before the files are copied, so
            // `.git` on disk and a `git worktree list` entry both appear while
            // the copy is still running — and the temporary creator we are
            // about to dispose is the process doing the copying. Killing it
            // then leaves a partial checkout that every later check calls
            // valid, with staged or untracked work silently absent.
            //
            // Bounded, and a timeout falls through to the disk checks rather
            // than failing: an older CLI may not emit the event at all, and
            // refusing a good worktree over a missing notification would be a
            // worse trade than the race it protects against.
            const outcome = await watch.settled(wtPath);
            if (outcome === "failed") {
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" was not created: the Grok CLI reported it failed.`,
              );
            }
            if (outcome === "stalled") {
              // It reported progress and then stopped. That is an unfinished
              // copy, not an old CLI — and the checks below cannot tell the
              // difference, because registration lands before the files do.
              this.host.appendLine(`[worktree] create reported progress then stalled: ${wtPath}`);
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" never finished being created, so no session was started. The partial checkout was left at ${wtPath}.`,
              );
            }
            if (outcome === "silent") {
              // Nothing at all was said about this create, so the CLI predates
              // the status event. The checks below are how this worked before
              // it existed — an unchanged risk rather than a new one.
              this.host.appendLine(`[worktree] no status reported for ${wtPath}; using disk checks`);
            }
            // create is ASYNC — the RPC returns "creating" before git writes the
            // checkout (its dir + `.git` pointer appear a beat later). Spawning a
            // session in a not-yet-existing cwd hangs the whole flow, so wait for
            // the checkout to land before validating or starting the session.
            const ready = await this.waitForWorktreeReady(wtPath, 30000);
            if (!ready) {
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" was created but its checkout never appeared on disk — the session wasn't started. Try again, or check \`git worktree list\`.`,
              );
            }

            // Validate against an authoritative worktree list before cache /
            // overrides / auth roots. A compromised or malformed ACP path must
            // not become a trusted session cwd.
            //
            // The root we QUERY is derived locally from the folder the user
            // actually asked to branch — never from the response. Taking
            // `created.sourceGitRoot` first (as this did) made the check answer
            // itself: the same value arrived as both the claim and the thing the
            // claim was compared against, so it always matched. A response naming
            // repository B could then hand back a genuine worktree OF B, have git
            // truthfully list it, and be filed under A.
            const sourceGitRoot = gitRootForPath(sourcePath, defaultFs) || sourcePath;
            const claimedGitRoot = created.sourceGitRoot?.trim() || undefined;
            if (claimedGitRoot && !pathsEqual(claimedGitRoot, sourceGitRoot) && !pathsEqual(claimedGitRoot, sourcePath)) {
              this.host.appendLine(
                `[worktree] refused: create claims source ${claimedGitRoot}, but ${sourcePath} is in ${sourceGitRoot}`,
              );
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" came back attributed to a different repository, so no session was started.`,
              );
            }
            // Ask more than once. The create RPC returns as soon as git is asked,
            // and `waitForWorktreeReady` only proves the DIRECTORY exists — the
            // worktree can still be missing from `git worktree list` for a beat
            // after that. Validating on the first answer refused a perfectly good
            // checkout roughly 14ms after creating it: "not in git worktree list".
            //
            // This weakens nothing. The path must still appear in an authoritative
            // list; it is only given the moment it needs to get there.
            let listedPaths = await this.listAuthoritativeWorktreePaths(
              client,
              sourcePath,
              sourceGitRoot,
            );
            for (let attempt = 0; attempt < 6; attempt++) {
              if (listedPaths.some((p) => pathsEqual(p, wtPath))) break;
              await new Promise((r) => setTimeout(r, 250));
              listedPaths = await this.listAuthoritativeWorktreePaths(
                client,
                sourcePath,
                sourceGitRoot,
              );
            }
            if (
              !worktreePathAuthorizedForRepo({
                worktreePath: wtPath,
                sourceRepo: sourcePath,
                listedWorktreePaths: listedPaths,
                claimedSourceGitRoot: claimedGitRoot,
                sourceGitRoot,
              })
            ) {
              this.host.appendLine(
                `[worktree] refused unlisted/unauthorized path from create: ${wtPath}`,
              );
              // The CLI already wrote a checkout there — for a clone-mode repo, a
              // full copy of it. Refusing without saying so left the directory
              // behind silently, so the next attempt with the same label got a
              // "-2" suffix and the owner accumulated orphans they had no way to
              // see. We do not delete it: it is real work on disk and this path
              // is reached precisely when we could NOT establish what it is.
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" could not be confirmed as part of this repository, so no session was started. The checkout was left at ${wtPath} — remove it yourself if you don't want it.`,
              );
            }
            // "A worktree of this repo" is not the same claim as "the worktree
            // I just asked you to make". Every sibling passes the first test,
            // so a response naming one would take over a checkout somebody else
            // is working in — and Apply and Remove would then act on it.
            if (preExisting.some((p) => pathsEqual(p, wtPath))) {
              this.host.appendLine(
                `[worktree] refused: ${wtPath} already existed before this create`,
              );
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" already existed before this request, so no session was started. Open it from the conversation list instead.`,
              );
            }

            // Every question that needed the creator has been asked. Let it go
            // BEFORE the session starts — see the note where it was obtained.
            await releaseCreator();

            // Refresh cache only after validation.
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

            // Open a brand-new session whose process cwd is the worktree.
            this.parkFocused();
            // Held as an OBJECT across the await, never re-read from
            // `this.focused`. Focus is free to move while startup runs — the
            // user can click another conversation — and reading it back
            // afterwards wrote this worktree's name, path and source root onto
            // whatever session happened to be focused by then. A cold restore
            // later treats that saved binding as authoritative, so the wrong
            // conversation comes back believing it lives in the worktree.
            const wtSession = this.newLocalSession();
            this.focused = wtSession;
            this.pool.add(wtSession);
            wtSession.cwd = wtPath;
            wtSession.worktree = {
              path: wtPath,
              label: wtLabel,
              sourceGitRoot,
            };
            await this.startSession(undefined, wtSession);
            const id = wtSession.activeSessionId;
            if (id) {
              const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
              await this.state.update(SESSION_META_KEY, {
                ...overrides,
                [id]: {
                  ...(overrides[id] ?? {}),
                  customName: worktreeDisplayName(wtLabel),
                  worktreePath: wtPath,
                  worktreeLabel: wtLabel,
                  sourceGitRoot,
                },
              });
              this.sessionCache.delete(id);
            }
              this.postSessionsList();
              void this.host.showInformationMessage(
                `Worktree session ready: ${wtLabel}. Edits stay isolated until you Apply worktree.`,
              );
          } finally {
            // Belt: every early return above lands here too.
            await releaseCreator();
          }
        } catch (e: any) {
          void this.host.showErrorMessage(`Create worktree failed: ${e?.message ?? e}`);
        }
      },
    );
  }

  /**
   * Watch one worktree create through to completion.
   *
   * Started BEFORE the RPC, because the CLI can finish a small repo before the
   * call resolves — so events are BUFFERED until the path is known and then
   * replayed. The path arrives from the RPC's own answer, which is why this is
   * two steps rather than one call.
   *
   * Correlation is the point. Creation reuses whatever live client the project
   * already has, so two creates on one client interleave their notifications;
   * accepting the first terminal event on the client let one create's
   * completion release another's wait, and that other flow would then start in
   * a checkout still being copied. An event with a `worktreePath` must name
   * OURS. An event without one is only trusted while a single create is in
   * flight on that client, which is the ordinary case and the one older CLIs
   * produce.
   *
   * The timeout distinguishes two situations that look identical from here:
   *
   *  - the CLI never said ANYTHING about this create → it does not speak the
   *    status protocol. Fall through to the disk and git checks, which is how
   *    this worked before the event existed.
   *  - the CLI DID report progress and then went quiet → it speaks the
   *    protocol and the copy is genuinely unfinished. Registration happens
   *    before the files are copied, so the disk checks would call a partial
   *    checkout valid. Refuse instead.
   */
  private watchWorktreeCreate(client: AcpClient, timeoutMs = 120000) {
    const events: Array<{ status?: string; worktreePath?: string }> = [];
    let target: string | undefined;
    let settleNow: ((o: WorktreeCreateOutcome) => void) | undefined;
    // Whether this CLI has said ANYTHING about our create. It is what separates
    // "does not speak the protocol" from "spoke, then stopped", and it is only
    // trustworthy because creates are serialised: progress notifications carry
    // no worktree path, so attributing one depends on there being exactly one
    // create it could belong to.
    let spoke = false;

    const mine = (e: { worktreePath?: string }) =>
      worktreeStatusIsForCreate(e, {
        target,
        soleCreateInFlight: this.worktreeCreatesInFlight.sole(client),
      });
    const verdict = worktreeStatusVerdict;
    // Arrow, so `this` is the sidebar: the object returned below has methods
    // of its own and would shadow it.
    const clientReportsStatus = () => this.worktreeStatusCapableClients.has(client);
    let onActivity: (() => void) | undefined;
    const onStatus = (status: { status?: string; worktreePath?: string }) => {
      // ANY event on this client — ours or not — proves the CLI emits status
      // notifications. That fact outlives a single create, and it is the thing
      // that makes "we heard nothing, so this must be an old build" a safe
      // inference or a false one.
      this.worktreeStatusCapableClients.add(client);
      events.push(status || {});
      if (!settleNow || !target) return; // buffered; replayed once we know ours
      if (!mine(status)) return;
      // Any matched event counts, progress included — that is the whole point
      // of the flag. Only a terminal one settles the wait.
      spoke = true;
      onActivity?.();
      const outcome = verdict(status);
      if (outcome) settleNow(outcome);
    };

    // Taking the slot also registers the listener that releases it when the CLI
    // dies — at watch START, which is the whole point. `exit` is one-shot, so
    // registering it later (as this used to, only once a stall decided to hold
    // the slot) attaches to an event a crashed CLI has already emitted.
    // See WorktreeCreateSlots for the two properties and why they are there.
    const releaseSlot = this.worktreeCreatesInFlight.take(client);
    try {
      client.on("worktreeStatus", onStatus);
    } catch {
      /* a client that cannot subscribe simply never reports */
    }

    const detach = (opts?: { keepSlot?: boolean }) => {
      try {
        client.off?.("worktreeStatus", onStatus);
      } catch {
        /* best effort — a disposed client has nothing to detach from */
      }
      releaseSlot({ keep: opts?.keepSlot });
    };

    return {
      /** Abandon the watch without waiting (the RPC failed or was unsupported). */
      cancel: () => detach(),
      /** Wait for OUR create to finish, now that the RPC has named its path. */
      settled(worktreePath: string): Promise<WorktreeCreateOutcome> {
        target = worktreePath;
        return new Promise<WorktreeCreateOutcome>((resolve) => {
          let done = false;
          const timers: Array<ReturnType<typeof setTimeout>> = [];
          const finish = (outcome: WorktreeCreateOutcome) => {
            if (done) return;
            done = true;
            for (const t of timers) clearTimeout(t);
            // A stalled create is one we STOPPED WAITING FOR, not one that
            // ended: the CLI may still be copying. Releasing its slot would let
            // the next create believe it is the only one in flight and trust
            // pathless progress events that belong to this one. The listener is
            // dropped either way; only the count is held, and only until the
            // client goes.
            detach({ keepSlot: outcome === "stalled" });
            resolve(outcome);
          };
          settleNow = finish;
          // ONE clock, and a long one.
          //
          // A short "has it said anything yet" window was tried and was worse
          // than the problem: a create-capable CLI whose first notification is
          // slow, or whose copy simply takes longer, was classified as a build
          // that never reports and admitted through the disk checks — which
          // approve a half-copied checkout, because registration lands before
          // the files do. That widened the unsafe window from "copies over two
          // minutes" to "copies over five seconds".
          //
          // What running out MEANS still depends on whether it ever spoke.
          // Deleting that distinction along with the short clock was the
          // over-correction: a CLI that reported progress and then stopped is
          // an unfinished copy, and letting it fall through hands the disk
          // checks the partial checkout they are guaranteed to approve.
          //
          // IDLE, not elapsed. A fixed deadline calls a copy stopped for taking
          // long, which for a big repository it legitimately does — and the
          // protocol emits progress while copying, so quiet is the signal, not
          // duration. Every matched event restarts the clock; only silence
          // running out ends the wait.
          //
          // "Silent" is a claim about the CLI, not about this create, so it is
          // only safe while nothing has ever proved otherwise. A retry after a
          // stall cannot attribute its own progress — the abandoned create's
          // slot is still held, so pathless events are ambiguous by design —
          // and reading that as "old build, fall through to the disk checks"
          // would be provably wrong: the retained slot exists BECAUSE this
          // client reports. Fail closed there.
          const capable = () => spoke || clientReportsStatus();
          let idle: ReturnType<typeof setTimeout>;
          const arm = () => {
            clearTimeout(idle);
            idle = setTimeout(() => finish(capable() ? "stalled" : "silent"), timeoutMs);
            timers.push(idle);
          };
          onActivity = arm;
          arm();
          // Replay what arrived before the path was known.
          for (const e of events) {
            if (!mine(e)) continue;
            spoke = true;
            const outcome = verdict(e);
            if (outcome) return finish(outcome);
          }
        });
      },
    };
  }

  /**
   * Live creates per client, so an event with no `worktreePath` can be trusted
   * only when there is exactly one create it could belong to. Lifetime rules
   * and their reasons live on {@link WorktreeCreateSlots}.
   */
  private worktreeCreatesInFlight = new WorktreeCreateSlots();

  /**
   * Clients observed emitting `worktree/status` at least once.
   *
   * Kept per client rather than per create because it is a fact about the
   * BUILD, and it is what stops "we heard nothing" from being read as "this
   * CLI is too old" in a case where we already know better.
   */
  private worktreeStatusCapableClients = new WeakSet<AcpClient>();

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
    // The timeout fallback used to accept the bare directory. A directory with
    // no `.git` is not a checkout — it is what is left when creation failed
    // halfway — and calling it ready is how grok came to be spawned in an empty
    // folder and exit 1. If the loop above never saw a `.git`, there isn't one.
    return false;
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
    const cliPath = this.locateProvider("grok");
    if (!cliPath) return undefined;
    const client = new AcpClient({
      cliPath,
      cwd: sourcePath,
      env: this.buildEnv(sourcePath),
      log: (msg) => this.host.appendLine(msg),
      grokVersion: this.providerCliVersions.grok,
    });
    // Minimal handlers so the handshake doesn't hang on server requests.
    client.fsRead = async (p) => fs.readFileSync(p, "utf8");
    client.fsWrite = async () => { /* create-only client */ };
    // Owned by this client, so tearing it down takes its commands with it.
    client.terminal = this.terminalManager.ownedBy(client);
    await client.start();
    await client.newSession();
    return { client, disposeAfter: true };
  }

  /** Merge the given session's worktree back into the main checkout.
   *  `skipConfirm` = the webview's custom confirm dialog already ran. */
  async applyFocusedWorktree(session: Session = this.focused, skipConfirm = false): Promise<void> {
    const wt = session.worktree;
    if (!wt) {
      return void this.host.showInformationMessage(
        "This session is not in a worktree. Start one with Grok: New Worktree Session.",
      );
    }
    if (!session.client?.sessionId) {
      return void this.host.showWarningMessage("Start the session before applying its worktree.");
    }
    if (!skipConfirm) {
      const ok = await this.host.showWarningMessage(
        `Apply worktree "${wt.label}" into the main checkout?\n\n${wt.path}\n→ ${wt.sourceGitRoot || this.workspaceRoot()}`,
        { modal: true },
        "Apply",
      );
      if (ok !== "Apply") return;
    }
    try {
      const r = await session.client.applyWorktree(wt.path);
      if (r === "unsupported") {
        return void this.host.showWarningMessage(
          "Apply worktree needs a newer Grok Build CLI. Update via Settings → About.",
        );
      }
      const n = r.files?.length ?? 0;
      this.host.appendLine(`[worktree] apply ${wt.path}: ${n} file(s), status=${r.status}`);
      void this.host.showInformationMessage(
        n ? `Applied ${n} file${n === 1 ? "" : "s"} from worktree "${wt.label}".` : `Worktree "${wt.label}" applied (no file changes).`,
      );
    } catch (e: any) {
      void this.host.showErrorMessage(`Apply worktree failed: ${e?.message ?? e}`);
    }
  }

  /** Remove the given session's worktree (after disposing processes that use it).
   *  `skipConfirm` = the webview's custom confirm dialog already ran. */
  async removeFocusedWorktree(session: Session = this.focused, skipConfirm = false): Promise<void> {
    const wt = session.worktree;
    if (!wt) {
      return void this.host.showInformationMessage("This session is not in a worktree.");
    }
    if (!skipConfirm) {
      const ok = await this.host.showWarningMessage(
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
          // Detach, don't hand-roll: this used to drop the client without ending
          // the turn, so a cancel recovery armed before the removal still held a
          // live token and a matching generation and would respawn the session
          // against a checkout that no longer exists.
          this.detachClient(s)?.dispose();
          if (s !== session) this.pool.delete(s);
        }
      }
      // Need a live client for the remove RPC — use the target if still up, else temp.
      let client = session.client;
      let disposeAfter = false;
      if (!client) {
        const tmp = await this.clientForWorktreeCreate(this.workspaceRoot());
        if (!tmp) {
          return void this.host.showErrorMessage("Could not start Grok to remove the worktree.");
        }
        client = tmp.client;
        disposeAfter = tmp.disposeAfter;
      }
      let r;
      try {
        try {
          r = await client.removeWorktree(wt.path);
        } catch (rpcErr: any) {
          // The CLI refuses ("Internal error") for a checkout git does not
          // recognise as a worktree — which is exactly the clone-mode case,
          // where `git worktree remove` has nothing to remove. That left the
          // user with a directory they explicitly asked to delete, an error
          // they could do nothing about, and a row still in the rail.
          //
          // We delete it ourselves, but only where we can prove all three:
          // it lives under the grok worktrees root, it carries the marker
          // naming this repo, and it is not the repo itself. Anything less
          // and the error stands.
          const detail = rpcErr?.message ?? String(rpcErr);
          const refusal = this.canSelfRemoveWorktree(wt);
          if (refusal) {
            this.host.appendLine(`[worktree] self-remove refused: ${refusal}`);
            void this.host.showErrorMessage(
              `Remove worktree failed: ${detail}. The checkout at ${wt.path} was left alone because ${refusal}.`,
            );
            return;
          }
          this.host.appendLine(
            `[worktree] CLI remove failed (${detail}); removing the checkout directly`,
          );
          fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          r = { removed: true };
        }
      } finally {
        if (disposeAfter) {
          const probeId = client.sessionId;
          await client.dispose();
          if (probeId) this.removeSessionFromDisk(probeId, this.workspaceRoot());
        }
      }
      if (r === "unsupported") {
        return void this.host.showWarningMessage(
          "Remove worktree needs a newer Grok Build CLI. Update via Settings → About.",
        );
      }
      // WHO OWNED IT — captured before the records that answer that are erased.
      // `resolveLocalRepoTarget` finds the owning project by walking session
      // ownership, and the next few lines drop the worktree from the cache and
      // strip its bindings from session meta, after which the lookup returns
      // nothing and the fallback lands on the git ROOT. For a nested project
      // (`/repo/packages/app` inside a `/repo` checkout) that is one level up,
      // free to touch sibling packages — and on desktop, where `/repo` is not an
      // open folder, startSession refuses it and the promised replacement
      // conversation never appears at all.
      const worktreeOwnerCwd = this.resolveLocalRepoTarget(wt.path)?.cwd;
      this.worktreeCache = this.worktreeCache.filter((w) => !pathsEqual(w.path, wt.path));
      this.host.appendLine(`[worktree] removed ${wt.path} (removed=${r.removed})`);
      // Clear worktree binding on meta for sessions that pointed here.
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      let changed = false;
      const next: SessionMetaOverrides = { ...overrides };
      for (const [id, o] of Object.entries(overrides)) {
        if (o.worktreePath && pathsEqual(o.worktreePath, wt.path)) {
          const { worktreePath: _p, worktreeLabel: _l, sourceGitRoot: _s, ...rest } = o;
          next[id] = rest;
          changed = true;
        }
      }
      if (changed) await this.state.update(SESSION_META_KEY, next);
      session.worktree = undefined;
      // Leave the chat; start a normal session so the user isn't stuck — in the
      // repository this worktree was cut FROM, which is where the work goes back
      // to. The open folder was right only while conversations were pinned to
      // it; the rail can put you in another project entirely, and landing in the
      // window's folder then dropped you somewhere you had not been working.
      this.parkFocused();
      this.focused = this.newLocalSession();
      this.pool.add(this.focused);
      // The catalog PROJECT that owned the worktree (captured above), not its
      // git root — that is the relationship the rail draws, and where the work
      // goes back to.
      this.focused.cwd = worktreeOwnerCwd || wt.sourceGitRoot || this.historyCwdFor("local");
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
      void this.host.showInformationMessage(`Removed worktree "${wt.label}".`);
    } catch (e: any) {
      void this.host.showErrorMessage(`Remove worktree failed: ${e?.message ?? e}`);
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
    const sourceGitRoot = gitRootForPath(sourceRepo, defaultFs) ?? sourceRepo;
    try {
      const list = await client.listWorktrees({});
      if (list === "unsupported") return;
      // mergeWorktreeRefresh filters unattributed / wrong-repo rows.
      this.worktreeCache = mergeWorktreeRefresh(this.worktreeCache, sourceRepo, list, {
        sourceGitRoot,
      });
    } catch (e: any) {
      this.host.appendLine(`[worktree] list failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Authoritative worktree paths for `sourcePath`: prefer the CLI list RPC
   * (scoped to that client's repo), fall back to `git worktree list --porcelain`.
   */
  private async listAuthoritativeWorktreePaths(
    client: AcpClient,
    sourcePath: string,
    sourceGitRoot: string,
  ): Promise<string[]> {
    // git first, and ALWAYS — it is the only party here that cannot be wrong
    // about its own worktrees, and it is a local process that answers in
    // milliseconds. What used to happen: an ACP list with any attributed row
    // was returned as-is and git was consulted only when that list came back
    // empty. So a path the agent named, and nothing else could confirm, passed
    // a check whose whole job was to confirm it — which is how an EMPTY
    // DIRECTORY became a session cwd and grok exited 1 inside it.
    const gitPaths = await listGitWorktreePaths(sourceGitRoot || sourcePath, {
      log: (m) => this.host.appendLine(m),
    });
    const authorized = [...gitPaths];
    const add = (p: string) => {
      if (p && !authorized.some((existing) => pathsEqual(existing, p))) authorized.push(p);
    };
    try {
      const list = await client.listWorktrees({});
      if (list !== "unsupported" && Array.isArray(list)) {
        // ACP rows still need corroboration, but a CLONE-mode checkout has a
        // second kind of proof available: the marker the CLI writes inside it.
        // Those never appear in the source repo's `git worktree list` — they
        // are separate repositories — so before this they were refused outright
        // and the feature simply did not work for any repo the CLI clones.
        for (const row of filterWorktreesForSourceRepo(list, sourcePath, { sourceGitRoot })) {
          // git already vouched for it — asking for a clone marker as well would
          // fail every LINKED worktree and log an alarming line about a checkout
          // that is perfectly valid.
          if (authorized.some((p) => pathsEqual(p, row.path))) continue;
          if (this.cloneWorktreeBelongsTo(row.path, sourcePath, sourceGitRoot)) add(row.path);
        }
      }
    } catch (e: any) {
      this.host.appendLine(`[worktree] listWorktrees for validate failed: ${e?.message ?? e}`);
    }
    return authorized;
  }

  /**
   * Whether we may delete this checkout ourselves after the CLI refused to.
   *
   * A recursive delete is the most destructive thing in this file, so the fence
   * is deliberately narrow — the user's confirmation already said "this deletes
   * the isolated checkout", and this decides only whether the thing in front of
   * us IS an isolated checkout. Location is necessary but never sufficient; on
   * top of it we need ONE of two positive answers:
   *
   *  - **nothing to lose** — the directory is gone or empty. This is the common
   *    case in practice, and the one that kept the owner stuck: the CLI deletes
   *    the contents and THEN fails to deregister, so by the time it reports
   *    "Internal error" the checkout is already an empty folder with no marker,
   *    no `.git`, and nothing left to prove anything with. Refusing there is
   *    refusing to delete an empty directory the user asked us to delete.
   *  - **provenance** — the clone marker names the repo it claims to come from,
   *    for a checkout that still has contents worth being careful about.
   *
   * Returns the reason on refusal so the error the user sees can say it.
   */
  private canSelfRemoveWorktree(wt: { path: string; sourceGitRoot?: string }): string | undefined {
    const target = wt?.path;
    // The session's own binding carries only the git root; the cache has the
    // full record when we have one. Either way this is the repo the MARKER has
    // to name — get it wrong and the check fails closed, which is the point.
    const cached = this.worktreeCache.find((w) => pathsEqual(w.path, target));
    const source = cached?.sourceRepo || wt?.sourceGitRoot || this.workspaceRoot();
    if (!target || !path.isAbsolute(target)) return "no absolute path to remove";
    const root = path.join(resolveGrokHome(), "worktrees");
    if (!relativePathWithin(root, target)) return `it is outside ${root}`;
    if (pathsEqual(target, root)) return "it is the worktrees root itself";
    if (source && pathsEqual(target, source)) return "it is the source repository";
    for (const folder of this.openWorkspaceFolders()) {
      if (pathsEqual(target, folder)) return "it is an open folder";
    }
    let contents: string[] | undefined;
    try {
      contents = fs.readdirSync(target);
    } catch {
      // Already gone — the CLI removed it and then failed on the bookkeeping.
      return undefined;
    }
    if (!contents.length) return undefined;
    if (!source) return "the source repository is unknown";
    if (this.cloneWorktreeBelongsTo(target, source, gitRootForPath(source, defaultFs) || source)) {
      return undefined;
    }
    return `it has contents but no ${CLONE_WORKTREE_SOURCE_MARKER} naming ${source}`;
  }

  /**
   * Whether `worktreePath` carries an on-disk marker naming `sourceRepo`.
   *
   * The I/O wrapper around {@link cloneWorktreeSourceMatches} — kept here so the
   * decision itself stays pure and testable, and so every refusal says why in
   * the log rather than leaving the owner with "not in git worktree list" for a
   * checkout that was never going to be in one.
   */
  private cloneWorktreeBelongsTo(
    worktreePath: string,
    sourceRepo: string,
    sourceGitRoot: string,
  ): boolean {
    // LOCATION FIRST, and it is not optional. A marker is a file, and a file is
    // something whoever proposed the path can write — so on its own it proves
    // only that the proposer touched that directory, not that we made it. Grok
    // creates clone-mode worktrees under its own root and nowhere else, so
    // anything outside that root is not one of ours whatever it contains.
    // Canonical, because a symlink planted inside the root and pointing
    // somewhere else entirely would satisfy a textual prefix check.
    //
    // The DELETE path already demanded this. Authorization is the more
    // dangerous of the two: it ends with a Grok process running in that
    // directory, the path persisted on the session, and the path in the
    // trusted-cwd set a linked remote is allowed to target.
    const root = path.join(resolveGrokHome(), "worktrees");
    if (!isCanonicallyInsideRoot(root, worktreePath)) {
      this.host.appendLine(
        `[worktree] refused clone provenance for ${worktreePath}: outside ${root}`,
      );
      return false;
    }
    const ok = cloneWorktreeSourceMatches({
      worktreePath,
      sourceRepo,
      sourceGitRoot,
      readMarker: (markerPath) => fs.readFileSync(markerPath, "utf8"),
      joinPath: (a, b) => path.join(a, ...b.split("/")),
    });
    if (!ok) {
      this.host.appendLine(
        `[worktree] no clone provenance for ${worktreePath} (expected ${CLONE_WORKTREE_SOURCE_MARKER} naming ${sourceRepo})`,
      );
    }
    return ok;
  }

  /** Every open workspace folder root (desktop multi-folder, or VS Code folders). */
  private openWorkspaceFolders(): string[] {
    try {
      const folders = this.host.workspaceFolders?.() ?? [];
      if (folders.length) return folders;
    } catch {
      /* fall through */
    }
    const root = this.workspaceRoot();
    return root ? [root] : [];
  }

  /**
   * Hand-added project folders (VS Code only — see EXTRA_PROJECT_FOLDERS_KEY).
   *
   * Not filtered for existence here: `discoverRepos` stats every trusted cwd and
   * drops the ones that are gone, so a deleted folder disappears from the rail
   * on its own without this having to police the stored list.
   */
  private extraProjectFolders(): string[] {
    const raw = this.state.get<string[]>(EXTRA_PROJECT_FOLDERS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is string => typeof c === "string" && !!c && path.isAbsolute(c));
  }

  /** Normalised keys of folders the user removed — see REMOVED_PROJECT_FOLDERS_KEY. */
  private removedProjectFolderKeys(): Set<string> {
    const raw = this.state.get<string[]>(REMOVED_PROJECT_FOLDERS_KEY, []);
    if (!Array.isArray(raw)) return new Set();
    return new Set(
      raw.filter((c): c is string => typeof c === "string" && !!c).map((c) => normalizeRepoPath(c)),
    );
  }

  /**
   * Whether this host offers "Add project" at all.
   *
   * Two different meanings behind one control: desktop opens the folder for
   * real, VS Code records it for the rail ({@link EXTRA_PROJECT_FOLDERS_KEY}).
   * Every local host can do one or the other, so this is flat true — it exists
   * as a method because the two call sites read better for it and because the
   * next host that cannot will want one place to say so.
   *
   * Deliberately NOT `canSwitchWorkspaceFolder`, which is what it used to be:
   * that flag means "this host owns its own workspace", which VS Code does not
   * and must not start claiming. Remotes are excluded twice over — the message
   * is `host-local` at the policy gate, and the client never paints a control
   * that opens a native dialog the phone could not see.
   */
  private canAddProjectFolder(): boolean {
    return true;
  }

  private repoCatalog() {
    const pins = this.state.get<RepoPins>(REPO_PINS_KEY, {});
    const worktreeLabels = new Map<string, string>();
    for (const o of Object.values(this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {}))) {
      if (o.worktreePath && o.worktreeLabel) {
        worktreeLabels.set(normalizeRepoPath(o.worktreePath), o.worktreeLabel);
      }
    }
    for (const wt of this.worktreeCache) {
      worktreeLabels.set(normalizeRepoPath(wt.path), wt.label);
    }
    const discovered = discoverRepos({
      fs: defaultFs,
      grokHome: resolveGrokHome(process.env),
      pins,
      archives: this.host.canArchiveRepos
        ? this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {})
        : undefined,
      // Colours are host-persisted on every surface that has a rail (desktop +
      // AFK Pilot). Always passed so every row carries `color` (possibly "") —
      // field presence is the client capability probe.
      colors: this.state.get<RepoColors>(REPO_COLORS_KEY, {}),
      tmpDir: os.tmpdir(),
      // Open folders remain selectable before Grok creates a catalog row (and
      // bypass managed-worktree exclusion when the user opened a worktree).
      // Hand-added folders join them: on VS Code that is the only thing keeping
      // a never-used project in the rail, since it has no session history to be
      // discovered from.
      trustedCwds: [...this.openWorkspaceFolders(), ...this.extraProjectFolders()],
      worktreeLabels,
      log: (m) => this.host.appendLine(m),
    });
    // Tombstoned folders are dropped HERE, at the single source, not in the
    // display list. `localTrustedSessionCwds` reads this catalog directly on VS
    // Code, so filtering only what the rail draws would have left a removed
    // project invisible but still authorized — the row would be gone while the
    // phone carried on browsing and editing it.
    const removed = this.removedProjectFolderKeys();
    if (!removed.size) return discovered;
    // A folder VS Code actually has OPEN outranks its own tombstone. Removal
    // refuses to tombstone the open folder, but one written while the folder was
    // CLOSED still applied when it was opened later: the project vanished from
    // the rail, `postRepoCatalog` silently selected a different one, so History
    // and New Session pointed somewhere other than the Explorer — while the root
    // stayed authorized for remotes the whole time, invisibly. Opening a folder
    // is a louder statement of intent than having once removed its row.
    for (const open of this.openWorkspaceFolders()) removed.delete(normalizeRepoPath(open));
    if (!removed.size) return discovered;
    return discovered.filter((r) => !removed.has(normalizeRepoPath(r.cwd)));
  }

  /**
   * Project rows for the local rail (and, on desktop, for remotes attached to
   * this host). Desktop multi-folder: only open project folders. VS Code: the
   * full discoverRepos catalog. Archive fields are stripped when the host
   * cannot archive ({@link Host.canArchiveRepos}) so the client hides Project
   * Archive without an `IS_DESKTOP` flag.
   */
  private localRepoCatalogEntries(): RepoListEntry[] {
    const full = this.repoCatalog();
    let entries: RepoListEntry[];
    if (!this.host.canSwitchWorkspaceFolder) {
      // Hand-added rows are marked so the rail can offer to take them back out.
      // A folder added by hand is the one kind of catalog row the user cannot
      // otherwise revoke: everything else is here because Grok has run there,
      // and stops being listed when that stops being true.
      const added = new Set(this.extraProjectFolders().map((c) => normalizeRepoPath(c)));
      entries = added.size
        ? full.map((r) => (added.has(normalizeRepoPath(r.cwd)) ? { ...r, added: true } : r))
        : full;
    } else {
      const open = this.openWorkspaceFolders();
      // Empty open set → empty rail (user may Add Project Folder). Never fall
      // back to the historical catalog — that reopened the trust hole.
      if (!open.length) {
        entries = [];
      } else {
        const byKey = new Map(full.map((r) => [normalizeRepoPath(r.cwd), r]));
        entries = [];
        for (const cwd of open) {
          const key = normalizeRepoPath(cwd);
          const hit = byKey.get(key);
          if (hit) {
            entries.push(hit);
            continue;
          }
          // Trusted open folder with no catalog row yet — still show it.
          // Colour still comes from the shared store so a painted project
          // keeps its tint when Grok has not created a sessions catalog yet.
          const colors = this.state.get<RepoColors>(REPO_COLORS_KEY, {});
          const colorChoice = colors[key]?.color;
          const archiveChoice = this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {})[key];
          entries.push({
            cwd,
            label: path.basename(cwd) || cwd,
            available: true,
            pinned: false,
            updatedAt: 0,
            archived: !!archiveChoice?.archived,
            archivedAt: archiveChoice?.at ?? 0,
            // Stored choices are non-empty ids; missing/invalid → "" for none.
            color: colorChoice && (REPO_COLOR_IDS as readonly string[]).includes(colorChoice)
              ? colorChoice
              : "",
          });
        }
      }
    }
    return this.applyArchiveCapability(entries);
  }

  /** Drop archive fields when the host does not support archiving. */
  private applyArchiveCapability(entries: RepoListEntry[]): RepoListEntry[] {
    if (this.host.canArchiveRepos) return entries;
    return entries.map((e) => withoutArchiveFields(e) as RepoListEntry);
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

  /**
   * Authorization epoch — bumped on open/close of a project folder so any
   * capability that cached "was authorized" can detect revocation. The live
   * check is always {@link isAuthorizedCwd} against the current open set.
   */
  private authEpoch = 0;

  /**
   * **Single authorization query** for session/process/remote/image use:
   * is this cwd currently in the host-trusted set?
   *
   * Desktop: open folders + worktrees authorized for sessions within them
   * (`localTrustedSessionCwds`). VS Code: full historical catalog (v3.1.0).
   * All call sites (remote target, start/resume, image handles, desktop auth
   * roots via the same trusted set) consult this rather than re-deriving.
   */
  private isAuthorizedCwd(cwd: string | undefined): boolean {
    if (!cwd) return false;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    return cwdIsAuthorized(cwd, this.localTrustedSessionCwds(overrides), pathsEqual);
  }

  /** Snapshot of currently authorized session cwds (same set as isAuthorizedCwd). */
  private authorizedSessionCwds(): string[] {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    return this.localTrustedSessionCwds(overrides);
  }

  /** Retire choices superseded by transcript activity, including worktrees.
   *  Store maintenance only, performed when publishing the catalog. */
  private normalizeArchiveChoices(): void {
    if (!this.host.canArchiveRepos) return;
    const archives = this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {});
    if (!Object.keys(archives).length) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const grokHome = resolveGrokHome(process.env);
    const expired = expiredArchiveChoiceKeys({
      archives,
      newestActivityAt: (cwd: string) => {
        let newest = 0;
        for (const c of this.sessionCwdsForRepo(cwd, overrides)) {
          const at = newestTranscriptMtime({ fs: defaultFs, grokHome, cwd: c });
          if (at > newest) newest = at;
        }
        return newest;
      },
    });
    if (!expired.length) return;
    const next: RepoArchives = { ...archives };
    for (const key of expired) {
      this.host.appendLine(`[archive] ${next[key]?.cwd ?? key} has been worked in since — its archive choice no longer applies`);
      delete next[key];
    }
    void this.state.update(REPO_ARCHIVES_KEY, next);
  }

  private remoteTargetableCwd(cwd: string): boolean {
    if (!cwd) return false;
    return cwdIsAuthorized(cwd, this.authorizedSessionCwds(), pathsEqual);
  }

  private postRepoCatalog(): void {
    this.normalizeArchiveChoices();
    // Both local and remote attached clients see the host's catalog: curated
    // open folders on desktop, full discovery on VS Code. Archive fields only
    // when canArchiveRepos (already applied inside localRepoCatalogEntries).
    const localEntries = this.localRepoCatalogEntries().map((entry) => ({
      ...entry,
      defaultProvider: this.defaultProviderForProject(entry.cwd),
    }));
    const activeCwd = this.sessionCwd(this.focused);
    const selectedKey = normalizeRepoPath(this.selectedHistoryCwd());
    const selected = localEntries.find((r) => normalizeRepoPath(r.cwd) === selectedKey);
    // The selection MUST name a row in the catalog. `clearAllSessions` and
    // `selectRepo` both resolve through it and bail when the lookup misses, so
    // a selection that isn't there turns a confirmed "Delete All" into a silent
    // no-op. Falling back to the workspace root is always valid when a root is
    // open — it's a trusted cwd. Empty desktop rail: clear the selection.
    const inLocal = (cwd: string) =>
      !!cwd && localEntries.some((r) => normalizeRepoPath(r.cwd) === normalizeRepoPath(cwd));
    if (selected && inLocal(selected.cwd)) this.selectedRepoCwd = selected.cwd;
    else if (inLocal(activeCwd)) this.selectedRepoCwd = activeCwd;
    else {
      const root = this.host.workspaceRoot();
      this.selectedRepoCwd = root && inLocal(root) ? root : (localEntries[0]?.cwd ?? "");
    }
    // Both hosts follow the selection the LOCAL user made. VS Code used to be
    // pinned to its own workspace root — a rule from when remote showed one
    // project at a time and VS Code had no rail. Now that both have one,
    // history stuck on the open folder while the chat shows another project's
    // conversation is simply wrong: the user picked that conversation.
    //
    // A remote still cannot drag this view. `selectRepo` routes by origin —
    // `selectRemoteRepo` per client for remotes — so `selectedRepoCwd` is
    // written by LOCAL selection only. That is what keeps the destructive
    // actions this frame feeds (Clear-all's target, and the project name in its
    // confirm dialog) aimed somewhere the user can actually see.
    //
    // Desktop multi-folder already worked this way: selectedCwd tracks the open
    // folder the user chose, and may equal the active session cwd once a switch
    // settles.
    const localSelected = this.selectedRepoCwd || this.workspaceRoot() || "";
    this.postLocal({
      type: "repos",
      entries: localEntries,
      selectedCwd: localSelected,
      activeCwd,
      // Local only. The remote frame below deliberately omits it: adding a
      // project opens a native folder dialog on the desk, which a phone can
      // neither see nor answer (remote-policy: `addProjectFolder` is host-local).
      canAddProject: this.canAddProjectFolder(),
      canCreateProject: this.canAddProjectFolder(),
      canCloneProject: this.canAddProjectFolder(),
      // What the EDITOR has open, sent alongside the selection rather than
      // instead of it — the rail needs both to say "you are working here, your
      // window is there".
      workspaceCwd: this.workspaceRoot() || "",
    });
    for (const clientId of this.remoteClients.clients()) {
      this.sendRemoteClient(clientId, this.buildRemoteReposMsg(clientId, localEntries));
    }
  }

  /**
   * Remote `repos` frame with project-bearing fields scrubbed to the live
   * authorized set. Per-tab state may still name a closed cwd (inbound refuse);
   * the wire never does — {@link mayDeliverRemoteHostMsg} rejects otherwise.
   */
  private buildRemoteReposMsg(
    clientId: string,
    entries: RepoListEntry[] = this.localRepoCatalogEntries().map((entry) => ({
      ...entry,
      defaultProvider: this.defaultProviderForProject(entry.cwd),
    })),
  ): HostMsg {
    const authorized = this.authorizedSessionCwds();
    const selectedCwd =
      authorizedListCwd(this.remoteClients.cwdIfPresent(clientId), authorized, pathsEqual) ?? "";
    const active = this.remoteClients.active(clientId);
    let activeCwd = selectedCwd;
    if (active) {
      const sc = this.sessionCwd(active);
      if (authorizedListCwd(sc, authorized, pathsEqual)) activeCwd = sc;
    }
    // Per-tab fields and rows must still exclude projects actually removed.
    const reachable = entries.filter((r) => cwdIsAuthorized(r.cwd, authorized, pathsEqual));
    return {
      type: "repos",
      // Same catalog as local, less what a remote may not reach.
      entries: reachable,
      selectedCwd,
      activeCwd,
    };
  }

  private sendRemoteRepoCatalog(clientId: string): void {
    this.sendRemoteClient(clientId, this.buildRemoteReposMsg(clientId));
  }

  /**
   * Resolve a renderer/local `cwd` against the host-owned local catalog only.
   * Desktop: open folders (via {@link localRepoCatalogEntries}). VS Code: the
   * full historical catalog (same helper returns the full list when the host
   * cannot switch folders). A registered worktree cwd resolves to its owning
   * catalog row through {@link sessionCwdsForRepo}. Never the remote
   * full-catalog-or-fallback probe.
   */
  private resolveLocalRepoTarget(cwd: string): RepoListEntry | undefined {
    const entries = this.localRepoCatalogEntries();
    let hit = entries.find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) {
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      // Ownership resolves by GIT ROOT, so every open folder sharing one
      // checkout claims the same worktree — two sibling monorepo packages both
      // answer yes. Taking the first would silently pick whichever the catalog
      // listed first, which is normally just the active folder, so an ambiguous
      // claim is treated as no claim.
      const owners = entries.filter(
        (r) =>
          r.available
          && this.sessionCwdsForRepo(r.cwd, overrides).some((c) => pathsEqual(c, cwd)),
      );
      hit = owners.length === 1 ? owners[0] : undefined;
    }
    if (!hit || !hit.available) return undefined;
    return hit;
  }

  /** Answer `listRepoSessions`: the newest few sessions for ONE repo, without
   *  making it the client's selection. `cwd` is matched against the catalog the
   *  client was already sent. Unknown and unavailable paths receive the same
   *  coarse empty refusal, so a remote cannot use the answer to probe whether
   *  an arbitrary path exists on the host. Both local and remote use
   *  {@link localRepoCatalogEntries} (open folders on desktop, full catalog on
   *  VS Code) so the preview scope cannot exceed the trust set. */
  private buildRepoSessionsPreview(
    cwd: string,
    limit: number | undefined,
    activeId: string | null | undefined,
    scope: "local" | "remote" = "local",
  ): HostMsg {
    const hit = this.resolveLocalRepoTarget(cwd);
    if (!hit || !hit.available) {
      this.host.appendLine(`[rail] listRepoSessions failed: project unavailable (${scope})`);
      return { type: "repoSessions", cwd, entries: [], dots: {}, total: 0, error: "project-unavailable" };
    }
    // Clamp: the rail wants a handful, and an unbounded limit would make every
    // repo row a full history read.
    const size = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || REPO_PREVIEW_SIZE));
    const list = this.buildSessionsList(
      hit.cwd,
      { offset: 0, limit: size },
      activeId,
    );
    if (list.type !== "sessions") {
      this.host.appendLine(`[rail] listRepoSessions failed: session list unavailable (${scope})`);
      return { type: "repoSessions", cwd: hit.cwd, entries: [], dots: {}, total: 0, error: "sessions-unavailable" };
    }
    return {
      type: "repoSessions",
      // The host's own spelling, not the one the client sent — the rail keys its
      // rows on this, and echoing an arbitrary casing would split one repo into
      // two rail entries.
      cwd: hit.cwd,
      entries: list.entries,
      dots: list.dots,
      total: list.total,
    };
  }

  private sendRepoSessionsPreview(clientId: string, cwd: string, limit?: number): void {
    const msg = this.buildRepoSessionsPreview(
      cwd,
      limit,
      this.remoteActiveSessionId(clientId),
      "remote",
    );
    this.sendRemoteClient(clientId, msg);
  }

  private sendLocalRepoSessionsPreview(cwd: string, limit?: number): void {
    const msg = this.buildRepoSessionsPreview(
      cwd,
      limit,
      this.focused.activeSessionId,
      "local",
    );
    this.postLocal(msg);
  }

  /**
   * Local repo selection. VS Code: history-scope only (workspace does not move).
   * Desktop multi-folder: re-homes the active folder and conversation — same
   * "newest real session or new" rule as {@link selectRemoteRepo}.
   * Desktop only accepts open folders; a closed historical catalog path is refused.
   */
  private async selectRepo(cwd: string): Promise<void> {
    const hit = this.resolveLocalRepoTarget(cwd);
    if (!hit) return;

    if (this.host.canSwitchWorkspaceFolder) {
      await this.switchLocalWorkspaceFolder(hit.cwd);
      return;
    }

    this.selectedRepoCwd = hit.cwd;
    this.postRepoCatalog();
    this.postSessionsList();
  }

  /**
   * Desktop multi-folder: switch the host's active folder for project browsing.
   * Reuses the host's active-folder path; session selection remains a separate
   * action.
   *
   * Serialized on {@link localWorkspaceSwitchQueue} so concurrent `selectRepo`
   * cannot interleave. The target cwd is captured once for the whole action —
   * never re-read from a shared active-root field after an await.
   */
  private async switchLocalWorkspaceFolder(
    cwd: string,
    options: { warnOnRefusal?: boolean } = {},
  ): Promise<void> {
    const target = cwd;
    return this.localWorkspaceSwitchQueue.run(() =>
      this.switchLocalWorkspaceFolderExclusive(target, options),
    );
  }

  private async switchLocalWorkspaceFolderExclusive(
    target: string,
    options: { warnOnRefusal?: boolean } = {},
  ): Promise<void> {
    const prevRoot = this.workspaceRoot();
    // What the LIST depends on: which folder is active, and which project the
    // rail has selected. Following a session into the project you are already in
    // moves neither, and rebuilding for that walked the whole session catalog to
    // produce the list already on screen. Captured before either can move.
    const prevSelected = this.selectedRepoCwd;
    const listMayHaveChanged = () =>
      !pathsEqual(target, prevRoot) || !pathsEqual(prevSelected ?? "", this.selectedRepoCwd ?? "");
    if (!pathsEqual(target, prevRoot)) {
      // A rejected host call must abort — never treat setActive as advisory
      // and then open history / spawn an agent against the refused path.
      if (!this.host.setActiveWorkspaceFolder(target)) {
        this.host.appendLine(
          `[workspace] refused setActiveWorkspaceFolder (not an open folder): ${target}`,
        );
        // Explicit project selection is actionable, so keep its warning. A
        // resume only tries to keep the file-tree view in sync; its session
        // must still open when the view switch is refused.
        if (options.warnOnRefusal !== false) {
          void this.host.showWarningMessage(
            `That folder is not open in this app:\n${target}`,
          );
        }
        return;
      }
    }
    this.selectedRepoCwd = target;
    this.postRepoCatalog();

    // Already focused on this folder's live conversation — just refresh chrome.
    if (pathsEqual(this.sessionCwd(this.focused), target) && this.focused.client) {
      if (listMayHaveChanged()) this.postSessionsList();
      return;
    }

    // Selecting a project shows you what is in it, and touches NOTHING else.
    //
    // It used to open that project's newest conversation, so a glance at
    // another project silently moved you into it and spawned an agent there.
    // The first fix replaced that with a blank session, which was the same
    // mistake in a quieter form — the conversation you were reading still went
    // away. Browsing the rail is not a decision to leave what you are doing:
    // you must be able to open and fold projects freely while a turn runs, and
    // come back to it untouched.
    //
    // So the focused session is deliberately left alone here. The host's active
    // folder does move, which is what decides where NEW work lands and which
    // files the panel lists — but file access is scoped to the asking session
    // (see desktopAuthRoots), so a conversation in another project keeps
    // reaching its own files and only its own.
    this.postRepoCatalog();
    if (listMayHaveChanged()) this.postSessionsList();
  }

  /**
   * Roots the desktop trust boundary may open files under, for THIS session.
   *
   * Two conditions, both necessary. The folder must be in the host-owned open
   * set — never a historical catalog cwd the user has not opened — AND it must
   * belong to the session the message came from. The second used to be missing:
   * the parameter was accepted and then ignored on desktop, so every open
   * project was a legal target and a message from a session in repo A could
   * open or diff a file in repo B merely because B was also open. Being open is
   * what makes a folder reachable at all; it is not what makes it this
   * session's business.
   */
  desktopAuthRoots(session: Session = this.focused): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();
    const add = (p: string | undefined) => {
      if (!p || typeof p !== "string") return;
      const abs = path.resolve(p);
      const key = process.platform === "win32" ? abs.toLowerCase() : abs;
      if (seen.has(key)) return;
      seen.add(key);
      roots.push(abs);
    };
    if (this.host.canSwitchWorkspaceFolder) {
      return sessionScopedRoots({
        sessionCwd: this.sessionCwd(session),
        worktreePath: session.worktree?.path,
        worktreeSourceRoot: session.worktree?.sourceGitRoot,
        activeRoot: this.workspaceRoot(),
        isAuthorized: (cwd) => this.isAuthorizedCwd(cwd),
      });
    }
    add(this.sessionCwd(session));
    if (session.worktree?.path) add(session.worktree.path);
    if (session.worktree?.sourceGitRoot) add(session.worktree.sourceGitRoot);
    add(this.workspaceRoot());
    return roots;
  }

  /**
   * Grok home + on-disk session directory + project session catalogs for desktop
   * openFile authorization of trusted session-generated media
   * (`images|videos` under `~/.grok/sessions/<cwd>/…`). Absolute opens are scoped
   * to the project catalogs (sibling sessions OK for fork replay; cross-repo not).
   * Public so Electron main can wire both message-gate and use-time contexts.
   */
  desktopOpenMediaContext(session: Session = this.focused): {
    grokHome?: string;
    sessionDir?: string;
    sessionCatalogDirs?: string[];
  } {
    let grokHome: string | undefined;
    try {
      grokHome = resolveGrokHome(process.env);
    } catch {
      grokHome = undefined;
    }
    const cwd = this.sessionCwd(session);
    const sid = session.activeSessionId;
    const sessionDir =
      grokHome && sid
        ? sessionDirFor(grokHome, cwd, sid, { fs: defaultFs })
        : undefined;
    const catalogs =
      grokHome
        ? sessionCatalogDirs({ fs: defaultFs, grokHome, cwd })
        : undefined;
    return { grokHome, sessionDir, sessionCatalogDirs: catalogs };
  }

  /** Review directory authorized for the focused desktop conversation. No I/O. */
  desktopPlanReviewSessionRoot(session: Session = this.focused): string {
    const sessionId =
      session.activeSessionId ?? session.client?.sessionId ?? "session";
    return Uri.joinPath(
      this.context.globalStorageUri,
      "plan-reviews",
      planReviewSessionDirectoryName(sessionId),
    ).fsPath;
  }

  /**
   * Public: desktop File menu / host asks the sidebar to open another folder.
   * Picks a directory when `cwd` is omitted.
   */
  async addProjectFolder(cwd?: string): Promise<void> {
    if (!this.canAddProjectFolder()) return;
    const wasEmpty =
      this.host.canSwitchWorkspaceFolder && !this.openWorkspaceFolders().length;
    let folder = cwd;
    if (!folder) {
      const picked = await this.host.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Add Project",
      });
      folder = picked?.[0];
    }
    if (!folder) return;
    const resolved = path.resolve(folder);
    if (!this.host.canSwitchWorkspaceFolder) {
      // VS Code. The workspace is VS Code's, and `updateWorkspaceFolders` on a
      // single-folder window converts it to multi-root and restarts the
      // extension host — conversations included. So the folder joins the rail's
      // catalog and nothing else moves: the Explorer, the open folder and every
      // running session stay exactly where they were.
      await this.rememberExtraProjectFolder(resolved);
      return;
    }
    if (!this.host.addWorkspaceFolder(folder)) {
      void this.host.showWarningMessage(`Could not open folder:\n${folder}`);
      return;
    }
    this.authEpoch++;
    await this.switchLocalWorkspaceFolder(resolved);
    // 0 → 1 folders is not "browse another project" — there is no conversation
    // to protect. Start one in the folder just added so Add project folder
    // from the empty state is connect-or-chat, not another dead Starting.
    if (wasEmpty) {
      this.setSessionCwd(this.focused, resolved, resolved);
      if (!this.focused.hasHistory && !this.focused.client) {
        this.focused.provider = this.defaultProviderForProject(resolved);
      }
      await this.startSession(undefined, this.focused, "ensure");
    }
  }

  /* ----------------------------------------------- making a project */

  /**
   * Home directory the way this host creates folders in it: USERPROFILE on
   * Windows (HOME is often a git-bash overlay), HOME elsewhere. Never
   * GROK_HOME — that is the CLI's store, not the user's.
   */
  private projectHomeDir(): string {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
  }

  /** The one directory new and cloned projects land in. */
  private projectRootPath(): string {
    const home = this.projectHomeDir();
    // Decided ONCE, then written down. Inferring it from the disk every time
    // cannot distinguish "an old install that also has a folder by the new
    // name" from "a new install committed to it", and guessing wrong sends an
    // upgrading user's next project into a second root, away from all their
    // work. A plain FILE named `~/Grok Build` is not a root either.
    const remembered = this.context.globalState.get<"legacy" | "current">(
      PROJECT_ROOT_CHOICE_KEY,
    );
    let legacyIsDirectory = false;
    if (!remembered) {
      try {
        const legacy = legacyProjectRootPath(home);
        legacyIsDirectory = fs.existsSync(legacy) && fs.statSync(legacy).isDirectory();
      } catch {
        /* unreadable home — fall through to the current name */
      }
    }
    const useLegacyRoot = shouldUseLegacyRoot({ remembered, legacyIsDirectory });
    if (!remembered) {
      // Fire and forget: a failed write costs one more disk look next launch,
      // and the answer it would record is the same one.
      void Promise.resolve(
        this.context.globalState.update(
          PROJECT_ROOT_CHOICE_KEY,
          rememberedRootFor(useLegacyRoot),
        ),
      ).catch(() => {});
    }
    return projectRoot(home, { useLegacyRoot });
  }

  /**
   * State of the Add project form.
   *
   * `root` goes out as `~/Grok Build`, never the real path: the client needs it
   * only to show where the folder will be, and a remote has no business
   * learning the desk's home directory.
   */
  private projectSetupMessage(
    extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root"> = {},
  ): Extract<HostMsg, { type: "projectSetup" }> {
    return {
      type: "projectSetup",
      root: displayPath(this.projectRootPath(), this.projectHomeDir()),
      ...extra,
    };
  }

  /** Last GitHub device-login card, only for the tab that started it. */
  private githubProjectSetupExtra(clientId: string): { github?: ProjectSetupGithub } {
    const entry = this.githubDeviceLogin;
    if (!entry?.last || entry.source === "settings") return {};
    const live = entry.tabToken ? this.remoteClients.clientForTabToken(entry.tabToken) : undefined;
    if (live === clientId || entry.clientId === clientId) return { github: entry.last };
    return {};
  }

  private githubStatePayload(loginFlow?: ProjectSetupGithub): GithubState {
    const s = this.githubConnection;
    const flow = loginFlow ?? (this.githubDeviceLogin?.last &&
      (this.githubDeviceLogin.last.status === "starting" || this.githubDeviceLogin.last.status === "waiting")
      ? this.githubDeviceLogin.last
      : undefined);
    if (!s) {
      return {
        connected: false,
        cliPresent: true,
        ...(flow ? { loginFlow: flow } : {}),
      };
    }
    return {
      connected: s.connected,
      ...(s.login ? { login: s.login } : {}),
      ...(s.envTokenInForce ? { envTokenInForce: true } : {}),
      ...(s.error ? { error: true } : {}),
      cliPresent: s.cliPresent,
      ...(s.message ? { message: s.message } : {}),
      ...(flow ? { loginFlow: flow } : {}),
    };
  }

  private githubStateMessage(loginFlow?: ProjectSetupGithub): Extract<HostMsg, { type: "githubState" }> {
    return { type: "githubState", github: this.githubStatePayload(loginFlow) };
  }

  private postGithubState(loginFlow?: ProjectSetupGithub): void {
    const message = this.githubStateMessage(loginFlow);
    this.post(message);
    void this.settingsEditor?.webview.postMessage(message);
  }

  private async refreshGithubState(loginFlow?: ProjectSetupGithub): Promise<void> {
    this.githubConnection = await readGithubAuthState();
    this.postGithubState(loginFlow);
  }

  private postProjectSetup(
    extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root"> = {},
  ): void {
    this.post(this.projectSetupMessage(extra));
  }

  /**
   * Make `<root>/<name>` and open it.
   *
   * A name, never a path — see src/project-create.ts for why that is the whole
   * containment model. `mkdir` only: a project is a folder, and `git init` on
   * something a knowledge-work user just named "Q3 Positioning" would be us
   * deciding they are writing software.
   */
  /**
   * Finish "add a project" for the surface that ASKED for it.
   *
   * `addProjectFolder` registers the project with the HOST — on desktop it adds
   * and activates a workspace folder. That is the whole job at a desk, where the
   * person who clicked is looking at the window that just changed. It is only
   * half the job for a browser tab: a remote client carries its OWN selected
   * repository (`RemoteClientState`), and nothing here was touching it.
   *
   * So the owner cloned a private repository onto a cloud machine, watched it
   * appear, and then found an empty file explorer and a New Session that did
   * nothing visible — because his tab was still bound to the project he started
   * from, and both of those follow the TAB's repository, not the host's. One
   * cause, two symptoms that look unrelated.
   *
   * "Done" has to mean usable from the surface that asked. Host-owned: this
   * reuses the same `selectRemoteRepo` an explicit tap goes through, including
   * its project checks, so it grants a remote nothing it could not
   * already ask for.
   */
  private async enterProjectForRequester(
    dest: string,
    origin: MsgOrigin,
    clientId?: string,
    tabToken?: string,
  ): Promise<void> {
    if (origin !== "remote" || !clientId) return;
    // FOLLOW THE TAB ACROSS A RECONNECT. A clone runs for seconds to minutes and
    // a phone changing network in that window is ordinary, not exotic. When it
    // reconnects, `identify()` moves the tab's state to a NEW client id and
    // drops the old one — and `select()` THROWS for an id it does not know. So
    // binding the id we were called with would report a successful clone as a
    // failure, skip the `done` frame, leave the form spinning, and leave the tab
    // on its old project: every symptom this method exists to prevent.
    //
    // `currentClient` resolves an old id to whatever connection owns that
    // logical tab now, and returns undefined once the tab has genuinely gone —
    // in which case there is nobody to enter the project for, and doing nothing
    // is right. The tab binds itself on its next explicit resume.
    // The TAB TOKEN is the durable identity; the client id is one connection.
    // `currentClient` walks id -> token -> current id, which only works while
    // the ORIGINAL id still remembers its token — and `deleteClient` deletes
    // exactly that mapping. So when the relay reports the old connection's
    // departure BEFORE the replacement identifies (an ordinary refresh, and
    // ordinary ordering), the lookup came back empty and the clone reported
    // success while leaving the tab on its previous project: the very symptom
    // this method exists to close, found by the second review round.
    //
    // Capturing the token when the operation STARTS removes the dependency on
    // that mapping surviving. Not a new mechanism — a better identifier.
    const current = (tabToken && this.remoteClients.clientForTabToken(tabToken))
      || this.remoteClients.currentClient(clientId);
    // Registered, not "has a non-empty cwd" — and the difference is a user's
    // FIRST project. `ready()` stores `defaultCwd`, which is "" when the host
    // has no project open, and `select` gates on the key being PRESENT, not on
    // it being truthy. Testing truthiness here skipped the bind for exactly the
    // person who had nothing to bind to yet, then reported done. Found by the
    // third review round; it was my own guard that introduced it.
    if (!current || this.remoteClients.cwdIfPresent(current) === undefined) return;
    await this.selectRemoteRepo(current, dest);
  }

  async createProject(name: string, origin: MsgOrigin = "local", clientId?: string): Promise<void> {
    // Read BEFORE the long-running work: the connection that asked may be gone
    // by the time it finishes, but its logical tab is what we want to land on.
    const requesterTab = origin === "remote" && clientId
      ? this.remoteClients.tabToken(clientId)
      : undefined;
    const nameError = projectNameError(name);
    if (nameError) {
      this.postProjectSetup({ error: nameError });
      return;
    }
    const root = this.projectRootPath();
    const dest = projectDestination(root, name);
    if (!dest) {
      // Unreachable via the validator above; kept because "cannot happen" is
      // how the deleteSession traversal shipped.
      this.postProjectSetup({ error: "That name can't be used for a folder." });
      return;
    }
    this.postProjectSetup({ busy: "new" });
    try {
      // The root itself may not exist: provisionDefaultProjectDir only creates
      // it on a first run where project discovery found nothing, so anyone
      // whose checkouts were discovered has never had one.
      fs.mkdirSync(root, { recursive: true });
      if (fs.existsSync(dest)) {
        this.postProjectSetup({ error: `"${name.trim()}" is already in ${displayPath(root, this.projectHomeDir())}.` });
        return;
      }
      fs.mkdirSync(dest);
    } catch (e) {
      this.postProjectSetup({ error: `Could not create the folder: ${(e as Error).message}` });
      return;
    }
    await this.addProjectFolder(dest);
    await this.enterProjectForRequester(dest, origin, clientId, requesterTab);
    this.postProjectSetup({ done: true });
  }

  /**
   * Clone `url` into the same root, under the folder name the URL implies.
   *
   * Credentials are git's own — whatever the user's credential helper, SSH
   * agent or `gh auth login` already set up. Nothing is minted, stored or
   * forwarded here, which is why this needs no new threat model on a desk
   * machine.
   *
   * `GIT_TERMINAL_PROMPT=0`: without it a private repo makes git block on a
   * username prompt against a terminal that does not exist, and the form waits
   * for ever instead of reporting an auth failure it could offer to fix.
   */
  async cloneProject(url: string, origin: MsgOrigin = "local", clientId?: string, name?: string): Promise<void> {
    // Read BEFORE the long-running work: the connection that asked may be gone
    // by the time it finishes, but its logical tab is what we want to land on.
    const requesterTab = origin === "remote" && clientId
      ? this.remoteClients.tabToken(clientId)
      : undefined;
    const urlError = cloneUrlError(url);
    if (urlError) {
      this.postProjectSetup({ error: urlError });
      return;
    }
    const root = this.projectRootPath();
    const folderError = name !== undefined ? projectNameError(name) : null;
    if (folderError) {
      this.postProjectSetup({ error: folderError, collision: name?.trim() });
      return;
    }
    const dest = name !== undefined
      ? projectDestination(root, name)
      : cloneDestination(root, url);
    if (!dest) {
      this.postProjectSetup({ error: "That URL doesn't name a repository." });
      return;
    }
    this.postProjectSetup({ busy: "clone" });
    try {
      fs.mkdirSync(root, { recursive: true });
      if (fs.existsSync(dest)) {
        this.postProjectSetup({
          error: `${path.basename(dest)} is already in ${displayPath(root, this.projectHomeDir())}. Pick a different folder name.`,
          collision: path.basename(dest),
        });
        return;
      }
    } catch (e) {
      this.postProjectSetup({ error: `Could not create the folder: ${(e as Error).message}` });
      return;
    }
    const trimmed = normalizeCloneUrl(url) ?? url.trim();
    const failure = await runGitClone(trimmed, dest);
    if (failure) {
      // A half-written checkout is worse than none: the next attempt would fail
      // on "already exists" and the rail would show an empty project.
      try {
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* leave it — reporting the clone failure matters more */
      }
      const kind = classifyCloneFailure(failure);
      let error = cloneFailureText(kind, failure);
      let fix: { fix?: "auth-gh" | "install-gh"; fixCommand?: string } = {};
      if (offersGithubSetup(trimmed, kind)) {
        const offer = githubFixFor(process.platform, commandOnPath);
        if (offer.kind === "auth") fix = { fix: "auth-gh" };
        else if (offer.kind === "install") fix = { fix: "install-gh", fixCommand: offer.command };
        else {
          // No gh, and no package manager we could drive either — a Mac with no
          // Homebrew, or Windows without winget. A button that runs a command
          // which is not installed either is worse than saying where to get it.
          error += ` Install the GitHub CLI from ${offer.where} first.`;
        }
      }
      this.postProjectSetup({ error, ...fix });
      return;
    }
    await this.addProjectFolder(dest);
    await this.enterProjectForRequester(dest, origin, clientId, requesterTab);
    this.postProjectSetup({ done: true });
  }

  /**
   * Run the GitHub CLI step the failed clone needs.
   *
   * A LOCAL webview still opens a terminal: `gh auth login` asks questions
   * and opens a browser, and a package manager asks for elevation. A REMOTE
   * `auth` has no terminal to look at, so it runs the headless device-code
   * flow and reports the URL and code on `projectSetup.github`.
   */
  async setupGithubCli(
    action: "install" | "auth",
    origin: MsgOrigin = "local",
    clientId?: string,
    surface?: "settings",
  ): Promise<void> {
    // `sendText`, not `shellPath`/`shellArgs`: both of these are command LINES
    // rather than one binary with arguments. Signing in has to run two commands
    // in order — see githubSignInCommand for why the second is not optional —
    // and this is the seam that already exists for exactly that (the desktop
    // host routes it through planRunCommandInTerminal, which keeps the window
    // open so the outcome stays readable).
    if (action === "auth") {
      if (origin === "remote") {
        this.startGithubDeviceLogin(clientId, surface === "settings" ? "settings" : "clone");
        return;
      }
      const term = this.host.createTerminal({ name: "GitHub sign-in" });
      term.show();
      term.sendText(githubSignInCommand(process.platform));
      return;
    }
    // INSTALL IS DESK-ONLY, and the check belongs here rather than in the
    // client that already declines to send it. `setupGithubCli` is `full` in
    // remote-policy.ts so that `auth` can run headlessly — but the policy gates
    // a message TYPE, not the action inside it, so widening the type handed a
    // remote the installer as well. A package manager asks for elevation, so
    // there is no headless path to offer: the honest answer is the same one the
    // clone form shows, and the relay-is-policy-free invariant means the HOST
    // has to be the one refusing.
    if (origin === "remote") {
      this.postProjectSetup({
        error: `Install the GitHub CLI from ${GITHUB_CLI_DOWNLOAD} on that computer, then try again.`,
      });
      return;
    }
    const install = githubCliInstallCommand(process.platform);
    if (!install) {
      this.postProjectSetup({
        error: `Install the GitHub CLI from ${GITHUB_CLI_DOWNLOAD}, then try again.`,
      });
      return;
    }
    const term = this.host.createTerminal({ name: "Install GitHub CLI" });
    term.show();
    term.sendText(install.display);
  }

  /**
   * Stop a headless GitHub login without reporting a failure. Closing the
   * clone form, picking the token path, or starting again all land here so
   * `gh` is not left polling.
   */
  private cancelGithubDeviceLogin(): void {
    const running = this.githubDeviceLogin;
    if (!running) return;
    this.githubDeviceLogin = undefined;
    try { running.handle?.cancel(); } catch { /* already gone */ }
    this.postGithubState();
  }

  /**
   * Headless `gh auth login --web` plus `gh auth setup-git`, reported only to
   * the client that asked. A code is for the person holding that device.
   */
  private startGithubDeviceLogin(clientId?: string, source: "clone" | "settings" = "clone"): void {
    if (this.githubDeviceLogin) {
      const prev = this.githubDeviceLogin;
      if (this.shouldAdoptInFlightDeviceLogin(prev, clientId)) {
        prev.clientId = clientId;
        if (clientId) prev.tabToken = this.remoteClients.tabToken(clientId) ?? prev.tabToken;
        if (prev.last) prev.send(prev.last);
        this.host.appendLine("[github] device login already in flight; repeated its state to the new tap");
        return;
      }
      this.githubDeviceLogin = undefined;
      try { prev.handle?.cancel(); } catch { /* already gone */ }
    }

    const gen = ++this.githubLoginGen;
    const send = (github: ProjectSetupGithub) => {
      const entry = this.githubDeviceLogin;
      if (!entry || entry.gen !== gen) return;
      entry.last = github;
      const id = this.githubAskerId(clientId);
      if (entry.source !== "settings") {
        const message = this.projectSetupMessage({ github });
        if (id) this.sendRemoteClient(id, message);
        else this.post(message);
      }
      this.postGithubState(github);
    };

    this.githubDeviceLogin = {
      gen,
      clientId,
      tabToken: clientId ? this.remoteClients.tabToken(clientId) : undefined,
      source,
      send,
    };

    if (!commandOnPath(GITHUB_CLI_BIN)) {
      this.finishGithubDeviceLoginMissing();
      return;
    }

    send({ status: "starting" });
    this.host.appendLine("[github] device login started");
    const workId = this.beginDeviceLoginWork();
    const startedAt = Date.now();
    let settled = false;
    const handle = runGithubDeviceLogin(GITHUB_CLI_BIN, {
      onPrompt: (prompt) => {
        send({
          status: "waiting",
          url: prompt.url,
          ...(prompt.code ? { code: prompt.code } : {}),
        });
      },
      onDone: (result) => {
        settled = true;
        this.endDeviceLoginWork(workId);
        if (this.githubDeviceLogin?.gen !== gen) return;
        this.githubDeviceLogin.handle = undefined;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (result.ok) {
          this.host.appendLine(`[github] device login completed after ${elapsed}s`);
          send({
            status: "done",
            message: source === "settings"
              ? "GitHub connected."
              : "Signed in to GitHub. Try to clone again.",
          });
          void this.refreshGithubState();
          return;
        }
        if ("failure" in result) {
          const failure = isGithubCliMissing(result.output) ? "missing" as const : result.failure;
          this.host.appendLine(`[github] device login failed (${failure}) after ${elapsed}s`);
          this.finishGithubDeviceLoginFailure(failure, { setupGit: !!result.setupGit });
          return;
        }
        this.host.appendLine(`[github] device login cancelled after ${elapsed}s`);
      },
    });
    if (!settled && this.githubDeviceLogin?.gen === gen) {
      this.githubDeviceLogin.handle = handle;
    }
  }

  /** The tab that started GitHub sign-in, wherever its socket is now. */
  private githubAskerId(fallback?: string): string | undefined {
    const entry = this.githubDeviceLogin;
    const live = entry?.tabToken ? this.remoteClients.clientForTabToken(entry.tabToken) : undefined;
    return live ?? entry?.clientId ?? fallback;
  }

  private postGithubProjectSetup(
    extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root">,
  ): void {
    const message = this.projectSetupMessage(extra);
    const id = this.githubAskerId();
    if (id) this.sendRemoteClient(id, message);
    else this.post(message);
  }

  private finishGithubDeviceLoginMissing(): void {
    const offer = githubFixFor(process.platform, commandOnPath);
    const extra: Omit<Extract<HostMsg, { type: "projectSetup" }>, "type" | "root"> =
      offer.kind === "install"
        ? { error: githubDeviceLoginFailureText("missing"), fix: "install-gh", fixCommand: offer.command }
        : offer.kind === "download"
          ? { error: `${githubDeviceLoginFailureText("missing")} Install it from ${offer.where} first.` }
          : { error: githubDeviceLoginFailureText("missing"), fix: "install-gh" };
    this.postGithubProjectSetup(extra);
    this.githubDeviceLogin = undefined;
    void this.refreshGithubState();
  }

  private finishGithubDeviceLoginFailure(
    failure: Parameters<typeof githubDeviceLoginFailureText>[0],
    opts: { setupGit?: boolean } = {},
  ): void {
    if (failure === "missing") {
      this.finishGithubDeviceLoginMissing();
      return;
    }
    const error = githubDeviceLoginFailureText(failure, opts);
    this.postGithubProjectSetup({
      error,
      ...(failure === "unsupported" ? {} : { fix: "auth-gh" as const }),
    });
    this.githubDeviceLogin = undefined;
    void this.refreshGithubState();
  }

  private async listGithubRepos(): Promise<void> {
    if (!this.githubConnection) this.githubConnection = await readGithubAuthState();
    if (!this.githubConnection.connected || this.githubConnection.error) {
      this.post({ type: "githubRepos", repos: [] });
      return;
    }
    const result = await listGithubRepositories();
    this.post({
      type: "githubRepos",
      repos: result.repos,
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  }

  /**
   * Sign out of GitHub. An environment token outranks the keyring and cannot
   * be cleared from here — the snapshot after logout says so.
   */
  private async githubSignOut(origin: MsgOrigin = "local"): Promise<void> {
    if (origin === "remote" && !isCloudEnvironment()) return;
    const current = this.githubConnection;
    const login = current?.login;
    if (current?.envTokenInForce) {
      const name = githubEnvTokenName() ?? "GH_TOKEN";
      this.githubConnection = {
        ...current,
        error: true,
        message: githubEnvTokenBlocksSignOutMessage(name),
      };
      this.postGithubState();
      return;
    }
    const result = await logoutGithub(login);
    if (!result.ok) {
      this.githubConnection = {
        ...(current ?? { ...DISCONNECTED_GITHUB, login: login || "" }),
        error: true,
        message: result.error,
      };
      this.postGithubState();
      return;
    }
    await this.refreshGithubState();
  }

  /**
   * Paste-a-token path. The token is never logged, never posted back, never
   * stored by us — gh owns it after `--with-token`.
   */
  private async githubLoginWithToken(token: string): Promise<void> {
    const result = await loginGithubWithToken(token);
    if (!result.ok) {
      this.host.appendLine("[github] token login failed");
      const current = this.githubConnection ?? { ...DISCONNECTED_GITHUB };
      this.githubConnection = { ...current, error: true, message: result.error };
      this.postGithubState();
      return;
    }
    this.host.appendLine("[github] token login completed");
    await this.refreshGithubState();
  }

  /**
   * Record a hand-added folder and show it, without touching the workspace.
   *
   * Selecting it afterwards is the half that makes the button feel like the
   * desktop's: there, adding a project switches to it. Here "switch" is only
   * the rail's own selection — `selectedRepoCwd`, which `postRepoCatalog` reads
   * — so the rail lands on the project you just added, expanded and ready, while
   * VS Code itself has not moved.
   */
  private async rememberExtraProjectFolder(resolved: string): Promise<void> {
    let ok = false;
    try {
      ok = fs.statSync(resolved).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      void this.host.showWarningMessage(`Not a folder:\n${resolved}`);
      return;
    }
    const key = normalizeRepoPath(resolved);
    // Already here on its own — the open workspace folder, or a project Grok has
    // run in. Recording it as hand-added would be a lie with consequences: the
    // row would gain a Remove action, and removing it tombstones a project that
    // has other reasons to exist. Worst of all for the OPEN folder, whose access
    // cannot be revoked at all (`localTrustedSessionCwds` adds `workspaceRoot()`
    // unconditionally, and every remote gate reads that set) — the row would
    // vanish while the phone carried on reading and writing it. Just go there.
    const alreadyListed =
      !!this.resolveLocalRepoTarget(resolved) ||
      pathsEqual(resolved, this.workspaceRoot() || "");
    if (alreadyListed) {
      await this.selectRepo(resolved);
      return;
    }
    // Adding a folder is the undo for having removed it. Without this the
    // tombstone would outlive the decision and the picker would appear to do
    // nothing at all.
    const tombstones = this.state.get<string[]>(REMOVED_PROJECT_FOLDERS_KEY, []);
    if (Array.isArray(tombstones) && tombstones.some((c) => normalizeRepoPath(c) === key)) {
      await this.state.update(
        REMOVED_PROJECT_FOLDERS_KEY,
        tombstones.filter((c) => normalizeRepoPath(c) !== key),
      );
    }
    const stored = this.extraProjectFolders();
    if (!stored.some((c) => normalizeRepoPath(c) === key)) {
      await this.state.update(EXTRA_PROJECT_FOLDERS_KEY, [...stored, resolved]);
    }
    // Already in the catalog by other means (open folder, or Grok has run there)
    // is not a failure — the user still gets taken to it.
    await this.selectRepo(resolved);
  }

  /**
   * Take a hand-added folder back out of the rail's catalog (VS Code).
   *
   * Deliberately NOT the desktop's revocation: nothing is disposed and no
   * process is killed, because adding the folder started nothing. It removes
   * the one reason this folder was listed. If Grok has since run there the row
   * survives on its own history — same as every other project, and the
   * conversations are still yours; archive is the way to hide those.
   */
  private async forgetExtraProjectFolder(cwd?: string): Promise<void> {
    if (!cwd) return;
    // Removal is a REVOCATION here too, not a catalog filter. Tombstoning the
    // row stopped new remote frames but left any agent already running in that
    // folder executing commands and writing files — while the confirmation said
    // "Nothing on disk is touched". Same warning and same disposal the desktop
    // close performs, for the same reason: the user is being asked to end work
    // they may not know is in flight.
    const working = this.sessionsBoundToFolder(cwd).filter(sessionHasWorkInFlight);
    if (working.length) {
      const many = working.length > 1;
      const ok = await this.host.showWarningMessage(
        `Hide "${path.basename(cwd)}"?\n\n` +
          `${many ? `${working.length} conversations are` : "A conversation is"} still working. ` +
          `Hiding it ends ${many ? "them" : "it"} and discards the turn in progress.`,
        { modal: true },
        "Hide anyway",
      );
      if (ok !== "Hide anyway") return;
    }
    // Never the open workspace folder. Its authorization does not come from the
    // catalog — `localTrustedSessionCwds` adds `workspaceRoot()` on its own — so
    // a tombstone would hide the row while every remote gate kept saying yes.
    // A revocation that does not revoke is worse than no button at all.
    if (pathsEqual(cwd, this.workspaceRoot() || "")) {
      void this.host.showWarningMessage(
        "This is the folder VS Code has open, so it cannot be removed from the list. " +
          "Close the folder in VS Code instead.",
      );
      return;
    }
    const key = normalizeRepoPath(cwd);
    const stored = this.extraProjectFolders();
    const next = stored.filter((c) => normalizeRepoPath(c) !== key);
    if (next.length === stored.length) return;
    await this.state.update(EXTRA_PROJECT_FOLDERS_KEY, next);
    // …and the PIN, or this removes nothing.
    //
    // `discoverRepos` keeps a pinned cwd in the catalog on its own — "a pin is
    // durable intent" — and a phone can pin any project it can see. So: add a
    // folder, pin it from the phone, remove it at the desk, and it came back as
    // an ordinary catalog row that VS Code trusts, still browsable and editable
    // from the phone, and now WITHOUT the `added` marker, so the rail no longer
    // offered to remove it. A revocation that a remote can pre-empt is not one.
    //
    // A pin on a folder being removed is not intent to keep it; it is the pin of
    // a project that is going away.
    const pins = this.state.get<RepoPins>(REPO_PINS_KEY, {});
    if (pins[key]) {
      const nextPins = { ...pins };
      delete nextPins[key];
      await this.state.update(REPO_PINS_KEY, nextPins);
    }
    // …and a tombstone, or the folder simply comes back. VS Code's catalog is
    // discovered from Grok's own session history, so anything that has run there
    // re-adds the row — and a phone can manufacture exactly that by selecting
    // the project, which starts a session in it. Removal has to outrank
    // discovery or it is not removal.
    const tombstones = this.state.get<string[]>(REMOVED_PROJECT_FOLDERS_KEY, []);
    const list = Array.isArray(tombstones) ? tombstones : [];
    if (!list.some((c) => normalizeRepoPath(c) === key)) {
      await this.state.update(REMOVED_PROJECT_FOLDERS_KEY, [...list, cwd]);
    }
    // Now that the tombstone is written — so `isAuthorizedCwd` already says no —
    // end everything that folder still owns: agent processes disposed, remote
    // ownership on that cwd released, image handles dropped, authEpoch bumped.
    // Order matters the same way it does on desktop: revoke only once the folder
    // has left the authorized set, or a concurrent remote send could still route
    // into a doomed session.
    this.revokeClosedProjectFolder(cwd);
    if (!this.pool.has(this.focused) && !this.focused.client) {
      this.focused = this.newLocalSession();
      this.emit(this.focused, { type: "clearMessages" });
    }
    // The selection may have been pointing at it. postRepoCatalog re-validates
    // against the catalog it is about to send and moves it if the row is gone.
    this.postRepoCatalog();
    this.postSessionsList();
  }

  /**
   * Public: close a project folder from the desktop File menu. Closing is a
   * **revocation**, not a catalog filter: sessions bound to the folder end,
   * remote ownership on that cwd is released, and image handles under it are
   * dropped. Closing the last folder leaves an empty rail (no re-seed).
   */
  async removeProjectFolder(
    cwd?: string,
    origin: MsgOrigin = "local",
    clientId?: string,
  ): Promise<void> {
    if (!this.host.canSwitchWorkspaceFolder) {
      // VS Code: the only thing there is to remove is a folder the user ADDED
      // by hand. Everything else in the catalog is there because Grok has run
      // in it, and no button here would change that. Without this the added
      // folder was permanent — a mistaken or sensitive directory stayed
      // selectable, and remotely browsable and editable, for ever.
      await this.forgetExtraProjectFolder(cwd);
      return;
    }
    const target = cwd || this.host.workspaceRoot();
    if (!target) return;
    // Closing is a revocation: every session in the folder is disposed and its
    // agent process killed (hard-killed on Windows). A File-menu item gives no
    // hint that anything is running, so a mid-turn close would discard the work
    // silently. Ask first. The revoke recomputes its own list at use time, so
    // nothing here goes stale across the await.
    const working = this.sessionsBoundToFolder(target).filter(sessionHasWorkInFlight);
    if (working.length && origin === "remote") {
      // A REMOTE cannot answer a native modal, and on a cloud machine there is
      // nobody at the screen it would open on: the host would wait for a click
      // that can never come, and the browser would sit there having been told
      // nothing. That is the exact silence this release exists to remove, so it
      // must not come back through the door the same release opened.
      //
      // Refused rather than assumed. The browser's own confirmation asks a
      // DIFFERENT question — it says nothing is deleted and the folder stays on
      // disk — so it is not consent to end a turn in progress and throw the work
      // away. Stopping the turn is one tap, and it is the user's call to make.
      const many = working.length > 1;
      const text = `“${path.basename(target)}” still has `
        + `${many ? `${working.length} conversations` : "a conversation"} working. `
        + `Hiding it would end ${many ? "them" : "it"} and discard the turn in `
        + "progress. Stop it first, then hide the project.";
      if (clientId) this.sendRemoteClient(clientId, { type: "error", text });
      return;
    }
    if (working.length) {
      const many = working.length > 1;
      const ok = await this.host.showWarningMessage(
        `Close "${path.basename(target)}"?

${many ? `${working.length} conversations are` : "A conversation is"} still working. ` +
          `Closing ends ${many ? "them" : "it"} and discards the turn in progress.`,
        { modal: true },
        "Close anyway",
      );
      if (ok !== "Close anyway") return;
    }

    const activeRoot = this.host.workspaceRoot();
    const wasActive = !!activeRoot && pathsEqual(target, activeRoot);
    if (!this.host.removeWorkspaceFolder(target)) {
      void this.host.showWarningMessage(`Could not close folder:\n${target}`);
      return;
    }
    // Revoke first so a concurrent remote send cannot still route to a doomed
    // session after the folder is gone from the open set.
    this.revokeClosedProjectFolder(target);

    const next = this.host.workspaceRoot();
    if (wasActive && next) {
      await this.switchLocalWorkspaceFolder(next);
    } else if (!next) {
      // Empty open set — focused may already have been disposed by revoke.
      // clearMessages alone resets the welcome to "Starting"; without a
      // follow-on startSession unlock that spinner never clears.
      if (this.pool.has(this.focused) || this.focused.client) {
        this.parkFocused();
      }
      this.focused = this.newLocalSession();
      this.selectedRepoCwd = "";
      this.emit(this.focused, { type: "clearMessages" });
      this.presentEmptyProjectState(this.focused);
    } else {
      // Revoke may have disposed the focused session when it lived in the closed
      // folder even though another folder remains active.
      if (!this.pool.has(this.focused) && !this.focused.client) {
        this.focused = this.newLocalSession();
      }
      this.postRepoCatalog();
      this.postSessionsList();
    }
  }

  /**
   * Desktop with nothing open: unlock the baked "Starting" welcome and name
   * the problem. startSession used to return here without either, which is
   * the first-run hang (#116) — grok is inferred connected from ~/.grok, so
   * postInitialState never shows connect-agent, and the spinner never clears.
   * Do not spawn against process.cwd() (that is the install directory).
   */
  private presentEmptyProjectState(session: Session): void {
    session.priming = false;
    this.emit(session, { type: "setBusy", value: false });
    this.emit(session, {
      type: "onboarding",
      state: "no-project",
      platform: process.platform,
    });
    this.postRepoCatalog();
    this.postSessionsList();
  }

  /**
   * Revoke all live capabilities that belonged to a just-closed project folder.
   * Bumps {@link authEpoch}. Idempotent for a given path once the open set has
   * already dropped it (isAuthorizedCwd is false for that cwd).
   */
  /** Every live session the given folder owns — pool plus focused, worktrees
   *  included. Both the close warning and the revoke read this, so the set the
   *  user is warned about is by construction the set that gets disposed. */
  private sessionsBoundToFolder(closedCwd: string): Session[] {
    const bound: Session[] = [];
    const seen = new Set<Session>();
    const consider = (s: Session | undefined) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      if (
        sessionBoundToClosedFolder(
          this.sessionCwd(s),
          s.worktree?.path,
          s.worktree?.sourceGitRoot,
          closedCwd,
          pathsEqual,
        )
      ) {
        bound.push(s);
      }
    };
    for (const s of this.pool) consider(s);
    consider(this.focused);
    return bound;
  }

  private revokeClosedProjectFolder(closedCwd: string): void {
    this.authEpoch++;
    // Voice first: a completing STT turn must not voiceSubmit / post into a
    // session that is about to be disposed or rehomed to another project.
    this.revokeVoiceForClosedFolder(closedCwd);

    const doomed = this.sessionsBoundToFolder(closedCwd);

    for (const s of doomed) {
      const remoteHolders = this.remoteClients.clientsForActiveValue(s);
      this.disposeSession(s);
      for (const clientId of remoteHolders) {
        this.rehomeRemoteClientAfterFolderClose(clientId, closedCwd);
      }
    }

    // Clients whose selected repo was the closed folder (even with no session).
    for (const clientId of this.remoteClients.clients()) {
      const cwd = this.remoteClients.cwdIfPresent(clientId);
      if (cwd && pathBoundToClosedFolder(cwd, closedCwd, pathsEqual)) {
        this.remoteClients.deleteActive(clientId);
        this.rehomeRemoteClientAfterFolderClose(clientId, closedCwd);
      }
    }

    this.invalidateImageHandlesUnder(closedCwd);

    this.worktreeCache = this.worktreeCache.filter(
      (w) =>
        !pathsEqual(w.sourceRepo, closedCwd) &&
        !pathBoundToClosedFolder(w.path, closedCwd, pathsEqual),
    );

    // Drop worktree meta that pointed at the closed folder so a later resume
    // cannot re-authorize via overrides alone (trusted set no longer includes it).
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    let metaChanged = false;
    const nextMeta: SessionMetaOverrides = { ...overrides };
    for (const [id, o] of Object.entries(overrides)) {
      if (
        (o.worktreePath && pathBoundToClosedFolder(o.worktreePath, closedCwd, pathsEqual)) ||
        (o.sourceGitRoot && pathsEqual(o.sourceGitRoot, closedCwd))
      ) {
        const { worktreePath: _wp, worktreeLabel: _wl, sourceGitRoot: _sg, ...rest } = o;
        nextMeta[id] = rest;
        metaChanged = true;
      }
    }
    if (metaChanged) void this.state.update(SESSION_META_KEY, nextMeta);

    this.host.appendLine(`[auth] revoked project folder ${closedCwd} (epoch=${this.authEpoch})`);
  }

  /** Re-point a remote tab at a remaining open folder, or leave it unbound. */
  private rehomeRemoteClientAfterFolderClose(clientId: string, closedCwd: string): void {
    const next =
      this.openWorkspaceFolders().find((c) => !pathsEqual(c, closedCwd)) ||
      this.host.workspaceRoot() ||
      "";
    try {
      if (next && this.isAuthorizedCwd(next)) {
        this.remoteClients.select(clientId, next);
      } else if (this.remoteClients.cwdIfPresent(clientId)) {
        // Keep the client alive but clear the active session; bound-cwd checks
        // refuse ops until the tab selects an authorized repo.
        this.remoteClients.deleteActive(clientId);
        // Leave *client state* pointing at the closed path so selectRepo is
        // required (isAuthorizedCwd(closed) is false → send/cancel refused).
        // Outbound `repos`/`initialState` scrub that path to empty — the choke
        // point rejects a closed selectedCwd on the wire.
      }
      this.sendRemoteRepoCatalog(clientId);
      this.sendRemoteClient(clientId, {
        type: "error",
        text: "That project folder was closed on the desktop. Select another project to continue.",
      });
    } catch (e) {
      this.host.appendLine(
        `[auth] rehome remote client failed: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  private invalidateImageHandlesUnder(closedCwd: string): void {
    const handles = imageHandlesToRevoke(this.fullImagePaths, closedCwd, pathsEqual);
    for (const handle of handles) {
      const p = this.fullImagePaths.get(handle);
      this.fullImagePaths.delete(handle);
      if (p && this.fullImageHandles.get(p) === handle) this.fullImageHandles.delete(p);
    }
  }

  /**
   * Cancel local + remote voice bound to a just-closed project folder so a late
   * transcript cannot land on a rehomed session or different focused project.
   */
  private revokeVoiceForClosedFolder(closedCwd: string): void {
    if (
      (this.localVoiceCwd && pathBoundToClosedFolder(this.localVoiceCwd, closedCwd, pathsEqual)) ||
      (this.localVoiceCredentialCwd &&
        pathBoundToClosedFolder(this.localVoiceCredentialCwd, closedCwd, pathsEqual))
    ) {
      this.stopVoiceInput();
    }
    for (const clientId of [...this.remoteVoice.keys()]) {
      const entry = this.remoteVoice.get(clientId);
      if (!entry) continue;
      const sessCwd = this.sessionCwd(entry.session);
      if (
        pathBoundToClosedFolder(entry.credentialCwd, closedCwd, pathsEqual) ||
        sessionBoundToClosedFolder(
          sessCwd,
          entry.session.worktree?.path,
          entry.session.worktree?.sourceGitRoot,
          closedCwd,
          pathsEqual,
        )
      ) {
        this.dropRemoteVoice(clientId);
      }
    }
  }

  private async selectRemoteRepo(clientId: string, cwd: string): Promise<void> {
    // Same catalog the client was sent (open folders on desktop, full on VS Code).
    const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, cwd));
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
    if (newest) {
      const liveSession = live.get(newest.id);
      const ownedByOther = !!liveSession && this.remoteClients.clients().some((ownerId) =>
        ownerId !== clientId && this.remoteClients.active(ownerId)?.activeSessionId === newest.id
      );
      // Re-selecting a repo whose conversation is already live must replay its
      // buffer. focusRemoteSession needs no CLI; openRemoteSession would mint
      // onboarding over a clientless live member. Another tab's live session
      // still goes through openRemoteSession without a claim, which refuses
      // the steal — selecting a repo is not an explicit conversation claim.
      if (liveSession && !ownedByOther) this.focusRemoteSession(clientId, liveSession, false);
      else await this.openRemoteSession(clientId, newest.id, newest.cwd, false);
    } else {
      await this.newRemoteSession(clientId, false);
    }
    this.sendRemoteRepoCatalog(clientId);
  }

  private async toggleRepoPin(cwd: string, pinned: boolean): Promise<void> {
    const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) return;
    const pins = this.state.get<RepoPins>(REPO_PINS_KEY, {});
    const key = normalizeRepoPath(hit.cwd);
    const next = { ...pins };
    if (pinned) next[key] = { cwd: hit.cwd, pinnedAt: Date.now() };
    else delete next[key];
    await this.state.update(REPO_PINS_KEY, next);
    this.postRepoCatalog();
  }

  /** Record where a project belongs in the rail. Both answers are stored,
   *  including "not archived" — that one exists to hold a long-idle project in
   *  view against the rail's own age rule, so forgetting it is not the same as
   *  storing it (see RepoArchiveChoice). */
  private async setRepoArchived(cwd: string, archived: boolean): Promise<void> {
    if (!this.host.canArchiveRepos) return;
    const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) return;
    const archives = this.state.get<RepoArchives>(REPO_ARCHIVES_KEY, {});
    const key = normalizeRepoPath(hit.cwd);
    await this.state.update(REPO_ARCHIVES_KEY, {
      ...archives,
      [key]: { cwd: hit.cwd, at: Date.now(), archived },
    });
    this.postRepoCatalog();
  }

  /** Record a project's folder-icon colour (or clear it). Empty `color` removes
   *  the stored entry so the wire reports `""` again. Invalid ids are ignored —
   *  a remote must not invent a palette entry the host never offered. */
  private async setRepoColor(cwd: string, color: string): Promise<void> {
    if (!isRepoColor(color)) return;
    const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, cwd));
    if (!hit) return;
    const colors = this.state.get<RepoColors>(REPO_COLORS_KEY, {});
    const key = normalizeRepoPath(hit.cwd);
    const next: RepoColors = { ...colors };
    if (color === "") delete next[key];
    else next[key] = { cwd: hit.cwd, color };
    await this.state.update(REPO_COLORS_KEY, next);
    this.postRepoCatalog();
  }

  /** Pin/unpin one conversation. Stored on the session's own override entry, so
   *  it survives a rename and travels with nothing else — `pinnedCwd` is kept
   *  alongside because the Pinned group spans repos and has to know where to
   *  read each session from without scanning every checkout. */
  private async toggleSessionPin(id: string, cwd: string | undefined, pinned: boolean): Promise<void> {
    if (!id) return;
    await this.updateSessionMeta((overrides) => {
      const existing = overrides[id];
      // Resolve the home repo once, at pin time: the client sends the row's own
      // cwd (already gated against the catalog), and falling back to whatever
      // repo happens to be selected would file the pin under the wrong project.
      const cachedAdapterCwd = [...this.allAdapterCatalogs()].flat().find((entry) => entry.id === id)?.cwd;
      const home = cwd || existing?.pinnedCwd || this.sessionCache.get(id)?.entry.cwd || cachedAdapterCwd;
      if (!home) return null; // nothing to write (pin or unpin)
      // Authorization is not only "cwd was once in the catalog": a remote client
      // that knows a session id must not mutate pin state for a closed project.
      // No protocol change — wire still allows optional cwd; we re-check home.
      if (!this.isAuthorizedCwd(home)) return null;
      const next: SessionMetaOverrides = { ...overrides };
      const entry = { ...(existing ?? {}) };
      if (pinned) {
        entry.pinnedAt = Date.now();
        entry.pinnedCwd = home;
      } else {
        delete entry.pinnedAt;
        delete entry.pinnedCwd;
      }
      // An override that now carries nothing is noise in globalState — drop it
      // rather than accumulating empty objects for every session ever unpinned.
      if (Object.keys(entry).length === 0) delete next[id];
      else next[id] = entry;
      return next;
    });
    // The pin lives in globalState, not in the session's summary.json, so the
    // file's mtime does not move and the entry cache would keep serving a row
    // with the OLD pin state — the pin control would then still say "Pin" right
    // after pinning, and clicking it would pin again instead of unpinning. Same
    // reason `customName` invalidates here: an override changes the entry
    // without touching disk.
    this.sessionCache.delete(id);
    this.postSessionsList(); // fans out the pinned refresh too
  }

  /** Read-modify-write on the session-meta map, serialised.
   *
   *  Every writer of this map reads the whole object, edits a copy and writes it
   *  back. The read is synchronous but the write awaits, so two updates started
   *  in the same tick both read the OLD map and the second silently discards the
   *  first — pin A then immediately pin B, and only B survives. Remote messages
   *  are not serialised, so "the same tick" is an ordinary double click.
   *
   *  Chaining every call through one promise makes the read-modify-write atomic
   *  with respect to other users of this helper. It is the mechanism the older
   *  writers should migrate onto (ROADMAP § Concurrent writes); until they do,
   *  a pin can still lose a race against a rename, which is far rarer than two
   *  pins in a row. Returning null from the mutator means "nothing to write". */
  private sessionMetaWrites: Promise<void> = Promise.resolve();
  private updateSessionMeta(
    mutate: (current: SessionMetaOverrides) => SessionMetaOverrides | null,
  ): Promise<void> {
    const run = this.sessionMetaWrites.then(async () => {
      const current = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const next = mutate(current);
      if (next) await this.state.update(SESSION_META_KEY, capSessionMetaAutoNames(next).value);
    });
    // Keep the chain alive even if one link throws, or every later write dies.
    this.sessionMetaWrites = run.catch(() => {});
    return run;
  }

  /** Park a composer draft on the conversation it was typed into, because that
   *  conversation is the only place it can be handed back without guessing who
   *  is watching what. */
  private rememberQueuedDraft(id: string, text: string): Promise<void> {
    if (!text) return Promise.resolve();
    return this.updateSessionMeta((current) => ({
      ...current,
      [id]: { ...(current[id] ?? {}), queuedDraft: text },
    }));
  }

  /** Hand a parked draft back to this session's live composer, exactly once.
   *  Detached tabs keep META untouched until reattachment because
   *  `restoreComposer` is transient and has no recipient while detached. */
  private restorePersistedDraft(session: Session): void {
    const hasComposer =
      (session === this.focused && this.view !== undefined) ||
      this.remoteClients.isActiveValueVisible(session);
    if (!hasComposer || session.needsProvider) return;
    const id = session.activeSessionId;
    if (!id) return;
    const draft = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]?.queuedDraft;
    if (!draft) return;
    void this.updateSessionMeta((current) => {
      const meta = current[id];
      if (!meta?.queuedDraft) return null;
      const { queuedDraft: _restored, ...rest } = meta;
      return { ...current, [id]: rest };
    });
    this.emit(session, { type: "restoreComposer", text: draft });
  }

  /** Restore a replacement's captured draft only after its provider start
   * succeeded. The durable copy stays on the old conversation until then. */
  private restoreStrandedDraft(session: Session): void {
    if (!this.sessionHasLiveOwner(session) || session.needsProvider) return;
    const draft = session.strandedDraft;
    if (!draft) return;
    const originId = session.strandedDraftSessionId;
    session.strandedDraft = undefined;
    session.strandedDraftSessionId = undefined;
    if (originId) {
      void this.updateSessionMeta((current) => {
        const meta = current[originId];
        if (!meta?.queuedDraft) return null;
        const { queuedDraft: _restored, ...rest } = meta;
        return { ...current, [originId]: rest };
      });
    }
    this.emit(session, { type: "restoreComposer", text: draft });
  }

  /** Every pinned conversation across every repo, newest pin first. Reads are
   *  grouped by the stored home cwd so this costs one index scan per repo that
   *  actually holds a pin — not one per repo in the catalog. */
  private buildPinnedSessions(): { entries: SessionListEntry[]; dots: Record<string, Dot> } {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    // Enforce authorization at build time — never trust pin metadata alone.
    const authorized = this.authorizedSessionCwds();
    const grokHome = resolveGrokHome(process.env);
    const log = (m: string) => this.host.appendLine(m);
    const byCwd = new Map<string, { cwd: string; ids: string[] }>();
    for (const [id, o] of Object.entries(overrides)) {
      if (typeof o?.pinnedAt !== "number" || !o.pinnedCwd) continue;
      // Closed project: skip the whole bucket before any disk scan.
      if (!authorizedListCwd(o.pinnedCwd, authorized, pathsEqual)) continue;
      const key = normalizeFsPath(o.pinnedCwd);
      const bucket = byCwd.get(key) ?? { cwd: o.pinnedCwd, ids: [] };
      bucket.ids.push(id);
      byCwd.set(key, bucket);
    }
    const entries: SessionListEntry[] = [];
    const cachedAdapterIds = new Set(
      [...this.allAdapterCatalogs()].flat().map((entry) => entry.id),
    );
    for (const { cwd, ids } of byCwd.values()) {
      const adapterIds = new Set(ids.filter((id) => {
        const provider = overrides[id]?.provider;
        return (provider && isAdapterProvider(provider)) || cachedAdapterIds.has(id);
      }));
      if (adapterIds.size) {
        this.scheduleAdapterHistoryRefresh("codex", cwd);
        this.scheduleAdapterHistoryRefresh("claude", cwd);
      }
      for (const id of adapterIds) {
        const cached = findCachedAdapterSession(
          this.allAdapterCatalogs(),
          id,
          [cwd],
          (entryCwd, allowed) => sessionCwdBelongsToRepo(entryCwd, allowed, pathsEqual),
        );
        if (!cached) continue;
        entries.push({
          ...cached,
          customName: overrides[id]?.customName,
          displayName: overrides[id]?.customName?.trim() || cached.rawSummary || cached.displayName,
          pinnedAt: overrides[id]?.pinnedAt,
        });
      }
      const wanted = new Set(ids.filter((id) => !adapterIds.has(id)));
      if (!wanted.size) continue;
      const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
      const present = index.filter((e) => wanted.has(e.id));
      if (!present.length) continue;
      const mtimeById = new Map(present.map((e) => [e.id, e.mtimeMs]));
      // One repo per pass, so every id in it reads from that same checkout.
      const cwdById = new Map(present.map((e) => [e.id, cwd]));
      entries.push(...this.readEntriesCachedMulti(
        present.map((e) => e.id), mtimeById, cwdById, overrides, grokHome, log,
      ));
    }
    // Newest pin on top — the same rule the repo rows use, and the one that
    // matches "I just pinned this, where did it go". Defense in depth: drop
    // any entry whose cwd slipped past the bucket gate.
    const filtered = filterEntriesByAuthorizedCwd(entries, authorized, pathsEqual);
    filtered.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    const dots: Record<string, Dot> = {};
    for (const e of filtered) dots[e.id] = this.dotForId(e.id);
    return { entries: filtered, dots };
  }

  private postPinnedSessions(clientId?: string): void {
    const hasRemote = this.remoteClients.clients().length > 0;
    // Desktop multi-folder rail OR the VS Code primary-side-bar projects view.
    const hasLocalRail = this.host.canSwitchWorkspaceFolder || !!this.projectsRail;
    if (!clientId && !hasRemote && !hasLocalRail) return;
    const message: HostMsg = { type: "pinnedSessions", ...this.buildPinnedSessions() };
    if (clientId) {
      this.sendRemoteClient(clientId, message);
      return;
    }
    if (hasLocalRail) this.postLocal(message);
    for (const id of this.remoteClients.clients()) this.sendRemoteClient(id, message);
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
   * are **trusted** generated media under the Grok home (canonical containment
   * + sessions/…/images|videos/ shape), so big videos stream from disk.
   *
   * Paths outside that provenance still render via a size-capped base64 data:
   * URI (v3.1.0 behaviour restored). Reachable only from ACP `mediaContent`
   * (agent over stdio); the agent already has full filesystem access, so
   * showing the picture to the same authenticated user adds no capability.
   * Still refuse `auth.json` by name, and never weaken renderer-facing
   * `app-resource://` registry containment.
   * Best-effort: a failure just drops the media rather than breaking the turn.
   */
  private async postGeneratedMedia(m: MediaRef, session: Session, gen: number): Promise<void> {
    try {
      if (m.kind === "data") {
        // Same 8 MiB bound as the file-path fallback — ACP inline blocks used
        // to bypass it and could still balloon the DOM / relay.
        const decoded = base64DecodedByteLength(m.data);
        if (decoded > MAX_INLINE_MEDIA_BYTES) {
          this.host.appendLine(
            `[media] refused oversized inline media (${decoded} > ${MAX_INLINE_MEDIA_BYTES})`,
          );
          return;
        }
        this.emit(session, { type: "media", media: m.media, src: `data:${m.mimeType};base64,${m.data}` });
        return;
      }
      if (m.kind === "uri") {
        this.emit(session, { type: "media", media: m.media, url: m.uri });
        return;
      }
      // Provenance is mandatory before either serving or reading. In particular,
      // a failed Codex generated_images containment check must never fall through
      // to the data-URI branch and deliver arbitrary bytes to a remote.
      if (!this.isServableFromDisk(m.path, session.provider)) {
        this.host.appendLine(`[media] refused generated media path outside its trusted root`);
        return;
      }
      const mime = m.mimeType || guessMediaMime(m.path);
      // Trusted session media: stream from disk when the webview can.
      const webview = this.view?.webview;
      if (webview) {
        const src = webview.asWebviewUri(Uri.file(m.path));
        this.emit(session, { type: "media", media: m.media, src, mimeType: mime, path: m.path });
        return;
      }
      // The path passed canonical containment but this surface has no served
      // webview root. Inline only that trusted file, with the ordinary size cap.
      const bytes = await this.host.fs.readFile(Uri.file(m.path));
      if (gen !== session.gen) return;
      if (bytes.byteLength > MAX_INLINE_MEDIA_BYTES) {
        this.host.appendLine(
          `[media] refused oversized media for data: inline (${bytes.byteLength} > ${MAX_INLINE_MEDIA_BYTES}): ${m.path}`,
        );
        return;
      }
      const b64 = Buffer.from(bytes).toString("base64");
      this.emit(session, { type: "media", media: m.media, src: `data:${mime};base64,${b64}`, path: m.path });
    } catch (e) {
      this.host.appendLine(`[media] failed to forward generated media: ${(e as Error).message}`);
    }
  }

  /**
   * True when `p` is trusted generated media under the Grok home: realpath
   * stays inside `~/.grok` and the path matches sessions/…/images|videos/.
   * Lexical-only checks would let a symlink escape and still pass.
   */
  private isServableFromDisk(p: string, provider: AcpProvider = "grok"): boolean {
    try {
      if (provider === "codex") {
        return isTrustedCodexGeneratedImagePath(
          p,
          resolveCodexHome(process.env),
          (candidate) => fs.realpathSync(candidate),
        );
      }
      const home = resolveGrokHome();
      return isTrustedGeneratedMediaPath(p, home, (candidate) => fs.realpathSync(candidate));
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
        // Node fs against globalStorage's fsPath — same as v3.1.0 (extension host
        // sees the remote disk when running remotely).
        const dir = path.join(this.context.globalStorageUri.fsPath, "exports");
        fs.mkdirSync(dir, { recursive: true });
        const stamp = Date.now();
        const file = path.join(dir, `${base}-${stamp}.${pngBytes ? "png" : "svg"}`);
        fs.writeFileSync(file, pngBytes ?? (msg.svg ?? ""), pngBytes ? undefined : "utf8");
        // Host-created path under globalStorage — not a renderer-supplied path.
        await this.host.openHostResolvedPath(file);
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
      const pick = await this.host.showQuickPick(items, {
        placeHolder: `Export ${base} as…`,
      });
      if (!pick) return;

      const ext = pick.fmt === "png" ? "png" : "svg";
      const defaultName = `${base}.${ext}`;
      const defaultPath = path.join(this.sessionCwd(session), defaultName);
      const filters: Record<string, string[]> =
        ext === "png" ? { "PNG image": ["png"] } : { "SVG image": ["svg"] };
      const target = await this.host.showSaveDialog({ defaultPath, filters });
      if (!target) return;

      if (pick.fmt === "png") {
        const pngBytes = toBytes(msg.png);
        fs.writeFileSync(target, pngBytes ?? Buffer.from(msg.svgDark ?? "", "utf8"));
      } else {
        const svg = pick.fmt === "svgDark" ? msg.svgDark : msg.svgLight;
        fs.writeFileSync(target, svg ?? "", "utf8");
      }
    } catch (e) {
      this.host.appendLine(`[export] failed: ${(e as Error).message}`);
      void this.host.showErrorMessage(`Export failed: ${(e as Error).message}`);
    }
  }

  /**
   * Sign out of the Grok CLI (`grok logout` — clears `~/.grok/auth.json`). The
   * CLI owns auth, so we shell out to it, tear down the live session, and drop
   * the webview back to the auth-required onboarding state. Resolves issue #13.
   */
  async logout(
    provider: AcpProvider = "grok",
    opts: { fromRemote?: boolean; report?: (text: string) => void } = {},
  ): Promise<void> {
    // Every failure below goes through here. A cloud environment has nobody at
    // its desk: a modal blocks on an answer that never comes, and an error
    // dialog is simply never seen — so the remote closed Settings believing it
    // had signed out while the account stayed connected. Caught in review, after
    // only the CONFIRMATION modal was made remote-aware.
    const fail = (text: string) => {
      this.host.appendLine(`[providers] ${text}`);
      if (opts.report) opts.report(text);
      else void this.host.showErrorMessage(text);
    };
    if (isAdapterProvider(provider)) {
      const cliPath = this.locateProvider(provider);
      const name = providerDisplayName(provider);
      if (!cliPath) {
        fail(`${name} sign-out could not run because the ${name} CLI was not found. The account remains connected.`);
        return;
      }
      // The modal is the DESK's confirmation step. A cloud environment has
      // nobody at its desk, so showing one there asks a question no one can
      // answer and the sign-out simply never happens. The remote already
      // clicked Sign out on the only surface that host has.
      if (!opts.fromRemote) {
        const choice = await this.host.showWarningMessage(
          `Sign out of ${name}? This clears the ${name} CLI's cached credentials.`,
          { modal: true },
          "Sign Out",
        );
        if (choice !== "Sign Out") return;
      }
      const logoutArgs = provider === "claude" ? ["auth", "logout"] : ["logout"];
      try {
        await execGrokCli(cliPath, logoutArgs, { timeout: 30_000, windowsHide: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
          // The terminal fallback is a DESK affordance: it works because someone
          // is there to read it. On a cloud box it opens a window nobody sees and
          // reports success that never happened, so that path is desk-only.
          if (!opts.fromRemote) {
            this.host.createTerminal({ name: `${name} Logout`, shellPath: cliPath, shellArgs: logoutArgs }).show();
            // The cause, in the log, next to the sentence that hides it. This
            // branch fires when the resolved CLI cannot be executed at all —
            // on Windows that is almost always an extensionless npm shim run
            // without a shell — and the user-facing text cannot say that, so
            // for months the only record was "could not be observed" with no
            // path and no errno (owner hit it on a stale extension host,
            // 2026-08-31).
            this.host.appendLine(`[providers] ${provider} logout spawn failed: ${cliPath} (${code}) ${errorDetail(error)}`);
            fail(`${name} sign-out could not be observed, so it was opened in a terminal. The account remains connected until sign-out is confirmed.`);
          } else {
            fail(`${name} sign-out could not run here: ${errorDetail(error)}. The account remains connected.`);
          }
        } else {
          fail(`${name} sign-out failed: ${errorDetail(error)}. The account remains connected.`);
        }
        this.postProviderState();
        return;
      }
      await this.finishProviderLogout(provider, opts.report);
      return;
    }
    const cliPath = this.locateProvider("grok");
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform, provider: "grok" });
      return;
    }
    if (!opts.fromRemote) {
      const choice = await this.host.showWarningMessage(
        "Sign out of Grok? This clears the CLI's cached credentials.",
        { modal: true },
        "Sign Out",
      );
      if (choice !== "Sign Out") return;
      // shellPath/shellArgs, not sendText — a quoted path typed into PowerShell
      // is parsed as a string literal rather than an invocation.
      this.host.createTerminal({ name: "Grok Logout", shellPath: cliPath, shellArgs: ["logout"] });
      await this.finishProviderLogout("grok", opts.report);
      return;
    }
    // A terminal nobody can see is not evidence. Run it and WAIT, so the
    // disconnected state is recorded only if the CLI actually cleared the
    // credential — the desk path can be optimistic because a person is watching
    // the terminal it opened.
    try {
      await execGrokCli(cliPath, ["logout"], { timeout: 30_000, windowsHide: true });
    } catch (error) {
      fail(`Grok sign-out failed: ${errorDetail(error)}. The account remains connected.`);
      this.postProviderState();
      return;
    }
    await this.finishProviderLogout("grok", opts.report);
  }

  private async finishProviderLogout(
    provider: AcpProvider,
    report?: (text: string) => void,
  ): Promise<void> {
    this.setProviderConnectedInMemory(provider, false);
    // Next sign-in starts at step 1 again. The latch stops the advice from
    // repeating inside one flow; a sign-out ends the flow, and the account
    // setting it names is the first thing to check before the next one.
    this.deviceLoginPreflightShown.delete(provider);
    const reset = this.resetProviderSessionsAfterLogout(provider);
    try {
      await this.persistProviderConnections();
    } catch (error) {
      const providerName = providerDisplayName(provider);
      const detail = errorDetail(error);
      this.host.appendLine(`[providers] ${providerName} signed out, but saving connection state failed: ${detail}`);
      const text = `${providerName} signed out and its conversations were reset, but the disconnected state could not be saved: ${detail}`;
      // Same reason as the failures above: on a cloud box a dialog is nobody's.
      if (report) report(text);
      else await this.host.showErrorMessage(text);
    }
    await reset;
    this.postSessionsList();
  }

  private async resetProviderSessionsAfterLogout(provider: AcpProvider): Promise<void> {
    const affectedClients = this.remoteClients.clients().filter(
      (clientId) => this.remoteClients.active(clientId)?.provider === provider,
    );
    const queuedByClient = new Map(affectedClients.map((clientId) => {
      const active = this.remoteClients.active(clientId);
      return [clientId, {
        id: active?.activeSessionId,
        text: active ? queuedSendsText(active.queuedSends) : "",
      }] as const;
    }));
    const connected = this.connectedProviders();
    // Never the opposite provider just because this one signed out: with nothing
    // connected that mints a session bound to an account the user does not have,
    // and `defaultProviderForProject` already declines to name a disconnected
    // one. Replacements made with nothing connected carry `needsProvider`
    // instead, and reconnecting any provider adopts them.
    const needsProvider = connected.length === 0;
    const replacementProvider = (cwd: string) => this.defaultProviderForProject(cwd);
    const providerName = providerDisplayName(provider);
    const detachedReplacements: Session[] = [];
    const detachedSessions = this.remoteClients.replaceDetachedActiveWhere(
      (session) => session.provider === provider,
      (cwd, session) => {
        const replacement = new Session();
        replacement.provider = replacementProvider(cwd);
        replacement.needsProvider = needsProvider;
        replacement.priming = connected.length > 0;
        this.setSessionCwd(replacement, cwd, this.workspaceRoot());
        replacement.lastActiveAt = Date.now();
        const queuedText = queuedSendsText(session.queuedSends);
        // Nothing will start this tab until an account comes back, so the draft
        // has to outlive the buffered notice below (a start clears the buffer).
        if (queuedText) {
          replacement.strandedDraft = queuedText;
          replacement.strandedDraftSessionId = session.activeSessionId;
        }
        replacement.buffer.push({ type: "clearMessages" });
        // A sign-out notice is momentary UI, never conversation history. A tab
        // that was detached at the instant of sign-out misses the notice; its
        // draft remains safe in META and is restored after a successful start.
        detachedReplacements.push(replacement);
        return replacement;
      },
    );
    const affectedSessions = new Set<Session>([
      ...[...this.pool].filter((session) => session.provider === provider),
      ...affectedClients
        .map((clientId) => this.remoteClients.active(clientId))
        .filter((session): session is Session => !!session),
      ...detachedSessions,
    ]);
    if (this.focused.provider === provider) affectedSessions.add(this.focused);
    const replacingFocused = this.focused.provider === provider;
    const focusedQueuedText = replacingFocused ? queuedSendsText(this.focused.queuedSends) : "";
    const focusedDraftId = replacingFocused ? this.focused.activeSessionId : undefined;
    const focusedCwd = replacingFocused ? this.sessionCwd(this.focused) : "";
    const backgroundQueued = [...affectedSessions]
      .filter((session) =>
        session !== this.focused &&
        !this.remoteClients.isActiveValueVisible(session) &&
        !detachedSessions.includes(session) &&
        session.queuedSends.length > 0
      )
      .map((session) => ({
        id: session.activeSessionId,
        name: this.sessionDisplayName(session) || "a background conversation",
        text: queuedSendsText(session.queuedSends),
      }));

    for (const affected of affectedSessions) {
      const text = queuedSendsText(affected.queuedSends);
      if (text && affected.activeSessionId) {
        await this.rememberQueuedDraft(affected.activeSessionId, text);
      }
    }

    // A signed-out session with nothing in it is a shell, and a sign-out is
    // the moment it stops having any owner at all. Left on disk each one is an
    // "Untitled" row in the rail that nobody can account for — the owner
    // counted three after a few connect/disconnect cycles (2026-08-31) — and
    // the periodic sweep is age-gated at thirty minutes, so it collects them
    // long after they have been read as a bug. Drafts were persisted to meta
    // above, so "empty" here is genuinely empty. Read BEFORE dispose, which
    // clears the ids this needs.
    const shells = [...affectedSessions]
      .filter((s) => !s.hasHistory && !s.worktree && s.chips.length === 0 && !s.priming
        && !s.strandedDraft && s.queuedSends.length === 0 && !!s.activeSessionId)
      .map((s) => ({ id: s.activeSessionId, cwd: this.sessionCwd(s), provider: s.provider }));
    // Atomic boundary: detach every signed-out-provider client before any
    // replacement startup can await. Membership is provider identity only;
    // another provider's crashed/clientless session remains resumable.
    for (const session of affectedSessions) this.disposeSession(session);
    for (const shell of shells) {
      if (isAdapterProvider(shell.provider)) {
        void this.discardAdapterEmptySession(shell.provider, shell.id, shell.cwd);
      } else {
        this.removeSessionFromDisk(shell.id, shell.cwd);
      }
    }

    let localReplacement: Session | undefined;
    if (replacingFocused) {
      const cwd = authorizedListCwd(focusedCwd, this.authorizedSessionCwds(), pathsEqual)
        ?? this.workspaceRoot();
      const replacement = this.newLocalSession();
      replacement.provider = replacementProvider(cwd);
      replacement.needsProvider = needsProvider;
      this.setSessionCwd(replacement, cwd, this.workspaceRoot());
      replacement.priming = connected.length > 0;
      replacement.lastActiveAt = Date.now();
      this.focused = replacement;
      this.pool.add(replacement);
      localReplacement = replacement;
      this.post({ type: "clearMessages" });
      // With an account left, the draft goes straight back into the composer it
      // was typed in. With none, that composer is behind the onboarding overlay,
      // so hold it until reconnect gives it somewhere visible to land.
      if (focusedQueuedText) {
        replacement.strandedDraft = focusedQueuedText;
        replacement.strandedDraftSessionId = focusedDraftId;
      }
      if (connected.length) this.emit(replacement, { type: "setBusy", value: true, locked: true });
      else this.post({ type: "onboarding", state: "connect-agent", platform: process.platform });
    }

    const remoteReplacements = new Map<string, Session>();
    for (const clientId of affectedClients) {
      this.dropRemoteVoice(clientId);
      this.remoteClients.deleteActive(clientId);
      const cwd = this.remoteClients.cwd(clientId);
      const replacement = new Session();
      replacement.provider = replacementProvider(cwd);
      replacement.needsProvider = needsProvider;
      replacement.priming = connected.length > 0;
      this.setSessionCwd(replacement, cwd, this.workspaceRoot());
      replacement.lastActiveAt = Date.now();
      this.remoteClients.setActive(clientId, replacement);
      remoteReplacements.set(clientId, replacement);
      this.emit(replacement, { type: "clearMessages" });
      const queued = queuedByClient.get(clientId);
      if (queued?.text) {
        replacement.strandedDraft = queued.text;
        replacement.strandedDraftSessionId = queued.id;
      }
      if (connected.length) {
        this.emit(replacement, { type: "setBusy", value: true, locked: true });
      } else {
        this.sendRemoteClient(
          clientId,
          this.buildSessionsList(this.remoteClients.cwd(clientId), undefined, null),
        );
        this.sendRemoteClient(clientId, {
          type: "onboarding",
          state: "connect-agent",
          platform: process.platform,
        });
      }
      this.sendRemoteClient(clientId, {
        type: "error",
        text: `${providerName} was signed out, so that conversation ended. This tab has been reset${connected.length ? " to a fresh session" : ""}.`,
      });
    }

    // A background conversation's draft belongs to that conversation, not to
    // whoever happens to be focused: `post` forwards to the remote clients
    // attached to the focused session, so an unrelated phone tab received text
    // typed into a different conversation — and being unbuffered, the only copy
    // died on the next focus switch or reload. The draft is persisted to its own
    // meta (restored by `restorePersistedDraft` when that conversation next
    // starts) and the desk gets a transient, content-light pointer to it.
    const draftNoticeTarget = localReplacement ?? this.focused;
    for (const queued of backgroundQueued) {
      if (!queued.id) {
        this.emitLocalTransient(draftNoticeTarget, {
          type: "error",
          text: `${providerName} was signed out while ${queued.name} had an unsaved draft:\n\n${queued.text}`,
        });
        continue;
      }
      this.emitLocalTransient(draftNoticeTarget, {
        type: "error",
        text: `${providerName} was signed out while “${queued.name}” had a draft. It is saved — open that conversation to get it back.`,
      });
    }

    // Startup begins only after the atomic disposal/re-home phase above. Sends
    // during any stall now target an inert replacement and stay composer/queue
    // owned; no signed-out client remains reachable locally or remotely.
    if (localReplacement && connected.length) {
      const started = await this.startSession(undefined, localReplacement);
      if (started && !localReplacement.needsProvider) this.restoreStrandedDraft(localReplacement);
    }
    if (connected.length) {
      for (const [clientId, replacement] of remoteReplacements) {
        const started = await this.startSession(undefined, replacement);
        if (started && !replacement.needsProvider) this.restoreStrandedDraft(replacement);
        await this.persistWorktreeBinding(replacement);
        this.sweepEmptySessions(this.sessionCwd(replacement));
        this.sendRemoteSessionList(replacement, this.remoteClients.tabToken(clientId));
      }
    }
    for (const replacement of detachedReplacements) this.pool.add(replacement);
    if (affectedClients.length) this.postRepoCatalog();
  }

  /**
   * Adopt every view left agent-less by a last-provider sign-out.
   *
   * Signing back in used to fix only whichever session the `recheckConnection`
   * arrived on — the desk, in practice — while every phone tab kept a
   * replacement bound to nothing, with no action available on it. Provider
   * connection is machine-wide, so the recovery has to be too: local focused,
   * every remote tab, and the detached replacements sitting in the pool waiting
   * for their tab to come back.
   */
  /**
   * A provider just became usable — put every view that was waiting for one to
   * work.
   *
   * Both ways in end here: Settings' "Check again" (`recheckConnection`) and
   * the device-code sign-in a phone or a cloud machine uses. The second one did
   * none of this until 2026-08-31: it promoted the account and stopped, so the
   * tab that had just signed in kept an empty model picker and a card still
   * offering to connect, and only a page reload — which starts a session for
   * its own reasons — put the agent on screen.
   */
  private async adoptSessionsForConnectedProvider(
    provider: AcpProvider,
    session: Session,
  ): Promise<void> {
      // Every view stranded by a last-provider sign-out, not just this one.
      const adopted = await this.retargetNeedsProviderSessions(provider);
      // An empty conversation bound to a provider that cannot answer has
      // nothing worth preserving, so hand it to the one just connected. This
      // used to require `firstConnection`, computed from CONNECTED providers,
      // so a lapsed Codex made connecting Grok look like a second account and
      // the empty session stayed on Codex — asking for a codex login while
      // the picker read Grok 4.6. What matters is whether the session's own
      // provider can answer, not how many others are linked.
      // Both halves matter: the session is stranded on something that cannot
      // answer, AND the provider just re-checked can. A FAILED re-check leaves
      // it unusable, and handing the empty session to it there would start a
      // session against an agent that just refused to authenticate.
      const nowUsable = this.usableProviders();
      const strandedOnUnusable = !session.hasHistory
        && !nowUsable.includes(session.provider)
        && nowUsable.includes(provider);
      // Say it worked. An empty session looks exactly like a re-check that did
      // nothing, and this is the moment someone most wants confirmation. Only
      // on a conversation with no history — a real transcript is its own
      // evidence, and the panel would cover it.
      // Announced once, after whichever branch ran, and only when the re-check
      // actually succeeded. It was previously wired into two of the four
      // outcomes and missed the most ordinary one — the session is already on
      // this provider and simply starts — so the confirmation the owner asked
      // for did not appear in the case he was testing.
      const confirmConnected = () => {
        if (session.hasHistory || !this.usableProviders().includes(provider)) return;
        // No folder to start in — "You can start grokking!" would be a lie.
        // startSession already painted no-project.
        if (this.host.canSwitchWorkspaceFolder && !this.openWorkspaceFolders().length) return;
        this.emit(session, {
          type: "onboarding",
          state: "provider-connected",
          platform: process.platform,
          provider,
        });
      };
      if (adopted.has(session)) {
        this.postSessionsList();
      } else if (strandedOnUnusable) {
        session.provider = provider;
        await this.rememberProjectProvider(this.sessionCwd(session), provider);
        await this.startSession(undefined, session);
      } else if (session.provider === provider && !session.client) {
        // Retry a provider whose first real session exposed a credential error.
        await this.startSession(session.hasHistory ? session.activeSessionId : undefined, session);
      } else {
        // Adding a second account must not restart or change a conversation
        // with history on screen. But an EMPTY one has nothing to protect,
        // and leaving its picker stale meant the newly connected agent's
        // models only appeared after clicking New session — for a session
        // that already was new. Re-post the catalog so the picker picks it up
        // in place.
        if (isAdapterProvider(provider)) this.scheduleAdapterHistoryRefresh(provider, this.sessionCwd(session));
        if (!session.hasHistory) this.postSessionModels(session);
        this.postSessionsList();
      }
      // Re-post after the branches, not just after setProviderConnected: the
      // credential re-probe and any retarget above change what a provider row
      // should say, and Settings → Providers reads this. Without it a freshly
      // connected agent still showed its old state there until something else
      // happened to refresh the panel.
      this.postProviderState();
      confirmConnected();
  }

  private async retargetNeedsProviderSessions(provider: AcpProvider): Promise<Set<Session>> {
    const targets = new Set<Session>();
    const consider = (session: Session | undefined) => {
      if (session?.needsProvider) targets.add(session);
    };
    consider(this.focused);
    for (const session of this.pool) consider(session);
    for (const session of this.remoteClients.detachedActiveValues()) consider(session);
    const clientOf = new Map<Session, string>();
    for (const clientId of this.remoteClients.clients()) {
      const active = this.remoteClients.active(clientId);
      consider(active);
      if (active?.needsProvider) clientOf.set(active, clientId);
    }
    if (!targets.size) return targets;
    // Bind and lock all of them before the first start can await, for the same
    // reason the sign-out path detaches before it starts: a send arriving
    // mid-adoption must queue against a priming session, not fall back through
    // the refusal path it is being rescued from.
    for (const session of targets) {
      session.provider = provider;
      session.priming = true;
      this.emit(session, { type: "setBusy", value: true, locked: true });
    }
    // `needsProvider` is cleared by a start that actually succeeds, so a refused
    // one (closed folder, missing CLI) stays adoptable by the next re-check
    // rather than becoming permanently unreachable.
    for (const session of targets) {
      const started = await this.startSession(undefined, session);
      const clientId = clientOf.get(session);
      if (clientId) {
        await this.persistWorktreeBinding(session);
        this.sweepEmptySessions(this.sessionCwd(session));
        this.sendRemoteSessionList(session, this.remoteClients.tabToken(clientId));
      }
      if (started && !session.needsProvider) this.restoreStrandedDraft(session);
    }
    return targets;
  }

  dispose(): void {
    void this.host.setContext("grok.composerFocus", false);
    if (this.reaper) { clearInterval(this.reaper); this.reaper = undefined; }
    if (this.routineTimer) { clearInterval(this.routineTimer); this.routineTimer = undefined; }
    for (const timer of this.loginReprobeTimers.values()) clearTimeout(timer);
    this.cancelAllDeviceLogins();
    this.loginReprobeTimers.clear();
    for (const timer of this.turnOrderTimers) clearTimeout(timer);
    this.turnOrderTimers.clear();
    this.uplink?.dispose();
    this.uplink = undefined;
    this.codexInstallAbort?.abort(new Error("Installation cancelled."));
    this.codexInstallAbort = undefined;
    try { this.keepAwake.stop(); } catch { /* the pid watcher reaps it anyway */ }
    try { this.settingsEditor?.dispose(); } catch { /* tab already gone */ }
    this.settingsEditor = undefined;
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
    await this.waitForSessionStart(session);
    if (session.client) return session.client;
    return this.startSession(session.activeSessionId, session, "ensure");
  }

  /** Read `grok --version` for policy checks. Returns "" on failure (logged). */
  private async readGrokVersion(cliPath: string, timeout = 30_000): Promise<string> {
    try {
      const { stdout } = await execGrokCli(cliPath, ["--version"], { timeout });
      const output = stdout?.trim() ?? "";
      const parsed = parseGrokVersion(output);
      if (parsed) this.providerCliVersions.grok = parsed.join(".");
      return output;
    } catch (e) {
      this.host.appendLine(`grok --version failed: ${(e as Error).message}`);
      return "";
    }
  }

  private probeProviderVersion(provider: AcpProvider): Promise<string> {
    if (provider === "codex") return this.probeCodexVersion();
    if (provider === "claude") return this.probeClaudeVersion();
    if (this.grokVersionProbe) return this.grokVersionProbe;
    this.grokVersionProbe = (async () => {
      const cliPath = this.locateProvider("grok");
      if (!cliPath) return "";
      const output = await this.readGrokVersion(cliPath);
      this.postProviderState();
      return this.providerCliVersions.grok ?? output;
    })();
    return this.grokVersionProbe;
  }

  /** Read `codex --version` once per activation. The adapter handshake reports
   * its own package version, not the binary it launches. */
  private probeCodexVersion(): Promise<string> {
    if (this.codexVersionProbe) return this.codexVersionProbe;
    this.codexVersionProbe = (async () => {
      const cliPath = this.locateProvider("codex");
      if (!cliPath) return "";
      try {
        const { stdout } = await execGrokCli(cliPath, ["--version"], {
          timeout: 30_000,
          windowsHide: true,
        });
        const version = parseCodexVersionOutput(stdout ?? "");
        if (!version) throw new Error("unrecognized version output");
        this.providerCliVersions.codex = version;
        this.postProviderState();
        return version;
      } catch (error) {
        this.host.appendLine(`codex --version failed: ${(error as Error).message}`);
        this.postProviderState();
        return "";
      }
    })();
    return this.codexVersionProbe;
  }

  /** Read `claude --version` once per activation. The adapter handshake version
   * is a stale package constant (0.49.0 on 0.69.0) and must not be displayed. */
  private probeClaudeVersion(): Promise<string> {
    if (this.claudeVersionProbe) return this.claudeVersionProbe;
    this.claudeVersionProbe = (async () => {
      const cliPath = this.locateProvider("claude");
      if (!cliPath) return "";
      try {
        const { stdout } = await execGrokCli(cliPath, ["--version"], {
          timeout: 30_000,
          windowsHide: true,
        });
        const version = parseClaudeVersionOutput(stdout ?? "");
        if (!version) throw new Error("unrecognized version output");
        this.providerCliVersions.claude = version;
        this.postProviderState();
        return version;
      } catch (error) {
        this.host.appendLine(`claude --version failed: ${(error as Error).message}`);
        this.postProviderState();
        return "";
      }
    })();
    return this.claudeVersionProbe;
  }

  /** Once per extension upgrade, from session start, with a fresh install only
   * establishing the baseline. Bounded at 20s and attempted ONCE per extension
   * version whether or not it succeeds — it blocks the composer, and a network
   * that cannot reach x.ai would otherwise re-charge that wait on every
   * window. */
  private async maybeUpdateCliOnUpgrade(cliPath: string): Promise<void> {
    if (this.cliUpdateChecked) return;
    this.cliUpdateChecked = true;
    const current = this.context.extensionVersion;
    const lastSeen = this.state.get<string>(CLI_UPDATE_VERSION_KEY);
    try {
      if (!extensionWasUpgraded(lastSeen, current)) return;
      const policy = grokUpdatePolicy(await this.readGrokVersion(cliPath), process.platform);
      if (!policy.allow) {
        this.host.appendLine(
          `Extension upgraded ${lastSeen} → ${current}; skipping silent CLI update (${policy.note}).`,
        );
        return;
      }
      const args = policy.target ? ["update", "--version", policy.target] : ["update"];
      this.host.appendLine(
        `Extension upgraded ${lastSeen} → ${current}; updating grok CLI (silent: ${args.join(" ")}).`,
      );
      this.post({ type: "cliUpdating" });
      try {
        // 20s, not the 180s the manual update gets. This one is awaited BEFORE
        // the CLI spawns, with the composer already locked, so every second of
        // it is a second the user cannot type — and it is optional work: the
        // installed binary is fine. A no-op `grok update` is ~0.8s where x.ai
        // is reachable and 68s where it is not (measured by funkpopo behind a
        // blocked x.ai, PR #129), so a short budget separates the two without
        // needing to detect which network we are on.
        const { stdout, stderr } = await execGrokCli(cliPath, args, { timeout: 20_000 });
        if (stdout?.trim()) this.host.appendLine(stdout.trim());
        if (stderr?.trim()) this.host.appendLine(stderr.trim());
      } catch (e) {
        this.host.appendLine(`grok update failed (continuing with current binary): ${(e as Error).message}`);
      }
    } finally {
      // ONE attempt per extension version, whatever the outcome.
      //
      // This used to leave the marker unwritten on failure so the next window
      // would retry, reasoning that the likely cause was transient — on Windows
      // another grok.exe holding the binary's lock, which a worktree create
      // leaves for a moment. That is true of a lock, which fails instantly and
      // costs nothing to retry. It is false of an unreachable x.ai: that
      // failure is persistent, and retrying it charged the full timeout to
      // session startup on EVERY new window, indefinitely. A user behind a
      // blocked x.ai paid it forever (funkpopo, PR #129).
      //
      // So a failed attempt now counts as the attempt. The cost of being wrong
      // is small and self-correcting: the update is optional, the version floor
      // and Plan-mode checks still run against whatever is installed, and the
      // CLI's own autoUpdate catches it up. The next extension version tries
      // again.
      void this.state.update(CLI_UPDATE_VERSION_KEY, current);
    }
  }

  /**
   * Probe the installed CLI and decide Plan availability. Fail-closed when the
   * version cannot be read, but that outcome is *not* latched — only a live
   * parseable below-floor banner sticks for the session. Retries once on
   * empty/unparseable output, then falls back to the last verified banner for
   * this binary when the file identity still matches. A cache hit keeps that
   * availability and is never treated as verified — initialize must not use
   * `cliVersion` unless `planModeVersionVerified` is true. Performs no update
   * or pool orchestration.
   */
  private async planModeCompatibility(
    cliPath: string,
    opts: { notify?: boolean } = {},
  ): Promise<CliCompatibilityResult> {
    const notify = opts.notify !== false;
    const cache = this.state.get<CliVersionCache>(CLI_VERSION_CACHE_KEY, {});
    const { decision, nextCache, usedCache, versionOutput } = await resolvePlanModeAvailability({
      readOnce: () => this.readGrokVersion(cliPath),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      identity: readCliBinaryIdentity(cliPath),
      cache,
    });
    if (nextCache) void this.state.update(CLI_VERSION_CACHE_KEY, nextCache);
    const parsed = parseGrokVersion(versionOutput);
    const cliVersion = parsed ? parsed.join(".") : undefined;
    if (cliVersion) this.providerCliVersions.grok = cliVersion;
    if (decision.available) {
      if (usedCache) {
        this.host.appendLine("grok --version failed; using last verified version for Plan mode.");
      }
      return { planModeAvailable: true, planModeVersionVerified: decision.verified, usedCache, cliVersion };
    }
    if (decision.verified) {
      const message =
        `grok CLI ${decision.installed} is below required version ${GROK_REQUIRED_VERSION}; ` +
        "Plan mode is unavailable.";
      this.host.appendLine(message);
      if (notify) void this.host.showWarningMessage(message);
      return {
        planModeAvailable: false,
        planModeVersionVerified: true,
        planModeUnavailableReason: decision.reason,
        usedCache,
        cliVersion,
      };
    }
    // Unverified: log + optional toast once at session start; a later Plan pick
    // re-probes without forcing a restart (#105).
    const message =
      `Could not verify the Grok CLI version (the check failed or timed out — a first run after install can be slow). ` +
      `Plan mode is unavailable until it can be checked. Pick Plan again or reload the window to retry. ` +
      `Continuing best-effort with the current binary.`;
    this.host.appendLine(message);
    if (notify) {
      void this.host.showWarningMessage(
        `Could not verify the Grok CLI version (the check failed or timed out — a first run after install can be slow). ` +
          `Pick Plan again or reload the window to retry.`,
      );
    }
    return {
      planModeAvailable: false,
      planModeVersionVerified: false,
      planModeUnavailableReason: decision.reason,
      usedCache,
      cliVersion,
    };
  }

  /** Push a Plan-availability decision onto the session and its views. */
  private applyPlanModeCompatibility(session: Session, compatibility: CliCompatibilityResult): void {
    session.planModeAvailable = compatibility.planModeAvailable;
    session.planModeUnavailableReason = compatibility.planModeUnavailableReason;
    session.planModeVersionVerified = compatibility.planModeVersionVerified;
    this.emit(session, {
      type: "planModeAvailability",
      available: compatibility.planModeAvailable,
      reason: compatibility.planModeUnavailableReason,
      recheckable: !compatibility.planModeAvailable && !compatibility.planModeVersionVerified,
    });
  }

  /**
   * Re-run the version probe for an unverified session when the user picks Plan.
   * Returns false if the CLI path is missing or the session was torn down mid-probe.
   */
  private async recheckPlanModeAvailability(session: Session): Promise<boolean> {
    const gen = session.gen;
    const cliPath = this.locateProvider("grok");
    if (!cliPath) return false;
    this.host.appendLine("Re-checking Grok CLI version for Plan mode…");
    // Silent: the initial session-start probe already notified; a second toast
    // on every pick would turn a transient into noise.
    const compatibility = await this.planModeCompatibility(cliPath, { notify: false });
    if (gen !== session.gen) return false;
    this.applyPlanModeCompatibility(session, compatibility);
    return true;
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
    this.host.appendLine(
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
      if (stdout?.trim()) this.host.appendLine(stdout.trim());
      if (stderr?.trim()) this.host.appendLine(stderr.trim());
      const detail = reason === "proactive"
        ? `Grok CLI ${fromVersion} has a known Windows startup issue (issue #22). Switched to the supported version ${GROK_STDIO_DOWNGRADE_TARGET}.`
        : `Grok CLI ${fromVersion} failed to start a session (issue #22). Switched to the supported version ${GROK_STDIO_DOWNGRADE_TARGET} and retrying.`;
      void this.host.showInformationMessage(detail);
      return true;
    } catch (e) {
      this.host.appendLine(`grok recovery update to ${GROK_STDIO_DOWNGRADE_TARGET} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * On-demand "is a newer grok available?" check for Settings → About.
   * Read-only — `grok update --check --json` doesn't touch the binary, so it's
   * safe while a session is live. Posts a grokUpdateStatus back to the webview.
   */
  private async checkGrokUpdate(): Promise<void> {
    const connected = this.connectedProviders();
    if (connected.includes("codex")) void this.probeCodexVersion();
    if (!connected.includes("grok")) return;
    const cliPath = this.locateProvider("grok");
    if (!cliPath) {
      this.postGrokUpdateStatus({ type: "grokUpdateStatus", error: "grok CLI not found" });
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
      this.postGrokUpdateStatus({
        type: "grokUpdateStatus",
        current: info.currentVersion ?? null,
        latest: info.latestVersion ?? null,
        updateAvailable: !!info.updateAvailable,
        policy,
      });
    } catch (e) {
      this.host.appendLine(`grok update --check failed: ${(e as Error).message}`);
      this.postGrokUpdateStatus({ type: "grokUpdateStatus", error: (e as Error).message, policy });
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
    const cliPath = this.locateProvider("grok");
    if (!cliPath) {
      this.post({ type: "onboarding", state: "missing-cli", platform: process.platform, provider: "grok" });
      return;
    }
    // Enforce the update policy (issue #22) server-side too — the menu already
    // disables the action when blocked, but never move the CLI onto an
    // unsupported Windows build even if the message arrives some other way.
    const policy = grokUpdatePolicy(await this.readGrokVersion(cliPath), process.platform);
    if (!policy.allow) {
      void this.host.showInformationMessage(
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
      const choice = await this.host.showWarningMessage(
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
        if (stdout?.trim()) this.host.appendLine(stdout.trim());
        if (stderr?.trim()) this.host.appendLine(stderr.trim());
        return true;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === 0 && isLockedBinaryError(msg)) {
          this.host.appendLine("grok update hit a locked binary; pausing then retrying once…");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        this.host.appendLine(`grok update failed: ${msg}`);
        if (notifyFailure) {
          void this.host.showWarningMessage(`Grok Build update failed: ${msg}`);
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
    const choice = await this.host.showInformationMessage(
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
      this.host.appendLine(`[sessions] could not discard empty session ${oldId}: ${(e as Error).message}`);
    }
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
    void this.state.update(SESSION_META_KEY, next);
    this.sessionCache.delete(oldId);
    this.postSessionsList();
  }

  private sessionStartTailMap(): WeakMap<Session, Promise<void>> {
    return (this.sessionStartTails ??= new WeakMap());
  }

  private runExclusiveSessionStart<R>(session: Session, action: () => Promise<R>): Promise<R> {
    const tails = this.sessionStartTailMap();
    const previous = tails.get(session) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(session, tail);
    return run.finally(() => {
      if (tails.get(session) === tail) tails.delete(session);
    });
  }

  private async waitForSessionStart(session: Session): Promise<void> {
    const tail = this.sessionStartTailMap().get(session);
    if (tail) await tail;
  }

  private emitAbandonedSend(session: Session): void {
    if (session.staleSendReported) return;
    session.staleSendReported = true;
    // Generic `error`, not agentError: after a gen bump this Session is the
    // replacement, and agentError would clear its startup lock or a flushed
    // follow-on turn.
    this.emit(session, { type: "error", text: INTERRUPTED_SEND_TEXT, code: INTERRUPTED_SEND_CODE });
  }

  /** `clock` lets a CALLER start the measurement where the user's click landed.
   *  Opening a conversation resolves a cwd, reads session meta and waits on the
   *  workspace queue before it ever reaches here, and a clock made in this
   *  function cannot see any of it — measured at 86-131ms on the QA fixture and
   *  225-352ms once `session-meta.json` reaches the 1.47MB a heavy real store
   *  has (`npm run e2e:open-timing`). That window is where a slow open would
   *  hide, so the callers that have a click to time pass their own. */
  private async startSession(
    resumeId?: string,
    target: Session = this.focused,
    intent: SessionStartIntent = "replace",
    clock?: OpenClock,
  ): Promise<AcpClient | undefined> {
    return this.runExclusiveSessionStart(target, () => this.startSessionBody(resumeId, target, intent, clock));
  }

  private async startSessionBody(
    resumeId: string | undefined,
    target: Session,
    intent: SessionStartIntent,
    startedClock?: OpenClock,
  ): Promise<AcpClient | undefined> {
    // Read the caller's clock BEFORE this function can add to it: the load
    // reservation, the workspace-switch queue, the cwd resolution, the
    // `session-meta.json` read and the wait for the exclusive start lock are
    // all already on it, and all of them belong to `resolve`.
    const clock = startedClock ?? new OpenClock();
    // A re-entry (the reactive downgrade below) arrives with the first pass's
    // phases already on it. Fold them into one NAMED phase and subtract it, so
    // the failed attempt keeps its own number instead of being reported as
    // session resolution. Zero on every ordinary open.
    const priorMs = clock.collapse("downgrade");
    const resolveMs = clock.totalMs() - priorMs;
    let approveGateMs = 0;
    // Desktop with no open folder: empty rail is valid — do not spawn grok
    // against process.cwd(). Unlock the baked "Starting" welcome; returning
    // silently here left first-run / last-project-removed on that spinner
    // forever (the HTML default is busy "Starting", and nothing else cleared
    // it). Adding a folder starts a session via select/switch.
    if (
      this.host.canSwitchWorkspaceFolder &&
      !this.openWorkspaceFolders().length &&
      !resumeId &&
      !target.cwd
    ) {
      this.presentEmptyProjectState(target);
      return undefined;
    }
    // Resume / held-session paths set target.cwd before start. A closed folder
    // must not restart just because resumeId is set (empty-open-set guard above
    // only covers the no-cwd case).
    if (
      this.host.canSwitchWorkspaceFolder &&
      target.cwd &&
      !this.isAuthorizedCwd(target.cwd)
    ) {
      this.host.appendLine(
        `[sessions] refused startSession (cwd not authorized): ${target.cwd}` +
          (resumeId ? ` resumeId=${resumeId}` : ""),
      );
      if (!this.openWorkspaceFolders().length) {
        this.presentEmptyProjectState(target);
      } else {
        target.priming = false;
        this.emit(target, { type: "setBusy", value: false });
        this.postRepoCatalog();
        this.postSessionsList();
      }
      return undefined;
    }
    // An EMPTY conversation pinned to a provider that cannot answer just moves
    // to one that can, silently. There is nothing to preserve — no history, no
    // model choice worth defending — and the alternative is what the owner hit:
    // Grok connected and chosen in the picker, while the turn insisted on
    // finishing a codex login because the session object still said "codex".
    // A conversation WITH history is never retargeted; that would silently
    // change who is answering someone mid-thread.
    //
    // `resumeId` is the other half of "has history": openSession mints a fresh
    // Session (hasHistory still false) and then loads an existing conversation
    // into it. Treating that as empty handed a Grok rail click to Codex, then
    // blamed Codex for the spawn that followed.
    if (!resumeId && !target.hasHistory && !this.usableProviders().includes(target.provider)) {
      const fallback = this.defaultProviderForProject(this.sessionCwd(target));
      if (fallback !== target.provider && this.usableProviders().includes(fallback)) {
        this.host.appendLine(
          `[providers] ${target.provider} cannot answer; empty session retargeted to ${fallback}`,
        );
        target.provider = fallback;
        await this.rememberProjectProvider(this.sessionCwd(target), fallback);
        this.postProviderState();
      }
    }
    if (!this.connectedProviders().includes(target.provider)) {
      const testDelay = this.testSessionStartDelay;
      if (testDelay && testDelay.resumeId === resumeId) {
        this.testSessionStartDelay = undefined;
        testDelay.started();
        await testDelay.wait;
      }
      target.priming = false;
      this.emit(target, { type: "setBusy", value: false });
      this.postProviderState();
      this.emit(target, {
        type: "onboarding",
        // Usable, not connected — with only a lapsed provider left there is
        // nothing to fall back to, so offer the choice rather than this one
        // provider's missing-CLI copy.
        state: this.usableProviders().length ? missingProviderState(target.provider) : "connect-agent",
        platform: process.platform,
        provider: target.provider,
      });
      return undefined;
    }
    // A repository that ships its own always-approve config gets consent first.
    // Deliberately here, before anything is mutated: nothing has been touched
    // yet, so declining is a clean no-op rather than a half-started session.
    const consentAt = clock.now();
    if (target.provider === "grok" && !(await this.confirmRepoForcedAutoApprove(this.sessionCwd(target)))) {
      return undefined;
    }
    // Its own phase because a modal is a PERSON reading a dialog, and folded
    // into `resolve` that would report a fast disk lookup as tens of seconds.
    // Named `approve-gate` rather than `consent` because the call also reads
    // project and global config to decide WHETHER to ask — on a slow or network
    // filesystem that is real I/O, and calling it consent would blame a human
    // who was never shown anything.
    approveGateMs = clock.elapsed(consentAt);
    // After the last await before ++gen: a send can have begun a turn (or
    // another start can have finished) while consent was up.
    const startDecision = decideSessionStart(target, resumeId, intent);
    if (startDecision === "reuse" || startDecision === "refuse-turn") {
      if (startDecision === "refuse-turn") {
        this.host.appendLine(`[sessions] refused startSession (turn in flight)`);
      }
      return target.client;
    }
    if (startDecision === "refuse-mismatch") {
      this.host.appendLine(
        `[sessions] refused startSession (ensure resumeId=${resumeId} does not match live session)`,
      );
      return undefined;
    }
    // The session this start (re)builds. Today always the focused one (pool-of-1);
    // Step D passes a pool member. Its handlers close over `session`/`gen` so a
    // backgrounded session's events stay bound to it even after focus moves.
    const session = target;
    // `resolve` is zero when the clock was made in this function, which is the
    // honest answer for the paths with no click to measure from (restart, model
    // change, provider swap).
    clock.record("resolve", resolveMs);
    clock.record("approve-gate", approveGateMs);
    const openedAt = clock.now();
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
    // The replacement session has no turn, whatever the old one was doing. This
    // matters most in the case the token exists for: a `prompt()` that never
    // settles never runs its `finally`, so the token outlives the client that
    // owned it — and resetting only `status` (which is all this used to have to
    // do) would leave the fresh session reporting a turn in flight and diverting
    // every send into the queue. A restart has always been the cure for a wedged
    // session; it stays the cure.
    session.turnToken = undefined;
    // Stop any in-progress voice capture so listening never carries across a
    // new/resumed/restarted session (covers New Session, history resume, and
    // model/effort restarts — all of which route through here).
    this.stopVoiceInput(session);
    session.client = undefined;
    // Detach and dispose as one structural operation. Nothing that can return
    // belongs between these lines: the old ACP callbacks remain live until the
    // process has actually exited.
    const disposeAt = clock.now();
    if (replacedClient) {
      // Its commands go with it, exactly as in detachClient — this path does
      // not go through that function but tears a client down all the same.
      // A cancel the CLI ignored replaces the client mid-turn, and without
      // this its terminals stay in the manager with no agent that could ever
      // release them: a running command with no owner, holding a rented
      // machine awake for the rest of the session.
      try {
        const n = this.terminalManager.releaseOwnedBy(replacedClient);
        if (n > 0) this.host.appendLine(`[terminal] released ${n} command(s) with the replaced client`);
      } catch { /* teardown is not worth failing over */ }
      await replacedClient.dispose();
      if (gen !== session.gen) return undefined;
    }
    const disposeMs = replacedClient ? clock.elapsed(disposeAt) : 0;
    clock.record("dispose", disposeMs);
    // A brand-new session starts in the remembered mode (#25) immediately, so the
    // toolbar shows the right one from the first paint — no Agent → Auto accept
    // flash while the session spins up and primes. Resumed sessions stay
    // verdict-driven (plan-restore decides), so they don't pre-apply it.
    const rememberedYolo = startsInYolo(
      this.host.getConfiguration("grok").get<string>("defaultMode", ""),
      !!resumeId,
    );
    // grok's own `permission_mode = "always-approve"` (config.toml, set via
    // Shift+Tab or `/always-approve`) auto-approves every session server-side
    // and is invisible over ACP — the CLI still reports plain agent mode. Detect
    // it so the button shows "Auto accept" instead of a misleading "Agent" (#31).
    // Applies to resumed sessions too (the config is global, not per-session).
    const configAutoApprove = session.provider === "grok" && this.configForcesAutoApprove(this.sessionCwd(session));
    session.autoApprove = rememberedYolo || configAutoApprove;
    session.planActive = false;
    session.hasHistory = false;
    session.suppressContent = false;
    session.captureAgentText = undefined;
    session.lastSessionInfoAt = 0;
    session.lastSessionInfoUsed = undefined;
    session.sessionInfoStale = false;
    session.sessionInfoUnsupported = false;
    session.sawCompactNotification = false;
    session.lastPlanText = "";
    session.pendingExitPlans.clear();
    session.pendingQuestions.clear();
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
    session.feedbackAvailable = false;
    session.feedbackUnsupported = false;
    session.feedbackMetaEnabled = undefined;
    session.feedbackCommandsAdvertise = undefined;
    session.liveFeedbackEligible = false;
    session.turnRating = 0;
    session.activeSessionId = undefined;
    session.titleGenerated = false;
    session.firstUserMessageForTitle = undefined;
    session.priming = true;
    session.compactUsageArmed = false;
    session.adapterCompactThisTurn = false;
    session.adapterTurnCallUsed = [];
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

    const cfg = this.host.getConfiguration("grok");
    const cliPath = this.locateProvider(session.provider);
    if (!cliPath) {
      if (gen !== session.gen) return undefined;
      this.pool.delete(session);
      session.priming = false;
      this.emit(session, { type: "setBusy", value: false });
      this.emit(session, {
        type: "onboarding",
        state: missingProviderState(session.provider),
        platform: process.platform,
        provider: session.provider,
      });
      return undefined;
    }

    // Keep the established once-per-extension-upgrade update trigger, then read
    // the resulting version solely to decide whether Plan is safe to expose
    // and which initialize handshake to advertise.
    // Everything before the version probe that is not the dispose itself. Cheap
    // in principle — mode/flag resets — which is exactly why it needs measuring
    // rather than assuming: an open that is slow here would otherwise land in
    // `other` with nothing to point at.
    clock.record("prep", Math.max(0, clock.elapsed(openedAt) - disposeMs));
    const versionAt = clock.now();
    let versionNote: string | undefined;
    let grokHandshakeVersion: string | undefined;
    let grokVersionVerified = false;
    if (session.provider === "grok") {
      await this.maybeUpdateCliOnUpgrade(cliPath);
      if (gen !== session.gen) return undefined;
      await this.maybePinBrokenCli(cliPath);
      if (gen !== session.gen) return undefined;
      const compatibility = await this.planModeCompatibility(cliPath);
      if (gen !== session.gen) return undefined;
      if (compatibility.usedCache) versionNote = "cached";
      // initialize cannot be renegotiated; only a live probe may change the fs handshake.
      grokVersionVerified = compatibility.planModeVersionVerified;
      grokHandshakeVersion = grokVersionVerified
        ? compatibility.cliVersion
        : undefined;
      this.applyPlanModeCompatibility(session, compatibility);
    } else {
      session.planModeAvailable = true;
      session.planModeVersionVerified = true;
      session.planModeUnavailableReason = undefined;
    }
    clock.record("version", clock.elapsed(versionAt), versionNote);
    const afterVersionAt = clock.now();

    // Worktree sessions pin cwd at creation/open; everyone else uses the workspace root.
    const cwd = session.cwd || this.workspaceRoot();
    session.cwd = cwd;
    // Re-bind worktree meta from override when resuming (cold open may only have cwd).
    if (!session.worktree && resumeId) {
      const o = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[resumeId];
      if (o?.worktreePath) {
        session.worktree = {
          path: o.worktreePath,
          label: o.worktreeLabel || path.basename(o.worktreePath),
          sourceGitRoot: o.sourceGitRoot || this.workspaceRoot(),
        };
      }
    }
    if (this.mcpConnectorKeysReady) await this.mcpConnectorKeysReady;
    if (gen !== session.gen) return undefined;
    const env = session.provider === "grok" ? this.buildEnv(cwd) : { ...process.env };
    const effortStr = cfg.get<string>("defaultEffort", "");
    const effort = effortStr ? (effortStr as EffortLevel) : undefined;
    // Transient spawn/init after an update can throw once; retry the plain
    // failure only (auth and the Windows stdio pin keep their own paths).
    const startSpawnAttempts = 3;
    const startSpawnBackoffMs = [300, 900] as const;
    const createBoundClient = (): AcpClient => {
    const client = new AcpClient({
      cliPath,
      cwd,
      env,
      effort,
      log: (msg) => this.host.appendLine(msg),
      timeouts: this.acpClientTimeouts(),
      mcpServers: () => this.hostMcpServersFor(session),
      ...(session.provider === "grok"
        ? { grokVersion: grokHandshakeVersion, grokVersionVerified }
        : { backend: this.createProviderBackend(session.provider) }),
    });
    session.client = client;
    // A replacement process may have gained the capability after a CLI update.
    session.lastSessionInfoAt = 0;
    session.lastSessionInfoUsed = undefined;
    session.sessionInfoStale = false;
    session.sessionInfoUnsupported = false;

    // fs handlers. Still wired on every session: 0.2.x, unverified, and Codex
    // advertise readTextFile and will call them. A live-verified grok >= 1.0.4
    // currently will not (withheld read → no client fs at all) but a later CLI
    // may honour writeTextFile independently.
    client.fsRead = async (p: string) => {
      try {
        // Agent paths are genuine workspace disk paths on the extension host.
        const bytes = await this.host.fs.readFile(Uri.file(p));
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return fs.readFileSync(p, "utf8");
      }
    };
    client.fsWrite = async (p: string, content: string) => {
      try {
        await this.host.fs.createDirectory(Uri.file(path.dirname(p)));
        await this.host.fs.writeFile(Uri.file(p), Buffer.from(content, "utf8"));
      } catch {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    // Owned by this client, so tearing it down takes its commands with it.
    client.terminal = this.terminalManager.ownedBy(client);

    client.on("initialized", (init) => {
      if (gen !== session.gen) return;
      this.warnOAuthShadowOnce(init?._meta?.defaultAuthMethodId, env);
      const handshakeVersion = init?.serverInfo?.version ?? init?.version ?? null;
      if (session.provider === "grok" && typeof handshakeVersion === "string" && handshakeVersion.trim()) {
        this.providerCliVersions.grok = handshakeVersion.trim().replace(/^v/i, "");
        this.postProviderState();
      }
      this.emit(session, {
        type: "initialized",
        info: {
          cliPath,
          cwd,
          version: handshakeVersion,
          provider: session.provider,
          init: { protocolVersion: init?.protocolVersion },
        },
      });
    });
    client.on("session", (res) => {
      if (gen !== session.gen) return;
      if (res?.sessionId) session.activeSessionId = res.sessionId;
      this.cacheProviderModels(session.provider, client.availableModels, client.currentModelId);
      if (res?.sessionId) {
        void this.updateSessionMeta((current) => ({
          ...current,
          [res.sessionId]: {
            ...(current[res.sessionId] ?? {}),
            provider: session.provider,
            providerCwd: cwd,
          },
        }));
      }
      this.emit(session, {
        type: "session",
        sessionId: res.sessionId,
        models: this.modelsForSession(session, client.availableModels, client.currentModelId, !resumeId),
        currentModelId: client.currentModelId,
        worktree: !!session.worktree,
        provider: session.provider,
      });
      if (session.provider === "grok") {
        const metaEnabled = parseFeedbackEnabledMeta(res);
        if (metaEnabled !== undefined) session.feedbackMetaEnabled = metaEnabled;
        this.refreshFeedbackAvailability(session);
      }
    });
    client.on("sessionTitle", (title: string) => {
      if (gen !== session.gen || !title.trim()) return;
      const sid = client.sessionId ?? session.activeSessionId;
      if (!sid) return;
      void this.updateSessionMeta((current) => {
        const entry = current[sid];
        const autoName = capAutoName(title);
        if (!autoName || entry?.customName || entry?.autoName === autoName) return null;
        return { ...current, [sid]: { ...(entry ?? {}), autoName } };
      }).then(() => {
        this.sessionCache.delete(sid);
        this.postSessionName(session);
        this.postSessionsList();
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
      } else if (!client.usesClientPlanGate) {
        // Claude ExitPlanMode / Codex plan approval switch to a writable mode
        // and then edit. Follow that mode so the button and permission filter
        // stop saying Plan. Grok's descriptive update must not do this.
        const next = applyAgentModeToHostPlan(id, false);
        if (next) {
          session.autoApprove = next.autoApprove;
          this.setPlanActive(session, next.planActive);
        }
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
      if (session.provider === "grok") {
        session.feedbackCommandsAdvertise = commandsAdvertiseFeedback(cmds);
        this.refreshFeedbackAvailability(session);
      }
    });
    client.on("messageChunk", (text: string) => {
      if (gen !== session.gen) return;
      if (session.captureAgentText !== undefined) {
        session.captureAgentText += text;
        return;
      }
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type: "messageChunk", text });
      this.noteAdapterCompactSignal(session, text);
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
      // No counter to re-seed: numbering restarts at #1 on every message, so a
      // restored conversation's tags say nothing about what the next one gets.
      // (Old transcripts written under the session-scoped scheme still render
      // correctly — the previews below are matched to the tags found in the
      // very same text, whatever numbers that text happens to carry.)
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
    const mcpState = createMcpPrepareState();
    client.on("childStream", (ev: { childSessionId: string; route: UpdateRoute }) => {
      if (gen !== session.gen) return;
      const payload = childStreamFromRoute(ev.childSessionId, ev.route);
      if (!payload) return;
      if (payload.event === "toolCall" || payload.event === "toolCallUpdate") {
        const prepared = prepareMcpToolCall(payload.call, mcpState);
        this.emit(session, { type: "childStream", ...payload, call: prepared.call });
        return;
      }
      this.emit(session, { type: "childStream", ...payload });
    });
    client.on("mediaContent", (m: MediaRef) => {
      if (gen !== session.gen) return;
      void this.postGeneratedMedia(m, session, gen);
    });
    client.on("taskBackgrounded", (u: any) => {
      if (gen !== session.gen) return;
      const cmd = typeof u?.command === "string" ? u.command : "";
      this.host.appendLine(`[task] backgrounded: ${cmd.slice(0, 200)}`);
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
      this.host.appendLine(`[task] ${text}`);
      void this.host.showInformationMessage(text, "Show Logs").then((choice) => {
        if (choice === "Show Logs") this.host.showOutput();
      });
    });
    const replayedCommandOutputs = new Set<string>();
    const replayedCommandsByToolCallId = new Map<string, string>();
    const emitReplayedCommandOutput = (call: unknown) => {
      const replayed = commandOutputForToolCall(call, {
        replaying: session.replaying,
        rememberedCommands: replayedCommandsByToolCallId,
      });
      if (!replayed) return;
      const id = typeof (call as { toolCallId?: unknown })?.toolCallId === "string"
        && (call as { toolCallId: string }).toolCallId
        ? (call as { toolCallId: string }).toolCallId
        : replayed.command;
      if (replayedCommandOutputs.has(id)) return;
      replayedCommandOutputs.add(id);
      this.emit(session, { type: "commandOutput", ...replayed });
    };
    const emitToolCallEvent = (type: "toolCall" | "toolCallUpdate", u: unknown) => {
      const prepared = prepareMcpToolCall(u, mcpState);
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.emit(session, { type, call: prepared.call });
      this.noteAdapterCompactSignal(session, prepared.call);
      if (prepared.commandOutput) {
        this.emit(session, { type: "commandOutput", ...prepared.commandOutput });
      }
      emitReplayedCommandOutput(prepared.call);
    };
    client.on("toolCall", (u) => {
      if (gen !== session.gen) return;
      emitToolCallEvent("toolCall", u);
    });
    client.on("toolCallUpdate", (u) => {
      if (gen !== session.gen) return;
      emitToolCallEvent("toolCallUpdate", u);
    });
    client.on("plan", (u) => {
      if (gen !== session.gen) return;
      // Fallback stash. Current CLIs send exit_plan_mode with planContent
      // populated; postExitPlanRequest prefers req.plan over lastPlanText.
      session.lastPlanText =
        (typeof u?.plan === "string" ? u.plan : "") ||
        (typeof u?.planText === "string" ? u.planText : "") ||
        (typeof u?.content === "string" ? u.content : "") ||
        (typeof u?.content?.text === "string" ? u.content.text : "");
      this.host.appendLine(`[plan] event payload keys: ${Object.keys(u ?? {}).join(", ")}`);
    });
    client.on("promptComplete", (meta) => {
      if (gen !== session.gen) return;
      const gated = gateZeroTokenMeta(meta);
      if (isAdapterProvider(session.provider) && !session.replaying) {
        // Stale partitions on a zero-inference compact turn are the previous
        // turn replayed — observing them would undo the compact reset.
        // Claude's result usage is a SUM; occupancy is the largest call.
        const occupancy = this.adapterTurnOccupancy(session, meta);
        const remembered = this.rememberAdapterContext(session, occupancy !== undefined ? { occupancy } : {});
        this.emit(session, {
          type: "promptComplete",
          meta: { ...gated, totalTokens: remembered?.used ?? gated.totalTokens },
        });
      } else {
        if (
          typeof gated.totalTokens === "number"
          && session.lastSessionInfoUsed != null
          && gated.totalTokens !== session.lastSessionInfoUsed
        ) {
          session.sessionInfoStale = true;
        }
        this.emit(session, { type: "promptComplete", meta: gated });
      }
      // The hidden legacy `/session-info` fallback is a CLI-local meter, not a
      // user turn. Do not add its zero-inference response to the billing ledger.
      if (session.captureAgentText === undefined) void this.accumulateUsage(session, meta);
      session.adapterTurnCallUsed = [];
      // A zero report (stripped above) is /compact or /session-info; neither
      // warrants a donut update here. /session-info leaves the context
      // untouched, and after /compact the fresh count comes from the live
      // auto_compact_completed notification (primary; xaiNotification listener)
      // or the live session/update envelope — reading signals.json now would
      // fetch the stale pre-compact count (the CLI recomputes it only at the
      // next inference turn's end; research/signals-refresh-probe.cjs).
    });
    client.on("contextUsage", (used: number | undefined, window?: number) => {
      if (gen !== session.gen) return;
      if (isAdapterProvider(session.provider)) {
        // Window only. Occupancy is remembered from prompt size / compact,
        // never from billed usage_update.used.
        this.rememberAdapterContext(session, {
          ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {}),
        });
        return;
      }
      if (
        typeof used === "number" && Number.isFinite(used) && used > 0
        && session.lastSessionInfoUsed != null
        && used !== session.lastSessionInfoUsed
      ) {
        session.sessionInfoStale = true;
      }
      this.emit(session, {
        type: "contextUsage",
        ...(typeof used === "number" && Number.isFinite(used) && used > 0 ? { used } : {}),
        ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {}),
      });
    });
    client.on("adapterUsageUpdate", (used: number, window?: number) => {
      if (gen !== session.gen) return;
      if (!isAdapterProvider(session.provider) || session.replaying) {
        if (typeof window === "number" && Number.isFinite(window) && window > 0) {
          this.rememberAdapterContext(session, { window });
        }
        return;
      }
      if (session.compactUsageArmed) {
        session.compactUsageArmed = false;
        this.rememberAdapterContext(session, {
          occupancy: used,
          compacted: true,
          ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {}),
        });
        return;
      }
      if (typeof used === "number" && Number.isFinite(used) && used > 0) {
        session.adapterTurnCallUsed.push(used);
      }
      if (typeof window === "number" && Number.isFinite(window) && window > 0) {
        this.rememberAdapterContext(session, { window });
      }
    });
    client.on("mcpNotification", (method: string, params: unknown) => {
      if (gen !== session.gen) return;
      this.applyMcpNotification(session, method, params);
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
        session.sawCompactNotification = true;
      }
      // Compaction FAILED (either path — compaction.rs emits it on both). The
      // context is unchanged, so the donut needs no refresh; flag it so a manual
      // /compact paints the failure instead of a false "Compacted.", and surface
      // a note.
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
      // buffer, so the cut is honest either way. Shared with session/load restore.
      // Null exit here is a real kill; `cancelled` is always stated so a later
      // historyReplay rebuild still paints [Cancelled], and so absence can only
      // mean an older host.
      this.emit(session, { type: "commandOutput", ...commandOutputFromLiveTerminal(info) });
    });
    client.on("permissionRequest", (req: PermissionRequest) => {
      if (gen !== session.gen) return;
      this.handlePermissionRequest(session, client, req, cwd);
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
      session.pendingQuestions.add(req.id);
      this.emit(session, { type: "questionRequest", req });
      this.setStatus(session, "needs-you");
    });
    client.on("exit", (code) => {
      if (gen !== session.gen) return; // suppress exit events from disposed/replaced clients
      // Startup window: teardown owns the user-facing outcome — no banner
      // (this is the empty-session spawn window the bounded retry exists
      // for), and no detachClient, whose gen bump would abort that retry.
      // But a death here is not always followed by a catch: the best-effort
      // setMode during resume swallows its error, so a client that died
      // there used to finish startup marked live and route every send into
      // a dead pipe (review find, 2026-08-15). Drop the attachment only;
      // the next send respawns. The equality check keeps a late exit from a
      // replaced attempt's client away from the current attempt's pipe.
      if (session.priming) {
        if (session.client === client) {
          session.client = undefined;
          this.pool.delete(session);
        }
        return;
      }
      this.emit(session, { type: "exit", code });
      if (session.queuedSends.length) {
        session.queuedSendDispatch = undefined;
        session.queuedSendCommit = undefined;
        session.queuedSends = [];
        session.queuedSendRequiresRelay = false;
        this.emitQueuedSends(session);
      }
      this.setStatus(session, "error");
      this.pool.delete(session); // the process is gone; it's no longer a live pool member
      // Drop the dead client too (and bump gen so its other in-flight handlers
      // bail): `handleSend`/`ensureClient` prefer `session.client`, so leaving
      // it set routed every post-crash send into a dead pipe instead of
      // respawning.
      // Ends the turn too: a process that dies mid-turn may never settle its
      // `prompt()`, and the send path tests for a turn in flight BEFORE it
      // respawns — so the next send would be diverted into a queue this handler
      // has just emptied. The turn died with the process.
      this.detachClient(session);
      void client.dispose();
    });
    client.on("stderr", (text: string) => this.host.append(text));
    return client;
    };

    for (let attempt = 1; attempt <= startSpawnAttempts; attempt++) {
      if (gen !== session.gen) return undefined;
      const client = createBoundClient();
      // Version probe done to the first spawn attempt: resolving the
      // environment (which on Windows can shell out to locate a shell) AND
      // building the ACP client with its handlers. Recorded after
      // `createBoundClient`, not before the loop, because recording it first
      // charged the client construction to `other` while the phase named after
      // it reported 0-1ms — a confident wrong number, which is the one thing
      // this line must never print. First attempt only: a retry repeats
      // `spawn+init`, and that is the phase allowed to repeat.
      if (attempt === 1) clock.record("client", clock.elapsed(afterVersionAt));
      // Once the resume branch starts emitting (queued plan/permission cards,
      // then streamed history), a retry would replay onto the partial
      // transcript and duplicate every message (review find, 2026-08-15) —
      // so a failure past this flag surfaces immediately, like before the
      // retry existed. The fresh-session path stays retryable end to end.
      let replayBegan = false;
    try {
      const spawnAt = clock.now();
      await client.start();
      clock.record("spawn+init", clock.elapsed(spawnAt));
      if (gen !== session.gen) { client.dispose(); return undefined; }
      const defaultModel = this.providerDefaultForProject(cwd, session.provider) ?? "";
      if (resumeId) {
        replayBegan = true;
        // Queue any saved plans BEFORE replay starts so the webview can interleave
        // them inline with user messages as they replay (instead of dumping all
        // cards at the bottom).
        const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
        } else if (client.usesClientPlanGate && planSource === "disk") {
            // Legacy Grok session (no per-plan persistence): fall back to the
            // on-disk latest plan, which we'll render at the bottom after replay.
            const sessDir = sessionDirFor(resolveGrokHome(process.env), cwd, resumeId, { fs: defaultFs });
            const planPath = sessDir ? path.join(sessDir, "plan.md") : "";
            if (planPath && fs.existsSync(planPath)) {
              try {
                const planText = fs.readFileSync(planPath, "utf8");
                let snapshot: { path: string; name: string } | undefined;
                try {
                  snapshot = await this.createPlanReviewSnapshot(planText, resumeId);
                } catch (e) {
                  this.host.appendLine(`[plan-review] ${(e as Error).message}`);
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
                this.host.appendLine(`[plan-restore] ${(e as Error).message}`);
              }
            }
        }

        const loadAt = clock.now();
        let replayAt = 0;
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
            this.host.appendLine(
              `[resume] kept the session's own model; default '${defaultModel}' needs a different agent`,
            );
          }
          // Events stream during session/load; replay(post) is the host wrap-up
          // after the RPC settles (no webview-complete signal exists). `new` is
          // zero on this branch and printed anyway — a resume creates nothing,
          // and a missing name is not a 0ms name in a line meant to be grepped.
          clock.record("new", 0);
          clock.record("load", clock.elapsed(loadAt));
          replayAt = clock.now();
        });
        clock.record("replay(post)", clock.elapsed(replayAt));
        session.activeSessionId = resumeId;
        session.titleGenerated = true; // existing session, name already in storage
        session.hasHistory = true;

        // Plan-gate restoration: the CLI replays its own current_mode_update
        // events during loadSession, which our modeChanged handler honors by
        // raising the gate. Override that here with the actual verdict-driven
        // decision (see plan-restore.ts) so a Cancelled or Approved session
        // doesn't come back stuck in Plan mode.
        if (client.usesClientPlanGate) {
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
        }

        // Seed the context donut from grok's persisted signals.json or the
        // remembered adapter occupancy — no turn has run yet, so without this
        // a restored session shows 0 until the first prompt completes. Emitted
        // after loadSession so it lands after the donut-resetting `session`
        // event in the replay buffer.
        this.emitContextUsage(session);
        if (session.provider === "grok") void this.refreshContextFromSessionInfo(session, gen, { force: true });
        // Same reason, for the billing breakdown (#53) — but from OUR store, as
        // grok persists no per-turn usage anywhere.
        this.restoreUsage(session);
      } else {
        // MEASURED, not assumed cheap. `session/new` also awaits the MCP server
        // list, `setModel`, and for adapters `setReasoningEffort` — and in one
        // reporter's log every `events: 0` open (i.e. every create) spent
        // 2.2-4.8s here with no phase naming it. It reached `other` once this
        // line started accounting for its own total; `new` says which call.
        const newAt = clock.now();
        await client.newSession(defaultModel || undefined);
        clock.record("new", clock.elapsed(newAt));
        clock.record("load", 0);
        clock.record("replay(post)", 0);
        session.activeSessionId = client.sessionId;
      }
      if (gen !== session.gen) { client.dispose(); session.client = undefined; return undefined; }
      this.host.appendLine(clock.summary(session.historyEventCount));
      this.postSessionName(session);

      if (session.provider === "grok" && defaultModel && client.currentModelId && client.currentModelId !== defaultModel) {
        const hasModel = client.availableModels.some((m) => m.modelId === defaultModel);
        if (!hasModel) {
          // The configured default isn't available — grok already fell back to an
          // available model. Heal the (non-empty) setting silently to that model
          // so it stops being stale, and just log it; no popup nag. An EMPTY
          // default means "CLI default" and never reaches here (the `defaultModel &&`
          // guard above), so a fresh install's empty default is left untouched.
          this.host.appendLine(
            `[startup] Default model '${defaultModel}' is not available; switching grok.defaultModel to '${client.currentModelId}'.`,
          );
          const cfg = this.host.getConfiguration("grok");
          const scope = cfg.inspect<string>("defaultModel");
          const target =
            scope?.workspaceFolderValue !== undefined
              ? "workspaceFolder"
              : scope?.workspaceValue !== undefined
                ? "workspace"
                : "global";
          void cfg.update("defaultModel", client.currentModelId, target);
        }
      }

      // A spontaneous death during startup detaches the pipe (see the exit
      // handler) without failing any awaited step — the best-effort setMode
      // swallows its error. Returning here would hand callers a silent
      // undefined, which recoverAuthAndResend and the send paths read as
      // "failure already surfaced" (review find, 2026-08-15: a swallowed
      // death consumed an auth-recovery resend with no error anywhere).
      // Throw into the classifier instead: the retry budget owns transient
      // startup deaths, and the final failure surfaces like any other.
      if (session.client !== client) throw new Error("the provider exited during startup");
      // Session is live — unlock the composer and flush anything typed during
      // the startup window (#37).
      session.priming = false;
      session.needsProvider = false;
      this.pool.add(session);
      this.touch(session);
      this.reapPool(); // enforce the LRU cap now that the pool grew
      this.setProviderNeedsLogin(session.provider, false);
      this.emit(session, { type: "setBusy", value: false });
      // A draft this conversation lost to a provider sign-out comes back with
      // it, before the queue flushes — the composer is where it was typed.
      this.restorePersistedDraft(session);
      if (gen === session.gen) void this.maybeFlushQueuedSends(session);
      // A spontaneous death during startup detaches the pipe (see the exit
      // handler) without failing any awaited step. Returning the dead client
      // would hand the caller a dead pipe; report "no client" and let the
      // next send respawn.
      if (session.client !== client) { this.pool.delete(session); return undefined; }
      return client;
    } catch (err) {
      if (gen !== session.gen) { client.dispose(); return undefined; }
      const msg = (err as any).message ?? String(err);
      // Decide the branch first: only the plain-failure path retries. Auth
      // must surface immediately; the Windows stdio pin has its own recovery.
      const credentialFailure =
        (client.provider !== "grok" && client.isCredentialError(err)) ||
        /auth|unauthor|401|api[_\s-]?key|credential|sign.?in/i.test(msg);
      const stdioRegression =
        session.provider === "grok" &&
        process.platform === "win32" &&
        /timed out: (initialize|session\/(new|load))|exited \(code null\)/i.test(msg);
      const userFacing = credentialFailure || stdioRegression || replayBegan || attempt >= startSpawnAttempts;
      client.removeAllListeners("exit");
      client.dispose();
      session.client = undefined;
      if (!userFacing) {
        await new Promise<void>((resolve) => setTimeout(resolve, startSpawnBackoffMs[attempt - 1]));
        if (gen !== session.gen) return undefined;
        continue;
      }
      this.pool.delete(session);
      session.priming = false;
      this.emit(session, { type: "setBusy", value: false });
      // No `403`/`forbidden` here: the CLI deliberately does NOT map 403 to an
      // auth failure (entitlement/policy, which sign-in can't fix — #58); a
      // startup error carrying that wording surfaces as a plain error below.
      if (credentialFailure) {
        // The onboarding overlay only reaches whoever is looking at THIS
        // session. The account-level flag is what tells the gear and the model
        // picker, on every view, that signing in is the action — strictly
        // classified so an entitlement failure (which a sign-in cannot fix)
        // does not label the account signed-out.
        if (client.isCredentialError(err) || isCredentialError(err)) {
          this.setProviderNeedsLogin(session.provider, true);
        }
        this.emit(session, { type: "onboarding", state: this.onboardingForSession(session) });
      } else if (stdioRegression) {
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
        if (gen !== session.gen) return undefined;
        if (!this.reactiveDowngradeInFlight && shouldReactivelyDowngrade(version, process.platform)) {
          this.reactiveDowngradeInFlight = true;
          try {
            const detected = parseGrokVersion(version)?.join(".") ?? version;
            if (await this.downgradeBrokenCli(cliPath, detected, "reactive")) {
              if (gen !== session.gen) return undefined;
              // Same clock: a downgrade re-entry that started a fresh one
              // reported only the successful second attempt and silently
              // dropped the timeout, the version read and the downgrade —
              // which is the slowest part of the open it was meant to explain.
              // `startSessionBody` clears the phases on entry, so the second
              // pass writes one set of names, not two.
              return await this.startSessionBody(resumeId, session, intent, clock); // same exclusive; do not re-enter the tail
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
      } else if (isResumeNotFound(err)) {
        // The person asked for a conversation and got the adapter's own words
        // plus a uuid: “Failed to start Claude: Resource not found:
        // 85730a78-9918-43d7-a6c6-91a058348d89”. That identifier is ours, not
        // theirs, and “resource” is not a word for a conversation.
        //
        // Says only what is known. -32002 covers a thread that never recorded
        // anything AND a query that died mid-resume, so it names both
        // possibilities and offers the action that settles it, rather than
        // picking one and being wrong half the time.
        this.emit(session, {
          type: "error",
          text:
            `This conversation could not be opened. It may never have recorded `
            + `anything, or ${providerDisplayName(session.provider)} may not have `
            + `finished starting — try opening it again, and start a new `
            + `conversation if it stays this way.`,
        });
      } else {
        this.emit(session, { type: "error", text: `Failed to start ${providerDisplayName(session.provider)}: ${msg}` });
      }
      return undefined;
    }
    }
    return undefined;
  }

  private remoteSessionFor(clientId: string): Session {
    const cwd = this.remoteClients.cwd(clientId);
    const active = this.remoteClients.active(clientId);
    if (active) return active;
    if (this.remoteClients.requiresExplicitSession(clientId)) {
      throw new Error(`Remote client ${clientId} has no session`);
    }
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
      this.sessionCwdsForRepo(cwd, this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})),
      this.remoteClients.isActiveValueVisible(deskSession),
      pathsEqual,
    );
    if (canAdoptDesk) {
      this.remoteClients.setActive(clientId, deskSession);
      return deskSession;
    }
    const session = new Session();
    session.cwd = cwd;
    session.provider = this.defaultProviderForProject(cwd);
    this.remoteClients.setActive(clientId, session);
    return session;
  }

  private async onMessage(msg: WebviewMsg, origin: MsgOrigin, clientId?: string): Promise<void> {
    const remoteBound = origin === "remote" && clientId
      ? this.remoteClients.active(clientId)
      : undefined;
    if (
      origin === "remote" &&
      clientId &&
      remoteRequiresBoundSession(msg.type) &&
      !remoteBound
    ) {
      this.refuseUnboundRemoteSession(clientId);
      return;
    }
    const session = remoteBound ?? this.focused;
    const requester = origin === "remote" && clientId
      ? this.captureRemoteRequester(clientId)
      : undefined;
    const attachmentOwner: AttachmentOwner = () => this.attachmentOwner(origin, clientId);
    const messageCwd = origin === "remote" && clientId
      ? this.remoteClients.cwd(clientId)
      : this.workspaceRoot();
    switch (msg.type) {
      case "ready": {
        // Decide BEFORE postInitialState runs: its cold-start branch calls
        // startSession(), which can create this.focused.client before this
        // handler resumes (synchronously for Codex; Grok assigns behind
        // consent/version awaits — the pre-evaluation is right either way).
        // Re-evaluating afterwards read that self-inflicted "live client" as
        // "a reload rehydrate will post the catalog" and skips it, so a cold
        // desktop boot that auto-restores a session never grew a rail (the
        // race the owner hit as "no left menu"; reload cured it because a
        // real rehydrate runs then). VS Code is immune — its flag is false.
        const rehydrating = shouldRehydrateOnWebviewReady(
          this.host.webviewReloadsUnderLiveSession,
          !!this.focused.client,
        );
        this.postInitialState();
        // Rehydrate already posts catalog + sessions. Cold start needs an early
        // disk list so the rail is not empty while startSession runs — but the
        // catalog scan is deferred so ready returns and the UI paints first
        // (large histories must not block activation).
        if (!rehydrating) {
          if (!this.firstBootScanStarted && !this.firstBootScanCompleted) {
            void this.runFirstBootScan({ deferSessions: true });
          } else {
            this.postRepoCatalog();
            setImmediate(() => this.postSessionsList());
          }
        } else {
          this.completeFirstBootScan();
        }
        break;
      }
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
          await this.host.setContext("grok.composerFocus", !!msg.focused);
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
          (line) => this.host.appendLine(line),
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
        // Revalidate against the current open set — a handle minted while a
        // folder was open must not survive closing that folder.
        if (!this.isImagePathAuthorizedNow(source)) {
          this.host.appendLine(`[remote] refused imageFull (path no longer authorized)`);
          break;
        }
        const src = await this.renderFullImage(source);
        this.sendRemoteRequester(requester, { type: "imageFull", fullId: msg.fullId, src });
        break;
      }
      case "send":
        let queuedSendCommit: { text: string; items: QueuedSendEntry[] } | undefined;
        if (origin === "remote" && msg.queuedSendId) {
          if (session.completedQueuedSendIds.includes(msg.queuedSendId)) {
            this.host.appendLine(`[queue] ignored duplicate remote dequeue ${msg.queuedSendId}`);
            break;
          }
          const dispatch = session.queuedSendDispatch;
          if (
            !dispatch ||
            dispatch.id !== msg.queuedSendId ||
            dispatch.text.trim() !== msg.text.trim()
          ) {
            this.host.appendLine(`[queue] ignored stale or mismatched remote dequeue ${msg.queuedSendId}`);
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
          this.host.appendLine("[queue] ignored an unidentifiable legacy dequeue echo");
          break;
        }
        try {
          await this.handleSend(msg.text, msg.bare === true, session, origin, queuedSendCommit, msg.submissionId);
        } finally {
          if (queuedSendCommit) finishQueuedSendCommit(session, queuedSendCommit, false);
        }
        break;
      case "newSession":
        // A remote's cwd is deliberately not forwarded: newRemoteSession starts
        // in that tab's own repo, which is the only project it is entitled to.
        if (origin === "remote" && clientId) await this.newRemoteSession(clientId);
        else await this.newFocusedSession(origin, msg.cwd);
        break;
      case "cancel": {
        const cancelled = session.turnToken;
        await session.client?.cancel("user Stop click");
        if (cancelled) this.armCancelRecovery(session, cancelled);
        break;
      }
      case "queueSend": {
        // Host-owned per-session queue (#37): each contribution keeps the chips
        // snapshotted here (image numbers already stamped at attach), then the
        // flush sends them as one combined prompt with per-item tags. The
        // webview renders a mirror from queuedSends snapshots, so queued
        // messages survive focus switches and flush even while backgrounded.
        const s = session;
        const text = typeof msg.text === "string" ? msg.text : "";
        const chips = chipsForQueueSend(s.chips, msg.chips);
        if (text.trim() || chips.length) {
          s.queuedSendDispatch = undefined;
          // STICKY, never overwritten back to false: with desk↔remote
          // co-attach both views append to ONE queue, and the combined flush
          // is a single submission — if ANY contribution is remote it must
          // round-trip the relay so it gets metered (a local overwrite here
          // would flush remote text through the unmetered local branch).
          if (origin === "remote") s.queuedSendRequiresRelay = true;
          s.queuedSends = enqueueQueuedSend(s.queuedSends, text, chips);
          s.chips = consumeChips(s.chips, chips);
          if (s === this.focused) this.refreshImplicitChip(true);
          else this.postChips(s);
          this.emitQueuedSends(s);
          // If the turn ended while this message was in flight, fire it now.
          void this.maybeFlushQueuedSends(s);
        }
        break;
      }
      case "dequeueSend": {
        // Old webviews render one pending block and send `index: 0` for Edit /
        // Remove / Steer. Chip-aware clients use `clearQueuedSends` for that
        // block, so this message keeps the pre-split meaning: the pending
        // block, not the first of several entries. Passing `false` is the
        // capability gate — we cannot see whether a remote honored
        // `queueSendChips`, and every client that still sends `dequeueSend`
        // is the old one.
        const s = session;
        const result = dequeueQueuedSends(s.queuedSends, msg.index, false);
        if (result) {
          s.queuedSendDispatch = undefined;
          s.queuedSendCommit = undefined;
          if (result.removed.some((item) => item.chips.length)) {
            s.chips = restoreQueuedChips(s.chips, result.removed);
          }
          s.queuedSends = result.rest;
          if (!s.queuedSends.length) s.queuedSendRequiresRelay = false;
          if (s === this.focused) this.refreshImplicitChip(true);
          else this.postChips(s);
          this.emitQueuedSends(s);
        }
        break;
      }
      case "steerSend":
        await this.steerSend(msg.text, session, requester, msg.chips, msg.fromQueue === true);
        break;
      case "turnFeedback":
        await this.handleTurnFeedback(msg.rating, session, requester);
        break;
      case "forkSession":
        if (this.refuseMismatchedSessionId(msg.sessionId, session, requester)) break;
        await this.forkFocusedSession(session, requester);
        break;
      case "newWorktreeSession":
        await this.newWorktreeSession({ fromRemote: origin === "remote" });
        break;
      case "setAppPurpose": {
        const purpose = parseAppPurpose(msg.value);
        await this.state.update(APP_PURPOSE_KEY, purpose);
        // Mirror to every open view (local + remote) so disclosure stays in sync.
        this.post({ type: "appPurpose", value: purpose });
        break;
      }
      case "applyWorktree":
        // The webview's custom confirm already ran (native modals stay only on
        // the Command-Palette path).
        if (this.refuseMismatchedSessionId(msg.sessionId, session, requester)) break;
        await this.applyFocusedWorktree(session, true);
        break;
      case "removeWorktree":
        if (this.refuseMismatchedSessionId(msg.sessionId, session, requester)) break;
        await this.removeFocusedWorktree(session, true);
        break;
      case "remoteSignIn":
        await this.linkRemoteDevice();
        break;
      case "remoteSignOut":
      case "unlinkRemoteDevice": {
        // Desktop confirms natively for both messages. VS Code's palette still
        // calls unlinkRemoteDevice() directly; a leftover remoteSignOut there
        // stays immediate.
        if (msg.type === "unlinkRemoteDevice" || this.host.canSwitchWorkspaceFolder) {
          const name = deviceDisplayName(os.hostname(), process.platform, os.release());
          const ok = await this.confirmHostExecute(
            "Unlink this device?",
            `${name} will be unlinked from AFK Pilot. Other devices will lose access to this machine.`,
            "Unlink",
          );
          if (!ok) break;
        }
        await this.unlinkRemoteDevice();
        break;
      }
      case "openRemotePortal":
        void this.host.openExternal(httpBaseFromRelayUrl(this.relayUrl()) + (msg.withHint ? "/?remoteHint=1" : ""));
        break;
      case "rewindSession":
        await this.rewindFocusedSession(
          typeof msg.userBubbleIndex === "number" ? msg.userBubbleIndex : undefined,
          msg.text,
          // Was dropped here while editLastMessage forwarded it, so the
          // bubble<->restore-point consistency check never ran for the Rewind
          // button — the one path that reverts files without the user naming a
          // target from a list. It matters more now that a remote can ask.
          msg.totalUserBubbles,
          session,
          requester,
        );
        break;
      case "uiConfirmAnswer": {
        const pending = this.pendingConfirms.get(msg.id);
        // Only from the conversation the confirm was ASKED in. `emit` showed it
        // to every surface holding that session, so any of them may answer —
        // what a mismatch means is an answer for somebody else's conversation,
        // and dropping it is right. Ignoring it cannot hang the caller either:
        // the real answer still resolves, and an abandoned confirm already
        // fails closed when the webview goes away.
        if (pending && pending.session === session) {
          this.pendingConfirms.delete(msg.id);
          pending.resolve(msg.ok === true);
        }
        break;
      }
      case "editLastMessage":
        await this.editLastMessage(msg.userBubbleIndex, msg.text, msg.totalUserBubbles, session, requester);
        break;
      case "workflowControl":
        await this.controlWorkflow(msg.action, msg.displayName, session);
        break;
      case "refreshContextDetails":
        if (session.provider === "grok") {
          void this.refreshContextFromSessionInfo(session, session.gen, {
            force: session.sessionInfoStale,
          });
        }
        break;
      case "clearQueuedSends": {
        // Posted by the webview's Stop/Edit/Remove flows. Stop and Edit set
        // `restore: true` so queued chips return to the composer; Remove omits
        // it and discards them. A halt must not auto-fire queued sends into
        // the cancelled turn's wake — this runs BEFORE cancel on that path.
        const s = session;
        if (s.queuedSends.length) {
          s.queuedSendDispatch = undefined;
          s.queuedSendCommit = undefined;
          const items = s.queuedSends;
          s.queuedSends = [];
          s.queuedSendRequiresRelay = false;
          if (msg.restore) {
            s.chips = restoreQueuedChips(s.chips, items);
          }
          if (s === this.focused) this.refreshImplicitChip(true);
          else this.postChips(s);
          this.emitQueuedSends(s);
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
          void this.state.update(IMPLICIT_CHIP_HIDDEN_KEY, toggled.hidden);
        }
        this.postChips(session);
        // Hiding an unreadable chip removes it from the next prompt just as
        // deleting it does, so it can unblock a retained idle queue too.
        void this.maybeFlushQueuedSends(session);
        break;
      }
      case "openFile": {
        const { ref, path: p } = this.resolveChatOpenPath(session, msg.path);
        if (ref.startLine != null) {
          const startLine = Math.max(0, ref.startLine - 1);
          const endLine = ref.endLine != null ? Math.max(startLine, ref.endLine - 1) : startLine;
          try {
            await this.host.openTextFile(p, {
              selection: {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: Number.MAX_SAFE_INTEGER },
              },
            });
          } catch {
            void this.host.openResource(p);
          }
        } else {
          void this.host.openResource(p);
        }
        break;
      }
      case "showInFolder": {
        if (!this.host.canShowInFolder) break;
        const { path: p } = this.resolveChatOpenPath(session, msg.path);
        await this.host.showInFolder(p);
        break;
      }
      case "openUrl":
      case "openUpdateRelease":
        void this.host.openExternal(msg.url);
        break;
      case "restartToUpdate":
        this.host.installAppUpdate?.();
        break;
      case "openText": {
        // Basename only — a renderer-supplied path must not choose the directory.
        const name = typeof msg.filename === "string" ? path.basename(msg.filename.trim()) : "";
        const suggested = name ? path.join(this.sessionCwd(session), name) : undefined;
        await this.host.openUntitledText(msg.content, msg.language, suggested);
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
        // Desktop rewrites a host-minted handle to path before this runs; VS Code
        // still posts a path from drag-drop. Missing path is a no-op (forged
        // handle already refused at the Electron gate).
        if (typeof msg.path === "string" && msg.path.length > 0) {
          await this.trackAttach(this.addDroppedFile(msg.path, msg.shift, attachmentOwner));
        }
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
          const chosen = pending.options.find((option) => option.optionId === msg.optionId);
          if (isPlanReviewPermission(pending.toolKind) && pending.plan?.trim()) {
            this.persistPlanVerdict(
              session,
              planReviewVerdictForOption(chosen?.kind),
              pending.plan,
            );
            session.pendingPermissions.delete(msg.requestId);
          } else {
            // Persist it (title + outcome) so a cold reload replays a collapsed card —
            // the CLI doesn't replay request_permission on session/load.
            this.persistPermissionAnswer(session, msg.requestId, msg.optionId);
          }
          this.closeDiffForRequest(session, msg.requestId); // tidy up the auto-opened diff (#21)
          // Only once EVERY card is answered. Two tools can ask at the same
          // time, and answering one leaves the agent blocked on the other — so
          // saying "working" here was a lie that the auto-approval path (which
          // checks the same thing) never told. On a cloud machine the lie also
          // costs money: `working` is what holds the machine awake, so a
          // half-answered pair would hold it open indefinitely while nothing
          // ran.
          this.noteAnswered(session);
          break;
        }
      case "exitPlanAnswer":
        this.handleExitPlan(msg.requestId, msg.verdict, msg.comment, session);
        break;
      case "questionAnswer":
        // A card that is no longer outstanding is a STALE card: a second tab
        // still showing it, or one replayed from the session buffer after the
        // turn ended. Answering it again would write a duplicate JSON-RPC
        // response and drag a settled session back to `working` — with no turn
        // left to ever end it, which on a rented machine bills for ever.
        if (!session.pendingQuestions.delete(msg.requestId)) break;
        if (session.client?.respondQuestion(msg.requestId, msg.answers ?? {}, msg.annotations ?? {})) {
          // Answering a QUESTION is not answering a permission card that is
          // also outstanding — the agent stays blocked on it, so `working`
          // would be wrong and would hold a rented machine awake indefinitely.
          this.noteAnswered(session);
        }
        break;
      case "questionCancel":
        if (!session.pendingQuestions.delete(msg.requestId)) break;
        if (session.client?.respondQuestionCancelled(msg.requestId)) {
          this.noteAnswered(session);
        }
        break;
      case "setModel":
        await this.switchModel(
          msg.modelId,
          session,
          requester,
          isAcpProvider(msg.provider)
            ? msg.provider
            : this.providerForRequestedModel(msg.modelId, session.provider),
        );
        break;
      case "listRoutines":
        this.routineError = undefined;
        this.postRoutines();
        break;
      case "saveRoutine": {
        const existing = this.loadRoutines();
        const prior = msg.id ? existing.find((r) => r.id === msg.id) : undefined;
        if (msg.id && !prior) {
          this.routineError = { id: msg.id, message: "That routine is no longer there." };
          this.postRoutines();
          break;
        }
        // The cwd is checked against what this connection may reach, not
        // against the whole catalog: a remote may create routines, and reach is
        // the property that has to be bounded.
        const cwd = typeof msg.draft.cwd === "string" ? msg.draft.cwd : "";
        if (!this.mayTargetRoutineCwd(cwd, origin, clientId)) {
          this.routineError = { id: msg.id, message: "Pick a project for this routine to run in." };
          this.postRoutines();
          break;
        }
        const result = validateRoutine(msg.draft, {
          id: prior?.id ?? randomUUID(),
          // Editing preserves createdAt, so the schedule anchor does not jump
          // when someone fixes a typo in the prompt.
          createdAt: prior?.createdAt ?? Date.now(),
          models: this.routineModelOptions(),
        });
        if (!result.ok) {
          this.routineError = { id: msg.id, message: result.error };
          this.postRoutines();
          break;
        }
        this.routineError = undefined;
        const next = prior
          ? existing.map((r) => (r.id === prior.id ? { ...result.routine, paused: r.paused } : r))
          : [...existing, result.routine];
        await this.saveRoutines(next);
        this.postRoutines();
        break;
      }
      case "deleteRoutine": {
        const existing = this.loadRoutines();
        const target = existing.find((r) => r.id === msg.id);
        if (!target || !this.mayTargetRoutineCwd(target.cwd, origin, clientId)) break;
        await this.saveRoutines(existing.filter((r) => r.id !== msg.id));
        this.routineRuns.forget(msg.id);
        this.routineError = undefined;
        this.postRoutines();
        break;
      }
      case "setRoutinePaused": {
        const existing = this.loadRoutines();
        const target = existing.find((r) => r.id === msg.id);
        if (!target || !this.mayTargetRoutineCwd(target.cwd, origin, clientId)) break;
        await this.saveRoutines(
          existing.map((r) => (r.id === msg.id ? { ...r, paused: msg.paused === true } : r)),
        );
        this.postRoutines();
        break;
      }
      case "runRoutineNow": {
        const target = this.loadRoutines().find((r) => r.id === msg.id);
        if (!target || !this.mayTargetRoutineCwd(target.cwd, origin, clientId)) break;
        if (this.routinesInFlight.has(target.id)) break;
        const now = Date.now();
        // A manual key, so an explicit run never consumes the scheduled window
        // — "Run now" at 07:59 must not cancel the 08:00 run.
        const key = manualWindowKey(now);
        this.routineRuns.claim(target.id, key, {
          routineId: target.id,
          windowKey: key,
          startedAt: now,
          outcome: "running",
        });
        await this.runRoutine(target, key, now);
        break;
      }
      case "installCodex":
        await this.installManagedCodexCli();
        break;
      case "cancelCodexInstall":
        this.codexInstallAbort?.abort(new Error("Installation cancelled."));
        break;
      case "setEffort": {
        if (session.priming) break; // ignore changes fired mid-session-start (see switchModel)
        const newLevel = msg.level;
        const cfg2 = this.host.getConfiguration("grok");

        if (!session.hasHistory || !session.client) {
          // As with a model switch on an empty session: restart without the summarize-vs-restart
          // prompt and discard the abandoned empty session — but only when it truly had no
          // history (a dead client on a session WITH history must keep that history).
          const wasEmpty = !session.hasHistory;
          const discardId = session.activeSessionId;
          await cfg2.update("defaultEffort", newLevel, "global");
          if (wasEmpty && isAdapterProvider(session.provider)) {
            await this.discardAdapterEmptySession(session.provider, discardId, this.sessionCwd(session), session.client);
          }
          await this.startSession(undefined, session);
          if (wasEmpty && session.provider === "grok") this.discardRestartedEmptySession(discardId, session);
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
            await cfg2.update("defaultEffort", newLevel, "global");
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
        await cfg2.update("defaultEffort", newLevel, "global");
        await this.restartSession(mode, session);
        break;
      }
      case "addProjectFolder":
        await this.addProjectFolder();
        break;
      case "removeProjectFolder":
        // NO LONGER always local: CLOUD_DISPOSITION admits this from a remote on
        // a cloud machine, where there is no desk to walk to. A path the renderer
        // names is still not trusted on its own — allowRemoteRepoTarget requires a
        // cwd the catalog knows, and removeWorkspaceFolder returns false for
        // anything not in the open set.
        await this.removeProjectFolder(msg.cwd, origin, clientId);
        break;
      case "createProject":
        await this.createProject(msg.name, origin, clientId);
        break;
      case "cloneProject":
        await this.cloneProject(msg.url, origin, clientId, msg.name);
        break;
      case "setupGithubCli":
        await this.setupGithubCli(
          msg.action === "install" ? "install" : "auth",
          origin,
          clientId,
          msg.surface,
        );
        break;
      case "listGithubRepos":
        await this.listGithubRepos();
        break;
      case "githubSignOut":
        await this.githubSignOut(origin);
        break;
      case "githubLoginWithToken":
        await this.githubLoginWithToken(msg.token);
        break;
      case "welcomeTipShown": {
        // Idempotent per day: `withShownTip` answers null when this tip is
        // already recorded for today, which means no write and no frame — the
        // client posts at most once per tip per day, and this is the second
        // gate so a client that forgets cannot rewrite the file all afternoon.
        const seen = withShownTip(
          this.state.get(WELCOME_TIPS_SHOWN_KEY, {}),
          msg.id,
          localDayKey(new Date()),
        );
        if (!seen) break;
        await this.state.update(WELCOME_TIPS_SHOWN_KEY, seen);
        this.postWelcomeTips();
        break;
      }
      case "dismissWelcomeTip": {
        // Id-shaped only, capped, and idempotent — `withDismissedTip` answers
        // null for anything already retired or out of bounds, and a null means
        // do not write and do not re-broadcast an identical frame. The host
        // deliberately does NOT check the id against a catalogue: the catalogue
        // lives in the client, and a newer client knowing a tip this host does
        // not is the normal case, not an error.
        const next = withDismissedTip(this.state.get(WELCOME_TIPS_KEY, {}), msg.id);
        if (!next) break;
        await this.state.update(WELCOME_TIPS_KEY, next);
        this.postWelcomeTips();
        break;
      }
      case "openGlobalConfig": {
        // Intent only — host resolves ~/.grok/config.toml (never a renderer path).
        await this.host.openGlobalConfig();
        break;
      }
      case "openProjectConfig": {
        // Intent only — host resolves project .grok/config.toml from session cwd.
        await this.host.openProjectConfig(this.sessionCwd(session));
        break;
      }
      case "listMcpServers": {
        await this.refreshMcpServers(session);
        break;
      }
      case "connectMcpConnector":
        if (origin === "remote" && !clientId) break;
        await this.connectMcpConnector(msg.id, {
          key: typeof msg.key === "string" ? msg.key : undefined,
          readOnly: typeof msg.readOnly === "boolean" ? msg.readOnly : undefined,
          remote: origin === "remote",
        });
        break;
      case "completeMcpConnectorOAuth":
        if (origin === "remote" && clientId) await this.completeMcpConnectorOAuth(msg, clientId);
        break;
      case "disconnectMcpConnector":
        await this.disconnectMcpConnector(msg.id);
        break;
      case "showLogs":
        this.host.showOutput();
        break;
      case "toggleDevTools":
        if (this.host.canToggleDevTools) this.host.toggleDevTools();
        break;
      case "openSettings":
        await this.host.openSettings(typeof msg.section === "string" ? msg.section : "grok");
        break;
      case "openSettingsSurface":
        await this.openSettingsEditor(typeof msg.category === "string" ? msg.category : undefined);
        break;
      case "closeSettingsSurface":
        this.settingsEditor?.dispose();
        this.settingsEditor = undefined;
        break;
      case "moveView": {
        // Settings -> Advanced -> Move view. Each destination targets an
        // extension-owned container, so the move is direct — no quickpick. An
        // unknown location falls back to the built-in destination picker
        // preselected on our view (the view-id argument also sidesteps the
        // focusedView context, which Cursor never sets for webview views).
        await this.retireMoveViewHint();
        await this.host.relocateView(
          GROK_VIEW_ID,
          moveViewContainerFor(msg.location),
          panelPositionFor(msg.location),
        );
        break;
      }
      case "setShowThinking":
        // Persist globally (like the other display prefs); the config watcher
        // re-posts the value, keeping every open webview in sync.
        await this.host.getConfiguration("grok")
          .update("showThinking", !!msg.value, "global");
        break;
      case "setExpandCommandOutputs":
        await this.host.getConfiguration("grok")
          .update("expandCommandOutputs", !!msg.value, "global");
        break;
      case "setSteerByDefault":
        await this.host.getConfiguration("grok")
          .update("steerByDefault", !!msg.value, "global");
        break;
      case "setSoundNotifications":
        await this.host.getConfiguration("grok")
          .update("soundNotifications", !!msg.value, "global");
        break;
      case "setProcessingSound":
        await this.host.getConfiguration("grok")
          .update("processingSound", !!msg.value, "global");
        break;
      case "setReadRepliesAloud":
        await this.host.getConfiguration("grok")
          .update("readRepliesAloud", !!msg.value, "global");
        break;
      case "setSummarizeRepliesAloud":
        await this.host.getConfiguration("grok")
          .update("summarizeRepliesAloud", !!msg.value, "global");
        break;
      case "setVoiceSendPhrase": {
        const cwd = messageCwd;
        const cfg = this.host.getConfiguration("grok", cwd);
        await cfg.update(
          "voiceSendPhrase",
          sanitizeVoiceSendPhrase(msg.value),
          voiceSettingWriteTarget(cfg.inspect("voiceSendPhrase"), this.host.isInWorkspace(cwd)),
        );
        break;
      }
      case "setVoiceKeyterms": {
        const cwd = messageCwd;
        const cfg = this.host.getConfiguration("grok", cwd);
        await cfg.update(
          "voiceKeyterms",
          sanitizeVoiceKeyterms(msg.value),
          voiceSettingWriteTarget(cfg.inspect("voiceKeyterms"), this.host.isInWorkspace(cwd)),
        );
        break;
      }
      case "setTelemetryEnabled":
        await this.host.getConfiguration("grok")
          .update("telemetry.enabled", !!msg.value, "global");
        break;
      case "setThumbsFeedback":
        await this.host.getConfiguration("grok")
          .update("thumbsFeedback", !!msg.value, "global");
        break;
      case "runInstallCmd": {
        // Host-owned confirmation, because this is one of the two messages that
        // run something. The renderer does not supply the command — it is the
        // fixed x.ai installer — so a compromised renderer cannot choose WHAT
        // runs, only trigger it. Confirming closes that anyway: the desktop
        // dispatcher authorizes on "the message came from the main frame", not
        // on a user gesture, and this is cheap where a general fix is not.
        if (!(await this.confirmHostExecute(
          "Install the Grok Build CLI?",
          "This runs the official installer from x.ai in a terminal.",
          "Install",
        ))) break;
        const term = this.host.createTerminal("Install Grok");
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
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : "grok";
        const cliPath = this.locateProvider(provider);
        if (!cliPath) {
          this.post({
            type: "onboarding",
            state: missingProviderState(provider),
            platform: process.platform,
            provider,
          });
          break;
        }
        // A remote has no terminal to look at and no keyboard attached to the
        // host, so the desk path is not merely worse there — it does nothing
        // visible at all. Run the CLI's headless flow instead and put the URL
        // and code in the transcript. Everything below this branch is the desk
        // path and is deliberately unchanged.
        if (origin === "remote") {
          await this.startDeviceLogin(provider, cliPath, clientId);
          break;
        }
        // Official CLI owns login. For Claude this is `claude auth login`
        // without --claudeai — we never implement or proxy Claude.ai OAuth.
        const loginArgs = provider === "claude" ? ["auth", "login"] : ["login"];
        const term = this.host.createTerminal({
          name: `${providerDisplayName(provider)} Login`,
          shellPath: cliPath,
          shellArgs: loginArgs,
        });
        term.show();
        // The terminal is outside the host protocol, so completion cannot be
        // observed directly. Probe immediately as well: browser/desktop login
        // helpers may already have completed, and the explicit Re-check below
        // remains available for interactive terminals still in progress.
        this.watchProviderLogin(provider);
        // Connecting an agent is about the NEXT conversation, not the one on
        // screen. Showing its sign-in panel over a session with history covered
        // that transcript, and the confirmation afterwards had nowhere sensible
        // to land — the owner connected Claude from an open Grok conversation
        // and got the panel there, then no confirmation at all. So start a fresh
        // session first and run the whole flow in it.
        // Not without a project: on desktop with nothing open, workspaceRoot()
        // is deliberately empty rather than the install directory, so there is
        // nowhere to start a session. Connecting still works — it only opens a
        // terminal — and the panel below still shows; the fresh session simply
        // waits until there is a project to put it in.
        //
        // The `origin !== "remote"` this used to carry is gone because the
        // remote branch above returns before here — TypeScript pointed out the
        // comparison could no longer be false, which is the check that the two
        // paths really are separate rather than merely intended to be.
        if (session.hasHistory && this.workspaceRoot()) {
          await this.newFocusedSession(origin);
        }
        // ALWAYS show this provider's login panel, and say the terminal was
        // launched. Two bugs lived in the gate this replaces.
        //
        // It only posted when the provider was not marked connected, so
        // connecting a lapsed Codex from Settings opened its browser flow and
        // left the chat on whatever panel was already there — no instructions,
        // and no Re-check button to finish with.
        //
        // And `launched` matters because this terminal is opened by the HOST,
        // not by a click in the webview. The done mark was only set on click, so
        // an automatically opened terminal left the button looking untouched —
        // which reads as "that did nothing, press it again".
        this.post({
          type: "onboarding",
          state: providerLoginState(provider),
          platform: process.platform,
          provider,
          launched: true,
        });
        break;
      }
      case "submitDeviceLoginCode": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : "grok";
        const running = this.deviceLogins.get(provider);
        if (!running) break;
        const code = typeof msg.code === "string" ? msg.code.trim() : "";
        if (!code) break;
        // Re-bind the tapper the same way a re-tap does: they left for the
        // vendor's page and came back under a new socket.
        if (clientId) {
          running.clientId = clientId;
          running.tabToken = this.remoteClients.tabToken(clientId) ?? running.tabToken;
        }
        running.handle.submitCode(code);
        if (running.last && running.last.status === "waiting") {
          running.send({ ...running.last, submitted: true });
        }
        break;
      }
      case "cancelDeviceLogin": {
        if (msg.provider === "github") {
          this.cancelGithubDeviceLogin();
          break;
        }
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : "grok";
        const running = this.deviceLogins.get(provider);
        if (!running) break;
        this.deviceLogins.delete(provider);
        // The hold is released by onDone, which cancel() settles synchronously
        // — the token belongs to that operation, not to this handler.
        running.handle.cancel();
        // Back to the plain sign-in panel, with no code and no failure. The
        // person cancelled; telling them it failed would be a small lie.
        const message: HostMsg = {
          type: "onboarding",
          state: providerLoginState(provider),
          platform: process.platform,
          provider,
        };
        if (clientId) this.sendRemoteClient(clientId, message);
        else this.post(message);
        break;
      }
      case "recheckConnection": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : session.provider;
        if (!this.locateProvider(provider)) {
          this.post({
            type: "onboarding",
            state: missingProviderState(provider),
            platform: process.platform,
            provider,
          });
          break;
        }
        const pendingLoginProbe = this.loginReprobeTimers.get(provider);
        if (pendingLoginProbe) clearTimeout(pendingLoginProbe);
        this.loginReprobeTimers.delete(provider);
        // Evidence, then promotion — never the other way round. Marking the
        // account connected BEFORE the probe meant a failed check left it
        // "connected but needs to sign in again" for an account that was
        // never signed in at all, which is exactly what the owner saw on a
        // fresh cloud machine (2026-08-31). The Providers refresh has always
        // promoted this way; this handler was the one that did not.
        //
        // A failure never demotes, either: a lapsed account keeps its row and
        // gets the sign-in action, which is what needsLogin is for.
        const rechecked = await this.reprobeProviderCredentials(provider);
        if (rechecked) await this.setProviderConnected(provider, true);
        await this.adoptSessionsForConnectedProvider(provider, session);
        break;
      }
      case "retryProviderSession": {
        const provider: AcpProvider = isAcpProvider(msg.provider) ? msg.provider : session.provider;
        if (!this.connectedProviders().includes(provider)) {
          if (requester) this.sendRemoteRequester(requester, {
            type: "error",
            text: `${providerDisplayName(provider)} must be connected at the desk before a remote session can be retried.`,
          });
          break;
        }
        if (session.provider === provider && !session.client) {
          await this.startSession(session.hasHistory ? session.activeSessionId : undefined, session);
        }
        break;
      }
      case "logout":
        // `fromRemote` is not a permission — the gate above already decided
        // that, and it only lets this through on a cloud environment. It says
        // there is NOBODY AT THE MACHINE to answer a modal.
        await this.logout(
          isAcpProvider(msg.provider) ? msg.provider : "grok",
          {
            fromRemote: origin === "remote",
            // `requester`, NOT clientId. Host dialogs are invisible on a cloud
            // box, so the asking client is the only surface that can be told —
            // and a clientId is ephemeral: a same-tab reconnect replaces it, and
            // sign-out can sit for 30 seconds, so one phone network blip is
            // enough to address the failure to a dead connection while the
            // credential stays on the machine. `reportRequester` is the
            // reconnect-stable path and already falls back to a host dialog at a
            // desk, which is what the first version of this reinvented badly.
            report: (text) => this.reportRequester(requester, "error", text),
          },
        );
        break;
      case "refreshProviders":
        await this.refreshProviderStates();
        break;
      case "checkGrokUpdate":
        await this.checkGrokUpdate();
        break;
      case "updateGrok":
        if (!(await this.confirmHostExecute(
          "Update the Grok Build CLI?",
          "This runs the CLI's own updater.",
          "Update",
        ))) break;
        await this.updateGrokCliOnDemand();
        break;
      case "listSessions":
        if (origin === "remote" && clientId) {
          this.sendRemoteClient(clientId, this.buildSessionsList(messageCwd, {
          offset: msg.offset, limit: msg.limit, query: msg.query, providerCursor: msg.providerCursor,
          }, this.remoteActiveSessionId(clientId)));
        } else {
        this.postSessionsList({ offset: msg.offset, limit: msg.limit, query: msg.query, providerCursor: msg.providerCursor });
        }
        break;
      case "listRepoSessions":
        // Preview rows for a repo WITHOUT selecting it (the projects rail).
        // Local: desktop multi-folder rail and the VS Code primary-side-bar rail.
        if (origin === "remote" && clientId) {
          this.sendRepoSessionsPreview(clientId, msg.cwd, msg.limit);
        } else {
          this.sendLocalRepoSessionsPreview(msg.cwd, msg.limit);
        }
        break;
      case "toggleSessionPin":
        // Rail pin. Remote always; local when any projects rail is live
        // (desktop multi-folder or VS Code primary-side-bar view).
        if (origin === "remote" || this.host.canSwitchWorkspaceFolder || this.projectsRail) {
          await this.toggleSessionPin(msg.id, msg.cwd, msg.pinned);
        }
        break;
      case "selectRepo":
        if (origin === "remote" && clientId) await this.selectRemoteRepo(clientId, msg.cwd);
        else await this.selectRepo(msg.cwd);
        break;
      case "setRepoArchived":
        await this.setRepoArchived(msg.cwd, msg.archived);
        break;
      case "setRepoColor":
        await this.setRepoColor(msg.cwd, msg.color);
        break;
      case "toggleRepoPin":
        await this.toggleRepoPin(msg.cwd, msg.pinned);
        break;
      case "resumeSession":
        if (origin === "remote" && clientId) {
          await this.openRemoteSession(clientId, msg.id, msg.cwd, true, msg.claim === true);
        }
        else await this.openSession(msg.id, msg.cwd);
        break;
       case "renameSession":
          this.renameSession(msg.id, msg.name, origin, clientId, msg.cwd);
          break;
      case "deleteSession":
        await this.deleteSession(msg.id, msg.name, origin, clientId, msg.cwd);
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
          this.host.appendLine(`[mention] index failed: ${(e as Error).message}`);
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
            this.host.appendLine(`[mention] index failed while validating remote pick: ${(e as Error).message}`);
          }
        } else {
          // Local picks preserve the #69 fallback for a result whose cached/open
          // entry disappeared between rendering and selection.
          try {
            catalogMatch = (await this.mentionFileIndexForCwd(workspaceRoot)).absByRel.get(msg.relPath);
          } catch (e) {
            this.host.appendLine(`[mention] index failed while validating local pick: ${(e as Error).message}`);
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
      case "listProjectDir": {
        // Remote file browse. Fence: repoScopeFor (which root) +
        // listTreeDir/resolveTreePath (paths inside it).
        // Local VS Code / desktop webviews may receive the capability flag but
        // never mount a second explorer — only remotes post these messages.
        const rel = typeof msg.relPath === "string" ? msg.relPath : "";
        const correlation = typeof msg.requestId === "string" ? { requestId: msg.requestId } : {};
        const selectedCwd = origin === "remote" && clientId
          ? this.remoteClients.cwd(clientId)
          : this.workspaceRoot();
        const rootResult = resolveRemoteFileRoot({
          origin,
          claimedCwd: msg.cwd,
          selectedCwd,
          workspaceRoot: this.workspaceRoot(),
          isKnownCwd: (cwd) =>
            origin === "remote"
              ? this.remoteTargetableCwd(cwd)
              : pathsEqual(cwd, this.workspaceRoot()),
          sameCwd: pathsEqual,
        });
        const replyList = (body: Extract<HostMsg, { type: "projectDirListing" }>) => {
          if (requester) this.sendRemoteRequester(requester, body);
          else this.post(body);
        };
        if (!rootResult.ok) {
          this.host.appendLine(`[remote-files] list rejected: ${rootResult.reason} (${msg.cwd})`);
          replyList({ type: "projectDirListing", ...correlation, cwd: msg.cwd, relPath: rel, ok: false, reason: rootResult.reason });
          break;
        }
        const listed = listRemoteProjectDir(rootResult.root, rel);
        if (!listed.ok) {
          replyList({ type: "projectDirListing", ...correlation, cwd: msg.cwd, relPath: rel, ok: false, reason: listed.reason });
        } else {
          replyList({
            type: "projectDirListing",
            ...correlation,
            cwd: msg.cwd,
            relPath: rel,
            ok: true,
            entries: listed.entries,
            truncated: listed.truncated,
          });
        }
        break;
      }
      case "readProjectFile": {
        // One file, text/image preview caps from file-tree.ts. When the host
        // advertises edit, text kinds also carry stamp + absPath for a save
        // round-trip (see writeProjectFile).
        const correlation = typeof msg.requestId === "string" ? { requestId: msg.requestId } : {};
        const selectedCwd = origin === "remote" && clientId
          ? this.remoteClients.cwd(clientId)
          : this.workspaceRoot();
        const rootResult = resolveRemoteFileRoot({
          origin,
          claimedCwd: msg.cwd,
          selectedCwd,
          workspaceRoot: this.workspaceRoot(),
          isKnownCwd: (cwd) =>
            origin === "remote"
              ? this.remoteTargetableCwd(cwd)
              : pathsEqual(cwd, this.workspaceRoot()),
          sameCwd: pathsEqual,
        });
        const replyFile = (body: Extract<HostMsg, { type: "projectFileContent" }>) => {
          if (requester) this.sendRemoteRequester(requester, body);
          else this.post(body);
        };
        if (!rootResult.ok) {
          this.host.appendLine(`[remote-files] read rejected: ${rootResult.reason} (${msg.cwd})`);
          replyFile({
            type: "projectFileContent",
            ...correlation,
            cwd: msg.cwd,
            relPath: msg.relPath,
            ok: false,
            reason: rootResult.reason,
          });
          break;
        }
        const read = readRemoteProjectFile(rootResult.root, msg.relPath);
        // includeEditMeta only when we advertise the write path — otherwise a
        // browse-only host must not leak absPath/stamp to the phone.
        const wire = projectFileContentForWire(read, {
          includeEditMeta: !!HOST_CAPABILITIES.editProjectFiles,
        });
        if (wire.ok) {
          replyFile({
            type: "projectFileContent",
            ...correlation,
            cwd: msg.cwd,
            relPath: wire.relPath,
            ok: true,
            kind: wire.kind,
            ...(wire.text !== undefined ? { text: wire.text } : {}),
            ...(wire.dataUrl !== undefined ? { dataUrl: wire.dataUrl } : {}),
            ...(wire.pretty !== undefined ? { pretty: wire.pretty } : {}),
            ...(wire.reformatted !== undefined ? { reformatted: wire.reformatted } : {}),
            ...(wire.stamp !== undefined ? { stamp: wire.stamp } : {}),
            ...(wire.absPath !== undefined ? { absPath: wire.absPath } : {}),
          });
        } else {
          replyFile({
            type: "projectFileContent",
            ...correlation,
            cwd: msg.cwd,
            relPath: msg.relPath,
            ok: false,
            reason: wire.reason,
          });
        }
        break;
      }
      case "writeProjectFile": {
        // Existing-file save only (no create/delete/rename). Reuses writeTreeFile
        // so stamp + expectedAbsPath both apply — a remote tab that went stale
        // after the desk switched projects is the expectedAbsPath scenario.
        // Capability gate: a host that does not advertise edit refuses here so
        // an older client cannot invent a write path the UI never offered.
        const correlation = typeof msg.requestId === "string" ? { requestId: msg.requestId } : {};
        const replyWrite = (body: Extract<HostMsg, { type: "projectFileWriteResult" }>) => {
          if (requester) this.sendRemoteRequester(requester, body);
          else this.post(body);
        };
        if (!HOST_CAPABILITIES.editProjectFiles) {
          replyWrite({
            type: "projectFileWriteResult",
            ...correlation,
            cwd: msg.cwd,
            relPath: msg.relPath,
            ok: false,
            reason: "editing is not available",
          });
          break;
        }
        const selectedCwd = origin === "remote" && clientId
          ? this.remoteClients.cwd(clientId)
          : this.workspaceRoot();
        const rootResult = resolveRemoteFileRoot({
          origin,
          claimedCwd: msg.cwd,
          selectedCwd,
          workspaceRoot: this.workspaceRoot(),
          isKnownCwd: (cwd) =>
            origin === "remote"
              ? this.remoteTargetableCwd(cwd)
              : pathsEqual(cwd, this.workspaceRoot()),
          sameCwd: pathsEqual,
        });
        if (!rootResult.ok) {
          this.host.appendLine(`[remote-files] write rejected: ${rootResult.reason} (${msg.cwd})`);
          replyWrite({
            type: "projectFileWriteResult",
            ...correlation,
            cwd: msg.cwd,
            relPath: msg.relPath,
            ok: false,
            reason: rootResult.reason,
          });
          break;
        }
        const written = writeRemoteProjectFile(
          rootResult.root,
          msg.relPath,
          msg.text,
          msg.stamp,
          {
            expectedAbsPath: msg.expectedAbsPath,
            // Same executable policy as desktop opens/saves — do not weaken it
            // for remote just because the phone never shell.opens the path.
          },
        );
        if (written.ok) {
          replyWrite({
            type: "projectFileWriteResult",
            ...correlation,
            cwd: msg.cwd,
            relPath: written.relPath,
            ok: true,
            stamp: written.stamp,
          });
        } else {
          this.host.appendLine(`[remote-files] write refused: ${written.reason} (${msg.relPath})`);
          replyWrite({
            type: "projectFileWriteResult",
            ...correlation,
            cwd: msg.cwd,
            relPath: msg.relPath,
            ok: false,
            reason: written.reason,
          });
        }
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
   * Merge a live MCP notification into reserved identity first so dedup does
   * not wait on a catalog read, then into the stored inventory only when there
   * is no catalog yet or the notifying session is that catalog's source.
   */
  private applyMcpNotification(session: Session, method: string, params: unknown): void {
    if (this.mcpListSupported === false) return;
    const next = mergeMcpNotification(this.mcpServers, method, params);
    this.grokMcpReserved = reservedFromMcpInventory(next, this.connectedConnectorStore());
    if (this.mcpServersCwd && !pathsEqual(this.sessionCwd(session), this.mcpServersCwd)) return;
    this.mcpServers = next;
    this.mcpServersView = this.filterMcpServers(this.mcpServers);
    if (this.mcpListSupported === true) {
      this.postMcpServers({
        type: "mcpServers",
        servers: this.mcpServersView,
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
    }
  }

  private postMcpServers(message: Extract<HostMsg, { type: "mcpServers" }>): void {
    const view = {
      ...message,
      servers: this.mcpServersView,
    };
    this.post(view);
    void this.settingsEditor?.webview.postMessage(view);
  }

  private mcpServersMessage(): Extract<HostMsg, { type: "mcpServers" }> {
    return {
      type: "mcpServers",
      servers: this.mcpServersView,
      warning: MCP_GLOBAL_SCOPE_WARNING,
    };
  }

  private connectedConnectorStore(): ConnectedConnectorStore {
    return parseConnectedConnectorStore(this.state.get(MCP_CONNECTORS_KEY, {}));
  }

  private mcpConnectorsMessage(): Extract<HostMsg, { type: "mcpConnectors" }> {
    const store = this.connectedConnectorStore();
    return {
      type: "mcpConnectors",
      remoteConnect: true,
      connectors: connectorViews(store, {
        connectingId: this.mcpConnectingId,
        errorId: this.mcpConnectError?.id,
        error: this.mcpConnectError?.message,
        keySet: new Set((this.mcpConnectorKeys ?? new Map()).keys()),
        lapsed: this.lapsedOAuthConnectors(store),
      }),
    };
  }

  private mcpConnectorAuthorizationMessage(): Extract<HostMsg, { type: "mcpConnectorAuthorization" }> | undefined {
    const pending = this.mcpRemoteAuthorization;
    return pending?.url ? {
      type: "mcpConnectorAuthorization", id: pending.id, attemptId: pending.attemptId,
      status: pending.status, url: pending.url,
    } : undefined;
  }

  private postMcpConnectors(): void {
    const message = this.mcpConnectorsMessage();
    this.post(message);
    void this.settingsEditor?.webview.postMessage(message);
    const authorization = this.mcpConnectorAuthorizationMessage();
    if (authorization) this.post(authorization);
    // Same reasoning as postRoutines: the connector count feeds the tip pool and
    // has just changed. This is also the initial-state call site, so a fresh
    // webview gets its first tip frame here without a separate trigger.
    this.postWelcomeTips();
  }

  private mcpNameCatalogFor(cwd: string): {
    nameLayer: Map<string, "project" | "user">;
    nameFile: Map<string, string>;
  } {
    // `this.mcpServers` is Grok's inventory (`refreshMcpServers` only reads
    // it through a Grok session). Classify against Grok's config files even
    // when the focused conversation is Codex or Claude — otherwise project
    // `.mcp.json` / `.grok/config.toml` are skipped and those rows fall
    // through as user-level and appear on a page that is grok.com + user
    // config only. The cwd is the catalog's source workspace, never the
    // receiving/focused session's.
    const opts = {
      cwd,
      provider: "grok" as const,
      grokHome: resolveGrokHome(process.env),
      userHome: process.env.USERPROFILE || process.env.HOME || os.homedir(),
    };
    const files: { layer: "project" | "user"; path: string; names: string[] }[] = [];
    for (const filePath of mcpConfigPaths(opts)) {
      try {
        if (!fs.existsSync(filePath)) continue;
        files.push({
          layer: mcpConfigLayer(filePath, opts),
          path: filePath,
          names: collectReservedMcpIdentity(fs.readFileSync(filePath, "utf8")).names,
        });
      } catch {
        // Unreadable configs must not block the inventory page.
      }
    }
    return {
      nameLayer: collectMcpNameLayers(files),
      nameFile: collectMcpNameFiles(files),
    };
  }

  private filterMcpServers(servers: readonly McpServerView[] = this.mcpServers): McpServerView[] {
    return mcpSettingsServersForCwd({
      servers,
      catalogCwd: this.mcpServersCwd,
      nameCatalogFor: (cwd) => this.mcpNameCatalogFor(cwd),
    });
  }

  private reservedMcpIdentityFor(session: Session): ReservedMcpIdentity {
    const cwd = this.sessionCwd(session);
    const parts: ReservedMcpIdentity[] = [];
    for (const filePath of mcpConfigPaths({
      cwd,
      provider: session.provider,
      grokHome: resolveGrokHome(process.env),
      userHome: process.env.USERPROFILE || process.env.HOME || os.homedir(),
    })) {
      try {
        if (!fs.existsSync(filePath)) continue;
        parts.push(collectReservedMcpIdentity(fs.readFileSync(filePath, "utf8")));
      } catch {
        // Unreadable configs must not block session/new.
      }
    }
    if (session.provider === "grok") parts.push(this.grokMcpReserved);
    return mergeReserved(...parts);
  }

  private async hostMcpServersFor(session: Session) {
    // Shared record is refreshSync'd from disk; the PAT cache is not. Re-read
    // this host's own HostSecrets, then take the disk-fresh record. The
    // secret does not travel.
    await this.loadMcpConnectorKeys();
    const store = this.connectedConnectorStore();
    const keyAuth: Record<string, string> = {};
    for (const [id, token] of this.mcpConnectorKeys ?? []) {
      if (store[id]) keyAuth[id] = token;
    }
    return hostMcpServers(
      store,
      this.reservedMcpIdentityFor(session),
      persistConnectorOAuthClientMetadata(store),
      keyAuth,
      this.lapsedOAuthConnectors(store),
    );
  }

  /**
   * Connectors we withhold from `session/new` because their token is gone.
   *
   * Read fresh rather than cached: a person can finish a sign-in in the browser
   * between two sessions, and a cached "lapsed" would keep the connector off
   * until the window was reloaded. It is one readdir and a few existsSync calls.
   */
  private lapsedOAuthConnectors(store = this.connectedConnectorStore()): ReadonlySet<string> {
    return connectorsLackingOAuthToken({ store });
  }

  private async loadMcpConnectorKeys(): Promise<void> {
    for (const connector of TIER1_CONNECTORS) {
      if (!isKeyConnector(connector)) continue;
      try {
        const value = await this.context.secrets.get(mcpConnectorSecretKey(connector.id));
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed) this.mcpConnectorKeys.set(connector.id, trimmed);
        else this.mcpConnectorKeys.delete(connector.id);
      } catch (error) {
        this.host.appendLine(`[mcp] could not read ${connector.id} connector key: ${(error as Error).message}`);
      }
    }
    this.postMcpConnectors();
  }

  private async forgetConnectorKey(id: ConnectorId): Promise<void> {
    this.mcpConnectorKeys.delete(id);
    try {
      await this.context.secrets.delete(mcpConnectorSecretKey(id));
    } catch (error) {
      this.host.appendLine(`[mcp] could not delete ${id} connector key: ${(error as Error).message}`);
    }
  }

  private async connectMcpConnector(
    id: string,
    opts: { key?: string; readOnly?: boolean; remote?: boolean } = {},
  ): Promise<void> {
    if (!isConnectorId(id)) return;
    if (this.mcpConnectingId) {
      this.mcpConnectError = {
        id,
        // Actionable now that the pending link rides the connectors snapshot:
        // whichever tab is asking has just been re-sent the sign-in it wants.
        message: this.mcpConnectingId === id
          ? "Sign-in is already in progress. Finish it with the link above, or wait for it to time out."
          : `Already connecting ${this.mcpConnectingId}. Wait for that to finish.`,
      };
      this.postMcpConnectors();
      return;
    }
    const connector = connectorById(id);
    if (!connector) return;
    const store = this.connectedConnectorStore();
    const endpoint = store[id]?.endpoint || connector.endpoint;
    if (isKeyConnector(connector)) {
      await this.connectKeyMcpConnector(connector, endpoint, opts);
      return;
    }
    this.mcpConnectingId = id;
    this.mcpConnectError = undefined;
    const npx = npxSpawnPlan(process.platform);
    let metadata: { path: string; dispose: () => void } | undefined;
    const pending: GrokSidebar["mcpRemoteAuthorization"] = opts.remote
      ? { id, attemptId: randomUUID(), status: "waiting" }
      : undefined;
    this.mcpRemoteAuthorization = pending;
    this.postMcpConnectors();
    try {
      if (connector.oauthScope?.trim()) {
        metadata = writeOAuthClientMetadataFile(connector.oauthScope.trim());
      }
      const result = await authorizeMcpRemote({
        spawn,
        command: npx.command,
        args: mcpRemoteArgs(endpoint, undefined, metadata?.path),
        shell: npx.shell,
        env: npx.env,
        onAuthorization: pending ? (url, complete) => {
          if (this.mcpRemoteAuthorization !== pending) return;
          pending.url = url;
          pending.complete = complete;
          this.postMcpConnectors();
        } : undefined,
      });
      if (this.mcpConnectingId !== id || this.mcpRemoteAuthorization !== pending) return;
      if (!result.ok) {
        this.mcpConnectError = { id, message: result.message };
        return;
      }
      // Re-read rather than writing the pre-await snapshot. The browser flow
      // takes as long as the user takes, other rows stay actionable throughout,
      // and `store` was captured before it began — so a Disconnect during
      // sign-in would be undone by this write, silently handing every later
      // agent a connector the user had explicitly removed.
      await this.state.update(
        MCP_CONNECTORS_KEY,
        connectConnector(this.connectedConnectorStore(), id, endpoint),
      );
      this.mcpConnectError = undefined;
    } catch (error) {
      if (this.mcpRemoteAuthorization !== pending) return;
      this.mcpConnectError = { id, message: (error as Error).message || "Could not connect." };
    } finally {
      try { metadata?.dispose(); } catch { /* best-effort */ }
      if (this.mcpRemoteAuthorization === pending) {
        if (pending) {
          this.mcpRemoteAuthorization = undefined;
          this.post({
            type: "mcpConnectorAuthorization", id, attemptId: pending.attemptId, status: "finished",
          });
        }
        if (this.mcpConnectingId === id) this.mcpConnectingId = undefined;
        this.postMcpConnectors();
      }
    }
  }

  private async completeMcpConnectorOAuth(
    msg: Extract<WebviewMsg, { type: "completeMcpConnectorOAuth" }>,
    clientId: string,
  ): Promise<void> {
    const pending = this.mcpRemoteAuthorization;
    if (!pending?.complete || pending.id !== msg.id || pending.attemptId !== msg.attemptId) {
      this.deliverRemote([clientId], {
        type: "mcpConnectorAuthorization", id: msg.id, attemptId: msg.attemptId, status: "finished",
        error: "This sign-in expired or was replaced. Connect again to get a new link.",
      });
      return;
    }
    try {
      await pending.complete(msg.redirectUrl);
      if (this.mcpRemoteAuthorization !== pending || !pending.complete) return;
      pending.status = "submitted";
      this.post({
        type: "mcpConnectorAuthorization", id: pending.id, attemptId: pending.attemptId, status: "submitted",
      });
    } catch (error) {
      if (this.mcpRemoteAuthorization !== pending || !pending.complete) return;
      this.deliverRemote([clientId], {
        type: "mcpConnectorAuthorization", id: pending.id, attemptId: pending.attemptId, status: "waiting",
        url: pending.url, error: (error as Error).message,
      });
    }
  }

  private async connectKeyMcpConnector(
    connector: ConnectorDef,
    endpoint: string,
    opts: { key?: string; readOnly?: boolean },
  ): Promise<void> {
    const id = connector.id;
    const incoming = typeof opts.key === "string" ? opts.key.trim() : "";
    if (incoming.length > MAX_CONNECTOR_KEY_CHARS) {
      this.mcpConnectError = { id, message: "That token is too long." };
      this.postMcpConnectors();
      return;
    }
    const token = incoming || this.mcpConnectorKeys.get(id) || "";
    const store = this.connectedConnectorStore();
    if (typeof opts.readOnly === "boolean" && !incoming && store[id] && this.mcpConnectorKeys.has(id)) {
      await this.state.update(
        MCP_CONNECTORS_KEY,
        connectConnector(store, id, endpoint, opts.readOnly),
      );
      this.mcpConnectError = undefined;
      this.postMcpConnectors();
      return;
    }
    if (!token) {
      this.mcpConnectError = { id, message: "Paste a personal access token to connect." };
      this.postMcpConnectors();
      return;
    }
    this.mcpConnectingId = id;
    this.mcpConnectError = undefined;
    this.postMcpConnectors();
    const npx = npxSpawnPlan(process.platform);
    try {
      const result = await authorizeMcpRemote({
        spawn,
        command: npx.command,
        args: mcpRemoteArgs(endpoint, undefined, undefined, {
          authorization: true,
          readOnly: opts.readOnly === true || (!incoming && store[id]?.readOnly === true),
        }),
        shell: npx.shell,
        env: withAuthHeaderEnv(npx.env, token),
        auth: "key",
      });
      if (this.mcpConnectingId !== id) return;
      if (!result.ok) {
        this.mcpConnectError = { id, message: result.message };
        return;
      }
      const header = bearerAuthorizationHeader(token);
      if (header) {
        await this.context.secrets.store(mcpConnectorSecretKey(id), token);
        this.mcpConnectorKeys.set(id, token);
      }
      const readOnly = opts.readOnly === true
        || (typeof opts.readOnly !== "boolean" && this.connectedConnectorStore()[id]?.readOnly === true);
      await this.state.update(
        MCP_CONNECTORS_KEY,
        connectConnector(this.connectedConnectorStore(), id, endpoint, readOnly),
      );
      this.mcpConnectError = undefined;
    } catch {
      // Secret-store errors are not a response channel for credential values.
      this.mcpConnectError = { id, message: "Could not save this connector's key. Try connecting again." };
    } finally {
      if (this.mcpConnectingId === id) this.mcpConnectingId = undefined;
      this.postMcpConnectors();
    }
  }

  private async disconnectMcpConnector(id: string): Promise<void> {
    if (!isConnectorId(id)) return;
    if (this.mcpConnectingId === id) return;
    const connector = connectorById(id);
    if (isKeyConnector(connector)) await this.forgetConnectorKey(id);
    await this.state.update(MCP_CONNECTORS_KEY, disconnectConnector(this.connectedConnectorStore(), id));
    if (this.mcpConnectError?.id === id) this.mcpConnectError = undefined;
    this.postMcpConnectors();
  }

  /**
   * Live Grok ACP session to read `_x.ai/mcp/list` through. Prefers any pooled
   * Grok conversation that already has a client — the focused session may be
   * Codex or Claude. Does not mint a session.
   */
  private findLiveGrokSession(): Session | undefined {
    const seen = new Set<Session>();
    for (const candidate of [this.focused, ...this.pool]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (candidate.provider === "grok" && candidate.client) return candidate;
    }
    return undefined;
  }

  /**
   * Session for the Connectors inventory. Reuses a live Grok client when one
   * exists; otherwise, if Grok is connected, starts an empty Grok session
   * (Connectors page only — never on boot). Overlapping callers await the same
   * in-flight start — a newly created session is not in `pool` until startup
   * completes. Empty-session recycling owns the rest: we do not dispose it here.
   */
  private async grokSessionForMcpList(requester: Session): Promise<Session | undefined> {
    const live = this.findLiveGrokSession();
    if (live) return live;
    if (this.grokSessionForMcpListInFlight) return this.grokSessionForMcpListInFlight;
    if (!this.connectedProviders().includes("grok")) return undefined;
    const pending = (async (): Promise<Session | undefined> => {
      const seen = new Set<Session>();
      let grok: Session | undefined;
      for (const candidate of [this.focused, ...this.pool]) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        if (candidate.provider === "grok") {
          grok = candidate;
          break;
        }
      }
      if (!grok) {
        grok = this.newLocalSession();
        grok.provider = "grok";
        this.setSessionCwd(grok, this.sessionCwd(requester), this.workspaceRoot());
      }
      await this.startSession(undefined, grok, "ensure");
      return grok.client ? grok : undefined;
    })();
    this.grokSessionForMcpListInFlight = pending;
    // `then(clear, clear)` rather than `finally`: an ACP start can reject, and
    // the promise `finally` derives would carry that rejection with nothing
    // attached to it. Callers await `pending` itself, never the derived one.
    const clear = () => {
      if (this.grokSessionForMcpListInFlight === pending) {
        this.grokSessionForMcpListInFlight = undefined;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  /** Read MCP inventory through a Grok ACP session, not necessarily the focused one. */
  private async refreshMcpServers(session: Session): Promise<void> {
    this.postMcpServers({
      type: "mcpServers",
      servers: this.mcpServersView,
      loading: true,
      warning: MCP_GLOBAL_SCOPE_WARNING,
    });
    const grokConnected = this.connectedProviders().includes("grok");
    const grok = await this.grokSessionForMcpList(session);
    const client = grok?.client;
    if (!grok || !client) {
      this.mcpListSupported = undefined;
      this.mcpServers = [];
      this.mcpServersCwd = undefined;
      this.mcpServersView = [];
      this.postMcpServers({
        type: "mcpServers",
        servers: [],
        error: grokConnected
          ? "Could not load MCP servers from Grok."
          : "Connect Grok to inspect MCP servers.",
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
      return;
    }
    try {
      const result = await client.listMcpServers();
      if (grok.client !== client) return;
      if (result === "unsupported") {
        this.mcpListSupported = false;
        this.mcpServers = [];
        this.mcpServersCwd = undefined;
        this.mcpServersView = [];
        this.postMcpServers({
          type: "mcpServers",
          servers: [],
          warning: MCP_GLOBAL_SCOPE_WARNING,
        });
        return;
      }
      this.mcpListSupported = true;
      this.mcpServers = parseMcpListResponse(result);
      this.mcpServersCwd = this.sessionCwd(grok) || undefined;
      this.mcpServersView = this.filterMcpServers(this.mcpServers);
      this.grokMcpReserved = reservedFromMcpInventory(this.mcpServers, this.connectedConnectorStore());
      this.postMcpServers({
        type: "mcpServers",
        servers: this.mcpServersView,
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
    } catch (error) {
      const detail = errorDetail(error);
      this.host.appendLine(`[mcp] _x.ai/mcp/list failed: ${detail}`);
      this.postMcpServers({
        type: "mcpServers",
        servers: [],
        error: detail || "Could not load MCP servers from Grok.",
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
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
  /**
   * Which repository the LOCAL surfaces are scoped to — the history list, New
   * Session, and the last-resort cwd a delete falls back to.
   *
   * This used to be the open workspace folder unconditionally
   * (`repoScopeFor`'s local branch), and the reason was sound at the time: VS
   * Code hid the repo switcher, so a selection the local user could not see
   * must not decide where Grok writes files. A phone that switched repos hours
   * ago would otherwise have been aiming the desk's New Session at another
   * checkout.
   *
   * Two things changed. VS Code has a projects rail now, so the selection is
   * visible and deliberate. And the selection is provably not the phone's:
   * `selectRepo` routes by origin — remotes go to `selectRemoteRepo`, which
   * writes a per-client cwd — and every writer of `selectedRepoCwd` is a local
   * path (selectRepo, postRepoCatalog's normalisation, the desktop folder
   * switch, openSession's follow). What the old rule produces now is simply the
   * wrong answer: a conversation from project B on screen with A's history
   * beside it, and New Session starting in A.
   *
   * Desktop is unaffected in steady state — there `selectedRepoCwd` tracks the
   * active folder, so the two agree.
   *
   * Remote scope is untouched and still goes through {@link repoScopeFor},
   * which is where per-tab isolation lives.
   */
  private historyCwdFor(origin: MsgOrigin): string {
    if (origin === "local") return this.selectedHistoryCwd() || this.workspaceRoot();
    return repoScopeFor(origin, {
      selectedCwd: this.selectedHistoryCwd(),
      workspaceRoot: this.workspaceRoot(),
    });
  }

  /** Refresh local history plus each connected remote tab. */
  /**
   * Rebuild and fan out the conversation list — COALESCED.
   *
   * Twenty-odd sites call this, because every catalog mutation funnels here on
   * purpose. That is the right shape, and it meant one click ran the rebuild
   * about twice, each time walking every session directory to sort by mtime:
   * ~380ms per walk at 3000 conversations, synchronously, on the thread that
   * paints the window (#133/#131).
   *
   * Every call posts a COMPLETE snapshot, so collapsing the ones that land in a
   * single tick loses nothing — the earlier frames were superseded before
   * anyone saw them. What the rail shows is unchanged; it is painted once
   * instead of twice, a tick later.
   *
   * A paged request is NOT coalesced. `opts` means the webview asked for a
   * specific slice and is waiting for it: merging that into a later
   * whole-list refresh would answer a scroll with the wrong page, or not at all.
   */
  private postSessionsList(opts?: SessionsListOptions): void {
    if (opts) {
      this.postSessionsListNow(opts);
      return;
    }
    if (this.sessionsListScheduled) return;
    this.sessionsListScheduled = true;
    setImmediate(() => {
      this.sessionsListScheduled = false;
      this.postSessionsListNow();
    });
  }

  private postSessionsListNow(opts?: SessionsListOptions): void {
    const localCwd = this.historyCwdFor("local");
    const local = this.buildSessionsList(localCwd, opts, undefined);
    this.postLocal(local);
    this.postSessionName(this.focused);
    if (opts) return;
    // Pins ride along with every catalog mutation rather than being refreshed at
    // each site that can invalidate one. Deleting a session, clearing a repo and
    // removing a worktree all land here; hanging the pinned refresh off the same
    // funnel fixes the whole class instead of the three cases we happened to
    // think of. Cheap when nothing is pinned — the scan is over an in-memory map
    // and reads no disk until a pin actually exists.
    this.postPinnedSessions();
    for (const clientId of this.remoteClients.clients()) {
      // Per-tab cwd may still name a closed project after revoke leaves it for
      // selectRepo — buildSessionsList enforces the live authorized set.
      // Same landmine as the voice-config refresh: a mid-handshake tab is in
      // the roster with no project, and this list rebuild is not a request
      // from that tab.
      const cwd = this.remoteClients.cwdIfPresent(clientId);
      if (!cwd) continue;
      const activeId = this.remoteActiveSessionId(clientId);
      this.sendRemoteClient(clientId, this.buildSessionsList(cwd, undefined, activeId));
      const active = this.remoteClients.active(clientId);
      if (active) this.postSessionName(active);
    }
  }

  private buildSessionsList(
    cwd: string,
    opts?: SessionsListOptions,
    activeId: string | null | undefined = this.focused.activeSessionId,
  ): Extract<HostMsg, { type: "sessions" }> {
    const offset = Math.max(0, opts?.offset ?? 0);
    const authorized = this.authorizedSessionCwds();
    const listCwd = authorizedListCwd(cwd, authorized, pathsEqual);
    if (!listCwd) {
      return {
        type: "sessions",
        entries: [],
        activeId: null,
        dots: {},
        offset,
        total: 0,
        hasMore: false,
        nextOffset: offset,
        query: opts?.query ?? "",
      };
    }
    cwd = listCwd;
    const providers = this.connectedProviders();
    const adapterProviders = providers.filter(isAdapterProvider);
    for (const provider of adapterProviders) this.scheduleAdapterHistoryRefresh(provider, cwd);
    // Grok rows are files under GROK_HOME/sessions (plus live-pool synthesis) —
    // listing is disk/buffer-truth and must not wait for a located grok binary.
    // Adapter rows come from session/list, so they legitimately require that CLI.
    if (!adapterProviders.length) {
      return this.buildGrokSessionsList(cwd, opts, activeId);
    }

    const query = opts?.query ?? "";
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const providerCursor = opts?.providerCursor ?? { grokOffset: offset };
    const grok = this.buildGrokSessionsList(cwd, query
          ? { offset: 0, limit: Number.MAX_SAFE_INTEGER, query }
          : { offset: providerCursor.grokOffset, limit, query }, activeId);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const adapter: SessionListEntry[] = [];
    if (providers.includes("codex")) adapter.push(...(this.codexSessionCache.get(projectProviderKey(cwd)) ?? []));
    if (providers.includes("claude")) adapter.push(...(this.claudeSessionCache.get(projectProviderKey(cwd)) ?? []));
    for (const session of this.pool) {
      if (!isAdapterProvider(session.provider) || !session.activeSessionId || !pathsEqual(this.sessionCwd(session), cwd)) continue;
      if (adapter.some((entry) => entry.id === session.activeSessionId)) continue;
      adapter.push(this.liveSessionEntry(session, session.activeSessionId, this.sessionCwd(session), overrides));
    }
    adapter.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const merged = query
      ? mergeProviderSessionEntries(grok?.entries ?? [], adapter, providers, query)
      : undefined;
    const combinedPage = query ? undefined : mergeProviderHistoryPage(
      grok,
      adapter,
      providerCursor,
      limit,
    );
    const entries = query
      ? (merged ?? []).slice(offset, offset + limit)
      : combinedPage?.entries ?? [];
    const dots: Record<string, Dot> = {};
    for (const entry of entries) dots[entry.id] = this.dotForId(entry.id);
    const nextOffset = query
      ? offset + entries.length
      : Math.max(offset + entries.length, combinedPage?.providerCursor.grokOffset ?? 0);
    const total = query ? (merged?.length ?? 0) : (grok?.total ?? 0) + adapter.length;
    return {
      type: "sessions",
      entries,
      activeId,
      dots,
      offset,
      total,
      hasMore: query ? nextOffset < total : combinedPage?.hasMore ?? false,
      nextOffset,
      ...(!query && combinedPage ? { providerCursor: combinedPage.providerCursor } : {}),
      query,
    };
  }

  private scheduleCodexHistoryRefresh(cwd: string): void {
    this.scheduleAdapterHistoryRefresh("codex", cwd);
  }

  private scheduleAdapterHistoryRefresh(provider: AcpProvider, cwd: string): void {
    if (!isAdapterProvider(provider) || !this.connectedProviders().includes(provider)) return;
    const history = this.adapterHistory(provider);
    if (!history) return;
    const key = projectProviderKey(cwd);
    if (history.refresh.has(key)) return;
    if (Date.now() - (history.at.get(key) ?? 0) < 10_000) return;
    const refresh = (provider === "codex"
      ? this.refreshCodexHistory(cwd, key)
      : this.refreshAdapterHistory(provider, cwd, key))
      .catch((error) => {
        this.host.appendLine(`[${provider}] session listing failed: ${(error as Error).message}`);
        const credential = provider === "claude" ? isClaudeCredentialError(error) : isCodexCredentialError(error);
        if (!credential) return;
        history.at.set(key, Date.now());
        this.setProviderNeedsLogin(provider, true);
      })
      .finally(() => history.refresh.delete(key));
    history.refresh.set(key, refresh);
  }

  private async refreshCodexHistory(cwd: string, key = projectProviderKey(cwd)): Promise<void> {
    return this.refreshAdapterHistory("codex", cwd, key);
  }

  private async refreshAdapterHistory(provider: AcpProvider, cwd: string, key = projectProviderKey(cwd)): Promise<void> {
    if (!isAdapterProvider(provider)) return;
    const history = this.adapterHistory(provider);
    const cliPath = this.locateProvider(provider);
    const backend = this.createProviderBackend(provider);
    if (!history || !cliPath || !backend || !this.connectedProviders().includes(provider)) return;
    const client = new AcpClient({
      cliPath,
      cwd,
      env: { ...process.env },
      backend,
      log: (message) => this.host.appendLine(message),
    });
    try {
      await client.start();
      const result = await client.listSessions(cwd, process.platform);
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      const stableOverrides: SessionMetaOverrides = { ...overrides };
      // First-seen adapter listing time is a baseline only. Claude restamps
      // `updatedAt` on `session/load` (measured). Codex does not restamp, but
      // pinning is still what we want: an open must not promote the row.
      // Trade-off: work done outside this extension stops promoting the row.
      // Unlike grok, neither adapter has a load-stable on-disk file to rank by.
      for (const entry of result.sessions) {
        const previous = stableOverrides[entry.sessionId] ?? {};
        if (typeof previous.activeAt === "number") continue;
        stableOverrides[entry.sessionId] = {
          ...previous,
          activeAt: adapterListEntry(entry, {}, provider, Date.now()).updatedAt,
        };
      }
      const entries = result.sessions.map((entry) => adapterListEntry(entry, stableOverrides, provider));
      this.setProviderNeedsLogin(provider, false);
      history.cache.set(key, entries);
      history.at.set(key, Date.now());
      await this.updateSessionMeta((current) => {
        let changed = false;
        const next = { ...current };
        for (const entry of result.sessions) {
          const previous = next[entry.sessionId] ?? {};
          const title = typeof entry.title === "string" ? entry.title.trim() : "";
          const autoName = capAutoName(title);
          const updated = {
            ...previous,
            provider,
            providerCwd: entry.cwd,
            activeAt: typeof previous.activeAt === "number"
              ? previous.activeAt
              : stableOverrides[entry.sessionId]?.activeAt,
            ...(!previous.customName && autoName ? { autoName } : {}),
          };
          if (JSON.stringify(updated) !== JSON.stringify(previous)) {
            next[entry.sessionId] = updated;
            changed = true;
          }
        }
        return changed ? next : null;
      });
    } finally {
      await client.dispose();
    }
    this.postSessionsList();
    this.sendLocalRepoSessionsPreview(cwd);
  }

  private buildGrokSessionsList(
    cwd: string,
    opts?: GrokSessionsListOptions,
    activeId: string | null | undefined = this.focused.activeSessionId,
  ): GrokSessionsListMessage {
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit ?? SESSION_PAGE_SIZE;
    const query = (opts?.query ?? "").trim().toLowerCase();
    // Stale per-tab / selected cwds must not scan a closed project's catalog.
    const authorized = this.authorizedSessionCwds();
    const listCwd = authorizedListCwd(cwd, authorized, pathsEqual);
    if (!listCwd) {
      return {
        type: "sessions",
        entries: [],
        activeId: null,
        dots: {},
        offset,
        total: 0,
        hasMore: false,
        nextOffset: offset,
        query: opts?.query ?? "",
      };
    }
    cwd = listCwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const log = (m: string) => this.host.appendLine(m);

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
      const pageIndex = index.slice(offset, offset + limit);
      const pageIds = pageIndex.map((e) => e.id);
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
    const liveProvider = new Map<string, AcpProvider>();
    for (const s of this.pool) {
      if (!s.activeSessionId) continue;
      liveProvider.set(s.activeSessionId, s.provider);
      if (!s.hasHistory) liveEmpty.add(s.activeSessionId);
    }
    for (const e of pageEntries) {
      const provider = liveProvider.get(e.id);
      if (provider) e.provider = provider;
      if (!e.customName && liveEmpty.has(e.id)) e.displayName = "New session";
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
   *  Precedence mirrors the list itself: the user's `customName` first (that IS
   *  the row's label for any session that has one), then grok's own title, then
   *  the first user message.
   *
   *  The one deliberate departure: a **legacy primer-derived** title is skipped.
   *  Older builds sent the primer as message #1, so inheriting that invisible
   *  internal title into a fork would propagate it forever. `cliSessionTitle`
   *  rejects it and we fall through to something real. */
  private sessionDisplayName(session: Session): string {
    const id = session.activeSessionId;
    if (!id) return "";
    const override = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    const custom = override?.customName?.trim();
    if (custom) return custom;
    // A live empty session is deliberately shown as "New session" in the
    // history list, even if grok has already left a summary file behind.
    if (!session.hasHistory) return "New session";
    try {
      const cwd = this.sessionCwd(session);
      const grokHome = resolveGrokHome(process.env);
      const sessDir = sessionDirFor(grokHome, cwd, id, { fs: defaultFs });
      if (!sessDir) throw new Error("no session dir");
      const raw = JSON.parse(fs.readFileSync(path.join(sessDir, "summary.json"), "utf8"));
      const title = cliSessionTitle(raw?.session_summary, raw?.generated_title);
      if (title) return fallbackName(title, Date.now());
    } catch {
      // No summary yet (grok flushes it at turn end) — fall through.
    }
    // Same last resort the history list uses ("Untitled (<date>)"), so a fork of
    // a nameless session reads like a row rather than a bare "(Fork)".
    const generated = (override?.autoName || "").trim();
    const opening = (session.firstUserMessageForTitle || "").trim();
    const first = session.client && isAdapterProvider(session.client.provider) ? generated || opening : opening || generated;
    return fallbackName(first, Date.now());
  }

  /** Push the focused conversation's title independently of history pagination.
   *  The VS Code webview must not depend on the history popover having been
   *  opened, while remote tabs need the same live update after a rename or turn. */
  private postSessionName(session: Session, name = this.sessionDisplayName(session)): void {
    const id = session.activeSessionId;
    if (!id) return;
    const cwd = this.sessionCwd(session);
    // The owning PROJECT, resolved the same way the rail groups worktrees under
    // their parent. Only when it differs from the cwd — an ordinary session is
    // its own project and the field would be noise.
    const owner = this.resolveLocalRepoTarget(cwd)?.cwd;
    const message: HostMsg = {
      type: "sessionName",
      sessionId: id,
      name,
      cwd,
      ...(owner && !pathsEqual(owner, cwd) ? { repoCwd: owner } : {}),
    };
    if (session === this.focused) this.postLocal(message);
    this.sendRemoteSession(session, message);
  }

  private postSessionRemoved(id: string | undefined, cwd: string): void {
    if (!id) return;
    const message: HostMsg = { type: "sessionRemoved", id, cwd };
    this.postLocal(message);
    // Every tab holds previews and pins, including for projects it isn't viewing.
    this.deliverRemote(this.remoteClients.clients(), message, cwd);
  }

  private liveSessionEntry(
    session: Session,
    id: string,
    cwd: string,
    overrides: SessionMetaOverrides,
  ): SessionListEntry {
    const now = Date.now();
    const customName = overrides[id]?.customName?.trim() || undefined;
    // No summary.json to read yet, so grok has no title for this one — the best
    // we have is the opening message, live or as the stored `autoName`.
    const firstMsg = (session.firstUserMessageForTitle || "").trim()
      || (overrides[id]?.autoName || "").trim();
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
      provider: session.provider,
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

  /** Which repo a remote request may act in. The client's selection by default;
   *  a NAMED repo when it asks for one and that repo is in the host's own
   *  catalog. Matching the catalog is the whole boundary — the path is never
   *  trusted as given, so a remote can only ever reach projects this host has
   *  already discovered and told it about.
   *
   *  Widened from selection-only deliberately: the rail lists every project, and
   *  refusing to rename a row it just drew is a broken affordance, not a guard.
   *  It was never much of a guard either — a remote can select any catalog repo
   *  and then act, so the selection only ever added a step to the same reach. */
  private remoteRepoScope(clientId: string, requestedCwd?: string): string | undefined {
    if (requestedCwd) {
      // Host catalog the client was told about (open folders on desktop).
      const hit = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, requestedCwd));
      // The host's own spelling, never the client's.
      if (hit?.available) return hit.cwd;
      return undefined;
    }
    return this.remoteClients.cwd(clientId);
  }

  /** The catalog repo that owns a session cwd — the checkout itself, or the parent
   *  of one of its worktrees. A rail row for a worktree session names the WORKTREE
   *  as its cwd, because that is where its transcript lives, and a worktree is
   *  deliberately not a catalog row (see sessionCwdsForRepo) — so scoping by
   *  catalog alone refused every action on one. The catalog is still the whole
   *  boundary: the parent has to be a repo this host exposes (open on desktop,
   *  discovered on VS Code). */
  private repoOwningSessionCwd(
    cwd: string,
    overrides: SessionMetaOverrides,
    entries: RepoListEntry[] = this.localRepoCatalogEntries(),
  ): string | undefined {
    return entries.find(
      (r) => r.available && this.sessionCwdsForRepo(r.cwd, overrides).some((c) => pathsEqual(c, cwd)),
    )?.cwd;
  }

  /** Where a remote's rename/delete may land, or why it may not.
   *
   *  "gone" is not a permission answer: the project IS in scope, the conversation
   *  simply is not in it any more. That is exactly what a rail row left over from
   *  a clear-all looks like, and answering it with "wrong repository" sent people
   *  hunting a permissions bug that was really a stale list. */
  private remoteSessionTarget(
    clientId: string,
    id: string,
    overrides: SessionMetaOverrides,
    requestedCwd?: string,
  ): { cwd: string; reason?: undefined } | { cwd?: undefined; reason: "scope" | "gone"; repoCwd?: string } {
    // A named repo the catalog does not know is a refusal, not a fallback to the
    // selected one — otherwise a bad cwd would quietly act somewhere else.
    const selectedCwd = this.remoteRepoScope(clientId, requestedCwd)
      ?? (requestedCwd ? this.repoOwningSessionCwd(requestedCwd, overrides) : undefined);
    if (!selectedCwd) return { reason: "scope" };
    const allowedCwds = this.sessionCwdsForRepo(selectedCwd, overrides);
    const live = [...this.pool].find((session) => session.activeSessionId === id);
    if (live) {
      const cwd = this.sessionCwd(live);
      if (sessionCwdBelongsToRepo(cwd, allowedCwds, pathsEqual)) return { cwd };
    }

    const cachedAdapter = findCachedAdapterSession(
      this.allAdapterCatalogs(),
      id,
      allowedCwds,
      (cwd, allowed) => sessionCwdBelongsToRepo(cwd, allowed, pathsEqual),
    );
    const provider = live?.provider ?? overrides[id]?.provider ?? cachedAdapter?.provider ?? "grok";
    if (provider && isAdapterProvider(provider)) {
      return cachedAdapter ? { cwd: cachedAdapter.cwd } : { reason: "gone", repoCwd: selectedCwd };
    }

    const candidates = [...new Set([
      overrides[id]?.worktreePath,
      this.sessionCache.get(id)?.entry.cwd,
      ...allowedCwds,
    ].filter((cwd): cwd is string =>
      !!cwd && sessionCwdBelongsToRepo(cwd, allowedCwds, pathsEqual)
    ))];
    const grokHome = resolveGrokHome(process.env);
    const found = candidates.find((cwd) =>
      indexSessions({ fs: defaultFs, grokHome, cwd })
        .some((entry) => entry.id === id)
    );
    return found ? { cwd: found } : { reason: "gone", repoCwd: selectedCwd };
  }

  private reportUnauthorizedSessionTarget(
    clientId: string,
    action: "rename" | "delete",
    id: string,
    miss: { reason: "scope" | "gone"; repoCwd?: string },
  ): void {
    if (miss.reason === "gone") {
      this.host.appendLine(`[remote] dropped ${action}Session for ${id} (no longer in ${miss.repoCwd})`);
      // Refresh what the client is looking at rather than argue with it: the row
      // it acted on is stale, so the honest repair is to make the row disappear.
      this.postSessionsList();
      this.refreshRemoteRepoPreview(clientId, miss.repoCwd);
      this.sendRemoteClient(clientId, {
        type: "error",
        text: "That conversation is no longer in this project. The list has been refreshed.",
      });
      return;
    }
    this.host.appendLine(`[remote] refused ${action}Session for ${id} (session is outside every known project)`);
    this.sendRemoteClient(clientId, {
      type: "error",
      text: `Could not ${action} this conversation because it does not belong to a project this computer knows about.`,
    });
  }

  private renameSession(
    id: string,
    name: string,
    origin: MsgOrigin,
    clientId?: string,
    requestedCwd?: string,
  ): void {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const target = origin === "remote" && clientId
      ? this.remoteSessionTarget(clientId, id, overrides, requestedCwd)
      : undefined;
    if (target?.reason && clientId) {
      this.reportUnauthorizedSessionTarget(clientId, "rename", id, target);
      return;
    }
    const authorizedCwd = target?.cwd;
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
    void this.state.update(SESSION_META_KEY, next);
    // A rename changes displayName but not summary.json's mtime, so the mtime-keyed cache would
    // otherwise keep serving the old name. Drop it so the next read rebuilds the entry.
    this.sessionCache.delete(id);
    for (const adapter of (["codex", "claude"] as const)) {
      const history = this.adapterHistory(adapter);
      if (!history) continue;
      for (const [key, entries] of history.cache) {
        history.cache.set(key, entries.map((entry) => {
          if (entry.id !== id) return entry;
          const customName = next[id]?.customName?.trim() || undefined;
          return {
            ...entry,
            customName,
            displayName: customName || entry.rawSummary || next[id]?.autoName || `Untitled (${new Date(entry.updatedAt).toLocaleDateString()})`,
          };
        }));
      }
    }
    const live = [...this.pool].find((session) => session.activeSessionId === id);
    this.postSessionsList();
    // Recompute rather than echoing `trimmed`: an empty rename DROPS the custom
    // name, and the view then has to be told the title it falls back to.
    if (live) this.postSessionName(live);
    // The renamed row's OWN project, not just the selected one. `postSessionsList`
    // refreshes the selected project's list and the rail draws every other
    // project from its `repoSessions` preview — so renaming a conversation in
    // project B while A is selected left B's rows showing the old name, and the
    // cache entry that would have corrected them was just dropped.
    const localCwd = origin === "local" ? requestedCwd : undefined;
    if (localCwd) this.sendLocalRepoSessionsPreview(localCwd);
    this.refreshRemoteRepoPreview(clientId, authorizedCwd);
  }

  /** Re-push one repo's preview after acting on a session inside it. `postSessionsList`
   *  only refreshes the repo the client has SELECTED, so a rename or delete in any
   *  other project would leave the rail showing the old row until something else
   *  happened to refetch it. */
  private refreshRemoteRepoPreview(clientId?: string, cwd?: string): void {
    if (!clientId || !cwd) return;
    // Resolve to the PROJECT, not the session's own directory. A worktree
    // conversation lives in a worktree, which is deliberately not a catalog row
    // — so a preview addressed to it lands under a key no project matches, and
    // the parent project quietly keeps showing the row that was just renamed or
    // deleted. Every caller here passes a session cwd, so the resolution belongs
    // at this seam rather than in each of them.
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const repoCwd = this.repoCatalog().find((r) => pathsEqual(r.cwd, cwd))?.cwd
      ?? this.repoOwningSessionCwd(cwd, overrides);
    if (!repoCwd) return;
    const clientCwd = this.remoteClients.cwdIfPresent(clientId);
    if (!clientCwd || pathsEqual(repoCwd, clientCwd)) return;
    // The rail's expanded cap — matches what its own probe asks for, so a
    // refresh never returns fewer rows than the client already had.
    this.sendRepoSessionsPreview(clientId, repoCwd, 20);
  }

  // No native confirm here: the webview shows its own confirm dialog before
  // posting deleteSession (works in the browser client too, where a host-side
  // modal would stall invisibly).
  /**
   * Is somebody OTHER than the asker looking at this conversation?
   *
   * `this.focused` is the host's own view. On a desk that is a real second
   * surface — a VS Code panel or a desktop window with a person at it — and
   * deleting out from under it is what this protection exists to stop.
   *
   * ON A CLOUD MACHINE THERE IS NOBODY AT THAT SCREEN, EVER. The host still
   * keeps a focused session, so whatever it adopted stayed “owned” for good:
   * the moment the only real user navigated elsewhere they were told to go
   * close it “in another tab or the VS Code view” — naming two surfaces that
   * do not exist there. The owner hit this and said, correctly, that if it
   * were open anywhere he would have been offered the take-it-back button;
   * that affordance is driven by REMOTE ownership, so its absence was the
   * proof that the claimant was this pointer.
   *
   * Remote ownership is unchanged: a second phone or tab still protects a
   * conversation, on cloud exactly as anywhere else.
   */
  private sessionHasLiveOwner(session: Session): boolean {
    const localOwner = session === this.focused && !isCloudEnvironment();
    return localOwner || this.remoteClients.isActiveValueVisible(session);
  }

  private reportProtectedSession(origin: MsgOrigin, clientId: string | undefined, action: "delete" | "clear"): void {
    const text = action === "delete"
      ? "This conversation is open in another tab or the VS Code view. Close it there before deleting it."
      : "Open conversations were kept. Close them in their tabs or the VS Code view before clearing them.";
    if (origin === "remote" && clientId) {
      this.sendRemoteClient(clientId, { type: "error", text });
    } else {
      void this.host.showInformationMessage(text);
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

  /**
   * Explicit session identity on fork/apply/remove. A present id that is not
   * the dispatch-resolved session is refused here, before any await — this
   * codebase has been bitten three times by an identifier captured before an
   * await going stale after it.
   */
  private refuseMismatchedSessionId(
    requestedId: string | undefined,
    session: Session,
    requester: RemoteRequester | undefined,
  ): boolean {
    if (requestedId === undefined || requestedId === session.activeSessionId) return false;
    const text = "That conversation is no longer focused — nothing was changed.";
    if (requester) {
      this.reportRequester(requester, "info", text);
    } else {
      this.postLocal({ type: "hostNotice", level: "info", text });
    }
    return true;
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
    if (level === "error") void this.host.showErrorMessage(text);
    else if (level === "warning") void this.host.showWarningMessage(text);
    else void this.host.showInformationMessage(text);
  }

  private async deleteSession(
    id: string,
    _name: string | undefined,
    origin: MsgOrigin,
    clientId?: string,
    requestedCwd?: string,
  ): Promise<void> {
    const overridesNow = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const target = origin === "remote" && clientId
      ? this.remoteSessionTarget(clientId, id, overridesNow, requestedCwd)
      : undefined;
    if (target?.reason && clientId) {
      this.reportUnauthorizedSessionTarget(clientId, "delete", id, target);
      return;
    }
    const authorizedRemoteCwd = target?.cwd;
    if (this.isSessionLoadReserved(id)) {
      this.host.appendLine(`[sessions] refused delete of reserved session ${id}`);
      this.reportProtectedSession(origin, clientId, "delete");
      return;
    }
    const live = [...this.pool].find((s) => s.activeSessionId === id);
    // Deleting the conversation you are READING is allowed. The guard exists to
    // stop one surface pulling a conversation out from under another, not to
    // protect you from your own delete — and having the same conversation open
    // at the desk AND in the browser is an ordinary way to work, so either side
    // may delete it and every side lands somewhere sensible. What stays refused
    // is deleting a live conversation you are NOT the one looking at.
    const watchers = live ? this.remoteClients.clientsForActiveValue(live) : [];
    const requesterWatches = !!live && (
      origin === "remote" && clientId
        ? watchers.includes(clientId)
        : live === this.focused
    );
    if (live && this.sessionHasLiveOwner(live) && !requesterWatches) {
      // Enough to prove the mechanism from one production line. The bare
      // version of this cost an evening: five identical refusals that said
      // “owned elsewhere” and could not say by whom, while the answer — a
      // local pointer on a machine with no local user — was a field away.
      // No client ids: who is watching is not something the log needs.
      this.host.appendLine(
        `[sessions] refused delete of live session ${id} owned elsewhere`
        + ` (localFocused=${live === this.focused} cloud=${isCloudEnvironment()}`
        + ` remoteOwners=${this.remoteClients.clientsForActiveValue(live).length}`
        + ` requesterWatches=${requesterWatches})`,
      );
      this.reportProtectedSession(origin, clientId, "delete");
      return;
    }
    // Last-resort cwd — and this one deletes files, so it resolves in the
    // ASKER's scope. A delete from VS Code must never fall back to a repo that
    // some remote client happens to have selected.
    //
    // A LOCAL row may name its own project, validated through the catalog. The
    // rail lists other projects' conversations now, and their rows carry a cwd
    // that this chain ignored: rename a cold conversation in project B (which
    // drops its cache entry), then Delete the same row, and it resolved to the
    // SELECTED project instead — deleting nothing under A, reporting nothing
    // wrong, and leaving the conversation in B under its old name. Resolved
    // rather than trusted: an unknown path falls through to the chain below.
    const localNamedCwd =
      origin === "local" && requestedCwd
        ? this.resolveLocalRepoTarget(requestedCwd)?.cwd
          ?? (this.localTrustedSessionCwds(overridesNow).some((c) => pathsEqual(c, requestedCwd))
            ? requestedCwd
            : undefined)
        : undefined;
    const cachedAdapter = [...this.allAdapterCatalogs()].flat().find((entry) => entry.id === id);
    const cwd =
      authorizedRemoteCwd ||
      live?.cwd ||
      overridesNow[id]?.worktreePath ||
      this.sessionCache.get(id)?.entry.cwd ||
      cachedAdapter?.cwd ||
      localNamedCwd ||
      this.historyCwdFor(origin);
    const provider = live?.provider ?? overridesNow[id]?.provider ?? cachedAdapter?.provider ?? "grok";
    // Tear the CLI down BEFORE touching the disk, not after. The live process
    // owns this conversation and re-persists it: delete the directory first and
    // it simply comes back, which is why deleting the open conversation used to
    // be refused outright rather than merely awkward. `disposeSession` ends the
    // turn, drops the client and disposes it, so by the time the files go there
    // is nothing left that could write them again.

    const visibleEntries = this.buildSessionsList(
      cwd,
      { limit: Number.MAX_SAFE_INTEGER },
      undefined,
    ).entries;
    if (isAdapterProvider(provider)) {
      // A FAILED DELETE MUST STILL REMOVE THE ROW.
      //
      // Codex implements delete as one `threadArchive(threadId)` and Claude's
      // removes a session file, and BOTH throw when the thread was never
      // written — which is every conversation nobody has used yet. The host
      // then read the adapter's own words out to the person (“Internal
      // error”) and, far worse, returned before its own cleanup, so a failed
      // delete was how a conversation became permanently un-sendable.
      //
      // Three attempts tried to PREDICT whether a thread existed and skip the
      // provider when it did not — keyed on `hasHistory`, then on a flag set
      // at the prompt call site, then on one set from provider output. Each
      // was wrong in a different direction, because persistence happens
      // inside the provider at a moment the host cannot observe: a suppressed
      // Summarize & Restart turn writes a thread the row calls empty, a
      // prompt that throws may or may not have written, and the user turn
      // persists before any agent output arrives. Skipping wrongly ORPHANS a
      // real thread; calling wrongly is the original bug. There is no signal
      // here that separates them, so this no longer guesses.
      //
      // Ask the provider every time, and treat a refusal as done: for the
      // overwhelmingly common cause — nothing there to delete — that is the
      // truth, and for a genuine provider failure the row returns on the next
      // listing refresh, which is visible and recoverable. Neither outcome
      // loses anything the person wrote. A dead row is worse than both.
      let temporary: AcpClient | undefined;
      const name = providerDisplayName(provider);
      try {
        const cliPath = this.locateProvider(provider);
        const backend = this.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${name} CLI is not available.`);
        // DISPOSING FIRST WAS TRIED HERE AND REVERTED. It looks obviously
        // right — the comment above asks for it and the Grok branch does it —
        // but tearing the live session down before the delete leaves it
        // unbound and still `this.focused` for the seconds a fresh CLI needs
        // to spawn, initialize and delete. In that window: a reconnect
        // re-opens the conversation onto the zombie focus and a second
        // process starts on the same id; or the person opens another
        // conversation and the finishing delete moves them onto a blank
        // session, so their next message goes somewhere they did not choose.
      // Independent review found all three. The defect was the RECOVERY
      // below, which used to return before our own cleanup; it no longer does.
        const client = live?.client ?? (temporary = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.host.appendLine(message),
        }));
        if (temporary) await temporary.start();
        await client.deleteSession(id);
      } catch (error) {
        // Logged, never raised: the usual cause is a thread that was never
        // written, where an error would be a lie about the person's own
        // system. Falling through is the point — the row goes either way.
        this.host.appendLine(
          `[sessions] ${name} could not delete ${id}, removing it locally: ${(error as Error).message}`,
        );
      }
      if (temporary) await temporary.dispose();
      if (live) this.disposeSession(live);
      const history = this.adapterHistory(provider);
      if (history) {
        for (const [key, entries] of history.cache) {
          history.cache.set(key, entries.filter((entry) => entry.id !== id));
        }
      }
    } else {
      // NOT awaited, and that is a deliberate revert rather than an
      // oversight: awaiting widens the same unbound window the adapter
      // branch above was reverted for, by up to the process kill timeout.
      // Worth revisiting only together with the recovery this path lacks.
      if (live) this.disposeSession(live);
      try {
        deleteSessionDir({
          fs: defaultFs,
          grokHome: resolveGrokHome(process.env),
          cwd,
          id,
        });
      } catch (e) {
        this.host.appendLine(`[sessions] delete failed for ${id}: ${(e as Error).message}`);
      }
    }
    // Said once, here, so anything downstream can tell a deleted conversation
    // from a live one without re-deriving it from an id that outlives the
    // directory.
    if (live) live.deleted = true;
    this.sessionCache.delete(id);
    this.removePlanReviews(id); // snapshots live outside grok's session dir
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    await this.removeUploadsForSessions([id], overrides);
    if (overrides[id]) {
      const next = { ...overrides };
      delete next[id];
      void this.state.update(SESSION_META_KEY, next);
    }
    // Re-home only the surfaces that were looking at it. The next row in the
    // list they were looking at is the home; a blank session is minted only
    // when that list is empty. Watchers share that same home. A viewer of a
    // different conversation is not moved.
    const neighbour = neighbourAfterDelete(visibleEntries, id);
    // THE ONLY QUESTION: is the view sitting on something that no longer
    // exists? If so it needs a home; if not, wherever the person is now is
    // where they want to be.
    //
    // Asked after the teardown, never remembered from before it. Four review
    // rounds went at this and every wrong answer was a PROXY — comparing focus
    // to the neighbour, asking whether the open succeeded, trusting a snapshot
    // taken earlier. Each minted a blank conversation over one the person had
    // deliberately opened, in one direction or the other.
    const viewNeedsHome = this.viewIsOnDeleted(id);
    if (viewNeedsHome) {
      if (neighbour) await this.openSession(neighbour.id, neighbour.cwd);
      // Still here means the open declined — another view holds that
      // session's load reservation — so there is nowhere to go but a new one.
      if (this.viewIsOnDeleted(id)) {
        this.focused = this.newLocalSession();
        // Neighbour rows already live in this project. A minted replacement
        // does not — without this it starts in the VS Code workspace folder
        // while history and the rail stay on the project the deleted
        // conversation belonged to. Same rule as newFocusedSession: the local
        // scope IS the selection.
        this.setSessionCwd(this.focused, this.historyCwdFor("local"), this.workspaceRoot());
        this.focused.provider = this.defaultProviderForProject(this.historyCwdFor("local"));
        await this.startSession();
      }
    }
    // Every watcher goes through `openRemoteSession`, the function that
    // enforces one remote per conversation.
    //
    // Attaching them straight to a live neighbour skipped that check, and two
    // browser tabs ended up on one conversation: the deleter's next message
    // went into the tab that was already there, and refreshing then hit the
    // conflicting-owner refusal and left them with nothing. Sharing between
    // the desk and a remote is fine; between two remotes it is not, and this
    // loop is not the place to invent an exception.
    for (const watcher of watchers) {
      this.dropRemoteVoice(watcher);
      if (neighbour) await this.openRemoteSession(watcher, neighbour.id, neighbour.cwd, false);
      // No neighbour, or it would not take them: a blank conversation of their
      // own, which is what v4.1.4 did for every watcher.
      if (!this.remoteClients.active(watcher)) await this.newRemoteSession(watcher, false);
    }
    if (watchers.length) this.postRepoCatalog();
    this.postSessionsList();
    // The rail's per-project rows come from `repoSessions`, which is a separate
    // frame from the selected repo's list that postSessionsList refreshes. Only
    // the remote preview was being refreshed here, so on the desk the deleted
    // conversation stayed on screen until something else happened to redraw it —
    // a row you could click that no longer existed.
    if (cwd) this.sendLocalRepoSessionsPreview(cwd);
    this.refreshRemoteRepoPreview(clientId, authorizedRemoteCwd);
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
    // Any project in the host's own catalog, not just the selected one — the rail
    // offers this per project, and the catalog is the boundary (see
    // remoteRepoScope). A path the host has never discovered still gets nothing.
    const selectedCwd = origin === "remote" && clientId
      ? this.remoteRepoScope(clientId, requestedCwd)
      : requestedCwd;
    if (!selectedCwd) {
      this.host.appendLine("[remote] dropped clearAllSessions (cwd is not a known repository)");
      return;
    }
    const repo = this.localRepoCatalogEntries().find((r) => pathsEqual(r.cwd, selectedCwd));
    if (!repo) return;
    const cwd = repo.cwd;
    const grokHome = resolveGrokHome(process.env);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const repoCwds = this.sessionCwdsForRepo(cwd, overrides);
    // Tear ownerless live processes down BEFORE touching disk. deleteSession
    // already does this: a grok process that still holds the directory makes
    // the Windows delete fail (or the CLI re-persists the shell), and the row
    // comes back as a live-empty "New session". Ownerless parked empties —
    // New session clicks while the previous one was still priming — are the
    // usual leftovers. Live-owned conversations stay protected below.
    const repoCwdKeys = new Set(repoCwds.map(normalizeFsPath));
    const exiting: Promise<void>[] = [];
    for (const s of [...this.pool]) {
      if (this.sessionHasLiveOwner(s)) continue;
      if (!repoCwdKeys.has(normalizeFsPath(this.sessionCwd(s)))) continue;
      exiting.push(this.disposeSession(s));
    }
    // AWAIT the exits. Firing dispose and moving on leaves `clearSessions`
    // racing a Windows taskkill that still holds the directory — the delete
    // then fails, or the CLI re-persists the shell, and the row returns as a
    // live-empty "New session". That is the precise failure this block exists
    // to prevent, so not waiting made it a no-op on the first clear.
    if (exiting.length) await Promise.allSettled(exiting);
    // Adapter history is provider-owned, so make the cache authoritative before
    // a destructive combined-history action. Grok-only installs skip this.
    // A failed refresh must not fall through to the stale cache — that is how
    // "were not cleared" became a delete. Only providers that checked succeed.
    const adapterHistoryChecked = new Set<AcpProvider>();
    for (const provider of this.connectedProviders().filter(isAdapterProvider)) {
      try {
        await this.refreshAdapterHistory(provider, cwd);
        adapterHistoryChecked.add(provider);
      } catch (error) {
        const text = `${providerDisplayName(provider)} history could not be checked, so its conversations were not cleared: ${(error as Error).message}`;
        this.host.appendLine(`[sessions] ${text}`);
        if (origin === "remote" && clientId) this.sendRemoteClient(clientId, { type: "error", text });
        else void this.host.showErrorMessage(text);
      }
    }
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
    const adapterEntries = adapterEntriesEligibleForClear(
      [
        { provider: "codex", entries: this.codexSessionCache.get(projectProviderKey(cwd)) ?? [] },
        { provider: "claude", entries: this.claudeSessionCache.get(projectProviderKey(cwd)) ?? [] },
      ],
      adapterHistoryChecked,
    );
    const allEntries = [...repoEntries, ...adapterEntries];
    const keptForAnotherOwner = allEntries.some(
      (entry) => protectedIds.has(entry.id) && entry.id !== requesterId,
    );
    const clearableCount = allEntries.filter((entry) => !protectedIds.has(entry.id)).length;
    // A notice is a line in the transcript, and a transcript belongs to ONE
    // project — so a remark about a project you are not talking in lands in the
    // wrong conversation. Where the rail is the thing that asked, the refreshed
    // rail is the answer: the project shows itself empty, in its own place.
    const clientCwd = origin === "remote" && clientId ? this.remoteClients.cwd(clientId) : undefined;
    const inThisConversation = origin !== "remote" || (!!clientCwd && pathsEqual(cwd, clientCwd));
    if (clearableCount === 0) {
      if (keptForAnotherOwner) this.reportProtectedSession(origin, clientId, "clear");
      else if (inThisConversation) this.reportRequester(
        origin === "remote" && clientId ? this.captureRemoteRequester(clientId) : undefined,
        "info",
        "No history to clear.",
      );
      // Ownerless live empties may have been disposed above without a catalog
      // row. The rail still has to drop them.
      this.postSessionsList();
      this.sendLocalRepoSessionsPreview(cwd);
      this.refreshRemoteRepoPreview(clientId, cwd);
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
        this.host.appendLine(
          `[sessions] clear-all failed for ${sessionCwd}: ${(e as Error).message}`,
        );
      }
    }
    for (const provider of (["codex", "claude"] as const)) {
      if (!adapterHistoryChecked.has(provider)) continue;
      const history = this.adapterHistory(provider);
      const entries = (history?.cache.get(projectProviderKey(cwd)) ?? [])
        .filter((entry) => !protectedIds.has(entry.id));
      if (!entries.length) continue;
      let client: AcpClient | undefined;
      const name = providerDisplayName(provider);
      try {
        const cliPath = this.locateProvider(provider);
        const backend = this.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${name} CLI is not available.`);
        client = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.host.appendLine(message),
        });
        await client.start();
        for (const entry of entries) {
          try {
            await client.deleteSession(entry.id);
            removedIds.add(entry.id);
          } catch (error) {
            const text = `${name} refused to delete “${entry.displayName}”: ${(error as Error).message}`;
            this.host.appendLine(`[sessions] ${text}`);
            if (origin === "remote" && clientId) this.sendRemoteClient(clientId, { type: "error", text });
            else void this.host.showErrorMessage(text);
          }
        }
      } catch (error) {
        const text = `${name} conversations were not cleared: ${(error as Error).message}`;
        this.host.appendLine(`[sessions] ${text}`);
        if (origin === "remote" && clientId) this.sendRemoteClient(clientId, { type: "error", text });
        else void this.host.showErrorMessage(text);
      } finally {
        if (client) await client.dispose();
      }
    }
    const removed = [...removedIds];

    if (removed.length) {
      const gone = new Set(removed);
      for (const adapter of (["codex", "claude"] as const)) {
        const history = this.adapterHistory(adapter);
        if (!history) continue;
        for (const [key, entries] of history.cache) {
          history.cache.set(key, entries.filter((entry) => !gone.has(entry.id)));
        }
      }
    }

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
      if (changed) await this.state.update(SESSION_META_KEY, next);
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
    // `postSessionsList` only refreshes the project the client has SELECTED, so
    // clearing any other one left the rail showing every row it had just deleted
    // — no confirmation, and a later delete on one of those ghosts failed with a
    // permissions error that was really "this is not there any more".
    this.sendLocalRepoSessionsPreview(cwd);
    this.refreshRemoteRepoPreview(clientId, cwd);
    if (keptForAnotherOwner) this.reportProtectedSession(origin, clientId, "clear");
  }

  private async pickFileFromComputer(): Promise<void> {
    const picked = await this.host.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Add to chat",
    });
    if (!picked || picked.length === 0) return;
    for (const filePath of picked) {
      try {
        await this.addDroppedFile(filePath, false);
      } catch (e) {
        // Per-file: one unreadable pick must not abort the rest of a multi-select.
        this.host.appendLine(`[image] could not attach ${filePath}: ${(e as Error).message}`);
        void this.host.showErrorMessage(`Grok: could not attach ${path.basename(filePath)} — ${(e as Error).message}`);
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
    const cfg = this.host.getConfiguration();
    // findFiles' default excludes are files.exclude ONLY — node_modules lives in
    // search.exclude, so both must be merged in or the index is dependency soup.
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    // Cap is user-tunable (`grok.mentionIndexLimit`) — large monorepos that hit
    // the default 5000 can miss files from `@` autocomplete (#69).
    const limit = clampMentionIndexLimit(
      this.host.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await this.host.findFiles("**/*", exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      // Default asRelativePath prefixes the folder name only in a multi-root
      // workspace — exactly when the prefix is needed to disambiguate. Pass the
      // full Uri so remote schemes match workspace folders (path-only fails).
      const rel = normalizeRelPath(this.host.asRelativePath(uri));
      const abs = uri.fsPath;
      if (!absByRel.has(rel)) absByRel.set(rel, abs);
    }
    return { rels: orderMentionIndex([...absByRel.keys()]), absByRel };
  }

  /** Currently open workspace text tabs as `{rel, abs}` for mention merge.
   *  Non-file schemes and paths outside the workspace are skipped. */
  private openWorkspaceFileEntries(): Array<{ rel: string; abs: string }> {
    return this.host.openWorkspaceTextFiles().map((e) => ({
      rel: normalizeRelPath(e.rel),
      abs: e.abs,
    }));
  }

  /** Resolve the xAI key for Speech-to-Text: the `grok.voiceApiKey` setting,
   *  else `GROK_VOICE_API_KEY` / `XAI_API_KEY` from the workspace .env or the
   *  host environment, else the reusable token the CLI stored at `grok login`
   *  (`~/.grok/auth.json`) — so Voice works out of the box for a signed-in user,
   *  no separate console.x.ai key needed (#51). */
  private resolveVoiceApiKey(cwd: string): string | undefined {
    const setting = this.host.getConfiguration("grok").get<string>("voiceApiKey", "");
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
    const pct = this.host.getConfiguration("grok").get<number>("chatFontScale", 100);
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

  /** Command Palette / Ctrl+F fallback: open in-webview find (#99). `post`
   *  (not emit) so a focus-swap cannot replay it; host-local so a desk
   *  invocation does not pop find on a linked phone. */
  findInSession(): void {
    this.view?.show?.(false);
    this.post({ type: "findInSession" });
  }

  /** grok.showThinking (#26) — whether grok's reasoning traces are shown. Off by
   *  default; hidden traces are replaced by a lightweight "Thinking…" indicator. */
  private showThinking(): boolean {
    return this.host.getConfiguration("grok").get<boolean>("showThinking", false);
  }

  private postShowThinking(): void {
    this.post({ type: "showThinking", value: this.showThinking() });
  }

  /** grok.thumbsFeedback — Settings → General opt-in. Off by default. */
  private thumbsFeedbackEnabled(): boolean {
    return this.host.getConfiguration("grok").get<boolean>("thumbsFeedback", false);
  }

  private postThumbsFeedback(): void {
    this.post({ type: "thumbsFeedback", value: this.thumbsFeedbackEnabled() });
  }

  /** Anonymous, per-install GUID — generated once and kept in shared client state
   *  (so it survives extension updates and identifies this machine across clients).
   *  It's an opaque random id, not tied to any
   *  account or the grok login; it's sent only as an event property so distinct
   *  installs can be counted without identifying anyone. */
  private installId(): string {
    return this.state.getOrCreate(INSTALL_ID_KEY, randomUUID);
  }

  /** Fire the single `session_start` telemetry event for the first real user
   *  message of `session` (callers gate on isFirstSend, so empty sessions
   *  never reach here). Respects VS Code's global telemetry setting + our own
   *  `grok.telemetry.enabled`; fully fire-and-forget. Must not rediscover
   *  providers or resolve credentials — those flags come from the last
   *  providerState / voiceConfigured refresh. */
  private reportSessionStart(session: Session, origin: MsgOrigin): void {
    // Telemetry must NEVER affect the user's turn. Build the event synchronously
    // from already-cached session + settings + the last connection/voice snapshot
    // (so it captures THIS session's mode/model/effort — focus could move during
    // the turn's awaits), then fire it asynchronously off the send path and
    // swallow any error silently. The PROD project always (dev host / local
    // installs included — only the probe script uses DEV).
    try {
      const enabled = shouldSendTelemetry(
        this.host.isTelemetryEnabled,
        this.host.getConfiguration("grok").get<boolean>("telemetry.enabled", true),
        this.context.extensionId === OFFICIAL_EXTENSION_ID,
      );
      if (!enabled) return;
      const cfg = this.host.getConfiguration("grok");
      const appVersion = this.context.extensionVersion;
      const remoteClientId = origin === "remote"
        ? this.remoteClients.clientsForActiveValue(session)[0]
        : undefined;
      const remotePreferences = remoteClientId
        ? this.remoteClients.metadata(remoteClientId)
        : undefined;
      const cwd = this.sessionCwd(session);
      // Read before installId(): getOrCreate would create the id first and make
      // every send look like a returning install. Reuse the value rather than
      // asking twice — PersistedState.get() is a disk-backed read (refreshSync
      // stats the file), so a second call would be a second probe on the send
      // path for an answer we already hold. Only a genuine first run falls
      // through to installId(), and only once ever.
      const existingInstallId = this.state.get<string>(INSTALL_ID_KEY);
      const returningInstall = existingInstallId !== undefined;
      const event = buildSessionStartEvent(
        {
          installId: existingInstallId ?? this.installId(),
          mode: this.displayMode(session),
          model: session.client?.currentModelId || cfg.get<string>("defaultModel", "") || "",
          effort: session.client?.currentReasoningEffort || cfg.get<string>("defaultEffort", "") || "",
          // Feature flags + host kind + connection snapshot. Config/enum values
          // only — the same class of anonymous property as mode/model/effort,
          // never content, paths, or free text. The builder allowlists every key.
          showThinking: cfg.get<boolean>("showThinking", false),
          expandToolDetails: cfg.get<boolean>("expandCommandOutputs", false),
          steerByDefault: cfg.get<boolean>("steerByDefault", false),
          chatFontScale: Math.round(this.chatFontScale() * 100),
          readRepliesAloud: cfg.get<boolean>("readRepliesAloud", false),
          soundNotifications: cfg.get<boolean>("soundNotifications", false),
          remoteFontScale: remotePreferences?.fontScale,
          remoteReadRepliesAloud: remotePreferences?.readRepliesAloud,
          ...sessionStartSurface(origin, remotePreferences?.usesTouch),
          host: this.host.appName || undefined,
          hostKind: sessionStartHostKind(this.host.canSwitchWorkspaceFolder),
          appPurpose: this.appPurpose(),
          voiceConfigured: this.lastVoiceConfiguredByCwd.get(normalizeRepoPath(cwd)),
          voiceStreaming: cfg.get<boolean>("voiceStreaming", true),
          voiceLanguageSet: !!String(this.voiceSetting(cwd, "voiceLanguage", "") || "").trim(),
          grokConnected: this.lastProviderConnected?.grok,
          codexConnected: this.lastProviderConnected?.codex,
          claudeConnected: this.lastProviderConnected?.claude,
          provider: session.provider,
          connectorCount: Object.keys(this.connectedConnectorStore()).length,
          worktree: !!session.worktree,
          returningInstall: returningInstall,
        },
        {
          appVersion,
          osName: osNameFromPlatform(process.platform),
          osVersion: os.release(),
          locale: this.host.language || "",
          isDebug: !this.context.isProduction,
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

  private rememberVoiceConfigured(cwd: string, value: boolean): void {
    this.lastVoiceConfiguredByCwd.set(normalizeRepoPath(cwd), value);
  }

  private voiceConfiguredMsg(cwd: string, value: boolean): Extract<HostMsg, { type: "voiceConfigured" }> {
    return {
      type: "voiceConfigured",
      value,
      sendPhrase: this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE),
      keyterms: sanitizeVoiceKeyterms(this.voiceSetting(cwd, "voiceKeyterms", [])),
    };
  }

  /** Record that this destination already has `payload`. Watcher posts skip a match. */
  private seedPostedVoiceConfigured(
    destKey: string,
    payload: Extract<HostMsg, { type: "voiceConfigured" }>,
  ): void {
    this.lastPostedVoiceConfigured.set(destKey, voiceConfiguredFingerprint(payload));
  }

  /** A replaced renderer is a new destination — drop the old view's cache entry. */
  private forgetPostedVoiceConfigured(destKey: string): void {
    this.lastPostedVoiceConfigured?.delete(destKey);
  }

  /**
   * Post `voiceConfigured` unless this destination already received an identical
   * frame. Returns whether a frame went out.
   */
  private deliverVoiceConfigured(
    destKey: string,
    payload: Extract<HostMsg, { type: "voiceConfigured" }>,
    send: () => void,
  ): boolean {
    const fp = voiceConfiguredFingerprint(payload);
    if (this.lastPostedVoiceConfigured.get(destKey) === fp) return false;
    this.seedPostedVoiceConfigured(destKey, payload);
    send();
    return true;
  }

  private postVoiceConfigured(): void {
    const cwd = this.sessionCwd(this.focused);
    const configured = !!this.resolveVoiceApiKey(cwd);
    const localMsg = this.voiceConfiguredMsg(cwd, configured);
    // Refresh = rebuild: only the cwds this pass actually resolved stay in the
    // map. Point-writes between refreshes (voice-start failure paths) are
    // fresh by definition; accumulation is what made stale `true` immortal.
    this.lastVoiceConfiguredByCwd.clear();
    this.rememberVoiceConfigured(cwd, configured);
    this.deliverVoiceConfigured("local", localMsg, () => this.postLocal(localMsg));
    for (const clientId of this.remoteClients.clients()) {
      // Scope = the project whose config we resolved. Classification is "scope"
      // so a closed/re-homed tab cannot receive the prior project's prefs.
      //
      // This refresh is a host-wide watcher/config event, not a request from
      // this tab. A connected client can still have no project (desktop
      // empty-workspace ready() stores ""). The strict cwd accessor throws
      // for that state and would take down the desktop main process. Skip —
      // the next snapshot carries voiceConfigured.
      const active = this.remoteClients.active(clientId);
      const remoteCwd = active
        ? this.sessionCwd(active)
        : this.remoteClients.cwdIfPresent(clientId);
      if (!remoteCwd) continue;
      const remoteConfigured = !!this.resolveVoiceApiKey(remoteCwd);
      this.rememberVoiceConfigured(remoteCwd, remoteConfigured);
      const remoteMsg = this.voiceConfiguredMsg(remoteCwd, remoteConfigured);
      this.deliverVoiceConfigured(`remote:${clientId}`, remoteMsg, () => {
        this.sendRemoteClient(clientId, remoteMsg, remoteCwd);
      });
    }
  }

  private voiceSetting<T>(cwd: string, key: string, fallback: T): T {
    const cfg = this.host.getConfiguration("grok", cwd);
    return voiceSettingForRepo(
      cfg.get<T>(key),
      cfg.inspect<T>(key),
      this.host.isInWorkspace(cwd),
      fallback,
    );
  }

  private async mentionFileIndexForCwd(cwd: string): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    if (pathsEqual(cwd, this.workspaceRoot())) return this.mentionFileIndex();
    const key = normalizeRepoPath(cwd);
    const cached = this.remoteMentionIndexes.get(key);
    if (cached && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached;
    const cfg = this.host.getConfiguration();
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    const limit = clampMentionIndexLimit(
      this.host.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await this.host.findFiles({ base: cwd, pattern: "**/*" }, exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      const abs = uri.fsPath;
      const rel = normalizeRelPath(path.relative(cwd, abs));
      if (rel && !absByRel.has(rel)) absByRel.set(rel, abs);
    }
    const value = { at: Date.now(), rels: orderMentionIndex([...absByRel.keys()]), absByRel };
    this.remoteMentionIndexes.set(key, value);
    return value;
  }

  /** Show actionable guidance for setting up the voice API key. */
  private async promptVoiceKeySetup(): Promise<void> {
    if (!this.connectedProviders().includes("grok")) {
      const pick = await this.host.showInformationMessage(
        "Voice needs Grok connected. It uses the same xAI account for speech-to-text.",
        "Connect Grok",
      );
      if (pick === "Connect Grok") {
        if (this.host.canOpenSettingsEditor) await this.openSettingsEditor("providers");
      }
      return;
    }
    const pick = await this.host.showErrorMessage(
      "Voice control needs an xAI Speech-to-Text key. Sign in with `grok login` and it reuses that token automatically — or set grok.voiceApiKey, or GROK_VOICE_API_KEY / XAI_API_KEY in your workspace .env for a dedicated console.x.ai key.",
      "Open Settings",
      "Get a Key",
    );
    if (pick === "Open Settings") {
      await this.host.openSettings("grok.voiceApiKey");
    } else if (pick === "Get a Key") {
      await this.host.openExternal("https://console.x.ai");
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
      void this.host.showWarningMessage(message);
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

  /**
   * Say what is actually wrong, and offer the action that fixes it.
   *
   * The old dialog offered only "Open Settings", which is a dead end when
   * ffmpeg is not installed — it sends you to a text field to name a file that
   * does not exist. Every new macOS user who clicked the mic before installing
   * ffmpeg met that.
   *
   * The install is offered but never run: pre-fill a terminal and let the user
   * press Enter. Installing software on someone's machine is their decision,
   * and when it fails the output is in front of them instead of swallowed.
   */
  private async reportFfmpegProblem(problem: Extract<FfmpegResolution, { ok: false }>): Promise<void> {
    const hasBrew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].some(
      (p) => statKindSafe(p) === "file",
    );
    const hint =
      problem.reason === "not-installed" ? ffmpegInstallHint(process.platform, hasBrew) : undefined;
    const message = describeFfmpegProblem(problem, hint);
    this.host.appendLine(`[voice] ${message}`);

    // Only offered where the package manager installs into a directory already
    // on PATH, so the running editor sees it without a restart. See
    // ffmpegInstallHint.
    const actions = hint?.offerToRun ? ["Install ffmpeg", "Open Settings"] : ["Open Settings"];
    const pick = await this.host.showErrorMessage(message, ...actions);

    if (pick === "Install ffmpeg" && hint) {
      const term = this.host.createTerminal("Install ffmpeg");
      term.sendText(hint.command, false); // false = do NOT press Enter for them
      term.show();
      return;
    }
    if (pick === "Open Settings") await this.host.openSettings("grok.ffmpegPath");
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
    const cfg = this.host.getConfiguration("grok");
    // Resolve before spawning. A stripped GUI PATH, a Cellar directory pasted
    // out of `brew info`, and "not installed at all" are three problems with
    // three different fixes, and the ENOENT/EACCES from spawn cannot tell them
    // apart — so the old code reported all of them as "ffmpeg was not found"
    // and offered Open Settings, which helps with none of them.
    const resolvedFfmpeg = resolveConfiguredFfmpeg(cfg.get<string>("ffmpegPath", ""), {
      platform: process.platform,
      pathEnv: process.env.PATH,
      isFile: (p) => statKindSafe(p) === "file",
      isDirectory: (p) => statKindSafe(p) === "dir",
    });
    if (!resolvedFfmpeg.ok) {
      void this.reportFfmpegProblem(resolvedFfmpeg);
      this.releaseVoice(cwd);
      this.localVoiceCredentialCwd = undefined;
      this.postLocal({ type: "voiceError" });
      return;
    }
    const ffmpegPath = resolvedFfmpeg.path;
    const device = cfg.get<string>("voiceInputDevice", "") || undefined;

    // Streaming (default): live transcription over the STT WebSocket, so "grok
    // send" can submit hands-free without a stop-click. Batch is the fallback.
    if (cfg.get<boolean>("voiceStreaming", true)) {
      await this.startVoiceStream(key, ffmpegPath, device, cwd, generation);
      return;
    }

    const tmp = path.join(os.tmpdir(), `grok-voice-${Date.now()}.wav`);
    try {
      await this.voiceRecorder.start({ ffmpegPath, outputPath: tmp, device, log: (m) => this.host.appendLine(m) });
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
      this.host.appendLine(`[voice] start failed: ${msg}`);
      // ffmpeg-missing is the common, fixable case — offer a jump to its setting.
      if (/ffmpeg/i.test(msg)) {
        const pick = await this.host.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await this.host.openSettings("grok.ffmpegPath");
        }
      } else {
        this.host.showErrorMessage(msg);
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
      try { resolved = await resolveWindowsAudioDevice(ffmpegPath, (m) => this.host.appendLine(m)); } catch { /* streamer surfaces it */ }
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
      this.host.appendLine(`[voice] stream error: ${e.message}`);
      if (!this.voiceFinalizing) {
        if (/\b(401|403)\b|rejected/i.test(e.message)) {
          void this.host.showErrorMessage(e.message, "Open Settings").then((pick) => {
            if (pick === "Open Settings") void this.host.openSettings("grok.voiceApiKey");
          });
        } else {
          this.host.showErrorMessage(`Voice transcription failed: ${e.message}`);
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
        log: (m) => this.host.appendLine(m),
      });
      if (!isCurrent()) { streamer.cancel(); return; }
      this.postLocal({ type: "voiceState", status: "listening" });
    } catch (e) {
      if (!isCurrent()) return;
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
      const msg = (e as Error).message;
      this.host.appendLine(`[voice] stream start failed: ${msg}`);
      if (/ffmpeg/i.test(msg)) {
        const pick = await this.host.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await this.host.openSettings("grok.ffmpegPath");
        }
      } else if (/\b(401|403)\b|rejected/i.test(msg)) {
        // Auth handshake rejection — msg is already the source-aware guidance
        // (re-login or set a dedicated key); offer the settings shortcut.
        const pick = await this.host.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await this.host.openSettings("grok.voiceApiKey");
        }
      } else {
        this.host.showErrorMessage(msg);
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
      this.host.appendLine(`[voice] stop failed: ${(e as Error).message}`);
      this.host.showErrorMessage(`Voice recording failed: ${(e as Error).message}`);
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.postLocal({ type: "voiceError" });
      return;
    }
    const tempPath = this.voiceTempPath;
    this.postLocal({ type: "voiceState", status: "transcribing" });
    try {
      const raw = await transcribeAudio(wavPath, key, (m) => this.host.appendLine(m));
      if (generation !== this.voiceGeneration) return;
      // Strip a trailing "grok send" (configurable) so dictation can submit
      // hands-free. The webview inserts `text` and, if `send`, fires the send.
      const sendPhrase = this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
      const { text, send } = parseVoiceCommand(raw, sendPhrase);
      if (!text && !send) {
        this.host.showInformationMessage("Voice control: nothing was transcribed (silence?).");
        this.postLocal({ type: "voiceError" });
        return;
      }
      this.postLocal({ type: "voiceTranscript", text, send });
    } catch (e) {
      if (generation !== this.voiceGeneration) return;
      this.host.appendLine(`[voice] transcription failed: ${(e as Error).message}`);
      this.host.showErrorMessage((e as Error).message);
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
      this.sendRemoteClient(
        clientId,
        { type: "voicePartial", text: ev.text },
        entry.credentialCwd,
      );
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
      this.host.appendLine(`[remote-voice] stream error: ${e.message}`);
      this.failRemoteVoice(clientId, e.message);
    });
    await streamer.start({
      apiKey: key,
      keyterms: entry.keyterms,
      language: entry.language,
      log: (m) => this.host.appendLine(`[remote] ${m}`),
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
      this.rememberVoiceConfigured(credentialCwd, false);
      const payload = this.voiceConfiguredMsg(credentialCwd, false);
      this.deliverVoiceConfigured(`remote:${clientId}`, payload, () => {
        this.sendRemoteClient(clientId, payload, credentialCwd);
      });
      this.sendRemoteClient(clientId, { type: "voiceError" });
      this.sendRemoteClient(clientId, {
        type: "error",
        text: this.connectedProviders().includes("grok")
          ? "Voice control needs an xAI Speech-to-Text key on the host."
          : "Voice needs Grok connected. It uses the same xAI account for speech-to-text.",
      });
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
    this.sendRemoteClient(
      clientId,
      { type: "voiceSubmit", text: text.trim() },
      entry.credentialCwd,
    );
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
      this.sendRemoteClient(
        clientId,
        { type: "voiceSubmit", text: text.trim() },
        entry.credentialCwd,
      );
      this.sendRemoteClient(clientId, { type: "voiceState", status: "idle" });
    } else {
      this.sendRemoteClient(
        clientId,
        { type: "voiceTranscript", text, send: false },
        entry.credentialCwd,
      );
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
    const left = Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/before/${base}` });
    const right = Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/after/${base}` });
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
    await this.host.openDiff(left, right, `Grok proposed: ${base}`, {
      preview: true,
      preserveFocus: true,
      selection: {
        start: { line: at, character: 0 },
        end: { line: at, character: 0 },
      },
    });
  }

  /**
   * The file's current content, for whole-file diff expansion (#66). Undefined
   * when it can't be read — a create whose file doesn't exist yet, a file
   * deleted since, or one too big to hold twice — which leaves the diff at the
   * region-only fallback rather than failing the open.
   */
  private readFileForDiff(filePath: string): string | undefined {
    try {
      const session = this.focused;
      let abs = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.sessionCwd(session), filePath);
      // Desktop: revalidate containment + executable policy immediately before
      // the read (same TOCTOU class as openFsPath / file-tree open). Use only
      // the path returned by that check — never the pre-authorize string.
      // VS Code keeps the plain read (v3.1.0 behaviour).
      if (this.host.canSwitchWorkspaceFolder) {
        const check = revalidateOpenFileForUse(abs, {
          allowedRoots: this.desktopAuthRoots(session),
        });
        if (!check.ok) return undefined;
        abs = check.absPath;
      }
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

  private closeDiffUris(uris: { left: Uri; right: Uri }): void {
    this.host.closeDiffTabs(uris.left, uris.right);
    this.diffProvider.delete(uris.left, uris.right);
  }

  private async postExitPlanRequest(req: ExitPlanRequest, session: Session, gen: number): Promise<void> {
    const plan = req.plan || session.lastPlanText;
    let snapshot: { path: string; name: string } | undefined;
    try {
      snapshot = await this.createPlanReviewSnapshot(
        plan,
        session.activeSessionId ?? session.client?.sessionId,
      );
    } catch (e) {
      this.host.appendLine(`[plan-review] ${(e as Error).message}`);
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
        this.host.appendLine(`[plan-review] ${(e as Error).message}`);
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
    // Keep globalStorageUri identity so remote storage stays on the remote fs.
    const dir = Uri.joinPath(
      this.context.globalStorageUri,
      "plan-reviews",
      planReviewSessionDirectoryName(sessionId),
    );
    void this.host.fs.delete(dir, { recursive: true, useTrash: false }).then(
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
    session.liveFeedbackEligible = false;
    session.turnRating = 0;
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
      this.pendingConfirms.set(id, { session, resolve });
      this.emit(session, { type: "uiConfirmRequest", id, ...opts });
    });
  }

  private async createPlanReviewSnapshot(plan: string, sessionId?: string): Promise<{ path: string; name: string }> {
    const content = plan && plan.trim() ? plan : "(empty plan)\n";
    const sessionPart = planReviewSessionDirectoryName(
      sessionId ?? this.focused.activeSessionId ?? this.focused.client?.sessionId ?? "session",
    );
    // Join under globalStorageUri so workspace.fs targets the same scheme VS Code
    // gave us (vscode-remote on remote hosts — never rebuild with Uri.file).
    const dir = Uri.joinPath(this.context.globalStorageUri, "plan-reviews", sessionPart);
    await this.host.fs.createDirectory(dir);
    // Content-addressed, so re-snapshotting the same plan on every restore
    // reuses one file instead of writing a new one forever.
    const fileUri = Uri.joinPath(dir, planReviewFileName(content));
    let existing: string | undefined;
    try {
      existing = Buffer.from(await this.host.fs.readFile(fileUri)).toString("utf8");
    } catch { /* first time for this plan */ }
    if (existing !== content) {
      // Different content under the same name means a hash collision — fall back
      // to a unique name rather than overwriting someone else's plan.
      const target = existing === undefined ? fileUri : await this.uniquePlanReviewUri(dir, planReviewFileName(content));
      await this.host.fs.writeFile(target, Buffer.from(content, "utf8"));
      return { path: target.fsPath, name: path.basename(target.fsPath) };
    }
    return { path: fileUri.fsPath, name: path.basename(fileUri.fsPath) };
  }

  private async uniquePlanReviewUri(dir: Uri, fileName: string): Promise<Uri> {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    for (let i = 0; i < 100; i += 1) {
      const suffix = i === 0 ? "" : `-${i + 1}`;
      const candidate = Uri.joinPath(dir, `${stem}${suffix}${ext}`);
      try {
        await this.host.fs.stat(candidate);
      } catch {
        return candidate;
      }
    }
    return Uri.joinPath(dir, `${stem}-${Date.now()}${ext}`);
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
    // Node-fs staging path — genuine local disk on the extension host (v3.1.0
    // also used globalStorageUri.fsPath here; not a workspace.fs address).
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
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
      this.host.appendLine(`[upload] rejected ${suppliedName}: ${detail}`);
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
      this.host.appendLine(`[upload] staging failed for ${prepared.name}: ${(e as Error).message}`);
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
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[sid] ?? {};
    const files = [...new Set([...(cur.uploadedFiles ?? []), ...uploaded])];
    await this.state.update(SESSION_META_KEY, {
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
        this.host.appendLine(`[upload] could not remove staged document directory: ${(e as Error).message}`);
      }
    }
  }

  /** Write image bytes into staging and attach the chip. The `[Image #N]`
   *  index is stamped once here (`allocateImageIndex`) and is never rewritten. */
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
    const allocated = allocateImageIndex(session.imageIndexHighWater, [
      ...session.chips,
      ...session.queuedSends.flatMap((item) => item.chips),
    ]);
    session.imageIndexHighWater = allocated.highWater;
    session.chips.push(makeImageChip(absPath, allocated.index, mimeType, originRelPath, previewId));
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
      this.host.appendLine(`[image] paste failed: ${(e as Error).message}`);
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
        this.host.appendLine(`[image] import failed for ${absPath}: ${(e as Error).message}`);
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
  /** Whether a prompt is genuinely running. This used to read `status`, which
   *  cannot tell "working" from "was working and never settled" — see
   *  Session.turnToken for the wedge that cost. */
  private turnInFlight(session: Session): boolean {
    return turnIsInFlight(session);
  }

  /** A cancel is a request, not an outcome: `client.prompt()` settling is the ONLY
   *  thing that ends a turn, so a cancel the CLI never answers leaves the session
   *  pinned mid-turn and every later send diverted into the queue — permanently,
   *  with nothing on disk to show for it.
   *
   *  Recovery RESTARTS the process rather than declaring the turn over locally.
   *  Declaring it over is not enough and is worse than doing nothing: the client
   *  is still live and its handlers are fenced only by `gen`, so a cancel that
   *  eventually produces chunks, a permission request or a completion would pour
   *  them into whatever turn is current by then — and flushing the queue would
   *  put a second prompt on a client that may still be running the first.
   *  `startSession` is the fence this codebase already has: it bumps `gen` (so
   *  every event from the old client is ignored), disposes it, clears the turn
   *  token, and resumes this same conversation from disk so nothing is lost.
   *
   *  A CLI that has ignored a stop request for ten seconds is wedged; replacing
   *  the process is the honest reading of what the user asked for. */
  private armCancelRecovery(session: Session, token: object): void {
    const gen = session.gen;
    setTimeout(() => {
      if (gen !== session.gen) return; // already restarted or replaced
      if (session.turnToken !== token) return; // the cancel was honoured
      void this.recoverUnansweredCancel(session, token);
    }, CANCEL_SETTLE_GRACE_MS);
  }

  private async recoverUnansweredCancel(session: Session, token: object): Promise<void> {
    // Nothing to recover if the client is already gone — something else tore it
    // down (a crash, a removed worktree), and respawning here would resurrect a
    // session that was deliberately ended, possibly against a cwd that no longer
    // exists. Belt to the generation check: whoever disposes a client is
    // expected to invalidate the turn, and this survives one that forgets.
    if (!session.client) {
      endTurn(session, token);
      return;
    }
    this.host.appendLine("[turn] cancel went unanswered; restarting this session's CLI");
    // Said BEFORE the restart, deliberately. startSession unlocks the composer
    // and flushes any queued sends itself, so a notice emitted afterwards could
    // land behind that queued turn's userMessage/agentStart — reading as if the
    // new turn had failed, and clearing the busy state of a turn that had only
    // just begun. Live-only as a consequence (the restart clears the buffer);
    // the conversation itself is reloaded from disk intact.
    session.staleSendReported = true;
    this.emit(session, {
      type: "agentError",
      text: "Stopped. The agent didn't answer the stop request, so its process is being restarted. This conversation is intact.",
    });
    const client = await this.startSession(session.activeSessionId, session);
    // Another restart can overtake this one while it is starting. Then the
    // session belongs to that one, and nothing here has anything to say about
    // it — least of all an error.
    if (session.client && session.client !== client) return;
    if (!session.client) {
      // startSession clears the token on its way through, but it can fail before
      // reaching that; either way this session must not be left pinned mid-turn.
      endTurn(session, token);
      this.emit(session, {
        type: "agentError",
        text: "The agent's process couldn't be restarted. Send again to start it.",
      });
      this.setStatus(session, "error");
    }
    // A successful restart has already cleared the token, unlocked the composer
    // and flushed anything queued. There is nothing left to do here.
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
  private divertRacingSend(
    session: Session,
    text: string,
    bare: boolean,
    chips: FileChip[] = explicitVisibleChips(session.chips),
  ): void {
    if (bare) {
      this.emit(session, {
        type: "error",
        text: "Grok is mid-turn — that command was not run. Try again when the turn finishes.",
      });
      return;
    }
    if (!text.trim() && !chips.length) return;
    session.queuedSendDispatch = undefined;
    session.queuedSends = enqueueQueuedSend(session.queuedSends, text, chips);
    if (chips.length) {
      session.chips = consumeChips(session.chips, chips);
      if (session === this.focused) this.refreshImplicitChip(true);
      else this.postChips(session);
    }
    this.emitQueuedSends(session);
    void this.maybeFlushQueuedSends(session);
  }

  private async handleSend(
    text: string,
    bare = false,
    target?: Session,
    origin: MsgOrigin = "local",
    queuedSendCommit?: { text: string; items: QueuedSendEntry[] },
    submissionId?: string,
  ): Promise<void> {
    // `target` lets a queued-send flush fire into a BACKGROUNDED session (its
    // turn ended while another was focused). Only the focused session may spawn
    // a client on demand; a background target without one has nothing to talk to.
    const session = target ?? this.focused;
    await this.waitForSessionStart(session);
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
    // Priming is latched before a client exists (sign-out replacements start
    // sequentially). A phone send in that gap used to call ensureClient and
    // race the planned replace. Queue whenever startup already owns this
    // session — not only when a client is sitting without a session id.
    if (session.priming || (session.client && !sessionReadyForPrompt(session))) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare);
      return;
    }
    const client = session.client ?? await this.ensureClient(session);
    if (!client) return;
    // ensureClient may return mid-startSession; re-check before committing work.
    if (!sessionReadyForPrompt(session)) {
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare);
      return;
    }
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

    // Snapshot attachments. A live send reads the composer's chips; a queued
    // flush uses the per-item copies snapshotted at queue time so a later
    // composer remove cannot silently drop them. `bare` sends (gear-menu
    // /compact) carry none. `[Image #N]` is the attach-time index on those
    // chips — send does not renumber.
    const queuedItems = !bare && queuedSendCommit?.items.length
      ? queuedSendCommit.items.map((item) => ({ text: item.text, chips: item.chips ?? [] }))
      : undefined;
    const implicitChips = session.chips.filter((chip) => isImplicitChip(chip));
    let chips: FileChip[] = [];
    let contributions: QueuedPromptContribution[] | undefined;
    if (bare) {
      chips = [];
    } else if (queuedItems) {
      contributions = [];
      const queuedChips: FileChip[] = [];
      for (const item of queuedItems) {
        const itemImages: PromptImageInput[] = [];
        for (const chip of item.chips) {
          if (chip.hidden || !isImageChip(chip)) continue;
          const read = await this.readImageChip(chip, session, gen);
          if (read === "gone") return;
          if (read === "failed") return;
          itemImages.push(read);
        }
        contributions.push({ text: item.text, chips: item.chips, images: itemImages });
        queuedChips.push(...item.chips);
      }
      chips = [...queuedChips, ...implicitChips];
    } else {
      chips = [...session.chips];
    }

    // Pre-read every visible image BEFORE anything is cleared or sent. Any
    // failure blocks the whole send with the chips intact — never a prompt
    // whose [Image #N] tag has no image block behind it (a dangling tag sends
    // grok hunting the workspace for an image it was never given).
    const images: PromptImageInput[] = contributions
      ? contributions.flatMap((contribution) => contribution.images)
      : [];
    if (!contributions) {
      for (const chip of chips) {
        if (chip.hidden || !isImageChip(chip)) continue;
        const read = await this.readImageChip(chip, session, gen);
        if (read === "gone") return;
        if (read === "failed") return;
        images.push(read);
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
    const promptDeps = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      extName: (p: string) => path.extname(p),
    };
    const { blocks: promptBlocks } = contributions
      ? buildQueuedPromptWithImages(contributions, implicitChips, promptDeps, slashCommand != null)
      : buildPromptWithImages(text, chips, images, promptDeps, slashCommand != null);

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
      if (!queuedSendCommit) this.divertRacingSend(session, text, bare, explicitVisibleChips(chips));
      return;
    }

    if (queuedSendCommit) {
      if (!finishQueuedSendCommit(session, queuedSendCommit, true)) return;
      this.emitQueuedSends(session);
      if (session === this.focused) this.refreshImplicitChip(true);
      else this.postChips(session);
    }

    if (bare) {
      this.postChips(session);
    } else if (!queuedSendCommit) {
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
      void this.rememberProjectProvider(
        this.sessionCwd(session),
        session.provider,
        session.client?.currentModelId,
      );
      if (session.client?.sessionId) {
        this.emit(session, {
          type: "session",
          sessionId: session.client.sessionId,
          models: this.modelsForSession(session, session.client.availableModels, session.client.currentModelId, false),
          currentModelId: session.client.currentModelId,
          worktree: !!session.worktree,
          provider: session.provider,
        });
      }
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
    // The token, not the status, is what says a turn is running from here on —
    // and only whoever holds it may end this one.
    const turn = beginTurn(session);
    this.setStatus(session, "working");
    // The send IS the activity — the rail should not wait ~2s for the CLI to
    // write a transcript before admitting you are working in this conversation.
    this.noteSessionActivity(session);

    try {
      session.adapterCompactThisTurn = false;
      session.compactUsageArmed = false;
      session.adapterTurnCallUsed = [];
      // Arm the compact-notification watch BEFORE the prompt: the live
      // auto_compact_completed / auto_compact_failed land DURING this turn.
      if (slashCommand === "compact") {
        session.sawCompactFailed = false;
        session.sawCompactNotification = false;
        if (isAdapterProvider(session.provider)) {
          session.adapterCompactThisTurn = true;
          this.rememberAdapterContext(session, { compacted: true });
        }
      }
      const meta = await client.prompt(promptBlocks);
      if (gen !== session.gen) {
        this.emitAbandonedSend(session);
        return;
      }
      // A cancel recovery may have settled this turn already; a second agentEnd
      // would end a turn that is no longer ours.
      if (!endTurn(session, turn)) return;
      if (slashCommand === "compact") {
        // A native /compact streams no agent content (research/compact.md), so
        // the turn would end with a blank bubble and no sign it worked. Paint a
        // live-only confirmation into that empty bubble — UNLESS compaction failed
        // (auto_compact_failed set sawCompactFailed), in which case the failure
        // note already showed and a "Compacted." would contradict it. Deliberately
        // not persisted: grok's own history has no such message, so re-focus keeps
        // it but a disk restore won't.
        if (!session.sawCompactFailed) this.emit(session, { type: "messageChunk", text: "Compacted." });
        // The live compact rail is exact and wins. Older Grok CLIs fall through
        // to the control-plane meter; only an explicit -32601 may use the hidden
        // legacy prompt fallback.
        if (session.provider === "grok" && !session.sawCompactNotification) {
          await this.refreshContextAfterCompact(client, session, gen);
          if (gen !== session.gen) return;
        }
      }
      // Nor does it get to say the turn ENDED. Browsers treat agentEnd as
      // authoritative and clear busy on it, so a stale compact handler
      // resuming after a newer turn started would leave every remote tab
      // showing that turn as idle, with no Stop control — and a refresh does
      // not repair it, because the snapshot replays the same order. The newer
      // turn emits its own end when it really ends. (The other agentEnd site
      // needs no guard: nothing awaits between its endTurn check and its
      // emit.)
      if (!turnIsInFlight(session)) this.emit(session, { type: "agentEnd", meta });
      this.noteLiveTurnEnded(session);
      // "done" only if this is still the LAST word. /compact releases its turn
      // token before awaiting the context refresh, so a send from another tab
      // can start a turn while this handler is suspended — and marking the
      // session done then tells every view the agent is idle while it is not.
      // On a cloud machine it also stops the heartbeat, which reads the status:
      // a quiet long-running tool in the newer turn is then frozen ninety
      // seconds later.
      if (!turnIsInFlight(session)) this.setStatus(session, "done");
      // Again at the end: by now the transcript really has moved, so this is
      // the push that makes the row's position true rather than asserted.
      this.noteSessionActivity(session);
      session.authRecoveryTried = false; // a clean turn re-arms token auto-recovery
      this.maybeGenerateTitle(session);
      this.postSessionName(session);
    } catch (err) {
      if (gen !== session.gen) {
        this.emitAbandonedSend(session);
        return;
      }
      // Same rule as the success path: if a cancel recovery already ended this
      // turn, the failure it eventually reported is not ours to announce.
      // Checked BEFORE the auth resend, which starts a turn of its own.
      if (!endTurn(session, turn)) return;
      const e = err as any;
      // A rate/usage-limit failure (ACP -32003, or limit phrasing) is not a
      // credential problem: skip the auth recovery — its retry would end on
      // the login screen, which can't fix a limit — and show a clear limit
      // notice instead (#57).
      if (isRateLimitError(e)) {
        this.emit(session, { type: "agentError", text: rateLimitNoticeText(e) });
        this.noteLiveTurnEnded(session);
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
      // A prompt failure reached the transcript and NOTHING reached the log:
      // the owner sent two messages to a Codex session, saw a bare “Internal
      // error” twice, and the host had no record either happened. An error we
      // show a person and cannot ourselves account for is the shape that costs
      // an evening — the rail's version verdict was the same mistake.
      //
      // The session id is what makes it diagnosable: it says whether the
      // prompt went to the session the person is looking at.
      this.host.appendLine(
        `[${session.provider}] prompt failed for session ${session.client?.sessionId ?? session.activeSessionId ?? "none"}`
        + `: ${errorDetail(e)}`,
      );
      this.emit(session, { type: "agentError", text: promptErrorText(e) });
      this.noteLiveTurnEnded(session);
      this.setStatus(session, "error");
    } finally {
      // Belt to the braces above: however this turn left — an early return on a
      // switched session, a throw nobody caught — it must not stay in flight, or
      // every later send in this session is diverted into the queue. A no-op
      // when the turn was already settled, or when the auth resend has since
      // started one of its own.
      endTurn(session, turn);
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
    if (!isAuthErrorText(errorText) && !session.client?.isCredentialError(err) && !isCredentialError(err)) return false;
    const resumeId = beginAuthRecovery(session);
    if (!resumeId) return false;
    this.host.appendLine(`[auth] recoverable token error — reloading session + resending: ${errorText}`);

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
    // The resend is a turn in its own right — it gets its own token, and the
    // outer turn's `finally` can no longer end it (the tokens differ).
    const turn = beginTurn(session);
    this.setStatus(session, "working");
    session.adapterTurnCallUsed = [];
    try {
      const meta = await client.prompt(promptBlocks);
      if (gen !== session.gen) {
        this.emitAbandonedSend(session);
        return true;
      }
      if (!endTurn(session, turn)) return true;
      this.emit(session, { type: "agentEnd", meta });
      this.noteLiveTurnEnded(session);
      this.setStatus(session, "done");
      session.authRecoveryTried = false; // recovered — re-arm for a future expiry
      this.maybeGenerateTitle(session);
      this.postSessionName(session);
    } catch (err2) {
      if (gen !== session.gen) {
        this.emitAbandonedSend(session);
        return true;
      }
      if (!endTurn(session, turn)) return true;
      const e2 = err2 as any;
      // The resend ran into a usage limit — that's the real story, not auth
      // (#57): a fresh process with a fresh token hit the same wall.
      if (isRateLimitError(e2)) {
        this.emit(session, { type: "agentError", text: rateLimitNoticeText(e2) });
        this.noteLiveTurnEnded(session);
        this.setStatus(session, "error");
        return true;
      }
      if (client.isCredentialError(e2) || isCredentialError(e2)) {
        // A fresh process still can't authenticate → auth.json genuinely dead →
        // the honest ask is a re-login. The agentError FIRST: its webview
        // handler is what clears the busy/"Grokking" indicator and leaves a
        // truthful transcript (the overlay alone froze both — #58). The overlay
        // itself is post()ed, not emit()ed: live-only, so it can't resurrect
        // from the replay buffer on a later focus switch after the user has
        // already re-authed.
        this.emit(session, { type: "agentError", text: errorDetail(e2) });
        this.noteLiveTurnEnded(session);
        this.setStatus(session, "error");
        this.post({ type: "onboarding", state: this.onboardingForSession(session) });
      } else {
        // Entitlement/billing wording (or anything else) on a fresh process is
        // not a sign-in problem — promptErrorText shows the entitlement notice
        // with the CLI's own actionable advice in chat (#58), never the login
        // overlay, which can't fix it.
        // Same as the first prompt path: say it out loud. This is the RESEND,
        // so a failure here means a fresh process hit the same wall.
        this.host.appendLine(
          `[${session.provider}] resend failed for session ${session.client?.sessionId ?? session.activeSessionId ?? "none"}`
          + `: ${errorDetail(e2)}`,
        );
        this.emit(session, { type: "agentError", text: promptErrorText(e2) });
        this.noteLiveTurnEnded(session);
        this.setStatus(session, "error");
      }
    } finally {
      // Same belt as the ordinary send path: a resend that leaves any other way
      // must not leave the session pinned mid-turn.
      endTurn(session, turn);
    }
    return true;
  }

  /** Give a session a readable name from its opening prompt, as `autoName` — never
   *  as `customName`. The distinction is the whole of #96: written as a rename, our
   *  guess outranked grok's own `session_summary` forever, so every unrenamed row
   *  stayed a truncated first sentence while the CLI had a real topic for it.
   *  `buildEntry` now ranks this below the CLI title, which means it shows only
   *  until grok writes one — usually the same turn.
   *
   *  Sessions named before this change keep the name they have: an auto title
   *  already written into `customName` is indistinguishable from a rename, and
   *  guessing wrong there would silently discard names people typed. */
  private maybeGenerateTitle(session: Session): void {
    if (session.titleGenerated) return;
    const sid = session.client?.sessionId ?? session.activeSessionId;
    const first = session.firstUserMessageForTitle;
    if (!sid || !first) return;
    session.titleGenerated = true;
    const cleaned = first.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    const title = cleaned.length > 50 ? cleaned.slice(0, 47) + "…" : cleaned;
    void this.updateSessionMeta((current) => {
      const entry = current[sid];
      if (entry?.customName || entry?.autoName) return null;
      return { ...current, [sid]: { ...(entry ?? {}), autoName: title } };
    }).then(() => this.postSessionName(session));
    // An override changes the row without touching summary.json's mtime, so the
    // mtime-keyed cache would keep serving the un-named entry (same reason rename
    // and pin invalidate here).
    this.sessionCache.delete(sid);
  }

  /**
   * The user has opened the host's move-view picker — from the gear, the palette
   * command, or the empty-state hint's own link. Retires that hint for good.
   *
   * The single place both routes record it, and it does two things because one
   * is not enough: persist, for future windows, and tell the LIVE webview, for
   * this one. `initialState` is not re-sent on a session swap, so a webview
   * holding a stale true would rebuild the hint the user had already acted on —
   * and if they open the picker and cancel, no rebuild happens to refresh it.
   *
   * Called BEFORE the move, never after: relocating a view makes the host tear
   * the webview down and rebuild it, and the rebuilt one asks for capabilities
   * immediately, so a write afterwards loses that race.
   *
   * Recorded for ANY destination, including one the user then cancels out of:
   * they have found the control, which is all the hint was for. It never affects
   * where the view goes — that decision takes no account of it.
   */
  async retireMoveViewHint(): Promise<void> {
    await this.state.update(MOVE_VIEW_HINT_USED_KEY, true);
    this.post({ type: "moveViewHint", value: false });
  }

  /** Global "Use this app for" from ~/.grok/client-state (absent → Knowledge work). */
  private appPurpose(): AppPurpose {
    return parseAppPurpose(this.state.get<string>(APP_PURPOSE_KEY));
  }

  private buildInitialStateMsg(): Extract<HostMsg, { type: "initialState" }> {
    const cfg = this.host.getConfiguration("grok");
    const cwd = this.workspaceRoot();
    // Additive: older webviews ignore an unknown field; older hosts omit it
    // and command View all then leaves language unset.
    const commandLanguage = commandLanguageForDialect(resolvedTerminalShellDialect());
    return {
      type: "initialState",
      effort: cfg.get("defaultEffort", ""),
      cwd,
      useCtrlEnter: cfg.get("useCtrlEnterToSend", false),
      extVersion: this.context.extensionVersion,
      showThinking: cfg.get("showThinking", false),
      expandCommandOutputs: cfg.get("expandCommandOutputs", false),
      steerByDefault: cfg.get("steerByDefault", false),
      soundNotifications: cfg.get("soundNotifications", false),
      processingSound: cfg.get("processingSound", false),
      readRepliesAloud: cfg.get("readRepliesAloud", false),
      telemetryEnabled: cfg.get("telemetry.enabled", true),
      thumbsFeedback: cfg.get("thumbsFeedback", false),
      appPurpose: this.appPurpose() || DEFAULT_APP_PURPOSE,
      ...(commandLanguage ? { commandLanguage } : {}),
      // For a remote's About page. A phone is looking at neither GUI,
      // so it has to be told which one is on the other end and what the machine
      // is called. `canSwitchWorkspaceFolder` is the desktop app's defining
      // capability and is already how every other host-kind decision here is
      // made. The name is the same string the device list shows, so the two
      // surfaces cannot disagree about what the machine is called.
      hostKind: this.host.canSwitchWorkspaceFolder ? "desktop" : "extension",
      hostName: deviceDisplayName(os.hostname(), process.platform, os.release()),
      // Wire baseline + host-kind UI affordances (gear Move view / Show logs).
      capabilities: {
        ...HOST_CAPABILITIES,
        relocateView: this.host.canRelocateView,
        // Cursor refuses extension containers in the secondary side bar, so the
        // menu offers the panel by edge there rather than a destination that
        // would silently do nothing.
        secondarySideBar: this.host.canUseSecondarySideBar,
        moveViewHint: shouldShowMoveViewHint({
          hostAcceptedSecondarySideBar: this.host.canUseSecondarySideBar,
          canRelocateView: this.host.canRelocateView,
          pickerAlreadyUsed: this.state.get<boolean>(MOVE_VIEW_HINT_USED_KEY) === true,
        }),
        showOutput: this.host.canShowOutput,
        // OPT-IN: unpackaged desktop only. Gear → Advanced offers the control so
        // DevTools is discoverable without the auto-hidden application menu.
        toggleDevTools: this.host.canToggleDevTools,
        // OPT-IN: absent/false hides Settings → Connectors.
        //
        // A cloud environment used to withhold this, because connecting is a
        // browser OAuth flow at the VENDOR and a hosted machine has no browser
        // — nor, unlike a desk, any computer to walk over to. That comment named
        // its own expiry: "until a connector offers a device-code flow". The
        // remote-connect path is that, near enough. The consent link is
        // delivered to the requesting client, the person approves it in the
        // browser they are already holding, and the callback address is pasted
        // back for the host to replay against its own loopback listener.
        //
        // So the capability now follows the host, not the estate. On a cloud
        // machine the remote is the ONLY surface, which makes this the one place
        // the feature is load-bearing rather than a convenience.
        ...(this.host.canShowMcpSettings ? { mcpSettings: true } : {}),
        // Sign OUT from a remote, cloud only. See HostUiCapabilities and the
        // CLOUD_DISPOSITION override in remote-policy.ts, which is the half that
        // actually admits the message — this flag only decides whether the page
        // offers the control.
        ...(isCloudEnvironment() ? { remoteAgentSignOut: true } : {}),
        // Absent/true = host opens files in an editor tab; false = no editor
        // (desktop → in-app lightbox for generated images). See Host.canOpenInEditor.
        openInEditor: this.host.canOpenInEditor,
        // Only a host that owns the media handler may opt generated videos into
        // metadata preload; every other host keeps the lazy default.
        servesMediaRanges: this.host.canServeMediaRanges,
        showInFolder: this.host.canShowInFolder,
        // OPT-IN: desktop only. View all / proposed diffs open the in-app
        // overlay instead of a host editor or bare window. Remotes never
        // receive this (DESK_ONLY_CAPABILITIES).
        previewInApp: this.host.canPreviewInApp,
        // OPT-IN: VS Code editor tab. Desktop/remotes keep the in-page overlay.
        settingsEditor: this.host.canOpenSettingsEditor,
        // Only a host that owns its own folder set can add one. VS Code's
        // workspace is VS Code's to manage, so the extension never advertises
        // this and the rail never draws the control — capability, not a flag.
        addProjectFolder: this.canAddProjectFolder(),
        // Add project can MAKE one as well as find one. Both are opt-in field
        // presence, never a version check: a client older than this ignores the
        // flags and keeps offering only the picker.
        createProject: this.canAddProjectFolder(),
        cloneProject: this.canAddProjectFolder(),
        // Closing an open folder is meaningful only at a local desk.
        removeProjectFolder: !isCloudEnvironment() && this.canAddProjectFolder(),
      },
    };
  }

  private postInitialState(): void {
    // `ready` means the local renderer just booted (including Electron
    // document reload, which does not re-enter resolveWebviewView). Drop the
    // cache so postVoiceConfigured below is not swallowed against the old view.
    this.forgetPostedVoiceConfigured("local");
    this.post(this.buildInitialStateMsg());
    this.postProviderState();
    void this.refreshGithubState();
    this.postMcpConnectors();
    // Where new projects go. Static per host, but the Add project form needs it
    // before the user has done anything, so it rides the initial burst rather
    // than waiting for a first attempt.
    this.postProjectSetup();
    for (const provider of this.connectedProviders()) void this.probeProviderVersion(provider);
    this.post({
      type: "summarizeRepliesAloud",
      value: this.host.getConfiguration("grok").get<boolean>("summarizeRepliesAloud", true),
    });
    // Sync the active-editor context chip into the fresh webview (the config
    // gate + no-editor case live inside refreshImplicitChip).
    this.refreshImplicitChip(true);
    this.postVoiceConfigured();
    void this.postRemoteStatus();
    // Usable, not connected: with only a lapsed provider there is nothing that
    // can answer, and connect-agent lets the user pick any of the three rather
    // than being funnelled into that one provider's login instructions.
    if (this.usableProviders().length === 0) {
      this.focused.priming = false;
      this.post({ type: "setBusy", value: false });
      this.post({ type: "onboarding", state: "connect-agent", platform: process.platform });
      this.postSessionsList();
      return;
    }
    // Host-declared capability (not incidental focused.client): only Electron
    // sets webviewReloadsUnderLiveSession. VS Code is false by construction, so
    // a view move / "Reload Webviews" that recreates the webview under a live
    // client still takes the v3.1.0 startSession path below.
    if (shouldRehydrateOnWebviewReady(this.host.webviewReloadsUnderLiveSession, !!this.focused.client)) {
      this.rehydrateWebviewFromFocused();
      return;
    }
    // Sweep abandoned empty sessions once the first session is live (so the
    // newly-focused session is excluded from the sweep). This is the run that
    // collects what the last window left behind when it closed without a prompt.
    // Re-post the session list after start so a live empty "New session" row and
    // any id assigned by session/new land on the selected project's rail (ready
    // already pushed the disk list before the agent was up).
    // The pristine session has no cwd, and `startSession`'s fallback is the
    // WORKSPACE ROOT — so a project chosen in the rail before the chat view was
    // ever revealed was ignored by the very first conversation. The rail and
    // history said B while the agent ran in A, and the first prompt could read
    // or write A. Every other entry point sets this (newFocusedSession, resume,
    // the delete replacement); the one that starts by itself did not.
    if (!this.focused.cwd) {
      this.setSessionCwd(this.focused, this.historyCwdFor("local"), this.workspaceRoot());
    }
    if (!this.focused.hasHistory && !this.focused.client) {
      this.focused.provider = this.defaultProviderForProject(this.sessionCwd(this.focused));
    }
    void this.startSession(undefined, this.focused, "ensure").then(() => {
      this.postSessionsList();
      this.sweepEmptySessions();
    });
  }

  /**
   * Replay the focused session into a freshly-booted webview without restarting
   * the ACP process. Used when the document reloads (Electron) but the sidebar
   * controller still holds a live pool member.
   */
  private rehydrateWebviewFromFocused(): void {
    const session = this.focused;
    const wv = this.view?.webview;
    if (!wv) return;
    this.touch(session);
    this.markRead(session);
    void wv.postMessage({ type: "clearMessages" });
    void wv.postMessage({ type: "historyReplay", active: true });
    for (const m of session.buffer) {
      void wv.postMessage(this.localizeHistoryMessage(m, wv));
    }
    void wv.postMessage({ type: "historyReplay", active: false });
    for (const m of sessionUiSnapshot(
      session,
      this.displayMode(session),
      this.localPreviewChips(session, wv),
    )) {
      void wv.postMessage(m);
    }
    // Restore turn chrome the buffer does not carry (busy is event-sourced live).
    // During priming the client exists but has no session id yet — keep the
    // startup lock so a reload cannot unlock the composer into a lost prompt.
    const chrome = rehydrateBusyChrome(session);
    void wv.postMessage({ type: "setBusy", value: chrome.value, locked: chrome.locked });
    this.postMode();
    this.postRepoCatalog();
    this.postSessionsList();
    this.postSessionName(session);
  }

  private async readImageChip(
    chip: FileChip,
    session: Session,
    gen: number,
  ): Promise<PromptImageInput | "failed" | "gone"> {
    try {
      const bytes = await fs.promises.readFile(chip.path);
      if (bytes.length === 0) throw new Error("file is empty");
      return {
        index: chip.imageIndex!,
        mimeType: chip.mimeType ?? "image/png",
        data: bytes.toString("base64"),
        path: chip.path,
        relPath: chip.originRelPath,
      };
    } catch (e) {
      if (gen !== session.gen) return "gone";
      this.emit(session, {
        type: "agentError",
        text: `Could not read ${chip.relPath} (${(e as Error).message}). Remove the attachment and try again.`,
      });
      return "failed";
    }
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

  private localPreviewChips(session: Session, webview: HostWebview): FileChip[] {
    return session.chips.map((chip) => isImageChip(chip)
      // Staging paths are genuine local disk (Uri.file roots).
      ? { ...chip, previewSrc: webview.asWebviewUri(Uri.file(chip.path)) }
      : chip);
  }

  private localizeHistoryMessage(message: HostMsg, webview: HostWebview): HostMsg {
    if (message.type === "userMessage" && message.chips) {
      return { ...message, chips: message.chips.map((chip) => isImageChip(chip)
        ? { ...chip, ...(fs.existsSync(chip.path)
          ? { previewSrc: webview.asWebviewUri(Uri.file(chip.path)) }
          : {}) }
        : chip) };
    }
    if (message.type === "queuedSends" && message.queued) {
      return {
        ...message,
        queued: message.queued.map((item) => ({
          ...item,
          ...(item.chips ? { chips: item.chips.map((chip) => isImageChip(chip)
            ? { ...chip, ...(fs.existsSync(chip.path)
              ? { previewSrc: webview.asWebviewUri(Uri.file(chip.path)) }
              : {}) }
            : chip) } : {}),
        })),
      };
    }
    if (message.type === "userMessageChunk" && message.images) {
      return {
        ...message,
        images: message.images.map((image) => image.path && fs.existsSync(image.path)
          ? { ...image, previewSrc: webview.asWebviewUri(Uri.file(image.path)) }
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
  /** Messages that DO something once rather than describe the conversation.
   *  The session buffer exists so a focus switch can rebuild the chat, and it is
   *  replayed in full every time — so anything action-shaped must stay out of it
   *  or it fires again on every switch back. `restoreComposer` is the one that
   *  bit: an Edit puts the message text back in the composer, the client appends
   *  it (deliberately, so an Edit cannot destroy what you are mid-way through
   *  typing), and a buffered copy therefore added the same draft again on every
   *  return to that conversation. The other two would re-steal focus and re-open
   *  the mode picker on reconnect. */
  private static readonly TRANSIENT_TYPES = new Set([
    "restoreComposer", "focusInput", "findInSession", "openModePopover",
    // Replayed mid-buffer it would stamp the then-current footer, not the live
    // one. `sessionUiSnapshot` restores eligibility after historyReplay ends.
    "turnFeedbackAck",
  ]);
  /**
   * Host→rail catalog surface. Everything else stays chat-only so a user who
   * never opens the rail sees exactly today's behaviour.
   */
  private static readonly PROJECTS_RAIL_HOST_TYPES = new Set<HostMsg["type"]>([
    "repos",
    "sessions",
    "sessionRemoved",
    "repoSessions",
    "pinnedSessions",
    "sessionDot",
    "session",
    "sessionName",
    "providerState",
    // The Add project form lives in this view too, and it needs both: where
    // folders go, and which mode decides whether cloning is on the menu.
    "projectSetup",
    "githubState",
    "githubRepos",
    "appPurpose",
  ]);
  /** Webview→host actions the rail may post. Closed set — never send/cancel/etc. */
  private static readonly PROJECTS_RAIL_WEBVIEW_TYPES = new Set<WebviewMsg["type"]>([
    "createProject",
    "cloneProject",
    "setupGithubCli",
    "listGithubRepos",
    // The rail renders the same clone form as the chat, so it can reach every
    // step of that form — including the token paste and the cancel that ends a
    // device login. Omitting them made both silently ignored from the rail:
    // the token field cleared with GitHub still disconnected, and Cancel left
    // the login running for its full 15-minute timeout.
    "githubLoginWithToken",
    "cancelDeviceLogin",
    "listSessions",
    "listRepoSessions",
    "selectRepo",
    "resumeSession",
    "newSession",
    "toggleSessionPin",
    "renameSession",
    "deleteSession",
    "clearAllSessions",
    "setRepoArchived",
    "setRepoColor",
    // Host-local by construction: it opens a native folder dialog. Reachable
    // from the rail because that is where the project list lives; a remote
    // cannot send it (remote-policy classifies it `host-local`).
    "addProjectFolder",
    // The way back out. Same host-local classification — on VS Code it forgets
    // a hand-added folder, which is the only revocation that surface has.
    "removeProjectFolder",
  ]);
  private post(message: HostMsg): void {
    if (this.focused.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    this.view?.webview.postMessage(message);
    this.mirrorToProjectsRail(message);
    if (GrokSidebar.DEVICE_GLOBAL_REMOTE_TYPES.has(message.type)) {
      this.broadcastRemoteDevice(message);
    } else {
      this.sendRemoteSession(this.focused, message);
    }
  }

  /** Chat + the settings tab (when open) both consume About update status. */
  private postGrokUpdateStatus(message: Extract<HostMsg, { type: "grokUpdateStatus" }>): void {
    this.post(message);
    void this.settingsEditor?.webview.postMessage(message);
  }

  /** Post to the VS Code webview only (plus catalog mirror to the projects rail). */
  private postLocal(message: HostMsg): void {
    this.postTap?.("local", message);
    this.view?.webview.postMessage(message);
    this.mirrorToProjectsRail(message);
  }

  /**
   * Second local destination for catalog-shaped frames. A view that has never
   * resolved is simply skipped — no parallel data path, no throw.
   */
  private mirrorToProjectsRail(message: HostMsg): void {
    if (!this.projectsRail) return;
    if (!GrokSidebar.PROJECTS_RAIL_HOST_TYPES.has(message.type)) return;
    void this.projectsRail.webview.postMessage(message);
  }

  /**
   * Sidebar orchestration for remote HostMsgs: pre-authorize (so postTap and
   * logs see the drop), transform media, then hand off to {@link RemoteUplink}.
   *
   * **The hard authorization boundary is inside RemoteUplink** — every socket
   * write (`broadcast` / `broadcastTo` / catch-up `snapshot`) re-checks
   * {@link mayDeliverRemoteHostMsg}. A new sender that forgot this method still
   * cannot put project data on the wire. Live fan-out still routes here so
   * transforms and the test postTap stay in one place.
   *
   * `scopeCwd` is the session or repo cwd that owns the payload. Required for
   * conversation/session types; list frames are checked against their entries;
   * device prefs and errors need no scope.
   */
  private deliverRemote(
    clientIds: readonly string[],
    message: HostMsg,
    scopeCwd?: string,
  ): void {
    if (clientIds.length === 0) return;
    const authorized = this.authorizedSessionCwds();
    const remoteMessage = this.messageForRemote(message);
    if (message.type === "repoSessions" && remoteMessage.type === "repoSessions"
      && remoteMessage.entries.length !== message.entries.length) {
      const removed = message.entries.length - remoteMessage.entries.length;
      this.host.appendLine(
        `[remote] filtered ${removed} unauthorized repoSessions ${removed === 1 ? "entry" : "entries"}`,
      );
    }
    if (!mayDeliverRemoteHostMsg(remoteMessage, authorized, scopeCwd, pathsEqual)) {
      this.host.appendLine(
        `[remote] dropped ${message.type} (project scope not authorized: ${scopeCwd ?? "<none>"})`,
      );
      return;
    }
    this.postTap?.("remote", remoteMessage, [...clientIds]);
    const out = transformHostMsgForRemote(remoteMessage, this.remoteMediaDeps);
    if (!out) return;
    // Pass scope through so the uplink gate does not re-derive from a stale
    // per-tab mapping for multi-client session fan-out.
    this.uplink?.broadcastTo([...clientIds], out, scopeCwd);
  }

  /** Remote clients receive media bytes only through the remote media policy;
   *  they must never inherit capabilities that describe the DESK machine. The
   *  list lives with the rest of the remote policy (DESK_ONLY_CAPABILITIES) so
   *  adding a capability has one obvious place to check, and so the stripping
   *  is testable without standing up a sidebar. */
  private messageForRemote(message: HostMsg): HostMsg {
    if (message.type === "repoSessions") {
      return repoSessionsMessageForRemote(
        message,
        this.authorizedSessionCwds(),
        pathsEqual,
      );
    }
    if (message.type !== "initialState") return message;
    return { ...message, capabilities: capabilitiesForRemote(message.capabilities) };
  }

  /** Target one opaque relay clientId. */
  private sendRemoteClient(clientId: string, message: HostMsg, scopeCwd?: string): void {
    // Derive scope when the caller did not pass one: message field → active
    // session cwd. Never invent a grant from a stale per-tab repo selection alone
    // for conversation types (that is exactly the close-ordering hole).
    let scope = scopeCwd;
    if (scope === undefined) {
      if (message.type === "sessionName") scope = message.cwd;
      else if (message.type === "repoSessions") scope = message.cwd;
      else {
        const active = this.remoteClients.active(clientId);
        if (active) scope = this.sessionCwd(active);
      }
    }
    this.deliverRemote([clientId], message, scope);
  }

  private sendRemoteRepo(cwd: string, message: HostMsg): void {
    // Repo-scoped fan-out (dots, etc.): the named cwd is the authorization scope.
    this.deliverRemote(this.remoteClients.clientsForCwd(cwd), message, cwd);
  }

  private sendRemoteSession(session: Session, message: HostMsg): void {
    const scope = this.sessionCwd(session);
    // Belt: refuse before iterating so a disposed/closed-folder session cannot
    // drip transcript to any remaining holder.
    if (!mayDeliverRemoteHostMsg(message, this.authorizedSessionCwds(), scope, pathsEqual)) {
      this.host.appendLine(
        `[remote] dropped ${message.type} for session (cwd not authorized: ${scope})`,
      );
      return;
    }
    for (const clientId of this.remoteClients.clients()) {
      if (this.remoteClients.active(clientId) === session) {
        this.sendRemoteClient(clientId, message, scope);
      }
    }
  }

  private sendRemoteHistorySnapshot(session: Session): void {
    const scope = this.sessionCwd(session);
    if (!this.isAuthorizedCwd(scope)) {
      this.host.appendLine(
        `[remote] dropped history snapshot (cwd not authorized: ${scope})`,
      );
      return;
    }
    const clientIds = this.remoteClients.clientsForActiveValue(session);
    if (clientIds.length === 0) return;
    const snapshot = bracketRemoteSnapshot(session.buffer);
    for (const clientId of clientIds) {
      for (const message of snapshot) this.sendRemoteClient(clientId, message, scope);
    }
  }

  private broadcastRemoteDevice(message: HostMsg): void {
    // Device-global prefs only (DEVICE_GLOBAL_REMOTE_TYPES) — no project scope.
    this.deliverRemote(this.remoteClients.clients(), message, undefined);
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
    fromLocal(message: WebviewMsg): Promise<void>;
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
    ): {
      promptCount(): number;
      queuedSends(): string[];
      /** The blocks of the last prompt actually handed to the CLI — the only
       *  place a test can read the `[Image #N]` tags and the image blocks they
       *  name as one artifact. */
      lastPromptBlocks(): Parameters<AcpClient["prompt"]>[0] | undefined;
    };
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
    delayFirstCatalogBuild(): { started: Promise<void>; release(): void; beginDeferred(): void };
    waitForSessionLoad(id: string): Promise<void>;
    setSessionStatus(id: string, status: SessionStatus): void;
    activeRemoteSessionId(clientId: string): string | undefined;
    activeRemoteWorktree(clientId: string): Session["worktree"];
    focusedSessionId(): string | undefined;
    seedFocusedWorktreeSession(
      id: string,
      worktree: NonNullable<Session["worktree"]>,
    ): {
      applyCount(): number;
      removeCount(): number;
      lastApplyPath(): string | undefined;
      lastRemovePath(): string | undefined;
      restore(): void;
    };

    hasLiveSession(id: string): boolean;
    /**
     * Latch Grok discovery to the missing-CLI path. `locateProvider("grok")`
     * will not search config or PATH; an explicit `provisionFakeGrok` path
     * still wins because it is cached first. In-memory only — does not
     * rewrite persisted account state.
     */
    isolateFromInstalledGrok(): void;
    /** Current Grok resolution after the isolate / provision latches. */
    locatedGrokCli(): string | undefined;
    /**
     * Point this host at a test-only ACP CLI and mark Grok connected so
     * startSession/loadSession spawn it instead of taking the missing-CLI
     * onboarding path. Does not start a session. The returned restore
     * function puts the previous CLI path and connection flag back.
     */
    provisionFakeGrok(cliPath: string): () => void;
    remoteClientLeft(clientId: string): void;
    remoteClientRoster(clientIds: string[]): void;
    sweepEmptySessions(cwd: string): void;
    workspaceRoot(): string;
  } {
    return {
      onPost: (fn) => {
        this.postTap = fn;
      },
      fromRemote: (message, clientId = "test-client") => this.handleRemoteMessage(clientId, message),
      fromLocal: (message) => this.onMessage(message, "local"),
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
        // sessionId is required for sessionReadyForPrompt (flush + send).
        session.client = { dispose() {}, sessionId: id } as AcpClient;
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
        session.client = { dispose() {}, sessionId: id } as AcpClient;
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
        // Priming: client may exist without a session id (spawn window).
        session.client = { dispose() {} } as AcpClient;
        session.priming = true;
        session.queuedSends = [{ text: queuedText, chips: [] }];
        session.queuedSendRequiresRelay = true;
        this.pool.add(session);
        this.remoteClients.setActive(clientId, session);
      },
      seedRemoteQueuedDispatch: (clientId, id, cwd, queuedText, chips = []) => {
        this.remoteClients.ready(clientId);
        this.remoteClients.select(clientId, cwd);
        let prompts = 0;
        let lastBlocks: Parameters<AcpClient["prompt"]>[0] | undefined;
        const session = new Session();
        session.cwd = cwd;
        session.activeSessionId = id;
        session.client = {
          sessionId: id,
          availableCommands: [],
          dispose() {},
          prompt: async (blocks: Parameters<AcpClient["prompt"]>[0]) => {
            prompts += 1;
            lastBlocks = blocks;
            return {};
          },
        } as unknown as AcpClient;
        session.hasHistory = true;
        session.status = "done";
        session.chips = [];
        session.queuedSends = [{ text: queuedText, chips: chips.map((chip) => ({ ...chip })) }];
        session.queuedSendRequiresRelay = true;
        this.pool.add(session);
        this.remoteClients.setActive(clientId, session);
        void this.maybeFlushQueuedSends(session);
        return {
          promptCount: () => prompts,
          queuedSends: () => session.queuedSends.map((item) => item.text),
          lastPromptBlocks: () => lastBlocks,
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
        const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
        await this.state.update(SESSION_META_KEY, {
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
      delayFirstCatalogBuild: () => {
        let markStarted!: () => void;
        let releaseWait!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const wait = new Promise<void>((resolve) => { releaseWait = resolve; });
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.testCatalogHold = undefined;
          releaseWait();
        };
        this.firstBootScanStarted = false;
        this.firstBootScanCompleted = false;
        this.firstBootScanDone = new Promise<void>((resolve) => {
          this.resolveFirstBootScan = resolve;
        });
        this.testCatalogHold = { started: markStarted, wait, release };
        return {
          started,
          release,
          beginDeferred: () => { void this.runFirstBootScan({ deferSessions: true }); },
        };
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
      seedFocusedWorktreeSession: (id, worktree) => {
        // Tear down a leftover live/in-flight client first. startSession writes
        // session.client with no gen check, so a stub seeded onto that same
        // Session is overwritten and apply/remove never reach this probe.
        const prev = this.focused;
        this.detachClient(prev)?.dispose();
        this.focused = this.newLocalSession();
        this.focused.activeSessionId = id;
        this.focused.cwd = worktree.sourceGitRoot;
        this.focused.worktree = worktree;
        let applyCount = 0;
        let removeCount = 0;
        let lastApplyPath: string | undefined;
        let lastRemovePath: string | undefined;
        this.focused.client = {
          dispose() {},
          sessionId: id,
          applyWorktree: async (worktreePath: string) => {
            applyCount += 1;
            lastApplyPath = worktreePath;
            return { status: "ok", files: [], gitRoot: worktree.sourceGitRoot };
          },
          removeWorktree: async (worktreePath: string) => {
            removeCount += 1;
            lastRemovePath = worktreePath;
            throw new Error("test-probe-stop");
          },
        } as unknown as AcpClient;
        return {
          applyCount: () => applyCount,
          removeCount: () => removeCount,
          lastApplyPath: () => lastApplyPath,
          lastRemovePath: () => lastRemovePath,
          restore: () => {
            this.focused = prev;
          },
        };
      },
      hasLiveSession: (id) => [...this.pool].some((session) =>
        session.activeSessionId === id && !!session.client
      ),
      isolateFromInstalledGrok: () => {
        this.testForceMissingGrokCli = true;
        this.cliPath = undefined;
        this.setProviderConnectedInMemory("grok", false);
      },
      locatedGrokCli: () => this.locateProvider("grok"),
      provisionFakeGrok: (cliPath) => {
        const previous = {
          cliPath: this.cliPath,
          connected: this.providerConnections().grok === true,
        };
        this.cliPath = cliPath;
        this.setProviderConnectedInMemory("grok", true);
        return () => {
          this.cliPath = previous.cliPath;
          this.setProviderConnectedInMemory("grok", previous.connected);
        };
      },
      remoteClientLeft: (clientId) => this.releaseRemoteClient(clientId),
      remoteClientRoster: (clientIds) => this.retainRemoteClients(clientIds),
      // Asking for the sweep by name means now — see the `force` note there.
      sweepEmptySessions: (cwd) => this.sweepEmptySessions(cwd, { force: true }),
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
    else if (!GrokSidebar.TRANSIENT_TYPES.has(message.type)) session.buffer.push(message);
    if (message.type === "userMessage" && !message.steer) {
      session.liveFeedbackEligible = false;
      session.turnRating = 0;
    }
    if (session === this.focused) {
      this.postTap?.("local", message);
      const webview = this.view?.webview;
      if (webview) webview.postMessage(this.localizeHistoryMessage(message, webview));
      // Active-session identity for the projects rail (highlight + pin home).
      this.mirrorToProjectsRail(message);
    }
    if (!session.replaying) this.sendRemoteSession(session, message);
  }

  /**
   * Session-scoped like {@link emit}, but the message never leaves this machine.
   *
   * The pairing exists because the two properties a desk-only notice needs pull
   * in opposite directions: `post` reaches the desk but forwards to whichever
   * remote clients hold the focused session (so a notice about conversation A
   * lands in a tab reading B), while `emit`'s buffering is exactly what stops a
   * notice dying on the next focus switch. Buffer like `emit`, deliver like
   * `postLocal`.
   */
  private emitLocal(session: Session, message: HostMsg): void {
    if (session.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (message.type === "clearMessages") session.buffer = [];
    else if (!GrokSidebar.TRANSIENT_TYPES.has(message.type)) session.buffer.push(message);
    if (message.type === "userMessage" && !message.steer) {
      session.liveFeedbackEligible = false;
      session.turnRating = 0;
    }
    if (session !== this.focused) return;
    this.postTap?.("local", message);
    const webview = this.view?.webview;
    if (webview) webview.postMessage(this.localizeHistoryMessage(message, webview));
    this.mirrorToProjectsRail(message);
  }

  /** Desk-targeted, non-replayable delivery for one-shot notices. */
  private emitLocalTransient(session: Session, message: HostMsg): void {
    if (session.suppressContent && GrokSidebar.SUPPRESS_TYPES.has(message.type)) return;
    if (session !== this.focused) return;
    this.postTap?.("local", message);
    const webview = this.view?.webview;
    if (webview) webview.postMessage(this.localizeHistoryMessage(message, webview));
    this.mirrorToProjectsRail(message);
  }

  private async replayLoadedHistory(session: Session, load: () => Promise<void>): Promise<void> {
    // Join an in-flight load rather than superseding it: session/load cannot
    // be aborted, and a second stream would interleave into the same buffer.
    // `replaying` stays a boolean so remotes still see "any replay in progress".
    await runExclusiveHistoryLoad(session, load, {
      onStart: () => this.emit(session, { type: "historyReplay", active: true }),
      onFinish: () => {
        this.emit(session, { type: "historyReplay", active: false });
        this.sendRemoteHistorySnapshot(session);
      },
    });
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
  private liveSessionById(id: string): Session | undefined {
    if (this.focused.activeSessionId === id) return this.focused;
    return [...this.pool].find((session) => session.activeSessionId === id);
  }

  /** An unused empty conversation is one nobody is looking at, with no real
   *  work in it. Minting another while one of these exists is how a project
   *  ends up with two identical "New session" rows. */
  private sessionIsReusableEmpty(session: Session): boolean {
    return !!session.activeSessionId
      && !session.hasHistory
      && !session.worktree
      && session.chips.length === 0
      && !session.priming
      && !session.strandedDraft
      && session.queuedSends.length === 0
      && !session.needsProvider;
  }

  private findUnusedEmptySession(
    cwd: string,
    scope: "local" | "remote",
    excludeId?: string,
  ): { session?: Session; id: string; cwd: string } | undefined {
    if (!cwd) return undefined;
    for (const session of this.pool) {
      const id = session.activeSessionId;
      if (!id || id === excludeId) continue;
      if (!pathsEqual(this.sessionCwd(session), cwd)) continue;
      if (!this.sessionIsReusableEmpty(session)) continue;
      if (this.sessionHasLiveOwner(session)) continue;
      return { session, id, cwd: this.sessionCwd(session) };
    }
    // ONLY sessions this host is holding, never a row from the list.
    //
    // The cold-row branch that used to live here read `numMessages === 0` as
    // “nobody has used this”. For Codex and Claude that field is HARDCODED to
    // zero for every row (`provider-ui.ts`, adapterListEntry), so every
    // conversation they own looked unused — and New Session would silently
    // adopt one with somebody's work in it, sending their next message into a
    // conversation they thought was new. An independent round caught it before
    // release; a stale Grok shell that cannot be resumed was the same premise
    // failing a second way.
    //
    // A live session in the pool is different in kind: emptiness is the host's
    // own state, not an inference from a list field that means nothing here.
    // So the reuse is narrower than first written, and only says what it knows.
    return undefined;
  }

  /**
   * Is the local view sitting on the conversation that was just deleted?
   *
   * By ID, and only by id. `disposeSession` does not clear `activeSessionId`,
   * so a view still attached to the dead conversation still carries its id —
   * which covers both the ordinary case and a view that moved onto it while
   * the delete was in flight.
   *
   * Object identity was tried and removed. A `Session` is a container that
   * gets RECYCLED: after the delete disposes it, a reasoning-effort change
   * calls `startSession(undefined, session)` and the same object comes back
   * holding a brand-new conversation. Identity then said “still on the deleted
   * one” and moved the person off a conversation they had just started
   * writing in. The id cannot make that mistake: it is the conversation, not
   * the box it arrived in.
   *
   * Asked at the moment of the decision. A snapshot taken before the provider
   * teardown answers a question about a view that has since moved.
   */
  private viewIsOnDeleted(id: string): boolean {
    return !!id && this.focused.activeSessionId === id;
  }
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
    const reservations = this.sessionLoadReservations;
    if (!reservations) return null;
    for (const [id, reservation] of reservations) {
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
    // Both surfaces need it, and the desk has the same gap the browser does —
    // re-focusing a live conversation never said which agent it belongs to.
    const identity = this.sessionIdentityFrame(session);
    if (wv) {
      wv.postMessage({ type: "clearMessages" });
      if (identity) wv.postMessage(identity);
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
        ...(identity ? [identity] : []),
        ...bracketRemoteSnapshot(session.buffer),
      ];
      for (const m of replay) {
        this.sendRemoteSession(session, m);
      }
    }
    this.postMode();
    this.postRepoCatalog();
    // The IDENTITY frame, sent directly rather than as a side effect.
    //
    // Both clients hold their rail transition open until they learn which
    // conversation is now active — from `sessionName`, or from a sessions list's
    // `activeId` (chat.js `noteRailTransitionSessionName`, projects-rail.js
    // `case "sessionName"`). That frame used to ride inside postSessionsList,
    // which is a whole catalog walk to deliver one id, and dropping the walk
    // dropped the id with it: switching to an already-live conversation hung the
    // transition for its full timeout and then snapped the highlight back to the
    // previous one while the host was focused on the new one. Caught in review,
    // after a commit message asserted this path already sent it.
    //
    // Sending it here is the point of the change rather than an exception to it:
    // the small frame the client actually needs, instead of rebuilding a list
    // that has not changed.
    this.postSessionName(session);
    // Same as the remote path, and for the same reason: restorePersistedDraft
    // broadcasts, so it is not called here.
  }

  /**
   * Leave the focused session running in the pool so it can be re-focused later
   * — unless it's an untouched, idle session, which isn't worth a live process,
   * so we tear it down. Called before switching focus to a new/other session.
   */
  private parkFocused(): void {
    const cur = this.focused;
    // A DELETED conversation is not parked, whatever state it is holding.
    //
    // Re-homing after a delete opens the neighbour, and a COLD neighbour
    // reaches here while `this.focused` is still the just-disposed object. If
    // the person had typed a follow-up while the agent worked, the arm below
    // put it BACK in the pool — and the list builder synthesizes a row for any
    // pool member with no directory on disk, so the conversation they deleted
    // reappeared. Reaping will not take it either, because a queued send
    // counts as a draft. Deleting it a second time works, which is exactly the
    // “it came back” complaint this change set out to fix, by a new route.
    if (cur.deleted) return;
    const busy = cur.status === "working" || cur.status === "needs-you";
    if (cur.needsProvider || cur.strandedDraft || cur.queuedSends.length > 0) {
      this.pool.add(cur);
      return;
    }
    // A worktree session backs a real git checkout the user explicitly created —
    // never auto-delete it as an empty session, even before the first
    // message (that's what made creating/leaving a worktree replace the current
    // one). It's removed only via Remove worktree.
    if (cur.hasHistory || busy || cur.chips.length > 0 || cur.worktree) return; // real/active work — keep it parked & alive
    // Still starting: `hasHistory` is the flag that says "this conversation is
    // real, do not delete it", and on a RESUME it is set at the very end of
    // startSession — after the client has already reported the session id and
    // after the default-model await. In that window a resumed conversation looks
    // exactly like an untouched new one, and the two lines below would delete the
    // stored conversation off disk. Reachable by clicking a second rail row while
    // the first is still opening, which the rail does not prevent because loads
    // are reserved per session id, not globally.
    if (cur.priming) return;
    // Co-attached: a remote tab still shows this session — not ours to tear down.
    if (this.remoteClients.clientsForActiveValue(cur).length > 0) return;
    // Empty session being left behind (New Session, or switching to
    // another): tear down its process AND delete its on-disk dir so it doesn't pile
    // up in history (#24). The next focused session becomes the single live "New
    // session"; abandoning this one removes it entirely.
    const id = cur.activeSessionId;
    const cwd = this.sessionCwd(cur);
    const provider = cur.provider;
    // Retain the pipe for session/delete. disposeSession still owns all pool
    // and remote bookkeeping; its second detach finds no client to terminate.
    const client = isAdapterProvider(provider) ? this.detachClient(cur) : undefined;
    this.disposeSession(cur);
    if (isAdapterProvider(provider)) {
      void this.discardAdapterEmptySession(provider, id, cwd, client).finally(() => client?.dispose()).then((removed) => {
        if (removed) this.postSessionRemoved(id, cwd);
      }).catch((error) => {
        this.host.appendLine(`[${provider}] empty-session cleanup failed: ${(error as Error).message}`);
      });
    } else if (this.removeSessionFromDisk(id, cwd)) this.postSessionRemoved(id, cwd);
  }

  /** Remote counterpart of parkFocused: abandoning an empty tab session
   * must not leave an ownerless process or history row behind. */
  private parkRemoteSession(clientId: string, next?: Session): void {
    const current = this.remoteClients.active(clientId);
    if (!current || current === next) return;
    const busy = current.status === "working" || current.status === "needs-you";
    if (current.needsProvider || current.strandedDraft) {
      this.pool.add(current);
      return;
    }
    if (
      current.hasHistory ||
      busy ||
      current.needsProvider ||
      !!current.strandedDraft ||
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
    const cwd = this.sessionCwd(current);
    const provider = current.provider;
    const client = isAdapterProvider(provider) ? this.detachClient(current) : undefined;
    this.disposeSession(current);
    if (isAdapterProvider(provider)) {
      void this.discardAdapterEmptySession(provider, id, cwd, client).finally(() => client?.dispose()).then((removed) => {
        if (removed) this.postSessionRemoved(id, cwd);
      }).catch((error) => {
        this.host.appendLine(`[${provider}] empty-session cleanup failed: ${(error as Error).message}`);
      });
    } else if (this.removeSessionFromDisk(id, cwd)) this.postSessionRemoved(id, cwd);
  }

  /** The sole remote-client release path: abandon its session before deleting ownership. */
  private releaseRemoteClient(clientId: string): void {
    this.forgetPostedVoiceConfigured(`remote:${clientId}`);
    const current = this.remoteClients.active(clientId);
    const preserveLogicalTab = (
      // A DEMOTED tab is a logical tab worth keeping, and it is the one case
      // with no active session to prove it. `deleteClient` drops the tab's
      // selected repo along with the latch, so an ordinary mobile network blip
      // after a takeover would land the page on the host's default repo with a
      // fresh session, its composer re-enabled and the old draft still in it —
      // and the next Send would file text written for one conversation into
      // another, in another REPOSITORY. `detachClient` keeps both for the same
      // tab token, which is exactly what a reconnect needs.
      this.remoteClients.requiresExplicitSession(clientId) ||
      (!!current && (
        current.needsProvider ||
        !!current.strandedDraft ||
        current.priming ||
        current.queuedSends.length > 0 ||
        current.chips.length > 0
      ))
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
  private removeSessionFromDisk(id: string | undefined, sessionCwd?: string): boolean {
    if (!id) return false;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cwd =
      sessionCwd ||
      overrides[id]?.worktreePath ||
      this.sessionCache.get(id)?.entry.cwd ||
      this.workspaceRoot();
    const grokHome = resolveGrokHome(process.env);
    let removed = false;
    try {
      deleteSessionDir({ fs: defaultFs, grokHome, cwd, id });
      removed = true;
    } catch (e) {
      this.host.appendLine(`[sessions] could not remove empty session ${id}: ${(e as Error).message}`);
    }
    if (overrides[id]) {
      void this.removeUploadsForSessions([id], overrides);
      const next = { ...overrides };
      delete next[id];
      void this.state.update(SESSION_META_KEY, next);
    }
    this.sessionCache.delete(id);
    return removed;
  }

  /** Every session id in a repo that has been PROVEN to hold real work, for this
   *  activation. The sweep runs on every new/opened session, and without this each
   *  run would re-read every `summary.json` under the repo; with it, a repeat run
   *  reads only directories it has never classified. Safe to keep forever: a
   *  session that has a real user turn never becomes empty again. Keyed by
   *  {@link normalizeRepoPath}. */
  private readonly provenNonEmpty = new Map<string, Set<string>>();

  /** Delete every empty session directory in `cwd` — one that grok registered but
   *  no conversation ever reached. `parkFocused` handles the session you walk away
   *  from inside a running window; this handles the ones nothing was there to park:
   *  a window closed without a prompt, a crashed host, a remote tab that vanished.
   *  With the primer retired (v2.2.0) nothing removed those at all and they
   *  collected as unloadable "Untitled" rows — a session directory holding only
   *  `summary.json` is not loadable by the CLI (#97).
   *
   *  Runs on activation and after every new/opened session, so at most one empty
   *  session — the live one you are looking at — survives in the repo you are
   *  working in. Scans the newest slice by mtime so it stays bounded on a large
   *  store, plus every summary-only (`hasTranscript === false`) entry even when
   *  it has aged out of that slice, and reads content only for directories it
   *  has not already cleared. Never touches a live session, one being loaded
   *  right now, one younger than {@link SWEEP_MIN_AGE_MS}, a renamed or pinned
   *  one, a worktree session, or a subagent's transcript. Best-effort
   *  throughout: a locked directory is logged and skipped. */
  private sweepEmptySessions(
    cwd: string = this.workspaceRoot(),
    opts: { force?: boolean } = {},
  ): void {
    if (!cwd) return;
    const repoKey = normalizeRepoPath(cwd);
    // THROTTLED, because the per-open frequency was buying nothing.
    //
    // Every call walks the whole catalog to sort it by mtime — `readdirSync`
    // plus up to three `statSync` per session directory — and then reads
    // `summary.json` and `chat_history.jsonl` for each surviving candidate. At
    // 3000 conversations that measured 200-380ms of walking plus the reads, on
    // the Electron MAIN thread, which is the thread that paints the window.
    // Callers put it on the open path, so it ran on every click (#133/#131).
    //
    // And it could not have found anything: SWEEP_MIN_AGE_MS is THIRTY MINUTES,
    // so a session that was not sweepable half an hour ago is not sweepable now.
    // Running it dozens of times an hour deletes exactly what running it once
    // would have.
    //
    // This is not the "tidy up the conversation I just abandoned" path — that is
    // `discardRestartedEmptySession` / `removeSessionFromDisk`, which delete one
    // known id immediately and are untouched here. This is the periodic sweep of
    // shells left by earlier runs, and periodic is what it now is.
    //
    // `force` is for a caller that NAMES the sweep, which means now. The
    // throttle is about the incidental callers on the open path; applying it to
    // a deliberate request makes an explicit call silently do nothing, which is
    // the shape of a bug nobody can find later. The integration gate caught
    // exactly that: it calls the sweep to assert what it deletes, an earlier
    // incidental sweep had already stamped the repo, and it deleted nothing.
    const startedAt = Date.now();
    const lastSweep = this.lastSweepAt.get(repoKey) ?? 0;
    if (!opts.force && startedAt - lastSweep < GrokSidebar.SWEEP_INTERVAL_MS) return;
    this.lastSweepAt.set(repoKey, startedAt);
    const grokHome = resolveGrokHome(process.env);
    const log = (m: string) => this.host.appendLine(m);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    // A session with a live process re-persists itself the moment it is touched,
    // so deleting one is at best pointless and at worst races the CLI. The same
    // goes for a load already in flight: its directory is about to be handed to a
    // process that has not started yet, and it has no pool entry to protect it.
    const liveIds = new Set<string>();
    for (const s of this.pool) if (s.activeSessionId) liveIds.add(s.activeSessionId);
    if (this.focused.activeSessionId) liveIds.add(this.focused.activeSessionId);
    for (const clientId of this.remoteClients.clients()) {
      const id = this.remoteClients.active(clientId)?.activeSessionId;
      if (id) liveIds.add(id);
    }
    for (const detached of this.remoteClients.detachedActiveValues()) {
      if (detached.activeSessionId) liveIds.add(detached.activeSessionId);
    }
    for (const id of this.sessionLoadReservations.keys()) liveIds.add(id);

    let proven = this.provenNonEmpty.get(repoKey);
    if (!proven) {
      proven = new Set<string>();
      this.provenNonEmpty.set(repoKey, proven);
    }
    const index = indexSessions({ fs: defaultFs, grokHome, cwd, log });
    const removed: string[] = [];
    const now = Date.now();
    // Newest-N as before, PLUS every summary-only shell even when it has aged
    // out of that window. The 300 cap is what let 312 transcript-less
    // directories accumulate on a large store: they fall off the slice and
    // are never looked at again. A dir with no events.jsonl is cheap to
    // judge and is the shape a credential probe leaves behind.
    const considered = new Set<string>();
    const candidates: typeof index = [];
    for (const entry of index.slice(0, GrokSidebar.SWEEP_SCAN_LIMIT)) {
      considered.add(entry.id);
      candidates.push(entry);
    }
    // DELIBERATELY not extended past that slice. Walking every
    // `hasTranscript === false` entry would reach the shells that already fell
    // off the scan — but `hasTranscript` is a snapshot, and another window can
    // begin a session's first prompt after it was taken. The age gate does not
    // help there: an OLD session that stayed open still looks stale, so an
    // in-progress first write could be deleted, unrecoverably, from a second
    // window. Historical shells are inert; a deleted conversation is not.
    // Stopping their creation (see the probe's scratch cwd) is the fix that
    // does not risk data to collect a tidier directory listing.
    for (const { id, mtimeMs } of candidates) {
      if (liveIds.has(id) || proven.has(id)) continue;
      // The index is already sorted newest-first, so this could break — but a
      // clock skew or a touched file would then silently end the scan early.
      if (now - mtimeMs < GrokSidebar.SWEEP_MIN_AGE_MS) continue;
      // Alias-aware: session may live under a differently-cased catalog leaf.
      const sessDir = sessionDirFor(grokHome, cwd, id, { fs: defaultFs });
      if (!sessDir) continue;
      let raw: any;
      try {
        raw = JSON.parse(defaultFs.readFileSync(path.join(sessDir, "summary.json"), "utf8"));
      } catch {
        continue;
      }
      // Read the chat history and let the content check decide — do NOT skip on a
      // high num_messages. A primer-only session whose agentic primer turn ballooned
      // past the gate (e.g. 74 messages, zero real queries) would otherwise survive
      // forever. A history file that is present but unreadable is not evidence of
      // anything, so it is reported as such rather than as "no history".
      let chatHistory: string | undefined;
      let historyUnreadable = false;
      const historyPath = path.join(sessDir, "chat_history.jsonl");
      try {
        chatHistory = defaultFs.readFileSync(historyPath, "utf8");
      } catch {
        historyUnreadable = defaultFs.existsSync(historyPath);
      }
      const override = overrides[id];
      const empty = isEmptySession({
        customName: override?.customName,
        pinnedAt: override?.pinnedAt,
        worktreePath: override?.worktreePath,
        queuedDraft: override?.queuedDraft,
        kind: typeof raw?.session_kind === "string" ? raw.session_kind : undefined,
        numMessages: typeof raw?.num_messages === "number" ? raw.num_messages : 0,
        summary: typeof raw?.session_summary === "string" ? raw.session_summary : "",
        generatedTitle: typeof raw?.generated_title === "string" ? raw.generated_title : "",
        chatHistory,
        historyUnreadable,
      });
      if (!empty) {
        // Cache only a verdict reached from evidence. A locked file makes this
        // "not empty" too, and caching THAT would retire the session from every
        // later sweep this activation — the lock clears, the orphan stays forever.
        if (!historyUnreadable) proven.add(id);
        continue;
      }
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
      void this.state.update(SESSION_META_KEY, next);
      log(`[sessions] swept ${removed.length} empty session(s) from history`);
      this.postSessionsList();
    }
  }

  /** Detach a session from its live client: bump the generation so every handler
   *  and await bound to that client bails, drop the reference, and END ITS TURN.
   *
   *  The turn is the part that is easy to forget and expensive to miss. A client
   *  that goes away without settling its `prompt()` leaves the turn in flight
   *  with nothing left to end it, and the send path tests that BEFORE it
   *  respawns — so the next send is diverted into a queue that can never flush,
   *  and the session is dead to its user until the window is reloaded. Four
   *  teardown paths made that same mistake independently, which is why this is
   *  one function rather than four careful call sites.
   *
   *  Returns the detached client so the caller can dispose it as it needs —
   *  fire-and-forget, or awaited. */
  private detachClient(session: Session): AcpClient | undefined {
    const client = session.client;
    session.gen++;
    session.client = undefined;
    session.turnToken = undefined;
    // ITS COMMANDS GO WITH IT.
    //
    // A terminal is a child of the extension, not of the agent, so it outlives
    // the client that asked for it — and once the client is gone nothing can
    // ever send it `terminal/release`. That leaves a command running that
    // nobody owns, and since a running command is what keeps a cloud machine
    // awake, it holds one running and billing until the extension itself exits.
    //
    // Done HERE rather than in disposeSession because every teardown path goes
    // through this one function: worktree removal, a crashed ACP process, pool
    // disposal, and the session being deleted outright.
    if (client) {
      try {
        const n = this.terminalManager.releaseOwnedBy(client);
        if (n > 0) this.host.appendLine(`[terminal] released ${n} command(s) with their session`);
      } catch { /* teardown is not worth failing over */ }
    }
    return client;
  }

  /** Tear down one session's live process and drop it from the pool. Bumps its
   *  generation so any in-flight handlers/awaits bound to the old client bail.
   *  Recomputes the dot after removal — a reaped session that's still unread stays
   *  green; an idle/read one goes gray. */
  private disposeSession(session: Session): Promise<void> {
    const id = session.activeSessionId;
    // Returned, not dropped. `dispose()` resolves when the process is actually
    // gone — on Windows that is a `taskkill` still running — and a caller about
    // to DELETE the session's directory must wait for it. Callers that only
    // want the pool entry gone can keep ignoring this, exactly as before.
    const exited = this.detachClient(session)?.dispose();
    this.pool.delete(session);
    this.remoteClients.deleteActiveValue(session);
    if (id) this.post({ type: "sessionDot", id, dot: this.dotForId(id) });
    // A session can leave the pool while it is still WORKING — deleting the
    // conversation you are watching is allowed, and reaping and worktree
    // teardown end here too. Every one of those can take the last turn away, so
    // the wake lock and the cloud heartbeat are re-asserted HERE rather than at
    // each caller: setStatus covers a turn that finishes, and this covers a
    // turn that is taken away. Without it the heartbeat outlives the work and
    // holds a machine we rent awake until something else happens to stop it.
    this.refreshKeepAwake();
    return exited ?? Promise.resolve();
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
    // Wake lock: a turn starting or ending can change turnInFlight.
    this.refreshKeepAwake();
    if (status === "done" || status === "error") this.refreshSessionOrderAfterTurn(session);
  }

  /**
   * Re-push the project preview a finished turn just reordered.
   *
   * The rail's Recent group ranks by `updatedAt`, which is the session FILE's
   * mtime — and the extension is not what writes that file, the agent process
   * is. So rename and delete refresh (we do those) while sending a message did
   * not: nothing in here knew the row had moved. Recent stayed on whatever
   * order it was built with until something unrelated happened to redraw it.
   *
   * The turn ending is the closest signal we own. The agent writes the
   * transcript around the same moment, not necessarily before, so this reads a
   * beat later — and once more after that, because a single delay is a guess
   * about someone else's disk write. Two cheap directory scans, only when a
   * turn actually ended.
   */
  private refreshSessionOrderAfterTurn(session: Session): void {
    const cwd = this.sessionCwd(session);
    if (!cwd) return;
    for (const delay of [400, 1600]) {
      const timer = setTimeout(() => {
        this.turnOrderTimers.delete(timer);
        try {
          this.sendLocalRepoSessionsPreview(cwd);
        } catch {
          /* a preview refresh is never worth failing a turn over */
        }
      }, delay);
      this.turnOrderTimers.add(timer);
    }
  }

  /** Pending {@link refreshSessionOrderAfterTurn} timers, so dispose can clear them. */
  private turnOrderTimers = new Set<ReturnType<typeof setTimeout>>();

  /** True when any live pool member is mid-turn or waiting on the user. */
  /**
   * The agent was waiting on a person and now it is not.
   *
   * Answering is ACTIVITY whether or not it unblocks the whole turn: the tool
   * that was approved starts running immediately. Setting `working` is separate,
   * and conditional — with another card still outstanding the turn is not
   * resumed and saying so would be a lie — but the clock has to be re-armed
   * either way, or a machine can freeze on work that has only just begun.
   */
  noteAnswered(session: Session): void {
    // EVERY kind of card, not just permissions. Parallel tool calls can raise a
    // question and a plan review together, and answering one of them resumed
    // nothing — while `working` is what holds a rented machine awake, so the
    // claim cost money as well as being untrue.
    if (session.pendingPermissions.size === 0
      && session.pendingExitPlans.size === 0
      && session.pendingQuestions.size === 0) {
      this.setStatus(session, "working"); // setStatus touches and re-asserts
      return;
    }
    this.touch(session);
    this.refreshKeepAwake();
  }

  private anyTurnInFlight(): boolean {
    for (const s of this.pool) {
      if (hasLiveWork(s)) return true;
    }
    return false;
  }

  /**
   * Does a machine we rent still need to be awake?
   *
   * `working` always counts. The hard case is `needs-you`, and it has been
   * wrong in both directions:
   *
   * - Counting it for ever holds a machine running and billing while an
   *   unanswered permission card sits there and nobody is coming back tonight.
   * - Not counting it at all is worse, because `needs-you` does not mean the
   *   machine is idle. Terminal work is deliberately asynchronous, so an agent
   *   can start a long test run and THEN ask a question — and freezing the
   *   machine underneath that kills exactly the work somebody walked away from.
   *
   * So a card holds the machine for a while and then stops. Anything a
   * background process was going to finish, it finishes; an abandoned card
   * stops costing money. Nothing is lost either way — opening the page wakes
   * the machine and the card is still there.
   */
  /** Sign-in operations in flight — spawning, polling a vendor, or having a
   *  credential verified afterwards. Deliberately NOT the `deviceLogins` guard
   *  map (populated after the runner starts, cleared before verification, so
   *  keep-awake read it as "no work" through the whole dangerous window), and
   *  deliberately keyed by OPERATION rather than by provider: a successful
   *  login leaves the guard map before it finishes verifying, so a second tab
   *  can legitimately start the same provider meanwhile, and a provider-keyed
   *  hold let the older operation's cleanup release the newer one's machine
   *  (both found in review, 2026-08-31). */
  private readonly deviceLoginWork = new Set<number>();
  private deviceLoginWorkSeq = 0;

  /** A sign-in is in progress somewhere. Counts as work for the keep-awake
   *  above: the machine must not be paused underneath it. */
  private deviceLoginInFlight(): boolean {
    return this.deviceLoginWork.size > 0;
  }

  /** Take the keep-awake hold for one sign-in. The token is the ownership. */
  private beginDeviceLoginWork(): number {
    const id = ++this.deviceLoginWorkSeq;
    this.deviceLoginWork.add(id);
    if (this.deviceLoginWork.size === 1) this.refreshKeepAwake();
    return id;
  }

  /** Release one sign-in's hold. Idempotent, and only ever its own. */
  private endDeviceLoginWork(id: number): void {
    if (!this.deviceLoginWork.delete(id)) return;
    if (this.deviceLoginWork.size === 0) this.refreshKeepAwake();
  }

  private anyTurnWorking(): boolean {
    // A command that is still running is the one answer that does not depend on
    // reading a status. An agent can start a twenty-five-minute build and THEN
    // ask a question — the session then says it is waiting for a person while
    // the build carries on, and any window we pick is a guess about how long
    // that build takes. This is not a guess.
    if (this.terminalManager.anyRunning()) return true;
    const now = Date.now();
    for (const s of this.pool) {
      if (!hasLiveWork(s)) continue;
      if (s.status === "working") return true;
      // `lastActiveAt` is stamped when a session becomes working or needs-you,
      // so this is "how long ago the agent last did something", not "how long
      // the card has been on screen".
      if (now - s.lastActiveAt < NEEDS_YOU_KEEP_AWAKE_MS) return true;
    }
    return false;
  }

  /** Push just this session's recomputed dot to the webview (cheap — no disk read
   *  beyond the small meta object). Used on status changes, read/unread changes,
   *  and on reaping (where the session has left the pool but may stay green). */
  private pushDot(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const message: HostMsg = { type: "sessionDot", id, dot: this.dotForId(id) };
    this.view?.webview.postMessage(message);
    this.mirrorToProjectsRail(message);
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const sent = new Set<string>();
    for (const clientId of this.remoteClients.clients()) {
      const repoCwd = this.remoteClients.cwdIfPresent(clientId);
      if (!repoCwd) continue;
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
    const meta = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
    return computeDot({ liveStatus: live?.status, unread: meta?.unread, unreadError: meta?.unreadError });
  }

  /** Persist (or clear) a session's unread badge in globalState session-meta. */
  private setMetaUnread(id: string | undefined, unread: boolean, error: boolean): void {
    if (!id) return;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
    void this.state.update(SESSION_META_KEY, next);
  }

  /** Adapter catalogs own their persistence, so abandoning an empty conversation
   *  must use the advertised ACP delete rather than touching Grok's store. */
  private async discardAdapterEmptySession(
    provider: AcpProvider,
    id: string | undefined,
    cwd: string,
    liveClient?: AcpClient,
  ): Promise<boolean> {
    if (!id || !isAdapterProvider(provider)) return false;
    let temporary: AcpClient | undefined;
    try {
      let client = liveClient;
      if (!client) {
        const cliPath = this.locateProvider(provider);
        const backend = this.createProviderBackend(provider);
        if (!cliPath || !backend) throw new Error(`${providerDisplayName(provider)} CLI is not available.`);
        client = temporary = new AcpClient({
          cliPath,
          cwd,
          env: { ...process.env },
          backend,
          log: (message) => this.host.appendLine(message),
        });
        await client.start();
      }
      await client.deleteSession(id);
      const history = this.adapterHistory(provider);
      if (history) {
        for (const [key, entries] of history.cache) {
          history.cache.set(key, entries.filter((entry) => entry.id !== id));
        }
      }
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      if (overrides[id]) {
        const next = { ...overrides };
        delete next[id];
        await this.state.update(SESSION_META_KEY, next);
      }
      return true;
    } catch (error) {
      this.host.appendLine(`[${provider}] could not discard empty session ${id}: ${(error as Error).message}`);
      return false;
    } finally {
      if (temporary) await temporary.dispose();
    }
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
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const cur = overrides[id] ?? {};
    const occupancy = this.adapterTurnOccupancy(session, meta);
    const compacted = isAdapterProvider(session.provider) && session.adapterCompactThisTurn;
    const usageLog = capUsageLog([
      ...(cur.usageLog ?? []),
      {
        afterUserMessage: session.userMessageCount,
        afterHistoryEvent: session.historyEventCount,
        usage: measured ? meta.usage : undefined,
        ...(occupancy !== undefined
          ? { contextUsed: occupancy }
          : compacted && !cur.contextPendingCompact && cur.contextUsed
            ? { contextUsed: cur.contextUsed }
            : {}),
        ...(compacted ? { compacted: true } : {}),
      },
    ]);
    const sessionUsage = enforceCompleteSessionCost(
      sumUsage(usageLog),
      usageLog,
      session.userMessageCount,
    );
    if (measured) {
      this.emit(session, { type: "usage", turn: meta.usage, session: sessionUsage, afterUserMessage: session.userMessageCount, afterHistoryEvent: session.historyEventCount });
    }
    return this.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: { ...cur, usage: sessionUsage, usageLog },
    });
  }

  private persistedUsageLedger(sessionId: string, userMessageCount: number): {
    usageLog: NonNullable<SessionMetaOverrides[string]["usageLog"]>;
    usage: PromptUsage | undefined;
  } {
    const persisted = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[sessionId];
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

  private noteAdapterCompactSignal(session: Session, update: unknown): void {
    if (session.replaying || !isAdapterProvider(session.provider)) return;
    const signal = adapterCompactSignal(update);
    if (!signal) return;
    if (signal === "failed") {
      session.compactUsageArmed = false;
      session.adapterCompactThisTurn = false;
      this.rememberAdapterContext(session, { compactFailed: true });
      return;
    }
    session.adapterCompactThisTurn = true;
    session.compactUsageArmed = signal === "completed";
    this.rememberAdapterContext(session, { compacted: true });
  }

  /**
   * Largest single call in this turn, never Claude's summed PromptResponse.
   * A compact turn must not feed that sum back over getContextUsage.
   */
  private adapterTurnOccupancy(session: Session, meta: PromptResultMeta): number | undefined {
    if (!usageIsRealMeasurement(meta) || session.adapterCompactThisTurn) return undefined;
    return occupancyFromAdapterTurn(adapterContextOccupancy(meta.usage), session.adapterTurnCallUsed);
  }

  /**
   * Remember adapter occupancy and push it to the donut. Prompt size is the
   * conversation; a later smaller prompt is not, unless a compact just armed
   * a reset. Grok never enters here.
   */
  private rememberAdapterContext(
    session: Session,
    event: Parameters<typeof persistSessionContext>[1],
  ): { used?: number; window?: number } | undefined {
    if (!isAdapterProvider(session.provider)) return undefined;
    const id = session.activeSessionId;
    if (!id) return undefined;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const next = persistSessionContext(overrides[id] ?? {}, event);
    void this.state.update(SESSION_META_KEY, { ...overrides, [id]: next });
    const usage = persistedContextUsage(next);
    if (usage) {
      this.emit(session, {
        type: "contextUsage",
        used: usage.used,
        ...(usage.window ? { window: usage.window } : {}),
      });
    } else if (next.contextWindow) {
      this.emit(session, { type: "contextUsage", window: next.contextWindow });
    }
    return { used: next.contextUsed, window: next.contextWindow };
  }

  /** Push the context size to the webview — chiefly the cold-restore source
   *  before any turn has run. Grok reads signals.json; Claude/Codex read the
   *  remembered prompt occupancy. Best-effort: no readable count, no message. */
  private emitContextUsage(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    if (isAdapterProvider(session.provider)) {
      const usage = persistedContextUsage(this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id]);
      if (usage) {
        this.emit(session, {
          type: "contextUsage",
          used: usage.used,
          ...(usage.window ? { window: usage.window } : {}),
        });
      }
      return;
    }
    const cwd = this.sessionCwd(session);
    const usage = readContextUsage({ fs: defaultFs, grokHome: resolveGrokHome(process.env), cwd, id });
    if (usage) this.emit(session, { type: "contextUsage", used: usage.used, window: usage.window });
  }

  /** Publish a control-plane session/info snapshot without touching accounting. */
  private emitSessionInfoContext(session: Session, info: SessionInfoContext): void {
    session.lastSessionInfoAt = Date.now();
    session.lastSessionInfoUsed = info.used;
    session.sessionInfoStale = false;
    this.emit(session, {
      type: "contextUsage",
      used: info.used,
      window: info.window,
      categories: info.categories,
      systemPromptTokens: info.systemPromptTokens,
      toolDefinitionsTokens: info.toolDefinitionsTokens,
      toolDefinitionsCount: info.toolDefinitionsCount,
      messageTokens: info.messageTokens,
      freeTokens: info.freeTokens,
      autoCompactThresholdPercent: info.autoCompactThresholdPercent,
    });
  }

  /**
   * Read Grok's structured context meter. This is intentionally separate from
   * the adapter usageLog/contextUsageFromLog seam: those entries reconstruct
   * Claude/Codex occupancy and never describe Grok's live categories.
   */
  private async refreshContextFromSessionInfo(
    session: Session,
    gen: number,
    opts: { force?: boolean } = {},
  ): Promise<boolean> {
    if (session.provider !== "grok" || gen !== session.gen || session.sessionInfoUnsupported) return false;
    const client = session.client;
    if (!client?.sessionId) return false;
    if (!opts.force && !session.sessionInfoStale && sessionInfoCacheFresh(session.lastSessionInfoAt, Date.now())) {
      return false;
    }
    try {
      const info = await client.getSessionInfo();
      if (gen !== session.gen) return false;
      if (info === "unsupported") {
        session.sessionInfoUnsupported = true;
        return false;
      }
      this.emitSessionInfoContext(session, info);
      return true;
    } catch (error) {
      this.host.appendLine(`[context] session/info failed: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Post-compact compatibility chain: live notification → session/info →
   * legacy `/session-info`. The prompt fallback is only permitted after the
   * RPC explicitly returned -32601; a transient RPC error must not manufacture
   * a hidden model turn.
   */
  private async refreshContextAfterCompact(client: AcpClient, session: Session, gen: number): Promise<void> {
    if (await this.refreshContextFromSessionInfo(session, gen, { force: true })) return;
    if (gen !== session.gen || !session.sessionInfoUnsupported) return;
    if (!client.availableCommands.some((command) => command?.name === "session-info")) return;
    // NOT while somebody else's turn is running.
    //
    // This is a real `session/prompt`, and a second prompt ends the active one.
    // The compact path released its turn token before the RPC above, so another
    // tab can have started a genuine turn during that await — and sending this
    // would cancel it mid-work, silently, to refresh a context number. The
    // guards further down run only after this returns and cannot undo it.
    //
    // Skipping costs a stale context reading until the next turn refreshes it.
    // That is the cheaper of the two by a wide margin.
    if (turnIsInFlight(session)) return;
    session.suppressContent = true;
    session.captureAgentText = "";
    try {
      await client.prompt("/session-info");
      if (gen !== session.gen) return;
      const info = parseSessionInfoContext(session.captureAgentText);
      if (info) this.emit(session, { type: "contextUsage", used: info.used, window: info.window });
    } catch (error) {
      this.host.appendLine(`[compact] hidden /session-info failed: ${(error as Error).message}`);
    } finally {
      if (gen === session.gen) session.suppressContent = false;
      session.captureAgentText = undefined;
    }
  }

  /** Clear a session's unread badge (it's being opened/viewed) and refresh its dot. */
  private markRead(session: Session): void {
    const id = session.activeSessionId;
    if (!id) return;
    const meta = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
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
      const client = this.detachClient(s);
      if (client) closing.push(client.dispose());
    }
    this.pool.clear();
    return Promise.all(closing).then(() => undefined);
  }

  /** Start a brand-new session, keeping the current one alive in the background. */
  private async newFocusedSession(origin: MsgOrigin, requestedCwd?: string): Promise<void> {
    // Repo selection only changes history scope; New Session is the deliberate
    // second action that starts Grok in the selected cwd — deliberate only for
    // the client that can SEE the selection. That used to exclude VS Code,
    // whose switcher was hidden; the projects rail is that switcher, so it no
    // longer does. The phone half of the old worry is handled where it always
    // was: a remote's selection is per-client and never reaches
    // `selectedRepoCwd` (see historyCwdFor).
    //
    // An explicitly named project (the rail's per-project "+") is honoured, and
    // it MOVES the selection rather than starting somewhere the rest of the view
    // is not looking. Resolved through the catalog, so an unknown path falls back
    // to the scope instead of becoming a cwd nobody vouched for — the caller may
    // be a webview, and a "+" on a row is not a licence to name a directory.
    const named = requestedCwd ? this.resolveLocalRepoTarget(requestedCwd) : undefined;
    if (requestedCwd && !named) {
      // A specific project was asked for and it is not there any more — the rail
      // was drawn before the folder was unmounted or deleted. Falling through to
      // the scope would start Grok in whatever happens to be selected while the
      // click plainly named another project, and the agent would then write
      // there. Refuse, and refresh so the dead row goes away.
      void this.host.showWarningMessage(`That project is no longer available:\n${requestedCwd}`);
      this.postRepoCatalog();
      this.postSessionsList();
      return;
    }
    if (named && !pathsEqual(named.cwd, this.selectedRepoCwd || "")) {
      this.selectedRepoCwd = named.cwd;
    }
    const targetCwd = named?.cwd ?? this.historyCwdFor(origin);
    const leavingId = this.focused.activeSessionId;
    this.parkFocused();
    const unused = this.findUnusedEmptySession(targetCwd, "local", leavingId);
    if (unused?.session?.client) {
      this.focusSession(unused.session);
    } else if (unused?.session) {
      this.focused = unused.session;
      this.pool.add(this.focused);
      this.emit(this.focused, { type: "clearMessages" });
      await this.startSession(unused.id, this.focused, "ensure");
    } else if (unused) {
      await this.openSession(unused.id, unused.cwd);
    } else {
      this.focused = this.newLocalSession();
      this.setSessionCwd(this.focused, targetCwd, this.workspaceRoot());
      this.focused.provider = this.defaultProviderForProject(targetCwd);
      // The webview toolbar button clears its own DOM before posting newSession,
      // but the Command Palette command lands here directly — without this clear
      // the old transcript stayed onscreen under the fresh session. (The toolbar
      // path just clears twice, a no-op.)
      this.emit(this.focused, { type: "clearMessages" });
      await this.startSession();
    }
    await this.persistWorktreeBinding(this.focused);
    this.sweepEmptySessions(this.sessionCwd(this.focused));
    this.postRepoCatalog();
    // The rail's rows for the selected project come from `sessions` frames, and
    // this path posted the catalog but never the list — so a new conversation on
    // the desktop did not appear in the rail until something unrelated refreshed
    // it (closing and reopening the project was how it got noticed). The remote
    // path has always sent its own list here; only the local one was missing it.
    // After the sweep, not before: the sweep can retire the empty session this
    // one replaced, and a list built ahead of it would show a row that is gone.
    this.postSessionsList();
  }

  private focusRemoteSession(clientId: string, session: Session, notifyCatalog = true): void {
    const cwd = this.remoteClients.cwd(clientId);
    this.remoteClients.setActive(clientId, session);
    this.touch(session);
    this.markRead(session);
    this.sendRemoteClient(clientId, { type: "clearMessages" });
    // Before the transcript, so the replay renders under the right agent rather
    // than being relabelled after the fact. See sessionIdentityFrame.
    const identity = this.sessionIdentityFrame(session);
    if (identity) this.sendRemoteClient(clientId, identity);
    for (const msg of bracketRemoteSnapshot(session.buffer)) this.sendRemoteClient(clientId, msg);
    for (const msg of sessionUiSnapshot(session, this.displayMode(session))) this.sendRemoteClient(clientId, msg);
    if (notifyCatalog) this.postRepoCatalog();
    this.sendRemoteClient(clientId, this.buildSessionsList(cwd, undefined, this.remoteActiveSessionId(clientId)));
    // `clearMessages` above drops the client's latched name, and this path builds
    // its own targeted list instead of going through postSessionsList — so the
    // name has to be re-announced here or the header loses its rename affordance
    // until something unrelated refreshes it.
    this.postSessionName(session);
    // NOT restorePersistedDraft. It hands the draft back with session-wide
    // `emit`, which appends it to every surface viewing the conversation — so
    // calling it here re-created, on the switch-back, the desk-composer
    // pollution this whole sequence removed. Parked text therefore returns on
    // the next load of the conversation rather than the instant you switch to
    // it. That is a narrower promise, kept, instead of a wider one that leaks.
  }

  private async newRemoteSession(clientId: string, notifyCatalog = true): Promise<void> {
    const ownerTabToken = this.remoteClients.tabToken(clientId);
    const cwd = this.remoteClients.cwd(clientId);
    const leavingId = this.remoteClients.active(clientId)?.activeSessionId;
    this.parkRemoteSession(clientId);
    this.dropRemoteVoice(clientId);
    const unused = this.findUnusedEmptySession(cwd, "remote", leavingId);
    if (unused?.session?.client) {
      this.focusRemoteSession(clientId, unused.session, notifyCatalog);
      return;
    }
    if (unused?.session) {
      this.remoteClients.setActive(clientId, unused.session);
      this.emit(unused.session, { type: "clearMessages" });
      await this.startSession(unused.id, unused.session, "ensure");
      await this.persistWorktreeBinding(unused.session);
      this.sweepEmptySessions(this.sessionCwd(unused.session));
      if (notifyCatalog) this.postRepoCatalog();
      this.sendRemoteSessionList(unused.session, ownerTabToken);
      return;
    }
    if (unused) {
      await this.openRemoteSession(clientId, unused.id, unused.cwd, notifyCatalog);
      return;
    }
    const session = new Session();
    this.setSessionCwd(session, cwd, this.workspaceRoot());
    session.provider = this.defaultProviderForProject(cwd);
    this.remoteClients.setActive(clientId, session);
    this.emit(session, { type: "clearMessages" });
    await this.startSession(undefined, session);
    await this.persistWorktreeBinding(session);
    this.sweepEmptySessions(this.sessionCwd(session));
    if (notifyCatalog) this.postRepoCatalog();
    this.sendRemoteSessionList(session, ownerTabToken);
  }

  private refuseRemoteResume(
    clientId: string,
    id: string,
    text: string,
    selectedCwd: string,
    code?: typeof SESSION_SUPERSEDED_CODE,
  ): void {
    this.sendRemoteClient(clientId, {
      type: "error",
      text,
      resumeFailed: { id },
      ...(code ? { code } : {}),
    });
    this.sendRemoteClient(clientId, this.buildSessionsList(selectedCwd, undefined, this.remoteActiveSessionId(clientId)));
  }

  private refuseUnboundRemoteSession(clientId: string): void {
    const id = this.remoteClients.supersededSessionId(clientId);
    this.host.appendLine(`[remote] refused session-bound message (tab has no active conversation)`);
    this.sendRemoteClient(clientId, {
      type: "error",
      text: "This conversation is open in another tab. Continue here to take it back.",
      ...(id ? { resumeFailed: { id } } : {}),
      code: SESSION_SUPERSEDED_CODE,
    });
  }

  /**
   * Hand a live conversation from one remote tab to another. Same Session
   * object — no cold-load, no second ACP process. The desk `focused` pointer
   * is left alone so a claim of a desk-visible session co-attaches.
   *
   * Ownership moves synchronously: no await between deleteActive and setActive.
   */
  private transferRemoteResume(
    winnerId: string,
    target: Extract<RemoteResumeTarget, { kind: "conflict" }>,
    notifyCatalog: boolean,
  ): void {
    const { ownerId: loserId, session, selectedCwd } = target;
    const id = session.activeSessionId;
    if (!id || this.remoteClients.active(loserId) !== session || loserId === winnerId) {
      this.parkRemoteSession(winnerId, session);
      this.dropRemoteVoice(winnerId);
      this.focusRemoteSession(winnerId, session, notifyCatalog);
      return;
    }
    this.remoteClients.deleteActive(loserId, session);
    this.remoteClients.markRequiresExplicitSession(loserId, id);
    this.pool.add(session);
    this.parkRemoteSession(winnerId, session);
    this.dropRemoteVoice(winnerId);
    this.dropRemoteVoice(loserId);
    this.focusRemoteSession(winnerId, session, notifyCatalog);
    this.notifyRemoteSessionSuperseded(loserId, id, this.remoteClients.cwdIfPresent(loserId) ?? selectedCwd);
  }

  private notifyRemoteSessionSuperseded(clientId: string, id: string, selectedCwd: string): void {
    this.sendRemoteClient(clientId, {
      type: "error",
      text: "This conversation is now open in another tab. Continue here to take it back.",
      resumeFailed: { id },
      code: SESSION_SUPERSEDED_CODE,
    });
    this.sendRemoteClient(clientId, this.buildSessionsList(selectedCwd, undefined, undefined));
  }

  /**
   * First full boot pass: repo catalog plus the deferred session-list build
   * that ready/cold-boot schedule after it. "Warmed" means this pair finished,
   * not that postRepoCatalog has merely started.
   */
  private async runFirstBootScan(opts?: { deferSessions?: boolean }): Promise<void> {
    if (this.firstBootScanStarted || this.firstBootScanCompleted) return;
    this.firstBootScanStarted = true;
    this.postRepoCatalog();
    const finish = async () => {
      const hold = this.testCatalogHold;
      if (hold) {
        // Consume before awaiting so a resume that arrives in this window
        // waits on firstBootScanCompleted, not on the hold flag itself.
        this.testCatalogHold = undefined;
        hold.started();
        await hold.wait;
      }
      this.postSessionsList();
      this.completeFirstBootScan();
    };
    if (opts?.deferSessions) {
      setImmediate(() => { void finish(); });
      return;
    }
    await finish();
  }

  private completeFirstBootScan(): void {
    if (this.firstBootScanCompleted) return;
    this.firstBootScanCompleted = true;
    this.resolveFirstBootScan();
  }

  private async waitForCatalogWarmup(): Promise<void> {
    if (this.firstBootScanCompleted) return;
    if (!this.firstBootScanStarted) {
      void this.runFirstBootScan({ deferSessions: false });
    }
    await Promise.race([
      this.firstBootScanDone,
      new Promise<void>((resolve) => {
        setTimeout(resolve, GrokSidebar.FIRST_BOOT_SCAN_WAIT_MS);
      }),
    ]);
  }

  private findRemoteResumeTarget(clientId: string, id: string, sessionCwd?: string): RemoteResumeTarget {
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const selectedCwd = this.adoptRepoForRemoteSession(clientId, sessionCwd, overrides);
    const allowedCwds = this.sessionCwdsForRepo(selectedCwd, overrides);
    const conflictingOwner = this.remoteClients.clients().find((ownerId) =>
      ownerId !== clientId && this.remoteClients.active(ownerId)?.activeSessionId === id
    );
    if (conflictingOwner) {
      const session = this.remoteClients.active(conflictingOwner);
      if (session) return { kind: "conflict", selectedCwd, ownerId: conflictingOwner, session };
    }
    for (const session of this.pool) {
      if (session.activeSessionId === id && session.client) {
        if (!sessionCwdBelongsToRepo(this.sessionCwd(session), allowedCwds, pathsEqual)) {
          return { kind: "repo-mismatch", selectedCwd };
        }
        return { kind: "live", selectedCwd, session };
      }
    }
    const cachedCwd = this.sessionCache.get(id)?.entry.cwd;
    const resumeCandidates = orderedResumeCwdCandidates({
      messageCwd: sessionCwd,
      trustedCwds: allowedCwds,
      metaWorktreePath: overrides[id]?.worktreePath,
      cachedCwd: overrides[id]?.providerCwd ?? cachedCwd,
      sameCwd: pathsEqual,
    });
    const provider = overrides[id]?.provider ?? "grok";
    const actualCwd = provider && isAdapterProvider(provider)
      ? resumeCandidates.find((candidate) => allowedCwds.some((allowed) => pathsEqual(candidate, allowed)))
      : findSessionCatalogCwd({
          fs: defaultFs,
          grokHome: resolveGrokHome(process.env),
          id,
          candidates: resumeCandidates,
        });
    if (!actualCwd) return { kind: "missing", selectedCwd };
    return { kind: "disk", selectedCwd, actualCwd, provider };
  }

  private async openRemoteSession(
    clientId: string,
    id: string,
    sessionCwd?: string,
    notifyCatalog = true,
    explicitClaim = false,
  ): Promise<void> {
    // Same reason the local open owns its clock: a phone tapping a conversation
    // waits through the reservation, the repo adoption and the metadata reads
    // before `startSession` is reached, and a clock made down there reports
    // `resolve 0ms` however long that took.
    const clock = new OpenClock();
    const load = this.reserveSessionLoad(id, this.remoteClients.tabToken(clientId));
    if (!load) {
      const selectedCwd = this.remoteClients.cwd(clientId);
      this.host.appendLine(`[remote] dropped resumeSession (session load is reserved by another view)`);
      this.refuseRemoteResume(
        clientId,
        id,
        "Could not restore this conversation because it is already being opened in another tab or the VS Code view.",
        selectedCwd,
      );
      return;
    }
    if (load.joined) {
      this.host.appendLine(`[remote] joined in-flight session load for the same logical tab`);
      await load.reservation.completion;
      return;
    }
    let failure: unknown;
    try {
      await this.openRemoteSessionReserved(
        clientId, id, load.reservation, sessionCwd, notifyCatalog, clock, explicitClaim,
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.releaseSessionLoad(id, load.reservation, failure);
    }
    const opened = this.remoteClients.active(clientId);
    if (opened) this.sweepEmptySessions(this.sessionCwd(opened));
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
    clock?: OpenClock,
    explicitClaim = false,
  ): Promise<void> {
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
    let target = this.findRemoteResumeTarget(clientId, id, sessionCwd);
    // Retry only while the first boot pass could EXPLAIN the miss — a completed
    // catalog+session-list miss is genuine, and waiting again would just delay
    // the refusal. catalog-posted-but-list-still-deferred is still warming.
    if (target.kind === "missing" && !this.firstBootScanCompleted) {
      await this.waitForCatalogWarmup();
      // Re-resolve after the await: the requesting tab, reservation, and catalog
      // can all have moved. Thread the live Session object, not a captured id.
      if (!this.remoteClients.isCurrent(clientId)) return;
      const held = this.sessionLoadReservations.get(id);
      if (held?.token !== reservation.token) return;
      target = this.findRemoteResumeTarget(clientId, id, sessionCwd);
    }
    // Remote holders are mutually exclusive. The newest tab that EXPLICITLY
    // claims a conversation wins; a reconnect restore (no claim bit) still
    // refuses, so a thawing background tab cannot steal it back. The VS Code
    // view is NOT a rival tab — a session open (or parked) at the desk is
    // joined, not refused: emit() fans every frame to the focused webview and
    // to each remote holder, so the desk and the phone stay in sync.
    if (target.kind === "conflict") {
      const stillHeld = this.remoteClients.active(target.ownerId) === target.session
        && target.ownerId !== clientId;
      if (stillHeld && explicitClaim) {
        this.host.appendLine(`[remote] transferred resumeSession from ${target.ownerId} to ${clientId}`);
        this.transferRemoteResume(clientId, target, notifyCatalog);
        return;
      }
      if (stillHeld) {
        this.host.appendLine(`[remote] dropped resumeSession (session is open in another tab)`);
        this.refuseRemoteResume(
          clientId,
          id,
          "Could not restore this conversation because it is already open in another tab.",
          target.selectedCwd,
          SESSION_SUPERSEDED_CODE,
        );
        return;
      }
      this.parkRemoteSession(clientId, target.session);
      this.dropRemoteVoice(clientId);
      this.focusRemoteSession(clientId, target.session, notifyCatalog);
      return;
    }
    if (target.kind === "repo-mismatch") {
      this.host.appendLine(`[remote] dropped resumeSession (session cwd does not match selected repo)`);
      this.refuseRemoteResume(
        clientId,
        id,
        "Could not restore this tab's conversation because its repository is no longer selected or available.",
        target.selectedCwd,
      );
      return;
    }
    if (target.kind === "live") {
      this.parkRemoteSession(clientId, target.session);
      this.dropRemoteVoice(clientId);
      this.focusRemoteSession(clientId, target.session, notifyCatalog);
      return;
    }
    if (target.kind === "missing") {
      this.host.appendLine(`[remote] dropped resumeSession (session was not found in selected repo)`);
      this.refuseRemoteResume(
        clientId,
        id,
        "Could not restore this tab's previous conversation. It may have been deleted, or its repository may no longer be available. Start a new session explicitly to continue.",
        target.selectedCwd,
      );
      return;
    }
    const { selectedCwd, actualCwd, provider } = target;
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
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
    session.provider = provider;
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
    // Opening a named conversation is not an empty session. Mark it before
    // start so a failed spawn cannot later look "stranded" and be handed to
    // whichever provider just signed in.
    session.hasHistory = true;
    this.sendRemoteClient(clientId, { type: "clearMessages" });
    await this.startSession(id, session, "ensure", clock);
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
    // The user's open starts HERE, not in startSession. See the note there.
    const clock = new OpenClock();
    const claim = this.reserveSessionLoad(id);
    if (!claim) {
      this.host.appendLine(`[sessions] refused local resume (session load is reserved by another view)`);
      void this.host.showInformationMessage(
        "This conversation is already being opened in another tab or view.",
      );
      return;
    }
    let failure: unknown;
    try {
      // Claim before entering the workspace queue so a duplicate resume cannot
      // slip through while this transition waits for a repo switch already in
      // progress. The queued operation calls the exclusive switch primitive
      // directly; calling switchLocalWorkspaceFolder here would wait on the
      // same queue and deadlock the resume transition.
      const open = () => this.openSessionReserved(id, sessionCwd, clock);
      if (this.host.canSwitchWorkspaceFolder) {
        await this.localWorkspaceSwitchQueue.run(open);
      } else {
        await open();
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.releaseSessionLoad(id, claim.reservation, failure);
    }
    // Opening a conversation is the other moment the user is looking straight at
    // this repo's history — and the moment the session they just left became
    // abandonable. Only on success: a load that threw has told us nothing.
    this.sweepEmptySessions(this.sessionCwd(this.focused));
    // The history list follows the conversation the LOCAL user just opened.
    // With a rail in VS Code you can open one from another project, and leaving
    // the list on the old project meant reading a conversation from B while the
    // history beside it offered A's. Resolved through the catalog rather than
    // taken raw, because a worktree session's cwd is the worktree and the row
    // that owns it is the parent project.
    //
    // VS Code only. On desktop the selection and the ACTIVE FOLDER are one
    // thing — the file tree, New Session and the rail all read it — so moving
    // the selection without switching the folder would split them, and opening
    // a conversation is not a request to change which project you are in.
    // Desktop's own selectRepo does the whole switch; this is the half VS Code
    // needs because it has no folder to switch.
    if (this.host.canSwitchWorkspaceFolder) return;
    const openedIn = this.resolveLocalRepoTarget(this.sessionCwd(this.focused));
    if (openedIn && !pathsEqual(openedIn.cwd, this.selectedRepoCwd || "")) {
      this.selectedRepoCwd = openedIn.cwd;
      this.postRepoCatalog();
      this.postSessionsList();
    }
  }

  /**
   * Host-trusted directories that may hold a session catalog for local resume,
   * list, select, and desktop file authorization.
   *
   * **Desktop** (`canSwitchWorkspaceFolder`): exactly the configured open
   * folders plus worktrees authorized for sessions within them. The full
   * historical `discoverRepos` catalog is deliberately excluded — a closed
   * repo must not become a process cwd or widen {@link desktopAuthRoots}.
   *
   * **VS Code**: the full historical catalog (history can span any discovered
   * checkout under grok home). That is the v3.1.0 behaviour and must not regress.
   */
  private localTrustedSessionCwds(overrides: SessionMetaOverrides): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (cwd: string | undefined) => {
      if (!cwd) return;
      const key = normalizeRepoPath(cwd);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(cwd);
    };
    if (this.host.canSwitchWorkspaceFolder) {
      for (const repoCwd of this.openWorkspaceFolders()) {
        for (const c of this.sessionCwdsForRepo(repoCwd, overrides)) add(c);
      }
      // Active root as a backstop if the folders list is empty mid-init.
      add(this.workspaceRoot());
      return out;
    }
    // VS Code: full historical catalog.
    add(this.workspaceRoot());
    if (this.selectedRepoCwd) add(this.selectedRepoCwd);
    for (const repo of this.repoCatalog()) {
      for (const c of this.sessionCwdsForRepo(repo.cwd, overrides)) add(c);
    }
    return out;
  }

  /**
   * Move only the desktop view to the project represented by a resumed
   * session. A worktree cwd is authorized for the session but is not itself an
   * open workspace folder, so the file tree deliberately follows the
   * worktree's owning project root instead.
   *
   * `openSession` already owns localWorkspaceSwitchQueue while this runs. Keep
   * this on the exclusive path: taking the public queue wrapper here would
   * deadlock the resume transition.
   */
  private async followSessionWorkspace(session: Session): Promise<void> {
    if (!this.host.canSwitchWorkspaceFolder) return;
    const intendedTarget = session.worktree?.sourceGitRoot ?? session.cwd;
    if (!intendedTarget) {
      this.host.appendLine(
        "[sessions] skipped active-folder follow (resumed session has no project root)",
      );
      return;
    }
    // ONE resolution, always from the session's own cwd. A plain session's cwd
    // is itself an open folder and matches exactly; a worktree's resolves
    // through ownership, which declines when more than one open folder claims
    // it. Trying sourceGitRoot first would walk straight past that guard: with
    // both /repo and /repo/packages/app open, a worktree made from app records
    // /repo, so the exact match would move the panel — and every subsequent new
    // session's root — up to /repo without ever noticing the ambiguity.
    const target = session.cwd ? this.resolveLocalRepoTarget(session.cwd)?.cwd : undefined;
    if (!target) {
      this.host.appendLine(
        `[sessions] skipped active-folder follow (no single open folder owns ${intendedTarget})`,
      );
      return;
    }
    await this.switchLocalWorkspaceFolderExclusive(target, { warnOnRefusal: false });
  }

  private async openSessionReserved(id: string, sessionCwd?: string, clock?: OpenClock): Promise<void> {
    // A session held by a remote tab is not off-limits here: the desk JOINS it
    // — focusSession replays the shared buffer into the webview and already
    // mirrors the replay to remote holders, and emit() keeps serving both
    // views from then on.
    for (const s of this.pool) {
      if (s.activeSessionId === id && s.client) {
        await this.followSessionWorkspace(s);
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
    if (held) {
      // Keep the host-owned cwd on the held object. A forged resumeSession.cwd
      // must not re-home an existing process or widen desktopAuthRoots.
      // A held session whose folder was closed is no longer authorized — do not
      // adopt/restart it (startSession would also refuse; fail closed here).
      if (
        this.host.canSwitchWorkspaceFolder &&
        held.cwd &&
        !this.isAuthorizedCwd(held.cwd)
      ) {
        this.host.appendLine(
          `[sessions] refused held-session adopt (cwd not authorized): ${held.cwd}`,
        );
        void this.host.showInformationMessage(
          "Could not restore this conversation — its project folder is no longer open.",
        );
        await this.startSession();
        this.postRepoCatalog();
        return;
      }
      this.focused = held;
      this.pool.add(this.focused);
      await this.followSessionWorkspace(this.focused);
      await this.startSession(id, this.focused, "ensure", clock);
      this.markRead(this.focused);
      this.postRepoCatalog();
      return;
    }
    this.focused = this.newLocalSession();
    this.pool.add(this.focused);
    // Session cwd is resolved host-side from the on-disk catalog. The message
    // may name an id (and optionally a look-first cwd that must already be
    // trusted); it never supplies the process root.
    const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const o = overrides[id];
    this.focused.provider = o?.provider ?? "grok";
    const trustedCwds = this.localTrustedSessionCwds(overrides);
    const candidates = orderedResumeCwdCandidates({
      messageCwd: sessionCwd,
      trustedCwds,
      metaWorktreePath: o?.worktreePath,
      cachedCwd: o?.providerCwd ?? this.sessionCache.get(id)?.entry.cwd,
      sameCwd: pathsEqual,
    });
    const cwd = isAdapterProvider(this.focused.provider)
      ? candidates.find((candidate) => trustedCwds.some((trusted) => pathsEqual(candidate, trusted)))
      : findSessionCatalogCwd({
          fs: defaultFs,
          grokHome: resolveGrokHome(process.env),
          id,
          candidates,
        });
    if (!cwd) {
      this.host.appendLine(
        `[sessions] refused resumeSession (session ${id} not found under any trusted catalog cwd)`,
      );
      void this.host.showInformationMessage(
        "Could not restore this conversation. It may have been deleted. Starting a new session.",
      );
      await this.startSession();
      this.postRepoCatalog();
      return;
    }
    this.focused.cwd = cwd;
    if (o?.worktreePath && pathsEqual(o.worktreePath, cwd)) {
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
    await this.followSessionWorkspace(this.focused);
    // Same as the remote open: this id already has a conversation. startSession
    // resets hasHistory if the load actually runs; if the provider cannot
    // answer we return first, and this bit stops a later re-check from
    // retargeting the row onto a different agent.
    this.focused.hasHistory = true;
    await this.startSession(id, this.focused, "ensure", clock);
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
    this.editorWatcher = disposeAll(
      this.host.onDidChangeActiveTextEditor(() => this.refreshImplicitChip()),
      // Host already filters to the active editor (split editors that are not
      // active must not drive the context chip).
      this.host.onDidChangeActiveTextEditorSelection(() => this.refreshImplicitChip()),
    );
  }

  /** The remembered eye-off choice for the active-editor context chip (#67).
   *  Defaults to visible — this only ever reflects an explicit click. */
  private implicitChipHidden(): boolean {
    return this.state.get<boolean>(IMPLICIT_CHIP_HIDDEN_KEY, false);
  }

  /** Mirror the active editor (file + live selection line range) onto the
   *  implicit context chip. No-op diffing keeps this silent for plain cursor
   *  movement — selection events fire on every caret change, but an empty
   *  selection compares equal to the previous empty one, so nothing is posted.
   *  `forcePost` is for a fresh webview, which needs the current state even
   *  when it hasn't changed. */
  /**
   * The focused conversation's relative path for a file, or undefined when the
   * file does not really belong to it.
   *
   * Lexical containment first ({@link relativePathWithin}), then CANONICAL.
   * A symlink — or a Windows junction — inside project B pointing at project A
   * passes the lexical test as `linked/secret.ts`, because it genuinely is at
   * that path inside B. But `buildPrompt` opens the absolute path and reads
   * whatever is on the other end, so A's source would be embedded in B's
   * conversation under a name that looks like B's own. The remote file browser
   * has always resolved canonically for exactly this reason
   * (`resolveTreePath` in `file-tree.ts`); this fence has to as well.
   *
   * Unprovable means refused: if either side cannot be resolved (deleted,
   * permissions), there is no containment to demonstrate, and a chip is not
   * worth guessing about.
   */
  private conversationRelPath(absPath: string): string | undefined {
    const root = this.sessionCwd(this.focused);
    const lexical = relativePathWithin(root, absPath);
    if (lexical === undefined) return undefined;
    try {
      if (relativePathWithin(fs.realpathSync(root), fs.realpathSync(absPath)) === undefined) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    // The LEXICAL path is the label: it is where the user sees the file, and
    // rewriting it to the link target would name a project they did not open.
    return lexical;
  }

  private refreshImplicitChip(forcePost = false): void {
    const includeActive = this.host.getConfiguration("grok")
      .get<boolean>("includeActiveFileByDefault", true);
    const prev = this.chips.find(isImplicitChip);
    const editor = this.host.getActiveTextEditor();

    if (!includeActive || !editor || editor.document.uri.scheme !== "file") {
      // No chip to show — and if one is lingering, the webview must hear about
      // its removal (the old code cleared host-side but never posted).
      this.chips = clearImplicitChips(this.chips);
      if (prev || forcePost) this.postChips();
      return;
    }

    const absPath = editor.document.uri.fsPath;
    // The chip must belong to the CONVERSATION, not to the window.
    //
    // While VS Code history was pinned to the open folder these were the same
    // thing, so taking the active editor unconditionally was safe. It is not any
    // more: the rail can put a project-B conversation on screen while VS Code
    // still shows a project-A file. Sending then attached A's file — and for a
    // SELECTION, `buildPrompt` reads that absolute path and embeds A's source
    // text under an A-relative name — into B's prompt. Content crossing projects
    // is exactly the class this scope work exists to close.
    //
    // Also the source of the relative path now. `asRelativePath` resolves
    // against VS Code's workspace folders, and a project reached through the
    // rail is deliberately not one of them, so it would have handed back an
    // absolute path for a file that is perfectly ordinary inside its own repo.
    const relPath = this.conversationRelPath(absPath);
    if (relPath === undefined) {
      this.chips = clearImplicitChips(this.chips);
      if (prev || forcePost) this.postChips();
      return;
    }
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
    if (this.oauthShadowWarningShown || this.state.get<boolean>(OAUTH_SHADOW_WARNING_KEY, false)) return;
    this.oauthShadowWarningShown = true;
    void this.state.update(OAUTH_SHADOW_WARNING_KEY, true);
    void this.host.showWarningMessage(
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
      this.host.appendLine(`[env] loaded ${Object.keys(dotEnv).length} var(s) from .env`);
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

  /** Fetch-time revalidation for remote image handles (open-set + session media). */
  private isImagePathAuthorizedNow(imagePath: string): boolean {
    const authorized = this.authorizedSessionCwds();
    let home: string | undefined;
    try {
      home = resolveGrokHome(process.env);
    } catch {
      home = undefined;
    }
    return imagePathStillAuthorized(imagePath, authorized, {
      grokHome: home,
      sameCwd: pathsEqual,
      isTrustedGeneratedMedia: (p) => {
        try {
          return !!home && isTrustedGeneratedMediaPath(p, home, (c) => fs.realpathSync(c));
        } catch {
          return false;
        }
      },
    });
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
      if (!allowFromRemote(m.type, GrokSidebar.REMOTE_TIER, { isCloud: isCloudEnvironment() })) {
        this.host.appendLine(`[remote] dropped ${m.type} (not allowed from a remote client)`);
        return;
      }
      if (!allowRemoteRepoTarget(m, (cwd) => this.remoteTargetableCwd(cwd))) {
        this.host.appendLine(`[remote] dropped ${m.type} (cwd was not discovered)`);
        if (m.type === "listRepoSessions") {
          this.sendRemoteClient(clientId, {
            type: "repoSessions", cwd: m.cwd, entries: [], dots: {}, total: 0,
            error: "project-unavailable",
          });
        }
        return;
      }
      // Messages with no cwd still act on a bound session / client-selected
      // repo. A closed folder must revoke those ops even when allowRemoteRepoTarget
      // returns true (its default branch). selectRepo is the escape hatch to a
      // still-authorized target and is gated only by the message cwd above.
      if (m.type !== "selectRepo" && m.type !== "listRepoSessions") {
        const active = this.remoteClients.active(clientId);
        const boundCwd = active
          ? this.sessionCwd(active)
          : this.remoteClients.cwdIfPresent(clientId);
        // Fresh tab with no binding yet may still only call ready / list — if
        // it has a client cwd (after ready), that cwd must remain authorized.
        if (
          boundCwd !== undefined &&
          !remoteBoundCwdStillAuthorized(boundCwd, this.authorizedSessionCwds(), pathsEqual)
        ) {
          this.host.appendLine(
            `[remote] dropped ${m.type} (bound cwd no longer authorized: ${boundCwd})`,
          );
          this.sendRemoteClient(clientId, {
            type: "error",
            text: "That project folder is no longer open on the desktop. Select another project to continue.",
          });
          return;
        }
      }
      if (!this.remoteClients.isCurrent(clientId)) {
        this.host.appendLine(`[remote] dropped ${m.type} from a superseded tab connection`);
        this.sendRemoteClient(clientId, {
          type: "error",
          text: "This page's remote connection was replaced by another tab. Open AFK Pilot in a new tab to reconnect independently.",
        });
        return;
      }
      this.remoteClients.ready(clientId);
      if (remoteRequiresBoundSession(m.type) && !this.remoteClients.active(clientId)) {
        this.refuseUnboundRemoteSession(clientId);
        return;
      }
      const requester = this.captureRemoteRequester(clientId);
      const transition = async (currentClientId: string) => {
        if (m.type === "newSession") {
          await this.newRemoteSession(currentClientId);
        } else if (m.type === "resumeSession") {
          await this.openRemoteSession(currentClientId, m.id, m.cwd, true, m.claim === true);
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
        this.host.appendLine(`[remote] ${m.type} failed: ${detail}`);
        this.sendRemoteRequester(requester, {
          type: "error",
          text: `Grok: ${m.type} failed — ${detail}`,
        });
      });
    } catch (e) {
      this.host.appendLine(`[remote] dropped malformed frame: ${(e as Error)?.message ?? String(e)}`);
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
        this.host.appendLine(`[remote] handed tab ownership from ${superseded} to ${clientId}`);
      }
    }
    if (!this.remoteClients.isCurrent(clientId)) return;
    // A ready client has rebuilt its page and therefore has no live capture to
    // feed an older host ingress. Drop it before buildRemoteSnapshot inspects
    // remoteVoice, so reconnect cannot resurrect a host-only listening state.
    this.dropRemoteVoice(clientId);
    this.remoteClients.ready(clientId);
    // Empty default cwd (no desktop project yet) is not a bound repo. The
    // snapshot still goes out unbound; adopting/starting here would throw.
    if (!this.remoteClients.cwdIfPresent(clientId)) return;
    // A tab that lost this conversation to another tab's claim must not
    // adopt the desk session or mint a blank one on reconnect. The snapshot
    // below stays unbound; an automatic restore (no claim bit) then lands
    // in the taken-over state instead of stealing the conversation back.
    if (this.remoteClients.requiresExplicitSession(clientId) && !this.remoteClients.active(clientId)) {
      return;
    }
    const session = this.remoteSessionFor(clientId);
    if (session.client && !session.needsProvider) {
      this.restorePersistedDraft(session);
      this.restoreStrandedDraft(session);
    }
    // A tab attached to a session with no live process would sit on "Starting"
    // forever — nothing ever emits `initialized`, and the first send would
    // quietly spawn a DIFFERENT conversation. Bring the process up (resuming
    // its id when it has one, so a crashed/reaped conversation reloads its
    // own history). Deferred: the caller sends this client's snapshot
    // synchronously right after we return, and the start's frames must land
    // after it, not race it.
    if (!session.client) {
      // Enqueue on the tab tail immediately so a following send waits. The
      // 0-delay stays inside the action so the snapshot posted after we
      // return still lands first.
      void this.remoteClients.runSessionTransition(
        clientId,
        session.activeSessionId,
        async (currentClientId) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (this.remoteClients.active(currentClientId) !== session) return;
          if (session.client || this.startingForRemote.has(session)) return;
          this.startingForRemote.add(session);
          this.pool.add(session);
          try {
            const started = await this.startSession(session.activeSessionId, session, "ensure");
            if (
              started &&
              this.remoteClients.active(currentClientId) === session &&
              !session.needsProvider
            ) this.restoreStrandedDraft(session);
          } finally {
            this.startingForRemote.delete(session);
          }
        },
      );
    }
  }

  private static readonly DEVICE_TOKEN_SECRET = RELAY_DEVICE_TOKEN_SECRET;

  /**
   * The relay this build talks to — the production constant, unless a
   * DEVELOPMENT build names another in `GROK_RELAY_URL` (see resolveRelayUrl).
   *
   * Every consumer goes through here, including the two HTTP ones (the web
   * portal link and device unlink). Half the app on staging and half on
   * production would fail in a way that looks like a relay bug.
   */
  private relayUrl(): string {
    return resolveRelayUrl({
      isProduction: this.context.isProduction,
      env: process.env,
      cloudBuild: this.context.isCloudBuild,
    });
  }

  /** Start the relay uplink when a device token is stored (from the link flow).
   *  Idempotent. */
  private async maybeStartUplink(): Promise<void> {
    if (this.uplink) return;
    const token = await this.readDeviceToken();
    if (!token) return; // not linked yet — the link command starts the uplink itself
    const uplink = new RemoteUplink({
      relayUrl: this.relayUrl(),
      token,
      deviceName: deviceDisplayName(os.hostname(), process.platform, os.release()),
      client: {
        platform: process.platform,
        release: os.release(),
        appName: this.host.appName,
        isDesktop: this.host.remoteInstallIdSuffix === ":desktop",
        isCloud: isCloudEnvironment(),
      },
      snapshot: (clientId) => this.buildRemoteSnapshot(clientId),
      // Socket-level project gate — also covers the catch-up snapshot path,
      // which never enters deliverRemote.
      auth: {
        authorizedCwds: () => this.authorizedSessionCwds(),
        scopeCwdForClient: (clientId) => {
          const active = this.remoteClients.active(clientId);
          if (active) return this.sessionCwd(active);
          return this.remoteClients.cwdIfPresent(clientId);
        },
        // Repo fan-out uses selected cwd; session fan-out uses active session
        // cwd. Either counts as ownership of that scope (default ownership
        // only compares scopeCwdForClient, which is session-first).
        clientOwnsScope: (clientId, scopeCwd) => {
          const selected = this.remoteClients.cwdIfPresent(clientId);
          if (selected && pathsEqual(selected, scopeCwd)) return true;
          const active = this.remoteClients.active(clientId);
          if (active && pathsEqual(this.sessionCwd(active), scopeCwd)) return true;
          return false;
        },
        sameCwd: pathsEqual,
      },
      onClientReady: (clientId, tabToken) => this.handleRemoteClientReady(clientId, tabToken),
      onClientLeft: (clientId) => {
        this.releaseRemoteClient(clientId);
      },
      onClientRoster: (clientIds) => this.retainRemoteClients(clientIds),
      onCredentialRevoked: () => {
        void this.handleRemoteCredentialRevoked(token, uplink);
      },
      onClientMessage: (clientId, m) => this.handleRemoteMessage(clientId, m),
      log: (l) => this.host.appendLine(l),
    });
    this.uplink = uplink;
    uplink.start();
    this.refreshKeepAwake();
  }

  /**
   * Read the stored device token without failing startup when ciphertext is
   * undecryptable (keychain unavailable / key rotated). Returns undefined and
   * logs — treat as "not linked".
   */
  private async readDeviceToken(): Promise<string | undefined> {
    try {
      return await this.context.secrets.get(GrokSidebar.DEVICE_TOKEN_SECRET);
    } catch (e) {
      this.host.appendLine(
        `[remote] stored device token unreadable (treating as unlinked): ${(e as Error)?.message ?? e}`,
      );
      return undefined;
    }
  }

  private async handleRemoteCredentialRevoked(
    revokedToken: string,
    revokedUplink: RemoteUplink,
  ): Promise<void> {
    // A replaced/disposed uplink may deliver a late close event. Only the
    // currently-owned connection is allowed to clear the credential it used.
    if (this.uplink !== revokedUplink) return;
    const storedToken = await this.readDeviceToken();
    if (this.uplink !== revokedUplink || storedToken !== revokedToken) return;

    this.clearRemoteRuntime();
    this.post({ type: "remoteStatus", linked: false });
    try {
      await this.context.secrets.delete(GrokSidebar.DEVICE_TOKEN_SECRET);
    } catch (e) {
      this.host.appendLine(`[remote] failed to clear revoked device token: ${(e as Error)?.message ?? e}`);
      const retry = "Retry unlink";
      void this.host.showErrorMessage(
        "AFK Pilot access was revoked, but the stored device token could not be cleared.",
        retry,
      ).then((choice) => {
        if (choice === retry) void this.host.unlinkRemote();
      });
      return;
    }

    const relink = "Link this device again";
    void this.host.showWarningMessage(
      "AFK Pilot access for this device was revoked, so it has been unlinked. Link it again to continue remotely.",
      relink,
    ).then((choice) => {
      if (choice === relink) void this.host.linkRemote();
    });
  }

  private clearRemoteRuntime(): void {
    this.uplink?.dispose();
    this.uplink = undefined;
    this.stopVoiceInput();
    this.remoteClients.clear();
    this.refreshKeepAwake();
  }

  /** Re-assert the wake lock against linked / turn-in-flight / setting. Called
   *  after every event that can change those; both start and stop are
   *  idempotent, so callers never have to know the previous state. Wrapped
   *  because keeping the machine awake is never worth failing a link/unlink or a
   *  config change over. The opt-out key remains `grok.remote.keepAwake` (ships
   *  today) even though local turns are now covered too. */
  private refreshKeepAwake(): void {
    try {
      const enabled = this.host.getConfiguration("grok").get<boolean>("remote.keepAwake", true);
      const turnInFlight = this.anyTurnInFlight();
      // The remote twin of the OS wake lock below, and the one that matters in
      // the cloud: an OS wake lock cannot stop a hypervisor suspending the whole
      // machine, and a suspended machine takes the turn down with it. Not gated
      // on the opt-out — that setting is about a laptop's battery, and this
      // costs a few bytes a minute on a socket that is already open.
      try {
        // A device sign-in is WORK, even though no turn is running. The relay
        // holds a cloud machine awake only while frames keep arriving, and a
        // machine with nothing to say goes quiet, gets released after 90s and
        // is paused by the platform seconds later — killing the CLI's polling
        // connection mid-flow. cloud-environments.md recorded exactly that
        // ("a grok login --device-auth was left polling, the sprite paused,
        // and the login never completed"), and it is the likeliest cause of
        // the first Codex attempt that approved at the vendor and wrote no
        // credential. The phone is on another tab by then, so nothing else is
        // generating traffic either (owner, 2026-08-31).
        this.uplink?.setWorking(this.anyTurnWorking() || this.deviceLoginInFlight());
      } catch { /* never worth failing over */ }
      if (shouldKeepAwake({
        enabled,
        linked: !!this.uplink,
        turnInFlight,
        cloudHost: isCloudEnvironment(),
      })) {
        this.keepAwake.start();
      } else {
        this.keepAwake.stop();
      }
    } catch (e) {
      // Keeping a machine awake is never worth failing a caller over, and this
      // now runs from every path that answers a card — so the handler itself
      // must not throw either.
      try {
        this.host.appendLine?.(`[keep-awake] skipped: ${(e as Error)?.message ?? e}`);
      } catch { /* nothing left to say it with */ }
    }
  }

  /** "AFK Pilot: Link this device" — the device-code flow against the relay's REST
   *  edge: start a link, open the browser for the (mock for now) approval, poll
   *  until the relay hands back a long-lived device token, store it in secrets,
   *  connect. Mirrors how a CLI links to a web account. */
  async linkRemoteDevice(): Promise<void> {
    const base = httpBaseFromRelayUrl(this.relayUrl());
    try {
      // Already persisted by the time this returns — getOrCreate writes the file
      // synchronously — so a first-ever link cannot outrun persistence and needs
      // no second write. Re-writing it would only add a way to mark the key
      // degraded on a link. Desktop appends `:desktop` (host capability) so the
      // relay shares one device-cap slot with the same machine's VS Code install.
      const installId = formatRemoteInstallId(this.installId(), this.host.remoteInstallIdSuffix);
      const startBody = buildLinkStartBody({
        hostname: os.hostname(),
        platform: process.platform,
        release: os.release(),
        installId,
        appName: this.host.appName,
        isDesktop: this.host.remoteInstallIdSuffix === ":desktop",
        isCloud: isCloudEnvironment(),
      });
      const startRes = await fetch(`${base}/api/link/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Stable per install so the relay can relink this machine instead of
        // minting duplicate device rows for the same hostname. `name` stays the
        // legacy HOST (Windows 11) form; clientLabel/platform/osLabel are optional
        // extras for relays that render richer device rows.
        body: JSON.stringify(startBody),
      });
      if (!startRes.ok) throw new Error(`link/start ${startRes.status}`);
      const { code } = (await startRes.json()) as { code: string };
      void this.host.openExternal(`${base}/link?code=${encodeURIComponent(code)}`);
      const token = await this.host.withProgress(
        { title: `Approve this device in the browser (code ${code})…`, cancellable: true },
        (cancel) => this.pollLinkApproval(base, code, cancel),
      );
      if (!token) return; // cancelled / expired — poll loop already surfaced why
      await this.context.secrets.store(GrokSidebar.DEVICE_TOKEN_SECRET, token);
      this.uplink?.dispose();
      this.uplink = undefined;
      await this.maybeStartUplink();
      this.post({ type: "remoteStatus", linked: true });
      void this.host.showInformationMessage("Remote device linked — this workspace is now reachable from the web client.");
    } catch (e) {
      void this.host.showErrorMessage(`Remote link failed: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  private async pollLinkApproval(base: string, code: string, cancel: HostCancellationToken): Promise<string | undefined> {
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
        void this.host.showErrorMessage("Remote link code expired — run the link command again.");
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
    // working kill-switch, including when the OS keychain cannot decrypt the
    // stored ciphertext (get throws; delete still drops the bytes).
    const token = await this.readDeviceToken();
    if (token) {
      try {
        await fetch(`${httpBaseFromRelayUrl(this.relayUrl())}/api/device/unlink`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        this.host.appendLine(`[remote] server-side unlink failed (local unlink continues): ${(e as Error)?.message ?? e}`);
      }
    }
    try {
      await this.context.secrets.delete(GrokSidebar.DEVICE_TOKEN_SECRET);
    } catch (e) {
      this.host.appendLine(`[remote] failed to clear device token: ${(e as Error)?.message ?? e}`);
      void this.host.showErrorMessage(
        "Could not clear the stored device token. Try again, or remove it from OS secure storage.",
      );
      // Still tear the runtime down so the machine stops advertising.
    }
    this.clearRemoteRuntime();
    this.post({ type: "remoteStatus", linked: false });
    void this.host.showInformationMessage("Remote device unlinked.");
  }

  /** Tell the webview whether this machine holds a relay device token (drives
   *  the gear "AFK Pilot" section's sign-in vs account/sign-out items). */
  private async postRemoteStatus(): Promise<void> {
    const token = await this.readDeviceToken();
    this.post({ type: "remoteStatus", linked: !!token });
  }

  /** Ordered catch-up built from this client's cwd and active remote session. */
  private buildRemoteSnapshot(clientId: string): HostMsg[] {
    const cwd = this.remoteClients.cwdIfPresent(clientId) ?? "";
    // Live authorized set for this host — not "whatever the tab last selected".
    const authorized = this.authorizedSessionCwds();
    const listCwd = authorizedListCwd(cwd, authorized, pathsEqual);
    const demoted = this.remoteClients.requiresExplicitSession(clientId)
      && !this.remoteClients.active(clientId);
    const session = demoted
      ? undefined
      : cwd
        ? this.remoteSessionFor(clientId)
        : this.remoteClients.active(clientId);
    // Catalog is already open-folder-filtered on desktop; still the sole source.
    const entries = this.localRepoCatalogEntries();
    // Never put a closed cwd on the wire (choke point rejects it); empty = unbound.
    const initial = this.messageForRemote({ ...this.buildInitialStateMsg(), cwd: listCwd ?? "" });
    const sessionCwd = session ? this.sessionCwd(session) : "";
    const sessionCwdOk = !!session && !!authorizedListCwd(sessionCwd, authorized, pathsEqual);
    const snap: HostMsg[] = [];
    snap.push(initial);
    snap.push(this.providerStateMessage());
    snap.push(this.githubStateMessage());
    snap.push(this.mcpConnectorsMessage());
    const authorization = this.mcpConnectorAuthorizationMessage();
    if (authorization) snap.push(authorization);
    snap.push(this.mcpServersMessage());
    // SIXTH hand-written registry, and it is not the same one as
    // DEVICE_GLOBAL_REMOTE_TYPES. That set decides how a frame is ROUTED once
    // something posts it; this list decides whether a newly-connected browser
    // ever receives it at all. Both are needed and TypeScript enforces neither.
    //
    // Without these two, a phone came up with no tip facts and no project root:
    // every count read as unknown, the dismissed list read as empty, so a tip
    // the user had retired weeks ago came back on every empty screen and the
    // once-a-day rule never applied — the host was recording faithfully and
    // nobody was listening.
    snap.push(this.welcomeTipsMessage());
    snap.push(this.projectSetupMessage(this.githubProjectSetupExtra(clientId)));
    // A demoted tab already has a frozen transcript. clearMessages here would
    // wipe it on a same-page reconnect (mobile thaw). A rebuilt page starts
    // empty, so skipping the clear is a no-op there.
    if (!demoted) snap.push({ type: "clearMessages" });
    // Conversation buffer only when the bound session still lives under an
    // authorized cwd (revoke disposes doomed sessions; this is the belt).
    if (session && sessionCwdOk && !session.replaying) {
      snap.push(...bracketRemoteSnapshot(session.buffer));
    }
    if (session && sessionCwdOk) {
      snap.push(...sessionUiSnapshot(session, this.displayMode(session)));
    }
    if (session && sessionCwdOk && session.queuedSendRequiresRelay) {
      session.queuedSendDispatch = claimQueuedSendDispatch(
        session.queuedSendDispatch,
        this.queuedSendReadyText(session),
        () => randomUUID(),
      );
    }
    if (session && sessionCwdOk && session.queuedSendDispatch) {
      snap.push({ type: "submitQueuedSend", ...session.queuedSendDispatch });
    }
    const voiceCwd = sessionCwdOk ? sessionCwd : this.workspaceRoot();
    const voiceConfigured = !!this.resolveVoiceApiKey(voiceCwd);
    this.rememberVoiceConfigured(voiceCwd, voiceConfigured);
    const voicePayload = this.voiceConfiguredMsg(voiceCwd, voiceConfigured);
    this.seedPostedVoiceConfigured(`remote:${clientId}`, voicePayload);
    snap.push(voicePayload);
    const activeVoice = this.remoteVoice.get(clientId);
    if (activeVoice) {
      snap.push({ type: "voiceState", status: activeVoice.finalizing ? "transcribing" : "listening" });
    }
    // Scrubbed selected/active; entries are the open-folder catalog only.
    snap.push(this.buildRemoteReposMsg(clientId, entries));
    // buildSessionsList re-checks authorization (empty list if listCwd missing).
    snap.push(
      this.buildSessionsList(
        listCwd ?? "",
        undefined,
        sessionCwdOk ? this.remoteActiveSessionId(clientId) : null,
      ),
    );
    if (demoted) {
      const supersededId = this.remoteClients.supersededSessionId(clientId);
      snap.push({
        type: "error",
        text: "This conversation is now open in another tab. Continue here to take it back.",
        ...(supersededId ? { resumeFailed: { id: supersededId } } : {}),
        code: SESSION_SUPERSEDED_CODE,
      });
    }
    if (session && sessionCwdOk && session.activeSessionId) {
      snap.push({
        type: "sessionName",
        sessionId: session.activeSessionId,
        name: this.sessionDisplayName(session),
        cwd: sessionCwd,
      });
    }
    // Pins belong in the snapshot, not behind a `ready` handler: `ready` from a
    // remote is answered HERE and never reaches onMessage's switch, so anything
    // pushed from there would simply never arrive on a fresh tab or a reconnect.
    // buildPinnedSessions filters to the live authorized set.
    snap.push({ type: "pinnedSessions", ...this.buildPinnedSessions() });
    const out: HostMsg[] = [];
    for (const m of snap) {
      const t = transformHostMsgForRemote(m, this.remoteMediaDeps);
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * HTML for the primary-side-bar projects rail. Self-contained: does not load
   * chat.js (that would create a second chat client).
   */
  private getProjectsRailHtml(webview: HostWebview): string {
    const nonce = getNonce();
    const mediaUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "media", file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${mediaUri("projects-rail.css")}" />
</head>
<body>
  <aside id="projects-rail" class="projects-rail" aria-label="Projects">
    <div class="rail-search-wrap">
      <span class="rail-search-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </span>
      <input id="rail-search" class="rail-search" type="search" placeholder="Filter projects…" autocomplete="off" spellcheck="false" aria-label="Filter projects" />
    </div>
    <div id="rail-scroll" class="rail-scroll"></div>
  </aside>
  <script nonce="${nonce}" src="${mediaUri("webview-helpers.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("projects-rail.js")}"></script>
</body>
</html>`;
  }

  /**
   * Open the shared settings surface as a VS Code editor tab.
   *
   * Snapshot-on-open: the tab does not subscribe to live chat updates. Every
   * change still posts an existing set-/open- message, so the sidebar and
   * chat webview stay in sync through the same handlers the gear uses.
   */
  async openSettingsEditor(category?: string): Promise<void> {
    if (this.settingsEditor) {
      this.settingsEditor.reveal();
      if (category) {
        void this.settingsEditor.webview.postMessage({ type: "settingsCategory", category });
      }
      return;
    }
    const panel = this.host.openEditorWebview({
      viewType: "grok.settings",
      title: "Grok Settings",
      localResourceRoots: [
        Uri.joinPath(this.context.extensionUri, "media"),
        Uri.joinPath(this.context.extensionUri, "resources"),
      ],
    });
    if (!panel) return;
    this.settingsEditor = panel;
    panel.onDidDispose(() => {
      if (this.settingsEditor === panel) this.settingsEditor = undefined;
    });
    const token = await this.readDeviceToken();
    if (this.settingsEditor !== panel) return;
    panel.webview.html = this.getSettingsHtml(panel.webview, {
      remoteLinked: !!token,
      category,
    });
    panel.webview.onDidReceiveMessage((raw) => {
      const msg = raw as WebviewMsg;
      void this.onSettingsPanelMessage(msg).catch((e) => {
        const text = (e as Error)?.message ?? String(e);
        this.host.appendLine(`[settings] ${msg.type} failed: ${text}`);
      });
    });
  }

  private async onSettingsPanelMessage(msg: WebviewMsg): Promise<void> {
    if (!GrokSidebar.SETTINGS_PANEL_TYPES.has(msg.type)) {
      this.host.appendLine(`[settings] ignored ${msg.type}`);
      return;
    }
    await this.onMessage(msg, "local");
  }

  private getSettingsHtml(
    webview: HostWebview,
    opts: { remoteLinked: boolean; category?: string },
  ): string {
    const nonce = getNonce();
    const mediaUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "media", file));
    const cfg = this.host.getConfiguration("grok");
    const boot = {
      snapshot: {
        appPurpose: this.appPurpose() || DEFAULT_APP_PURPOSE,
        showThinking: cfg.get("showThinking", false),
        expandCommandOutputs: cfg.get("expandCommandOutputs", false),
        steerByDefault: cfg.get("steerByDefault", false),
        fontScale: this.chatFontScale(),
        soundNotifications: cfg.get("soundNotifications", false),
        processingSound: cfg.get("processingSound", false),
        readRepliesAloud: cfg.get("readRepliesAloud", false),
        summarizeRepliesAloud: cfg.get("summarizeRepliesAloud", true),
        voiceConfigured: this.lastVoiceConfiguredByCwd.get(
          normalizeRepoPath(this.workspaceRoot() || ""),
        ) === true,
        voiceSendPhrase: this.voiceSetting(
          this.workspaceRoot(),
          "voiceSendPhrase",
          DEFAULT_SEND_PHRASE,
        ),
        voiceKeyterms: sanitizeVoiceKeyterms(
          this.voiceSetting(this.workspaceRoot(), "voiceKeyterms", []),
        ),
        telemetryEnabled: cfg.get("telemetry.enabled", true),
        thumbsFeedback: cfg.get("thumbsFeedback", false),
        providers: this.providerStateMessage().providers,
        providersChecking: this.providerRefreshInFlight,
        githubState: this.githubStatePayload(),
        extVersion: this.context.extensionVersion,
        cliVersion: this.providerCliVersions.grok || "",
        hostKind: "extension" as const,
        hostName: deviceDisplayName(os.hostname(), process.platform, os.release()),
        grokUpdate: null,
        mcpServers: this.mcpServersView,
        mcpLoading: false,
        mcpError: "",
        mcpWarning: MCP_GLOBAL_SCOPE_WARNING,
        mcpConnectors: this.mcpConnectorsMessage().connectors,
      },
      category: opts.category || "general",
      env: {
        isRemote: false,
        isDesktop: false,
        clientOwnsFontScale: false,
        steerSupported: true,
        providersKnown: true,
        remoteLinked: opts.remoteLinked,
        hostCaps: {
          relocateView: this.host.canRelocateView,
          secondarySideBar: this.host.canUseSecondarySideBar,
          showOutput: this.host.canShowOutput,
          toggleDevTools: this.host.canToggleDevTools,
          settingsEditor: true,
          ...(this.host.canShowMcpSettings ? { mcpSettings: true } : {}),
        },
      },
    };
    const bootJson = JSON.stringify(boot).replace(/</g, "\\u003c");
    return `<!DOCTYPE html>
<html lang="en" class="settings-page">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${mediaUri("settings.css")}" />
<title>Grok Settings</title>
</head>
<body class="settings-page">
  <div id="settings-root"></div>
  <script nonce="${nonce}">window.__grokSettingsBoot = ${bootJson};</script>
  <script nonce="${nonce}" src="${mediaUri("settings.js")}"></script>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var boot = window.__grokSettingsBoot || {};
      var tts = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
      var surface = window.GrokSettings.mount(document.getElementById("settings-root"), {
        snapshot: boot.snapshot,
        env: Object.assign({ ttsAvailable: tts }, boot.env || {}),
        post: function (msg) { vscode.postMessage(msg); },
        standalone: true,
        category: boot.category,
        onClose: function () { vscode.postMessage({ type: "closeSettingsSurface" }); }
      });
      window.addEventListener("message", function (e) {
        var msg = e.data;
        if (!msg || !msg.type || !surface) return;
        if (msg.type === "grokUpdateStatus") {
          var next = { grokUpdate: {
            current: msg.current, latest: msg.latest,
            updateAvailable: !!msg.updateAvailable, error: msg.error || null,
            policy: msg.policy || null,
          } };
          if (msg.current) next.cliVersion = msg.current;
          surface.update(next);
        }
        if (msg.type === "providerState" && Array.isArray(msg.providers)) {
          surface.update({ providers: msg.providers, providersChecking: msg.checking === true });
        }
        if (msg.type === "githubState" && msg.github) {
          surface.update({ githubState: msg.github });
        }
        if (msg.type === "mcpServers") {
          surface.update({
            mcpServers: Array.isArray(msg.servers) ? msg.servers : [],
            mcpLoading: msg.loading === true,
            mcpError: msg.error || "",
            mcpWarning: msg.warning || "",
          });
        }
        if (msg.type === "mcpConnectors") {
          surface.update({
            mcpConnectors: Array.isArray(msg.connectors) ? msg.connectors : [],
          });
        }
        if (msg.type === "routines") {
          surface.update({
            routines: Array.isArray(msg.entries) ? msg.entries : [],
            routineProjects: Array.isArray(msg.projects) ? msg.projects : [],
            routineModels: Array.isArray(msg.models) ? msg.models : [],
            routineError: msg.error || "",
            routineErrorId: msg.errorId || "",
          });
        }
        if (msg.type === "error") {
          // Same reason as chat.js: a quota-refused save never reaches the host,
          // so the relay's bounce is the only answer the page will get.
          surface.update({ routineError: msg.text || "", routineErrorId: "" });
        }
        if (msg.type === "settingsCategory" && msg.category) surface.setCategory(msg.category);
      });
    })();
  </script>
</body>
</html>`;
  }

  private getHtml(webview: HostWebview): string {
    const nonce = getNonce();
    // Join under extensionUri so remote hosts keep vscode-remote:// (Uri.file
    // on extensionPath.fsPath would point the webview at a missing local path).
    const mediaUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "media", file));
    const resourceUri = (file: string) =>
      webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, "resources", file));

    // Desktop multi-folder: host ships the rail mount. VS Code never does —
    // absence of `#projects-rail` is the property that keeps the extension's
    // chat column free of an in-panel rail (the projects view is a separate
    // primary-side-bar webview). A `repos` frame still arrives for clear-all.
    // Chrome mirrors AFK Pilot: brand + panel toggle, search, scroll, footer
    // theme toggle (no account avatar). chat.js only empties #rail-scroll.
    const railMark = this.host.canSwitchWorkspaceFolder
      ? resourceUri("grok-icon.svg")
      : "";
    const railMount = this.host.canSwitchWorkspaceFolder
      ? `
  <aside id="projects-rail" class="projects-rail" aria-label="Projects">
    <div class="rail-top">
      <span class="rail-brand" title="Grok Build Desktop">
        <span class="mark" style="--rail-mark:url('${railMark}')" aria-hidden="true"></span>
        <span class="wordmark"><b>Grok</b> <span class="dim">Build</span></span>
      </span>
      <button id="desk-rail-toggle" class="rail-icon-btn" type="button" title="Hide projects" aria-label="Hide projects" aria-expanded="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
      </button>
    </div>
    <div class="rail-search-wrap">
      <span class="rail-search-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      </span>
      <input id="rail-search" class="rail-search" type="search" placeholder="Filter projects…" autocomplete="off" spellcheck="false" aria-label="Filter projects" />
    </div>
    <div id="rail-scroll" class="rail-scroll"></div>
    <div class="rail-foot">
      <div class="rail-user" aria-hidden="true"></div>
      <button id="rail-gear-btn" class="rail-icon-btn" type="button" title="Settings" aria-label="Settings" hidden></button>
      <button id="desk-theme-toggle" class="rail-icon-btn" type="button" title="Toggle theme" aria-label="Toggle light and dark theme">
        <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12H5M19 12h2.5M4.2 19.8L6 18M18 6l1.8-1.8"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.2 6.2 0 0 0 10.5 10.5z"/></svg>
      </button>
    </div>
  </aside>`
      : "";
    const openMain = this.host.canSwitchWorkspaceFolder ? `<div class="app-main">` : "";
    const closeMain = this.host.canSwitchWorkspaceFolder ? `</div>` : "";
    // Files shell is in the first HTML frame so desktop never paints the
    // panel-less column and then upgrades. Inject reuses this node.
    const fileShellOpen = this.host.canSwitchWorkspaceFolder
      ? `<div id="desk-ft-shell" class="desk-ft-shell"><div class="desk-ft-chat">`
      : "";
    const fileShellClose = this.host.canSwitchWorkspaceFolder ? `</div></div>` : "";
    const deskLayoutClass = this.host.canSwitchWorkspaceFolder ? " has-rail desk-with-ft" : "";
    const firstFrameLayout = this.host.canSwitchWorkspaceFolder
      ? `
  body.desk.has-rail { display: flex; flex-direction: row; align-items: stretch; }
  body.desk.has-rail #projects-rail { width: var(--rail-width, 260px); flex-shrink: 0; height: 100%; display: flex; flex-direction: column; }
  body.desk.has-rail .app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  body.desk.has-rail .desk-ft-shell { display: flex; flex: 1 1 auto; flex-direction: row; min-width: 0; min-height: 0; height: 100%; }
  body.desk.has-rail .desk-ft-chat { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; }`
      : "";
    // The shared file-panel asset is desktop-only in this generated document.
    // Remote browsers load it from the relay's own web/chat.html; VS Code gets
    // neither the tag nor the bytes, making the no-file-panel decision structural.
    const filePanelStyle = this.host.canSwitchWorkspaceFolder
      ? `<link rel="stylesheet" href="${mediaUri("file-panel.css")}" />`
      : "";
    // The highlighter rides the same gate and MUST precede the panel: the panel
    // reads `GrokSyntaxHighlight` at render time, and a missing global there
    // silently degrades every file to plain text rather than failing loudly.
    const filePanelScript = this.host.canSwitchWorkspaceFolder
      ? `<script nonce="${nonce}" src="${mediaUri("syntax-highlight.js")}"></script>\n` +
        `  <script nonce="${nonce}" src="${mediaUri("file-panel.js")}"></script>`
      : "";

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
${firstFrameLayout}
</style>
<link rel="stylesheet" href="${mediaUri("chat.css")}" />
<link rel="stylesheet" href="${mediaUri("settings.css")}" />
${filePanelStyle}
</head>
<body class="desk${deskLayoutClass}${this.showThinking() ? "" : " thinking-hidden"}" style="--chat-zoom: ${this.chatFontScale()}">
${this.host.canSwitchWorkspaceFolder ? `<script nonce="${nonce}">try{if(localStorage.getItem("desk-rail-open")==="0")document.body.classList.add("desk-rail-collapsed")}catch(e){}</script>` : ""}
${railMount}
${openMain}
  <header class="top-bar">
    <div id="session-name-chip" class="session-name-chip" hidden>
      <button id="session-name-label" class="session-name-label" type="button"></button>
      <!-- Which project this conversation belongs to. History went
           multi-workspace, so the open conversation is no longer necessarily
           from the folder VS Code has open, and the name alone stopped saying
           where you are. Same treatment the rail gives its cross-project rows. -->
      <span id="session-name-repo" class="session-name-repo" hidden></span>
      <button id="session-name-edit" class="session-name-edit icon-btn" type="button" hidden></button>
    </div>
    <button id="repo-btn" class="repo-chip" type="button" title="Choose repository"></button>
    <button id="remote-btn" class="icon-btn remote-btn" title="Continue remotely" hidden></button>
    <button id="history-btn" class="icon-btn" title="Session history"></button>
    <button id="new-btn" class="icon-btn" title="New session"></button>
    ${this.host.canSwitchWorkspaceFolder ? `<div id="session-head-actions"></div>` : ""}
    ${this.host.canSwitchWorkspaceFolder ? "" : `<div id="vscode-session-actions"></div>`}
    <div id="repo-popover" class="toolbar-popover repo-popover" hidden></div>
    <div id="history-popover" class="toolbar-popover history-popover" hidden></div>
  </header>
${fileShellOpen}
  <main id="messages" class="messages">
    <div class="welcome" id="welcome">
      <span class="welcome-mark" role="img" aria-label="Grok" style="--welcome-mark:url('${resourceUri("grok-icon.svg")}')"></span>
      <h2>${isCloudEnvironment() ? "AFK Pilot (Cloud)" : "Grok Build (Community)"}</h2>
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
${fileShellClose}
${closeMain}

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
  <script nonce="${nonce}" src="${mediaUri("settings.js")}"></script>
  ${filePanelScript}
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
