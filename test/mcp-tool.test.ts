import { describe, expect, it, vi } from "vitest";
import { MAX_COMMAND_OUTPUT_CHARS } from "../src/acp-dispatch";
import {
  EMPTY_MCP_ARGS,
  MCP_MACHINERY_KIND,
  createMcpPrepareState,
  extractMcpInput,
  extractMcpOutput,
  formatMcpArgs,
  isMcpMachineryRow,
  isMcpToolCall,
  mcpCommandOutput,
  prepareMcpToolCall,
} from "../src/mcp-tool";

const ARGS = { message: "MCPSHAPE_9931" };
const IN = JSON.stringify(ARGS, null, 2);
const OUT = "Echo: MCPSHAPE_9931";
const gmailStructured = {
  query: "after:2026/08/18",
  messages: [
    { id: "m1", subject: "STRUCTPAYLOAD_ONE", from: "a@example.com" },
    { id: "m2", subject: "STRUCTPAYLOAD_TWO", from: "b@example.com" },
  ],
  total: 2,
};

const grokSearch = {
  sessionUpdate: "tool_call",
  toolCallId: "call-search-0",
  title: "search_tool",
  rawInput: { query: "everything echo", limit: 5 },
  _meta: { "x.ai/tool": { name: "search_tool", kind: "search_tool" } },
};

const grokSearchUpdate = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-search-0",
  kind: "other",
  title: "Search tools: \"everything echo\"",
  rawInput: { variant: "SearchTool", query: "everything echo", limit: 5 },
  _meta: { "x.ai/tool": { name: "search_tool", kind: "search_tool" } },
};

const grokSearchDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-search-0",
  status: "completed",
  rawOutput: { type: "SearchTool", result_count: 5, content: "{}" },
};

const grokUse = {
  sessionUpdate: "tool_call",
  toolCallId: "call-use-1",
  title: "use_tool",
  rawInput: { tool_name: "everything__echo", tool_input: ARGS },
  _meta: { "x.ai/tool": { name: "use_tool", kind: "use_tool" } },
};

const grokUseUpdate = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-use-1",
  kind: "other",
  title: "everything__echo",
  rawInput: { variant: "UseTool", tool_name: "everything__echo", tool_input: ARGS },
  _meta: { "x.ai/tool": { name: "use_tool", kind: "use_tool" } },
};

const grokUseDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-use-1",
  status: "completed",
  rawOutput: {
    type: "MCP",
    tool_name: "echo",
    server_name: "everything",
    output: { OkayOutput: OUT },
  },
};

const codexStartup = {
  sessionUpdate: "tool_call",
  toolCallId: "mcp_startup.everything",
  kind: "other",
  title: "mcp__everything__startup",
  status: "failed",
  content: [{
    type: "content",
    content: {
      type: "text",
      text: "[codex-acp forwarded startup error] MCP server `everything` startup was cancelled.",
    },
  }],
};

const codexStartupBroken = {
  sessionUpdate: "tool_call",
  toolCallId: "mcp_startup.canva",
  kind: "other",
  title: "mcp__canva__startup",
  status: "failed",
  content: [{
    type: "content",
    content: {
      type: "text",
      text: "MCP server `canva` failed to start: connect ECONNREFUSED 127.0.0.1:3001",
    },
  }],
};

const codexCall = {
  sessionUpdate: "tool_call",
  toolCallId: "exec-mcp-1",
  kind: "execute",
  title: "mcp.everything.echo",
  status: "in_progress",
  rawInput: { server: "everything", tool: "echo", arguments: ARGS },
  _meta: { is_mcp_tool_call: true },
};

const codexDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "exec-mcp-1",
  status: "completed",
  rawInput: { server: "everything", tool: "echo", arguments: ARGS },
  rawOutput: {
    result: {
      content: [{ type: "text", text: OUT }],
      structuredContent: null,
      _meta: null,
    },
    error: null,
  },
};

const claudePending = {
  sessionUpdate: "tool_call",
  toolCallId: "toolu_mcp_1",
  rawInput: {},
  status: "pending",
  title: "mcp__everything__echo",
  kind: "other",
  _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
};

