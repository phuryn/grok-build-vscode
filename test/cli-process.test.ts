import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grokCliNeedsShell } from "../src/cli-process";

describe("grok CLI process invocation", () => {
  it("uses a shell only for Windows command shims", () => {
    expect(grokCliNeedsShell("C:\\Users\\me\\.grok\\bin\\grok.cmd", "win32")).toBe(true);
    expect(grokCliNeedsShell("C:\\Tools\\grok.BAT", "win32")).toBe(true);
    expect(grokCliNeedsShell("C:\\Users\\me\\.grok\\bin\\grok.exe", "win32")).toBe(false);
    expect(grokCliNeedsShell("/usr/local/bin/grok.cmd", "linux")).toBe(false);
  });

  it("keeps every one-shot sidebar invocation on the shared wrapper", () => {
    const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    expect(sidebar).not.toMatch(/\bexecFile(?:Async)?\s*\(/);
    expect(sidebar.match(/execGrokCli\s*\(/g)).toHaveLength(10);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["mcp", "list", "--json"\]/);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["mcp", action, name\]/);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["--version"\],[\s\S]*parseCodexVersionOutput/);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["--version"\],[\s\S]*parseClaudeVersionOutput/);
  });

  it("shares the same shim predicate with the ACP spawn path", () => {
    const acp = readFileSync(new URL("../src/acp.ts", import.meta.url), "utf8");
    expect(acp).toContain("grokCliNeedsShell(this.opts.cliPath)");
  });
});
