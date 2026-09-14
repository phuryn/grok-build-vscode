import { describe, it, expect } from "vitest";
import { buildWindowsCaptureScript, resolveCaptureCommand } from "../src/snapshot";

describe("snapshot engine", () => {
  it("generates correct PowerShell script for Windows screen capture", () => {
    const targetPath = "C:\\temp\\snap.png";
    const script = buildWindowsCaptureScript(targetPath);
    expect(script).toContain("System.Drawing");
    expect(script).toContain("CopyFromScreen");
    expect(script).toContain("snap.png");
    expect(script).toContain("System.Windows.Forms");
  });

  it("escapes single quotes in Windows target paths", () => {
    const targetPath = "C:\\temp's dir\\snap.png";
    const script = buildWindowsCaptureScript(targetPath);
    expect(script).toContain("C:\\temp''s dir\\snap.png");
  });

  it("resolves correct capture command for Windows", () => {
    const winCmd = resolveCaptureCommand("win32", "C:\\temp\\out.png");
    expect(winCmd.command).toBe("powershell.exe");
    expect(winCmd.args).toContain("-NoProfile");
    expect(winCmd.args).toContain("-NonInteractive");
    expect(winCmd.args).toContain("-Command");
  });

  it("resolves correct capture command for macOS", () => {
    const macCmd = resolveCaptureCommand("darwin", "/tmp/out.png");
    expect(macCmd.command).toBe("screencapture");
    expect(macCmd.args).toEqual(["-x", "/tmp/out.png"]);
  });

  it("resolves fallback capture command for Linux", () => {
    const linuxCmd = resolveCaptureCommand("linux", "/tmp/out.png");
    expect(linuxCmd.command).toBe("import");
    expect(linuxCmd.args).toEqual(["-window", "root", "/tmp/out.png"]);
  });
});
