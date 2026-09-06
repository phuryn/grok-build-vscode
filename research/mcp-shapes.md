# MCP tool calls on the ACP wire — all three providers

Measured 2026-08-18 with the official `@modelcontextprotocol/server-everything`
passed through ACP's own `session/new` `mcpServers` parameter, so every provider
got an identical server and an identical prompt (`echo`, `message=MCPSHAPE_9931`).

A structured follow-up the same day used `scratchpad/structured-mcp-server.cjs`
(terse `content` text plus a `structuredContent` payload) through the Claude ACP
adapter (`ANTHROPIC_MODEL=claude-opus-5`) and Codex — that is the string-
`rawOutput` / `structuredContent` case below.

Probe: `research/mcp-shape-per-provider-probe.cjs <grok|codex|claude>`.
Full dumps: `%TEMP%/mcp-shape-<provider>.json`.

Builds: grok CLI 1.0.5; `@agentclientprotocol/codex-acp` and
`@agentclientprotocol/claude-agent-acp` as vendored in this repo's `node_modules`.

## The short version

**There is no common field.** IN, OUT and the tool's own name each live somewhere
different per provider, so any IN/OUT row for MCP needs a per-provider normalizer
— the same shape of work `normalizeCodexUpdate` already does for tool names.

| | grok | codex | claude |
|---|---|---|---|
| tool name | `rawInput.tool_name` (`everything__echo`) | `title` (`mcp.everything.echo`) + `rawInput.server`/`.tool` | `title` / `_meta.claudeCode.toolName` (`mcp__everything__echo`) |
| IN args | `rawInput.tool_input` | `rawInput.arguments` | `rawInput` **flat** |
| OUT | `rawOutput.output.OkayOutput` (string; sibling keys on `output` included) | `rawOutput.result.content` blocks **and** `structuredContent`; non-null `error` | `rawOutput` is **polymorphic**: content-block **array** (plain text) **or** a JSON **string** (structured) |
| error channel | — (not probed) | `rawOutput.error` (null on success; shown when non-null) | — (not probed) |
| `content` on the completed update | **absent** | **absent** | present |
| MCP marker | `_meta["x.ai/tool"].name === "use_tool"` | `_meta.is_mcp_tool_call === true` | `_meta.claudeCode.toolName` starts `mcp__` |
| `kind` on the call | `other` | `execute` | `other` |

**The trap:** two of three providers send **no `content`** on the completed MCP
update. The shell IN/OUT block reads `content`, so reusing that path unchanged
renders output for Claude and blank for grok and codex.

## grok

One MCP call produces **three** tool rows, because grok routes MCP through its own
wrappers — a `search_tool` call to locate the tool, then `use_tool` to invoke it:

    tool_call        title="search_tool"  rawInput={"query":"everything echo","limit":5}
    tool_call_update title="Search tools: \"everything echo\""  kind="other"
    tool_call_update status="completed"  rawOutput={"type":"SearchTool","result_count":5,…}
    tool_call        title="use_tool"     rawInput={"tool_name":"everything__echo","tool_input":{"message":"MCPSHAPE_9931"}}
    tool_call_update title="everything__echo"  kind="other"  rawInput={"variant":"UseTool",…}
    tool_call_update status="completed"  rawOutput={"type":"MCP","tool_name":"echo","server_name":"everything","output":{"OkayOutput":"Echo: MCPSHAPE_9931"}}

A client that renders every tool row as a standalone command shows a tool-search
row the user did not ask for. The host folds `search_tool` into the existing
explore group (`kind:"search"`) so the sequence still reads; the real call is
the `use_tool` one, whose update title carries the readable name.

## codex

    tool_call        title="mcp.everything.echo"  kind="execute"  status="in_progress"
                     rawInput={"server":"everything","tool":"echo","arguments":{"message":"MCPSHAPE_9931"}}
                     _meta={"is_mcp_tool_call":true}
    tool_call_update status="completed"
                     rawOutput={"result":{"content":[{"type":"text","text":"Echo: MCPSHAPE_9931"}],
                                          "structuredContent":null,"_meta":null},"error":null}

`_meta.is_mcp_tool_call` is an explicit, reliable marker — the only provider that
gives one directly. Note `kind: "execute"`, which is why `normalizeCodexUpdate`
remaps it (#115): an execute row short-circuits before the title is read.

**`structuredContent` is the real payload on many servers.** `echo` returned
plain text and `structuredContent: null`, so the first measurement never saw
this. A Gmail search (and a purpose-built probe, same envelope) arrives as:

    rawOutput = {"result":{
        "content":[{"type":"text","text":"Action completed."}],
        "structuredContent":{"query":"after:2026/08/18",
            "messages":[{"id":"m1","subject":"STRUCTPAYLOAD_ONE",…},…],
            "total":2},
        "_meta":null},"error":null}

`extractMcpOutput` therefore renders **both** the text blocks and a
pretty-printed `structuredContent`, and a non-null `error` (instead of
dropping OUT so a failed call looks like a call that returned nothing).

Also observed: a `mcp__everything__startup` row with `status:"failed"` and
`"[codex-acp forwarded startup error] MCP server \`everything\` startup was
cancelled."` — emitted even though the subsequent call succeeded. The host
drops every `mcp__<server>__startup` row for its whole lifecycle, remembering
the id for updates without the title. Failed startups write the server name
and forwarded text to the host log; successful and running startups stay silent.

## claude

`rawOutput` is **polymorphic**. Both shapes are measured; a client that only
handles the array drops structured results as if the tool returned nothing.

Plain-text result (`echo`):

    tool_call        title="mcp__everything__echo"  kind="other"  status="pending"  rawInput={}
    tool_call_update rawInput={"message":"MCPSHAPE_9931"}          (args arrive on the update, not the call)
    tool_call_update _meta.claudeCode.toolResponse=[{"type":"text","text":"Echo: MCPSHAPE_9931"}]
    tool_call_update status="completed"
                     rawOutput=[{"type":"text","text":"Echo: MCPSHAPE_9931"}]
                     content=[{"type":"content","content":{"type":"text","text":"Echo: MCPSHAPE_9931"}}]

Structured result (same server as the Codex Gmail / `structured-mcp-server.cjs`
case — terse `content` plus a `structuredContent` object):

    keys = ["_meta","toolCallId","sessionUpdate","status","rawOutput","content"]
    rawOutput = "{\"query\":\"after:2026/08/18\",\"messages\":[{\"id\":\"m1\",\"subject\":\"STRUCTPAYLOAD_ONE\",…}],\"total\":2}"
    content   = [{"type":"content","content":{"type":"text","text":"<the same JSON string>"}}]

Claude serialises `structuredContent` to a JSON **string** and puts that string
in `rawOutput`. It does **not** wrap it in a Codex-style
`{result:{content, structuredContent}}` envelope, and it is not an array of
blocks. `content` repeats the same string inside a text block.

`rawInput` is `{}` on the initial call and filled on a later update, so a client
reading args at call time gets nothing. The response also appears twice — once in
`_meta.claudeCode.toolResponse` one update before completion, then in
`rawOutput`/`content`. `extractMcpOutput` reads only the completed `rawOutput`:
every array block (text as text, non-text as indented JSON), or a string shown
verbatim — do not `JSON.parse` it, or integers past 2^53 are rounded. Do **not** also read
`toolResponse` — two sources is how a double-render happens.
