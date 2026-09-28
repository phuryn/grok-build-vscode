import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A rewound message goes back to the surface that asked for it, and no other.
 *
 * `restoreComposer` APPENDS to whatever is already typed (media/chat.js case
 * "restoreComposer") — deliberately, because silently destroying a draft is the
 * bug Edit exists to fix. Sent through `emit` it reaches the focused desk
 * webview AND every remote holder of the session, so once rewind/edit became
 * reachable from a remote, a phone tapping Edit would paste its message on top
 * of an unsent draft at the computer and steal focus there. Nobody at that desk
 * asked for it, and appending text to someone's draft is the "duplicating the
 * user's work" case the usage model rules out.
 *
 * Found by the independent review of the widening, and the same narrowing fixes
 * the desk-to-phone mirror, which was always possible.
 *
 * A source-shape guard, and honest about it: it proves the rewind and edit
 * paths route through the requester-aware helper rather than the session-wide
 * emit, not that a frame reaches one client and not another.
 */
const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
  "utf8",
);

function methodBody(signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  private ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("who receives a rewound message", () => {
  it("delivers to the requester, or to the desk when there is none", () => {
    const body = methodBody("private restoreComposerFor(");
    expect(body).toContain("this.resolveRemoteRequester(requester)");
    expect(body).toContain("this.sendRemoteClient(clientId, message)");
    expect(body).toContain("this.postLocal(this.view ? this.localizeHistoryMessage(message, this.view.webview) : message)");
  });

  /**
   * The half a first attempt dropped, caught by review. `emit` delivered
   * locally only while the session was focused and remotely only to clients
   * still holding it; "send to whoever asked" without that check pastes
   * conversation A's message into conversation B — a different repository's —
   * when the user switches conversation while the rewind RPC is still running.
   */
  it("refuses to deliver to a surface that has moved to another conversation", () => {
    const body = methodBody("private restoreComposerFor(");
    expect(body).toContain("this.remoteClients.active(clientId) === session");
    expect(body).toContain("this.focused === session");
  });

  /**
   * And refusing is only half an answer. The rewind has already removed the
   * message from the transcript, so a surface that moved on must not simply
   * drop the text — that loses it from both places at once. It is parked on the
   * conversation it belongs to and handed back when that conversation is next
   * on screen.
   */
  it("parks the text on its conversation rather than dropping it", () => {
    const body = methodBody("private restoreComposerFor(");
    expect(body).toContain("this.rememberQueuedDraft(id");
  });

  /**
   * The slot holds one string. Two rewinds parked before either is collected
   * would overwrite — and the first message is already gone from the transcript,
   * so replacing loses it outright. The webview appends for the same reason;
   * the store must not be the one place that silently drops a message.
   */
  it("appends to an already-parked draft instead of replacing it", () => {
    const body = methodBody("private rememberQueuedDraft(");
    expect(body).toContain("this.updateSessionMeta");
    expect(body).toContain("previous.queuedDraft");
  });

  it("restores on re-focus through an explicitly targeted recipient", () => {
    expect(methodBody("private focusRemoteSession(")).toContain("this.restorePersistedDraft(session, { clientId })");
    expect(methodBody("private focusSession(")).toContain('this.restorePersistedDraft(session, "local")');
  });

  it("is how both rewind and edit hand the text back", () => {
    for (const signature of ["private async editLastMessage(", "async rewindFocusedSession("]) {
      const body = methodBody(signature);
      // The session travels with it: the helper refuses a surface that has
      // since moved to another conversation, and cannot check that without it.
      expect(body, signature).toContain("this.restoreComposerFor(session, requester,");
      // The session-wide emit is what pasted into a bystander's composer.
      expect(body, signature).not.toContain('emit(session, { type: "restoreComposer"');
    }
  });

  it("leaves the draft-restore paths alone — those are the desk's own drafts", () => {
    // `restoreComposer` with a stored draft is a different flow (a session's own
    // saved text coming back to it) and is not requester-scoped.
    expect(src).toContain('this.emit(session, { type: "restoreComposer", text: draft });');
  });
});
