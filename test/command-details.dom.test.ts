// DOM tests for #41 — full command text + captured output on command rows,
// driving the REAL media/chat.js. The host snapshots each terminal's buffer at
// terminal/release (the extension runs the commands itself, so the output is
// exactly what grok received) and posts it as `commandOutput`; the webview
// renders a Claude-Code-style IN/OUT block under the row, collapsed by default
// with the tool-group header's chevron affordance. Outputs attach by
// exact-command FIFO, with a standalone fallback row so output is never
// dropped. Success is silent (exit 0 = just the output); failure gets an
// [Error] marker + error tint; a kill is [Cancelled], not an error.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";
import { normalizeCodexUpdate } from "../src/codex-backend";
import { commandOutputForToolCall } from "../src/acp-dispatch";

const exec = (id: string, command: string, title?: string) => ({
  type: "toolCall",
  call: {
    toolCallId: id,
    kind: "execute",
    title: title ?? `Run ${command.slice(0, 20)}…`,
    rawInput: { variant: "Bash", command, is_background: false },
  },
});
const out = (
  command: string,
  output: string,
  exitCode: number | null = 0,
  truncated = false,
  cancelled?: boolean,
) => ({
  type: "commandOutput" as const,
  command,
  output,
  exitCode,
  truncated,
  ...(cancelled !== undefined ? { cancelled } : {}),
});
const explore = (id: string, path: string) => ({
  type: "toolCall",
  call: { toolCallId: id, kind: "search", title: "grep", rawInput: { pattern: "needle", path } },
});
const close = (window: Window) => dispatch(window, { type: "messageChunk", text: "done" });

