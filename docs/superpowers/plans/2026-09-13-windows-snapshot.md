# Windows Snapshot Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a native Windows screen snapshot capture feature with customizable keyboard shortcuts in Grok Build, automatically attaching the captured screenshot as an image chip in the chat composer while keeping macOS implementation completely untouched and isolated.

**Architecture:** Create an OS-isolated capture module (`src/snapshot.ts`) that dispatches to platform-specific capture engines based on `process.platform`. For Windows (`win32`), use a zero-dependency PowerShell GDI+/`System.Drawing` capture script that saves to a temporary PNG file. The command is registered in VS Code's extension host and tied to a default keybinding (`ctrl+alt+s` on Windows/Linux, `cmd+alt+s` on macOS) that feeds the captured image directly into the composer's image chip pipeline.

**Tech Stack:** TypeScript, Node.js (`child_process`), PowerShell / .NET `System.Drawing`, VS Code Extension API (`vscode.commands`, `vscode.workspace`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-windows-snapshot-design.md`

## Global Constraints

- Never mutate or alter existing macOS snapshot / screencapture code paths (`process.platform === 'darwin'`).
- Zero external binary dependencies on Windows — use built-in Windows PowerShell (`powershell.exe` / `pwsh.exe`) and .NET Framework `System.Drawing`/`System.Windows.Forms`.
- Keybindings must be configurable via standard VS Code Keybindings and respect platform `when` clauses.
- Captured files must be sanitized, saved in the designated OS temp directory or `.grok/snapshots/`, and attached as vision image chips without breaking the chat state.
- All tests must pass in binary-free CI without requiring an active GUI/desktop station.

---

### Task 1: Windows & Multi-Platform Snapshot Engine

**Files:**
- Create: `src/snapshot.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `process.platform`, Node `child_process.spawn` / `execFile`, `fs/promises`.
- Produces: `captureScreen(options?: SnapshotOptions): Promise<SnapshotResult>`, `buildWindowsCaptureScript(targetPath: string): string`.

- [ ] **Step 1: Write the failing unit tests for `src/snapshot.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildWindowsCaptureScript, resolveCaptureCommand, SnapshotOptions } from "../src/snapshot";

describe("snapshot module", () => {
  it("generates correct PowerShell script for Windows screen capture", () => {
    const targetPath = "C:\\temp\\snap.png";
    const script = buildWindowsCaptureScript(targetPath);
    expect(script).toContain("System.Drawing");
    expect(script).toContain("CopyFromScreen");
    expect(script).toContain("snap.png");
  });

  it("resolves correct capture command per platform", () => {
    const winCmd = resolveCaptureCommand("win32", "C:\\temp\\out.png");
    expect(winCmd.command).toMatch(/powershell/i);
    expect(winCmd.args).toContain("-Command");

    const macCmd = resolveCaptureCommand("darwin", "/tmp/out.png");
    expect(macCmd.command).toBe("screencapture");
    expect(macCmd.args).toContain("/tmp/out.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/snapshot.test.ts`
Expected: FAIL with module not found or functions undefined.

- [ ] **Step 3: Implement `src/snapshot.ts`**

```typescript
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

export function buildWindowsCaptureScript(targetPath: string): string {
  const escapedPath = targetPath.replace(/'/g, "''");
  return `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
$screens = [System.Windows.Forms.Screen]::AllScreens;
$top = ($screens | Measure-Object -Property Bounds.Top -Minimum).Minimum;
$left = ($screens | Measure-Object -Property Bounds.Left -Minimum).Minimum;
$right = ($screens | Measure-Object -Property Bounds.Right -Maximum).Maximum;
$bottom = ($screens | Measure-Object -Property Bounds.Bottom -Maximum).Maximum;
$bounds = [System.Drawing.Rectangle]::FromLTRB($left, $top, $right, $bottom);
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bmp);
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
$bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose();
$bmp.Dispose();
`.trim().replace(/\r?\n/g, " ");
}

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/snapshot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts test/snapshot.test.ts
git commit -m "feat(snapshot): add cross-platform screen snapshot engine with native Windows support"
```

---

### Task 2: VS Code Command Registration and Keybinding

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Modify: `src/sidebar.ts`
- Test: `test/snapshot-command.test.ts`

**Interfaces:**
- Consumes: `captureScreen` from `src/snapshot.ts`, `GrokSidebarProvider.attachImageFromPath` or composer chip attachment.
- Produces: VS Code command `grok.takeSnapshot` and keyboard shortcuts (`ctrl+alt+s` / `cmd+alt+s`).

- [ ] **Step 1: Write tests for command registration and chip attachment**

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleTakeSnapshotCommand } from "../src/snapshot-handler";

