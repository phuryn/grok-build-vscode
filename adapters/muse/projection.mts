import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { parseToolInput } from "./tool-input.mjs";

interface ItemState {
  kind?: string;
  revision: number;
  text: string;
  output: string;
  toolCallId?: string;
  delegationTerminal?: boolean;
  /** `subagent`: the workflow run that owns it, when Muse names one. */
  workflowRunId?: string;
  /** `subagent`: the last item Muse sent, to settle the card when its run ends. */
  lastItem?: Record<string, any>;
  /** `reasoning`: the summary parts as they stream (`item/delta` field `summary.N`). */
  parts: string[];
  /** `reasoning`: what has been emitted as thinking, the parts joined. */
  thought: string;
}

const newItemState = (): ItemState => ({ revision: -1, text: "", output: "", parts: [], thought: "" });

const MUSE_FAILURE_OUTPUT_LINES = 8;

/** MSP full workflow snapshots, including the same item in resume history. */
function workflowUpdate(item: Record<string, any>): Record<string, any> | undefined {
  if (typeof item.workflowRunId !== "string" || !item.workflowRunId) return;
  let summary: unknown;
  const match = typeof item.message === "string"
    ? /^<workflow-launch-reconciled>([\s\S]*)<\/workflow-launch-reconciled>$/.exec(item.message.trim()) : null;
  if (match) {
    try { summary = JSON.parse(match[1])?.final_summary?.summary; } catch { /* Incomplete envelope: no output yet. */ }
  }
  if (typeof summary === "string") {
    try {
      // Muse's entire returned value is output, including arbitrary JSON.
      // Four backticks mark our validated JSON; the shared renderer suppresses
      // three-backtick CLI envelopes that may have been truncated.
      summary = "````json\n" + JSON.stringify(JSON.parse(summary), null, 2).replace(/`/g, "\\u0060") + "\n````";
    } catch { /* Already prose or Markdown. */ }
  }
  const children = Array.isArray(item.children) ? item.children : [];
  return {
    sessionUpdate: "workflow_updated", run_id: item.workflowRunId,
    name: item.entryId || item.scriptId || "Workflow", revision: item.revision,
    status: item.status === "inProgress" ? "running" : item.status === "completed" ? "completed"
      : item.status === "cancelled" ? "cancelled" : "failed",
    controlsAvailable: false,
    agentProgressDots: true,
    result_summary: typeof summary === "string" ? summary : undefined,
    agents: children.filter((child: any) => child && typeof child.childId === "string").map((child: any, i: number) => ({
      agent_id: child.childId, label: `Agent ${i + 1}`,
      state: child.status === "terminal" ? child.terminal || "stopped"
        : child.status === "started" || child.status === "usage" ? "active" : child.status,
      tokens_used: typeof child.usage?.inputTokens === "number" && typeof child.usage?.outputTokens === "number"
        ? child.usage.inputTokens + child.usage.outputTokens : undefined,
    })),
  };
}

/** The row already names the tool. Show why it stopped: the reported reason,
 *  the server's one-line summary, else the tail of what the tool printed. */
function museToolFailureMessage(item: Record<string, any>): string {
  const reason = typeof item.failureReason === "string" ? item.failureReason.trim() : "";
  if (reason) return reason;
  const fallback = typeof item.fallbackText === "string" ? item.fallbackText.trim() : "";
  if (fallback) return fallback;
  if (typeof item.visibleOutput === "string") {
    const lines = item.visibleOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length) return lines.slice(-MUSE_FAILURE_OUTPUT_LINES).join("\n");
  }
  const status = typeof item.status === "string" && item.status.trim() ? item.status.trim() : "failed";
  return `Muse reported "${status}" without a reason.`;
}

/** A single session's raw MSP stream, independent of transport and SDK folds. */
// Muse's shell tool is `bash` or, on Windows, `powershell`; `search` is its grep/glob.
const MUSE_TOOL_KINDS: Record<string, "execute" | "search"> = { bash: "execute", powershell: "execute", search: "search" };
function museToolKind(tool: unknown): "execute" | "search" | "other" {
  return typeof tool === "string" && Object.hasOwn(MUSE_TOOL_KINDS, tool) ? MUSE_TOOL_KINDS[tool] : "other";
}

export class Projection {
  private readonly items = new Map<string, ItemState>();
  private readonly replyTurns = new Map<string, string>();
  private readonly stopTargets = new Map<string, string>();
  /** Workflow runs that have ended, with Muse's terminal status. */
  private readonly endedWorkflows = new Map<string, string>();
  stopWorkflows = false;
  stopSubagents = false;
  forkIds = false;
  /** The reasoning item that last emitted thinking, if any. */
  private lastThoughtItem?: string;
  constructor(
    private readonly emit: (update: SessionUpdate) => void,
    private readonly log: (message: string) => void,
  ) {}

  clear(): void {
    this.items.clear(); this.replyTurns.clear(); this.stopTargets.clear(); this.endedWorkflows.clear();
    this.lastThoughtItem = undefined;
  }

  replyTurnId(messageId: string): string | undefined { return this.replyTurns.get(messageId); }

  stopTarget(kind: "workflow" | "subagent", id: string): string | undefined {
    return this.stopTargets.get(`${kind}:${id}`);
  }

  private recordStopTarget(kind: "workflow" | "subagent", id: string, target: unknown): boolean {
    const key = `${kind}:${id}`;
    if (typeof target === "string" && target.trim()) {
      this.stopTargets.set(key, target);
      return true;
    }
    this.stopTargets.delete(key);
    return false;
  }

  private projectSubagent(id: string, state: ItemState, item: Record<string, any>, live: boolean): void {
    const first = !state.toolCallId;
    const toolCallId = state.toolCallId ??= `muse-subagent:${id}`;
    // A workflow agent's last own update can still say inProgress after its
    // run has ended (observed when Stop cancels the run): the run's end is its end.
    const museStatus: string = item.status === "inProgress" && state.workflowRunId
      ? this.endedWorkflows.get(state.workflowRunId) ?? item.status : item.status;
    state.delegationTerminal = museStatus !== "inProgress";
    const canStop = this.recordStopTarget("subagent", toolCallId,
      live && this.stopSubagents && !state.delegationTerminal ? item.subagentId : undefined);
    const cancelled = museStatus === "cancelled";
    const stoppedOrDone = cancelled || museStatus === "completed";
    const status = !state.delegationTerminal ? "in_progress" : stoppedOrDone ? "completed" : "failed";
    const output = item.result?.text || item.result?.summary
      || (status === "failed" ? museToolFailureMessage({ ...item, status: museStatus }) : "");
    const usage = item.usage;
    const tokens = typeof usage?.inputTokens === "number" && typeof usage?.outputTokens === "number"
      ? usage.inputTokens + usage.outputTokens : undefined;
    this.emit({ sessionUpdate: first ? "tool_call" : "tool_call_update", toolCallId,
      title: item.role || "Subagent", kind: "think", status, rawInput: { description: item.objective },
      rawOutput: { output }, _meta: { "muse/subagent": true, "muse/cancelled": cancelled, "muse/canStop": canStop,
        subagentStatusAuthoritative: true, subagentUsage: { durationMs: item.durationMs, tokens } } });
  }

  /** Settle the cards of a run's agents that are still open when the run ends. */
  private settleWorkflowAgents(runId: string, status: string): void {
    this.endedWorkflows.set(runId, status);
    for (const [id, state] of this.items) {
      if (state.kind === "subagent" && state.workflowRunId === runId && !state.delegationTerminal && state.lastItem) {
        this.projectSubagent(id, state, state.lastItem, false);
      }
    }
  }

  private append(state: ItemState, id: string, field: "text" | "output", text: string): void {
    const previous = state[field];
    if (text === previous || previous.startsWith(text)) return;
    if (!text.startsWith(previous)) {
      // An append-only channel cannot represent a revision of an emitted prefix.
      this.log(`Muse projection: prefix-changing ${field} revision for item ${id}`);
      return;
    }
    const suffix = text.slice(previous.length);
    state[field] = text;
    if (field === "text" && (state.kind === "agentMessage" || state.kind === undefined)) {
      this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: suffix },
        ...(this.forkIds ? { messageId: id } : {}) });
    } else if (field === "output" && state.kind === "toolCall") {
      // ACP tool content is a replacement snapshot, unlike assistant chunks.
      this.emit({ sessionUpdate: "tool_call_update", toolCallId: state.toolCallId!,
        content: [{ type: "content", content: { type: "text", text } }] });
    }
  }

  /**
   * Muse's reasoning summary as ACP thinking (#207): the same
   * `agent_thought_chunk` the other agents send, so "Show thinking traces"
   * shows it. Parts are joined with a blank line; only new text is emitted.
   */
  private think(state: ItemState, id: string): void {
    const joined = state.parts.filter((part) => part).join("\n\n");
    if (joined === state.thought || state.thought.startsWith(joined)) return;
    if (!joined.startsWith(state.thought)) {
      this.log(`Muse projection: prefix-changing reasoning revision for item ${id}`);
      return;
    }
    let suffix = joined.slice(state.thought.length);
    state.thought = joined;
    // A new reasoning item is a new thought. The renderer keeps appending
    // thinking to one block for the turn, whatever comes in between, so
    // without a break two summaries ran into one sentence. A block the
    // renderer has just started drops the leading break itself (appendThought).
    if (this.lastThoughtItem !== undefined && this.lastThoughtItem !== id) suffix = `\n\n${suffix}`;
    this.lastThoughtItem = id;
    this.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: suffix } });
  }

  acceptHistory(item: Record<string, any>): void {
    if (item.kind === "userMessage" && typeof item.text === "string") {
      // Reuse the host's replay-only steer envelope and keep the authored text
      // out of the fork boundary logic for ordinary prompts.
      const text = item.steered ? `The user sent a message while you were working:\n${item.text}` : item.text;
      this.emit({ sessionUpdate: "user_message_chunk", content: { type: "text", text },
        ...(this.forkIds && typeof item.itemId === "string" ? { messageId: item.itemId } : {}) });
    }
    this.accept("item/completed", { item }, false);
  }

  accept(method: string, params: Record<string, any>, live = true): void {
    if (method === "session/contextUsage") {
      this.emit({ sessionUpdate: "usage_update", used: params.usedTokens, size: params.windowTokens });
      return;
    }
    if (method === "item/delta") {
      const id = params.itemId;
      if (typeof id !== "string" || typeof params.delta !== "string") return;
      let state = this.items.get(id);
      if (!state) {
        // Muse may send an answer delta without a preceding item/started.
        state = newItemState();
        this.items.set(id, state);
      }
      if (state.kind === "reminderChild") return;
      const field: string = params.field ?? "text";
      const part = /^summary\.(\d+)$/.exec(field);
      if (part && (state.kind === "reasoning" || state.kind === undefined)) {
        const n = Number(part[1]);
        state.parts[n] = (state.parts[n] ?? "") + params.delta;
        this.think(state, id);
      } else if (field === "text" || field === "output") this.append(state, id, field, state[field] + params.delta);
      return;
    }
    if (!["item/started", "item/updated", "item/completed"].includes(method)) return;
    const item = params.item;
    if (!item || typeof item.itemId !== "string" || typeof item.revision !== "number") return;
    const id = item.itemId;
    let state = this.items.get(id);
    if (!state) {
      state = newItemState();
      this.items.set(id, state);
    }
    if (item.revision <= state.revision) return;
    if (state.delegationTerminal && item.status === "inProgress") return;
    state.revision = item.revision;
    state.kind = item.kind;
    if (this.forkIds && item.kind === "agentMessage" && typeof item.turnId === "string" && item.turnId) {
      this.replyTurns.set(id, item.turnId);
    }
    if (item.kind === "reminderChild") return;
    if (item.kind === "workflow") {
      const workflow = workflowUpdate(item);
      // Keep ACP schema-valid: provider metadata carries the rollup to our
      // backend, which emits the existing runProgress presentation message.
      if (workflow) {
        state.delegationTerminal = item.status !== "inProgress";
        if (this.recordStopTarget("workflow", item.workflowRunId,
          live && this.stopWorkflows && !state.delegationTerminal ? item.workflowRunId : undefined)) {
          workflow.stopAvailable = true;
        }
        this.emit({ sessionUpdate: "session_info_update", _meta: { "muse/workflow": workflow } });
        if (state.delegationTerminal) this.settleWorkflowAgents(item.workflowRunId, item.status);
      }
    } else if (item.kind === "subagent") {
      state.lastItem = item;
      if (typeof item.workflowRunId === "string" && item.workflowRunId) state.workflowRunId = item.workflowRunId;
      this.projectSubagent(id, state, item, live);
    } else if (item.kind === "toolCall") {
      const first = !state.toolCallId;
      state.toolCallId = item.callId || id;
      // MSP's open enum has exactly one nonterminal value. ACP has no
      // terminal-unknown status: use its non-success terminal. The reason
      // stays on rawOutput.message, which is what the row reads first.
      const status = item.status === "inProgress" ? "in_progress"
        : item.status === "completed" ? "completed" : "failed";
      // Output has to ride the update whose status is completed. The row
      // fills its output box only from that update, and a later content-only
      // update is not merged. A failed command also carries `output` (what
      // it printed, or "") beside `message`. Replay commandOutput has no
      // toolCallId and is served to the oldest row with that command which
      // has not received output yet, so every run emits its own.
      const printed = typeof item.visibleOutput === "string" ? item.visibleOutput : undefined;
      const visible = status === "completed" ? printed : undefined;
      this.emit({ sessionUpdate: first ? "tool_call" : "tool_call_update",
        toolCallId: state.toolCallId!, title: item.tool || "Muse tool",
        kind: museToolKind(item.tool), status, rawInput: parseToolInput(item.args),
        rawOutput: status === "failed" ? { message: museToolFailureMessage(item), output: printed ?? "" }
          : visible !== undefined ? { output: visible } : undefined,
        ...(visible !== undefined ? { content: [{ type: "content", content: { type: "text", text: visible } }] } : {}),
      });
      if (typeof item.visibleOutput === "string") this.append(state, id, "output", item.visibleOutput);
    } else if (item.kind === "agentMessage" && typeof item.text === "string") {
      this.append(state, id, "text", item.text);
    } else if (item.kind === "reasoning" && Array.isArray(item.summary)) {
      state.parts = item.summary.map((part: unknown) => (typeof part === "string" ? part : ""));
      this.think(state, id);
    }
  }
}