describe("command details (#41)", () => {
  it("a lone command flattens WITH its trailing chevron + expandable IN/OUT block", () => {
    const { window, doc } = bootWebview();
    const longCmd = "node -e \"const fs=require('fs');const paths=fs.readdirSync('.').filter(p=>p.endsWith('.md'));console.log(paths.join('\\n'))\"";
    dispatch(window, exec("t1", longCmd, "Run node -e \"const fs=require('fs');const pa…"));
    close(window);

    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    expect(flat).not.toBeNull();
    expect(flat.querySelector(".tool-chevron")).not.toBeNull(); // › after the label, moved with the flatten
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(true); // collapsed by default
    expect(flat.classList.contains("expanded")).toBe(false);

    click(window, flat);
    expect(details.hidden).toBe(false);
    expect(flat.classList.contains("expanded")).toBe(true); // › rotated to v

    // The FULL command under an IN tag, not grok's truncated title.
    expect(details.querySelector(".cmd-io-tag")!.textContent).toBe("IN");
    expect(details.querySelector(".tool-cmd")!.textContent).toBe(longCmd);

    // Output lands after the flatten — the moved node still receives it.
    // Success is silent: OUT tag + text, no exit marker.
    dispatch(window, out(longCmd, "CLAUDE.md\nREADME.md", 0));
    const outRow = details.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.querySelector(".cmd-io-tag")!.textContent).toBe("OUT");
    expect(outRow.querySelector(".tool-cmd-output")!.textContent).toBe("CLAUDE.md\nREADME.md");
    expect(outRow.classList.contains("failed")).toBe(false);
    expect(outRow.querySelector(".cmd-out-marker")).toBeNull();

    click(window, flat);
    expect(details.hidden).toBe(true);
    expect(flat.classList.contains("expanded")).toBe(false); // back to ›
  });

  it("grok.expandCommandOutputs pre-expands new rows and applies live to existing ones", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
    });
    dispatch(window, exec("a", "git status"));
    close(window);

    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(false); // pre-expanded (v)
    expect(flat.classList.contains("expanded")).toBe(true);

    // Live config change collapses existing rows too.
    dispatch(window, { type: "expandCommandOutputs", value: false });
    expect(details.hidden).toBe(true);
    expect(flat.classList.contains("expanded")).toBe(false);

    dispatch(window, { type: "expandCommandOutputs", value: true });
    expect(details.hidden).toBe(false);
    expect(flat.classList.contains("expanded")).toBe(true);
  });

  it("outputs attach FIFO when the same command runs twice in one batch; exit 1 is [Error]", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "npm test"));
    close(window); // 2 calls → stays a group with .tool-item rows

    dispatch(window, out("npm test", "first run", 0));
    dispatch(window, out("npm test", "second run", 1));

    const items = [...doc.querySelectorAll(".tool-item.has-details")];
    expect(items).toHaveLength(2);
    // Labels in their own span (single-line ellipsis) + trailing chevron each.
    expect(items.every((i) => i.querySelector(".tool-item-label"))).toBe(true);
    expect(items.every((i) => i.querySelector(".tool-chevron"))).toBe(true);

    const details = [...doc.querySelectorAll(".tool-item .tool-item-details")];
    expect(details[0].querySelector(".tool-cmd-output")!.textContent).toBe("first run");
    expect(details[1].querySelector(".tool-cmd-output")!.textContent).toBe("second run");
    const failedRow = details[1].querySelector(".cmd-out") as HTMLElement;
    expect(failedRow.classList.contains("failed")).toBe(true);
    expect(failedRow.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
    // The non-zero exit also rolls up to the ROW + GROUP (error at a glance,
    // consistent with a status:"failed" tool); the exit-0 row stays clean.
    expect(items[1].classList.contains("tool-failed")).toBe(true);
    expect(items[0].classList.contains("tool-failed")).toBe(false);
    expect((items[1].closest(".tool-group") as HTMLElement).classList.contains("has-error")).toBe(true);
  });

  it("a lone non-zero command flags its flattened row as failed (not just the OUT box)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("solo", "node build.js"));
    close(window); // 1 call → flattens to .tool-flat
    dispatch(window, out("node build.js", "boom", 1));
    const flat = doc.querySelector(".tool-flat") as HTMLElement;
    expect(flat.classList.contains("tool-failed")).toBe(true);
    expect(flat.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
  });

  it("an output with no matching row gets a standalone fallback row (never dropped)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, out("echo orphan", "orphan output", 0));

    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details).not.toBeNull();
    expect(details.querySelector(".tool-cmd")!.textContent).toBe("echo orphan");
    expect(details.querySelector(".tool-cmd-output")!.textContent).toBe("orphan output");
  });

  it("clips a long single-line command but keeps the full text reachable remotely", () => {
    const { window, doc } = bootWebview({
      remote: true,
      beforeScripts: (win) => {
        Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
          configurable: true,
          get() { return this.classList?.contains("tool-cmd") ? 120 : 0; },
        });
        Object.defineProperty(win.HTMLElement.prototype, "scrollWidth", {
          configurable: true,
          get() { return this.classList?.contains("tool-cmd") ? 480 : 0; },
        });
      },
    });
    const longCmd = `node -e "${"console.log('x');".repeat(12)}"`;
    dispatch(window, exec("long", longCmd));
    close(window);
    const row = doc.querySelector(".tool-flat.has-details")!;
    click(window, row);
    const pre = row.querySelector(".tool-cmd") as HTMLElement;
    const viewAll = row.querySelector(".command-view-all")!;
    expect(pre.textContent).toBe(longCmd);
    expect(pre.classList.contains("command-full")).toBe(false);
    click(window, viewAll);
    expect(pre.classList.contains("command-full")).toBe(true);
    expect(pre.textContent).toBe(longCmd);
  });

  it("offers a touch reveal when a short command actually overflows a narrow container", () => {
    const { window, doc } = bootWebview({
      remote: true,
      beforeScripts: (win) => {
        Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
          configurable: true,
          get() { return this.classList?.contains("tool-cmd") ? 72 : 0; },
        });
        Object.defineProperty(win.HTMLElement.prototype, "scrollWidth", {
          configurable: true,
          get() { return this.classList?.contains("tool-cmd") ? 240 : 0; },
        });
      },
    });
    const command = "git status --short src media test";
    expect(command.length).toBeLessThan(80);
    dispatch(window, exec("narrow", command));
    close(window);
    const row = doc.querySelector(".tool-flat.has-details")!;
    click(window, row);

    const reveal = row.querySelector(".command-view-all") as HTMLButtonElement;
    expect(reveal).not.toBeNull();
    expect(reveal.tagName).toBe("BUTTON");
    click(window, reveal);
    expect((row.querySelector(".tool-cmd") as HTMLElement).classList.contains("command-full")).toBe(true);
  });

  it("caps long IN/OUT previews at six lines and opens the full text in untitled editors", () => {
    const { window, doc, posted } = bootWebview();
    const command = Array.from({ length: 8 }, (_, i) => `command ${i + 1}`).join("\n");
    const output = Array.from({ length: 9 }, (_, i) => `output ${i + 1}`).join("\n");
    dispatch(window, exec("long", command));
    close(window);
    dispatch(window, out(command, output, 0));

    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    click(window, flat);
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    expect(details.querySelector(".tool-cmd")!.textContent).toBe(command);
    expect(details.querySelector(".tool-cmd-output")!.textContent).toBe(output);
    expect(details.querySelector(".tool-cmd")!.classList.contains("command-preview-capped")).toBe(true);
    expect(details.querySelector(".tool-cmd-output")!.classList.contains("command-preview-capped")).toBe(true);

    const viewAll = [...details.querySelectorAll(".command-view-all")] as HTMLButtonElement[];
    expect(viewAll.map((b) => b.textContent)).toEqual([
      "View all (8 lines) →",
      "View all (9 lines) →",
    ]);
    click(window, viewAll[0]);
    click(window, viewAll[1]);
    expect(details.hidden).toBe(false); // editor links do not toggle the tool row
    expect(details.querySelector(".tool-cmd")!.textContent).toBe(command);
    expect(details.querySelector(".tool-cmd-output")!.textContent).toBe(output);
    expect(posted.filter((m: any) => m.type === "openText")).toEqual([
      { type: "openText", content: command },
      { type: "openText", content: output },
    ]);
  });

  it("opens a command in the host shell language and output with no language", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, commandLanguage: "powershell",
    });
    const command = Array.from({ length: 8 }, (_, i) => `command ${i + 1}`).join("\n");
    const output = Array.from({ length: 9 }, (_, i) => `output ${i + 1}`).join("\n");
    dispatch(window, exec("lang", command));
    close(window);
    dispatch(window, out(command, output, 0));

    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    click(window, doc.querySelector(".tool-flat.has-details") as HTMLElement);
    const viewAll = [...details.querySelectorAll(".command-view-all")] as HTMLButtonElement[];
    click(window, viewAll[0]);
    click(window, viewAll[1]);
    expect(posted.filter((m: any) => m.type === "openText")).toEqual([
      { type: "openText", content: command, language: "powershell" },
      { type: "openText", content: output },
    ]);
  });

  it.each(["shellscript", "bat"] as const)(
    "sends command language %s from the host and still omits it on output",
    (commandLanguage) => {
      const { window, doc, posted } = bootWebview();
      dispatch(window, {
        type: "initialState",
        effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
        showThinking: false, commandLanguage,
      });
      const command = Array.from({ length: 8 }, (_, i) => `command ${i + 1}`).join("\n");
      const output = Array.from({ length: 8 }, (_, i) => `output ${i + 1}`).join("\n");
      dispatch(window, exec(`lang-${commandLanguage}`, command));
      close(window);
      dispatch(window, out(command, output, 0));

      click(window, doc.querySelector(".tool-flat.has-details") as HTMLElement);
      const viewAll = [...doc.querySelectorAll(".command-view-all")] as HTMLButtonElement[];
      click(window, viewAll[0]);
      click(window, viewAll[1]);
      expect(posted.filter((m: any) => m.type === "openText")).toEqual([
        { type: "openText", content: command, language: commandLanguage },
        { type: "openText", content: output },
      ]);
    },
  );

  it("omits command language when the host never sent one", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false,
    });
    const command = Array.from({ length: 8 }, (_, i) => `command ${i + 1}`).join("\n");
    dispatch(window, exec("old-host", command));
    close(window);

    click(window, doc.querySelector(".tool-flat.has-details") as HTMLElement);
    click(window, doc.querySelector(".command-view-all") as HTMLButtonElement);
    expect(posted.filter((m: any) => m.type === "openText")).toEqual([
      { type: "openText", content: command },
    ]);
  });

  it("clips wrapped commands at rendered rows but keeps a logical line count", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (win) => {
        Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
          configurable: true,
          get() { return this.classList?.contains("tool-cmd") ? 120 : 0; },
        });
        Object.defineProperty(win.HTMLElement.prototype, "scrollHeight", {
          configurable: true,
          get() { return this.classList?.contains("tool-cmd") ? 240 : 0; },
        });
        Object.defineProperty(win.HTMLElement.prototype, "clientHeight", {
          configurable: true,
          get() { return this.classList?.contains("tool-cmd") ? 120 : 0; },
        });
      },
    });
    const command = Array.from({ length: 3 }, () => `python -c "${"print('x');".repeat(30)}"`).join("\n");
    dispatch(window, exec("wrapped", command));
    close(window);

    const row = doc.querySelector(".tool-flat.has-details")!;
    click(window, row);
    const pre = row.querySelector(".tool-cmd") as HTMLElement;
    const viewAll = row.querySelector(".command-view-all") as HTMLButtonElement;
    expect(pre.classList.contains("command-preview-capped")).toBe(true);
    expect(viewAll.textContent).toBe("View all (3 lines) →");
  });

  it("expands long IN/OUT inline on remote clients without posting a host-local message", () => {
    const { window, doc, posted } = bootWebview({ remote: true });
    const command = Array.from({ length: 8 }, (_, i) => `command ${i + 1}`).join("\n");
    const output = Array.from({ length: 9 }, (_, i) => `output ${i + 1}`).join("\n");
    dispatch(window, exec("remote-long", command));
    close(window);
    dispatch(window, out(command, output, 0));

    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    const commandPre = details.querySelector(".tool-cmd") as HTMLElement;
    const outputPre = details.querySelector(".tool-cmd-output") as HTMLElement;
    const viewAll = [...details.querySelectorAll(".command-view-all")] as HTMLButtonElement[];
    expect(viewAll.map((b) => b.textContent)).toEqual([
      "View all (8 lines) →",
      "View all (9 lines) →",
    ]);

    click(window, viewAll[0]);
    expect(commandPre.textContent).toBe(command);
    expect(outputPre.textContent).toBe(output); // each preview expands independently
    expect(viewAll[0].textContent).toBe("Show less");
    click(window, viewAll[1]);
    expect(outputPre.textContent).toBe(output);
    expect(posted.filter((m: any) => m.type === "openText")).toHaveLength(0);

    click(window, viewAll[0]);
    expect(commandPre.textContent).toBe(command);
    expect(viewAll[0].textContent).toBe("View all (8 lines) →");
  });

  it("renders six-line IN/OUT text in full with no View all control", () => {
    const { window, doc } = bootWebview();
    const command = Array.from({ length: 6 }, (_, i) => `command ${i + 1}`).join("\n");
    const output = Array.from({ length: 6 }, (_, i) => `output ${i + 1}`).join("\n");
    dispatch(window, exec("short", command));
    close(window);
    dispatch(window, out(command, output, 0));

    expect(doc.querySelector(".tool-cmd")!.textContent).toBe(command);
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe(output);
    expect(doc.querySelector(".command-view-all")).toBeNull();
  });

  // The cursor/Composer agent runs commands in its OWN CLI-side shell (no
  // terminal/create), so `commandOutput` never fires for it — its output rides
  // the completed tool_call_update (rawOutput/content), keyed by toolCallId. The
  // #41 box must render it from there, or the row shows IN with no OUT (the bug).
  const completed = (id: string, output: string, exitCode = 0) => ({
    type: "toolCallUpdate",
    call: {
      toolCallId: id,
      status: "completed",
      rawOutput: { type: "Bash", output: [...Buffer.from(output, "utf8")], exit_code: exitCode, command: "x", truncated: false },
      content: [{ type: "content", content: { type: "text", text: output } }],
    },
  });

  it("a replayed completed execute tool_call has IN but no OUT until commandOutput arrives", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "call-restore-1",
        kind: "execute",
        status: "completed",
        title: "Execute `echo MARKER`",
        rawInput: { variant: "Bash", command: "echo MARKER", is_background: false },
        content: [{ type: "content", content: { type: "text", text: "MARKER\r\n" } }],
        rawOutput: {
          type: "Bash",
          output: [...Buffer.from("MARKER\r\n", "utf8")],
          output_for_prompt: "exit: 0\nMARKER\n",
          exit_code: 0,
          command: "echo MARKER",
          truncated: false,
        },
      },
    });
    close(window);
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe("echo MARKER");
    expect(doc.querySelector(".cmd-out")).toBeNull();
  });

  it("session/load restore fills OUT from the host commandOutput (same message as live)", () => {
    const { window, doc } = bootWebview();
    const call = {
      toolCallId: "call-restore-2",
      kind: "execute",
      status: "completed",
      title: "Execute `echo MARKER`",
      rawInput: { variant: "Bash", command: "echo MARKER", is_background: false },
      content: [{ type: "content", content: { type: "text", text: "MARKER\r\n" } }],
      rawOutput: {
        type: "Bash",
        output: [...Buffer.from("MARKER\r\n", "utf8")],
        output_for_prompt: "exit: 0\nMARKER\n",
        exit_code: 0,
        command: "echo MARKER",
        truncated: false,
      },
    };
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "toolCall", call });
    const replayed = commandOutputForToolCall(call, { replaying: true });
    expect(replayed).not.toBeNull();
    dispatch(window, { type: "commandOutput", ...replayed! });
    dispatch(window, { type: "historyReplay", active: false });
    close(window);

    expect(doc.querySelectorAll(".has-details")).toHaveLength(1);
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe("echo MARKER");
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("MARKER\r\n");
    expect(doc.querySelector(".cmd-out-marker")).toBeNull();
  });

  it("Claude session/load fills OUT from string rawOutput, not the fenced content or description", () => {
    const { window, doc } = bootWebview();
    const remembered = new Map<string, string>();
    const pending = {
      toolCallId: "toolu_01AnGmToxGM69P1ovvsNgk4F",
      kind: "execute",
      status: "pending",
      title: "echo REPLAY_MARKER_4b7c",
      rawInput: { command: "echo REPLAY_MARKER_4b7c", description: "Echo replay marker string" },
      content: [{ type: "content", content: { type: "text", text: "Echo replay marker string" } }],
    };
    const completed = {
      toolCallId: "toolu_01AnGmToxGM69P1ovvsNgk4F",
      status: "completed",
      rawOutput: "REPLAY_MARKER_4b7c",
      content: [{ type: "content", content: { type: "text", text: "```console\nREPLAY_MARKER_4b7c\n```" } }],
    };
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "toolCall", call: pending });
    expect(commandOutputForToolCall(pending, { replaying: true, rememberedCommands: remembered })).toBeNull();
    dispatch(window, { type: "toolCallUpdate", call: completed });
    const replayed = commandOutputForToolCall(completed, { replaying: true, rememberedCommands: remembered });
    expect(replayed).toEqual({
      command: "echo REPLAY_MARKER_4b7c",
      output: "REPLAY_MARKER_4b7c",
      exitCode: null,
      truncated: false,
      cancelled: false,
      agentSawCut: true,
    });
    dispatch(window, { type: "commandOutput", ...replayed! });
    dispatch(window, { type: "historyReplay", active: false });
    close(window);

    expect(doc.querySelectorAll(".has-details")).toHaveLength(1);
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe("echo REPLAY_MARKER_4b7c");
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("REPLAY_MARKER_4b7c");
    expect(doc.querySelector(".tool-cmd-output")!.textContent).not.toContain("```");
    expect(doc.querySelector(".cmd-out")!.textContent).not.toContain("Echo replay marker string");
    expect(doc.querySelector(".cmd-out-marker")).toBeNull();
    expect(replayed).toEqual(expect.objectContaining({ cancelled: false }));
  });

  it("a live Claude command keeps OUT after a buffer rebuild (conversation switch)", () => {
    const { window, doc } = bootWebview();
    const pending = {
      type: "toolCall" as const,
      call: {
        toolCallId: "toolu_live_1",
        kind: "execute",
        status: "pending",
        title: "echo LIVE_CLAUDE_OUT",
        rawInput: { command: "echo LIVE_CLAUDE_OUT", description: "Echo live marker" },
        content: [{ type: "content", content: { type: "text", text: "Echo live marker" } }],
      },
    };
    const completed = {
      type: "toolCallUpdate" as const,
      call: {
        toolCallId: "toolu_live_1",
        status: "completed",
        rawOutput: "LIVE_CLAUDE_OUT",
        content: [{ type: "content", content: { type: "text", text: "```console\nLIVE_CLAUDE_OUT\n```" } }],
      },
    };
    dispatch(window, pending);
    dispatch(window, completed);
    close(window);
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("LIVE_CLAUDE_OUT");
    expect(doc.querySelector(".cmd-out-marker")).toBeNull();

    // focusSession / rehydrateWebviewFromFocused: clear + historyReplay + the
    // live buffer. Claude has no commandDone, so the buffer has no commandOutput.
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, pending);
    dispatch(window, completed);
    dispatch(window, { type: "historyReplay", active: false });
    close(window);

    expect(doc.querySelectorAll(".has-details")).toHaveLength(1);
    expect(doc.querySelectorAll(".cmd-out")).toHaveLength(1);
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe("echo LIVE_CLAUDE_OUT");
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("LIVE_CLAUDE_OUT");
    expect(doc.querySelector(".tool-cmd-output")!.textContent).not.toContain("```");
    expect(doc.querySelector(".cmd-out")!.textContent).not.toContain("Echo live marker");
    expect(doc.querySelector(".cmd-out-marker")).toBeNull();
  });

  it("fills a self-executed (Composer) command's OUT from the completed update, no terminal/create", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("c1", "git status --short"));
    close(window);
    // No commandOutput ever arrives (Composer never delegates). The completed
    // update carries the result instead.
    dispatch(window, completed("c1", " M CHANGELOG.md", 0));

    const rows = [...doc.querySelectorAll(".has-details")];
    expect(rows).toHaveLength(1); // no duplicate/standalone row
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe(" M CHANGELOG.md");
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe("git status --short"); // IN unchanged
  });

  it("attaches self-executed outputs by toolCallId regardless of completion order (Composer runs parallel)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("a", "git status --short"));
    dispatch(window, exec("b", "$env:USERNAME"));
    close(window); // 2 calls → stays a group with rows
    // Completions arrive OUT of issue order (b before a) — FIFO would swap them.
    dispatch(window, completed("b", "Dell", 0));
    dispatch(window, completed("a", "STATUS_OUT", 0));

    const items = [...doc.querySelectorAll(".tool-item.has-details")];
    expect(items).toHaveLength(2); // no duplicate rows
    const outFor = (id: string) =>
      (items.find((i) => i.querySelector(".tool-cmd")!.textContent ===
        (id === "a" ? "git status --short" : "$env:USERNAME"))!
        .querySelector(".tool-cmd-output") as HTMLElement).textContent;
    expect(outFor("a")).toBe("STATUS_OUT"); // each output on its OWN row, by id
    expect(outFor("b")).toBe("Dell");
  });

  it("a non-zero self-executed command shows [Error] exit N in its OUT box", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("e", "(cd x ; git status)"));
    close(window);
    dispatch(window, completed("e", "Missing closing ')' in expression.", 1));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(true);
    expect(outRow.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
    expect(outRow.querySelector(".tool-cmd-output")!.textContent).toContain("Missing closing");
  });

  it("killed commands read [Cancelled] (muted, not an error); truncation is noted", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("k", "sleep 999"));
    close(window);
    dispatch(window, { ...out("sleep 999", "partial", null, true, true), agentSawCut: true });

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(false);
    const markers = [...outRow.querySelectorAll(".cmd-out-marker")];
    expect(markers[0].textContent).toBe("[Cancelled] no exit code");
    expect(markers[0].classList.contains("muted")).toBe(true);
    expect(markers[1].textContent).toBe("output truncated — grok saw the same cut");
  });

  it("an over-cap shell result still says the agent saw the same cut", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("t", "cat big"));
    close(window);
    dispatch(window, { ...out("cat big", "x".repeat(80), 0, true, false), agentSawCut: true });
    expect(doc.querySelector(".cmd-out-marker")!.textContent)
      .toBe("output truncated — grok saw the same cut");
  });

  it("an over-cap MCP result does not claim the agent saw the cut", () => {
    const { window, doc } = bootWebview();
    const mcpIn = JSON.stringify({ query: "titles" }, null, 2);
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "call-use-huge",
        title: "canva__search-designs",
        kind: "other",
        detailInput: mcpIn,
      },
    });
    close(window);
    dispatch(window, {
      type: "commandOutput",
      command: mcpIn,
      toolCallId: "call-use-huge",
      output: "x".repeat(80),
      exitCode: null,
      truncated: true,
      cancelled: false,
      agentSawCut: false,
    });
    const note = doc.querySelector(".cmd-out-marker")!.textContent ?? "";
    expect(note).toBe("output truncated — display only; the agent saw the full result");
    expect(note).not.toContain("grok saw the same cut");
  });

  it("a truncated commandOutput with no agentSawCut does not attribute the cut", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("t", "cat big"));
    close(window);
    dispatch(window, out("cat big", "partial", 0, true));
    expect(doc.querySelector(".cmd-out-marker")!.textContent).toBe("output truncated");
    expect(doc.querySelector(".cmd-out")!.textContent).not.toContain("grok saw");
    expect(doc.querySelector(".cmd-out")!.textContent).not.toContain("display only");
  });

  it("a cancelled live command still shows [Cancelled] after a buffer rebuild", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("k", "sleep 999"));
    close(window);
    dispatch(window, out("sleep 999", "partial", null, true, true));
    expect(doc.querySelector(".cmd-out-marker")!.textContent).toBe("[Cancelled] no exit code");

    // focusSession / rehydrateWebviewFromFocused: clear + historyReplay + the
    // live buffer, which still carries the host-asserted cancelled field.
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, exec("k", "sleep 999"));
    close(window);
    dispatch(window, out("sleep 999", "partial", null, true, true));
    dispatch(window, { type: "historyReplay", active: false });

    expect(doc.querySelectorAll(".has-details")).toHaveLength(1);
    const markers = [...doc.querySelectorAll(".cmd-out-marker")];
    expect(markers[0].textContent).toBe("[Cancelled] no exit code");
    expect(markers[0].classList.contains("muted")).toBe(true);
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("partial");
  });

  it("new-client / old-host: null exit with no cancellation field still shows [Cancelled]", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("k", "sleep 999"));
    close(window);
    dispatch(window, out("sleep 999", "partial", null));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(false);
    expect(outRow.querySelector(".cmd-out-marker")!.textContent).toBe("[Cancelled] no exit code");
    expect(outRow.querySelector(".cmd-out-marker")!.classList.contains("muted")).toBe(true);
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("partial");
  });

  it("null exit with cancelled: false is not reported, not a kill", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("c", "echo hi"));
    close(window);
    dispatch(window, out("echo hi", "hi\n", null, false, false));

    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("hi\n");
    expect(doc.querySelector(".cmd-out-marker")).toBeNull();
    expect(doc.querySelector(".cmd-out")!.classList.contains("failed")).toBe(false);
  });

  it("null exit with cancelled: false and no output does not synthesise success", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("c", "true"));
    close(window);
    dispatch(window, out("true", "", null, false, false));

    expect(doc.querySelector(".tool-cmd-output")).toBeNull();
    expect(doc.querySelector(".cmd-out-marker")).toBeNull();
  });

  it("an exit-0 command with no output shows a done marker, not an empty (no output) pre", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("q", "touch newfile"));
    close(window);
    dispatch(window, out("touch newfile", "", 0)); // success, nothing on stdout

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(false);
    const marker = outRow.querySelector(".cmd-out-marker") as HTMLElement;
    expect(marker.classList.contains("ok")).toBe(true);
    expect(marker.textContent).toContain("no output");
    expect(outRow.querySelector(".tool-cmd-output")).toBeNull(); // no empty <pre>
  });

  it("whitespace-only output is treated as empty (no lingering pre)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("w", "echo"));
    close(window);
    dispatch(window, out("echo", "\n  \n", 0));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.querySelector(".cmd-out-marker.ok")).not.toBeNull();
    expect(outRow.querySelector(".tool-cmd-output")).toBeNull();
  });

  it("a non-zero exit with no output shows only [Error], no (no output) filler", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("f", "false"));
    close(window);
    dispatch(window, out("false", "", 1));

    const outRow = doc.querySelector(".cmd-out") as HTMLElement;
    expect(outRow.classList.contains("failed")).toBe(true);
    expect(outRow.querySelector(".cmd-out-marker")!.textContent).toBe("[Error] exit 1");
    expect(outRow.querySelector(".tool-cmd-output")).toBeNull();
  });

  it("clicking inside the expanded block (text selection) does not collapse it", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("s", "git status"));
    close(window);
    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    click(window, flat);
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(false);

    click(window, details.querySelector(".tool-cmd")!);
    expect(details.hidden).toBe(false); // still open
  });

  it("row chevrons are independent of the group's state (present mid-run, per-row rotation)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "git status"));
    // Group still IN PROGRESS — expand it and inspect the rows.
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    click(window, group.querySelector(".tool-group-header")!);

    const rows = [...group.querySelectorAll(".tool-item.has-details")] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.querySelector(".tool-chevron"))).toBe(true); // chevrons exist mid-run
    expect(rows.every((r) => !r.classList.contains("expanded"))).toBe(true); // each starts ›

    click(window, rows[0]);
    expect(rows[0].classList.contains("expanded")).toBe(true); // v — this row only
    expect(rows[1].classList.contains("expanded")).toBe(false); // still ›
  });

  it("a lone RUNNING command is expandable immediately (no waiting for the batch to close)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("live", "npm run build"));
    // No close(): the batch is still in progress.
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    expect(group.classList.contains("cmd-single")).toBe(true);

    // One click on the header reveals the row AND its IN detail.
    click(window, group.querySelector(".tool-group-header")!);
    const details = group.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(false);
    expect(details.querySelector(".tool-cmd")!.textContent).toBe("npm run build");

    // A second tool joining the batch demotes it to normal group behavior.
    dispatch(window, exec("live2", "git status"));
    expect(group.classList.contains("cmd-single")).toBe(false);
  });

  it("search/list tools get no details block and no clickable-highlight class", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "r", kind: "search", rawInput: { pattern: "x", path: "/a.ts" } } });
    close(window);
    expect(doc.querySelector(".tool-item-details")).toBeNull();
    expect(doc.querySelector(".has-details")).toBeNull();
  });

  const readCall = (id: string, rawInput: Record<string, unknown>, title = "read_file") => ({
    type: "toolCall",
    call: { toolCallId: id, kind: "read", title, rawInput },
  });
  const readDone = (id: string, text: string, rawOutput?: unknown) => ({
    type: "toolCallUpdate",
    call: {
      toolCallId: id,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text } }],
      ...(rawOutput ? { rawOutput } : {}),
    },
  });

  it("a completed Read row IS its linked path and range — no excerpt (#122)", () => {
    const { window, doc, posted } = bootWebview();
    const body = Array.from({ length: 8 }, (_, i) => `${i + 1}\u2192line ${i + 1}`).join("\n");
    dispatch(window, readCall("r1", { target_file: "hello.txt" }));
    dispatch(window, readDone("r1", body, {
      type: "ReadFile",
      FileContent: { content: body, offset: null, raw_output: body, total_lines: 8 },
    }));
    close(window);

    const flat = doc.querySelector(".tool-flat") as HTMLElement;
    const label = flat.querySelector(".tool-label") as HTMLElement;
    expect(label.textContent).toBe("Read hello.txt");

    // The path + range is the control; there is nothing else to click, and no
    // six-line excerpt of the file under it.
    const link = label.querySelector(".tool-label-ref") as HTMLElement;
    expect(link.textContent).toBe("hello.txt");
    expect(flat.querySelector(".tool-item-details")).toBeNull();
    expect(doc.querySelector(".command-view-all")).toBeNull();
    expect(doc.querySelector(".tool-cmd-output")).toBeNull();

    click(window, link);
    // No `#L1-L8`: the agent read the whole file, so there is no range it
    // chose and nothing to select. Opening with the first 8 lines highlighted
    // would invent an emphasis the read never had.
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([
      { type: "openFile", path: "hello.txt" },
    ]);
  });

  it("the linked range opens the FILE at those lines, never a copy of them (#122)", () => {
    const { window, doc, posted } = bootWebview();
    const body = Array.from({ length: 30 }, (_, i) => `${i + 980}\u2192line ${i + 980}`).join("\n");
    dispatch(window, readCall("r1", { target_file: "src/deep.ts", offset: 980, limit: 30 }));
    dispatch(window, readDone("r1", body, {
      type: "ReadFile",
      FileContent: { content: body, offset: 980, limit: 30 },
    }));
    close(window);

    click(window, doc.querySelector(".tool-label-ref") as HTMLElement);
    // The excerpt is exactly the context you cannot see, so an untitled copy of
    // it is the one thing that does not help.
    expect(posted.filter((m: any) => m.type === "openText")).toEqual([]);
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([
      { type: "openFile", path: "src/deep.ts#L980-L1009" },
    ]);
  });

  it("a Read row with no line range on the wire links the file with no fragment (#122)", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, readCall("r2", { target_file: "notes.md" }));
    dispatch(window, readDone("r2", "a\nb\nc\nd\ne\nf\ng\nh", {
      type: "ReadFile",
      FileContent: { content: "a\nb\nc\nd\ne\nf\ng\nh" },
    }));
    close(window);

    const link = doc.querySelector(".tool-label-ref") as HTMLElement;
    expect(link.textContent).toBe("notes.md");
    click(window, link);
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([
      { type: "openFile", path: "notes.md" },
    ]);
  });

  it("a Claude-shaped Read row links too — file_path + offset/limit (#122)", () => {
    const { window, doc, posted } = bootWebview();
    // Claude names its tool "Read" and passes { file_path, offset, limit } —
    // neither the grok `target_file` key nor its `read_file` name.
    dispatch(window, readCall("cl1", { file_path: "src/host.ts", offset: 40, limit: 20 }, "Read"));
    dispatch(window, readDone("cl1", Array.from({ length: 20 }, (_, i) => `line ${i + 40}`).join("\n")));
    close(window);

    click(window, doc.querySelector(".tool-label-ref") as HTMLElement);
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([
      { type: "openFile", path: "src/host.ts#L40-L59" },
    ]);
  });

  it("a Read row identified only by kind links the file (#122)", () => {
    const { window, doc, posted } = bootWebview();
    // No recognisable tool name at all — only ACP's kind. This is the path any
    // provider takes when it names its read something we have never seen.
    dispatch(window, readCall("k1", { path: "docs/x.md" }, "Inspect"));
    dispatch(window, readDone("k1", Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n")));
    close(window);

    click(window, doc.querySelector(".tool-label-ref") as HTMLElement);
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([
      { type: "openFile", path: "docs/x.md" },
    ]);
  });

  it("a Read row with NO path stays plain text — the gate is the ref, not the kind (#122)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, readCall("np", {}, "read_file"));
    dispatch(window, readDone("np", Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")));
    close(window);

    // Nothing to link to, so nothing is linked. (Such a row carries no detail
    // either — that is pre-existing: without a path there is no IN to attach.)
    expect(doc.querySelector(".tool-label-ref")).toBeNull();
    expect((doc.querySelector(".tool-label") as HTMLElement).textContent).toBe("Read");
  });

  it("REMOTE shows the SAME row; the link reveals the text in place (#122)", () => {
    const { window, doc, posted } = bootWebview({ remote: true });
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    dispatch(window, readCall("rr", { target_file: "src/a.ts", offset: 1, limit: 12 }));
    dispatch(window, readDone("rr", body, {
      type: "ReadFile",
      FileContent: { content: body, offset: 1, limit: 12 },
    }));
    close(window);

    // Identical shape to the IDE — one line, path + range as the link.
    const link = doc.querySelector(".tool-label-ref") as HTMLElement;
    expect(link.textContent).toBe("a.ts lines 1-12");
    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details.classList.contains("tool-read-carrier")).toBe(true);
    expect(details.hidden).toBe(true); // costs no space until asked for

    // A phone cannot send openFile (host-local in remote-policy), so the link
    // reveals what is already on the wire instead — and toggles back.
    click(window, link);
    expect(details.hidden).toBe(false);
    expect(details.querySelector(".tool-cmd-output")!.textContent).toBe(body);
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([]);
    click(window, link);
    expect(details.hidden).toBe(true);
  });

  it("the DESKTOP app shows the SAME row; the link opens its preview window (#122)", async () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
      capabilities: { previewInApp: true },
    });
    const excerpt = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const whole = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    dispatch(window, readCall("dd", { target_file: "src/a.ts", offset: 1, limit: 12 }));
    dispatch(window, readDone("dd", excerpt, {
      type: "ReadFile",
      FileContent: { content: excerpt, offset: 1, limit: 12 },
    }));
    close(window);

    const link = doc.querySelector(".tool-label-ref") as HTMLElement;
    expect(link.textContent).toBe("a.ts lines 1-12");
    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(true);
    expect(doc.getElementById("preview-overlay")).toBeNull();

    // openTextFile cannot honour a line selection there, so the in-app preview
    // fetches the file and marks the agent's lines — never posts openFile.
    click(window, link);
    const req = posted.find((m: any) => m.type === "readProjectFile");
    expect(req).toMatchObject({ type: "readProjectFile", cwd: "/w", relPath: "src/a.ts" });
    dispatch(window, {
      type: "projectFileContent",
      requestId: (req as any).requestId,
      cwd: "/w",
      relPath: "src/a.ts",
      ok: true,
      kind: "text",
      text: whole,
    });
    await Promise.resolve();
    await Promise.resolve();
    const overlay = doc.getElementById("preview-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain("line 40");
    expect(overlay!.querySelectorAll(".tdl-read").length).toBe(12);
    expect(details.hidden).toBe(true); // the carrier stays out of the transcript
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([]);
    expect(posted.filter((m: any) => m.type === "openText")).toEqual([]);
  });

  it("a carrier is never an affordance — no chevron, no row toggle (#122)", () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, readCall("c1", { target_file: "src/a.ts", offset: 1, limit: 12 }));
    dispatch(window, readDone("c1", "one\ntwo\nthree"));
    close(window);

    const flat = doc.querySelector(".tool-flat") as HTMLElement;
    expect(flat.querySelector(".tool-chevron")).toBeNull();
    expect(flat.classList.contains("has-details")).toBe(false);
    const details = flat.querySelector(".tool-item-details") as HTMLElement;
    click(window, flat);
    expect(details.hidden).toBe(true); // only the link opens it
  });

  // A subagent's rows are painted by applyToolLabel too — the row IS the label —
  // and they never get a carrier, so off the editor a link there would be a
  // control that does nothing.
  const spawnSubagentReadingA = (window: Window) => {
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "spawn-1",
        title: "spawn_subagent",
        _meta: { "x.ai/tool": { name: "spawn_subagent" } },
        rawInput: { description: "Look around", subagent_type: "explore" },
      },
    });
    dispatch(window, {
      type: "subagentUpdate",
      update: { sessionUpdate: "subagent_spawned", subagent_id: "kid", child_session_id: "kid" },
    });
    dispatch(window, {
      type: "childStream",
      childSessionId: "kid",
      event: "toolCall",
      call: { toolCallId: "s1", kind: "read", title: "read_file",
              rawInput: { target_file: "src/a.ts", offset: 1, limit: 12 } },
    });
  };

  it("a SUBAGENT read row links on an editor — openFile needs no carrier (#122)", () => {
    const { window, doc, posted } = bootWebview();
    spawnSubagentReadingA(window);

    const row = doc.querySelector(".subagent-tool") as HTMLElement;
    expect(row).not.toBeNull(); // the sequence really built the row
    expect(row.textContent).toBe("Read a.ts lines 1-12");
    const link = row.querySelector(".tool-label-ref") as HTMLElement;
    expect(link).not.toBeNull();
    click(window, link);
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([
      { type: "openFile", path: "src/a.ts#L1-L12" },
    ]);
  });

  it("a SUBAGENT read row stays plain on a remote — a link there would be dead (#122)", () => {
    const { window, doc } = bootWebview({ remote: true });
    spawnSubagentReadingA(window);

    const row = doc.querySelector(".subagent-tool") as HTMLElement;
    expect(row).not.toBeNull(); // same sequence, so the absence below means something
    expect(row.textContent).toBe("Read a.ts lines 1-12");
    expect(row.querySelector(".tool-label-ref")).toBeNull();
  });

  it("a read batch expands WHILE it runs, not only when it finishes (#122)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
    });
    dispatch(window, readCall("g1", { target_file: "one.ts", offset: 1, limit: 150 }));
    dispatch(window, readCall("g2", { target_file: "two.ts", offset: 20, limit: 31 }));

    // Mid-run: no close() yet. This is the report — the details only appeared
    // once the command was done, because the group was settled at close time.
    const group = doc.querySelector(".tool-group") as HTMLElement;
    const groupBody = group.querySelector(".tool-group-body") as HTMLElement;
    expect(groupBody.hidden).toBe(false);
    expect(group.classList.contains("expanded")).toBe(true);

    const links = [...group.querySelectorAll(".tool-label-ref")].map((e) => e.textContent);
    expect(links).toEqual(["one.ts lines 1-150", "two.ts lines 20-50"]);
  });

  it("a user who collapses a running group is not overridden when rows arrive (#122)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
    });
    dispatch(window, readCall("u1", { target_file: "one.ts", offset: 1, limit: 10 }));
    const group = doc.querySelector(".tool-group") as HTMLElement;
    click(window, group.querySelector(".tool-group-header") as HTMLElement);
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);

    dispatch(window, readCall("u2", { target_file: "two.ts", offset: 1, limit: 10 }));
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);
  });

  it("View all on a COMMAND row still opens the captured text — there is no file to open (#122)", () => {
    const { window, doc, posted } = bootWebview();
    const command = "npm run build";
    const output = Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n");
    dispatch(window, exec("c1", command));
    dispatch(window, out(command, output));
    close(window);

    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    for (const btn of [...details.querySelectorAll(".command-view-all")] as HTMLButtonElement[]) {
      click(window, btn);
    }
    expect(posted.filter((m: any) => m.type === "openFile")).toEqual([]);
    expect(posted.filter((m: any) => m.type === "openText").length).toBeGreaterThan(0);
  });

  it("a Codex MCP tool_call without detailInput is not a command row — name shows, no IN/OUT", () => {
    const { window, doc } = bootWebview();
    const { update } = normalizeCodexUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "mcp-1",
      kind: "execute",
      title: "mcp.canva.search-designs",
      rawInput: { server: "canva", tool: "search-designs", arguments: { query: "logo" } },
      _meta: { is_mcp_tool_call: true },
    });
    dispatch(window, { type: "toolCall", call: update });
    close(window);
    expect(doc.querySelector(".tool-flat .tool-label")!.textContent).toBe("mcp.canva.search-designs");
    expect(doc.querySelector(".tool-item-details")).toBeNull();
    expect(doc.querySelector(".has-details")).toBeNull();
    expect(doc.querySelector(".cmd-block")).toBeNull();
  });

  it("the output poller and kill tools stay plain (no details, no highlight)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "p1", title: "Get task output: t1", rawInput: { variant: "TaskOutput", task_id: "t1", block: true } },
    });
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "p2", title: "kill_command_or_subagent", rawInput: { task_id: "t1" } },
    });
    close(window);
    expect(doc.querySelector(".has-details")).toBeNull();
    expect(doc.querySelector(".tool-item-details")).toBeNull();
  });
});

