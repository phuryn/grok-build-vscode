import { AcpClient } from "./acp";
import type { PromptUsage } from "./acp";
import type { FileBaseline } from "./file-baseline";
import type { HostMsg } from "./protocol";

/** Live state for the dashboard dot. `cold` (no live process) is represented by
 *  the absence of a Session, so it isn't in this union. */
export type SessionStatus = "idle" | "working" | "needs-you" | "done" | "error";

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
  /** The live ACP client (one spawned `grok agent stdio` process), once started. */
  client?: AcpClient;

  /** YOLO: auto-approve every permission request for this session. */
  autoApprove = false;

  /** Plan-mode gate is up for this session (client-side enforcement mirror). */
  planActive = false;

  /**
   * Deferred post-turn action. The CLI's exit_plan_mode arrives *during* an
   * in-flight session/prompt, so we can't send a new prompt/set_mode from the
   * approval handler — we'd collide with the running turn. We stash the action
   * here and run it once the current prompt resolves (see handleSend).
   */
  afterTurn?: () => Promise<void>;

  /** This session has conversational history (vs. a fresh, empty one). */
  hasHistory = false;

  /**
   * True for the whole session-start window (spawn → newSession/load → primer).
   * Model/effort changes are settings that restart or race the session, so they
   * are ignored while priming — the webview also disables the controls (busy),
   * this is the host-side backstop for a click that slips through that window.
   */
  priming = false;

  /**
   * False until the hidden primer has been sent on THIS session load. The primer
   * is no longer sent at session start — it's deferred to the first outbound
   * prompt (ensurePrimed), so a startup or glance-only restore costs nothing.
   * It's (re-)sent on the first send of every load, new OR restored: a primer
   * buried in a restored session's replayed history isn't reliably honored by
   * grok (a /compact can drop it from effective context), so we re-assert it
   * once before the first post-restore turn rather than trusting history.
   */
  primed = false;

  /**
   * In-flight (or settled) hidden-primer turn for THIS session load, if one has
   * been kicked off. The primer now fires eagerly + non-blocking the moment a
   * session goes live (ensurePrimed in sidebar), so the user can send straight
   * away; their first real prompt awaits this promise (grok can't run two turns
   * at once) and is released the instant the silent primer acks. Reused so a
   * concurrent send doesn't start a second primer; cleared on failure so the
   * next send retries. undefined until the primer is first requested.
   */
  primingPromise?: Promise<void>;

  /** Drop streaming content from the webview (primer / summary injection). */
  suppressContent = false;

  /**
   * True once a live `auto_compact_completed` notification (with a usable
   * `tokens_after`) has updated the donut for the CURRENT manual /compact. Reset
   * to false just before each manual compact prompt. Gates the pre-rail
   * `/session-info` fallback + the signals.json backup so they run ONLY when the
   * live rail didn't already give us the exact post-compact count.
   */
  sawCompactNotification = false;

  /**
   * True when an `auto_compact_failed` notification arrived for the CURRENT
   * manual /compact (reset with `sawCompactNotification` before each). Gates the
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

  /**
   * When set (to ""), the sidebar's messageChunk handler accumulates the
   * agent's streamed text here instead of only forwarding it — used by the
   * pre-rail post-/compact /session-info fallback, whose reply text carries the
   * fresh context count. undefined = no capture.
   */
  captureAgentText?: string;

  /**
   * Plan-reject specific suppression: drop streaming output (the false-approval
   * ramble) but let lifecycle events through so the webview clears `busy` and
   * re-enables the send button when the cancelled turn finally ends.
   */
  suppressPlanReject = false;

  /** Live permission requests awaiting an answer, by request id. Set when the
   *  card is shown, read when the user answers so we can persist the resolved
   *  card (title + outcome) for replay on a resumed session, then deleted. */
  pendingPermissions = new Map<number | string, { title: string; toolCallId?: string; options: { optionId: string; kind: string }[] }>();

  /** Most recent plan text seen for this session (exit_plan_mode fallback). */
  lastPlanText = "";

  /**
   * Plan text currently shown in the live exit_plan_mode card. Set when we post
   * the card to the webview, read by persistPlanVerdict when the user picks a
   * verdict, then cleared. Decoupled from lastPlanText (which gets nuked the
   * moment we render the card) so the saved history actually has content.
   */
  pendingPlanText = "";

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
   */
  replaying = false;

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
   * Session-scoped `[Image #N]` counter — the highest index used so far.
   * Incremented per attached image and NEVER reset on send, so every image in
   * one conversation gets a distinct tag (per-composer numbering would restart
   * at #1 each turn and make "image #1" ambiguous in the transcript). On
   * restore it's re-seeded from the replayed prompts' tags (sidebar's
   * userMessageChunk handler).
   */
  imageCounter = 0;

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

  /** Derived status for the dashboard dot (see SessionStatus). */
  status: SessionStatus = "idle";

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
   * The ONE pending message composed while THIS session was busy (typed
   * Enter-sends and dictated utterances), awaiting its turn end. Invariant:
   * length ≤ 1 — composing more while one is queued appends to the entry
   * (blank-line separator, the exact flush format), because Stop and the flush
   * collapse everything into one message anyway. Host-owned per session — the
   * webview renders a mirror (a pending user block) from `queuedSends`
   * snapshots, so it survives focus switches and the flush
   * (maybeFlushQueuedSends) fires even while the session is backgrounded.
   */
  queuedSends: string[] = [];

  /** The last completed prompt's billing usage (#53) — grok's `_meta.usage`. */
  lastTurnUsage?: PromptUsage;

  /**
   * Session-cumulative billing (#53), summed by US across the session's turns.
   * grok reports usage per prompt only and `signals.json` persists just context
   * size, so nothing on disk can seed this — it is restored from our own
   * globalState (`SessionMetaOverride.usage`) and re-persisted as turns land.
   */
  sessionUsage?: PromptUsage;

  /**
   * Monotonic id for the open agent turn (incremented on each agentStart).
   * Keys the per-turn file baseline maps used by view-deleted / undo-file.
   * 0 = no turn started yet.
   */
  turnBaselineId = 0;

  /**
   * First-touch baselines for the *current* turn (pathKey → snapshot taken
   * before the first write/delete of that path). Content stays host-side.
   */
  turnBaselines = new Map<string, FileBaseline>();

  /**
   * Completed turns' baselines (turnId → map), kept for a few turns so undo /
   * view-deleted still work after the next agentStart clears `turnBaselines`.
   */
  turnBaselineArchive = new Map<number, Map<string, FileBaseline>>();
}
