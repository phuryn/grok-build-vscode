# Smooth Session Switching & Non-Blocking Suffix Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the `(Not Responding)` freeze and provide a smooth, fluid visual loading experience during session transitions by chunking `applyHistoryWindow` message dispatch across animation frames and displaying a dedicated non-intrusive loading skeleton/shimmer.

**Architecture:**
1. **Cooperative Chunked History Dispatch in `media/chat.js` (`applyHistoryWindow`):**
   - Instead of processing all `split.suffix` messages in one monolithic blocking loop, process them in chunks of 6–10 messages per frame via `requestAnimationFrame` / `setTimeout(0)`.
   - Keep `state.replaying = true` and `setConversationLoading(true)` active during chunk processing so the UI remains fluid, responsive, and free of layout thrashing.
   - On completion of the last chunk, transition `state.replaying = false`, call `syncHistoryHead()`, dismiss the loading state, and settle scroll.
2. **Dedicated Transcript Loading Spinner / Shimmer in `media/chat.css`:**
   - Add `.transcript-loading-veil` styling that renders an elegant pulse/shimmer over the conversation container when switching sessions, providing clear visual feedback that content is loading without looking like a frozen app.
3. **Throttled Host Buffer Replay in `src/sidebar.ts` (`focusSession`):**
   - In `focusSession()`, avoid dumping entire session buffers synchronously; send structured `historyBatch` messages so IPC transmission doesn't flood Electron's channel.

**Tech Stack:** JavaScript (DOM, `requestAnimationFrame`, `setTimeout`), CSS (Keyframe animations), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-smooth-session-loading-spec.md`

## Global Constraints

- Do not alter existing session message formats or serialization contracts.
- Automated tests in `test/webview-ui.dom.test.ts` (which mock timers or expect immediate synchronous DOM in unit harnesses) must be supported via a flush-all fallback when testing or when `requestAnimationFrame` is not present.
- All 240 test files (5,820+ tests) must pass cleanly in `pnpm test`.

---

### Task 1: Implement Sliced/Chunked `applyHistoryWindow` in `media/chat.js` with Headless Fallback

**Files:**
- Modify: `media/chat.js`
- Test: `test/webview-ui.dom.test.ts`

- [ ] **Step 1: Refactor `applyHistoryWindow` to use chunked scheduling**

```javascript
function applyHistoryWindow(held, onComplete) {
  const split = splitHistoryWindow(held, historyWindowTurns());
  state.historyPrefix = split.prefix;
  state.historyPrefixUserCount = split.prefixUserCount;
  if (split.prefixUserCount > 0) {
    const counters = countHistoryReplayCounters(split.prefix);
    state.userMsgCount = counters.userMsgCount;
    state.interjectionCount = counters.interjectionCount;
    state.historyEventCount = counters.historyEventCount;
    const plans = state.planHistoryQueue || [];
    state.historyPrefixPlans = plans.filter((p) =>
      typeof p.afterUserMessage === "number" && p.afterUserMessage <= split.prefixUserCount);
    state.planHistoryQueue = plans.filter((p) =>
      typeof p.afterUserMessage !== "number" || p.afterUserMessage > split.prefixUserCount);
    const perms = state.permissionHistoryQueue || [];
    state.historyPrefixPermissions = perms.filter((p) =>
      typeof p.afterUserMessage === "number" && p.afterUserMessage <= split.prefixUserCount);
    state.permissionHistoryQueue = perms.filter((p) =>
      typeof p.afterUserMessage !== "number" || p.afterUserMessage > split.prefixUserCount);
    recordPrefixExport(split.prefix);
  }

  const suffix = split.suffix || [];
  if (!suffix.length) {
    syncHistoryHead();
    if (typeof onComplete === "function") onComplete();
    return;
  }

  // Sliced dispatch: process in chunks of 8 messages so the Chromium event loop
  // and Windows Message Pump continuously breathe, preventing "(Not Responding)" freezes.
  const CHUNK_SIZE = 8;
  let index = 0;

  function processNextChunk() {
    const end = Math.min(index + CHUNK_SIZE, suffix.length);
    for (; index < end; index++) {
      handleHostMessage(suffix[index]);
    }
    if (index < suffix.length) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => processNextChunk());
      } else {
        setTimeout(processNextChunk, 0);
      }
    } else {
      syncHistoryHead();
      if (typeof onComplete === "function") onComplete();
    }
  }

  processNextChunk();
}
```

- [ ] **Step 2: Update callers and `historyReplay: false` handler in `media/chat.js`**
- [ ] **Step 3: Run DOM tests to verify zero regressions**

Run: `pnpm test -- test/webview-ui.dom.test.ts`
Expected: PASS

---

### Task 2: Add Smooth Loading Indicator Overlay in `media/chat.css` and `media/chat.js`

**Files:**
- Modify: `media/chat.css`
- Modify: `media/chat.js`
- Test: `test/webview-ui.dom.test.ts`

- [ ] **Step 1: Add `.transcript-loading-veil` styling in `media/chat.css`**
- [ ] **Step 2: Connect veil visibility to session switching lifecycle in `media/chat.js`**
- [ ] **Step 3: Run tests to verify**

Run: `pnpm test -- test/webview-ui.dom.test.ts`
Expected: PASS

---

### Task 3: Package to `win-unpacked`, Test Suite Verification & Git Push

**Files:**
- Test: `pnpm run compile`
- Test: `pnpm test`
- Build: `pnpm run dist:dir`

- [ ] **Step 1: Compile TypeScript**
- [ ] **Step 2: Run all tests**
- [ ] **Step 3: Package to `dist-desktop/win-unpacked`**
- [ ] **Step 4: Commit and push to GitHub `fiko942`**

---

## Self-Review

1. **Root Cause:** Slices heavy Markdown/TeX parsing into non-blocking chunks, ensuring the Windows Message Pump never starves.
2. **Visual Feedback:** Shows a clean, polished loading spinner during the quick slice rendering.
3. **No Regressions:** Fallbacks maintain synchronous test compatibility.
