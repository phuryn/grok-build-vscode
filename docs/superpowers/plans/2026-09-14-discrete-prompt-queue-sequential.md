# Discrete Sequential Prompt Queue & Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the prompt queuing bug where multiple queued messages were collapsed/concatenated into a single prompt string (`"prompt1prompt2"`), transforming the system into a true discrete FIFO queue that processes prompts sequentially (Prompt 1 runs $\rightarrow$ completes $\rightarrow$ Prompt 2 automatically runs) with individual UI cards and drag-and-drop reordering.

**Architecture:**
1. **Host Sequential Queue Dispatching (`src/sidebar.ts` & `src/queued-send.ts`):**
   - Change `queuedSendReadyText(session)` to evaluate and pop ONLY the first element (`[session.queuedSends[0]]`) rather than joining all queued elements.
   - When a turn completes (`agentEnd` / turn settled), `maybeFlushQueuedSends(session)` automatically pops and executes the next pending item in the queue.
   - Add `reorderQueuedSends(items, fromIndex, toIndex)` in `src/queued-send.ts`.
2. **Protocol & IPC Message Additions:**
   - Add `removeQueuedSend: { type: "removeQueuedSend"; index: number }` to remove an individual item from the queue without touching others.
   - Add `reorderQueuedSends: { type: "reorderQueuedSends"; fromIndex: number; toIndex: number }` for drag-and-drop reordering.
   - Update `steerSend` to optionally take `index?: number` to steer a specific item from the queue.
3. **Webview Multi-Card Queue UI (`media/chat.js` & `media/chat.css`):**
   - Refactor `renderQueuedBlocks()` in `media/chat.js` from rendering a single concatenated text block to rendering a distinct list of cards (`.queued-item`) for each item in `state.sendQueue`.
   - Each card displays its own queue number badge (`Queued #1`, `Queued #2`, ...), its distinct text content, attached file chips, and action buttons (`Steer`, `Edit`, `Remove`).
   - Implement HTML5 native drag-and-drop (`draggable="true"`, `dragstart`, `dragover`, `dragleave`, `drop`, `dragend`) for intuitive queue reordering.

**Tech Stack:** TypeScript, Node.js, JavaScript (DOM / Webview), CSS.

**Spec:** `docs/superpowers/specs/2026-09-14-discrete-prompt-queue-spec.md`

## Global Constraints

- Never concatenate distinct queued prompts together into a single string.
- When multiple prompts are queued, Prompt 1 must execute completely; when the agent finishes Prompt 1's turn, Prompt 2 must immediately trigger as the next turn without user intervention.
- All unit, DOM, and integration tests must pass cleanly in `pnpm test`.

---

### Task 1: Protocol, Host Logic & Sequential Queue Helpers

**Files:**
- Modify: `src/protocol.ts`
- Modify: `src/queued-send.ts`
- Modify: `src/sidebar.ts`
- Modify: `media/webview-helpers.js`
- Modify: `src/desktop/webview-msg-validate.ts`
- Modify: `src/remote-policy.ts`
- Test: `test/queued-send.test.ts`

**Interfaces:**
- Produces: `reorderQueuedSends(items: readonly QueuedSendEntry[], fromIndex: number, toIndex: number): QueuedSendEntry[]`
- Produces: Webview messages `removeQueuedSend` and `reorderQueuedSends`.

- [ ] **Step 1: Update `src/protocol.ts`**

Add `removeQueuedSend` and `reorderQueuedSends` to `WebviewMsg`:
```typescript
  | { type: "removeQueuedSend"; index: number }
  | { type: "reorderQueuedSends"; fromIndex: number; toIndex: number }
```
Update `steerSend`:
```typescript
  | { type: "steerSend"; text: string; chips?: FileChip[]; fromQueue?: boolean; index?: number }
```
Add to `WEBVIEW_MESSAGE_TYPE_MAP`.

- [ ] **Step 2: Update `src/queued-send.ts`**

Implement `reorderQueuedSends` and ensure `dequeueQueuedSends` correctly splices targeted indices.

- [ ] **Step 3: Update `src/sidebar.ts` Queue Flushing & Handlers**

1. In `queuedSendReadyText`:
```typescript
  private queuedSendReadyText(session: Session): string | undefined {
    if (!sessionReadyForPrompt(session)) return undefined;
    if (session.status === "working" || session.status === "needs-you") return undefined;
    if (!session.queuedSends.length) return undefined;
    return queuedFlushText([session.queuedSends[0]]);
  }
```

2. In `steerSend`:
Support `queueIndex?: number` to splice out only the steered item while leaving the rest of the queue intact.

3. In `switch (msg.type)`:
Handle `reorderQueuedSends`, `removeQueuedSend`, and `dequeueSend` with targeted index.

- [ ] **Step 4: Update `media/webview-helpers.js`, `src/desktop/webview-msg-validate.ts`, and `src/remote-policy.ts`**

- [ ] **Step 5: Run tests to verify**

Run: `pnpm test -- test/queued-send.test.ts`
Expected: PASS

---

### Task 2: Multi-Card Queue Rendering and Drag-and-Drop in Webview

**Files:**
- Modify: `media/chat.css`
- Modify: `media/chat.js`
- Test: `test/send-queue.dom.test.ts`
- Test: `test/webview-ui.dom.test.ts`

- [ ] **Step 1: Add Card and Drag-and-Drop Styles in `media/chat.css`**

Add styling for `.queued-msgs-list`, `.queued-item`, `.drag-over-above`, `.drag-over-below`, `.queued-item-header`, and action buttons.

- [ ] **Step 2: Refactor `renderQueuedBlocks()` in `media/chat.js`**

Render individual `.queued-item` cards for each item in `state.sendQueue`:
- Displays `Queued #${index + 1}` header badge.
- Displays prompt text and image/file chips.
- Action buttons:
  - `Edit`: Sends `{ type: "dequeueSend", index }` to remove card and populate prompt composer.
  - `Remove`: Sends `{ type: "removeQueuedSend", index }` to discard card.
  - `Steer`: Sends `{ type: "steerSend", fromQueue: true, index, text, chips }` to inject into the active turn.
- Drag-and-drop event listeners (`dragstart`, `dragover`, `dragleave`, `drop`, `dragend`) posting `{ type: "reorderQueuedSends", fromIndex, toIndex }`.

- [ ] **Step 3: Run DOM tests to verify**

Run: `pnpm test -- test/send-queue.dom.test.ts test/webview-ui.dom.test.ts`
Expected: PASS

---

### Task 3: Full Verification, Packaging to `win-unpacked`, and Git Push

**Files:**
- Test: `pnpm run compile`
- Test: `pnpm test`
- Build: `pnpm run dist:dir`

- [ ] **Step 1: Compile TypeScript**
- [ ] **Step 2: Run all 241 test files (5,870+ tests)**
- [ ] **Step 3: Package to `dist-desktop/win-unpacked`**
- [ ] **Step 4: Commit and push to GitHub `fiko942` and update upstream PR #161**

---

## Self-Review

1. **Bug Resolution:** Prompts are no longer joined into `"prompt1prompt2"`. They are processed sequentially one-by-one.
2. **UX Enhancement:** Separate visual cards per queued item with drag-and-drop reordering and individual actions.
3. **No Regressions:** All existing tests passing cleanly.
