import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { AcpClient, acpClientCapabilities } from "../src/acp";
import { grokBackend } from "../src/grok-backend";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { MuseBackend } from "../src/muse-backend";
import { parseRunProgressUpdate } from "../src/run-progress";
import { Projection } from "../adapters/muse/projection.mts";
import { SessionFold } from "@muse-code/sdk";
import claudeBackground from "./fixtures/claude-background-subagent.json";

const fixtures = JSON.parse(readFileSync(new URL("fixtures/provider-delegation.json", import.meta.url), "utf8"));
const backends = [grokBackend, new CodexBackend(), new ClaudeBackend(), new MuseBackend()];

describe("Claude background subagent receipts and task correlation", () => {
  it("settles the captured async launch in background with no model-facing receipt", () => {
    const backend = new ClaudeBackend();
    const updates = claudeBackground.launch.map(u => backend.normalizeUpdate(u, undefined).update);
    for (const u of updates.slice(-2)) {
      expect(u).toMatchObject({ status: "background", rawOutput: { output: "" }, content: [] });
      expect(JSON.stringify(u)).not.toMatch(/Async agent|agent-task|output_file|toolResponse/);
    }
  });

  // The 0.76.0 capture has no Agent task edges: its async runtime excludes
  // local_agent. Exercise the AIR contract separately, not as captured data.
  it.each(["completed", "failed", "stopped"])("finishes only the ID-matched card on %s, preserving usage", state => {
    const backend = new ClaudeBackend();
    for (const u of claudeBackground.launch) backend.normalizeUpdate(u, undefined);
    const event = (u: any) => backend.normalizeUpdate({ asyncTaskId: "agent-task", ...u }, undefined);
    expect(event({ sessionUpdate: "async_task_state_update", asyncTaskId: "unrelated", state }).update).toBeUndefined();
    expect(event({ sessionUpdate: "async_task_spawned", taskType: "agent", name: "plumbing test" }).workflowUpdate).toBeUndefined();
    const progress = event({ sessionUpdate: "async_task_progress", summary: "Working", usage: { durationMs: 1200, totalTokens: 42 } });
    expect(progress.update).toMatchObject({ status: "in_progress", rawOutput: { output: "" } });
    const finished = event({ sessionUpdate: "async_task_state_update", state, summary: "## Report\n\nok" });
    expect(finished.update).toMatchObject({ toolCallId: "agent-tool", status: state === "stopped" ? "cancelled" : state,
      rawOutput: { output: "## Report\n\nok" }, _meta: { subagentUsage: { durationMs: 1200, tokens: 42 } } });
    expect(event({ sessionUpdate: "async_task_progress" }).update.status).toBe(finished.update.status);
    expect(backend.normalizeUpdate(claudeBackground.launch.at(-1), undefined).update.status).toBe(finished.update.status);
  });

  it("treats the captured ID-less task wake-up as accounting, never as a card outcome", () => {
    const backend = new ClaudeBackend();
    for (const u of claudeBackground.launch) backend.normalizeUpdate(u, undefined);
    const wake = backend.normalizeUpdate(claudeBackground.wake, undefined);
    expect(wake.update).toEqual(claudeBackground.wake);
    expect(wake.workflowUpdate).toBeUndefined();
    expect(backend.normalizeUpdate(claudeBackground.launch.at(-1), undefined).update.status).toBe("background");
  });

  it("retains early task completion and accepts a stopped-edge correction with a late summary", () => {
    const backend = new ClaudeBackend();
    backend.normalizeUpdate({ sessionUpdate: "async_task_state_update", asyncTaskId: "agent-task", state: "stopped" }, undefined);
    for (const u of claudeBackground.launch) backend.normalizeUpdate(u, undefined);
    for (const summary of [undefined, "ok"]) {
      expect(backend.normalizeUpdate({ sessionUpdate: "async_task_state_update", asyncTaskId: "agent-task", state: "completed", summary }, undefined).update)
        .toMatchObject({ status: "completed", rawOutput: { output: summary || "" } });
    }
  });

  it("replays the receipt and notification without inventing usage or accepting conflicting IDs", () => {
    const backend = new ClaudeBackend();
    for (const u of claudeBackground.launch.filter(u => !(u._meta.claudeCode as any).toolResponse)) backend.normalizeUpdate(u, undefined);
    const wake = (ids: string, result = "<result>ok</result>") => backend.normalizeUpdate({ sessionUpdate: "user_message_chunk",
      content: { type: "text", text: `<task-notification>${ids}<status>completed</status>${result}</task-notification>` } }, undefined);
    expect(wake("<task-id>agent-task</task-id><tool-use-id>other-tool</tool-use-id>").update).toBeUndefined();
    expect(backend.normalizeUpdate(claudeBackground.launch.at(-1), undefined).update.status).toBe("background");
    const done = wake("<task-id>agent-task</task-id><tool-use-id>agent-tool</tool-use-id>");
    expect(done).toMatchObject({ notice: "Background task completed.", update: { status: "completed", rawOutput: { output: "ok" } } });
    expect(done.update._meta.subagentUsage).toEqual({ durationMs: undefined, tokens: undefined });
  });

  it("strips the captured tool error wrapper from both output channels", () => {
    const backend = new ClaudeBackend();
    const result = backend.normalizeUpdate(claudeBackground.failure.at(-1), undefined).update;
    expect(result.rawOutput.output).toMatch(/^InputValidationError:/);
    expect(JSON.stringify(result)).not.toContain("tool_use_error");
  });

  it("pins the installed adapter limitation: local_agent produces no AIR task events", async () => {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    const { AsyncTaskRuntime } = await import(new URL("dist/async-tasks.js", pathToFileURL(manifest)).href);
    const frames: any[] = [];
    const runtime = new AsyncTaskRuntime(true, "parent", async (frame: any) => { frames.push(frame); });
    await runtime.taskStarted({ task_id: "agent-task", task_type: "local_agent", is_backgrounded: true });
    await runtime.taskNotification({ task_id: "agent-task", status: "completed", summary: "ok" });
    expect(frames).toEqual([]);
  });
});

