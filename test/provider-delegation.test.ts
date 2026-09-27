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

const fixtures = JSON.parse(readFileSync(new URL("fixtures/provider-delegation.json", import.meta.url), "utf8"));
const backends = [grokBackend, new CodexBackend(), new ClaudeBackend(), new MuseBackend()];

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
      resultSummary: 'Returned value:\n\n```json\n{\n  "status": "ok",\n  "a": "alpha",\n  "b": "beta"\n}\n```' } });
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
