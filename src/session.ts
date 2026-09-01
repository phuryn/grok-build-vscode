import { AcpClient } from "./acp";
import type { HostMsg } from "./protocol";
import type { FileChip } from "./chips";
import { permissionOptionsForPlan } from "./plan-gate";
import type { AcpProvider } from "./acp-backend";
import {
  queuedSendsMessage,
  takeQueuedSendsPrefix,
  type QueuedSendEntry,
} from "./queued-send";

/** Live state for the dashboard dot. `cold` (no live process) is represented by
 *  the absence of a Session, so it isn't in this union. */
export type SessionStatus = "idle" | "working" | "needs-you" | "done" | "error";

export interface PendingPermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

export interface PendingPermission {
  title: string;
  toolCallId?: string;
  toolKind?: string;
  /** Adapter plan-review text, when the permission carried one. */
  plan?: string;
  /** Full option set offered by the CLI. */
  options: PendingPermissionOption[];
  /** Subset safe to expose while the client-side Plan gate remains active. */
  planOptions: PendingPermissionOption[];
}

export interface PendingExitPlan {
  planText: string;
}

/** A submitted plan comment owned by one live ACP process until its interject
 * response arrives. This is intentionally memory-only; process exit hands the
 * text to the ordinary queue/composer recovery path. */
export interface InFlightPlanComment {
  text: string;
  client: AcpClient;
  gen: number;
}

export function createPendingPermission(
  input: Omit<PendingPermission, "planOptions">,
): PendingPermission {
  return {
    ...input,
    planOptions: permissionOptionsForPlan(input.options, true, input.toolKind),
  };
}

export function pendingPermissionOptions(
  pending: PendingPermission,
  planActive: boolean,
): PendingPermissionOption[] {
  return planActive ? pending.planOptions : pending.options;
}

export function preferredPermissionAllowOption(
  pending: PendingPermission,
  planActive: boolean,
): PendingPermissionOption | undefined {
  const options = pendingPermissionOptions(pending, planActive);
  return options.find((option) => option.kind === "allow_always")
    ?? options.find((option) => option.kind === "allow_once");
}

/**
 * All state that belongs to a single grok session — extracted from GrokSidebar so
 * the sidebar can hold a *pool* of these (one live `grok agent stdio` process per
 * session) and switch focus between them without tearing the others down.
 *
 * Today the sidebar keeps exactly one of these (the focused session). Steps C–F
 * add the pool, a per-session generation guard (`gen`), the webview post buffer,
 * and a derived `status` for the dashboard dots. For now this is a pure state bag
 * so the extraction is behavior-preserving (the field set + defaults mirror the
 * singletons it replaces 1:1).
 */
export class Session {
  /** Provider is fixed once the first user turn enters history. */
  provider: AcpProvider = "grok";
  /** Host-owned composer attachments for this session/view. */
  chips: FileChip[] = [];
  /** The live ACP client (one spawned `grok agent stdio` process), once started. */
  client?: AcpClient;

  /** YOLO: auto-approve every permission request for this session. */
  autoApprove = false;

  /** Plan-mode gate is up for this session (client-side enforcement mirror). */
  planActive = false;

  /** Whether this session's CLI is new enough for native plan verdicts. */
  planModeAvailable = true;
  planModeUnavailableReason?: string;
  /**
   * True only after a live `grok --version` produced a parseable answer.
   * A cache substitute may keep Plan available but stays unverified so a later
   * live probe can replace it. Unverified + unavailable stays fail-closed for
   * Plan but is re-checkable when the user picks Plan. A live below-floor
   * answer keeps this true so we never re-ask a known-old CLI.
   */
  planModeVersionVerified = true;

  /** Latest attempt to force an unavailable Plan session back to Agent. */
  planModeRecoveryAttempt = 0;

  /** Two-phase unavailable-Plan recovery. The write gate may drop only after
   * both the forced Agent mode change and any live planning turn have settled. */
  planModeRecovery?: {
    attempt: number;
    modeConfirmed: boolean;
    turnSettled: boolean;
    warningTimer?: ReturnType<typeof setTimeout>;
  };

  /** This session has conversational history (vs. a fresh, empty one). */
  hasHistory = false;

