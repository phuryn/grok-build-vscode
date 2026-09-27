/**
 * Pure helpers for Deep Research / Workflow / Goal progress cards (P2-10).
 *
 * These ride live `_x.ai/session_notification` and persisted/replayed
 * `_x.ai/session/update` rails as:
 *   - `workflow_updated`  — background workflow / deep-research runs
 *   - `goal_updated`      — `/goal` autonomous loops
 *
 * Field names on the wire are snake_case (same family as subagent lifecycle /
 * auto_compact_*). We accept camelCase fallbacks so a future rename doesn't
 * blank the card. See research/run-progress.md.
 */

export type RunProgressKind = "workflow" | "goal";

/**
 * `last_event` is a Rust enum variant, and the card printed it verbatim —
 * `phase_entered: Research`, `log: research plan: 3 question(s)`. The owner
 * read a real one and asked whether we can translate the labels, and whether
 * this was the only one.
 *
 * The answer that scales is not a bigger table. The full vocabulary is NOT
 * knowable from here: the live capture of 2026-09-17 produced exactly three
 * values (`workflow_started`, `phase_entered`, `log`) because the run was cut
 * short after two of four phases, and the binary's string table shows a dozen
 * more nearby (`agent_spawned`, `agent_finished`, `agents_reserved`,
 * `subagent_finished`, `phase_transition`, `workflow_paused`, …) without
 * saying which of them ever land in THIS field. A table alone would keep
 * leaking Rust for every name we failed to predict.
 *
 * So the rule is about the shape, not the vocabulary: the event NAME is
 * scaffolding and the event DETAIL is the content. An empty label here means
 * "print the detail alone" — `log:` adds nothing to its own message, and
 * `phase_entered` restates the phase the row already shows. Anything unknown
 * falls through {@link eventLabel} and reads as English rather than as a
 * variant name.
 */
const EVENT_LABEL: Record<string, string> = {
  log: "",
  phase_entered: "",
  phase_transition: "",
  // Every `workflow_*` lifecycle event is already the phase slot's business
  // now that `status` outranks `current_phase`, so the name adds nothing here.
  // Their DETAILS still come through when they carry something: a bare reason
  // token like `user` is dropped by the containment rule below (the row says
  // "user paused"), while `workflow_failed`'s prose — the CLI has sentences
  // like "maximum agent budget reached; start a new run" — survives it.
  workflow_started: "",
  workflow_paused: "",
  workflow_resumed: "",
  workflow_completed: "",
  workflow_cancelled: "",
  workflow_failed: "",
  workflow_interrupted: "",
  agent_spawned: "Agent started",
  agent_finished: "Agent finished",
  agent_completed: "Agent finished",
  agents_reserved: "Agents reserved",
  subagent_finished: "Subagent finished",
  warning: "Warning",
  error: "Error",
  retry: "Retrying",
};

/**
 * A wire name as a person would read it. Known names get their label (possibly
 * empty, meaning "the detail speaks for itself"); an unknown one is
 * sentence-cased, so a future `verification_failed` reads "Verification
 * failed" instead of shipping a Rust identifier to a phone.
 */