const claudeArgs = {
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_mcp_1",
  rawInput: ARGS,
  title: "mcp__everything__echo",
  kind: "other",
  _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
};

const claudeDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_mcp_1",
  status: "completed",
  rawOutput: [{ type: "text", text: OUT }],
  content: [{ type: "content", content: { type: "text", text: OUT } }],
  _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
};

const shell = {
  sessionUpdate: "tool_call",
  toolCallId: "cmd-1",
  kind: "execute",
  title: "Run echo hi",
  rawInput: { command: "echo hi" },
};

describe("formatMcpArgs", () => {
  it("pretty-prints objects, including empty, and rejects non-objects", () => {
    expect(formatMcpArgs(ARGS)).toBe(IN);
    expect(formatMcpArgs({})).toBe(EMPTY_MCP_ARGS);
    expect(formatMcpArgs(null)).toBeNull();
    expect(formatMcpArgs("x")).toBeNull();
    expect(formatMcpArgs(["x"])).toBeNull();
  });
});

describe("MCP machinery rows", () => {
  it("classifies grok search_tool on the initial call, the titled update, and the SearchTool result", () => {
    expect(isMcpMachineryRow(grokSearch)).toBe(true);
    expect(isMcpMachineryRow(grokSearchUpdate)).toBe(true);
    expect(isMcpMachineryRow(grokSearchDone)).toBe(true);
    expect(isMcpToolCall(grokSearch)).toBe(false);
  });

  it("classifies every Codex mcp__<server>__startup row, not only the cancelled one", () => {
    expect(isMcpMachineryRow(codexStartup)).toBe(true);
    expect(isMcpToolCall(codexStartup)).toBe(false);
    expect(isMcpMachineryRow(codexStartupBroken)).toBe(true);
    expect(isMcpToolCall(codexStartupBroken)).toBe(false);
  });

  it("does not treat a successful MCP call or a shell command as machinery", () => {
    expect(isMcpMachineryRow(grokUse)).toBe(false);
    expect(isMcpMachineryRow(codexCall)).toBe(false);
    expect(isMcpMachineryRow(claudePending)).toBe(false);
    expect(isMcpMachineryRow(shell)).toBe(false);
  });
});

describe("grok use_tool IN/OUT", () => {
  it("reads tool_input and OkayOutput, not content", () => {
    expect(isMcpToolCall(grokUse)).toBe(true);
    expect(extractMcpInput(grokUse)).toBe(IN);
    expect(extractMcpInput(grokUseUpdate)).toBe(IN);
    expect(extractMcpOutput(grokUse)).toBeNull();
    expect(extractMcpOutput(grokUseDone)).toEqual({ output: OUT, truncated: false });
    expect(extractMcpOutput({
      ...grokUseDone,
      rawOutput: { type: "MCP", output: { ErrorOutput: "nope" } },
    })).toBeNull();
    expect(extractMcpOutput({
      ...grokUseDone,
      rawOutput: { type: "MCP", output: { OkayOutput: OUT, ExtraVariant: "also-here" } },
    })).toEqual({ output: `${OUT}\nalso-here`, truncated: false });
  });
});

describe("codex MCP IN/OUT", () => {
  it("reads arguments and result.content[].text when structuredContent is null", () => {
    expect(isMcpToolCall(codexCall)).toBe(true);
    expect(extractMcpInput(codexCall)).toBe(IN);
    expect(extractMcpOutput(codexCall)).toBeNull();
    expect(extractMcpOutput(codexDone)).toEqual({ output: OUT, truncated: false });
    expect(extractMcpOutput({
      ...codexDone,
      rawOutput: { result: { content: [{ type: "image", data: "x" }] }, error: null },
    })).toEqual({
      output: JSON.stringify({ type: "image", data: "x" }, null, 2),
      truncated: false,
    });
  });
});

