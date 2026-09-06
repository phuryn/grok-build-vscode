import { MCP_REMOTE_PACKAGE } from "../src/mcp-connectors";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  AcpClient,
  ACP_DELEGATED_FS_CAPABILITIES,
  ACP_IMAGE_READ_FS_CAPABILITIES,
  acpClientCapabilities,
  buildGrokAgentArgs,
  buildInterjectParams,
  cliHonorsInterjectContent,
} from "../src/acp";
import type { AcpBackend } from "../src/acp-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";

// Unit tests for AcpClient internals that don't need a real subprocess. We
// stand up the client with a fake writable proc and drive `request`/`onLine`
// directly.
function clientWithFakeProc(opts?: {
  backend?: AcpBackend;
  effort?: "high";
  timeouts?: {
    promptIdleTimeoutMs?: number;
    promptAbsoluteTimeoutMs?: number;
    requestTimeoutMs?: number;
  };
}): { client: AcpClient; written: string[] } {
  const client = new AcpClient({
    cliPath: "x",
    cwd: "/",
    log: () => {},
    ...(opts?.backend ? { backend: opts.backend } : {}),
    ...(opts?.effort ? { effort: opts.effort } : {}),
    ...(opts?.timeouts ? { timeouts: opts.timeouts } : {}),
  });
  const written: string[] = [];
  (client as any).proc = {
    killed: false,
    stdin: { writable: true, write: (s: string) => written.push(s) },
  };
  return { client, written };
}

function replyToWrites(
  client: AcpClient,
  written: string[],
  resultFor: (msg: any) => any,
): void {
  (client as any).proc.stdin.write = (s: string) => {
    written.push(s);
    const msg = JSON.parse(s);
    queueMicrotask(() => {
      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: resultFor(msg) }));
    });
    return true;
  };
}

describe("AcpClient notification metadata", () => {
  it("emits the live context count from the session/update envelope", () => {
    const { client } = clientWithFakeProc();
    const seen: number[] = [];
    client.on("contextUsage", (used) => seen.push(used));

    for (const totalTokens of [5487, 5487, 15781, 16015, 0]) {
      (client as any).onLine(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
          _meta: { totalTokens },
        },
      }));
    }

    expect(seen).toEqual([5487, 15781, 16015]);
  });

  it("emits the adapter usage_update window even when the live model id is missing or unmatched", () => {
    const { client } = clientWithFakeProc({ backend: new ClaudeBackend() });
    const seen: Array<{ used?: number; window?: number }> = [];
    const billed: number[] = [];
    client.on("contextUsage", (used, window) => seen.push({ used, window }));
    client.on("adapterUsageUpdate", (used) => billed.push(used));

    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 35671, size: 1000000 } },
    }));
    expect(seen).toEqual([{ used: undefined, window: 1000000 }]);
    expect(billed).toEqual([35671]);

    (client as any).currentModelId = "opus[1m]";
    (client as any).availableModels = [{ modelId: "claude-opus-4-6", name: "Opus" }];
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 35709, size: 1000000 } },
    }));
    expect(seen[1]).toEqual({ used: undefined, window: 1000000 });
    expect((client as any).availableModels[0].totalContextTokens).toBeUndefined();

    (client as any).currentModelId = "claude-opus-4-6";
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "usage_update", used: 35709, size: 1000000 } },
    }));
    expect((client as any).availableModels[0].totalContextTokens).toBe(1000000);
  });

  it("preserves session/update metadata on routed text events", () => {
    const { client } = clientWithFakeProc();
    const seen: unknown[] = [];
    client.on("userMessageChunk", (text, meta) => seen.push({ text, meta }));

    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "restored" },
        },
        _meta: { agentTimestampMs: 1_783_845_298_123, isReplay: true },
      },
    }));

    expect(seen).toEqual([{
      text: "restored",
      meta: { agentTimestampMs: 1_783_845_298_123, isReplay: true },
    }]);
  });

  it("preserves metadata on persisted xAI lifecycle events", () => {
    const { client } = clientWithFakeProc();
    const seen: unknown[] = [];
    client.on("subagentLifecycle", (update, meta) => seen.push({ update, meta }));

    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        update: { sessionUpdate: "turn_completed", prompt_id: "p1" },
        _meta: { agentTimestampMs: 1_783_845_299_456, isReplay: true },
      },
    }));

    expect(seen).toEqual([{
      update: { sessionUpdate: "turn_completed", prompt_id: "p1" },
      meta: { agentTimestampMs: 1_783_845_299_456, isReplay: true },
    }]);
  });
});

