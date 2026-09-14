# Snapshot Settings UI/UX Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the raw text input fields for Snapshot settings into an intuitive, polished UI/UX experience featuring an interactive Keyboard Shortcut Recorder (with key pill badges) and a Native Folder Browser with path status display and Reset buttons.

**Architecture:** 
1. Introduce custom interactive control renderers in `media/settings.js`:
   - `kind: "hotkey"`: Renders recorded shortcuts as sleek visual `<kbd>` pill badges (e.g. `[Ctrl] + [Alt] + [S]`), with a one-click "Record Shortcut" mode that captures pressed key combinations (`keydown`) with live visual feedback, validation for 2–3 key combos, and clear/reset actions.
   - `kind: "folder"`: Displays current folder path with folder icon, an ellipsis-truncated monospace badge, a "Browse..." button that triggers native directory picker (`showOpenDialog`), and a "Reset to Default" button when custom path is set.
2. Add a `pickSnapshotFolder` host handler in `src/sidebar.ts` that invokes `host.showOpenDialog({ canSelectFolders: true, canSelectFiles: false })` and broadcasts the selected folder path back to the webview.
3. Enhance `media/settings.css` with dedicated styles for hotkey badges, recording pulse animations, and folder picker button groups.

**Tech Stack:** JavaScript / DOM, CSS (VS Code theme token variables), TypeScript, Electron / VS Code Extension API (`showOpenDialog`), Vitest / Happy-DOM.

**Spec:** `docs/superpowers/specs/2026-09-13-snapshot-settings-ui-ux-design.md`

## Global Constraints

- Retain full theme compatibility using VS Code CSS variables (`--vscode-button-*`, `--vscode-badge-*`, `--vscode-keybindingLabel-*`).
- Do not break existing serialization or config format (`grok.snapshot.shortcut`, `grok.snapshot.savePath`, `grok.snapshot.autoAttach`).
- Keep keyboard navigation accessible: Escape cancels recording without modifying previous shortcut; Tab/Shift+Tab navigation behaves naturally.
- All DOM and pure unit tests must pass cleanly in `pnpm test`.

---

### Task 1: Add Dedicated Styling for Hotkey Recorder and Folder Picker in `media/settings.css`

**Files:**
- Modify: `media/settings.css`

**Interfaces:**
- Produces CSS classes: `.settings-hotkey-wrap`, `.settings-hotkey-badges`, `.settings-hotkey-kbd`, `.settings-hotkey-recording`, `.settings-folder-wrap`, `.settings-folder-path`, `.settings-folder-actions`.

- [ ] **Step 1: Add CSS rules in `media/settings.css`**

```css
/* Hotkey Recorder */
.settings-hotkey-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.settings-hotkey-badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 2px 6px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #3c3c3c));
  border-radius: 4px;
}

.settings-hotkey-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  font-family: var(--vscode-font-family);
  font-size: 11px;
  font-weight: 600;
  line-height: 14px;
  color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground));
  background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.15));
  border: 1px solid var(--vscode-keybindingLabel-border, rgba(128, 128, 128, 0.3));
  border-bottom: 2px solid var(--vscode-keybindingLabel-bottomBorder, rgba(128, 128, 128, 0.4));
  border-radius: 3px;
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.2);
}

.settings-hotkey-plus {
  font-size: 11px;
  opacity: 0.6;
  user-select: none;
}

.settings-hotkey-recording {
  border-color: var(--vscode-focusBorder, #007acc) !important;
  background: color-mix(in srgb, var(--vscode-focusBorder, #007acc) 15%, transparent) !important;
  animation: pulse-border 1.5s infinite ease-in-out;
}

@keyframes pulse-border {
  0%, 100% { outline: 1px solid transparent; }
  50% { outline: 2px solid var(--vscode-focusBorder, #007acc); }
}

/* Folder Picker */
.settings-folder-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}

.settings-folder-display {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--vscode-input-background, rgba(0, 0, 0, 0.2));
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #3c3c3c));
  border-radius: 4px;
  font-size: 12px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-folder-display.is-empty {
  opacity: 0.65;
  font-style: italic;
}
```

- [ ] **Step 2: Commit CSS additions**

