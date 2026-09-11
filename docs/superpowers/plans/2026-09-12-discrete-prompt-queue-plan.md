# Discrete Prompt Queue & Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify the host and UI so that multiple pending prompts form a discrete queue processed one-by-one, with UI cards that can be reordered via drag-and-drop.

**Architecture:** 
- The host (`sidebar.ts` & `queued-send.ts`) shifts from executing the entire queue array joined by newlines to shifting only the first element per turn completion. 
- The protocol adds new events (`reorderQueuedSends`) and amends existing ones (`dequeueSend`, `steerSend`) to carry an `index` parameter targeting specific items.
- The webview UI (`media/chat.js`) renders a list of `div` cards mapping to `state.sendQueue`, equipped with HTML5 Drag-and-Drop event handlers and explicit card actions (Steer, Edit, Remove).

**Tech Stack:** TypeScript, Node.js, DOM API (Vanilla JS for Webview).

## Global Constraints
- Target workspace: `grok-build-vscode`
- Testing: TypeScript strict mode must pass; existing Vitest suites must be updated to pass.
- No new external drag-and-drop dependencies; use HTML5 native `draggable="true"` and DOM events.
- Maintain isolation per session `Session.queuedSends`.

---

### Task 1: Protocol and Host Base Logic for Queue Reordering & Sequential Flushing

**Files:**
- Modify: `src/protocol.ts`
- Modify: `src/queued-send.ts`
- Modify: `src/sidebar.ts`
- Test: `test/sidebar.test.ts` or `test/queued-send.test.ts` (existing suites).

**Interfaces:**
- Produces: `reorderQueuedSends(items: QueuedSendEntry[], fromIndex: number, toIndex: number): QueuedSendEntry[]`
- Produces: WebviewMessage `reorderQueuedSends` and HostMessage adjustments for targeted editing/steering.

- [ ] **Step 1: Update Protocol Types**

Update `src/protocol.ts` to include the new host message and enhance existing ones.
Add to `HostMsg` union:
```typescript
  | { type: "reorderQueuedSends"; fromIndex: number; toIndex: number }
  | { type: "dequeueSend"; index: number } // ensure index exists
  | { type: "steerSend"; text: string; chips?: FileChip[]; fromQueue?: boolean; index?: number }
```

- [ ] **Step 2: Add Reorder Helper to `queued-send.ts`**

In `src/queued-send.ts`, add the reorder logic.
```typescript
export function reorderQueuedSends(
  items: readonly QueuedSendEntry[],
  fromIndex: number,
  toIndex: number,
): QueuedSendEntry[] {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
    return [...items];
  }
  const result = [...items];
  const [moved] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, moved);
  return result;
}
```

- [ ] **Step 3: Modify `sidebar.ts` Flush Logic**

In `src/sidebar.ts`, locate `queuedSendReadyText()` and `maybeFlushQueuedSends()` routines around line 3915.
Instead of:
```typescript
return queuedFlushText(session.queuedSends); // returns joined string
```
Modify to:
```typescript
private queuedSendReadyText(session: Session): string | undefined {
  if (!sessionReadyForPrompt(session)) return undefined;
  if (session.status === "working" || session.status === "needs-you") return undefined;
  if (session.queuedSends.length === 0) return undefined;
  return queuedFlushText([session.queuedSends[0]]);
}
```

And in `maybeFlushQueuedSends()` where `session.queuedSends = []` is called when clearing the queue for execution (around line 4000):
```typescript
if (takeQueue) {
  // Only shift the first item for execution
  contributions = [{
    text: session.queuedSends[0].text,
    chips: session.queuedSends[0].chips.map(cloneChipForQueue),
  }];
  session.queuedSends = session.queuedSends.slice(1);
  session.queuedSendDispatch = undefined;
  session.queuedSendCommit = undefined;
  this.emitQueuedSends(session);
}
```

- [ ] **Step 4: Wire Webview-to-Host Messages in `sidebar.ts`**