describe("AcpClient submitFeedback", () => {
  it("sends _x.ai/feedback with snake_case thumbs params", async () => {
    const { client, written } = clientWithFakeProc();
    client.sessionId = "s1";
    const pending = client.submitFeedback({
      ratingValue: 1,
      clientType: "extension",
      clientVersion: "3.13.0",
    });
    const msg = JSON.parse(written[0]);
    expect(msg).toMatchObject({
      method: "_x.ai/feedback",
      params: {
        session_id: "s1",
        client_type: "extension",
        rating_type: "thumbs",
        rating_value: 1,
        client_version: "3.13.0",
      },
    });
    expect(msg.params.request_id).toBeUndefined();
    expect(msg.params.turn_number).toBeUndefined();
    (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
    await expect(pending).resolves.toBe("ok");
  });

  it("degrades -32601 and disabled-feedback to unsupported", async () => {
    const { client } = clientWithFakeProc();
    client.sessionId = "s1";
    (client as any).request = vi.fn().mockRejectedValue({ code: -32601, message: "Method not found" });
    await expect(client.submitFeedback({
      ratingValue: -1,
      clientType: "desktop",
    })).resolves.toBe("unsupported");

    (client as any).request = vi.fn().mockRejectedValue({
      code: -32603,
      message: "Internal error",
      data: "Feedback is disabled. To enable, set GROK_FEEDBACK_ENABLED=true",
    });
    await expect(client.submitFeedback({
      ratingValue: 1,
      clientType: "desktop",
    })).resolves.toBe("unsupported");
  });

  it("does not call the RPC for Codex or Claude", async () => {
    const { client } = clientWithFakeProc({ backend: new ClaudeBackend() });
    client.sessionId = "s1";
    const request = vi.fn();
    (client as any).request = request;
    await expect(client.submitFeedback({
      ratingValue: 1,
      clientType: "extension",
    })).resolves.toBe("unsupported");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not treat -32602 as a capability gap", async () => {
    const { client } = clientWithFakeProc();
    client.sessionId = "s1";
    (client as any).request = vi.fn().mockRejectedValue({ code: -32602, message: "Invalid params" });
    await expect(client.submitFeedback({
      ratingValue: 1,
      clientType: "extension",
    })).rejects.toMatchObject({ code: -32602 });
  });
});

describe("AcpClient session/info", () => {
  it("returns the structured control-plane context without prompting", async () => {
    const { client } = clientWithFakeProc();
    client.sessionId = "s1";
    const request = vi.fn().mockResolvedValue({ context: { used: 16017, total: 512000 } });
    (client as any).request = request;

    await expect(client.getSessionInfo()).resolves.toEqual({ used: 16017, window: 512000 });
    expect(request).toHaveBeenCalledWith("_x.ai/session/info", { sessionId: "s1" });
  });

  it("degrades only a JSON-RPC method-not-found response to unsupported", async () => {
    const { client } = clientWithFakeProc();
    client.sessionId = "s1";
    (client as any).request = vi.fn().mockRejectedValue({ code: -32601, message: "Method not found" });
    await expect(client.getSessionInfo()).resolves.toBe("unsupported");

    (client as any).request = vi.fn().mockRejectedValue({ code: -32602, message: "Invalid params" });
    await expect(client.getSessionInfo()).rejects.toMatchObject({ code: -32602 });
  });

  it("does not probe Grok's private RPC for an adapter session", async () => {
    const { client } = clientWithFakeProc({ backend: new ClaudeBackend() });
    client.sessionId = "s1";
    const request = vi.fn();
    (client as any).request = request;
    await expect(client.getSessionInfo()).resolves.toBe("unsupported");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("AcpClient session mcpServers", () => {
  it.each([undefined, new CodexBackend(), new ClaudeBackend()])("retains private MCP files through session startup and disposes them with the CLI (%s)", async (backend) => {
    const { client, written } = clientWithFakeProc({ backend });
    const cleanup = vi.fn();
    (client as any).opts.mcpServers = (onDispose) => { onDispose(cleanup); return []; };
    replyToWrites(client, written, () => ({ sessionId: "s1" }));
    await client.newSession();
    await client.loadSession("s1");
    expect(cleanup).not.toHaveBeenCalled();
    await client.dispose();
    await client.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans files supplied by an async secret read that finishes after CLI disposal", async () => {
    const { client } = clientWithFakeProc();
    let finish!: () => void;
    const cleanup = vi.fn();
    (client as any).opts.mcpServers = async (onDispose) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      onDispose(cleanup);
      return [];
    };
    const servers = (client as any).mcpServersForSession();
    await client.dispose();
    finish();
    await servers;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("sends the host-owned list on session/new and session/load", async () => {
    const servers = [{ name: "linear", command: "npx", args: ["-y", MCP_REMOTE_PACKAGE, "https://mcp.linear.app/mcp"] }];
    const { client, written } = clientWithFakeProc();
    (client as any).opts.mcpServers = () => servers;
    replyToWrites(client, written, (msg) => {
      if (msg.method === "session/new" || msg.method === "session/load") {
        return { sessionId: "s1", models: { currentModelId: "grok-build", availableModels: [] } };
      }
      return {};
    });
    await client.newSession();
    expect(JSON.parse(written[0])).toMatchObject({
      method: "session/new",
      params: { mcpServers: servers },
    });
    written.length = 0;
    await client.loadSession("s1");
    expect(JSON.parse(written[0])).toMatchObject({
      method: "session/load",
      params: { sessionId: "s1", mcpServers: servers },
    });
  });

  it("still sends an empty array when nothing is connected", async () => {
    const { client, written } = clientWithFakeProc();
    replyToWrites(client, written, () => ({
      sessionId: "s1",
      models: { currentModelId: "grok-build", availableModels: [] },
    }));
    await client.newSession();
    expect(JSON.parse(written[0]).params.mcpServers).toEqual([]);
  });
});

describe("AcpClient MCP surface", () => {
  it("calls the active-session inventory RPC and degrades -32601 to unsupported", async () => {
    const { client, written } = clientWithFakeProc();
    (client as any).sessionId = "session-1";
    const request = client.listMcpServers();
    const msg = JSON.parse(written[0]);
    expect(msg).toMatchObject({ method: "_x.ai/mcp/list", params: {} });
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0", id: msg.id, result: { servers: [{ name: "docs" }] },
    }));
    await expect(request).resolves.toEqual({ servers: [{ name: "docs" }] });

    const unsupported = client.listMcpServers();
    const missing = JSON.parse(written[1]);
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0", id: missing.id, error: { code: -32601, message: "Method not found" },
    }));
    await expect(unsupported).resolves.toBe("unsupported");
  });

  it("forwards the four MCP health notifications", () => {
    const { client } = clientWithFakeProc();
    const seen: unknown[] = [];
    client.on("mcpNotification", (...args) => seen.push(args));
    for (const method of [
      "_x.ai/mcp/servers_updated",
      "_x.ai/mcp/init_progress",
      "_x.ai/mcp_initialized",
      "_x.ai/mcp/server_status",
    ]) {
      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", method, params: { name: "docs" } }));
    }
    expect(seen.map((entry: any) => entry[0])).toEqual([
      "_x.ai/mcp/servers_updated",
      "_x.ai/mcp/init_progress",
      "_x.ai/mcp_initialized",
      "_x.ai/mcp/server_status",
    ]);
  });
});