  /** True for the session-start window (spawn → newSession/load). Model/effort
   * changes that would race startup are ignored; the webview also locks busy. */
  priming = false;

  /** Drop streaming content from hidden summary/context-injection turns. */
  suppressContent = false;

  /** Captures the legacy hidden `/session-info` reply without rendering it. */
  captureAgentText?: string;

  /** Last successful `_x.ai/session/info` snapshot, for the popover TTL. */
  lastSessionInfoAt = 0;
  /** `used` from that snapshot — occupancy that moves off it is stale. */
  lastSessionInfoUsed?: number;
  /** Live occupancy moved off the last session/info snapshot. */
  sessionInfoStale = false;

  /** Latched after this process returns -32601 for `_x.ai/session/info`. */
  sessionInfoUnsupported = false;

  /**
   * Grok thumbs (#114). Off until `session/new` `_meta.feedbackEnabled` or an
   * advertised `feedback` command says otherwise. `feedbackUnsupported` latches
   * a -32601 / disabled-feedback RPC so the buttons cannot come back on this
   * process. Thumbs rate only the turn that just finished in this process
   * (`liveFeedbackEligible`); `turnRating` is that footer's local UI state.
   */
  feedbackAvailable = false;
  feedbackUnsupported = false;
  feedbackMetaEnabled?: boolean;
  feedbackCommandsAdvertise?: boolean;
  liveFeedbackEligible = false;
  turnRating: 0 | 1 | -1 = 0;

  /** A live compact notification already supplied this manual compact's count. */
  sawCompactNotification = false;

  /**
   * True when an `auto_compact_failed` notification arrived for the CURRENT
   * manual /compact (reset before each). Gates the
   * "Compacted." confirmation so a failed compaction doesn't paint a false
   * success next to the failure note.
   */
  sawCompactFailed = false;

  /**
   * Guards the one-shot expired-token auto-recovery: set when a turn's auth-like
   * error triggers a transparent process reload + resend, so a second failure
   * (genuinely dead auth or real billing) surfaces the error / re-login prompt
   * instead of looping. Reset on any turn that completes successfully, re-arming
   * recovery for a later token expiry.
   */
  authRecoveryTried = false;

  /** Live permission requests awaiting an answer, by request id. Set when the
   *  card is shown, read when the user answers so we can persist the resolved
   *  card (title + outcome) for replay on a resumed session, then deleted. */
  pendingPermissions = new Map<number | string, PendingPermission>();

  /** Most recent plan text seen for this session (exit_plan_mode fallback). */
  lastPlanText = "";

  /** Live exit_plan_mode requests awaiting one answer, keyed by ACP request id. */
  pendingExitPlans = new Map<number | string, PendingExitPlan>();

  /**
   * Live question requests awaiting an answer, by ACP request id.
   *
   * Tracked for the same reason as the two maps beside it: answering one card
   * does not resume a turn that another card is still blocking. Questions had
   * no record at all, so answering a plan review while a question was still up
   * looked like "nothing outstanding" — the session was marked working, the
   * agent stayed blocked, and on a rented machine the heartbeat that follows
   * `working` kept it awake and billing indefinitely.
   */
  pendingQuestions = new Set<number | string>();

  /** Submitted plan comments still awaiting `_x.ai/interject` acceptance. */
  inFlightPlanComments = new Map<number | string, InFlightPlanComment>();

  /** Accepted mid-turn interjections in this session. This is the secondary
   * replay coordinate for multiple native plan reviews inside one prompt. */
  interjectionCount = 0;

  /** Number of replay-stable assistant update events observed in this session.
   * Persisted records use this common boundary to order plans, permissions, and
   * usage inside a turn rather than waiting for the next user message. */
  historyEventCount = 0;

  /** Accumulator used to classify replayed user-message chunks even when the
   * CLI splits the interjection envelope across updates. */
  replayUserRaw = "";
  replayUserCounted = false;
  replayUserIsInterjection = false;

  /**
   * Count of user messages that have entered this session (replayed + live).
   * Persisted on each resolved plan as `afterUserMessage` so the resume view
   * can render plan cards inline with the conversation rather than at the end.
   */
  userMessageCount = 0;

  /**
   * True while a sequence of user_message_chunk events is mid-flight, so we
   * only increment userMessageCount once per user message during replay.
   */
  inUserMessage = false;

