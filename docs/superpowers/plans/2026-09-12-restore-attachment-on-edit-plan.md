# Preserve Attached File Chips when Editing Sent Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore file attachments (images/files) back to the composer when editing a previously sent message.

**Architecture:** 
- The webview UI (`media/chat.js`) stores the attached chips on the user message DOM node (`_chips`) when rendering a user message.
- Clicking the "Edit" button includes the message's `chips` array in the `editLastMessage` message sent to the extension host (`src/sidebar.ts`).
- Protocol definitions (`src/protocol.ts`) update `editLastMessage` to accept optional `chips`.
- The extension host (`src/sidebar.ts`) receives `chips` in `editLastMessage` and passes them to `restoreComposerFor`, which invokes `restoreQueuedChips` on `session.chips` and triggers `this.postChips(session)` to re-populate the composer's chip attachments.

**Tech Stack:** TypeScript, Vanilla JS (Webview DOM), Vitest.

## Global Constraints
- Target workspace: `grok-build-vscode`
- Testing: TypeScript strict mode must pass (`pnpm run compile`); Vitest test suite (`pnpm test`) must pass.

---

### Task 1: Preserve and Restore Attached Chips on Edit Last Message

**Files:**
- Modify: `src/protocol.ts`
- Modify: `src/sidebar.ts`
- Modify: `media/chat.js`
- Test: `test/edit-resend.dom.test.ts`

**Interfaces:**
- Produces: `editLastMessage(userBubbleIndex: number, text: string, totalUserBubbles?: number, session?: Session, requester?: RemoteRequester, chips?: FileChip[]): Promise<void>`
- Produces: `restoreComposerFor(session: Session, requester: RemoteRequester | undefined, text: string, chips?: FileChip[]): void`

- [ ] **Step 1: Update Protocol Definitions**

In `src/protocol.ts`, update `WebviewMsg` for `editLastMessage` to accept `chips?: FileChip[]`:
```typescript
| { type: "editLastMessage"; userBubbleIndex: number; text: string; chips?: FileChip[]; totalUserBubbles?: number }
```

- [ ] **Step 2: Update Host Logic in `src/sidebar.ts`**

Update `restoreComposerFor` to restore chips to `session.chips` if present:
```typescript
  private restoreComposerFor(
    session: Session,
    requester: RemoteRequester | undefined,
    text: string,
    chips?: FileChip[],
  ): void {
    if (!text && (!chips || !chips.length)) return;
    
    if (chips && chips.length) {
      session.chips = restoreQueuedChips(session.chips, [{ text: "", chips }]);
      if (session === this.focused) this.refreshImplicitChip(true);
      else this.postChips(session);
    }
    
    const message: HostMsg = { type: "restoreComposer", text };
    // ...
```

Update `editLastMessage` signature and call sites to forward `chips` to `restoreComposerFor`:
```typescript
  private async editLastMessage(
    userBubbleIndex: number,
    text: string,
    totalUserBubbles?: number,
    session: Session = this.focused,
    requester?: RemoteRequester,
    chips?: FileChip[],
  ): Promise<void> {
    // ...
    const target = resolveEditRewindTarget(points, userBubbleIndex);
    if (!target) {
      this.restoreComposerFor(session, requester, text, chips);
      return void this.reportRequester(...);
    }
    // ...
    this.restoreComposerFor(session, requester, text, chips);
  }
```

Update the `editLastMessage` case in `sidebar.ts`'s message dispatcher:
```typescript
  case "editLastMessage":
    await this.editLastMessage(msg.userBubbleIndex, msg.text, msg.totalUserBubbles, session, requester, msg.chips);
    break;
```

- [ ] **Step 3: Update Webview UI in `media/chat.js`**

In `addMessage`, store `chips` on the element node:
```javascript
  el._copyText = text || "";
  el._chips = chips || [];
```

In the `.msg-edit-btn` click handler:
```javascript
  const editMsg = {
    type: "editLastMessage",
    userBubbleIndex: idx,
    text: (msgEl && msgEl._copyText) || "",
    totalUserBubbles: visibleUserBubbleCount(),
  };
  if (msgEl && msgEl._chips && msgEl._chips.length) {
    editMsg.chips = msgEl._chips;
  }
  vscode.postMessage(editMsg);
```

- [ ] **Step 4: Add Automated Unit / DOM Test in `test/edit-resend.dom.test.ts`**

Add test verifying `editLastMessage` posts chips when editing a message with attachments:
```typescript
  it("posts attached chips with editLastMessage when the message has attachments", () => {
    const { window, posted, doc } = bootWebview();
    const chip = {
      id: "image:/s/test.png:1:1",
      path: "/s/test.png",
      relPath: "Image #1",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
    };
    dispatch(window, {
      type: "userMessage",
      text: "with image",
      chips: [chip],
    });

    click(window, editBtn(userBubbles(doc)[0]));
    expect(posted.find((m: any) => m.type === "editLastMessage")).toEqual({
      type: "editLastMessage",
      userBubbleIndex: 0,
      text: "with image",
      chips: [expect.objectContaining({ id: chip.id })],
      totalUserBubbles: 1,
    });
  });
```

- [ ] **Step 5: Verify Compilation and Tests**

Run: `pnpm run compile && pnpm test`
Expected: PASS (All TypeScript checks and test suites pass).

- [ ] **Step 6: Commit**

```bash
git add src/protocol.ts src/sidebar.ts media/chat.js test/edit-resend.dom.test.ts
git commit -m "fix(edit): restore file attachments to composer when editing sent messages"
```
