# macOS Isolation and Windows-Specific Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the custom Snapshot settings rows (`snapshotShortcut`, `snapshotAutoAttach`, `snapshotSavePath`) are exclusively scoped to Windows systems, hiding them completely on macOS to preserve macOS's clean, untouched default experience, while verifying full functionality, running tests, and updating the Pull Request to upstream.

**Architecture:**
1. In `media/chat.js` and `src/sidebar.ts`:
   - Expose `isWindows` and `isMac` platform flags in `settingsEnv()`.
2. In `media/settings.js`:
   - Add `visible: (s, env) => !env || env.isWindows !== false` guard to `snapshotShortcut`, `snapshotAutoAttach`, and `snapshotSavePath`.
   - Update `defaultEnv()` to default `isWindows: true, isMac: false`.
3. In `test/settings-surface.dom.test.ts`:
   - Add assertions verifying that under macOS environments (`{ isWindows: false, isMac: true }`), the snapshot rows are cleanly omitted from the visible General rows.
   - Verify that under Windows environments (`{ isWindows: true }`), all snapshot rows are properly rendered.
4. Update GitHub branch and Pull Request #161 on upstream.

**Tech Stack:** JavaScript, TypeScript, Vitest, Git / GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-13-macos-isolation-spec.md`

## Global Constraints

- macOS implementation must remain 100% untouched and isolated.
- Windows-specific settings must not leak into macOS settings screens.
- All 240 test files (5,820+ tests) must pass cleanly in `pnpm test`.

---

### Task 1: Add Platform Gating in `media/settings.js` & `media/chat.js`

**Files:**
- Modify: `media/chat.js`
- Modify: `media/settings.js`
- Modify: `test/settings-surface.dom.test.ts`

- [ ] **Step 1: Update `media/chat.js` `settingsEnv` with `isWindows` and `isMac`**
- [ ] **Step 2: Add `visible: (s, env) => !env || env.isWindows !== false` to snapshot rows in `media/settings.js`**
- [ ] **Step 3: Update `test/settings-surface.dom.test.ts` to test platform isolation**
- [ ] **Step 4: Run test suite**

```bash
pnpm test -- test/settings-surface.dom.test.ts
```

---

### Task 2: Compile, Test, and Push to GitHub

**Files:**
- Test: `pnpm run compile`
- Test: `pnpm test`
- Remote: `git push origin feat/windows-snapshot-and-pnpm-migration` & `git push origin main`
- Remote: Update PR description on upstream #161 via `gh pr edit`

---

## Self-Review

1. **Isolation:** macOS environment hides Windows snapshot settings cleanly.
2. **Type Safety:** All test suites and compile steps pass.