describe("MCP tool details (host-normalized detailInput + commandOutput)", () => {
  const mcpIn = JSON.stringify({ message: "MCPSHAPE_9931" }, null, 2);
  const mcpOut = (command: string, output: string) => ({
    type: "commandOutput" as const,
    command,
    output,
    exitCode: null,
    truncated: false,
    cancelled: false,
  });

  it("a decorated grok use_tool row shows IN immediately and OUT from commandOutput", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "call-use-1",
        title: "use_tool",
        kind: "other",
        rawInput: { tool_name: "everything__echo", tool_input: { message: "MCPSHAPE_9931" } },
        detailInput: mcpIn,
      },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "call-use-1", title: "everything__echo", detailInput: mcpIn },
    });
    close(window);
    dispatch(window, mcpOut(mcpIn, "Echo: MCPSHAPE_9931"));

    const flat = doc.querySelector(".tool-flat.has-details") as HTMLElement;
    expect(flat).not.toBeNull();
    expect(flat.querySelector(".tool-label")!.textContent).toBe("everything__echo");
    expect(flat.querySelector(".tool-cmd")!.textContent).toBe(mcpIn);
    expect(flat.querySelector(".tool-cmd-output")!.textContent).toBe("Echo: MCPSHAPE_9931");
  });

  it("a decorated Codex MCP row uses the same IN/OUT shell, not a Run <program> label", () => {
    const { window, doc } = bootWebview();
    const { update } = normalizeCodexUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "exec-mcp-1",
      kind: "execute",
      title: "mcp.everything.echo",
      rawInput: { server: "everything", tool: "echo", arguments: { message: "MCPSHAPE_9931" } },
      _meta: { is_mcp_tool_call: true },
    });
    dispatch(window, { type: "toolCall", call: { ...update, detailInput: mcpIn } });
    close(window);
    dispatch(window, mcpOut(mcpIn, "Echo: MCPSHAPE_9931"));

    expect(doc.querySelector(".tool-flat .tool-label")!.textContent).toBe("mcp.everything.echo");
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe(mcpIn);
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("Echo: MCPSHAPE_9931");
  });

  it("Claude pending MCP renders the title with no empty IN, then fills IN when args arrive", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "toolu_mcp_1",
        title: "mcp__everything__echo",
        kind: "other",
        rawInput: {},
        detailInput: null,
      },
    });
    expect(doc.querySelector(".tool-item-label")!.textContent).toBe("mcp__everything__echo");
    expect(doc.querySelector(".cmd-block")).toBeNull();
    expect(doc.querySelector(".cmd-in-body")).toBeNull();

    dispatch(window, {
      type: "toolCallUpdate",
      call: {
        toolCallId: "toolu_mcp_1",
        title: "mcp__everything__echo",
        rawInput: { message: "MCPSHAPE_9931" },
        detailInput: mcpIn,
      },
    });
    expect(doc.querySelector(".cmd-block")).not.toBeNull();
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe(mcpIn);
    expect(doc.querySelector(".cmd-out")).toBeNull();

    close(window);
    dispatch(window, mcpOut(mcpIn, "Echo: MCPSHAPE_9931"));
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("Echo: MCPSHAPE_9931");
  });

  it("grok.expandCommandOutputs pre-expands a decorated MCP row", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
    });
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "mcp-exp",
        title: "mcp__everything__echo",
        kind: "other",
        detailInput: mcpIn,
      },
    });
    close(window);
    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details.hidden).toBe(false);
    expect((doc.querySelector(".tool-flat") as HTMLElement).classList.contains("expanded")).toBe(true);
  });

  it("a zero-argument MCP row keeps IN {} and OUT joined by toolCallId", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "exec-mcp-empty",
        title: "mcp.everything.list_folders",
        kind: "other",
        rawInput: { server: "everything", tool: "list_folders", arguments: {} },
        detailInput: "{}",
      },
    });
    close(window);
    dispatch(window, {
      type: "commandOutput",
      command: "{}",
      toolCallId: "exec-mcp-empty",
      output: "[]",
      exitCode: null,
      truncated: false,
      cancelled: false,
    });
    expect(doc.querySelector(".tool-flat .tool-label")!.textContent).toBe("mcp.everything.list_folders");
    expect(doc.querySelector(".tool-cmd")!.textContent).toBe("{}");
    expect(doc.querySelector(".tool-cmd-output")!.textContent).toBe("[]");
    expect(doc.querySelector(".tool-flat")!.textContent).not.toMatch(/Run /);
  });

  it("two same-argument MCP rows completing out of order keep their own OUT", () => {
    const { window, doc } = bootWebview();
    for (const id of ["exec-mcp-a", "exec-mcp-b"]) {
      dispatch(window, {
        type: "toolCall",
        call: {
          toolCallId: id,
          title: id === "exec-mcp-a" ? "mcp.everything.echo-a" : "mcp.everything.echo-b",
          kind: "other",
          detailInput: mcpIn,
        },
      });
    }
    close(window);
    dispatch(window, {
      type: "commandOutput",
      command: mcpIn,
      toolCallId: "exec-mcp-b",
      output: "out-b",
      exitCode: null,
      truncated: false,
      cancelled: false,
    });
    dispatch(window, {
      type: "commandOutput",
      command: mcpIn,
      toolCallId: "exec-mcp-a",
      output: "out-a",
      exitCode: null,
      truncated: false,
      cancelled: false,
    });
    const rows = [...doc.querySelectorAll(".tool-item")] as HTMLElement[];
    expect(rows).toHaveLength(2);
    const rowA = rows.find((row) => row.textContent?.includes("echo-a"));
    const rowB = rows.find((row) => row.textContent?.includes("echo-b"));
    expect(rowA?.querySelector(".tool-cmd-output")!.textContent).toBe("out-a");
    expect(rowB?.querySelector(".tool-cmd-output")!.textContent).toBe("out-b");
  });

  it("does not invent IN from a null detailInput or from Claude content alone", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "toolCall",
      call: {
        toolCallId: "toolu_empty",
        title: "mcp__everything__echo",
        kind: "other",
        rawInput: {},
        detailInput: null,
        content: [{ type: "content", content: { type: "text", text: "Echo: MCPSHAPE_9931" } }],
      },
    });
    close(window);
    expect(doc.querySelector(".cmd-block")).toBeNull();
    expect(doc.querySelector(".tool-cmd-output")).toBeNull();
  });
});