  /**
   * True only while replaying a resumed session (session/load). grok ≥0.2.33
   * echoes the *live* prompt back as user_message_chunk too, so this gates the
   * handler to replay-only — the live bubble already comes from send().
   * Boolean on purpose: remotes must not see a partial transcript whenever
   * *any* load is in progress (`runExclusiveHistoryLoad`).
   */
  replaying = false;

  /**
   * Exclusive in-flight history load (`replayLoadedHistory`). A second load on
   * this session joins this promise instead of starting another `session/load`,
   * so the first-to-finish cannot clear `replaying` while the other is still
   * going. Settles with the owner's outcome (rejects on failure).
   */
  loadInFlight?: Promise<void>;

  /**
   * Next Claude/Codex `usage_update.used` is getContextUsage occupancy, not
   * the billed per-call sum. Armed only after a compact *completed* so a
   * leftover mid-compact usage_update cannot overwrite the conversation.
   */
  compactUsageArmed = false;

  /** This turn is a Claude/Codex compaction — usageLog records the reset. */
  adapterCompactThisTurn = false;

  /**
   * This turn's `usage_update.used` values. Claude's prompt-result usage
   * is a SUM; occupancy is the max of these (`occupancyFromAdapterTurn`).
   */
  adapterTurnCallUsed: number[] = [];

  /** grok's id for this session (set on session/new or session/load). */
  activeSessionId?: string;

  /**
   * Effective working directory for this session's `grok agent stdio` process.
   * Usually the workspace root; for a worktree-isolated session (P2-8) this is
   * the worktree path under `~/.grok/worktrees/…`. Pinned at startSession —
   * history reopen must reuse the same cwd so `session/load` finds the dir.
   */
  cwd?: string;

  /**
   * When this session runs inside an isolated git worktree, the worktree's
   * path/label/source root. Drives Apply/Remove and the history badge.
   */
  worktree?: { path: string; label: string; sourceGitRoot: string; id?: string };

  /**
   * Last `[Image #N]` handed to a chip in this staging generation (`0` = idle).
   * `allocateImageIndex` increments it at attach and resets only when nothing
   * is staged (composer empty and queue empty), so a plain send starts at `#1`
   * while a chip shown as `#2` keeps `#2` after an earlier image flushes.
   */
  imageIndexHighWater = 0;

  titleGenerated = false;
  firstUserMessageForTitle?: string;

  /**
   * Per-session generation counter — bumped only when THIS session's client is
   * torn down/restarted. Replaces the old global `sessionGen`: in a pool a
   * backgrounded session's in-flight events must not be judged "stale" just
   * because focus moved to another session, so each session guards its own
   * events against its own gen (captured when its handlers were wired).
   */
  gen = 0;

  /**
   * True when this generation already told the user an in-flight send was
   * abandoned. Cancel recovery emits first; a later stale-generation bail
   * must not add a second interruption.
   */
  staleSendReported = false;

  /** Derived status for the dashboard dot (see SessionStatus). */
  status: SessionStatus = "idle";

  /**
   * The prompt currently in flight, or undefined when none is. A token rather
   * than a boolean so a settlement can prove WHICH turn it is settling — a
   * cancel-recovery and the real promise can both come back, and only the first
   * of them may end the turn.
   *
   * It exists because `status` was standing in for this and could not do the
   * job. Status is set to "working" beside the prompt and only leaves it when
   * that promise settles, so a cancel the CLI never answered left the session
   * "working" forever — and `turnInFlight` then diverted every later send in
   * that session into the queue instead of sending it, permanently, with
   * nothing on disk to show for it and only a window reload as a cure. Status
   * now describes the dot; this describes the turn.
   */
  turnToken: object | undefined = undefined;

  /** ms-epoch stamped by {@link beginTurn} — the wall clock a turn's footer
   *  duration is measured from. Deliberately NOT cleared by `endTurn`: the
   *  turn-ending emit sites read it right after the token settles. The next
   *  beginTurn overwrites it. */
  turnStartedAt: number | undefined = undefined;