describe("provider delegation normalization boundaries", () => {
  it("projects the installed Muse SDK's real workflow fold, preserving opaque result references", () => {
    const fold = new SessionFold();
    const updates: any[] = [];
    const projection = new Projection(update => updates.push(update), () => {});
    for (const row of fixtures["muse-workflow"]) {
      fold.apply({ method: row.method, params: { sessionId: "parent", item: row.item } } as any);
      projection.accept(row.method, { item: fold.items.get(row.item.itemId) });
    }
    const final = fixtures["muse-workflow"].at(-1).item;
    const held = fold.items.get(final.itemId)!;
    expect(held.children).toEqual(final.children);
    // The scrubbed fixture omitted refs. Exercise the SDK with the documented
    // opaque URI too; the fold preserves it without resolving it into output.
    const withRef = { ...final, revision: final.revision + 1, children: final.children.map((child: any) => ({
      ...child, resultRef: `subagent-result://${child.childId}/task/example#5`,
    })) };
    fold.apply({ method: "item/updated", params: { sessionId: "parent", item: withRef } } as any);
    expect(fold.items.get(final.itemId)?.children?.[0].resultRef).toMatch(/^subagent-result:\/\//);
    const card = parseRunProgressUpdate(updates.at(-1)._meta["muse/workflow"]);
    expect(card).toMatchObject({ done: true, agentProgressDots: true, agents: [{ label: "Agent 1", state: "completed" }, { label: "Agent 2", state: "completed" }] });
    expect(card?.phases).toBeUndefined();
  });
  it.each(backends)("$provider routes replay before load resolves and clears the child IDs on failure", async backend => {
    for (const fails of [false, true]) {
      const client = new AcpClient({ cliPath: "unused", cwd: "/example", log: () => {}, backend });
      const parent: string[] = [], children: any[] = [];
      client.on("messageChunk", text => parent.push(text));
      client.on("childStream", event => children.push(event));
      (client as any).request = async () => {
        expect(client.sessionId).toBeUndefined();
        (client as any).handleSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent" } }, undefined, "loaded");
        (client as any).handleSessionUpdate({ sessionUpdate: "subagent_spawned", subagentSessionId: "child" }, undefined, "loaded");
        (client as any).handleSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child" } }, undefined, "child");
        if (fails) throw new Error("load failed");
        return {};
      };
      if (fails) await expect(client.loadSession("loaded")).rejects.toThrow("load failed");
      else await client.loadSession("loaded");
      expect(parent).toEqual(["parent"]);
      expect(children).toMatchObject([{ childSessionId: "child", route: { event: "messageChunk", text: "child" } }]);
      expect(client.sessionId).toBe(fails ? undefined : "loaded");
      expect((client as any).loadingChildSessionIds).toBeUndefined();
    }
  });

  it.each(backends)("$provider opts into only its own capability and wire extensions", backend => {
    const caps = acpClientCapabilities(backend.provider);
    expect(caps.subagents).toEqual(backend.provider === "codex" ? {} : undefined);
    if (backend.provider === "grok" || backend.provider === "muse") expect(caps).not.toHaveProperty("_meta");
    const spawn = fixtures["codex-subagent-optin"][0].update;
    expect(backend.normalizeUpdate(spawn, undefined).update.sessionUpdate)
      .toBe(backend.provider === "codex" ? "tool_call" : "subagent_spawned");
    const wake = fixtures["claude-workflow"].find((r: any) => r.update.sessionUpdate === "user_message_chunk").update;
    const normalized = backend.normalizeUpdate(wake, undefined);
    expect(normalized.notice).toBe(backend.provider === "claude" ? "Background task completed." : undefined);
    if (backend.provider !== "claude") expect(normalized.update).toEqual(wake);
  });

  it("does not use child-session metadata for parent progress or notices", () => {
    for (const backend of backends) {
      const client = new AcpClient({ cliPath: "unused", cwd: "/example", log: () => {}, backend });
      client.sessionId = "parent";
      const seen: unknown[] = [];
      client.on("subagentLifecycle", u => seen.push(u));
      client.on("notice", u => seen.push(u));
      const launch = fixtures["claude-workflow"].find((r: any) => r.update._meta?.claudeCode?.toolResponse).update;
      (client as any).handleSessionUpdate(launch, undefined, "child");
      const wake = fixtures["claude-workflow"].find((r: any) => r.update.sessionUpdate === "user_message_chunk").update;
      (client as any).handleSessionUpdate(wake, undefined, "child");
      expect(seen).toEqual([]);
    }
  });

  it.each(["failed", "cancelled", "stopped", "running"])("Codex state %s uses the existing card status", state => {
    const backend = new CodexBackend();
    const result = backend.normalizeUpdate({ sessionUpdate: "subagent_state_update", subagentSessionId: "child", state }, undefined);
    expect(result.update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "codex-subagent:child",
      status: state === "running" ? "in_progress" : state === "stopped" ? "cancelled" : state });
  });

  it.each(["live", "load"])("Claude workflow %s has the same run identity without controls", phase => {
    const backend = new ClaudeBackend();
    const updates = fixtures["claude-workflow"].filter((r: any) => r.phase === phase)
      .map((r: any) => backend.normalizeUpdate(r.update, undefined)).filter((r: any) => r.workflowUpdate && r.update);
    expect(updates.length).toBeGreaterThan(0);
    expect(new Set(updates.map((r: any) => r.workflowUpdate.run_id)).size).toBe(1);
    for (const result of updates) {
      expect(result.update.sessionUpdate).toBe("tool_call_update"); // launch row still completes
      expect(parseRunProgressUpdate(result.workflowUpdate)).toMatchObject({ kind: "workflow", phase: "launched", done: false,
        controlsAvailable: false, displayName: undefined });
    }
  });

  it("Muse projects each captured child state without inventing completion percentages or fetching resultRef", () => {
    const updates: any[] = [];
    const p = new Projection(update => updates.push(update), () => {});
    const backend = new MuseBackend();
    for (const row of fixtures["muse-workflow"]) p.accept(row.method, { item: row.item });
    const progress = updates.map(update => parseRunProgressUpdate(backend.normalizeUpdate(update, undefined).workflowUpdate)!);
    expect(progress[0]).toMatchObject({ title: "alpha-beta two-step", phase: "running", agents: [], controlsAvailable: false });
    expect(progress.slice(1, 6).map(p => p.agents![0].state)).toEqual(["scheduled", "active", "active", "completed", "completed"]);
    expect(progress[3].agents![0].tokensUsed).toBe(16219);
    expect(progress.at(-1)).toMatchObject({ done: true, workflowContent: { pauseMessage: null,
      resultSummary: '````json\n{\n  "status": "ok",\n  "a": "alpha",\n  "b": "beta"\n}\n````' } });
    expect(progress.every(p => p.progress === undefined && p.displayName === undefined)).toBe(true);
  });

  it("Muse ignores stale revisions and malformed output envelopes and clears on a new history load", () => {
    const updates: any[] = [];
    const p = new Projection(u => updates.push(u), () => {});
    const final = fixtures["muse-workflow"].at(-1).item;
    p.acceptHistory(final);
    p.acceptHistory(final);
    p.accept("item/updated", { item: { ...final, revision: 1 } });
    expect(updates).toHaveLength(1);
    p.clear();
    p.acceptHistory({ ...final, message: "<workflow-launch-reconciled>broken</workflow-launch-reconciled>" });
    expect(updates).toHaveLength(2);
    expect(updates[1]._meta["muse/workflow"].result_summary).toBeUndefined();
    expect(updates[1]._meta["muse/workflow"].status).toBe("completed");
  });
});