describe("AcpClient child-stream demux", () => {
  const parentId = "sess-parent";
  const childId = "sess-child";

  function feed(client: AcpClient, sessionId: string | undefined, update: object, meta?: object) {
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        ...(sessionId ? { sessionId } : {}),
        update,
        ...(meta ? { _meta: meta } : {}),
      },
    }));
  }

  it("emits a child stream — never the parent message path — when sessionId differs", () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = parentId;
    const parentChunks: string[] = [];
    const child: unknown[] = [];
    client.on("messageChunk", (text: string) => parentChunks.push(text));
    client.on("thoughtChunk", (text: string) => parentChunks.push("T:" + text));
    client.on("toolCall", (payload: unknown) => parentChunks.push("tool"));
    client.on("childStream", (ev: unknown) => child.push(ev));

    feed(client, childId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child-prose" } });
    feed(client, childId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "child-think" } });
    feed(client, childId, { sessionUpdate: "tool_call", toolCallId: "t-child", title: "list_dir" });
    feed(client, parentId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent-prose" } });

    expect(parentChunks).toEqual(["parent-prose"]);
    expect(child).toEqual([
      { childSessionId: childId, route: { event: "messageChunk", text: "child-prose" }, meta: undefined },
      { childSessionId: childId, route: { event: "thoughtChunk", text: "child-think" }, meta: undefined },
      { childSessionId: childId, route: { event: "toolCall", payload: { sessionUpdate: "tool_call", toolCallId: "t-child", title: "list_dir" } }, meta: undefined },
    ]);
  });

  it("treats a missing sessionId as the parent conversation (legacy CLI)", () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = parentId;
    const parentChunks: string[] = [];
    const child: unknown[] = [];
    client.on("messageChunk", (text: string) => parentChunks.push(text));
    client.on("childStream", (ev: unknown) => child.push(ev));
    feed(client, undefined, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "legacy" } });
    expect(parentChunks).toEqual(["legacy"]);
    expect(child).toEqual([]);
  });

  it("does not emit a hidden user_message_chunk", () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = parentId;
    const seen: unknown[] = [];
    client.on("userMessageChunk", (text: string) => seen.push(text));
    client.on("childStream", (ev: unknown) => seen.push(ev));
    feed(client, parentId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "<system-reminder>wake</system-reminder>" },
      _meta: { hideFromScrollback: true },
    });
    expect(seen).toEqual([]);
  });
});

