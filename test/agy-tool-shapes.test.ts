/**
 * Antigravity's tool calls in the shapes the renderer reads, and invoke_subagent
 * as a subagent card. The frames are the ones Google's server 1.4.0 sent in a
 * live session (Gemini 3.8 Flash, Google sign-in, 2026-10-15), paths shortened;
 * the key-mode model ids are the 40 a real key was offered in gateway mode.
 */
import { describe, expect, it } from "vitest";
import {
  AgyBackend,
  AgyToolCallMerger,
  AgyToolCallShapes,
  agyToolNameFromTitle,
  isAgyGemini2,
  normalizeAgyPermissionParams,
  normalizeAgySessionResponse,
  normalizeAgyUpdate,
} from "../src/agy-backend";

const WS = "C:/work/proj";

function run(frames: any[]): any[] {
  const shapes = new AgyToolCallShapes();
  const merger = new AgyToolCallMerger();
  return frames.map((frame) => normalizeAgyUpdate(frame, undefined, merger, shapes).update);
}

describe("Antigravity tool calls, normalised for the renderer", () => {
  it("names the tool from the title: awaiting approval, running, and a command's own line", () => {
    expect(["Run edit_file?", "Running view_file", "Running invoke_subagent", "Get-ChildItem", "Run edit_file", "github_list_issues"]
      .map(agyToolNameFromTitle)).toEqual(["edit_file", "view_file", "invoke_subagent", undefined, undefined, undefined]);
  });

  it("a command: its line and folder as command/cwd, a neutral title, and its output as output", () => {
    const id = "1582e01c751b443b9dbe7277c2bd4d37";
    const line = 'Get-ChildItem -Recurse -File -Exclude ".*" | Select-String "TODO"';
    const [pending, running, done] = run([
      { sessionUpdate: "tool_call", toolCallId: id, title: line, kind: "execute", status: "pending", rawInput: { CommandLine: line, Cwd: WS, WaitMsBeforeAsync: 5000 } },
      { sessionUpdate: "tool_call_update", toolCallId: id, title: line, kind: "execute", status: "in_progress", rawInput: { command_line: line, working_dir: WS } },
      { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { commandLine: line, workingDir: WS, exitCode: 0, exit_code: 0, combinedOutput: "\r\nsrc\\app.js:3:// TODO: tidy this up\r\n", formatted_output: "\r\nsrc\\app.js:3:// TODO: tidy this up\r\n" } },
    ]);
    expect(pending).toMatchObject({ tool: "run_command", title: "Run command", kind: "execute", rawInput: { CommandLine: line, command: line, cwd: WS } });
    expect(running).toMatchObject({ tool: "run_command", title: "Run command", rawInput: { command: line, cwd: WS } });
    expect(done).toMatchObject({ tool: "run_command", rawOutput: { output: "\r\nsrc\\app.js:3:// TODO: tidy this up\r\n", exit_code: 0 } });
    expect(done).not.toHaveProperty("title");
  });

  it("a read: the file and its line range where the renderer looks, in both spellings the server uses", () => {
    const [lower, upper] = run([
      { sessionUpdate: "tool_call", toolCallId: "call_576434", title: "Running view_file", kind: "read", status: "in_progress", rawInput: { absolute_path: `${WS}/src/app.js` }, locations: [{ path: `${WS}/src/app.js` }] },
      { sessionUpdate: "tool_call", toolCallId: "call_384298", title: "Running view_file", kind: "read", status: "in_progress", rawInput: { AbsolutePath: `${WS}/src/app.js`, StartLine: 1, EndLine: 2 } },
    ]);
    expect(lower).toMatchObject({ tool: "view_file", title: "Running view_file", rawInput: { file_path: `${WS}/src/app.js` } });
    expect(upper).toMatchObject({ tool: "view_file", rawInput: { file_path: `${WS}/src/app.js`, start_line: 1, end_line: 2 } });
  });

  it("an edit and a new file: the target as file_path, the diff untouched", () => {
    const diff = [{ type: "diff", path: `${WS}/src/app.js`, oldText: "const a = 1;", newText: "const a = 2;" }];
    const [edit, running] = run([
      { sessionUpdate: "tool_call", toolCallId: "785707b3", title: "Run edit_file?", kind: "edit", status: "pending", content: diff, locations: [{ path: `${WS}/src/app.js`, line: 1 }],
        rawInput: { TargetFile: `${WS}/src/app.js`, TargetContent: "const a = 1;", ReplacementContent: "const a = 2;", StartLine: 1, EndLine: 1 } },
      { sessionUpdate: "tool_call_update", toolCallId: "785707b3", title: "Running edit_file", kind: "edit", status: "in_progress", rawInput: { file_path: "C:\\work\\proj\\src\\app.js" } },
    ]);
    expect(edit).toMatchObject({ tool: "edit_file", content: diff, rawInput: { file_path: `${WS}/src/app.js` } });
    expect(running).toMatchObject({ tool: "edit_file", rawInput: { file_path: "C:\\work\\proj\\src\\app.js" } });
    const [create] = run([{ sessionUpdate: "tool_call", toolCallId: "b7ea9288", title: "Run create_file?", kind: "edit", status: "pending",
      rawInput: { CodeContent: "hello", Overwrite: true, TargetFile: `${WS}/hello.md` } }]);
    expect(create).toMatchObject({ tool: "write_file", rawInput: { file_path: `${WS}/hello.md` } });
  });

  it("a page read and a web search: the url and the query", () => {
    const [fetchCall, fetchRunning, search] = run([
      { sessionUpdate: "tool_call", toolCallId: "7543ce01", title: "Run read_url_content?", kind: "fetch", status: "pending", rawInput: { Url: "https://example.com" } },
      { sessionUpdate: "tool_call_update", toolCallId: "7543ce01", title: "Running read_url_content", kind: "fetch", status: "in_progress", rawInput: { url: "https://example.com", title: "", summary: "" } },
      { sessionUpdate: "tool_call", toolCallId: "19e39b22", title: "Run search_web?", kind: "search", status: "pending", rawInput: { query: "Agent Client Protocol specification" } },
    ]);
    expect(fetchCall).toMatchObject({ tool: "web_fetch", rawInput: { url: "https://example.com" } });
    expect(fetchRunning).toMatchObject({ tool: "web_fetch", rawInput: { url: "https://example.com" } });
    expect(search).toMatchObject({ tool: "search_web", rawInput: { query: "Agent Client Protocol specification" } });
  });

  // Not registered for the account the capture ran under ("list_dir,
  // grep_search and find_by_name are not registered tools in this
  // environment"), so these follow the field names the server's own location
  // helper reads (tools.py `extract_tool_locations`).
  it("a listing, a grep and a file search, by the server's own field names", () => {
    const [list, grep, find] = run([
      { sessionUpdate: "tool_call", toolCallId: "l1", title: "Running list_dir", kind: "search", status: "in_progress", rawInput: { DirectoryPath: WS } },
      { sessionUpdate: "tool_call", toolCallId: "g1", title: "Running grep_search", kind: "search", status: "in_progress", rawInput: { Query: "TODO", SearchPath: WS } },
      { sessionUpdate: "tool_call", toolCallId: "f1", title: "Running find_by_name", kind: "search", status: "in_progress", rawInput: { Pattern: "*.txt", SearchDirectory: WS } },
    ]);
    expect(list).toMatchObject({ tool: "list_dir", rawInput: { target_directory: WS } });
    expect(grep).toMatchObject({ tool: "grep", rawInput: { pattern: "TODO", path: WS } });
    expect(find).toMatchObject({ tool: "search_files", rawInput: { pattern: "*.txt", path: WS } });
  });

  it("reads replayed history's arguments, which arrive as the JSON text the model wrote", () => {
    const [replayed] = run([{ sessionUpdate: "tool_call", toolCallId: "step_7", title: "Running view_file", kind: "read", status: "completed",
      rawInput: JSON.stringify({ AbsolutePath: `${WS}/notes.txt` }) }]);
    expect(replayed).toMatchObject({ tool: "view_file", rawInput: { AbsolutePath: `${WS}/notes.txt`, file_path: `${WS}/notes.txt` } });
  });

  it("leaves an MCP tool and anything it cannot name as the server sent it", () => {
    const mcp = { sessionUpdate: "tool_call", toolCallId: "m1", title: "github_list_issues", kind: "other", status: "in_progress", rawInput: { repo: "x" }, _meta: { is_mcp_tool_call: true } };
    expect(run([mcp])[0]).toEqual(mcp);
  });

  it("puts the command where an approval card reads it, keeping the server's title", () => {
    const params = { sessionId: "s", toolCall: { toolCallId: "c", kind: "execute", status: "pending", title: "node --version", rawInput: { CommandLine: "node --version", Cwd: WS } }, options: [] };
    expect(normalizeAgyPermissionParams(params).toolCall).toMatchObject({ title: "node --version", rawInput: { command: "node --version", cwd: WS } });
  });
});