// #41 (1.5.10): with the audit toggle on, a command-bearing tool GROUP opens
// itself so a "Ran N commands ›" batch needs zero extra clicks. Explore/edit-only
// groups (no command detail) stay collapsed.
describe("group auto-expand under grok.expandCommandOutputs", () => {
  const bootExpanded = () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
    });
    return h;
  };

  it("a finished command-bearing group paints open; an explore-only group stays collapsed", () => {
    const { window, doc } = bootExpanded();

    // Batch 1: a command + a read → kept as a group, has a command detail row.
    dispatch(window, exec("c1", "git status"));
    dispatch(window, explore("r1", "src/a.ts"));
    close(window);

    // Batch 2: two searches → kept as a group, NO command detail.
    dispatch(window, explore("r2", "src/b.ts"));
    dispatch(window, explore("r3", "src/c.ts"));
    close(window);

    const groups = [...doc.querySelectorAll(".tool-group")] as HTMLElement[];
    expect(groups).toHaveLength(2);
    const cmdGroup = groups.find((g) => g.querySelector(".has-details"))!;
    const readGroup = groups.find((g) => !g.querySelector(".has-details"))!;

    expect((cmdGroup.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(false);
    expect(cmdGroup.classList.contains("expanded")).toBe(true);
    expect((readGroup.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);
    expect(readGroup.classList.contains("expanded")).toBe(false);
  });

  it("toggling the setting live expands/collapses existing command-bearing groups only", () => {
    const { window, doc } = bootWebview(); // setting OFF by default
    dispatch(window, { type: "appPurpose", value: "coding" });

    dispatch(window, exec("c1", "git status"));
    dispatch(window, explore("r1", "src/a.ts"));
    close(window);
    dispatch(window, explore("r2", "src/b.ts"));
    dispatch(window, explore("r3", "src/c.ts"));
    close(window);

    const groups = [...doc.querySelectorAll(".tool-group")] as HTMLElement[];
    const cmdBody = groups.find((g) => g.querySelector(".has-details"))!.querySelector(".tool-group-body") as HTMLElement;
    const readBody = groups.find((g) => !g.querySelector(".has-details"))!.querySelector(".tool-group-body") as HTMLElement;
    expect(cmdBody.hidden).toBe(true); // both collapsed while OFF

    dispatch(window, { type: "expandCommandOutputs", value: true });
    expect(cmdBody.hidden).toBe(false); // command group opened
    expect(readBody.hidden).toBe(true); // explore-only untouched

    dispatch(window, { type: "expandCommandOutputs", value: false });
    expect(cmdBody.hidden).toBe(true); // collapses back
  });
});

// 1.5.10: Command Palette "Grok: Expand/Collapse All Tool Details (This Session)"
// — a per-session, in-memory LATCH. It opens/closes EVERY group (even
// explore-only) and every command box, and keeps applying to content that
// streams in afterward, until the opposite command or a gear-setting change
// (last action wins). It never persists to the host.
const bodies = (doc: Document) => [...doc.querySelectorAll(".tool-group-body")] as HTMLElement[];
const details = (doc: Document) => [...doc.querySelectorAll(".tool-item-details")] as HTMLElement[];

describe("setAllToolDetails (expand/collapse all latch)", () => {
  it("opens every group and command box, then collapses them all", () => {
    const { window, doc } = bootWebview();

    dispatch(window, exec("c1", "git status"));
    dispatch(window, explore("r1", "src/a.ts"));
    close(window);
    dispatch(window, explore("r2", "src/b.ts"));
    dispatch(window, explore("r3", "src/c.ts"));
    close(window);
    dispatch(window, exec("solo", "npm test")); // lone command → flat row with details
    close(window);

    expect(bodies(doc).every((b) => b.hidden)).toBe(true); // all collapsed initially

    dispatch(window, { type: "setAllToolDetails", open: true });
    expect(bodies(doc).every((b) => !b.hidden)).toBe(true); // every group open (incl. explore-only)
    expect(details(doc).every((d) => !d.hidden)).toBe(true); // every IN/OUT box open

    dispatch(window, { type: "setAllToolDetails", open: false });
    expect(bodies(doc).every((b) => b.hidden)).toBe(true);
    expect(details(doc).every((d) => d.hidden)).toBe(true);
  });

  it("opens a group that is STILL EXECUTING (the reported gap)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, exec("a", "npm test"));
    dispatch(window, exec("b", "git status")); // 2 tools, no close → group in-progress
    const group = doc.querySelector(".tool-group.in-progress") as HTMLElement;
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(true);

    dispatch(window, { type: "setAllToolDetails", open: true });
    expect((group.querySelector(".tool-group-body") as HTMLElement).hidden).toBe(false);
    expect(group.classList.contains("expanded")).toBe(true); // chevron shown via CSS while running
  });

  it("keeps applying to tool calls that arrive AFTER the command (the second reported gap)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "setAllToolDetails", open: true }); // latch on, transcript empty

    // A group + a lone command that appear later both render open.
    dispatch(window, exec("c1", "git status"));
    dispatch(window, explore("r1", "src/a.ts"));
    close(window);
    dispatch(window, exec("solo", "npm test"));
    close(window);
    expect(bodies(doc).every((b) => !b.hidden)).toBe(true);
    expect(details(doc).every((d) => !d.hidden)).toBe(true);

    // Flip to collapse-all; subsequent content renders collapsed.
    dispatch(window, { type: "setAllToolDetails", open: false });
    dispatch(window, explore("r2", "src/b.ts"));
    dispatch(window, explore("r3", "src/c.ts"));
    close(window);
    expect(bodies(doc).every((b) => b.hidden)).toBe(true);
    expect(details(doc).every((d) => d.hidden)).toBe(true);
  });

  it("last action wins: flipping the gear setting clears the latch", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "appPurpose", value: "coding" });
    dispatch(window, exec("c1", "git status"));
    dispatch(window, explore("r1", "src/a.ts"));
    close(window);
    dispatch(window, explore("r2", "src/b.ts")); // explore-only group
    dispatch(window, explore("r3", "src/c.ts"));
    close(window);

    dispatch(window, { type: "setAllToolDetails", open: false }); // force-collapse everything
    const cmdBody = bodies(doc).find((b) => b.closest(".tool-group")!.querySelector(".has-details"))!;
    const readBody = bodies(doc).find((b) => !b.closest(".tool-group")!.querySelector(".has-details"))!;
    expect(cmdBody.hidden).toBe(true);

    // Turning the setting ON clears the latch → command group opens, explore-only stays closed.
    dispatch(window, { type: "expandCommandOutputs", value: true });
    expect(cmdBody.hidden).toBe(false); // setting now governs (command-bearing only)
    expect(readBody.hidden).toBe(true);
  });

  it("collapse-all overrides the persisted setting (setting on, then collapse)", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true, appPurpose: "coding",
    });
    dispatch(window, exec("c1", "git status"));
    dispatch(window, explore("r1", "src/a.ts"));
    close(window); // command group auto-opens under the setting
    const cmdBody = bodies(doc)[0];
    expect(cmdBody.hidden).toBe(false);

    dispatch(window, { type: "setAllToolDetails", open: false }); // latch beats the setting
    expect(cmdBody.hidden).toBe(true);
  });

  it("does not persist — no setExpandCommandOutputs round-trips to the host", () => {
    const { window, posted } = bootWebview();
    dispatch(window, exec("solo", "git status"));
    close(window);
    dispatch(window, { type: "setAllToolDetails", open: true });
    expect(posted.filter((m: any) => m.type === "setExpandCommandOutputs")).toHaveLength(0);
  });

  it("resets on a session swap (clearMessages) — new content follows the gear default again", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "setAllToolDetails", open: true }); // latch on
    dispatch(window, { type: "clearMessages" }); // focus-swap / new session

    dispatch(window, explore("r1", "src/a.ts"));
    dispatch(window, explore("r2", "src/b.ts"));
    close(window);
    // Explore-only group, latch cleared, setting off → collapsed.
    expect(bodies(doc)[0].hidden).toBe(true);
  });
});
