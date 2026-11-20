import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AsyncTaskRuntime, AsyncTaskStarted } from "@agentclientprotocol/claude-agent-acp/dist/async-tasks.js";

type Task = { taskType: string; announced: boolean; stopping: boolean };
type Runtime = {
  tasks: Map<string, Task>;
  finish(task: Task, state: "stopped", summary: undefined, source: "event"): Promise<void>;
};

// Loaded only in the bundled adapter process. Keep its session registry,
// claimStop and SDK stopTask path. The pinned adapter normally excludes Agent
// tasks from AIR even when the SDK registers them as background work.
export async function installTaskStopBridge(entry: string | undefined): Promise<void> {
  if (!entry) return;
  const entryUrl = pathToFileURL(entry);
  const manifest = JSON.parse(await readFile(new URL("../package.json", entryUrl), "utf8"));
  if (manifest.version !== "0.76.0") return;

  // Resolve from the launched entry, matching its own relative import and
  // sharing the same registry class even when multiple copies are installed.
  const { AsyncTaskRuntime } = await import(new URL("./async-tasks.js", entryUrl).href) as {
    AsyncTaskRuntime?: { prototype: AsyncTaskRuntime };
  };
  const proto = AsyncTaskRuntime?.prototype;
  if (!proto || typeof (proto as unknown as Runtime).finish !== "function"
      || !["taskStarted", "backgroundTasksChanged", "taskStopped"].every(name => {
        const method = Object.getOwnPropertyDescriptor(proto, name);
        return method?.writable === true && typeof method.value === "function";
      })) return;
  const taskStarted = proto.taskStarted;
  proto.taskStarted = function (message: AsyncTaskStarted) {
    if ((message.task_type === "local_agent" || message.subagent_type !== undefined)
        && typeof message.tool_use_id === "string" && message.tool_use_id) {
      // Explicit foreground starts stay unannounced. A later background
      // patch or membership in the SDK's background level can promote them.
      return taskStarted.call(this, { ...message, task_type: "subagent",
        subagent_type: undefined, is_backgrounded: message.is_backgrounded === true });
    }
    return taskStarted.call(this, message);
  };

  const backgroundTasksChanged = proto.backgroundTasksChanged;
  proto.backgroundTasksChanged = function (tasks) {
    const registry = (this as unknown as Runtime).tasks;
    // The bundled adapter passes the SDK's array here. Preserve attribution
    // from task_started. A level can precede that edge, so skip unknown Agent
    // ids here before the original runtime marks them permanently ignored.
    return backgroundTasksChanged.call(this, Array.isArray(tasks) ? tasks.flatMap(task => {
      if (task?.task_type !== "local_agent") return [task];
      return registry.get(task.task_id)?.taskType === "subagent" ? [{ ...task, task_type: "subagent" }] : [];
    }) : tasks);
  };

  proto.taskStopped = async function (id) {
    // The card is the acknowledgement. Keep the adapter's terminal edge and
    // omit its synthetic assistant chunk, which would join the parent's reply.
    const runtime = this as unknown as Runtime;
    const task = runtime.tasks.get(id);
    if (task?.announced && task.stopping) await runtime.finish(task, "stopped", undefined, "event");
  };
}