describe("Antigravity subagents, as subagent cards with their own work inside", () => {
  const launchId = "24ac72049c3b49ecac09e055152210cf";
  const child = (id: string) => `agy-subagent:${id}`;
  const launch = (id: string, role: string) => [
    { sessionUpdate: "tool_call", toolCallId: id, title: "Run invoke_subagent?", kind: "other", status: "pending",
      rawInput: { Subagents: [{ Model: "inherit", Prompt: `${role}: list the files and read notes.txt.`, Role: role, TypeName: "research", Workspace: "inherit" }] } },
    { sessionUpdate: "tool_call_update", toolCallId: id, title: "Running invoke_subagent", kind: "other", status: "in_progress", rawInput: {} },
    { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "Invoke subagent" },
  ];
  const read = (id: string, file: string) => ({ sessionUpdate: "tool_call", toolCallId: id, title: "Running view_file", kind: "read", status: "in_progress", rawInput: { absolute_path: `${WS}/${file}` } });
  const done = (id: string) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
  const text = (value: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });

  function session() {
    const backend = new AgyBackend();
    return {
      backend,
      feed: (frames: any[]) => frames.map((frame) => backend.normalizeUpdate(frame, undefined)),
    };
  }

  it("one launch: the card runs while its child works, the child's calls go inside it, the parent's text stays out, and the turn's end settles it", () => {
    const { backend, feed } = session();
    const [pending, running, receipt, childCall, parentText, childDone] = feed([
      ...launch(launchId, "Project Explorer"), read("call_636537", "notes.txt"), text("The subagent found the notes."), done("call_636537"),
    ]);
    expect(pending.update).toMatchObject({ kind: "subagent", title: "Project Explorer", child_session_id: child(launchId),
      rawInput: { description: "Project Explorer", subagent_type: "research" } });
    expect(pending.childSessionId).toBeUndefined();
    expect(running.update).toMatchObject({ kind: "subagent", status: "in_progress" });
    // "Invoke subagent" is the model's summary of the launch: the child is only starting.
    expect(receipt.update).toMatchObject({ kind: "subagent", status: "in_progress" });
    expect(receipt.update).not.toHaveProperty("rawOutput");
    expect(childCall).toMatchObject({ childSessionId: child(launchId), update: { tool: "view_file" } });
    expect(childDone.childSessionId).toBe(child(launchId));
    expect(parentText.childSessionId).toBeUndefined();
    expect(backend.turnEnded("completed")).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: launchId, kind: "subagent", tool: "invoke_subagent", status: "completed", rawOutput: { output: "" } },
    ]);
    expect(backend.turnEnded("completed")).toEqual([]);
  });

  it("two launches: new calls go to the newest open card, earlier calls stay with theirs, and both settle", () => {
    const { backend, feed } = session();
    const out = feed([
      ...launch("first", "Reader"), read("a", "notes.txt"),
      ...launch("second", "Counter"), read("b", "README.md"), done("a"), done("b"),
    ]);
    const routed = out.filter((entry) => entry.update?.toolCallId?.length === 1).map((entry) => [entry.update.toolCallId, entry.update.status, entry.childSessionId]);
    expect(routed).toEqual([
      ["a", "in_progress", child("first")], ["b", "in_progress", child("second")],
      ["a", "completed", child("first")], ["b", "completed", child("second")],
    ]);
    expect(backend.turnEnded("completed").map((update) => update.toolCallId)).toEqual(["first", "second"]);
  });

  it("a call the parent opened before the launch stays the parent's; one it makes during the window lands in the card (the accepted cost)", () => {
    const { backend, feed } = session();
    const [, , , , early, parentInWindow] = feed([
      read("parent-before", "app.js"), ...launch(launchId, "Explorer"), done("parent-before"), read("parent-during", "package.json"),
    ]);
    expect(early.childSessionId).toBeUndefined();
    expect(parentInWindow.childSessionId).toBe(child(launchId));
    backend.turnEnded("completed");
  });

  it("the next turn's calls are the parent's: the server streams nothing between turns, and the card has settled", () => {
    const { backend, feed } = session();
    feed([...launch(launchId, "Explorer"), read("a", "notes.txt")]);
    expect(backend.turnEnded("completed")).toHaveLength(1);
    const [nextTurn] = feed([read("next", "README.md")]);
    expect(nextTurn.childSessionId).toBeUndefined();
    expect(backend.turnEnded("completed")).toEqual([]);
  });

  it("a cancelled turn stops its cards, and a refused launch opens no window", () => {
    const { backend, feed } = session();
    feed([...launch(launchId, "Explorer")]);
    expect(backend.turnEnded("cancelled")).toMatchObject([{ toolCallId: launchId, status: "cancelled" }]);
    const [, refused, afterRefusal] = feed([
      launch("refused", "Explorer")[0],
      { sessionUpdate: "tool_call_update", toolCallId: "refused", status: "failed", rawOutput: "Denied by user." },
      read("x", "notes.txt"),
    ]);
    expect(refused.update).toMatchObject({ kind: "subagent", status: "failed" });
    expect(afterRefusal.childSessionId).toBeUndefined();
    expect(backend.turnEnded("completed")).toEqual([]);
  });

  it("replay: the same grouping from history, each card settled when the next user message starts a turn and at the end of the load", () => {
    const { backend, feed } = session();
    const replayed = (id: string, role: string) => ({ sessionUpdate: "tool_call", toolCallId: id, title: "Running invoke_subagent", kind: "other", status: "completed",
      rawInput: JSON.stringify({ Subagents: [{ Role: role, Prompt: "Look around." }] }) });
    const out = feed([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Run a demo subagent" } },
      replayed("step_3", "Explorer"), { sessionUpdate: "tool_call_update", toolCallId: "step_3", status: "completed", rawOutput: "Invoke subagent" },
      { sessionUpdate: "tool_call", toolCallId: "step_4", title: "Running view_file", kind: "read", status: "completed", rawInput: JSON.stringify({ AbsolutePath: `${WS}/README.md` }) },
      text("Done."),
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "And again" } },
      replayed("step_9", "Second"),
      { sessionUpdate: "tool_call", toolCallId: "step_10", title: "Running view_file", kind: "read", status: "completed", rawInput: JSON.stringify({ AbsolutePath: `${WS}/notes.txt` }) },
    ]);
    expect(out[1].update).toMatchObject({ kind: "subagent", status: "in_progress", title: "Explorer", child_session_id: child("step_3") });
    expect(out[3]).toMatchObject({ childSessionId: child("step_3"), update: { tool: "view_file" } });
    // The second user message settles the first turn's card before it is routed.
    expect(out[5].precede).toEqual([expect.objectContaining({ toolCallId: "step_3", status: "completed" })]);
    expect(out[7].childSessionId).toBe(child("step_9"));
    expect(backend.turnEnded("completed").map((update) => update.toolCallId)).toEqual(["step_9"]);
  });
});