describe("claude MCP pending-then-filled", () => {
  it("treats empty rawInput as pending and fills IN from the later flat args", () => {
    expect(isMcpToolCall(claudePending)).toBe(true);
    expect(extractMcpInput(claudePending)).toBeNull();
    expect(extractMcpInput(claudeArgs)).toBe(IN);
    expect(extractMcpOutput(claudeArgs)).toBeNull();
    expect(extractMcpOutput(claudeDone)).toEqual({ output: OUT, truncated: false });
  });

  it("does not treat Claude ToolSearch as an MCP invocation", () => {
    const search = {
      title: "ToolSearch",
      rawInput: { query: "select:mcp__everything__echo" },
      _meta: { claudeCode: { toolName: "ToolSearch" } },
    };
    expect(isMcpToolCall(search)).toBe(false);
    expect(isMcpMachineryRow(search)).toBe(false);
    expect(extractMcpInput(search)).toBeNull();
  });
});

describe("shell rows stay untouched", () => {
  it("does not classify or extract a command row as MCP", () => {
    expect(isMcpToolCall(shell)).toBe(false);
    expect(extractMcpInput(shell)).toBeNull();
    expect(extractMcpOutput({
      ...shell,
      rawOutput: { type: "Bash", output: "hi\n", exit_code: 0 },
    })).toBeNull();
  });
});

