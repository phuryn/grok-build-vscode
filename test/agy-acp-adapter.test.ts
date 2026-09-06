import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AgyAcpAdapterServer,
  isImplementationPlanTool,
  extractPlanText,
  cleanPromptTitle,
  normalizeBaselineKey,
  findTranscriptPath,
  findRecentTranscriptToolCall,
  unwrapTranscriptStrings,
  synthesizeAgyToolDiff,
} from "../src/agy-acp-adapter";

// The conversation map is real state under ~/.gemini in production. A test must
// never read or write the user's own resume state, so every server gets its own.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-adapter-test-"));
let storeSeq = 0;
const nextStore = () => path.join(scratchDir, `conversations-${++storeSeq}.json`);

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    this.emit("exit", 0);
  }
}

describe("AgyAcpAdapterServer", () => {
  it("responds to initialize with ACP protocol version and capabilities", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
    });
    server.start();

    const responses: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 10));

    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
    });

    server.dispose();
  });

  it("handles session/new with models and config options", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
    });
    server.start();

    const responses: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 10));

    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(2);
    expect(responses[0].result.sessionId).toBeDefined();
    expect(responses[0].result.models.currentModelId).toBe("gemini-3.8-flash");
    expect(responses[0].result.models.availableModels.length).toBeGreaterThanOrEqual(4);
    expect(responses[0].result.configOptions).toHaveLength(3);

    server.dispose();
  });

  it("handles set_config_option and set_mode", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
    });
    server.start();

    const responses: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: { configId: "model", value: "gemini-3.1-pro" },
    }) + "\n");

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: { configId: "reasoning_effort", value: "low" },
    }) + "\n");

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "session/set_mode",
      params: { modeId: "yolo" },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    expect(server.currentModelId).toBe("gemini-3.1-pro");
    expect(server.currentEffort).toBe("low");
    expect(server.currentModeId).toBe("yolo");

    server.dispose();
  });

  it("translates session/prompt to NDJSON and streams step updates and prompt result", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let fakeProc: FakeProcess | undefined;

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    const messages: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: {
        sessionId: "test-sess",
        prompt: [{ type: "text", text: "Hello Antigravity" }],
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProc).toBeDefined();

    // Verify agy stdin received NDJSON prompt
    let stdinData = "";
    fakeProc!.stdin.on("data", (d) => { stdinData += d.toString(); });
    await new Promise((r) => setTimeout(r, 10));

    // Simulate agy events
    fakeProc!.stdout.write(JSON.stringify({
      event: "init",
      conversation_id: "conv-12345",
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "Hi there! ",
        usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, total_tokens: 110 },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "Ready to assist.\n",
        usage: { input_tokens: 100, output_tokens: 25, thinking_tokens: 10, total_tokens: 125 },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Hi there! Ready to assist.\n",
        usage: { input_tokens: 100, output_tokens: 25, thinking_tokens: 10, total_tokens: 125 },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    // Check updates: should have 2 session/update notifications and 1 response for id: 6
    const notifications = messages.filter((m) => m.method === "session/update");
    expect(notifications).toHaveLength(2);
    expect(notifications[0].params.update.content.text).toBe("Hi there! ");
    expect(notifications[1].params.update.content.text).toBe("Ready to assist.\n");

    const promptRes = messages.find((m) => m.id === 6);
    expect(promptRes).toBeDefined();
    expect(promptRes.result).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        thoughtTokens: 10,
        totalTokens: 125,
      },
    });

    server.dispose();
  });

  it("translates tool step updates to ACP tool_call and tool_call_update", { timeout: 15000 }, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let fakeProc: FakeProcess | undefined;

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      // write_to_file targets a path that never exists on disk in this test,
      // so waitForDiskChangeText's poll always exhausts its full budget —
      // shrunk here so this (non-timing) test doesn't pay the ~10s production cost.
      diskPollAttempts: 3,
      diskPollDelayMs: 10,
      spawnFn: () => {
        fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    const messages: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: {
        sessionId: "sess-tools",
        prompt: [{ type: "text", text: "Create test.md" }],
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProc).toBeDefined();

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: {
          name: "write_to_file",
          parameters: { TargetFile: "C:\\workspace\\test.md" },
        },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: {
          name: "write_to_file",
          parameters: { TargetFile: "C:\\workspace\\test.md" },
          output: "Successfully written 20 bytes",
        },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "File created.",
      },
    }) + "\n");

    // write_to_file targets a path that never actually exists on disk in this
    // test, so the DONE-phase disk-change poll (waitForDiskChangeText) runs
    // its full retry budget (~3s) before resolving — see agy-acp-adapter.ts.
    // Polled rather than a fixed sleep: under a loaded full-suite run the
    // retry loop's own timers can run behind a fixed buffer.
    for (let i = 0; i < 100 && !messages.some((m) => m.params?.update?.sessionUpdate === "tool_call_update"); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const toolCalls = messages.filter((m) => m.params?.update?.sessionUpdate === "tool_call");
    const toolUpdates = messages.filter((m) => m.params?.update?.sessionUpdate === "tool_call_update");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].params.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-3",
      title: "Create test.md",
      kind: "edit",
      status: "in_progress",
      rawInput: {
        TargetFile: "C:\\workspace\\test.md",
        file_path: "C:\\workspace\\test.md",
      },
    });

    expect(toolUpdates).toHaveLength(1);
    expect(toolUpdates[0].params.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-3",
      title: "Create test.md",
      kind: "edit",
      status: "completed",
      rawInput: {
        TargetFile: "C:\\workspace\\test.md",
        file_path: "C:\\workspace\\test.md",
      },
    });

    // Test run_command normalization
    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 4,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "git status" },
        },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    const cmdCall = messages.find((m) => m.params?.update?.toolCallId === "tool-4");
    expect(cmdCall).toBeDefined();
    expect(cmdCall.params.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-4",
      title: "git status",
      kind: "execute",
      status: "in_progress",
      rawInput: {
        CommandLine: "git status",
        command: "git status",
        cmd: "git status",
      },
    });

    server.dispose();
  });

  describe("session/load transcript replay includes tool calls", () => {
    it("replays a completed edit tool call with a synthesized diff (best-effort field names)", async () => {
      const geminiHome = fs.mkdtempSync(path.join(scratchDir, "gemini-home-"));
      const conversationId = "11111111-2222-3333-4444-555555555555";
      const logsDir = path.join(geminiHome, "antigravity-cli", "brain", conversationId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "transcript.jsonl"),
        [
          JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>rename token</USER_REQUEST>" }),
          JSON.stringify({
            type: "AGENT_ACTION",
            tool_calls: [
              { name: "replace_file_content", args: { TargetFile: "a.ts", TargetContent: "old", ReplacementContent: "new" } },
            ],
          }),
          JSON.stringify({ type: "PLANNER_RESPONSE", content: "Done." }),
        ].join("\n"),
        "utf8",
      );

      const input = new PassThrough();
      const output = new PassThrough();
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        geminiHome,
        inputStream: input,
        outputStream: output,
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 30, method: "session/load",
        params: { sessionId: conversationId },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const toolCall = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call")?.params.update;
      expect(toolCall).toBeDefined();
      expect(toolCall.status).toBe("completed");
      expect(toolCall.kind).toBe("edit");
      expect(toolCall.content).toEqual([{ type: "diff", path: "a.ts", oldText: "old", newText: "new" }]);

      server.dispose();
    });

    it("unwraps transcript.jsonl's double-JSON-encoded string args before building the replay diff", async () => {
      // Real capture from a live agy 1.1.26 transcript.jsonl: every string arg
      // is JSON-stringified a second time, so its value (once the whole line
      // is parsed) still carries a leading/trailing literal quote character —
      // e.g. `"TargetContent":"\"old\""` decodes here to `"\"old\""`, not `"old"`.
      const geminiHome = fs.mkdtempSync(path.join(scratchDir, "gemini-home-"));
      const conversationId = "22222222-3333-4444-5555-666666666666";
      const logsDir = path.join(geminiHome, "antigravity-cli", "brain", conversationId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "transcript.jsonl"),
        JSON.stringify({
          type: "AGENT_ACTION",
          tool_calls: [{
            name: "replace_file_content",
            args: {
              TargetFile: JSON.stringify("a.ts"),
              TargetContent: JSON.stringify("old value"),
              ReplacementContent: JSON.stringify("new value"),
            },
          }],
        }) + "\n",
        "utf8",
      );

      const input = new PassThrough();
      const output = new PassThrough();
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        geminiHome,
        inputStream: input,
        outputStream: output,
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 31, method: "session/load",
        params: { sessionId: conversationId },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const toolCall = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call")?.params.update;
      expect(toolCall.content).toEqual([{ type: "diff", path: "a.ts", oldText: "old value", newText: "new value" }]);

      server.dispose();
    });

    it("skips a tool_calls entry whose name field doesn't match any known key", async () => {
      const geminiHome = fs.mkdtempSync(path.join(scratchDir, "gemini-home-"));
      const conversationId = "66666666-7777-8888-9999-000000000000";
      const logsDir = path.join(geminiHome, "antigravity-cli", "brain", conversationId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "transcript.jsonl"),
        JSON.stringify({ type: "AGENT_ACTION", tool_calls: [{ args: { TargetFile: "a.ts" } }] }) + "\n",
        "utf8",
      );

      const input = new PassThrough();
      const output = new PassThrough();
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        geminiHome,
        inputStream: input,
        outputStream: output,
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 31, method: "session/load",
        params: { sessionId: conversationId },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      expect(messages.find((m) => m.params?.update?.sessionUpdate === "tool_call")).toBeUndefined();
      server.dispose();
    });
  });

  describe("diff synthesis for edit tools", () => {
    it("synthesizes a create diff for write_to_file when the file doesn't exist yet", async () => {
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-"));
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 20, method: "session/prompt",
        params: { sessionId: "sess-diff", prompt: [{ type: "text", text: "Create new.md" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      // No file on disk yet at ACTIVE — matches a genuine creation.
      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file",
          tool_info: { name: "write_to_file", parameters: { TargetFile: "new.md" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      // The write lands on disk between ACTIVE and DONE, exactly like a real tool run.
      fs.writeFileSync(path.join(projectDir, "new.md"), "hello\n", "utf8");

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_to_file",
          tool_info: { name: "write_to_file", parameters: { TargetFile: "new.md" }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const toolCall = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call")?.params.update;
      const toolUpdate = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call_update")?.params.update;
      expect(toolCall.content).toBeUndefined(); // ACTIVE has nothing to diff yet — the write hasn't landed
      expect(toolUpdate.content).toEqual([{ type: "diff", path: "new.md", oldText: "", newText: "hello\n" }]);

      server.dispose();
    });

    it("polls past agy's own DONE-before-write race instead of reporting a degenerate diff", async () => {
      // Reproduces a live capture against real agy (1.1.26): the DONE step
      // notification for replace_file_content arrived before the write had
      // actually landed on disk — two reads taken right at the DONE event
      // came back byte-identical with the SAME mtime. Simulated here by
      // writing the file shortly AFTER the DONE line, not before it.
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-"));
      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 1;\n", "utf8");
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 25, method: "session/prompt",
        params: { sessionId: "sess-race", prompt: [{ type: "text", text: "Edit a.ts" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" }, output: "ok" },
        },
      }) + "\n");

      // The write lands ~120ms AFTER the DONE line — inside the poll's retry
      // budget, but after its first read would have found nothing changed.
      await new Promise((r) => setTimeout(r, 120));
      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 2;\n", "utf8");

      let toolUpdate: any;
      for (let i = 0; i < 100 && !toolUpdate?.content; i++) {
        toolUpdate = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call_update")?.params.update;
        if (!toolUpdate?.content) await new Promise((r) => setTimeout(r, 100));
      }
      expect(toolUpdate?.content).toEqual([
        { type: "diff", path: "a.ts", oldText: "const x = 1;\n", newText: "const x = 2;\n" },
      ]);

      server.dispose();
    }, 20000);

    it("sends a corrective diff at turn-end when the write lands only after the DONE-phase poll gave up", async () => {
      // Live evidence: some edits still hadn't landed on disk even after the
      // full DONE-phase poll budget — the write can be deferred until the
      // whole turn finishes, not just this tool step. flushPendingEditRechecks
      // (called right before the "result" event resolves) catches this.
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-"));
      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 1;\n", "utf8");
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        // Shrunk so this test doesn't have to wait out the full ~10s
        // production budget before the write "never lands in time" — the
        // behavior under test (queue-for-recheck) is budget-size-independent.
        diskPollAttempts: 3,
        diskPollDelayMs: 20,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 26, method: "session/prompt",
        params: { sessionId: "sess-turnend", prompt: [{ type: "text", text: "Edit a.ts" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" }, output: "ok" },
        },
      }) + "\n");

      // Wait past the full DONE-phase poll budget (~3s) WITHOUT the write ever
      // landing — the DONE tool_call_update goes out degenerate (oldText ===
      // newText), and the edit gets queued for a turn-end recheck. Polled
      // rather than a fixed sleep — the retry loop's own timers can run
      // behind under a loaded test machine (a full-suite run is many
      // concurrent timers), and a fixed 3200ms buffer proved flaky there.
      let degenerateUpdate: any;
      for (let i = 0; i < 100 && !degenerateUpdate; i++) {
        degenerateUpdate = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call_update")?.params.update;
        if (!degenerateUpdate) await new Promise((r) => setTimeout(r, 100));
      }
      expect(degenerateUpdate?.content).toEqual([
        { type: "diff", path: "a.ts", oldText: "const x = 1;\n", newText: "const x = 1;\n" },
      ]);

      // The write finally lands, then the turn completes.
      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 2;\n", "utf8");
      fakeProc!.stdout.write(JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "Done." },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      const updates = messages.filter((m) => m.params?.update?.sessionUpdate === "tool_call_update");
      expect(updates).toHaveLength(2); // the degenerate one, then the turn-end correction
      expect(updates[1].params.update).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        content: [{ type: "diff", path: "a.ts", oldText: "const x = 1;\n", newText: "const x = 2;\n" }],
      });

      server.dispose();
    }, 20000);

    it("reads disk only in ACTIVE for a write_to_file overwrite, and reuses it in DONE", async () => {
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-"));
      fs.writeFileSync(path.join(projectDir, "existing.md"), "before\n", "utf8");
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 21, method: "session/prompt",
        params: { sessionId: "sess-diff2", prompt: [{ type: "text", text: "Overwrite existing.md" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file",
          tool_info: { name: "write_to_file", parameters: { TargetFile: "existing.md", CodeContent: "after\n" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      // Simulate the write actually landing on disk between ACTIVE and DONE —
      // a DONE-branch disk read would see "after" on both sides. It must not.
      fs.writeFileSync(path.join(projectDir, "existing.md"), "after\n", "utf8");

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_to_file",
          tool_info: { name: "write_to_file", parameters: { TargetFile: "existing.md", CodeContent: "after\n" }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const toolUpdate = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call_update")?.params.update;
      expect(toolUpdate.content).toEqual([{ type: "diff", path: "existing.md", oldText: "before\n", newText: "after\n" }]);

      server.dispose();
    });

    it("uses the previous edit's result as the baseline for a second edit, when the write already landed before ACTIVE was processed", async () => {
      // Live evidence (real agy, reported directly by the user): edits land
      // on disk essentially instantly — the editor reflects the change
      // immediately. For a second edit to the SAME file within one session,
      // that means the ACTIVE-phase disk read can already be seeing the
      // SECOND edit's own result (not a "before" snapshot at all), which
      // would previously produce a degenerate oldText === newText diff.
      // sessionFileBaseline sidesteps this: DONE's result from the first
      // edit seeds the baseline used by the second edit's ACTIVE, instead of
      // re-reading disk (which would just see the second write's content on
      // both "sides").
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-"));
      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 1;\n", "utf8");
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      // First turn: edit a.ts from "1" to "2".
      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 30, method: "session/prompt",
        params: { sessionId: "sess-baseline", prompt: [{ type: "text", text: "Edit a.ts to 2" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 2;\n", "utf8");
      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fakeProc!.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      // Second turn: edit a.ts from "2" to "3" — but the write lands on disk
      // BEFORE ACTIVE is even processed, so a plain disk read at ACTIVE would
      // already see "3", not "2".
      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 31, method: "session/prompt",
        params: { sessionId: "sess-baseline", prompt: [{ type: "text", text: "Edit a.ts to 3" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 3;\n", "utf8");
      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2, state: "DONE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const updates = messages.filter((m) => m.params?.update?.sessionUpdate === "tool_call_update");
      expect(updates[1].params.update.content).toEqual([
        { type: "diff", path: "a.ts", oldText: "const x = 2;\n", newText: "const x = 3;\n" },
      ]);

      server.dispose();
    });

    it("synthesizes a replace_file_content diff from disk, even when parameters carry only TargetFile", async () => {
      // Regression test for a live capture against real agy (1.1.26): the
      // ACTUAL tool_info.parameters for replace_file_content carried ONLY
      // TargetFile — no TargetContent/ReplacementContent/StartLine/EndLine at
      // all (those exist in Antigravity's own transcript.jsonl, a different,
      // internal log — not on the live stream-json wire this adapter reads).
      // Trusting those fields produced a degenerate oldText === newText ===
      // "" diff ("+0 -0" in the UI) even though the file visibly changed.
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-"));
      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 1;\n", "utf8");
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 22, method: "session/prompt",
        params: { sessionId: "sess-diff3", prompt: [{ type: "text", text: "Edit a.ts" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fs.writeFileSync(path.join(projectDir, "a.ts"), "const x = 2;\n", "utf8");

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: "a.ts" }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const toolUpdate = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call_update")?.params.update;
      expect(toolUpdate.content).toEqual([
        { type: "diff", path: "a.ts", oldText: "const x = 1;\n", newText: "const x = 2;\n" },
      ]);

      server.dispose();
    });

    it("synthesizes a multi_replace_file_content diff from disk the same way as a single replace", async () => {
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-"));
      fs.writeFileSync(path.join(projectDir, "b.ts"), "old1\nold2\n", "utf8");
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 23, method: "session/prompt",
        params: { sessionId: "sess-diff4", prompt: [{ type: "text", text: "Rename token" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "multi_replace_file_content",
          tool_info: { name: "multi_replace_file_content", parameters: { TargetFile: "b.ts" } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fs.writeFileSync(path.join(projectDir, "b.ts"), "new1\nnew2\n", "utf8");

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "multi_replace_file_content",
          tool_info: { name: "multi_replace_file_content", parameters: { TargetFile: "b.ts" }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const toolUpdate = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call_update")?.params.update;
      expect(toolUpdate.content).toEqual([
        { type: "diff", path: "b.ts", oldText: "old1\nold2\n", newText: "new1\nnew2\n" },
      ]);

      server.dispose();
    });

    it("emits no content for an errored edit tool call", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;
      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 24, method: "session/prompt",
        params: { sessionId: "sess-diff5", prompt: [{ type: "text", text: "Edit c.ts" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ERROR", step_type: "tool", tool_name: "replace_file_content",
          tool_info: {
            name: "replace_file_content",
            parameters: { TargetFile: "c.ts", TargetContent: "x", ReplacementContent: "y" },
            error: { message: "not found" },
          },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      const toolUpdate = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call_update")?.params.update;
      expect(toolUpdate.content).toBeUndefined();

      server.dispose();
    });
  });

  it("updates cwd and passes --add-dir and effort to agy process", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let spawnArgs: string[] = [];
    let spawnOpts: any;

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      defaultEffort: "high",
      inputStream: input,
      outputStream: output,
      spawnFn: (cmd, args, opts) => {
        spawnArgs = args;
        spawnOpts = opts;
        const fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "session/new",
      params: { cwd: "C:\\my-project\\workspace" },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 10));
    expect(server.cwd).toBe("C:\\my-project\\workspace");

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Test prompt" }] },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    expect(spawnArgs).toContain("--add-dir");
    expect(spawnArgs).toContain("C:\\my-project\\workspace");
    expect(spawnArgs).toContain("--effort");
    expect(spawnArgs).toContain("high");
    expect(spawnArgs).toContain("--print-timeout");
    expect(spawnArgs).toContain("24h");
    expect(spawnOpts.cwd).toBe("C:\\my-project\\workspace");

    server.dispose();
  });

  it("maps grep_search and find_by_name to kind search with correct titles", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let fakeProc: FakeProcess | undefined;

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    const messages: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "search test" }] },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProc).toBeDefined();

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "grep_search",
        tool_info: {
          name: "grep_search",
          parameters: { Query: "newsession(" },
        },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 6,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "find_by_name",
        tool_info: {
          name: "find_by_name",
          parameters: { Pattern: "*claude*" },
        },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    const grepCall = messages.find((m) => m.params?.update?.toolCallId === "tool-5");
    expect(grepCall).toBeDefined();
    expect(grepCall.params.update.kind).toBe("search");
    expect(grepCall.params.update.title).toBe('Search "newsession("');

    const findCall = messages.find((m) => m.params?.update?.toolCallId === "tool-6");
    expect(findCall).toBeDefined();
    expect(findCall.params.update.kind).toBe("search");
    expect(findCall.params.update.title).toBe('Find "*claude*"');

    server.dispose();
  });

  it("session/new isolates sessions by terminating agy process and resetting conversation id", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];
    const spawnArgsHistory: string[][] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: (_cmd, args) => {
        spawnArgsHistory.push(args);
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();

    // 1. First session prompt
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 30,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "First conversation" }] },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(spawnedProcs).toHaveLength(1);
    expect(spawnArgsHistory[0]).not.toContain("--conversation");

    // Simulate agy setting conversation_id
    spawnedProcs[0].stdout.write(JSON.stringify({
      event: "init",
      conversation_id: "conv-session-1",
    }) + "\n");

    spawnedProcs[0].stdout.write(JSON.stringify({
      event: "result",
      result: { status: "SUCCESS" },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(server.activeConversationId).toBe("conv-session-1");

    // 2. User clicks New Chat (session/new) in the SAME workspace
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 31,
      method: "session/new",
      params: {},
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    // Old process must have been killed and conversation id cleared
    expect(spawnedProcs[0].killed).toBe(true);
    expect(server.activeConversationId).toBeUndefined();

    // 3. Prompt in the new session must NOT inherit conv-session-1
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 32,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Second conversation" }] },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(spawnedProcs).toHaveLength(2);
    expect(spawnArgsHistory[1]).not.toContain("--conversation");
    expect(spawnArgsHistory[1]).not.toContain("conv-session-1");

    server.dispose();
  });

  it("session/load terminates existing process and resets activeConversationId", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 40,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Old chat" }] },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(spawnedProcs).toHaveLength(1);

    spawnedProcs[0].stdout.write(JSON.stringify({
      event: "init",
      conversation_id: "conv-old",
    }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(server.activeConversationId).toBe("conv-old");

    // Load another session
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "session/load",
      params: { sessionId: "sess-2" },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(spawnedProcs[0].killed).toBe(true);
    expect(server.activeConversationId).toBeUndefined();
    expect(server.sessionId).toBe("sess-2");

    server.dispose();
  });

  it("continues the same conversation on the next turn", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];
    const spawnArgsHistory: string[][] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: (_cmd, args) => {
        spawnArgsHistory.push(args);
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 40, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Turn one" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    spawnedProcs[0].stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-continue" }) + "\n");
    spawnedProcs[0].stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // The CLI exits after the turn; the next one must resume, not start over.
    spawnedProcs[0].emit("exit", 0);
    await new Promise((r) => setTimeout(r, 10));

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 41, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Turn two" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnedProcs).toHaveLength(2);
    expect(spawnArgsHistory[1]).toContain("--conversation");
    expect(spawnArgsHistory[1]).toContain("conv-continue");

    server.dispose();
  });

  it("session/load resumes the conversation that session owns, across adapter restarts", async () => {
    const store = nextStore();

    const firstInput = new PassThrough();
    const firstOutput = new PassThrough();
    const firstProcs: FakeProcess[] = [];
    const first = new AgyAcpAdapterServer({
      conversationStorePath: store,
      inputStream: firstInput,
      outputStream: firstOutput,
      spawnFn: () => {
        const proc = new FakeProcess();
        firstProcs.push(proc);
        return proc as any;
      },
    });
    first.start();

    firstInput.write(JSON.stringify({
      jsonrpc: "2.0", id: 50, method: "session/load", params: { sessionId: "sess-persist" },
    }) + "\n");
    firstInput.write(JSON.stringify({
      jsonrpc: "2.0", id: 51, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Remember this" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    firstProcs[0].stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-persist" }) + "\n");
    firstProcs[0].stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    first.dispose();

    // A different adapter process - what reopening the conversation later gets.
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnArgsHistory: string[][] = [];
    const server = new AgyAcpAdapterServer({
      conversationStorePath: store,
      inputStream: input,
      outputStream: output,
      spawnFn: (_cmd, args) => {
        spawnArgsHistory.push(args);
        return new FakeProcess() as any;
      },
    });
    server.start();

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 52, method: "session/load", params: { sessionId: "sess-persist" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(server.activeConversationId).toBe("conv-persist");

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 53, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Follow-up" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgsHistory[0]).toContain("conv-persist");

    // A brand new session in the same adapter still starts clean.
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 54, method: "session/new", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(server.activeConversationId).toBeUndefined();

    server.dispose();
  });

  it("session/cancel kills the CLI and answers the running prompt as cancelled", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];
    const responses: any[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 60, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Long running" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnedProcs).toHaveLength(1);

    // ACP sends cancel as a notification - no id.
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnedProcs[0].killed).toBe(true);
    const answer = responses.find((m) => m.id === 60);
    expect(answer?.result?.stopReason).toBe("cancelled");
    expect(answer?.error).toBeUndefined();

    server.dispose();
  });

  it("a model switch during a running turn does not throw that turn away", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];
    const spawnArgsHistory: string[][] = [];
    const responses: any[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: (_cmd, args) => {
        spawnArgsHistory.push(args);
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 70, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Working" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 71, method: "session/set_config_option",
      params: { configId: "model", value: "gemini-3.1-pro" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnedProcs[0].killed).toBe(false);
    expect(responses.find((m) => m.id === 70)).toBeUndefined();

    spawnedProcs[0].stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(responses.find((m) => m.id === 70)?.result?.stopReason).toBe("end_turn");

    // The deferred switch lands on the next prompt.
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 72, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Next" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnedProcs).toHaveLength(2);
    expect(spawnArgsHistory[1]).toContain("gemini-3.1-pro");

    server.dispose();
  });

  it("sends exactly as many --effort flags as the model accepts", async () => {
    // Measured against agy 1.1.26: `--model gemini-3.8-flash` alone is refused
    // with "requires --effort", and `--model gpt-oss-120b-medium --effort high`
    // with "conflicts with --effort=high". One, or none, never both or neither.
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnArgsHistory: string[][] = [];
    const spawnedProcs: FakeProcess[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: (_cmd, args) => {
        spawnArgsHistory.push(args);
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();

    const finishTurn = async (index: number) => {
      spawnedProcs[index].stdout.write(
        JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\n",
      );
      await new Promise((r) => setTimeout(r, 20));
    };

    // "Default" on a model that groups by effort resolves to a real level.
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 80, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Default effort" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgsHistory[0]).toContain("--effort");
    expect(spawnArgsHistory[0][spawnArgsHistory[0].indexOf("--effort") + 1]).toBe("medium");
    await finishTurn(0);

    // An explicit choice is passed through.
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 81, method: "session/set_config_option",
      params: { configId: "reasoning_effort", value: "high" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 82, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "High effort" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgsHistory[1][spawnArgsHistory[1].indexOf("--effort") + 1]).toBe("high");
    await finishTurn(1);

    // A model that carries its own level takes no flag at all.
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 83, method: "session/set_config_option",
      params: { configId: "model", value: "gpt-oss-120b-medium" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 84, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "No reasoning flag here" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnArgsHistory[2]).toContain("gpt-oss-120b-medium");
    expect(spawnArgsHistory[2]).not.toContain("--effort");

    server.dispose();
  });

  it("refuses a second prompt while one is still running", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];
    const responses: any[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 90, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "First" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 91, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Second" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnedProcs).toHaveLength(1);
    expect(responses.filter((m) => m.id === 91)).toHaveLength(1);
    expect(responses.find((m) => m.id === 91)?.error?.message).toMatch(/already running/i);
    expect(responses.find((m) => m.id === 90)).toBeUndefined();

    server.dispose();
  });

  it("correctly identifies implementation plan tools and extracts plan text", () => {
    expect(isImplementationPlanTool("write_to_file", { TargetFile: "C:\\project\\implementation_plan.md" })).toBe(true);
    expect(isImplementationPlanTool("write_to_file", { TargetFile: "/home/user/.gemini/brain/conv1/implementation_plan.md" })).toBe(true);
    expect(isImplementationPlanTool("write_to_file", {
      TargetFile: "/home/user/my_plan.md",
      ArtifactMetadata: { RequestFeedback: true },
    })).toBe(true);
    expect(isImplementationPlanTool("write_to_file", { TargetFile: "src/index.ts" })).toBe(false);
    expect(isImplementationPlanTool("grep_search", { Query: "plan" })).toBe(false);

    expect(extractPlanText({ CodeContent: "# My Plan\nStep 1" })).toBe("# My Plan\nStep 1");
    expect(extractPlanText({ content: "# Content Plan" })).toBe("# Content Plan");
    expect(extractPlanText({ ReplacementContent: "# Replaced Plan" })).toBe("# Replaced Plan");

    const tempFile = path.join(scratchDir, "test_plan.md");
    fs.writeFileSync(tempFile, "# Disk Plan", "utf8");
    expect(extractPlanText({ TargetFile: tempFile })).toBe("# Disk Plan");
    expect(extractPlanText({ TargetFile: "test_plan.md" }, scratchDir)).toBe("# Disk Plan");
  });

  it("handles implementation plan creation in plan mode, emits exit_plan_mode, and transitions to agent on approval", { timeout: 15000 }, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];
    const messages: any[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      defaultModeId: "plan",
      // implementation_plan.md never exists on disk in this test, so
      // waitForDiskChangeText's poll always exhausts its full budget —
      // shrunk here so this (non-timing) test doesn't pay the ~10s production cost.
      diskPollAttempts: 3,
      diskPollDelayMs: 10,
      spawnFn: () => {
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();

    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) messages.push(JSON.parse(line));
      }
    });

    // Start a prompt in plan mode
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 100, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Create an implementation plan" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnedProcs).toHaveLength(1);
    const proc = spawnedProcs[0];

    // Simulate agy output: tool call creating implementation_plan.md
    proc.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "tool",
        tool_name: "write_to_file",
        state: "ACTIVE",
        tool_info: {
          parameters: {
            TargetFile: "implementation_plan.md",
            CodeContent: "# Implementation Plan\n\n1. Do this\n2. Do that",
          },
        },
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    proc.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "tool",
        tool_name: "write_to_file",
        state: "DONE",
        tool_info: {
          parameters: {
            TargetFile: "implementation_plan.md",
            CodeContent: "# Implementation Plan\n\n1. Do this\n2. Do that",
          },
          output: "File written successfully",
        },
      },
    }) + "\n");
    // implementation_plan.md never actually exists on disk in this test, so
    // the DONE-phase disk-change poll runs its full retry budget (~3s) before
    // the plan-emitting side effects (which ride the same .then()) fire.
    // Polled rather than a fixed sleep for the same reason as elsewhere in
    // this file: a loaded full-suite run can push the retry loop's own
    // timers past a fixed buffer.
    for (let i = 0; i < 100 && !messages.some((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "plan"); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // A session/update with sessionUpdate: "plan" must be emitted
    const planUpdate = messages.find((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "plan");
    expect(planUpdate).toBeDefined();
    expect(planUpdate.params.update.plan).toContain("# Implementation Plan");

    // An x.ai/exit_plan_mode request must be emitted to the client
    const exitPlanReq = messages.find((m) => m.method === "x.ai/exit_plan_mode");
    expect(exitPlanReq).toBeDefined();
    expect(exitPlanReq.id).toBeDefined();
    expect(exitPlanReq.params.planContent).toContain("# Implementation Plan");

    // Client responds with approval
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: exitPlanReq.id,
      result: { outcome: "approved" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(server.currentModeId).toBe("agent");
    const modeUpdate = messages.find((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "current_mode_update");
    expect(modeUpdate).toBeDefined();
    expect(modeUpdate.params.update.currentModeId).toBe("agent");

    server.dispose();
  });

  it("handles _x.ai/interject and forwards message to agy stdin", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const spawnedProcs: FakeProcess[] = [];
    const responses: any[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: nextStore(),
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        const proc = new FakeProcess();
        spawnedProcs.push(proc);
        return proc as any;
      },
    });
    server.start();

    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    // Start a prompt so process is spawned
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 200, method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Hello" }] },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(spawnedProcs).toHaveLength(1);
    const proc = spawnedProcs[0];

    let stdinData = "";
    proc.stdin.on("data", (chunk) => {
      stdinData += chunk.toString();
    });

    // Send interject
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 201, method: "_x.ai/interject",
      params: { text: "User steering feedback" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(responses.some((r) => r.id === 201)).toBe(true);
    expect(stdinData).toContain("User steering feedback");

    server.dispose();
  });

  it("cleanPromptTitle parses and cleans titles correctly", () => {
    expect(cleanPromptTitle("<USER_REQUEST>\nFix Antigravity sessions\n</USER_REQUEST>")).toBe("Fix Antigravity sessions");
    expect(cleanPromptTitle("The current local time is: 2026-09-05\n\n<USER_REQUEST>Build modern web app</USER_REQUEST>")).toBe("Build modern web app");
    expect(cleanPromptTitle("")).toBe("Antigravity Session");
    const longPrompt = "A".repeat(100);
    const cleaned = cleanPromptTitle(longPrompt);
    expect(cleaned.length).toBeLessThanOrEqual(80);
    expect(cleaned.endsWith("…")).toBe(true);
  });

  it("session/list returns stored sessions filtered by cwd and sorted by updatedAt", async () => {
    const storePath = nextStore();
    const testCwd = "C:\\projects\\my-app";
    const otherCwd = "C:\\other\\app";

    fs.writeFileSync(storePath, JSON.stringify({
      "sess-1": {
        conversationId: "conv-1",
        cwd: testCwd,
        title: "Earlier Session",
        updatedAt: 1000,
      },
      "sess-2": {
        conversationId: "conv-2",
        cwd: testCwd,
        title: "Recent Session",
        updatedAt: 2000,
      },
      "sess-other": {
        conversationId: "conv-other",
        cwd: otherCwd,
        title: "Other Project Session",
        updatedAt: 3000,
      },
    }), "utf8");

    const input = new PassThrough();
    const output = new PassThrough();
    const responses: any[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: storePath,
      cwd: testCwd,
      inputStream: input,
      outputStream: output,
    });
    server.start();

    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 300,
      method: "session/list",
      params: { cwd: testCwd },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    const listResp = responses.find((m) => m.id === 300);
    expect(listResp).toBeDefined();
    expect(listResp.result?.sessions).toHaveLength(2);
    // Should be sorted by updatedAt desc
    expect(listResp.result.sessions[0].sessionId).toBe("sess-2");
    expect(listResp.result.sessions[0].title).toBe("Recent Session");
    expect(listResp.result.sessions[1].sessionId).toBe("sess-1");
    expect(listResp.result.sessions[1].title).toBe("Earlier Session");

    server.dispose();
  });

  it("session/prompt stores prompt title and updates timestamp", async () => {
    const storePath = nextStore();
    const testCwd = "C:\\projects\\my-app";
    const input = new PassThrough();
    const output = new PassThrough();

    const server = new AgyAcpAdapterServer({
      conversationStorePath: storePath,
      cwd: testCwd,
      inputStream: input,
      outputStream: output,
      spawnFn: () => new FakeProcess() as any,
    });
    server.start();

    // Create session
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 310,
      method: "session/new",
      params: { cwd: testCwd },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    // Send prompt
    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 311,
      method: "session/prompt",
      params: {
        sessionId: server.sessionId,
        prompt: [{ type: "text", text: "<USER_REQUEST>Implement dark mode</USER_REQUEST>" }],
      },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    const storeContent = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const entry = storeContent[server.sessionId!];
    expect(entry).toBeDefined();
    expect(entry.title).toBe("Implement dark mode");
    expect(entry.cwd).toBe(testCwd);
    expect(entry.updatedAt).toBeGreaterThan(0);

    server.dispose();
  });

  it("session/load replays transcript notifications from disk", async () => {
    const storePath = nextStore();
    const customGeminiHome = path.join(scratchDir, "gemini-home-" + Date.now());
    const convId = "conv-replay-test";
    const transcriptDir = path.join(customGeminiHome, "antigravity-cli", "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(transcriptDir, { recursive: true });

    const transcriptLines = [
      JSON.stringify({
        type: "USER_INPUT",
        content: "<USER_REQUEST>Hello from user</USER_REQUEST>",
      }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        content: "Hello! I am Antigravity.",
      }),
    ];
    fs.writeFileSync(path.join(transcriptDir, "transcript.jsonl"), transcriptLines.join("\n"), "utf8");

    fs.writeFileSync(storePath, JSON.stringify({
      "sess-replay": {
        conversationId: convId,
        cwd: "C:\\projects\\app",
        title: "Replay Test",
        updatedAt: Date.now(),
      },
    }), "utf8");

    const input = new PassThrough();
    const output = new PassThrough();
    const messages: any[] = [];

    const server = new AgyAcpAdapterServer({
      conversationStorePath: storePath,
      geminiHome: customGeminiHome,
      inputStream: input,
      outputStream: output,
    });
    server.start();

    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line) messages.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 320,
      method: "session/load",
      params: { sessionId: "sess-replay" },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 30));

    const loadResp = messages.find((m) => m.id === 320);
    expect(loadResp).toBeDefined();
    expect(loadResp.result?.sessionId).toBe("sess-replay");

    const updates = messages.filter((m) => m.method === "session/update");
    const userChunk = updates.find((m) => m.params?.update?.sessionUpdate === "user_message_chunk");
    const agentChunk = updates.find((m) => m.params?.update?.sessionUpdate === "agent_message_chunk");

    expect(userChunk).toBeDefined();
    expect(userChunk.params.update.content.text).toBe("Hello from user");

    expect(agentChunk).toBeDefined();
    expect(agentChunk.params.update.content.text).toBe("Hello! I am Antigravity.");

    server.dispose();
  });

  it("stages base64 image data and injects view_file instructions for Antigravity", () => {
    const testGeminiHome = path.join(scratchDir, "gemini-home-img");
    const server = new AgyAcpAdapterServer({
      geminiHome: testGeminiHome,
      conversationStorePath: nextStore(),
    });

    const tinyBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const result = server.processPromptBlocks([
      { type: "text", text: "Look at this screenshot [Image #1] (image-abc.png — local staged copy; thumbnail only; do not access this path)" },
      { type: "image", mimeType: "image/png", data: tinyBase64 },
    ]);

    expect(result).toContain("Look at this screenshot [Image #1]");
    expect(result).not.toContain("thumbnail only; do not access this path");
    expect(result).toContain("[Attached Image #1: Local file located at");
    expect(result).toContain("Please use the view_file tool on this path to inspect the image content.");

    // Verify file actually exists on disk
    const match = result.match(/Local file located at "([^"]+)"/);
    expect(match).not.toBeNull();
    const filePath = match![1];
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath).length).toBeGreaterThan(0);

    server.dispose();
  });

  it("reuses existing knownPath without re-writing if file already exists on disk", () => {
    const testGeminiHome = path.join(scratchDir, "gemini-home-img-reuse");
    const server = new AgyAcpAdapterServer({
      geminiHome: testGeminiHome,
      conversationStorePath: nextStore(),
    });

    const existingFile = path.join(scratchDir, "test-existing.png");
    fs.writeFileSync(existingFile, "png-binary-data");

    const result = server.processPromptBlocks([
      { type: "text", text: "Analyze this image" },
      { type: "image", mimeType: "image/png", data: "", path: existingFile },
    ]);

    expect(result).toContain(`Local file located at "${existingFile}"`);
    expect(result).toContain("Please use the view_file tool on this path");

    server.dispose();
  });

  describe("normalizeBaselineKey", () => {
    it("normalizes path casing and separators consistently", () => {
      const p1 = normalizeBaselineKey("C:/project/sub/file.ts", "C:/project");
      const p2 = normalizeBaselineKey("c:\\project\\sub\\file.ts", "C:\\project");
      if (process.platform === "win32") {
        expect(p1).toBe(p2);
        expect(p1).toBe("c:\\project\\sub\\file.ts");
      } else {
        expect(normalizeBaselineKey("sub/file.ts", "/project")).toBe("/project/sub/file.ts");
      }
    });
  });

  describe("findTranscriptPath", () => {
    it("prefers transcript_full.jsonl over transcript.jsonl", () => {
      const testGeminiHome = path.join(scratchDir, "gemini-home-tf-" + Date.now());
      const convId = "conv-tf-pref";
      const logsDir = path.join(testGeminiHome, "antigravity-cli", "brain", convId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      const fullPath = path.join(logsDir, "transcript_full.jsonl");
      const compactPath = path.join(logsDir, "transcript.jsonl");
      fs.writeFileSync(fullPath, "{}\n", "utf8");
      fs.writeFileSync(compactPath, "{}\n", "utf8");

      const found = findTranscriptPath(convId, testGeminiHome);
      expect(found).toBe(fullPath);
    });

    it("finds transcript in antigravity/brain directory", () => {
      const testGeminiHome = path.join(scratchDir, "gemini-home-agy-" + Date.now());
      const convId = "conv-agy-dir";
      const logsDir = path.join(testGeminiHome, "antigravity", "brain", convId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      const fullPath = path.join(logsDir, "transcript_full.jsonl");
      fs.writeFileSync(fullPath, "{}\n", "utf8");

      const found = findTranscriptPath(convId, testGeminiHome);
      expect(found).toBe(fullPath);
    });

    it("falls back to transcript.jsonl when transcript_full.jsonl is not present", () => {
      const testGeminiHome = path.join(scratchDir, "gemini-home-compact-" + Date.now());
      const convId = "conv-compact-only";
      const logsDir = path.join(testGeminiHome, "brain", convId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      const compactPath = path.join(logsDir, "transcript.jsonl");
      fs.writeFileSync(compactPath, "{}\n", "utf8");

      const found = findTranscriptPath(convId, testGeminiHome);
      expect(found).toBe(compactPath);
    });
  });

  describe("unwrapTranscriptStrings & synthesizeAgyToolDiff robustness", () => {
    it("handles inner unescaped quotes gracefully in unwrapTranscriptStrings", () => {
      // Simulating corrupted transcript.jsonl line: inner quotes broke JSON.parse
      const raw = {
        TargetContent: '"Phase 3 ,Doku + VSIX" ist kein Feature-Schnitt."',
      };
      const unwrapped = unwrapTranscriptStrings(raw);
      expect(unwrapped.TargetContent).toBe('Phase 3 ,Doku + VSIX" ist kein Feature-Schnitt.');
    });

    it("parses numeric strings for StartLine in synthesizeAgyToolDiff", () => {
      const diff = synthesizeAgyToolDiff("replace_file_content", {
        TargetFile: "test.ts",
        TargetContent: "old",
        ReplacementContent: "new",
        StartLine: "188",
      });
      expect(diff).toBeDefined();
      expect(diff?._meta?.old_line).toBe(188);
      expect(diff?._meta?.new_line).toBe(188);
    });
  });

  describe("session reload baseline seeding & live transcript diff synthesis", () => {
    it("seeds sessionFileBaseline on transcript replay so the next edit does not produce +0 -0", async () => {
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-reload-"));
      const testFile = path.join(projectDir, "sample.ts");
      fs.writeFileSync(testFile, "const version = 1;\n", "utf8");

      const testGeminiHome = path.join(scratchDir, "gemini-home-seed-" + Date.now());
      const convId = "conv-seed-test";
      const logsDir = path.join(testGeminiHome, "antigravity-cli", "brain", convId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      // Transcript records that sample.ts was edited in turn 1
      const transcriptLines = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          content: "<USER_REQUEST>Edit sample.ts to version 2</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          tool_calls: [{
            name: "replace_file_content",
            args: {
              TargetFile: testFile,
              TargetContent: "const version = 1;\n",
              ReplacementContent: "const version = 2;\n",
              StartLine: 1,
            },
          }],
        }),
      ];
      fs.writeFileSync(path.join(logsDir, "transcript_full.jsonl"), transcriptLines.join("\n"), "utf8");

      // Disk is now at version 2 (from turn 1)
      fs.writeFileSync(testFile, "const version = 2;\n", "utf8");

      const storePath = nextStore();
      fs.writeFileSync(storePath, JSON.stringify({
        "sess-seed": {
          conversationId: convId,
          cwd: projectDir,
          title: "Seed Test",
          updatedAt: Date.now(),
        },
      }), "utf8");

      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;

      const server = new AgyAcpAdapterServer({
        conversationStorePath: storePath,
        geminiHome: testGeminiHome,
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      // Reload the session
      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 400, method: "session/load",
        params: { sessionId: "sess-seed" },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 30));

      // Now send turn 2: edit sample.ts to version 3
      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 401, method: "session/prompt",
        params: { sessionId: "sess-seed", prompt: [{ type: "text", text: "Edit sample.ts to version 3" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      // File write lands instantly on disk before ACTIVE is processed!
      fs.writeFileSync(testFile, "const version = 3;\n", "utf8");

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: testFile } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 3, state: "DONE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: testFile }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      // Verify the emitted tool_call_update: it must show oldText = version 2, newText = version 3!
      // (NOT degenerate +0 -0 where oldText === newText === version 3!)
      const toolUpdates = messages.filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "tool_call_update");
      const lastToolUpdate = toolUpdates[toolUpdates.length - 1];
      expect(lastToolUpdate).toBeDefined();

      const diff = lastToolUpdate.params.update.content?.find((c: any) => c.type === "diff");
      expect(diff).toBeDefined();
      expect(diff.oldText).toContain("version = 2");
      expect(diff.newText).toContain("version = 3");
      expect(diff.oldText).not.toBe(diff.newText);

      server.dispose();
    });

    it("synthesizes live diff from transcript_full.jsonl when wire parameters only contain TargetFile", async () => {
      const projectDir = fs.mkdtempSync(path.join(scratchDir, "proj-live-tf-"));
      const testFile = path.join(projectDir, "code.ts");
      fs.writeFileSync(testFile, "function hello() { return 'world'; }\n", "utf8");

      const testGeminiHome = path.join(scratchDir, "gemini-home-live-" + Date.now());
      const convId = "conv-live-tf-test";
      const logsDir = path.join(testGeminiHome, "antigravity-cli", "brain", convId, ".system_generated", "logs");
      fs.mkdirSync(logsDir, { recursive: true });

      const input = new PassThrough();
      const output = new PassThrough();
      let fakeProc: FakeProcess | undefined;

      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        geminiHome: testGeminiHome,
        cwd: projectDir,
        inputStream: input,
        outputStream: output,
        spawnFn: () => {
          fakeProc = new FakeProcess();
          return fakeProc as any;
        },
      });
      server.start();

      const messages: any[] = [];
      output.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          if (line.trim()) messages.push(JSON.parse(line));
        }
      });

      // Start new session
      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 500, method: "session/new", params: { cwd: projectDir },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      input.write(JSON.stringify({
        jsonrpc: "2.0", id: 501, method: "session/prompt",
        params: { sessionId: server.sessionId, prompt: [{ type: "text", text: "Change world to universe" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 20));

      // CLI emits init event setting conversation ID
      fakeProc!.stdout.write(JSON.stringify({
        event: "init",
        conversation_id: convId,
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      // ACTIVE step arrives with only TargetFile on the wire
      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: testFile } },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      // Antigravity writes the change to disk AND logs it to transcript_full.jsonl
      fs.writeFileSync(testFile, "function hello() { return 'universe'; }\n", "utf8");
      const transcriptEntry = JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{
          name: "replace_file_content",
          args: {
            TargetFile: testFile,
            TargetContent: "return 'world';",
            ReplacementContent: "return 'universe';",
            StartLine: 1,
          },
        }],
      });
      fs.writeFileSync(path.join(logsDir, "transcript_full.jsonl"), transcriptEntry + "\n", "utf8");

      // DONE step arrives over stdout with only TargetFile
      fakeProc!.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1, state: "DONE", step_type: "tool", tool_name: "replace_file_content",
          tool_info: { name: "replace_file_content", parameters: { TargetFile: testFile }, output: "ok" },
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 30));

      const toolUpdates = messages.filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "tool_call_update");
      const doneUpdate = toolUpdates[toolUpdates.length - 1];
      expect(doneUpdate).toBeDefined();

      const diff = doneUpdate.params.update.content?.find((c: any) => c.type === "diff");
      expect(diff).toBeDefined();
      // Should have extracted the exact targeted region and line numbers from transcript_full.jsonl!
      expect(diff.oldText).toBe("return 'world';");
      expect(diff.newText).toBe("return 'universe';");
      expect(diff._meta?.old_line).toBe(1);
      expect(diff._meta?.new_line).toBe(1);

      server.dispose();
    });
  });

  describe("headless stream-json permission arguments", () => {
    it("passes --dangerously-skip-permissions in agent mode to prevent stream-json permission deadlocks", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let capturedArgs: string[] = [];

      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        inputStream: input,
        outputStream: output,
        spawnFn: (_cmd, args) => {
          capturedArgs = args;
          return new FakeProcess() as any;
        },
      });
      server.start();

      input.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        method: "session/prompt",
        params: { sessionId: "perm-test-agent", prompt: [{ type: "text", text: "Run git status" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedArgs).toContain("--dangerously-skip-permissions");
      expect(capturedArgs).not.toContain("--mode");

      server.dispose();
    });

    it("passes both --mode plan and --dangerously-skip-permissions in plan mode", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let capturedArgs: string[] = [];

      const server = new AgyAcpAdapterServer({
        conversationStorePath: nextStore(),
        inputStream: input,
        outputStream: output,
        defaultModeId: "plan",
        spawnFn: (_cmd, args) => {
          capturedArgs = args;
          return new FakeProcess() as any;
        },
      });
      server.start();

      input.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "session/prompt",
        params: { sessionId: "perm-test-plan", prompt: [{ type: "text", text: "Plan the changes" }] },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedArgs).toContain("--dangerously-skip-permissions");
      const modeIdx = capturedArgs.indexOf("--mode");
      expect(modeIdx).toBeGreaterThanOrEqual(0);
      expect(capturedArgs[modeIdx + 1]).toBe("plan");

      server.dispose();
    });
  });
});