function eventLabel(name: string): string {
  if (Object.prototype.hasOwnProperty.call(EVENT_LABEL, name)) return EVENT_LABEL[name];
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * The same problem lives one slot over, which is why "is this the only one?"
 * is answered "no": the PHASE word reaches the row raw too, and it is
 * snake_case whenever a run ends badly (`budget_exceeded`, `budget_limited`,
 * `accounting_incomplete`) or whenever no phase field arrives and the parser
 * falls back to the `sessionUpdate` discriminator.
 *
 * That one is fixed at the RENDER site (media/chat.js, the
 * `.run-progress-phase` fill) rather than here, and deliberately: `phase` is a
 * machine value on the way through — DONE_PHASES, the failed/cancelled tests
 * and the renderer's own pause check all compare against it — so humanising it
 * in this file would mean either breaking those comparisons or carrying two
 * spellings of the same field across the wire.
 */

/**
 * Status words that describe the RUN's lifecycle rather than its position.
 * Observed live: `active`, `user_paused`, `cancelled`. The rest come from the
 * CLI's own vocabulary in the same module (`workflow_budget_limited`,
 * `workflow_interrupted`, `workflow_failed`, `workflow_completed`), matched on
 * stems so a prefix we have not seen — `agent_paused`, `budget_exceeded` —
 * still lands on the right side of the line.
 */
const LIFECYCLE_STATUS = /paus|cancel|stopp|stopped|complet|fail|error|interrupt|budget|abort/;

/** Terminal-ish phases that stop the live dots. */
const DONE_PHASES = new Set([
  "complete",
  "completed",
  "failed",
  "cancelled",
  "cleared",
  "stopped",
  "budget_exceeded",
  "error",
  "success",
]);

export interface WorkflowPhase {
  id?: string;
  title: string;
  state?: string;
}

export interface WorkflowAgent {
  id?: string;
  label: string;
  phase?: string;
  state?: string;
  tokensUsed?: number;
}

export interface RunProgressUpdate {
  kind: RunProgressKind;
  /** Stable id for the card (run_id / goal_id / display name). */
  id: string;
  /** User-facing name (workflow display handle or "Goal"). */
  title: string;
  /** Optional objective / query line. */
  subtitle?: string;
  /** Coarse phase string (running / paused / completed / …). */
  phase: string;
  /** One-line status (last_event + detail, deliverable title, …). */
  detail?: string;
  /** Source-preserving workflow content. Null means supplied but no content;
   * absence means an older host whose `detail` has lost field provenance.
   * Keep `detail` unchanged for older clients; they ignore this extra field. */
  workflowContent?: { resultSummary: string | null; pauseMessage: string | null };
  /** False for providers whose workflow controls the host cannot drive. */
  controlsAvailable?: boolean;
  /** Child progress for providers that report a roster without phases. */
  agentProgressDots?: boolean;
  /** A launch receipt, without live progress or a composer pin. */
  launchOnly?: boolean;
  /**
   * 0–1 COMPLETION when known — goals only.
   *
   * Deliberately absent for workflows. A workflow's only fraction on the wire
   * is `agents_used / agent_budget`, which is money spent, not work finished
   * (#163: *"Grok tells me the progress is never accurate"* — it was right).
   * The renderer also rejects workflow percentages supplied by older hosts.
   * Spend reaches the card as {@link agentsUsed} / {@link agentBudget} and a
   * labelled `N of M agents used` in {@link detail}.
   */
  progress?: number;
  /** Workflow agent spend, when the run reports it. Never a completion ratio. */
  agentsUsed?: number;
  agentBudget?: number;
  /** Observed workflow fields; absence means the host/wire did not supply them. */
  phases?: WorkflowPhase[];
  currentPhase?: string;
  currentPhaseId?: string;
  agents?: WorkflowAgent[];
  activeAgents?: number;
  elapsedMs?: number;
  revision?: number;
  /** True when the run is finished (success, fail, cancel, clear). */
  done: boolean;
  failed: boolean;
  cancelled: boolean;
  /** Observed handle for /workflow pause|resume|stop; never inferred from id. */
  displayName?: string;
  /** Raw sessionUpdate for debugging / tests. */
  sessionUpdate: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function lower(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

/**
 * True when an xAI session update is a workflow/goal progress
 * event the progress cards act on. Excludes high-frequency noise (no
 * subagent_progress equivalent here — workflow_updated is the rollup).
 */
export function isRunProgressUpdate(update: unknown): boolean {
  const k = asRecord(update)?.sessionUpdate;
  if (typeof k !== "string") return false;
  return (
    k === "workflow_updated" ||
    k === "goal_updated" ||
    k === "workflow_started" ||
    k === "workflow_completed" ||
    k === "workflow_failed" ||
    k === "workflow_cancelled" ||
    k === "workflow_paused" ||
    k === "workflow_resumed" ||
    k === "goal_created" ||
    k === "goal_completed" ||
    k === "goal_cleared" ||
    k === "goal_paused" ||
    k === "goal_resumed"
  );
}

/**
 * Normalize an xAI session update into a card-friendly shape, or null
 * when it isn't a run-progress kind / lacks an id.
 */
export function parseRunProgressUpdate(update: unknown): RunProgressUpdate | null {
  const u = asRecord(update);
  if (!u) return null;
  const sessionUpdate = str(u.sessionUpdate);
  if (!sessionUpdate || !isRunProgressUpdate(u)) return null;

  if (sessionUpdate === "workflow_updated" || sessionUpdate.startsWith("workflow_")) {
    return parseWorkflow(u, sessionUpdate);
  }
  if (sessionUpdate === "goal_updated" || sessionUpdate.startsWith("goal_")) {
    return parseGoal(u, sessionUpdate);
  }
  return null;
}

function parseWorkflow(u: Record<string, unknown>, sessionUpdate: string): RunProgressUpdate | null {
  const displayName =
    str(u.display_name) ||
    str(u.displayName) ||
    str(u.name) ||
    str(u.run_name) ||
    str(u.runName);
  const runId = str(u.run_id) || str(u.runId) || displayName;
  if (!runId) return null;

  // `status` is the LIFECYCLE; `current_phase` is the position within it — and
  // a lifecycle word outranks the position, because pausing or stopping a run
  // changes only the first of the two.
  //
  // Measured on a real run, 2026-09-17 (test/fixtures/
  // workflow-lifecycle-live.jsonl):
  //
  //   running      status=active       current_phase=Plan
  //   after Pause  status=user_paused  current_phase=Plan
  //   after Stop   status=cancelled    current_phase=Plan
  //
  // Reading `current_phase` first meant the card kept saying "plan" through
  // both, so Pause never became Resume and a stopped run never went grey —
  // the owner reported exactly that, having watched the CLI confirm the pause
  // in prose. The discriminator stays `workflow_updated` for all three, so
  // there was no second channel that would have caught it.
  //
  // `active` deliberately does NOT qualify: it is the absence of a lifecycle
  // event, and "Plan" tells the reader more than "active" does.
  const statusRaw = str(u.status) || "";
  const lifecycle = LIFECYCLE_STATUS.test(statusRaw.toLowerCase()) ? statusRaw : "";
  const positionRaw = str(u.current_phase) || str(u.currentPhase) || str(u.phase);
  const phaseRaw =
    lifecycle ||
    positionRaw ||
    statusRaw ||
    lastEventPhase(u) ||
    sessionUpdate.replace(/^workflow_/, "") ||
    "running";
  const phase = phaseRaw.toLowerCase();
  // Where it stopped. Preferring the lifecycle must not throw the position
  // away: `current_phase` is the only field that says where a paused run will
  // resume from, so it moves to the detail line rather than off the card.
  const position = lifecycle && positionRaw ? positionRaw : "";
  const objective = str(u.objective) || str(u.query) || str(u.description);
  const lastEvent = str(u.last_event) || str(u.lastEvent);
  const lastDetail = str(u.last_event_detail) || str(u.lastEventDetail);
  const pauseMsg = str(u.pause_message) || str(u.pauseMessage);
  const resultSummary = str(u.result_summary) || str(u.resultSummary);
  const agentLabel = str(u.current_agent_label) || str(u.currentAgentLabel);

  const detailParts: string[] = [];
  // Nothing in the detail line may repeat what the phase slot already says.
  // The phase is `user_paused` where the row prints "user paused", so compare
  // against the spaced form: that one rule then covers both the commonest
  // frame in a live run (`phase_entered` + detail `Research`, beside a row
  // already reading `· research`) and the pause frame (`workflow_paused` +
  // detail `user`, beside a row already reading `· user paused`).
  const alreadySaid = phase.replace(/[_-]+/g, " ");
  const say = (text: string) => {
    const t = text.trim();
    if (t && !alreadySaid.includes(t.toLowerCase())) detailParts.push(t);
  };

  if (position) say(position);
  if (pauseMsg) say(pauseMsg);
  else if (resultSummary) say(resultSummary);
  else if (lastEvent) {
    const label = eventLabel(lastEvent);
    say(lastDetail ? (label ? `${label}: ${lastDetail}` : lastDetail) : label);
  } else if (agentLabel) say(agentLabel);

  // Spend, and it is reported as spend. `agents_used / agent_budget` used to
  // become `progress` here, which the card then drew as a percentage in the
  // same place the Goal card draws real completion — so "strategy 2%" meant
  // "one agent of fifty gone", and a run doing long work inside one agent sat
  // at the same number for an hour (#163). Reported as `N of M agents used`:
  // the same fact, in a form that cannot be read as a finish line.
  const agentsUsed = num(u.agents_used ?? u.agentsUsed);
  const agentBudget = num(u.agent_budget ?? u.agentBudget);
  if (agentsUsed != null && agentBudget != null && agentBudget > 0) {
    detailParts.push(`${agentsUsed.toLocaleString("en-US")} of ${agentBudget.toLocaleString("en-US")} agents used`);
  }

  const done = DONE_PHASES.has(phase) || /completed|failed|cancelled|stopped/.test(sessionUpdate);
  const failed = phase === "failed" || phase === "error" || phase === "budget_exceeded" || sessionUpdate === "workflow_failed";
  const cancelled = phase === "cancelled" || phase === "stopped" || sessionUpdate === "workflow_cancelled";

  return {
    kind: "workflow",
    id: runId,
    title: displayName || "Workflow",
    subtitle: objective,
    phase,
    detail: detailParts.join(" · ") || undefined,
    workflowContent: { resultSummary: resultSummary || null, pauseMessage: pauseMsg || null },
    agentsUsed,
    agentBudget,
    phases: Array.isArray(u.phases) ? u.phases.flatMap((value) => {
      const p = asRecord(value);
      const title = p && (str(p.title) || str(p.name) || str(p.label));
      return p && title ? [{ id: str(p.id) || str(p.phase_id) || str(p.phaseId), title, state: str(p.state) }] : [];
    }) : undefined,
    currentPhase: positionRaw,
    currentPhaseId: str(u.current_phase_id) || str(u.currentPhaseId),
    agents: Array.isArray(u.agents) ? u.agents.flatMap((value) => {
      const a = asRecord(value);
      if (!a) return [];
      const id = str(a.agent_id) || str(a.agentId) || str(a.id);
      const label = str(a.label) || str(a.name) || id;
      return label ? [{ id, label, phase: str(a.phase), state: str(a.state), tokensUsed: num(a.tokens_used ?? a.tokensUsed) }] : [];
    }) : undefined,
    activeAgents: num(u.active_agents ?? u.activeAgents),
    elapsedMs: num(u.elapsed_ms ?? u.elapsedMs),
    revision: num(u.revision),
    done: done || failed || cancelled,
    failed,
    cancelled,
    displayName: u.controlsAvailable === false ? undefined : displayName,
    ...(u.controlsAvailable === false ? { controlsAvailable: false } : {}),
    ...(u.agentProgressDots === true ? { agentProgressDots: true } : {}),
    ...(u.launchOnly === true ? { launchOnly: true } : {}),
    sessionUpdate,
  };
}

function parseGoal(u: Record<string, unknown>, sessionUpdate: string): RunProgressUpdate | null {
  const goalId = str(u.goal_id) || str(u.goalId) || str(u.id) || "goal";
  const objective = str(u.objective) || str(u.title) || str(u.goal);
  const phaseRaw =
    str(u.phase) ||
    str(u.status) ||
    str(u.current_phase) ||
    str(u.currentPhase) ||
    sessionUpdate.replace(/^goal_/, "") ||
    "running";
  const phase = phaseRaw.toLowerCase();

  const total = num(u.total_deliverables ?? u.totalDeliverables);
  const completed = num(u.completed_deliverables ?? u.completedDeliverables);
  const curTitle =
    str(u.current_deliverable_title) ||
    str(u.currentDeliverableTitle) ||
    str(u.current_subagent_role) ||
    str(u.currentSubagentRole);

  let progress: number | undefined;
  if (total != null && total > 0 && completed != null) {
    progress = Math.min(1, Math.max(0, completed / total));
  }

  const detailParts: string[] = [];
  if (total != null && completed != null) detailParts.push(`${completed.toLocaleString("en-US")}/${total.toLocaleString("en-US")} deliverables`);
  if (curTitle) detailParts.push(curTitle);

  const done =
    DONE_PHASES.has(phase) ||
    sessionUpdate === "goal_completed" ||
    sessionUpdate === "goal_cleared";
  const failed = phase === "failed" || phase === "budget_exceeded" || phase === "error";
  const cancelled = phase === "cancelled" || phase === "cleared" || sessionUpdate === "goal_cleared";

  return {
    kind: "goal",
    id: goalId,
    title: "Goal",
    subtitle: objective,
    phase,
    detail: detailParts.join(" · ") || undefined,
    progress,
    done: done || failed || cancelled,
    failed,
    cancelled,
    sessionUpdate,
  };
}

function lastEventPhase(u: Record<string, unknown>): string | undefined {
  const e = str(u.last_event) || str(u.lastEvent);
  return e ? e.toLowerCase() : undefined;
}

/**
 * Build the slash command to control a workflow run by display name.
 * Returns null when the action isn't applicable (e.g. goal has no pause via /workflow).
 */
export function workflowControlCommand(
  action: "pause" | "resume" | "stop",
  displayName: string | undefined,
): string | null {
  const name = displayName || "";
  if (!name) return null;
  // Display names are session-unique handles (review-changes, deep-research-2).
  // Don't shell-quote — slash dispatch is plain text, and names are [a-z0-9-].
  if (!/^[\w.:-]+$/.test(name)) return null;
  return `/workflow ${action} ${name}`;
}

/** Human label for the card's kind badge. */
export function runProgressKindLabel(kind: RunProgressKind): string {
  return kind === "goal" ? "Goal" : "Workflow";
}

/** Format a 0–1 progress fraction as a short percent, or "" when unknown. */
export function formatRunProgressPct(progress: number | undefined): string {
  if (progress == null || !Number.isFinite(progress)) return "";
  return `${Math.round(progress * 100)}%`;
}
