import type { WorkflowAgent, WorkflowPhase } from "./run-progress";

interface AsyncWorkflow {
  taskType?: string;
  toolCallId?: string;
  status: string;
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
  currentPhase?: string;
  summary?: string;
  elapsedMs?: number;
}

const terminal = (status: string) => /^(completed|failed|stopped|cancelled)$/.test(status);

/** Read only the leading literal meta block; never execute workflow source. */
function scriptPhases(script: unknown): WorkflowPhase[] | undefined {
  if (typeof script !== "string") return;
  // Bound work even when a streamed input is incomplete or malformed.
  const source = script.slice(0, 65536);
  const token = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:=]/y;
  let offset = 0;
  const next = (): string => {
    for (;;) {
      token.lastIndex = offset;
      const match = token.exec(source);
      if (!match) throw new Error("Not a literal meta block");
      offset = token.lastIndex;
      if (!/^\s|^\/[/\*]/.test(match[0])) return match[0];
    }
  };
  const string = (value: string): string => {
    if (!/^["'`]/.test(value) || (value[0] === "`" && value.includes("${"))) throw new Error("Not a literal string");
    return value.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[^])/g, (_, escape: string) => {
      if (/^[ux]/.test(escape)) {
        if (escape.length === 1) throw new Error("Invalid escape");
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      }
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[escape] ?? escape;
    });
  };
  const value = (first: string, depth = 0): any => {
    if (depth > 16) throw new Error("Meta nesting limit");
    if (/^["'`]/.test(first)) return string(first);
    if (/^-?\d/.test(first)) return Number(first);
    if (["true", "false", "null"].includes(first)) return JSON.parse(first);
    if (first !== "{" && first !== "[") throw new Error("Not a literal value");
    const object = first === "{";
    const result: any = object ? Object.create(null) : [];
    const end = object ? "}" : "]";
    let part = next();
    while (part !== end) {
      if (object) {
        const key = /^["'`]/.test(part) ? string(part) : part;
        if (!/^["'`A-Za-z_$]/.test(part) || next() !== ":") throw new Error("Invalid property");
        result[key] = value(next(), depth + 1);
      } else result.push(value(part, depth + 1));
      part = next();
      if (part === end) break;
      if (part !== ",") throw new Error("Invalid separator");
      part = next();
    }
    return result;
  };
  try {
    if (next() !== "export" || next() !== "const" || next() !== "meta" || next() !== "=" || next() !== "{") return;
    const meta = value("{");
    if (!Array.isArray(meta.phases) || !meta.phases.length
        || meta.phases.some((p: any) => typeof p?.title !== "string" || !p.title.trim())) return;
    return meta.phases.slice(0, 64).map((p: any) => ({ title: p.title.trim().slice(0, 200), state: "pending" }));
  } catch { return; }
}

/** AIR task events can precede the receipt that supplies the stable run ID. */
export class ClaudeWorkflows {
  private readonly launches = new Map<string, any>();
  private readonly tasks = new Map<string, AsyncWorkflow>();
  private readonly inputs = new Map<string, WorkflowPhase[]>();

  toolInput(update: any): void {
    if (update?._meta?.claudeCode?.toolName !== "Workflow" || typeof update.toolCallId !== "string") return;
    const phases = scriptPhases(update.rawInput?.script);
    if (phases) this.inputs.set(update.toolCallId, phases);
  }

  launch(update: any, receipt: any): any {
    const previous = this.launches.get(receipt.run_id);
    const launch = previous || receipt;
    const phases = this.inputs.get(update.toolCallId);
    if (phases && !launch.phases?.length) {
      launch.phases = phases.map(p => ({ ...p }));
      launch.launchOnly = false;
    }
    if (previous) {
      if (receipt.name !== "Workflow") launch.name = receipt.name;
      if (receipt.objective) launch.objective = receipt.objective;
    }
    const output = typeof update.rawOutput === "string" ? update.rawOutput : "";
    const taskId = update._meta?.claudeCode?.toolResponse?.taskId
      ?? /^Workflow launched in background\. Task ID:\s*(\S+)/.exec(output)?.[1];
    for (const key of [update.toolCallId, taskId, receipt.run_id]) {
      if (typeof key === "string" && key) this.launches.set(key, launch);
    }
    for (const [id, task] of this.tasks) {
      if (this.match([id, task.toolCallId]) === launch && task.taskType === "workflow") {
        return this.snapshot(launch, task);
      }
    }
    return { ...launch };
  }

  notification(text: string): any {
    const ids = ["task-id", "tool-use-id", "run-id"].map(tag =>
      new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(text)?.[1]?.trim());
    const launch = this.match(ids);
    const status = /<status>([^<]*)<\/status>/.exec(text)?.[1];
    if (!launch || !status || !terminal(status)) return;
    // Cold replay has receipts only; warm replay already has the richer snapshot.
    if (launch.launchOnly !== false || launch.status === "launched") {
      launch.status = status;
      if (status === "completed" && launch.phases) launch.phases = launch.phases.map((p: WorkflowPhase) => ({ ...p, state: "done" }));
    }
    return { ...launch };
  }

  accept(update: any): any {
    const id = update.asyncTaskId;
    if (typeof id !== "string" || !id) return;
    let task = this.tasks.get(id);
    if (!task) {
      task = { status: "running", phases: [], agents: [] };
      this.tasks.set(id, task);
    }
    if (typeof update.toolCallId === "string") task.toolCallId = update.toolCallId;
    if (update.sessionUpdate === "async_task_spawned") task.taskType = update.taskType;
    if (update.sessionUpdate === "async_task_state_update") {
      const status = update.state;
      // The adapter can correct its level-derived stopped edge with an event.
      if (["running", "paused", "completed", "failed", "stopped"].includes(status)
          && (!terminal(task.status) || (task.status === "stopped" && terminal(status)))) {
        task.status = status;
        if (terminal(status) && typeof update.summary === "string") task.summary = update.summary.slice(0, 32768);
      }
    }
    if (update.sessionUpdate === "async_task_progress" && !terminal(task.status)) {
      const description = typeof update.description === "string" ? update.description : "";
      const step = /^([^\n]+?):\s+([^\n]+)$/.exec(description);
      if (step) {
        const phase = step[1].trim(), label = step[2].trim();
        task.currentPhase = phase;
        // Claude awaits each phase before entering the next. Within a phase,
        // labels may alternate between parallel agents; keep all of them active.
        for (const entry of task.phases) {
          if (entry.title === phase) entry.state = "active";
          else if (entry.state === "active") entry.state = "done";
        }
        for (const entry of task.agents) entry.state = entry.phase === phase ? "active" : "done";
        let p = task.phases.find(p => p.title === phase);
        if (!p) task.phases.push(p = { title: phase });
        p.state = "active";
        let a = task.agents.find(a => a.phase === phase && a.label === label);
        if (!a) task.agents.push(a = { id: JSON.stringify([phase, label]), label, phase });
        a.state = "active";
      }
      if (typeof update.usage?.durationMs === "number" && Number.isFinite(update.usage.durationMs)) {
        task.elapsedMs = update.usage.durationMs;
      }
    }
    // Shell/watch/other tasks also use AIR. They must never create workflows.
    if (task.taskType !== "workflow") return;
    const launch = this.match([id, task.toolCallId]);
    return launch ? this.snapshot(launch, task) : undefined;
  }

  private match(ids: (string | undefined)[]): any {
    const matches = ids.map(id => id && this.launches.get(id)).filter(Boolean);
    return matches.length && matches.every(match => match === matches[0]) ? matches[0] : undefined;
  }

  private snapshot(launch: any, task: AsyncWorkflow): any {
    if (launch.phases?.length) {
      const observed = new Map(task.phases.map(p => [p.title, p]));
      task.phases = [
        ...launch.phases.map((p: WorkflowPhase) => observed.get(p.title) ?? { ...p }),
        ...task.phases.filter(p => !launch.phases.some((seed: WorkflowPhase) => seed.title === p.title)),
      ];
    }
    // The step that was running when the run stopped reads as cancelled, the
    // state the renderer styles; "stopped" would draw as a step never begun.
    const state = (value: string | undefined) => task.status === "completed" ? "done"
      : terminal(task.status) && value === "active" ? (task.status === "stopped" ? "cancelled" : task.status) : value;
    Object.assign(launch, {
      launchOnly: false, status: task.status, current_phase: task.currentPhase,
      phases: task.phases.map(p => ({ ...p, state: state(p.state) })),
      agents: task.agents.map(a => ({ ...a, state: state(a.state) })),
      elapsed_ms: task.elapsedMs, result_summary: task.summary,
    });
    return { ...launch };
  }
}
