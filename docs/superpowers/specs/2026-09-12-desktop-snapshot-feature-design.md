# macOS Desktop Snapshot Screen Capture Design Specification

## Overview
A macOS-exclusive global desktop snapshot and screen capture system for Grok Build Desktop, enabling instant screen captures attached directly as context into the prompt composer.

## Requirements & Specifications

### 1. Global Shortcut Listening
- **Dual Command (`⌘ Left + ⌘ Right`):**
  - Native Swift binary (`resources/macos-dual-cmd-listener`) running Cocoa `NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged)`.
  - Captures Left Command (keyCode `55`) and Right Command (keyCode `54`) transitions simultaneously.
  - Rate-limited to one trigger every `1.2s`.
  - Requires macOS Accessibility permission (`AXIsProcessTrusted`).
- **Standard Shortcuts:**
  - Registered via Electron `globalShortcut` API.
  - Supports `CommandOrControl+Shift+S`, `CommandOrControl+Alt+S`, `CommandOrControl+Shift+4`.

### 2. Full-Screen Native Flash Overlay
- A dedicated temporary `BrowserWindow` spanning the active display's `bounds`.
- Attributes: `frame: false`, `transparent: true`, `alwaysOnTop: true`, `hasShadow: false`, `focusable: false`.
- Injects a full-screen white div with a 0.25s fade-out animation before auto-destroying.

### 3. Screen Capture & Window Opacity
- Finds display matching `screen.getCursorScreenPoint()`.
- If Grok Desktop is visible & focused, `mainWindow.setOpacity(0)` is applied, followed by a 40ms delay, capturing via `desktopCapturer.getSources`, and immediately restoring opacity to `1`.

### 4. Composer Attachment & Security Policy
- The screenshot is written to a temporary PNG in `app.getPath("temp")`.
- Main process registers the file into the webview's security context: `handle = webview.fileSelection.register(tempPath)`.
- IPC triggers `host-to-webview` event `{ type: "snapshotCompleted", imagePath, handle }`.
- Webview plays audio shutter sound and attaches via `dropFile` message with `handle`.

### 5. Packaging & Distribution
- The native listener must reside outside the `.asar` archive at runtime.
- `electron-builder.yml` configured with `asarUnpack: ["resources/macos-dual-cmd-listener"]`.
- `main.ts` resolves path from `app.asar.unpacked`.
