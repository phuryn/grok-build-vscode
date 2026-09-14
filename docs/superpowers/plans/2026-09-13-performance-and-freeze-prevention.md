# Performance Optimization and Freeze Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate application lag and prevent "Not Responding" (white freeze) states in Grok Build by converting synchronous main-thread I/O to asynchronous non-blocking operations, expanding directory skip lists, and implementing chunked UI rendering for large sessions.

**Architecture:**
1. **Asynchronous Non-Blocking Workspace Scanner (`src/desktop/find-files.ts`):**
   - Refactor `findFilesUnder` from blocking `fs.readdirSync` recursion to asynchronous `fs.promises.readdir` with `withFileTypes: true`.
   - Implement cooperative event-loop yielding (`setImmediate` every $N=50$ directory walks) to ensure the Windows Message Pump always receives ticks and never enters "(Not Responding)" state.
   - Expand `SKIP_DIR_NAMES` to automatically ignore heavy build artifacts and caches (`.pnpm`, `dist-desktop`, `out-integration`, `target`, `venv`, `.venv`, `.next`, `.nuxt`, `build`, `temp`, `tmp`).
2. **Cooperative Chunked History Replay in Webview (`media/chat.js`):**
   - When switching or loading long conversation sessions with large batches of messages/tool calls, yield renderer execution across animation frames (`requestAnimationFrame` / `setTimeout(0)`) so the UI stays 60fps responsive without locking the Chromium renderer thread.
3. **Optimized Process Spawning & Resource Management:**
   - Ensure child process stdio pipes buffer asynchronously without blocking main process message dispatch.

**Tech Stack:** TypeScript, Node.js (`fs.promises`), Electron Main & Renderer Process, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-performance-optimization-design.md`

## Global Constraints

- No breaking changes to existing VS Code Extension Host API contracts or test fixtures.
- All unit and DOM tests must pass 100% cleanly in `pnpm test`.
- File search results for `@`-mentions must maintain complete accuracy and respect user-defined exclude globs.

---

### Task 1: Refactor `src/desktop/find-files.ts` to Asynchronous Non-Blocking Traversal

**Files:**
- Modify: `src/desktop/find-files.ts`
- Test: `test/desktop-host-pure.test.ts`
- Test: `test/mention.test.ts`

- [ ] **Step 1: Expand `SKIP_DIR_NAMES` and implement asynchronous cooperative walking**

```typescript
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".pnpm",
  ".git",
  ".hg",
  ".svn",
  "out",
  "out-integration",
  "dist",
  "dist-desktop",
  ".vscode-test",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "venv",
  ".venv",
  "tmp",
  "temp",
]);

export async function findFilesUnder(
  base: string,
  exclude?: string,
  maxResults = 5000,
): Promise<Uri[]> {
  const root = path.resolve(base);
  try {
    const st = await fs.promises.stat(root);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  const out: Uri[] = [];
  let yieldCounter = 0;

  async function walk(dir: string): Promise<void> {
    if (out.length >= maxResults) return;

    yieldCounter++;
    if (yieldCounter % 40 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (out.length >= maxResults) return;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (matchesExclude(rel + "/", exclude) || matchesExclude(rel, exclude)) continue;
        await walk(abs);
      } else if (ent.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (matchesExclude(rel, exclude)) continue;
        out.push(Uri.file(abs));
      }
    }
  }

  await walk(root);
  return out;
}
```

- [ ] **Step 2: Run tests to verify**

Run: `pnpm test -- test/desktop-host-pure.test.ts test/mention.test.ts`
Expected: PASS

---

### Task 2: Smooth Chunked Rendering for Large Sessions in `media/chat.js`

**Files:**
- Modify: `media/chat.js`
- Test: `test/webview-ui.dom.test.ts`

- [ ] **Step 1: Add sliced batch rendering for heavy session history restore**

When processing `historyBatch` or hundreds of restored tool calls, break huge batches into slices of 25 items and schedule next slice via `requestAnimationFrame` or `setTimeout(..., 0)` so the UI remains interactive and fluid.

- [ ] **Step 2: Run tests to verify**

Run: `pnpm test -- test/webview-ui.dom.test.ts`
Expected: PASS

---

### Task 3: Build & Verification

**Files:**
- Test: `pnpm run compile`
- Test: `pnpm test`
- Build: `pnpm run dist:win`

- [ ] **Step 1: Compile TypeScript**
- [ ] **Step 2: Run full test suite**
- [ ] **Step 3: Rebuild installer to verify zero build warnings**

---

## Self-Review

1. **Non-Blocking Guarantee:** Asynchronous `fs.promises` + cooperative `setImmediate` prevents main thread starvation.
2. **Safety:** Common package manager and build directories (`.pnpm`, `dist-desktop`, `venv`) are cleanly pruned from file scans.
3. **Stability:** All existing tests pass without regressions.