describe("AcpClient permission responses", () => {
  it("can decline a request when no safe option was offered", () => {
    const { client, written } = clientWithFakeProc();
    expect(client.respondPermissionCancelled(9)).toBe(true);
    expect(JSON.parse(written[0])).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it("surfaces accepted writes for every user response", async () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = "session-1";

    expect(client.respondPermission(1, "allow-once")).toBe(true);
    expect(client.respondExitPlan(2, "approved")).toBe(true);
    expect(client.respondExitPlanUnavailable(3)).toBe(true);
    expect(client.respondQuestion(4, { Pick: "One" })).toBe(true);
    expect(client.respondQuestionCancelled(5)).toBe(true);
    await expect(client.cancel()).resolves.toBe(true);
  });
});

describe("AcpClient Plan terminal environment", () => {
  it("strips agent-supplied environment overrides from allowed Plan commands", async () => {
    const { client, written } = clientWithFakeProc();
    const create = vi.fn(() => ({ terminalId: "t-1" }));
    client.planActive = true;
    (client as any).terminal = { create };

    await (client as any).handleServerRequest({
      id: 12,
      method: "terminal/create",
      params: {
        command: "node --version",
        cwd: "/workspace",
        env: [
          { name: "NODE_OPTIONS", value: "--require ./evil.js" },
          { name: "PATH", value: "/attacker/bin" },
        ],
      },
    });

    expect(create).toHaveBeenCalledWith({
      command: "node --version",
      cwd: "/workspace",
    });
    expect(JSON.parse(written[0])).toEqual({
      jsonrpc: "2.0",
      id: 12,
      result: { terminalId: "t-1" },
    });
  });

  it("preserves agent-supplied environment overrides outside Plan mode", async () => {
    const { client } = clientWithFakeProc();
    const create = vi.fn(() => ({ terminalId: "t-1" }));
    client.planActive = false;
    (client as any).terminal = { create };
    const env = [{ name: "EXAMPLE", value: "kept" }];

    await (client as any).handleServerRequest({
      id: 13,
      method: "terminal/create",
      params: { command: "custom-command", env },
    });

    expect(create).toHaveBeenCalledWith({ command: "custom-command", env });
  });

  it("raises the Plan gate before a same-chunk terminal/create is dispatched", async () => {
    const { client, written } = clientWithFakeProc();
    const create = vi.fn(() => ({ terminalId: "t-1" }));
    const blocked: Array<{ kind: string; target: string }> = [];
    (client as any).sessionId = "session-1";
    (client as any).terminal = { create };
    client.on("mutationBlocked", (v) => blocked.push(v));

    const stdout = new PassThrough();
    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => (client as any).onLine(line));

    try {
      const pending = client.setMode("plan");
      const req = JSON.parse(written[0]);
      expect(req.method).toBe("session/set_mode");

      stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "terminal/create",
          params: { command: "rm -rf /tmp/x" },
        }) + "\n",
      );

      await pending;
      expect(client.planActive).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(blocked).toEqual([{ kind: "terminal", target: "rm -rf /tmp/x" }]);
    } finally {
      rl.close();
      stdout.destroy();
    }
  });

  it("does not block a same-chunk terminal/create for Codex after Plan is accepted", async () => {
    const { client, written } = clientWithFakeProc({ backend: new CodexBackend() });
    const create = vi.fn(() => ({ terminalId: "t-1" }));
    const blocked: Array<{ kind: string; target: string }> = [];
    (client as any).sessionId = "session-1";
    (client as any).terminal = { create };
    client.on("mutationBlocked", (v) => blocked.push(v));

    const stdout = new PassThrough();
    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => (client as any).onLine(line));

    try {
      const pending = client.setMode("plan");
      const req = JSON.parse(written[0]);
      expect(req.method).toBe("session/set_config_option");

      stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "terminal/create",
          params: { command: "rm -rf /tmp/x" },
        }) + "\n",
      );

      await pending;
      expect(client.planActive).toBe(true);
      expect(client.usesClientPlanGate).toBe(false);
      expect(create).toHaveBeenCalledWith({ command: "rm -rf /tmp/x" });
      expect(blocked).toEqual([]);
    } finally {
      rl.close();
      stdout.destroy();
    }
  });
});