  /** `_meta.agentTimestampMs` of the most recent replayed user message — the
   *  start edge a restored turn's footer duration is measured from when the
   *  persisted rail carries no explicit duration_ms. Set by the session/load
   *  userMessageChunk replay path; read by the replayed turn_completed. */
  replayTurnStartedAt: number | undefined = undefined;

  /**
   * ms-epoch of the last time this session was made the focus, created, or put to
   * work — its "recency" for the pool's LRU/TTL reaping (see session-pool.ts).
   * 0 until the sidebar touches it (kept off the constructor so this stays a pure
   * state bag — the host stamps it via `touch`).
   */
  lastActiveAt = 0;

  /**
   * Every webview post that built this session's current view, in order. The
   * focused session flushes straight to the webview; a backgrounded session
   * buffers here, so re-focusing replays the buffer (clearMessages + replay)
   * to reconstruct the view losslessly — no grok reload, no process kill.
   */
  buffer: HostMsg[] = [];

  /**
   * Pending follow-ups composed while THIS session was busy (typed Enter-sends
   * and dictated utterances), awaiting turn end. Each entry keeps the text AND
   * the attachments snapshotted at queue time, so a later composer edit cannot
   * silently drop them. Entries are the source of truth (`""` is image-only).
   * The flush still sends them as ONE combined prompt
   * (`buildQueuedPromptWithImages`): each chip keeps the `[Image #N]` it was
   * shown at attach (`allocateImageIndex`); authored text is copied verbatim.
   * Host-owned per session — the webview renders a mirror from `queuedSends`
   * snapshots, so it survives focus switches and flushes even while backgrounded.
   */
  queuedSends: QueuedSendEntry[] = [];

  /**
   * Remote-only dequeue handshake. While set, the host has asked the owning
   * browser to echo this claimed submission through the relay, but has not
   * positively acknowledged its metered frame yet.
   */
  queuedSendDispatch?: { id: string; text: string };

  /** A queued send that has reached the host but not yet reached handleSend's
   * commit point. The queue remains authoritative until this claim commits.
   *
   * Known limitation: the commit point precedes `client.prompt()`. That promise
   * resolves at TURN COMPLETION, not request acceptance, so moving the commit
   * after it would keep already-executing text flushable for the whole turn.
   * Restoring on a rejected prompt result can also execute a partially accepted
   * prompt twice. Do not widen this window without an ACP acceptance signal or
   * an explicit retained-prefix state plus a proven never-executed classifier. */
  queuedSendCommit?: { text: string; items: QueuedSendEntry[] };

  /** Recently accepted dequeue ids. Delayed outbox copies are ignored even
   * after the active dispatch has been retired. Bounded per live session. */
  completedQueuedSendIds: string[] = [];

  /** True when this queue originated in AFK Pilot and therefore must return
   * through the relay's metered `send` path, even across a disconnected tab.
   *
   * Known limitation: if the relay accepts a dequeue but local preflight
   * (for example, reading an attachment) fails, retrying the retained queue is
   * metered again. Avoid changing this until the queue can distinguish an
   * already-metered prefix from newly appended, unmetered text; conflating the
   * two risks duplicate delivery or work loss. */
  queuedSendRequiresRelay = false;

  /**
   * This view was re-homed onto a replacement while NO provider was connected,
   * so it is bound to no agent yet. Binding it to the opposite (also
   * disconnected) provider is what this replaces: that produced a session no
   * amount of signing in could ever drive, because reconnecting retargeted only
   * whichever session the recheck happened to arrive on. Reconnecting any
   * provider adopts every session carrying this flag.
   */
  needsProvider = false;

  /**
   * The draft rescued from the conversation this replacement stands in for,
   * held until there is a working composer to put it back into. Restoring it at
   * sign-out time would post it into a view that is showing the onboarding
   * overlay, where the user cannot see it and a reload discards it.
   */
  strandedDraft?: string;

  /** Conversation whose META holds {@link strandedDraft}. A replacement gets a
   * fresh provider session id after reconnect, so the durable draft must still
   * be cleared from the conversation it was captured from. */
  strandedDraftSessionId?: string;

}

/** Mark a prompt as in flight. The returned token is the only thing that can
 *  later end THIS turn. */
export function beginTurn(session: Session): object {
  const token = {};
  session.turnToken = token;
  session.turnStartedAt = Date.now();
  session.staleSendReported = false;
  return token;
}