// Execute the installed adapter's parser AND predicates, without its CLI entry
// point. Testing our raw capabilities against the predicate alone misses the
// schema stripping `subagents` on the way into CodexAcpServer.initialize.
it("Codex handshake survives the bundled adapter parser and enables only native subagents", () => {
  const require = createRequire(import.meta.url);
  const file = require.resolve("@agentclientprotocol/codex-acp");
  const source = readFileSync(file, "utf8");
  const entry = source.indexOf('if (process.argv.includes("--version"))');
  expect(entry).toBeGreaterThan(0);
  const code = transformSync(source.slice(0, entry) + `
    export { zInitializeRequest, clientSupportsSubagents, clientSupportsAirCapability };`, {
    format: "cjs", platform: "node", define: { "import.meta.url": JSON.stringify(pathToFileURL(file).href) },
  }).code;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", code.replace(/^#![^\n]*\n/, ""))(createRequire(file), module, module.exports);
  const adapter = module.exports;
  const parsed = (capabilities: any) => adapter.zInitializeRequest.parse({ protocolVersion: 1, clientCapabilities: capabilities }).clientCapabilities;
  // This is the broken real-app handshake, not an invented negative fixture.
  expect(adapter.clientSupportsSubagents(parsed({ ...acpClientCapabilities("codex"), _meta: undefined }))).toBe(false);
  for (const provider of ["grok", "codex", "claude", "muse"] as const) {
    const caps = parsed(acpClientCapabilities(provider));
    expect(adapter.clientSupportsSubagents(caps)).toBe(provider === "codex");
    expect(adapter.clientSupportsAirCapability(caps, "nativeSubagentSessions")).toBe(provider === "codex");
    expect(adapter.clientSupportsAirCapability(caps, "asyncTasks")).toBe(provider === "claude");
  }
});

it("Claude completes only the launch identified by a task notification", () => {
  const backend = new ClaudeBackend();
  const launch = (id: string) => backend.normalizeUpdate({ sessionUpdate: "tool_call_update", toolCallId: `tool-${id}`,
    _meta: { claudeCode: { toolName: "Workflow", toolResponse: {
      status: "async_launched", taskType: "local_workflow", runId: id, taskId: `task-${id}`,
      workflowName: `name-${id}`, summary: "Description",
    } } } }, undefined);
  launch("one"); launch("two");
  const wake = (ids: string) => backend.normalizeUpdate({ sessionUpdate: "user_message_chunk",
    content: { type: "text", text: `<task-notification>${ids}<status>completed</status></task-notification>` } }, undefined);
  expect(wake("<task-id>unknown</task-id>").workflowUpdate).toBeUndefined();
  expect(wake("<task-id>task-one</task-id><tool-use-id>tool-two</tool-use-id>").workflowUpdate).toBeUndefined();
  expect(wake("<task-id>task-one</task-id>").workflowUpdate).toMatchObject({ run_id: "one", name: "name-one", status: "completed", launchOnly: true });
  expect(wake("<run-id>two</run-id>").workflowUpdate).toMatchObject({ run_id: "two", status: "completed" });
});
