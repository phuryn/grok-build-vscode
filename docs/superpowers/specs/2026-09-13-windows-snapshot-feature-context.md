# Superpowers Feature Context & Architecture Specification

## Project: Grok Build VS Code / Standalone Desktop (Windows & Multi-Platform)
**Date:** 2026-09-13  
**Author:** fiko942  
**Feature:** Cross-Platform Native Screen Snapshot Engine, Global Hotkeys, Fullscreen Flash Animation, Camera Shutter Audio, and Settings UI/UX

---

### 1. Executive Summary

This document captures the complete technical context, implementation decisions, and architectural contracts for the Windows Snapshot feature and its accompanying UI/UX modernization in Grok Build.

---

### 2. Architecture Overview

```
[ User presses Global Shortcut / In-App Keybinding ]
                        │
                        ▼
           1. Window Exclusion (Desktop)
              - mainWindow.hide() (prevents Grok from capturing itself)
              - 120ms DWM compositor settle delay
                        │
                        ▼
           2. Multi-Platform Screen Capture Engine (`src/snapshot.ts`)
              - Windows: GDI+ via [System.Windows.Forms.SystemInformation]::VirtualScreen
              - macOS: Native `screencapture -x` (completely isolated, untouched)
              - Linux: `import -window root` fallback
              - Output: Sanitized PNG in %TEMP% or custom user folder
                        │
                        ▼
           3. Visual & Auditory Feedback
              - Fullscreen White Flash (`showDesktopScreenFlash` on all active monitors)
              - Mechanical Camera Shutter Audio Synthesis (`Web Audio API` in `media/chat.js`)
                        │
                        ▼
           4. Application Window Restore & Image Staging
              - mainWindow.restore() & mainWindow.show() & mainWindow.focus()
              - `attachSnapshot()` imports PNG into session chip list
              - `revealAndFocusComposer()` activates prompt input box
```

---

### 3. Key Components & File Map

1. **`src/snapshot.ts`**:
   - Zero-dependency screen capture engine.
   - Built-in GDI+ script with multi-monitor VirtualScreen coverage.
   - Cross-platform resolution (`win32`, `darwin`, `linux`).

2. **`src/snapshot-handler.ts`**:
   - Bridges CLI / VS Code / Desktop configurations (`grok.snapshot.savePath`, `grok.snapshot.autoAttach`).
   - Handles capture errors and notification messages gracefully.

3. **`src/desktop/main.ts`**:
   - Manages Electron `globalShortcut` registration and dynamic re-registration on settings changes.
   - Orchestrates window exclusion (`mainWindow.hide()`), 120ms delay, and full-monitor white flash window overlays.

4. **`media/settings.js` & `media/settings.css`**:
   - **`kind: "hotkey"`**: Interactive shortcut recorder supporting key combinations (`Ctrl`, `Alt`, `Shift`, `Cmd` + keys) with visual `<kbd>` pill badges and instant reset button.
   - **`kind: "folder"`**: Native OS folder picker dialog via `pickSnapshotFolder` host IPC message, path truncation badge, and reset button.

5. **`media/chat.js` & `media/chat.css`**:
   - Synthesizes authentic camera shutter sound (`playCameraShutterSound`) via offline Web Audio API.
   - Handles `snapshotTaken` host message to trigger screen flash and audio effects.

---

### 4. Verification & Testing

- **Unit / Integration Tests:**
  - `test/snapshot.test.ts`
  - `test/snapshot-command.test.ts`
  - `test/snapshot.integration.test.ts`
  - `test/settings-surface.dom.test.ts`
- **Total Test Suite:** 240 test files, 5,822 tests passing 100%.