In `src/sidebar.ts` inside the `switch (message.type)` handler (around line 10760+):
```typescript
case "reorderQueuedSends": {
  const s = requireSession(message.sessionId);
  s.queuedSends = reorderQueuedSends(s.queuedSends, message.fromIndex, message.toIndex);
  this.emitQueuedSends(s);
  break;
}
```
Update `"dequeueSend"`:
```typescript
case "dequeueSend": {
  // Pass message.index explicitly. It defaults to 0 if not provided for legacy support.
  const idx = typeof message.index === "number" ? message.index : 0;
  const result = dequeueQueuedSends(s.queuedSends, idx, false);
  // ... existing logic to prepend text to composer ...
}
```
Update `"steerSend"`:
```typescript
case "steerSend": {
  const s = requireSession(message.sessionId);
  if (message.fromQueue && typeof message.index === "number") {
    // Remove only the steered item from the queue
    const res = dequeueQueuedSends(s.queuedSends, message.index, false);
    if (res) s.queuedSends = res.rest;
    this.emitQueuedSends(s);
  } else if (message.fromQueue) {
    // Legacy fallback: clear the whole queue
    s.queuedSends = [];
    this.emitQueuedSends(s);
  }
  // ... existing steer setup logic ...
}
```

- [ ] **Step 5: Run tests to verify host state**

Run: `vitest run test/queued-send.test.ts test/sidebar.test.ts -v` (or run full suite `pnpm test`)
Expected: PASS. If tests fail due to the change from combined execution to sequential execution, update the test snapshots or logic to expect single-item execution.

- [ ] **Step 6: Commit**

```bash
git add src/protocol.ts src/queued-send.ts src/sidebar.ts
git commit -m "feat(host): implement sequential queue flushing and reorder logic"
```

---

### Task 2: Webview Multi-Card Queue Rendering & Drag-and-Drop

**Files:**
- Modify: `media/chat.js`
- Modify: `media/chat.css`

**Interfaces:**
- Consumes: The `state.sendQueue` array from the webview state containing `{ text, chips }`.

- [ ] **Step 1: CSS Updates for Drag-and-Drop & Cards**

In `media/chat.css`, add styles for the individual cards and drag interactions:
```css
.queued-msgs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.queued-item {
  position: relative;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-widget-border);
  cursor: grab;
  padding: 8px;
}
.queued-item:active {
  cursor: grabbing;
}
.queued-item.drag-over-above {
  border-top: 2px solid var(--vscode-focusBorder);
}
.queued-item.drag-over-below {
  border-bottom: 2px solid var(--vscode-focusBorder);
}
.queued-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
}
.queued-item-actions {
  display: flex;
  gap: 4px;
}
.queued-item-actions button {
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  padding: 2px 4px;
}
```

- [ ] **Step 2: Re-write `renderQueuedBlocks` in `media/chat.js`**

