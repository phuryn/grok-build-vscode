# Discrete Prompt Queue & Reordering Specification

**Date:** 2026-09-12  
**Feature:** Discrete Per-Conversation Prompt Queue & Drag-and-Drop Reordering  
**Target Repository:** `grok-build-vscode`  

---

## 1. Overview & Objectives

Currently, when multiple prompts are sent while an agent is busy processing a turn, all pending messages are merged into a single queued text block and executed together as one combined prompt when the turn completes. 

This specification introduces **Discrete Prompt Queueing**:
1. **Sequential Execution (FIFO):** Each prompt submitted during an active turn forms a distinct queued item. When the turn finishes, only the first prompt in the queue is executed. When that subsequent turn completes, the next queued prompt executes, continuing until the queue is exhausted.
2. **Per-Item UI Cards:** Each queued prompt renders as an individual card in the webview with order indicators (`#1`, `#2`, etc.) and individual action controls (`Edit`, `Remove`, `Steer`).
3. **Drag-and-Drop Reordering:** Users can reorder queued prompts by dragging and dropping cards to change their execution sequence.
4. **Session Isolation:** Queue state remains strict and isolated per conversation session (`Session.queuedSends`), so switching sessions or workspace projects updates the queue view seamlessly.

---

## 2. Component & Data Flow Changes

### A. Protocol & Messages (`src/protocol.ts`)
Add host-webview message types for individual queue manipulation:
- `reorderQueuedSends`: sent from Webview to Host with payload `{ fromIndex: number, toIndex: number }` or `{ newOrder: number[] }`.
- `dequeueSend`: enhanced to include `{ index: number }` so a specific item can be dequeued/edited/removed.
- `steerSend`: enhanced to accept `{ index: number }` so a specific queued item can be steered into the running turn.

### B. Host / Session Manager (`src/queued-send.ts` & `src/sidebar.ts`)
- **Flush Execution (`sidebar.ts -> maybeFlushQueuedSends`):**
  Instead of joining all entries with `queuedFlushText(session.queuedSends)` (`items.map(text).join("\n\n")`), the host checks if `session.queuedSends.length > 0` and extracts only the first item (`session.queuedSends[0]`).
  Upon initiating the turn for item `0`, only item `0` is removed from `session.queuedSends`.
- **Reordering (`queued-send.ts -> reorderQueuedSends`):**
  Add a helper function to reorder entries:
  ```typescript
  export function reorderQueuedSends(
    items: readonly QueuedSendEntry[],
    fromIndex: number,
    toIndex: number
  ): QueuedSendEntry[]
  ```
- **Targeted Dequeue & Steer (`sidebar.ts`):**
  Update `dequeueSend` and `steerSend` handlers to target `msg.index`, modifying or removing only the entry at that index and broadcasting the updated `queuedSendsMessage`.

### C. Webview UI & Drag-and-Drop (`media/chat.js` & `media/chat.css`)
- **Render Multi-Card Queue (`renderQueuedBlocks`):**
  Render a list container `.queued-msgs-list` containing individual `.queued-item` cards for every entry in `state.sendQueue`.
- **Drag-and-Drop Event Handlers:**
  - Attach `draggable="true"` to each `.queued-item`.
  - Handle `dragstart`: store source index in `dataTransfer`.
  - Handle `dragover`: add visual drop indicator class (`drag-over-above` or `drag-over-below`).
  - Handle `dragleave`: remove drop indicator.
  - Handle `drop`: calculate target index and post `reorderQueuedSends` to the host.
- **Card Action Controls:**
  - **Edit:** Removes the card at `index` from the queue and places its text and file chips into the active composer.
  - **Remove (x):** Deletes the card at `index` from the queue.
  - **Steer:** Injects the text and attachments of the card at `index` directly into the in-flight turn, leaving all other queued cards intact.

---

## 3. Scope & Edge Cases

1. **Session Switching:** Queue snapshots (`queuedSends`) are already attached to each `Session` instance. Switching active sessions updates `state.sendQueue` and re-renders the cards corresponding to the focused session.
2. **Process / Turn Interruption:** Stopping or cancelling a turn leaves the remaining queue intact, allowing the user to either resume or edit queued items.
3. **Image Attachments:** File chips belonging to a specific queued prompt stay bound to that specific prompt item during reordering and targeted execution.

---

## 4. Verification Plan

- **Unit & Logic Tests (`test/queued-send.test.ts` & `test/sidebar.test.ts`):**
  - Verify `reorderQueuedSends` produces correct array permutations.
  - Verify `maybeFlushQueuedSends` flushes items sequentially one by one instead of combining them into a single prompt.
- **TypeScript Compilation:**
  - Run `pnpm run compile` to verify strict type correctness across messages and protocol implementations.