describe("complete MCP result OUT", () => {
  it("shows Codex text content and structuredContent together", () => {
    const extracted = extractMcpOutput({
      ...codexDone,
      rawOutput: {
        result: {
          content: [{ type: "text", text: "Action completed." }],
          structuredContent: gmailStructured,
          _meta: null,
        },
        error: null,
      },
    });
    expect(extracted).toEqual({
      output: `Action completed.\n${JSON.stringify(gmailStructured, null, 2)}`,
      truncated: false,
    });
    expect(extracted?.output).toContain("STRUCTPAYLOAD_ONE");
    expect(extracted?.output).toContain("STRUCTPAYLOAD_TWO");
  });

  it("shows a non-null Codex error instead of dropping OUT", () => {
    const error = { code: -32000, message: "MCP error -32000: search failed" };
    expect(extractMcpOutput({
      ...codexDone,
      rawOutput: { result: null, error },
    })).toEqual({
      output: JSON.stringify(error, null, 2),
      truncated: false,
    });
    expect(extractMcpOutput({
      ...codexDone,
      rawOutput: { result: { content: [{ type: "text", text: OUT }] }, error: "boom" },
    })?.output).toContain("boom");
  });

  it("renders every Claude content block, including a non-text trace", () => {
    const image = { type: "image", mimeType: "image/png", data: "xxxx" };
    const resource = { type: "resource", resource: { uri: "file://messages/1" } };
    expect(extractMcpOutput({
      ...claudeDone,
      rawOutput: [
        { type: "text", text: "first block" },
        image,
        resource,
        { type: "text", text: "last block" },
      ],
    })).toEqual({
      output: [
        "first block",
        JSON.stringify(image, null, 2),
        JSON.stringify(resource, null, 2),
        "last block",
      ].join("\n"),
      truncated: false,
    });
  });

  it("shows Claude string rawOutput verbatim when it is JSON", () => {
    const compact = JSON.stringify(gmailStructured);
    const extracted = extractMcpOutput({
      ...claudeDone,
      rawOutput: compact,
      content: [{ type: "content", content: { type: "text", text: compact } }],
    });
    expect(extracted).toEqual({ output: compact, truncated: false });
    expect(extracted?.output).toContain("STRUCTPAYLOAD_ONE");
    expect(extracted?.output).toContain("STRUCTPAYLOAD_TWO");
  });

  it("does not reparse Claude string rawOutput so 64-bit integers stay exact", () => {
    const raw = '{"id":9223372036854775807,"n":9007199254740993}';
    const extracted = extractMcpOutput({
      ...claudeDone,
      rawOutput: raw,
    });
    expect(extracted).toEqual({ output: raw, truncated: false });
    expect(extracted?.output).toContain("9223372036854775807");
    expect(extracted?.output).toContain("9007199254740993");
    expect(extracted?.output).not.toContain("9223372036854776000");
    expect(extracted?.output).not.toContain("9007199254740992");
  });

  it("shows Claude string rawOutput verbatim when it is not JSON", () => {
    const text = "Action completed. not-json {broken";
    expect(extractMcpOutput({
      ...claudeDone,
      rawOutput: text,
    })).toEqual({ output: text, truncated: false });
  });

  it("does not read Claude _meta.claudeCode.toolResponse as OUT", () => {
    expect(extractMcpOutput({
      ...claudeArgs,
      _meta: {
        claudeCode: {
          toolName: "mcp__everything__echo",
          toolResponse: JSON.stringify(gmailStructured),
        },
      },
    })).toBeNull();
    expect(extractMcpOutput({
      ...claudeDone,
      rawOutput: undefined,
      _meta: {
        claudeCode: {
          toolName: "mcp__everything__echo",
          toolResponse: [{ type: "text", text: OUT }],
        },
      },
    })).toBeNull();
  });

  it("applies the 100K display cap to a large structured payload", () => {
    const huge = { blob: "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 50) };
    const capped = extractMcpOutput({
      ...codexDone,
      rawOutput: {
        result: {
          content: [{ type: "text", text: "Action completed." }],
          structuredContent: huge,
          _meta: null,
        },
        error: null,
      },
    });
    expect(capped?.output).toHaveLength(MAX_COMMAND_OUTPUT_CHARS);
    expect(capped?.truncated).toBe(true);
    expect(capped?.output.startsWith("Action completed.")).toBe(true);
    expect(mcpCommandOutput({
      ...codexDone,
      rawOutput: {
        result: {
          content: [{ type: "text", text: "ok" }],
          structuredContent: huge,
          _meta: null,
        },
        error: null,
      },
    }, IN, "exec-mcp-1")).toMatchObject({
      truncated: true,
      agentSawCut: false,
    });
    const stringCapped = extractMcpOutput({
      ...claudeDone,
      rawOutput: JSON.stringify(huge),
    });
    expect(stringCapped?.output).toHaveLength(MAX_COMMAND_OUTPUT_CHARS);
    expect(stringCapped?.truncated).toBe(true);
    expect(mcpCommandOutput({
      ...claudeDone,
      rawOutput: JSON.stringify(huge),
    }, IN, "toolu_mcp_1")).toMatchObject({
      truncated: true,
      agentSawCut: false,
    });
  });
});

describe("100K display cap", () => {
  it("does not expand a nested MCP payload past the display cap in memory", () => {
    // Compact form of this spine is a few KB; indent-2 is ~1MB. The bug is
    // the intermediate allocation, not the final capped string.
    const depth = 700;
    let eager: unknown = 1;
    for (let i = 0; i < depth; i++) eager = { a: eager };
    expect(JSON.stringify(eager, null, 2).length).toBeGreaterThan(MAX_COMMAND_OUTPUT_CHARS);

    let walks = 0;
    function nest(n: number): object {
      return {
        get a() {
          walks += 1;
          return n <= 1 ? 1 : nest(n - 1);
        },
      };
    }
    const nested = nest(depth);

    const orig = JSON.stringify;
    let longest = 0;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((
      value: unknown,
      replacer?: unknown,
      space?: unknown,
    ) => {
      const result = orig(value as never, replacer as never, space as never);
      if (typeof result === "string" && result.length > longest) longest = result.length;
      return result;
    }) as typeof JSON.stringify);

    let extracted: ReturnType<typeof extractMcpOutput>;
    try {
      extracted = extractMcpOutput({
        ...codexDone,
        rawOutput: {
          result: { content: [], structuredContent: nested, _meta: null },
          error: null,
        },
      });
    } finally {
      spy.mockRestore();
    }

    expect(longest).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_CHARS);
    expect(walks).toBeLessThan(depth);
    expect(extracted?.output.length).toBeLessThanOrEqual(MAX_COMMAND_OUTPUT_CHARS);
    expect(extracted?.output).toContain("\"a\"");
    expect(extracted?.truncated).toBe(true);
    expect(mcpCommandOutput({
      ...codexDone,
      rawOutput: {
        result: { content: [], structuredContent: eager, _meta: null },
        error: null,
      },
    }, IN, "exec-mcp-1")).toMatchObject({
      truncated: true,
      agentSawCut: false,
    });
  });

  it("caps MCP OUT the same way as shell commandOutput", () => {
    const huge = "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25);
    const capped = extractMcpOutput({
      ...grokUseDone,
      rawOutput: { type: "MCP", output: { OkayOutput: huge } },
    });
    expect(capped?.output).toHaveLength(MAX_COMMAND_OUTPUT_CHARS);
    expect(capped?.truncated).toBe(true);
    expect(mcpCommandOutput({
      ...claudeDone,
      rawOutput: [{ type: "text", text: huge }],
    }, IN, "toolu_mcp_1")).toEqual({
      command: IN,
      toolCallId: "toolu_mcp_1",
      output: huge.slice(0, MAX_COMMAND_OUTPUT_CHARS),
      exitCode: null,
      truncated: true,
      agentSawCut: false,
      cancelled: false,
    });
    expect(mcpCommandOutput(claudeDone, IN, "")).toBeNull();
  });
});