Replace the logic that builds a single DOM element with logic that builds a list of elements.
```javascript
function renderQueuedBlocks() {
  let wrap = state.queuedWrapEl;
  if (!state.sendQueue || state.sendQueue.length === 0) {
    if (wrap) wrap.remove();
    state.queuedWrapEl = null;
    return;
  }
  
  if (!wrap || !wrap.isConnected) {
    wrap = document.createElement("div");
    wrap.className = "queued-msgs-list";
    state.queuedWrapEl = wrap;
  }
  wrap.innerHTML = "";
  
  state.sendQueue.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "queued-item msg user queued";
    card.draggable = true;
    card.dataset.index = index;
    
    // Drag and drop event listeners
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", index.toString());
      card.style.opacity = "0.5";
    });
    card.addEventListener("dragend", () => {
      card.style.opacity = "1";
      document.querySelectorAll(".queued-item").forEach(el => {
        el.classList.remove("drag-over-above", "drag-over-below");
      });
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        card.classList.add("drag-over-above");
        card.classList.remove("drag-over-below");
      } else {
        card.classList.add("drag-over-below");
        card.classList.remove("drag-over-above");
      }
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over-above", "drag-over-below");
    });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over-above", "drag-over-below");
      const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
      let toIndex = index;
      const rect = card.getBoundingClientRect();
      if (e.clientY >= rect.top + rect.height / 2) {
        toIndex += 1;
      }
      if (fromIndex < toIndex) toIndex -= 1; // adjust for shift
      if (fromIndex !== toIndex) {
        vscode.postMessage({ type: "reorderQueuedSends", fromIndex, toIndex, sessionId: state.activeSessionId });
      }
    });
    
    // Header & Actions
    const header = document.createElement("div");
    header.className = "queued-item-header queued-hdr";
    const tag = document.createElement("span");
    tag.className = "queued-tag";
    tag.innerHTML = `${ICON.clock}<span>Queued #${index + 1}</span>`;
    header.appendChild(tag);
    
    const actions = document.createElement("div");
    actions.className = "queued-item-actions queued-actions";
    
    // Edit Button
    const editBtn = document.createElement("button");
    editBtn.title = "Edit (removes from queue)";
    editBtn.innerHTML = `${ICON.edit} Edit`;
    editBtn.onclick = () => {
      vscode.postMessage({ type: "dequeueSend", index, sessionId: state.activeSessionId });
    };
    actions.appendChild(editBtn);
    
    // Remove Button
    const removeBtn = document.createElement("button");
    removeBtn.title = "Remove";
    removeBtn.innerHTML = `${ICON.close}`;
    removeBtn.onclick = () => {
      // In host side, dequeueSend without putting it back in composer needs special handling, 
      // or we can reuse `cancelSubmission` behavior directed at an index.
      // Easiest is adding a specific `removeQueuedSend` or passing a flag to `dequeueSend`.
      vscode.postMessage({ type: "removeQueuedSend", index, sessionId: state.activeSessionId });
    };
    actions.appendChild(removeBtn);
    
    header.appendChild(actions);
    card.appendChild(header);
    
    // Content body
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    const content = document.createElement("div");
    content.className = "msg-content text-content";
    content.textContent = item.text || "";
    bubble.appendChild(content);
    
    // Chips logic (if any)
    if (item.chips && item.chips.length > 0) {
      const chipContainer = document.createElement("div");
      chipContainer.className = "chips-row msg-chips";
      item.chips.forEach(chip => {
        const c = document.createElement("div");
        c.className = "chip file-chip";
        c.textContent = chip.label || chip.id;
        chipContainer.appendChild(c);
      });
      bubble.appendChild(chipContainer);
    }
    
    card.appendChild(bubble);
    
    // Steer Action (if applicable)
    if (state.steerSupported && steerableProvider()) {
      const steerBtn = document.createElement("button");
      steerBtn.className = "queued-action queued-steer";
      steerBtn.innerHTML = `${ICON.cornerDownRight}<span>Steer</span>`;
      steerBtn.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.sessionSuperseded) return;
        vscode.postMessage({ type: "steerSend", text: item.text, chips: item.chips, fromQueue: true, index, sessionId: state.activeSessionId });
      };
      card.appendChild(steerBtn);
    }
    
    wrap.appendChild(card);
  });
  
  const bottomAnchor = document.getElementById("bottom-anchor");
  if (bottomAnchor && bottomAnchor.parentNode) {
    bottomAnchor.parentNode.insertBefore(wrap, bottomAnchor);
  }
}
```

- [ ] **Step 3: Missing `removeQueuedSend` Protocol Support**

Because step 2 introduces a pure remove button, add it to `protocol.ts` and `sidebar.ts`.
In `protocol.ts`:
```typescript
| { type: "removeQueuedSend"; index: number }
```
In `sidebar.ts` inside the webview message switch:
```typescript
case "removeQueuedSend": {
  const s = requireSession(message.sessionId);
  if (message.index >= 0 && message.index < s.queuedSends.length) {
    s.queuedSends = [...s.queuedSends.slice(0, message.index), ...s.queuedSends.slice(message.index + 1)];
    if (!s.queuedSends.length) s.queuedSendRequiresRelay = false;
    this.emitQueuedSends(s);
  }
  break;
}
```

- [ ] **Step 4: Verify in Webview tests**

Run: `vitest run test/webview-ui.dom.test.ts`
Expected: Passes. (Update snapshot or test expectations for queued render structure).

- [ ] **Step 5: Commit**

```bash
git add media/chat.js media/chat.css src/protocol.ts src/sidebar.ts
git commit -m "feat(ui): render distinct queued cards with drag-and-drop reordering"
```