describe("AcpClient.request timer lifecycle", () => {
  it("clears the per-request timeout when the response arrives (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = clientWithFakeProc();
      const before = vi.getTimerCount();

      const p = (client as any).request("session/set_mode", { modeId: "plan" }); // id = 1
      expect(vi.getTimerCount()).toBe(before + 1); // timeout armed

      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      await p;

      expect(vi.getTimerCount()).toBe(before); // timeout cleared on response
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a silent session/prompt on the idle cap (#117)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = clientWithFakeProc({
        timeouts: { promptIdleTimeoutMs: 1_000, promptAbsoluteTimeoutMs: 10_000 },
      });
      const p = (client as any).request("session/prompt", { sessionId: "s", prompt: [] });
      const timedOut = expect(p).rejects.toThrow(/ACP request timed out: session\/prompt/);
      await vi.advanceTimersByTimeAsync(1_000);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a session/prompt that still receives session/update (#117)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = clientWithFakeProc({
        timeouts: { promptIdleTimeoutMs: 1_000, promptAbsoluteTimeoutMs: 10_000 },
      });
      let settled = false;
      const p = (client as any).request("session/prompt", { sessionId: "s", prompt: [] });
      void p.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(800);
      (client as any).onLine(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      }));
      await vi.advanceTimersByTimeAsync(800);
      expect(settled).toBe(false);

      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a session/prompt when a concurrent request gets a response (#117)", async () => {
    // A response is ACP traffic. During a long silent turn the only proof of
    // life can be a reply to an in-turn call (`_x.ai/interject`,
    // `session/set_mode`) — that must extend the prompt's idle window.
    vi.useFakeTimers();
    try {
      const { client } = clientWithFakeProc({
        timeouts: { promptIdleTimeoutMs: 1_000, promptAbsoluteTimeoutMs: 10_000 },
      });
      let settled = false;
      const prompt = (client as any).request("session/prompt", { sessionId: "s", prompt: [] });
      void prompt.then(() => { settled = true; }, () => { settled = true; });

      // A second, concurrent call while the prompt is still open.
      const other = (client as any).request("_x.ai/interject", { sessionId: "s", text: "hi" });
      void other.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(800);
      // Only the concurrent call answers — no session/update at all.
      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }));
      await other;

      await vi.advanceTimersByTimeAsync(800);
      expect(settled).toBe(false); // would already have timed out without the re-arm

      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
      await prompt;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still enforces the absolute cap even when updates keep arriving (#117)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = clientWithFakeProc({
        timeouts: { promptIdleTimeoutMs: 10_000, promptAbsoluteTimeoutMs: 1_000 },
      });
      const p = (client as any).request("session/prompt", { sessionId: "s", prompt: [] });
      (client as any).onLine(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      }));
      const timedOut = expect(p).rejects.toThrow(/ACP request timed out: session\/prompt/);
      await vi.advanceTimersByTimeAsync(1_000);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});