```bash
git add media/settings.css
git commit -m "style(settings): add custom styles for hotkey recorder and folder picker"
```

---

### Task 2: Implement Interactive Hotkey Recorder and Folder Picker in `media/settings.js`

**Files:**
- Modify: `media/settings.js`
- Test: `test/settings-surface.dom.test.ts`

**Interfaces:**
- Consumes: Keydown events, `applySettingsChange`, `post` / `vscode.postMessage`.
- Produces: Visual hotkey recorder and folder browser row renderers for `kind: "hotkey"` and `kind: "folder"`.

- [ ] **Step 1: Update `ROWS` in `media/settings.js`**

Change `snapshotShortcut` to `kind: "hotkey"` and `snapshotSavePath` to `kind: "folder"`.

- [ ] **Step 2: Add render handlers in `renderRow` in `media/settings.js`**

1. Hotkey recorder handler:
   - Formats shortcut string (e.g. `"Ctrl+Alt+S"`) into individual `<span class="settings-hotkey-kbd">` tags separated by `+`.
   - "Record shortcut" button (`.settings-action`) that enters recording state.
   - When recording: intercepts `keydown`, captures modifier keys (`Ctrl`, `Alt`, `Shift`, `Meta`) + target key (letter, number, F1-F12), formats the result string, dispatches `setSnapshotShortcut`, and exits recording.
   - Escape exits recording without saving.
   - "Reset" button when shortcut differs from default.

2. Folder picker handler:
   - Displays icon + path or *"Default (%TEMP%)"*.
   - "Browse..." button that posts `{ type: "pickSnapshotFolder" }`.
   - "Reset" button that clears path to default (`{ type: "setSnapshotSavePath", value: "" }`).

- [ ] **Step 3: Update `test/settings-surface.dom.test.ts`**

Update assertions to check for `kind: "hotkey"` and `kind: "folder"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/settings-surface.dom.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add media/settings.js test/settings-surface.dom.test.ts
git commit -m "feat(settings): add interactive hotkey recorder and folder browser controls"
```

---

### Task 3: Handle `pickSnapshotFolder` Host Message in `src/sidebar.ts` & Protocol

**Files:**
- Modify: `src/protocol.ts`
- Modify: `media/webview-helpers.js`
- Modify: `src/desktop/webview-msg-validate.ts`
- Modify: `src/remote-policy.ts`
- Modify: `src/sidebar.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `{ type: "pickSnapshotFolder" }` from webview.
- Produces: Opens native OS folder dialog (`host.showOpenDialog({ canSelectFolders: true, canSelectFiles: false })`), saves selected path to config `"grok.snapshot.savePath"`, and updates webview state.

- [ ] **Step 1: Add `pickSnapshotFolder` to `WebviewMsg` in `src/protocol.ts`**

```typescript
  | { type: "pickSnapshotFolder" }
```

- [ ] **Step 2: Add handler in `src/sidebar.ts`**

```typescript
      case "pickSnapshotFolder": {
        const picked = await this.host.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Select Snapshot Folder",
        });
        if (picked && picked.length && picked[0]) {
          const folderPath = picked[0];
          await this.host.getConfiguration("grok")
            .update("snapshot.savePath", folderPath, "global");
        }
        break;
      }
```

- [ ] **Step 3: Run full tests and compilation**

Run: `pnpm run compile && pnpm test -- test/snapshot test/settings-surface.dom.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/protocol.ts media/webview-helpers.js src/desktop/webview-msg-validate.ts src/remote-policy.ts src/sidebar.ts
git commit -m "feat(host): handle pickSnapshotFolder message to open native folder dialog"
```

---

## Self-Review

1. **Spec Coverage:**
   - Interactive 2-3 key shortcut recorder with visual badges: Covered in Task 1 & Task 2.
   - Native folder picker with "Browse..." and "Reset" buttons: Covered in Task 2 & Task 3.
   - Styling fits seamlessly with dark/light themes: Covered in Task 1.
2. **Placeholder Scan:** No placeholders or vague TODOs.
3. **Type Consistency:** Message types and handler contracts match across `protocol.ts`, `settings.js`, and `sidebar.ts`.
