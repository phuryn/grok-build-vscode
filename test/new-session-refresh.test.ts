import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A new local session must refresh the project's conversation list.
 *
 * The symptom was oddly specific: starting a new session moved the project to
 * the top of the rail but added no row for the conversation, and only closing
 * and reopening the project made it appear. Both halves are explained by
 * `newFocusedSession` posting the repo CATALOG (which re-sorts projects by
 * recency) and never the sessions LIST (which is where the rail's rows come
 * from). The remote path has always sent its own list; only the local one
 * missed it, so it went unnoticed until the desktop grew a rail.
 *
 * This is a source-shape guard, and worth being honest about: it proves the
 * call is present and correctly ordered after the sweep, not that the frame
 * reaches the webview. The end-to-end path needs a real host and lives in the
 * integration suite. What it does buy is a failure that is loud — the bug it
 * guards is invisible locally and only shows up as "the rail is stale".
 */
const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
  "utf8",
);

const body = (() => {
  const start = src.indexOf("private async newFocusedSession(");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n  private ", start + 1);
  return src.slice(start, end);
})();

describe("a new local session refreshes the rail", () => {
  it("posts the sessions list, not only the repo catalog", () => {
    expect(body).toContain("this.postRepoCatalog();");
    expect(body).toContain("this.postSessionsList();");
  });

  it("posts it after the empty-session sweep", () => {
    // The sweep can retire the empty session this one replaced. A list built
    // before it would carry a row that no longer exists.
    //
    // lastIndexOf, not indexOf: the method now opens with a refusal path for a
    // named project that has gone away, and that path posts a refresh of its
    // own before returning. The ordering guarded here is the one on the way
    // through to actually starting a session.
    const sweep = body.indexOf("sweepEmptySessions");
    const list = body.lastIndexOf("this.postSessionsList();");
    expect(sweep).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(sweep);
  });
});

/**
 * A FINISHED TURN must refresh it too — the gap the rail's Recent group fell
 * into. The list ranks by `updatedAt`, which is the session file's mtime, and
 * the extension is not what writes that file: the agent process is. So rename
 * and delete refreshed (we do those) and sending a message did not. Recent kept
 * whatever order it was built with until something unrelated redrew it.
 */
describe("turn end refreshes the project preview", () => {
  it("never stamps send-time ordering merely by opening or focusing a session", () => {
    for (const signature of [
      "private focusSession(",
      "private focusRemoteSession(",
      "private async openSession(",
      "private async openRemoteSession(",
    ]) {
      const start = src.indexOf(signature);
      expect(start, `${signature} exists`).toBeGreaterThan(-1);
      const end = src.indexOf("\n  private ", start + signature.length);
      expect(src.slice(start, end)).not.toContain("noteSessionActivity");
    }
  });

  it("stamps ordering optimistically before prompt and reasserts it at turn end", () => {
    // handleSend is now an admission wrapper; the turn body it runs is here.
    const start = src.indexOf("private async handleAdmittedSend(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  private ", start + 1));
    const prompt = body.indexOf("await client.prompt(");
    const stamps = [...body.matchAll(/this\.noteSessionActivity\(session\)/g)].map((match) => match.index!);
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    expect(stamps[0]).toBeLessThan(prompt);
    expect(stamps.some((index) => index > prompt)).toBe(true);
  });

  it("hangs off the one place every turn ends, not off the success path", () => {
    // done AND error AND cancel — a cancelled turn still wrote a user message,
    // so the row still moved. `setStatus` is where all three meet.
    const start = src.indexOf("private setStatus(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(body).toMatch(/status === "done" \|\| status === "error"/);
    expect(body).toContain("refreshSessionOrderAfterTurn");
  });

  it("re-reads a beat later, and again, because the agent owns the write", () => {
    // Reading immediately races the agent's own transcript write. A single
    // delay is a guess about someone else's disk; two cheap scans cover it.
    const start = src.indexOf("private refreshSessionOrderAfterTurn(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  /**", start));
    expect(body).toContain("sendLocalRepoSessionsPreview");
    const delays = body.match(/for \(const delay of \[([^\]]+)\]/);
    expect(delays, "delays are declared as a list, not hidden in a chain").toBeTruthy();
    expect(delays![1].split(",").length).toBeGreaterThan(1);
    // Timers are tracked so a disposed sidebar does not post into a dead view.
    expect(body).toContain("turnOrderTimers");
  });

  it("clears its pending timers on dispose", () => {
    const start = src.indexOf("dispose(): void {");
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(body).toContain("turnOrderTimers");
    expect(body).toContain("clearTimeout");
  });
});
