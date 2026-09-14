import { describe, it, expect } from "vitest";
import { resolveCaptureCommand } from "../src/snapshot";

describe("snapshot platform isolation integration", () => {
  it("preserves exact macOS screencapture command and arguments without modification", () => {
    const macCmd = resolveCaptureCommand("darwin", "/tmp/screen.png");
    expect(macCmd.command).toBe("screencapture");
    expect(macCmd.args).toEqual(["-x", "/tmp/screen.png"]);
  });

  it("produces Windows command with complete GDI+ screen capture script", () => {
    const winCmd = resolveCaptureCommand("win32", "C:\\snapshots\\screen.png");
    expect(winCmd.command).toBe("powershell.exe");
    expect(winCmd.args).toContain("-NoProfile");
    expect(winCmd.args).toContain("-NonInteractive");
    expect(winCmd.args).toContain("-Command");
    const script = winCmd.args[winCmd.args.indexOf("-Command") + 1];
    expect(script).toContain("[System.Windows.Forms.SystemInformation]::VirtualScreen");
    expect(script).toContain("[System.Drawing.Graphics]::FromImage");
    expect(script).toContain("CopyFromScreen");
  });
});
