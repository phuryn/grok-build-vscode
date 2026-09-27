import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AcpClient, acpClientCapabilities } from "../src/acp";
import { grokBackend } from "../src/grok-backend";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { MuseBackend } from "../src/muse-backend";
import { parseRunProgressUpdate } from "../src/run-progress";
import { Projection } from "../adapters/muse/projection.mts";

const fixtures = JSON.parse(readFileSync(new URL("fixtures/provider-delegation.json", import.meta.url), "utf8"));
const backends = [grokBackend, new CodexBackend(), new ClaudeBackend(), new MuseBackend()];

describe("provider delegation normalization boundaries", () => {
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
    expect(caps).not.toHaveProperty("_meta"); // no AIR asyncTasks/nativeSubagentSessions
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
      .map((r: any) => backend.normalizeUpdate(r.update, undefined)).filter((r: any) => r.workflowUpdate);
    expect(updates.length).toBeGreaterThan(0);
    expect(new Set(updates.map((r: any) => r.workflowUpdate.run_id)).size).toBe(1);
    for (const result of updates) {
      expect(result.update.sessionUpdate).toBe("tool_call_update"); // launch row still completes
      expect(parseRunProgressUpdate(result.workflowUpdate)).toMatchObject({ kind: "workflow", phase: "running", done: false,
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
