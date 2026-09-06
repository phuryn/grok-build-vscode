import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGrokCli, grokCliNeedsShell } from "../src/cli-process";

describe("grok CLI process invocation", () => {
  it("closes updater input so a headless command can finish on EOF", async () => {
    const result = await execGrokCli(process.execPath, ["-e",
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("EOF"));',
    ], { closeStdin: true, windowsHide: true, timeout: 5000 });
    expect(result.stdout).toBe("EOF");
  });

  it("uses exit status even when stdout looks successful", async () => {
    await expect(execGrokCli(process.execPath, ["-e",
      'process.stdout.write("Successfully updated"); process.exitCode = 7;',
    ], { closeStdin: true, windowsHide: true, timeout: 5000 })).rejects.toMatchObject({ code: 7 });
    await expect(execGrokCli(process.execPath, ["-e",
      'process.stdout.write(JSON.stringify({error:"this is just output"}));',
    ], { closeStdin: true, windowsHide: true, timeout: 5000 })).resolves.toMatchObject({ stdout: '{"error":"this is just output"}' });
  });

  it("uses a shell only for Windows command shims", () => {
    expect(grokCliNeedsShell("C:\\Users\\me\\.grok\\bin\\grok.cmd", "win32")).toBe(true);
    expect(grokCliNeedsShell("C:\\Tools\\grok.BAT", "win32")).toBe(true);
    expect(grokCliNeedsShell("C:\\Users\\me\\.grok\\bin\\grok.exe", "win32")).toBe(false);
    expect(grokCliNeedsShell("/usr/local/bin/grok.cmd", "linux")).toBe(false);
  });

  it("keeps every one-shot sidebar invocation on the shared wrapper", () => {
    const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    expect(sidebar).not.toMatch(/\bexecFile(?:Async)?\s*\(/);
    expect(sidebar).not.toMatch(/execGrokCli\([^\n]*\["mcp"/);
    expect(sidebar).toContain('client.listMcpServers()');
    // Pinned so a NEW one-shot invocation has to be noticed rather than slipped
    // in. The tenth is the shared headless Codex/Claude updater.
    expect(sidebar.match(/execGrokCli\s*\(/g)).toHaveLength(10);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["--version"\],[\s\S]*parseCodexVersionOutput/);
    expect(sidebar).toMatch(/execGrokCli\(cliPath, \["--version"\],[\s\S]*parseClaudeVersionOutput/);
  });

  it("shares the same shim predicate with the ACP spawn path", () => {
    const acp = readFileSync(new URL("../src/acp.ts", import.meta.url), "utf8");
    expect(acp).toContain("grokCliNeedsShell(this.opts.cliPath)");
  });
});