// #3/#4 (thanks @shugav for the crash report): the startup crash was the bogus
// `max` value, not reasoningEffort itself — grok accepts none|minimal|low|medium|
// high|xhigh, and the flag must precede the `stdio` subcommand.
// #79: grok's image-aware read_file only runs when we do not advertise
// readTextFile. Measured on 1.0.4; only a live-verified banner at that
// floor (no upper cap) may select the withheld handshake.
describe("acpClientCapabilities", () => {
  it("withholds readTextFile on a live-verified grok at or above 1.0.4", () => {
    expect(acpClientCapabilities("grok", "1.0.4", true)).toEqual(ACP_IMAGE_READ_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "grok 1.0.4 (abc) [stable]", true)).toEqual(ACP_IMAGE_READ_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "1.1.0", true).fs).not.toHaveProperty("readTextFile");
    expect(acpClientCapabilities("grok", "2.0.0", true)).toEqual(ACP_IMAGE_READ_FS_CAPABILITIES);
  });

  it("keeps the delegated handshake on a live-verified grok 1.0.3", () => {
    expect(acpClientCapabilities("grok", "1.0.3", true)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "grok 1.0.3 (x) [stable]", true)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "1.0.0", true)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
  });

  it("keeps the delegated handshake for an unverified 1.x banner even when the number is at the floor", () => {
    expect(acpClientCapabilities("grok", "1.0.4")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "1.0.4", false)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "grok 1.1.0 (x) [stable]")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "2.0.0", false)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
  });

  it("keeps the delegated handshake on grok 0.2.117", () => {
    expect(acpClientCapabilities("grok", "0.2.117", true)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "grok 0.2.117 (x) [stable]", true)).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
  });

  it("keeps the delegated handshake for Codex", () => {
    expect(acpClientCapabilities("codex")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("codex", "1.0.4", true)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
  });

  it("keeps the delegated handshake when the grok version is unknown", () => {
    expect(acpClientCapabilities("grok")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "unparseable", true)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", null, true)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
  });
});

