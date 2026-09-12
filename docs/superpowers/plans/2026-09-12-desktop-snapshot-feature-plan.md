# macOS Desktop Snapshot Screen Capture Implementation Plan

> **Goal:** Provide an effortless, native desktop snapshot workflow in Grok Build Desktop for macOS, capturing the active screen behind the window with a full-screen flash and attaching it to the composer.

**Architecture:**
- **Native Shortcut Hook (macOS):** Standalone Swift executable (`resources/macos-dual-cmd-listener`) using Cocoa `NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged)` and `addLocalMonitorForEvents` to detect simultaneous Left Command + Right Command (`⌘ Left + ⌘ Right`) without keyboard polling overhead or kernel-level drops. Packaged with `asarUnpack` to allow direct process execution from `app.asar.unpacked`.
- **Alternative Shortcuts:** Electron `globalShortcut.register` for `⌘ + Shift + S`, `⌘ + Option + S`, `⌘ + Shift + 4`.
- **Active Monitor & Behind Window Capture:** Detects the active screen from `screen.getCursorScreenPoint()`. If the app window is focused, momentarily drops opacity to `0` before capturing via `desktopCapturer.getSources({ types: ["screen"] })`.
- **Full-Screen Desktop Flash:** A native frameless, transparent, `alwaysOnTop` Electron `BrowserWindow` over the active monitor bounds that executes a brief CSS opacity pulse (flash effect) and closes.
- **Audio & Visual Feedback:** Web Audio API mechanical camera shutter sound, plus fluid flying image chip animation to the prompt composer.
- **Security & File Minting:** Secure host-side file handle minting via `webview.fileSelection.register(tempPath)` for `dropFile` compliance.
- **Settings & Persistence:** Registered `grok.snapshotShortcut` in `CONFIG_DEFAULTS`, `package.json`, and Settings UI with direct deep-links to macOS Screen Recording and Accessibility preferences.

---

### Key Components & Files
- `resources/macos-dual-cmd.swift` / `resources/macos-dual-cmd-listener`: Native Cocoa `NSEvent` global modifier hook.
- `electron-builder.yml`: `asarUnpack: ["resources/macos-dual-cmd-listener"]`.
- `src/desktop/main.ts`: Snapshot coordination, screen flash window, active monitor detection, daemon lifecycle, and file handle registration.
- `src/desktop/config-store.ts`: `CONFIG_DEFAULTS` definition for `grok.snapshotShortcut`.
- `media/chat.js` & `media/chat.css`: Shutter sound synthesis, fly-in chip animation, and attachment dispatch.
- `media/settings.js` & `package.json`: Settings UI dropdown and macOS privacy shortcut buttons.