/** End the turn `token` started, if it is still the one in flight. False means
 *  something already settled it — a cancel recovery, or a newer turn — and the
 *  caller must not emit a second end for it. */
export function endTurn(session: Session, token: object): boolean {
  if (session.turnToken !== token) return false;
  session.turnToken = undefined;
  return true;
}

/** Whether a prompt is genuinely running. Asked instead of reading `status`,
 *  which cannot distinguish "working" from "was working and never settled". */
export function turnIsInFlight(session: { turnToken?: object }): boolean {
  return session.turnToken !== undefined;
}

/** Wall-clock ms the current (or just-settled) turn has run — the number a
 *  "Worked for …" footer displays. Undefined when no turn was ever started
 *  (a failure before {@link beginTurn}); never negative. Pure in `now`. */
export function turnElapsedMs(
  session: { turnStartedAt?: number },
  now: number = Date.now(),
): number | undefined {
  return typeof session.turnStartedAt === "number" && session.turnStartedAt > 0
    ? Math.max(0, now - session.turnStartedAt)
    : undefined;
}

/**
 * True when the ACP session can accept `session/prompt` (spawn finished and
 * session/new|load returned an id). During the priming window the client object
 * may already exist while `sessionId` is still unset — a prompt then throws
 * "no session" after consuming chips. Callers must queue instead.
 */
export function sessionReadyForPrompt(session: {
  client?: { sessionId?: string };
  priming: boolean;
}): boolean {
  return !!session.client && !session.priming && !!session.client.sessionId;
}

/**
 * Opportunistic starts (boot, client-ready, resume, ensureClient) must not
 * tear down a live turn or a just-started matching client. Intentional
 * replacements (restart, auth/cancel recovery, model switch) always proceed.
 */
export type SessionStartIntent = "ensure" | "replace";

export type SessionStartDecision = "proceed" | "reuse" | "refuse-turn" | "refuse-mismatch";

export const INTERRUPTED_SEND_TEXT =
  "The session restarted while this message was being sent, so delivery is uncertain. Check the conversation and send it again if needed.";

/**
 * One history load at a time per session. A second caller joins the in-flight
 * load (does not run `load`) rather than superseding it: `session/load` cannot
 * be aborted, and a second stream would interleave into the same buffer and
 * leak a partial transcript through `emit`'s `!session.replaying` remote gate.
 *
 * The barrier settles with the owner's outcome: joiners return `"joined"` only
 * after a successful load, and reject with the same reason the owner threw. A
 * permanently attached no-op catch keeps a reject with no waiter from becoming
 * unhandled.
 *
 * `replaying` stays a boolean ("is any replay in progress") for that gate;
 * `loadInFlight` is the exclusive token.
 */
export async function runExclusiveHistoryLoad(
  session: { replaying: boolean; loadInFlight?: Promise<void> },
  load: () => Promise<void>,
  hooks: { onStart(): void; onFinish(): void },
): Promise<"ran" | "joined"> {
  if (session.loadInFlight) {
    await session.loadInFlight;
    return "joined";
  }

  let resolveLoad!: () => void;
  let rejectLoad!: (reason: unknown) => void;
  const barrier = new Promise<void>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  // A reject with no joiner must not become an unhandled rejection.
  void barrier.catch(() => undefined);
  session.loadInFlight = barrier;
  session.replaying = true;
  let failure: { reason: unknown } | undefined;
  try {
    hooks.onStart();
    await load();
    return "ran";
  } catch (reason) {
    failure = { reason };
    throw reason;
  } finally {
    try {
      hooks.onFinish();
    } catch (reason) {
      failure = { reason };
      throw reason;
    } finally {
      session.replaying = false;
      session.loadInFlight = undefined;
      if (failure) rejectLoad(failure.reason);
      else resolveLoad();
    }
  }
}

export function decideSessionStart(
  session: {
    turnToken?: object;
    client?: { sessionId?: string };
    priming: boolean;
    activeSessionId?: string;
  },
  resumeId: string | undefined,
  intent: SessionStartIntent,
): SessionStartDecision {
  if (intent === "replace") return "proceed";
  if (turnIsInFlight(session)) return "refuse-turn";
  if (sessionReadyForPrompt(session)) {
    const liveId = session.client?.sessionId;
    if (!resumeId || resumeId === liveId) return "reuse";
    return "refuse-mismatch";
  }
  return "proceed";
}

