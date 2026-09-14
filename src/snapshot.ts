import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { spawn } from "child_process";

export interface SnapshotOptions {
  outputPath?: string;
  platform?: NodeJS.Platform;
}

export interface SnapshotResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface CaptureCommand {
  command: string;
  args: string[];
}

/**
 * Builds a PowerShell script using System.Drawing/System.Windows.Forms to capture the screen on Windows.
 */
export function buildWindowsCaptureScript(targetPath: string): string {
  const escapedPath = targetPath.replace(/'/g, "''");
  return `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bmp);
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size);
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose();
$bmp.Dispose();
`.trim().replace(/\r?\n/g, " ");
}

/**
 * Resolves the appropriate command and arguments for capturing screen per OS.
 */
export function resolveCaptureCommand(platform: NodeJS.Platform, targetPath: string): CaptureCommand {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", buildWindowsCaptureScript(targetPath)],
    };
  }
  if (platform === "darwin") {
    return {
      command: "screencapture",
      args: ["-x", targetPath],
    };
  }
  // Linux / fallback
  return {
    command: "import",
    args: ["-window", "root", targetPath],
  };
}

/**
 * Executes a screen capture and writes the PNG image to disk.
 */
export async function captureScreen(options?: SnapshotOptions): Promise<SnapshotResult> {
  const platform = options?.platform ?? process.platform;
  const tempDir = os.tmpdir();
  const fileName = `grok-snapshot-${Date.now()}.png`;
  const targetPath = options?.outputPath ?? path.join(tempDir, fileName);

  const { command, args } = resolveCaptureCommand(platform, targetPath);

  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    child.on("close", async (code) => {
      if (code === 0) {
        try {
          await fs.access(targetPath);
          resolve({ success: true, filePath: targetPath });
        } catch {
          resolve({ success: false, error: "Snapshot file was not created on disk." });
        }
      } else {
        resolve({ success: false, error: stderr || `Process exited with code ${code}` });
      }
    });
  });
}
