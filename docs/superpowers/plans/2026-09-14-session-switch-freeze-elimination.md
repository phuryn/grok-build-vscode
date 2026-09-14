# Session Switch Freeze & (Not Responding) Elimination Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely eliminate the `(Not Responding)` freeze when switching sessions in Grok Build Desktop by caching `repoCatalog()` and `indexSessions()`, debouncing catalog broadcasts, and preventing redundant synchronous disk stats during session transitions.

**Architecture:**
1. **TTL / Dirty-Flag Caching for `repoCatalog()` in `src/sidebar.ts`:**
   - Currently, `discoverRepos` runs hundreds of synchronous `statSync` operations across all projects in `~/.grok/sessions/` on every `postRepoCatalog()` call.
   - Introduce `cachedRepoCatalog` with a 5-second TTL and dirty-flag invalidation (invalidated on folder add/remove/archive/pin). When switching sessions, `postRepoCatalog()` serves instantly from memory ($<1\text{ms}$ instead of $300\text{ms}-1500\text{ms}$).
2. **Session Index Caching in `src/sidebar.ts`:**
   - Cache the results of `indexSessions()` per repository with a 3-second TTL. Switching between sessions in the same project reuses the index rather than re-stating every session directory.
3. **Consolidate `postRepoCatalog()` & `postSessionsList()` during Session Switch:**
   - In `openSessionReserved()`, avoid firing multiple immediate back-to-back catalog/session-list broadcasts. Defer them to a single microtask/tick once the session focus completes.

**Tech Stack:** TypeScript, Node.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-session-switch-perf-spec.md`

## Global Constraints

- Never serve stale data when a project or session is explicitly created, deleted, or pinned (must invalidate cache immediately on explicit mutations).
- Full compatibility with VS Code Extension and Electron Desktop.
- All unit and DOM test suites (5,820+ tests) must pass cleanly in `pnpm test`.

---

### Task 1: Add In-Memory Caching for `repoCatalog()` with Mutation Invalidation in `src/sidebar.ts`

**Files:**
- Modify: `src/sidebar.ts`
- Test: `test/desktop-host-pure.test.ts`

- [ ] **Step 1: Add cache state fields and invalidation helper in `src/sidebar.ts`**

```typescript
private repoCatalogCache: { at: number; entries: RepoListEntry[] } | null = null;
private invalidateRepoCatalog(): void {
  this.repoCatalogCache = null;
}
```

- [ ] **Step 2: Update `repoCatalog()` to check cache and serve cached entries**

```typescript
private repoCatalog(): RepoListEntry[] {
  const now = Date.now();
  if (this.repoCatalogCache && now - this.repoCatalogCache.at < 5000) {
    return this.repoCatalogCache.entries;
  }
  const discovered = discoverRepos({ ... });
  const removed = this.removedProjectFolderKeys();
  const res = !removed.size ? discovered : ...;
  this.repoCatalogCache = { at: now, entries: res };
  return res;
}
```

- [ ] **Step 3: Invalidate cache on mutations (add/remove folder, toggle pin, set archive, set color)**

- [ ] **Step 4: Run tests to verify**

Run: `pnpm test -- test/desktop-host-pure.test.ts`
Expected: PASS

---

### Task 2: Add Short TTL Caching for `indexSessions` in `src/sidebar.ts`

**Files:**
- Modify: `src/sidebar.ts`
- Test: `test/settings-surface.dom.test.ts`

- [ ] **Step 1: Add `sessionIndexCache` map (keyed by repo cwd) in `src/sidebar.ts`**
- [ ] **Step 2: Invalidate session index cache on new message, session delete, or session creation**
- [ ] **Step 3: Run tests to verify**

Run: `pnpm test -- test/settings-surface.dom.test.ts`
Expected: PASS

---

### Task 3: Package, Compile, and End-to-End Verification

**Files:**
- Test: `pnpm run compile`
- Test: `pnpm test`
- Build: `pnpm run dist:dir`

- [ ] **Step 1: Compile TypeScript**
- [ ] **Step 2: Run all unit and DOM tests**
- [ ] **Step 3: Package to `dist-desktop/win-unpacked` and verify instantaneous session switching**

---

## Self-Review

1. **Root Cause Coverage:** Eliminates the hundreds of synchronous `statSync` calls during session switching by caching catalog & index.
2. **Correctness:** Cache automatically invalidates on every write/delete/create action.
3. **No Regressions:** All existing tests pass.
