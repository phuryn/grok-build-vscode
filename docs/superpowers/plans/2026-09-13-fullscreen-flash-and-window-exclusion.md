# Fullscreen Flash and Grok Window Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Grok Build window is temporarily hidden and excluded from screen captures, and display the white shutter flash animation across the entire physical monitor screen(s) rather than merely inside the Electron app container.

**Architecture:**
1. **Window Exclusion during Capture:**
   - In `src/desktop/main.ts` (and `src/snapshot-handler.ts`), when snapshot is triggered:
     - Check if `mainWindow` is visible; if so, call `mainWindow.hide()`.
     - Introduce a brief 100ms DWM compositor settle delay.
     - Execute `captureScreen()` so only the underlying desktop and user apps are captured (Grok window is 100% excluded).
2. **Full-Monitor White Flash Animation (`showDesktopScreenFlash`):**
   - Use Electron's `screen.getAllDisplays()` to spawn a temporary full-screen, click-through, frameless, transparent overlay window on each active display.
   - The overlay renders a pure white flash that smoothly fades out (`opacity: 0.85` $\rightarrow$ `0` in 260ms) and destroys itself after 300ms.
3. **Restore, Audio, and Prompt Focus:**
   - Play the camera shutter sound.
   - Call `mainWindow.show()`, `mainWindow.restore()`, and `mainWindow.focus()`.
   - Attach the captured PNG as an image chip in the chat composer and focus the prompt box.

**Tech Stack:** Electron (`BrowserWindow`, `screen`, `globalShortcut`), Web Audio API, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-fullscreen-flash-design.md`

## Global Constraints

- Full-screen flash overlays must be strictly click-through (`setIgnoreMouseEvents(true)`) and non-focusable (`focusable: false`) so they never steal user clicks or interrupt active apps.
- Grok window hiding and restoring must be guarded against destroyed window instances.
- Zero external binary or file asset dependencies.

---

### Task 1: Implement Full-Monitor Screen Flash Overlay in `src/desktop/main.ts`

**Files:**
- Modify: `src/desktop/main.ts`

**Interfaces:**
- Produces: `showDesktopScreenFlash(): void` in Electron main process.

- [ ] **Step 1: Implement `showDesktopScreenFlash` function**

```typescript
function showDesktopScreenFlash(): void {
  try {
    const displays = screen.getAllDisplays();
    for (const display of displays) {
      const { x, y, width, height } = display.bounds;
      const flashWin = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        focusable: false,
        hasShadow: false,
        backgroundColor: "#00000000",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      flashWin.setIgnoreMouseEvents(true);
      flashWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            html, body {
              margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
              background: rgba(255, 255, 255, 0.85);
              animation: flash 260ms cubic-bezier(0.1, 0.9, 0.2, 1) forwards;
            }
            @keyframes flash {
              0% { opacity: 0.85; }
              100% { opacity: 0; }
            }
          </style>
        </head>
        <body></body>
        </html>
      `)}`);
      setTimeout(() => {
        if (!flashWin.isDestroyed()) {
          flashWin.close();
          flashWin.destroy();
        }
      }, 300);
    }
  } catch (e) {
    /* best-effort visual flash */
  }
}
```

---

### Task 2: Hide Grok Window during Capture and Orchestrate the Capture-Flash-Attach Sequence

**Files:**
- Modify: `src/desktop/main.ts`
- Modify: `src/snapshot-handler.ts`

- [ ] **Step 1: Update global shortcut trigger sequence in `src/desktop/main.ts`**

```typescript
const ok = globalShortcut.register(accelerator, async () => {
  log(`[snapshot] global shortcut triggered: ${accelerator}`);
  try {
    // 1. Hide Grok window so it is not in the screenshot
    const wasVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
    if (wasVisible && mainWindow) {
      mainWindow.hide();
    }

    // Settle delay for OS compositor
    await new Promise((r) => setTimeout(r, 100));

    // 2. Capture clean screen
    await handleTakeSnapshotCommand(undefined, sidebar || undefined);

    // 3. Show full monitor white flash across displays
    showDesktopScreenFlash();

    // 4. Restore and focus Grok window
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (e) {
    log(`[snapshot] capture failed: ${(e as Error).message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
});
```

---

### Task 3: Verification & Full Test Suite

**Files:**
- Test: `pnpm run compile`
- Test: `pnpm test -- test/snapshot.test.ts test/snapshot-command.test.ts test/desktop-host-pure.test.ts`

- [ ] **Step 1: Compile TypeScript**
- [ ] **Step 2: Run all unit & DOM tests**
- [ ] **Step 3: Verify clean git status**

---

## Self-Review

1. **Grok Window Exclusion:** `mainWindow.hide()` runs before `captureScreen()`, with 100ms DWM settle delay.
2. **Whole-Screen Flash:** Frameless transparent window covers the entire virtual screen / all displays.
3. **No Breaking Changes:** Existing tests and macOS code remain untouched.
