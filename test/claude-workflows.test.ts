import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { acpClientCapabilities } from "../src/acp";
import { ClaudeBackend } from "../src/claude-backend";
import { parseRunProgressUpdate } from "../src/run-progress";
import wire from "./fixtures/claude-async-workflow.json";

const normalize = (backend: ClaudeBackend, update: any) => backend.normalizeUpdate(update, undefined).workflowUpdate;

describe("Claude AIR workflows", () => {
  it.each([true, false])("joins receipt and async events in either order (spawn first=%s)", spawnFirst => {
    const backend = new ClaudeBackend();
    const receipt = normalize(backend, wire[spawnFirst ? 0 : 1]);
    expect(receipt?.launchOnly).toBe(spawnFirst ? undefined : true);
    const live = normalize(backend, wire[spawnFirst ? 1 : 0]);
    expect(live).toMatchObject({ run_id: "wf-live", name: "two-steps", launchOnly: false, status: "running" });
    for (const update of wire.slice(2)) normalize(backend, update);
    const final = normalize(backend, wire[1]); // late duplicate receipt cannot erase progress
    expect(parseRunProgressUpdate(final)).toMatchObject({ id: "wf-live", done: true, cancelled: false,
      phases: [{ title: "One", state: "done" }, { title: "Two", state: "done" }],
      agents: [{ label: "step-one" }, { label: "step-two" }], elapsedMs: 2000 });
    expect(final.launchOnly).toBe(false);
    expect(normalize(backend, { ...wire[4], description: "Stale: late" }).agents).toHaveLength(2);
  });

  it("retains progress and failure before a receipt; ignores shell tasks and conflicting IDs", () => {
    const backend = new ClaudeBackend();
    for (const update of [wire[0], wire[3], { ...wire[5], state: "failed", summary: "Failure" }]) {
      expect(normalize(backend, update)).toBeUndefined();
    }
    expect(parseRunProgressUpdate(normalize(backend, wire[1]))).toMatchObject({ failed: true,
      workflowContent: { resultSummary: "Failure" }, agents: [{ label: "step-one", state: "failed" }] });
    expect(normalize(backend, { ...wire[0], asyncTaskId: "shell", taskType: "shell" })).toBeUndefined();
    expect(normalize(backend, { ...wire[4], asyncTaskId: "shell", toolCallId: "launch-live" })).toBeUndefined();
    normalize(backend, { ...wire[1], toolCallId: "other", _meta: { claudeCode: { toolName: "Workflow",
      toolResponse: { ...(wire[1] as any)._meta.claudeCode.toolResponse, taskId: "other-task", runId: "other-run" } } } });
    expect(normalize(backend, { ...wire[4], toolCallId: "other" })).toBeUndefined();
  });

  it("deduplicates observations, avoids invented phases, and does not allocate aggregate usage to a child", () => {
    const backend = new ClaudeBackend();
    normalize(backend, wire[1]); normalize(backend, wire[0]);
    const unstructured = normalize(backend, { ...wire[3], description: "Waiting for work" });
    expect(unstructured.phases).toEqual([]);
    expect(unstructured.agents).toEqual([]);
    normalize(backend, wire[3]);
    const repeated = normalize(backend, wire[3]);
    expect(repeated.agents).toHaveLength(1);
    expect(repeated.agents[0].tokensUsed).toBeUndefined();
    const next = normalize(backend, { ...wire[4], description: "Two: step-one" });
    expect(next.agents).toHaveLength(2);
    expect(next.agents[0].state).toBe("done");
    expect(next.agents[1].state).toBe("active");
    expect(normalize(backend, { ...wire[5], state: "paused" }).status).toBe("paused");
  });

  it.each(["completed", "failed", "stopped"])("finishes earlier phases, retains parallel agents, and honors %s", status => {
    const backend = new ClaudeBackend();
    normalize(backend, wire[1]); normalize(backend, wire[0]);
    const progress = (description: string) => parseRunProgressUpdate(normalize(backend, { ...wire[3], description }))!;
    progress("Pick: Pick three nouns");
    for (const noun of ["wave", "tide", "wave", "reef", "tide"]) {
      const live = progress(`Describe: describe:${noun}`);
      expect(live.phases).toEqual([{ title: "Pick", state: "done" }, { title: "Describe", state: "active" }]);
      expect(live.agents?.[0].state).toBe("done");
      expect(live.agents?.slice(1).every(agent => agent.state === "active")).toBe(true);
    }
    const combine = progress("Combine: Make a haiku");
    expect(combine.phases?.map(phase => phase.state)).toEqual(["done", "done", "active"]);
    expect(combine.agents?.map(agent => agent.state)).toEqual(["done", "done", "done", "done", "active"]);
    const final = parseRunProgressUpdate(normalize(backend, { ...wire[5], state: status }))!;
    expect(final.done).toBe(true);
    expect(final.failed).toBe(status === "failed");
    expect(final.cancelled).toBe(status === "stopped");
    expect(final.phase).toBe(status);
    // A stopped run marks the step that was running cancelled, the state the renderer styles.
    const last = status === "completed" ? "done" : status === "stopped" ? "cancelled" : status;
    expect(final.agents?.map(agent => agent.state)).toEqual(["done", "done", "done", "done", last]);
    expect(final.phases?.map(phase => phase.state)).toEqual(["done", "done", last]);
  });

  it("executes the installed initialize parser, native gate, and async runtime without a CLI", async () => {
    const require = createRequire(import.meta.url);
    const dir = dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
    const fromAdapter = createRequire(join(dir, "dist/acp-agent.js"));
    const sdk = dirname(fromAdapter.resolve("@agentclientprotocol/sdk"));
    const schema = await import(pathToFileURL(join(sdk, "schema/zod.gen.js")).href);
    const { clientSupportsAsyncTasks, AsyncTaskRuntime } = await import(pathToFileURL(join(dir, "dist/async-tasks.js")).href);
    const { clientSupportsSubagents } = await import(pathToFileURL(join(dir, "dist/acp-subagents.js")).href);
    for (const provider of ["grok", "codex", "claude", "muse"] as const) {
      const caps = schema.zInitializeRequest.parse({ protocolVersion: 1, clientCapabilities: acpClientCapabilities(provider) }).clientCapabilities;
      expect(clientSupportsAsyncTasks(caps)).toBe(provider === "claude");
      expect(clientSupportsSubagents(caps)).toBe(provider === "codex");
    }
    const backend = new ClaudeBackend();
    normalize(backend, wire[1]);
    const updates: any[] = [], cards: any[] = [];
    const runtime = new AsyncTaskRuntime(true, "parent", async ({ update }: any) => {
      updates.push(update);
      const card = normalize(backend, update);
      if (card) cards.push(card);
    });
    await runtime.taskStarted({ task_id: "task-live", task_type: "local_workflow", description: "Two steps", skip_transcript: true });
    await runtime.taskProgress({ task_id: "task-live", description: "One: step-one", usage: { total_tokens: 100, tool_uses: 0, duration_ms: 1000 } });
    await runtime.backgroundTasksChanged([]);
    await runtime.taskNotification({ task_id: "task-live", status: "completed" });
    await runtime.taskNotification({ task_id: "task-live", status: "completed", output_file: "/example/result" });
    expect(updates.filter(u => u.sessionUpdate === "async_task_state_update").map(u => u.state)).toEqual(["stopped", "completed", "completed"]);
    expect(parseRunProgressUpdate(cards.at(-1))).toMatchObject({ id: "wf-live", done: true, cancelled: false, agents: [{ label: "step-one" }] });
    const count = cards.length;
    await runtime.taskStarted({ task_id: "shell", task_type: "local_bash", description: "Background shell", is_backgrounded: false });
    expect(updates.at(-1).asyncTaskId).toBe("task-live");
    await runtime.taskBackgrounded({ task_id: "shell", task_type: "local_bash", tool_use_id: "bash" });
    await runtime.taskNotification({ task_id: "shell", status: "failed" });
    expect(updates.at(-1)).toMatchObject({ asyncTaskId: "shell", state: "failed" });
    expect(cards).toHaveLength(count);
  });
});