describe("prepareMcpToolCall", () => {
  it("folds grok search_tool as kind:search for the whole id, including a later update without the name", () => {
    const state = createMcpPrepareState();
    const first = prepareMcpToolCall(grokSearch, state);
    expect(first.action).toBe("emit");
    if (first.action !== "emit") return;
    expect(first.call).toMatchObject({
      toolCallId: "call-search-0",
      title: "search_tool",
      kind: MCP_MACHINERY_KIND,
    });
    expect(first.call).not.toHaveProperty("detailInput");
    expect(first.commandOutput).toBeNull();
    const nameless = { sessionUpdate: "tool_call_update", toolCallId: "call-search-0", status: "completed" };
    for (const update of [grokSearchUpdate, nameless, grokSearchDone]) {
      expect(prepareMcpToolCall(update, state)).toMatchObject({
        action: "emit", call: { kind: MCP_MACHINERY_KIND }, commandOutput: null,
      });
    }
  });

  it.each(["pending", "in_progress", "completed"])("drops a Codex startup tool_call with status %s", (status) => {
    expect(prepareMcpToolCall({ ...codexStartup, status, content: [] }, createMcpPrepareState()))
      .toEqual({ action: "drop" });
  });

  it("drops a cancelled Codex startup and still emits the real call", () => {
    const state = createMcpPrepareState();
    const startup = prepareMcpToolCall(codexStartup, state);
    expect(startup).toEqual({
      action: "drop",
      logLine: `[mcp] everything startup failed: ${codexStartup.content[0].content.text}`,
    });
    const first = prepareMcpToolCall(codexCall, state);
    expect(first.action).toBe("emit");
    if (first.action !== "emit") return;
    expect(first.call.detailInput).toBe(IN);
    expect(first.commandOutput).toBeNull();
    const done = prepareMcpToolCall(codexDone, state);
    expect(done.action).toBe("emit");
    if (done.action !== "emit") return;
    expect(done.commandOutput).toEqual({
      command: IN,
      toolCallId: "exec-mcp-1",
      output: OUT,
      exitCode: null,
      truncated: false,
      agentSawCut: false,
      cancelled: false,
    });
  });

  it.each([undefined, "Connecting to Canva"])("drops later updates with title %s and remembers the server for the host log", (title) => {
    const state = createMcpPrepareState();
    expect(prepareMcpToolCall({
      ...codexStartupBroken, toolCallId: "startup-1", status: "in_progress", content: [],
    }, state)).toEqual({ action: "drop" });
    for (const status of ["in_progress", "completed"]) {
      expect(prepareMcpToolCall({
        sessionUpdate: "tool_call_update", toolCallId: "startup-1", title, status,
      }, state)).toEqual({ action: "drop" });
    }
    expect(prepareMcpToolCall({
      sessionUpdate: "tool_call_update", toolCallId: "startup-1", title, status: "failed",
      content: codexStartupBroken.content,
    }, state)).toEqual({
      action: "drop",
      logLine: `[mcp] canva startup failed: ${codexStartupBroken.content[0].content.text}`,
    });
  });

  it("drops a genuine Codex MCP startup failure and returns its diagnostic for the host log", () => {
    const state = createMcpPrepareState();
    const prepared = prepareMcpToolCall(codexStartupBroken, state);
    expect(prepared).toEqual({
      action: "drop",
      logLine: `[mcp] canva startup failed: ${codexStartupBroken.content[0].content.text}`,
    });
  });

  it("keeps forwarded failure text on one host-log line", () => {
    expect(prepareMcpToolCall({
      ...codexStartupBroken,
      content: [
        { type: "content", content: { type: "text", text: "Failed to connect.\r\nECONNREFUSED" } },
        { type: "content", content: { type: "text", text: "Retry cancelled." } },
      ],
    }, createMcpPrepareState())).toEqual({
      action: "drop", logLine: "[mcp] canva startup failed: Failed to connect. ECONNREFUSED Retry cancelled.",
    });
  });

  it("still emits an mcp__server__tool invocation and respects explicit invocation metadata", () => {
    for (const call of [
      { toolCallId: "real-1", title: "mcp__canva__list_designs", rawInput: {} },
      { ...claudePending, title: "mcp__everything__startup", _meta: { claudeCode: { toolName: "mcp__everything__startup" } } },
      { ...grokUse, title: "mcp__everything__startup" },
    ]) {
      expect(prepareMcpToolCall(call, createMcpPrepareState())).toMatchObject({
        action: "emit", call: { title: call.title },
      });
    }
  });

  it("emits Claude string rawOutput once from the completed update, not from toolResponse", () => {
    const state = createMcpPrepareState();
    expect(prepareMcpToolCall(claudePending, state)).toMatchObject({ action: "emit", commandOutput: null });
    expect(prepareMcpToolCall(claudeArgs, state)).toMatchObject({ action: "emit", commandOutput: null });
    const preview = prepareMcpToolCall({
      ...claudeArgs,
      _meta: {
        claudeCode: {
          toolName: "mcp__everything__echo",
          toolResponse: JSON.stringify(gmailStructured),
        },
      },
    }, state);
    expect(preview.action).toBe("emit");
    if (preview.action !== "emit") return;
    expect(preview.commandOutput).toBeNull();
    const compact = JSON.stringify(gmailStructured);
    const done = prepareMcpToolCall({
      ...claudeDone,
      rawOutput: compact,
      content: [{ type: "content", content: { type: "text", text: compact } }],
    }, state);
    expect(done.action).toBe("emit");
    if (done.action !== "emit") return;
    expect(done.call.detailInput).toBe(IN);
    expect(done.commandOutput).toEqual({
      command: IN,
      toolCallId: "toolu_mcp_1",
      output: compact,
      exitCode: null,
      truncated: false,
      agentSawCut: false,
      cancelled: false,
    });
    const again = prepareMcpToolCall({
      ...claudeDone,
      rawOutput: compact,
    }, state);
    expect(again.action).toBe("emit");
    if (again.action !== "emit") return;
    expect(again.commandOutput).toBeNull();
  });

  it("states detailInput: null on Claude's pending row, then fills IN and OUT", () => {
    const state = createMcpPrepareState();
    const pending = prepareMcpToolCall(claudePending, state);
    expect(pending).toEqual({
      action: "emit",
      call: { ...claudePending, detailInput: null },
      commandOutput: null,
    });
    const args = prepareMcpToolCall(claudeArgs, state);
    expect(args.action).toBe("emit");
    if (args.action !== "emit") return;
    expect(args.call.detailInput).toBe(IN);
    expect(args.commandOutput).toBeNull();
    const done = prepareMcpToolCall(claudeDone, state);
    expect(done.action).toBe("emit");
    if (done.action !== "emit") return;
    expect(done.call.detailInput).toBe(IN);
    expect(done.commandOutput).toEqual({
      command: IN,
      toolCallId: "toolu_mcp_1",
      output: OUT,
      exitCode: null,
      truncated: false,
      agentSawCut: false,
      cancelled: false,
    });
  });

  it("emits grok use_tool IN immediately and OUT once, even if the completed row is seen twice", () => {
    const state = createMcpPrepareState();
    const first = prepareMcpToolCall(grokUse, state);
    expect(first.action).toBe("emit");
    if (first.action !== "emit") return;
    expect(first.call.detailInput).toBe(IN);
    expect(first.call.title).toBe("use_tool");
    expect(first.commandOutput).toBeNull();
    expect(prepareMcpToolCall(grokUseUpdate, state).action).toBe("emit");
    const done = prepareMcpToolCall(grokUseDone, state);
    expect(done.action).toBe("emit");
    if (done.action !== "emit") return;
    expect(done.commandOutput?.output).toBe(OUT);
    const again = prepareMcpToolCall(grokUseDone, state);
    expect(again.action).toBe("emit");
    if (again.action !== "emit") return;
    expect(again.commandOutput).toBeNull();
  });

  it("passes a shell command through with no detailInput and no MCP output", () => {
    const state = createMcpPrepareState();
    expect(prepareMcpToolCall(shell, state)).toEqual({
      action: "emit",
      call: shell,
      commandOutput: null,
    });
    expect(Object.prototype.hasOwnProperty.call(
      (prepareMcpToolCall(shell, createMcpPrepareState()) as { call: object }).call,
      "detailInput",
    )).toBe(false);
  });
});