/**
 * Busy chrome restored after a webview reload reattaches to a live session.
 * Keeps the startup lock while priming (or while the client has no session id
 * yet) so a rehydrate cannot unlock the composer into a work-losing send.
 */
export function rehydrateBusyChrome(session: Session): { value: boolean; locked: boolean } {
  if (!sessionReadyForPrompt(session)) {
    return { value: true, locked: true };
  }
  const busy =
    session.status === "working" ||
    session.status === "needs-you" ||
    session.turnToken !== undefined;
  return { value: busy, locked: false };
}

/**
 * True while this session has something to lose — the agent is working, waiting
 * on an answer it will resume from, or still starting up with input already
 * queued behind it.
 *
 * Closing a project folder disposes its sessions and force-kills the agent
 * process (a hard kill on Windows), so this predicate is the difference between
 * a clean close and work discarded without a word.
 *
 * The startup clause is the one that is easy to get wrong, and it was: an
 * earlier version of this checked only status and token, and reported "nothing
 * running" for a session whose process was still spawning — precisely the
 * window where a slow start leaves queued input sitting unsent.
 * `rehydrateBusyChrome` treats that state as busy-and-locked for the same
 * reason. It cannot simply defer to `sessionReadyForPrompt`, though: that is
 * false for a brand-new session which has never started at all, and warning
 * about those would fire on every close.
 *
 * Broader than `turnIsInFlight`, which only asks whether a token exists.
 */
export function sessionHasWorkInFlight(session: Session): boolean {
  if (session.status === "working" || session.status === "needs-you") return true;
  if (session.turnToken !== undefined) return true;
  // Starting: `priming` covers the spawn window before the client object even
  // exists; the second clause covers a client whose session/new has not
  // returned an id yet. A session with neither has never been started.
  return session.priming || (!!session.client && !session.client.sessionId);
}

export function beginQueuedSendCommit(
  session: Session,
  text: string,
): { text: string; items: QueuedSendEntry[] } | undefined {
  if (session.queuedSendCommit) return undefined;
  const split = takeQueuedSendsPrefix(session.queuedSends, text);
  if (!split) return undefined;
  const claim = { text, items: split.prefix };
  session.queuedSendCommit = claim;
  return claim;
}

export function finishQueuedSendCommit(
  session: Session,
  claim: { text: string; items: QueuedSendEntry[] },
  committed: boolean,
): boolean {
  if (session.queuedSendCommit !== claim) return false;
  session.queuedSendCommit = undefined;
  if (!committed) return false;

  const split = takeQueuedSendsPrefix(session.queuedSends, claim.text);
  if (!split) return false;
  session.queuedSends = split.rest.map((item) => ({
    text: item.text,
    chips: item.chips ?? [],
  }));
  if (!session.queuedSends.length) session.queuedSendRequiresRelay = false;
  return true;
}

/** Current non-chat UI state for rebuilding a view of this live session. */
export function sessionUiSnapshot(
  session: Session,
  modeId: string,
  chips: FileChip[] = session.chips,
): HostMsg[] {
  const messages: HostMsg[] = [];
  if (session.client?.currentModelId) {
    messages.push({ type: "modelChanged", modelId: session.client.currentModelId });
  }
  messages.push({ type: "modeChanged", modeId });
  messages.push({
    type: "planModeAvailability",
    available: session.planModeAvailable,
    reason: session.planModeUnavailableReason,
    // Unverified probes stay clickable so the user can re-check without restart.
    recheckable: !session.planModeAvailable && !session.planModeVersionVerified,
  });
  messages.push({ type: "feedbackAvailability", available: session.feedbackAvailable });
  if (session.liveFeedbackEligible) {
    messages.push({ type: "turnFeedbackAck", rating: session.turnRating });
  }
  for (const [requestId, pending] of session.pendingPermissions) {
    messages.push({
      type: "permissionOptions",
      requestId,
      options: pendingPermissionOptions(pending, session.planActive),
    });
  }
  messages.push({ type: "chips", chips });
  messages.push(queuedSendsMessage(session.queuedSends));
  return messages;
}