describe("snapshot command handler", () => {
  it("calls captureScreen and passes file path to sidebar attachment", async () => {
    const mockCapture = vi.fn().mockResolvedValue({ success: true, filePath: "C:\\temp\\snap.png" });
    const mockAttach = vi.fn().mockResolvedValue(undefined);
    const mockShowInfo = vi.fn();
    const mockShowError = vi.fn();

    await handleTakeSnapshotCommand({
      captureScreen: mockCapture,
      attachImage: mockAttach,
      showInformationMessage: mockShowInfo,
      showErrorMessage: mockShowError,
    });

    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockAttach).toHaveBeenCalledWith("C:\\temp\\snap.png");
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it("handles capture error gracefully", async () => {
    const mockCapture = vi.fn().mockResolvedValue({ success: false, error: "Access denied" });
    const mockAttach = vi.fn();
    const mockShowError = vi.fn();

    await handleTakeSnapshotCommand({
      captureScreen: mockCapture,
      attachImage: mockAttach,
      showInformationMessage: vi.fn(),
      showErrorMessage: mockShowError,
    });

    expect(mockAttach).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining("Access denied"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/snapshot-command.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/snapshot-handler.ts`, wire into `package.json` and `src/extension.ts`**

1. Create `src/snapshot-handler.ts`:
```typescript
import * as vscode from "vscode";
import { captureScreen, SnapshotResult } from "./snapshot";

export interface SnapshotHandlerDependencies {
  captureScreen: () => Promise<SnapshotResult>;
  attachImage: (filePath: string) => Promise<void>;
  showInformationMessage: (msg: string) => void;
  showErrorMessage: (msg: string) => void;
}

export async function handleTakeSnapshotCommand(deps?: Partial<SnapshotHandlerDependencies>, sidebar?: any): Promise<void> {
  const capture = deps?.captureScreen ?? captureScreen;
  const attach = deps?.attachImage ?? (async (filePath: string) => {
    if (sidebar) {
      await sidebar.attachImageFilePath(filePath);
    }
  });
  const showError = deps?.showErrorMessage ?? vscode.window.showErrorMessage;

  const result = await capture();
  if (result.success && result.filePath) {
    await attach(result.filePath);
  } else {
    showError(`Grok Snapshot failed: ${result.error ?? "Unknown error"}`);
  }
}
```

2. Add contribution to `package.json`:
- Under `contributes.commands`:
```json
{
  "command": "grok.takeSnapshot",
  "title": "Grok: Take Snapshot"
}
```
- Under `contributes.keybindings`:
```json
{
  "command": "grok.takeSnapshot",
  "key": "ctrl+alt+s",
  "mac": "cmd+alt+s",
  "when": "editorTextFocus || grok.chatViewVisible || grok.composerFocus"
}
```

3. Register in `src/extension.ts`:
```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("grok.takeSnapshot", () => handleTakeSnapshotCommand(undefined, sidebarProvider))
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/snapshot-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json src/snapshot-handler.ts src/extension.ts test/snapshot-command.test.ts
git commit -m "feat(commands): register grok.takeSnapshot command with custom Windows/Mac keybindings"
```

---

### Task 3: Integration and End-to-End Verification

**Files:**
- Test: `test/snapshot.integration.test.ts`
- Modify: `README.md` (documenting the new snapshot feature and keybinding)

- [ ] **Step 1: Write integration tests verifying non-interactive fallback and platform isolation**

```typescript
import { describe, it, expect } from "vitest";
import { resolveCaptureCommand } from "../src/snapshot";

describe("platform isolation", () => {
  it("preserves exact macOS screencapture syntax", () => {
    const mac = resolveCaptureCommand("darwin", "/tmp/mac.png");
    expect(mac.command).toBe("screencapture");
    expect(mac.args).toEqual(["-x", "/tmp/mac.png"]);
  });

  it("produces headless-safe Windows command", () => {
    const win = resolveCaptureCommand("win32", "C:\\out.png");
    expect(win.command).toBe("powershell.exe");
    expect(win.args).toContain("-NoProfile");
    expect(win.args).toContain("-NonInteractive");
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All 4,860+ tests passing, including all new snapshot tests.

- [ ] **Step 3: Update documentation in `README.md`**

Add `grok.takeSnapshot` (`Ctrl+Alt+S` / `Cmd+Alt+S`) to Commands and Keybindings table.

- [ ] **Step 4: Commit**

```bash
git add README.md test/snapshot.integration.test.ts
git commit -m "docs: document grok.takeSnapshot and verify platform isolation"
```

---

## Self-Review

1. **Spec coverage:** 
   - Windows native support implemented via PowerShell GDI+ without external binaries: Covered in Task 1.
   - macOS code paths remain isolated and untouched: Covered in Task 1 & Task 3.
   - Custom keybinding/shortcut added: Covered in Task 2.
2. **Placeholder scan:** No "TBD", "TODO", or vague descriptions. All code and command samples are complete and concrete.
3. **Type consistency:** Interfaces `SnapshotOptions`, `SnapshotResult`, `CaptureCommand`, and `handleTakeSnapshotCommand` are consistent across all tasks.