describe("zero-argument MCP keeps IN and OUT", () => {
  const emptyGrok = {
    ...grokUse,
    toolCallId: "call-use-empty",
    rawInput: { tool_name: "everything__list_folders", tool_input: {} },
  };
  const emptyGrokDone = {
    ...grokUseDone,
    toolCallId: "call-use-empty",
    rawOutput: {
      type: "MCP",
      tool_name: "list_folders",
      server_name: "everything",
      output: { OkayOutput: "[]" },
    },
  };
  const emptyCodex = {
    ...codexCall,
    toolCallId: "exec-mcp-empty",
    title: "mcp.everything.list_folders",
    rawInput: { server: "everything", tool: "list_folders", arguments: {} },
  };
  const emptyCodexDone = {
    ...codexDone,
    toolCallId: "exec-mcp-empty",
    rawInput: { server: "everything", tool: "list_folders", arguments: {} },
    rawOutput: {
      result: { content: [{ type: "text", text: "[]" }], structuredContent: null, _meta: null },
      error: null,
    },
  };
  const emptyClaudePending = {
    ...claudePending,
    toolCallId: "toolu_mcp_empty",
    title: "mcp__everything__list_folders",
    _meta: { claudeCode: { toolName: "mcp__everything__list_folders" } },
  };
  const emptyClaudeDone = {
    ...claudeDone,
    toolCallId: "toolu_mcp_empty",
    rawOutput: [{ type: "text", text: "[]" }],
    content: [{ type: "content", content: { type: "text", text: "[]" } }],
    _meta: { claudeCode: { toolName: "mcp__everything__list_folders" } },
  };

  it("keeps IN {} and OUT on grok, Codex, and Claude", () => {
    const grokState = createMcpPrepareState();
    expect(extractMcpInput(emptyGrok)).toBe(EMPTY_MCP_ARGS);
    const grokFirst = prepareMcpToolCall(emptyGrok, grokState);
    expect(grokFirst.action).toBe("emit");
    if (grokFirst.action !== "emit") return;
    expect(grokFirst.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(grokFirst.commandOutput).toBeNull();
    const grokDone = prepareMcpToolCall(emptyGrokDone, grokState);
    expect(grokDone.action).toBe("emit");
    if (grokDone.action !== "emit") return;
    expect(grokDone.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(grokDone.commandOutput).toEqual({
      command: EMPTY_MCP_ARGS,
      toolCallId: "call-use-empty",
      output: "[]",
      exitCode: null,
      truncated: false,
      agentSawCut: false,
      cancelled: false,
    });

    const codexState = createMcpPrepareState();
    expect(extractMcpInput(emptyCodex)).toBe(EMPTY_MCP_ARGS);
    expect(prepareMcpToolCall(emptyCodex, codexState)).toMatchObject({ action: "emit", commandOutput: null });
    const codexDonePrep = prepareMcpToolCall(emptyCodexDone, codexState);
    expect(codexDonePrep.action).toBe("emit");
    if (codexDonePrep.action !== "emit") return;
    expect(codexDonePrep.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(codexDonePrep.commandOutput).toMatchObject({
      command: EMPTY_MCP_ARGS,
      toolCallId: "exec-mcp-empty",
      output: "[]",
    });

    const claudeState = createMcpPrepareState();
    expect(extractMcpInput(emptyClaudePending)).toBeNull();
    const pending = prepareMcpToolCall(emptyClaudePending, claudeState);
    expect(pending.action).toBe("emit");
    if (pending.action !== "emit") return;
    expect(pending.call.detailInput).toBeNull();
    const claudeDonePrep = prepareMcpToolCall(emptyClaudeDone, claudeState);
    expect(claudeDonePrep.action).toBe("emit");
    if (claudeDonePrep.action !== "emit") return;
    expect(claudeDonePrep.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(claudeDonePrep.commandOutput).toMatchObject({
      command: EMPTY_MCP_ARGS,
      toolCallId: "toolu_mcp_empty",
      output: "[]",
    });
  });
});

describe("same-argument MCP calls stay correlated by toolCallId", () => {
  it("does not swap OUT when two identical-arg calls complete out of order", () => {
    const state = createMcpPrepareState();
    const a = { ...codexCall, toolCallId: "exec-mcp-a" };
    const b = { ...codexCall, toolCallId: "exec-mcp-b" };
    expect(prepareMcpToolCall(a, state)).toMatchObject({ action: "emit", call: { detailInput: IN } });
    expect(prepareMcpToolCall(b, state)).toMatchObject({ action: "emit", call: { detailInput: IN } });
    const bDone = prepareMcpToolCall({
      ...codexDone,
      toolCallId: "exec-mcp-b",
      rawOutput: {
        result: { content: [{ type: "text", text: "out-b" }], structuredContent: null, _meta: null },
        error: null,
      },
    }, state);
    const aDone = prepareMcpToolCall({
      ...codexDone,
      toolCallId: "exec-mcp-a",
      rawOutput: {
        result: { content: [{ type: "text", text: "out-a" }], structuredContent: null, _meta: null },
        error: null,
      },
    }, state);
    expect(bDone.action).toBe("emit");
    expect(aDone.action).toBe("emit");
    if (bDone.action !== "emit" || aDone.action !== "emit") return;
    expect(bDone.commandOutput).toMatchObject({ toolCallId: "exec-mcp-b", output: "out-b", command: IN });
    expect(aDone.commandOutput).toMatchObject({ toolCallId: "exec-mcp-a", output: "out-a", command: IN });
  });
});

describe("provider metadata wins over argument-key heuristics", () => {
  it("reads a Claude tool whose args are named server/tool as Claude, not Codex", () => {
    const call = {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_collide",
      title: "mcp__everything__echo",
      kind: "other",
      rawInput: { server: "everything", tool: "echo", message: "keep-me" },
      _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
    };
    expect(isMcpToolCall(call)).toBe(true);
    expect(extractMcpInput(call)).toBe(JSON.stringify({
      server: "everything",
      tool: "echo",
      message: "keep-me",
    }, null, 2));
    const prepared = prepareMcpToolCall(call, createMcpPrepareState());
    expect(prepared.action).toBe("emit");
    if (prepared.action !== "emit") return;
    expect(prepared.call.detailInput).toContain("keep-me");
    expect(prepared.call.detailInput).not.toBeNull();
  });

  it("reads a Claude tool whose args are named tool_name/tool_input as Claude, not grok", () => {
    const call = {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_collide_grok",
      title: "mcp__everything__echo",
      rawInput: { tool_name: "not-grok", tool_input: { inner: "nope" }, message: "keep-me" },
      _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
    };
    expect(extractMcpInput(call)).toBe(JSON.stringify({
      tool_name: "not-grok",
      tool_input: { inner: "nope" },
      message: "keep-me",
    }, null, 2));
  });

  it("does not hide a Claude MCP tool whose arguments look like grok search", () => {
    const call = {
      title: "mcp__everything__echo",
      rawInput: { variant: "SearchTool", query: "x" },
      _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
    };
    expect(isMcpMachineryRow(call)).toBe(false);
    expect(isMcpToolCall(call)).toBe(true);
    expect(extractMcpInput(call)).toContain("SearchTool");
  });
});