describe("cliHonorsInterjectContent", () => {
  it("is true only for a live-verified grok 1.x", () => {
    expect(cliHonorsInterjectContent("1.0.0", true)).toBe(true);
    expect(cliHonorsInterjectContent("grok 1.0.5 (x) [stable]", true)).toBe(true);
    expect(cliHonorsInterjectContent("1.0.5", false)).toBe(false);
    expect(cliHonorsInterjectContent("0.2.117", true)).toBe(false);
    expect(cliHonorsInterjectContent("unparseable", true)).toBe(false);
    expect(cliHonorsInterjectContent()).toBe(false);
  });
});

describe("buildInterjectParams", () => {
  it("omits content when there are no image blocks — legacy wire", () => {
    expect(buildInterjectParams("s1", "steer")).toEqual({ sessionId: "s1", text: "steer" });
    expect(buildInterjectParams("s1", "steer", [{ type: "text", text: "steer" }])).toEqual({
      sessionId: "s1",
      text: "steer",
    });
    expect(Object.keys(buildInterjectParams("s1", "steer"))).toEqual(["sessionId", "text"]);
  });

  it("includes content when an image block is present", () => {
    const content = [
      { type: "text" as const, text: "look at [Image #1]" },
      { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" },
    ];
    expect(buildInterjectParams("s1", "look at this", content)).toEqual({
      sessionId: "s1",
      text: "look at this",
      content,
    });
  });
});

describe("AcpClient.interject wire", () => {
  it("sends text-only params without a content key", async () => {
    const { client, written } = clientWithFakeProc();
    (client as any).sessionId = "s1";
    replyToWrites(client, written, () => ({ status: "queued" }));
    await expect(client.interject("steer left")).resolves.toBe("ok");
    const sent = JSON.parse(written[0]);
    expect(sent).toMatchObject({
      method: "_x.ai/interject",
      params: { sessionId: "s1", text: "steer left" },
    });
    expect(sent.params).not.toHaveProperty("content");
  });

  it("sends additive content when image blocks are provided", async () => {
    const { client, written } = clientWithFakeProc();
    (client as any).sessionId = "s1";
    replyToWrites(client, written, () => ({ status: "queued" }));
    const content = [
      { type: "text" as const, text: "look at [Image #1]" },
      { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" },
    ];
    await expect(client.interject("look at this", undefined, content)).resolves.toBe("ok");
    const sent = JSON.parse(written[0]);
    expect(sent.params).toEqual({
      sessionId: "s1",
      text: "look at this",
      content,
    });
  });

  it("honorsInterjectContent follows the live-verified 1.x floor", () => {
    const yes = new AcpClient({
      cliPath: "x", cwd: "/", log: () => {}, grokVersion: "1.0.5", grokVersionVerified: true,
    });
    const no = new AcpClient({
      cliPath: "x", cwd: "/", log: () => {}, grokVersion: "0.2.117", grokVersionVerified: true,
    });
    expect(yes.honorsInterjectContent()).toBe(true);
    expect(no.honorsInterjectContent()).toBe(false);
  });
});

describe("buildGrokAgentArgs", () => {
  it("starts ACP sessions with the stdio subcommand when no effort is set", () => {
    expect(buildGrokAgentArgs()).toEqual(["agent", "stdio"]);
  });

  it("forwards a valid effort as --reasoning-effort before the stdio subcommand", () => {
    expect(buildGrokAgentArgs("high")).toEqual(["agent", "--reasoning-effort", "high", "stdio"]);
    expect(buildGrokAgentArgs("none")).toEqual(["agent", "--reasoning-effort", "none", "stdio"]);
    expect(buildGrokAgentArgs("xhigh")).toEqual(["agent", "--reasoning-effort", "xhigh", "stdio"]);
  });
});

describe("adapter session/new effort", () => {
  it("sends Claude effort as session/set_config_option after session/new", async () => {
    const { client, written } = clientWithFakeProc({ backend: new ClaudeBackend(), effort: "high" });
    replyToWrites(client, written, (msg) => {
      if (msg.method === "session/new") {
        return {
          sessionId: "s1",
          configOptions: [
            { id: "model", currentValue: "claude-opus-4-6", options: [{ value: "claude-opus-4-6", name: "Opus" }] },
            { id: "effort", currentValue: "default", options: [{ value: "low" }, { value: "high" }] },
          ],
        };
      }
      if (msg.method === "session/set_config_option") {
        return { configOptions: [
          { id: "model", currentValue: "claude-opus-4-6" },
          { id: "effort", currentValue: msg.params.value },
        ] };
      }
      return {};
    });
    await client.newSession();
    const calls = written.map((line) => JSON.parse(line));
    expect(calls.some((msg) => msg.method === "session/set_config_option" && msg.params.configId === "effort" && msg.params.value === "high")).toBe(true);
    expect(client.currentReasoningEffort).toBe("high");
  });

  it("sends Codex effort as session/set_config_option after session/new", async () => {
    const { client, written } = clientWithFakeProc({ backend: new CodexBackend(), effort: "high" });
    replyToWrites(client, written, (msg) => {
      if (msg.method === "session/new") {
        return {
          sessionId: "s1",
          models: {
            currentModelId: "gpt-5.6-sol[high]",
            availableModels: [
              { modelId: "gpt-5.6-sol[low]", name: "Sol (low)" },
              { modelId: "gpt-5.6-sol[high]", name: "Sol (high)" },
            ],
          },
        };
      }
      if (msg.method === "session/set_config_option") {
        return { configOptions: [
          { id: "model", currentValue: "gpt-5.6-sol" },
          { id: "reasoning_effort", currentValue: msg.params.value },
        ] };
      }
      return {};
    });
    await client.newSession();
    const calls = written.map((line) => JSON.parse(line));
    expect(calls.some((msg) => msg.method === "session/set_config_option" && msg.params.configId === "reasoning_effort" && msg.params.value === "high")).toBe(true);
    expect(client.currentReasoningEffort).toBe("high");
  });

  it("does not send a post-new effort RPC for grok (spawn already applied it)", async () => {
    const { client, written } = clientWithFakeProc({ effort: "high" });
    replyToWrites(client, written, (msg) => {
      if (msg.method === "session/new") return { sessionId: "s1", models: { currentModelId: "grok-build", availableModels: [] } };
      return { _meta: { model: { Ok: "grok-build" } } };
    });
    await client.newSession();
    expect(written.map((line) => JSON.parse(line).method)).toEqual(["session/new"]);
  });
});

describe("adapter config_option_update", () => {
  it("emits the permission mode when Codex leaves plan via config_option_update", () => {
    const { client } = clientWithFakeProc({ backend: new CodexBackend() });
    const modes: string[] = [];
    client.on("modeChanged", (mode) => modes.push(mode));
    client.currentModeId = "plan";
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "collaboration_mode", currentValue: "default" },
            { id: "mode", currentValue: "agent" },
          ],
        },
      },
    }));
    expect(modes).toEqual(["agent"]);
    expect(client.currentModeId).toBe("agent");
  });

  it("emits agent-full-access when Codex leaves plan still in full-access", () => {
    const { client } = clientWithFakeProc({ backend: new CodexBackend() });
    const modes: string[] = [];
    client.on("modeChanged", (mode) => modes.push(mode));
    client.currentModeId = "plan";
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "collaboration_mode", currentValue: "default" },
            { id: "mode", currentValue: "agent-full-access" },
          ],
        },
      },
    }));
    expect(modes).toEqual(["agent-full-access"]);
    expect(client.currentModeId).toBe("agent-full-access");
  });
});
