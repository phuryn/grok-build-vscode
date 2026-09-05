/**
 * Host-declared webview-reload capability + remote install-id suffix.
 *
 * Mutation targets:
 *   - Reverting the ready gate to bare `focused.client` must fail the VS Code arm
 *     (capability false + live client must NOT rehydrate).
 *   - Dropping the capability on VS Code/Electron hosts must fail the source gates.
 *   - Rehydrate during priming must keep the startup lock and route sends to the
 *     queue (work loss if a prompt races "no session").
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatRemoteInstallId,
  shouldRehydrateOnWebviewReady,
} from "../src/host";
import {
  rehydrateBusyChrome,
  Session,
  sessionReadyForPrompt,
} from "../src/session";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("shouldRehydrateOnWebviewReady", () => {
  it("VS Code arm: capability off never rehydrates even with a live client", () => {
    // View move / Reload Webviews under a live session — v3.1.0 always startSession.
    expect(shouldRehydrateOnWebviewReady(false, true)).toBe(false);
    expect(shouldRehydrateOnWebviewReady(false, false)).toBe(false);
  });

  it("Electron arm: capability on rehydrates only when a live client exists", () => {
    expect(shouldRehydrateOnWebviewReady(true, true)).toBe(true);
    expect(shouldRehydrateOnWebviewReady(true, false)).toBe(false);
  });

  it("fails if the decision collapses to incidental hasLiveClient alone", () => {
    // Simulates the bug this gate replaces: if (focused.client) rehydrate.
    const buggy = (hasLiveClient: boolean) => hasLiveClient;
    expect(buggy(true)).toBe(true);
    // Correct policy for VS Code + live client:
    expect(shouldRehydrateOnWebviewReady(false, true)).toBe(false);
    // If someone "tests" only Electron, the VS Code regression slips through —
    // this assertion is the one that must stay.
    expect(shouldRehydrateOnWebviewReady(false, true)).not.toBe(buggy(true));
  });
});

describe("formatRemoteInstallId", () => {
  it("leaves a bare id unchanged for VS Code (empty suffix)", () => {
    expect(formatRemoteInstallId("abc-123", "")).toBe("abc-123");
  });

  it("appends :desktop for the desktop app", () => {
    expect(formatRemoteInstallId("abc-123", ":desktop")).toBe("abc-123:desktop");
  });

  it("does not double-suffix", () => {
    expect(formatRemoteInstallId("abc-123:desktop", ":desktop")).toBe("abc-123:desktop");
  });
});

describe("source gates — capability at the ownership boundary", () => {
  it("sidebar gates rehydrate on shouldRehydrateOnWebviewReady, not bare focused.client", () => {
    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = sidebar.indexOf("private postInitialState()");
    expect(start).toBeGreaterThan(-1);
    const end = sidebar.indexOf("private rehydrateWebviewFromFocused", start);
    const body = sidebar.slice(start, end);
    expect(body).toContain("shouldRehydrateOnWebviewReady");
    expect(body).toContain("webviewReloadsUnderLiveSession");
    // Must not re-introduce the incidental-state gate as the sole condition.
    expect(body).not.toMatch(/if\s*\(\s*this\.focused\.client\s*\)/);
  });

  it("VS Code host declares rehydrate capability false and empty install suffix", () => {
    const src = readFileSync(path.join(root, "src", "vscode-host.ts"), "utf8");
    expect(src).toMatch(/webviewReloadsUnderLiveSession:\s*false/);
    expect(src).toMatch(/remoteInstallIdSuffix:\s*""/);
    expect(src).toMatch(/canRelocateView:\s*true/);
    expect(src).toMatch(/canShowOutput:\s*true/);
    expect(src).toMatch(/canToggleDevTools:\s*false/);
    expect(src).toMatch(/canShowMcpSettings:\s*true/);
    expect(src).toMatch(/canOpenInEditor:\s*true/);
    expect(src).toMatch(/canPreviewInApp:\s*false/);
    expect(src).toMatch(/canOpenSettingsEditor:\s*true/);
    expect(src).toMatch(/canSwitchWorkspaceFolder:\s*false/);
    expect(src).toMatch(/canArchiveRepos:\s*true/);
  });

  it("Electron host declares rehydrate capability true and :desktop suffix", () => {
    const src = readFileSync(path.join(root, "src", "desktop", "electron-host.ts"), "utf8");
    expect(src).toMatch(/webviewReloadsUnderLiveSession:\s*true/);
    expect(src).toMatch(/remoteInstallIdSuffix:\s*":desktop"/);
    expect(src).toMatch(/canRelocateView:\s*false/);
    expect(src).toMatch(/canShowOutput:\s*false/);
    expect(src).toMatch(/canToggleDevTools/);
    expect(src).toMatch(/canShowMcpSettings/);
    expect(src).toMatch(/canOpenInEditor:\s*false/);
    expect(src).toMatch(/canPreviewInApp:\s*true/);
    expect(src).toMatch(/canOpenSettingsEditor:\s*false/);
    expect(src).toMatch(/canSwitchWorkspaceFolder:\s*true/);
    expect(src).toMatch(/canArchiveRepos:\s*true/);
  });

  it("link flow formats installId through the host suffix helper", () => {
    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(sidebar).toContain("formatRemoteInstallId");
    expect(sidebar).toContain("remoteInstallIdSuffix");
    // Must not send bare installId() alone without the helper.
    const linkStart = sidebar.indexOf("async linkRemoteDevice()");
    const linkEnd = sidebar.indexOf("async unlinkRemoteDevice()", linkStart);
    const linkBody = sidebar.slice(linkStart, linkEnd);
    expect(linkBody).toContain("formatRemoteInstallId(this.installId()");
    expect(linkBody).toContain("buildLinkStartBody");
    expect(linkBody).toContain("clientLabel");
    expect(linkBody).toContain("this.host.appName");
    expect(linkBody).not.toMatch(/JSON\.stringify\(\{\s*name,\s*installId\s*\}\)/);
  });
});

/**
 * Behavioural model of reload-during-priming (the work-loss bug):
 *   1. Rehydrate must post setBusy locked:true while priming.
 *   2. A send that still arrives must join the queue (not call prompt).
 *   3. When priming ends, the queued text is ready to flush.
 *
 * Mutation: rehydrateBusyChrome always unlocking, or handleSend ignoring
 * priming, loses the prompt (chips consumed + "no session").
 */
describe("rehydrate during priming does not lose a prompt", () => {
  function fakeClient(sessionId?: string): Session["client"] {
    return { sessionId } as Session["client"];
  }

  /** Mirror of handleSend's divert decision (pure) — what the host must do. */
  function wouldQueueSend(session: Session): boolean {
    return session.priming || (!!session.client && !sessionReadyForPrompt(session));
  }

  /** Mirror of divertRacingSend + maybeFlush readiness. */
  function queueThenFlushModel(session: Session, text: string): {
    queuedDuringPriming: Array<{ text: string; chips: [] }>;
    flushedWhenReady: string | undefined;
  } {
    if (wouldQueueSend(session) || !sessionReadyForPrompt(session)) {
      session.queuedSends = [...session.queuedSends, { text, chips: [] }];
    }
    const queuedDuringPriming = [...session.queuedSends] as Array<{ text: string; chips: [] }>;
    // startSession success path:
    session.priming = false;
    if (session.client && !session.client.sessionId) {
      (session.client as { sessionId?: string }).sessionId = "sess-live";
    }
    const flushedWhenReady =
      sessionReadyForPrompt(session) &&
      session.status !== "working" &&
      session.status !== "needs-you" &&
      session.queuedSends.length
        ? session.queuedSends.map((item) => item.text).join("\n\n")
        : undefined;
    return { queuedDuringPriming, flushedWhenReady };
  }

  it("keeps the startup lock when client exists but priming is still true", () => {
    const session = new Session();
    session.priming = true;
    session.client = fakeClient(undefined);
    session.status = "idle";

    // The bug: setBusy({ locked: false }) unconditionally on rehydrate.
    const buggy = {
      value: session.status === "working" || session.status === "needs-you" || !!session.turnToken,
      locked: false as boolean,
    };
    expect(buggy.locked).toBe(false);
    expect(buggy.value).toBe(false); // composer unlocked and idle — user can send

    const chrome = rehydrateBusyChrome(session);
    expect(chrome.locked).toBe(true);
    expect(chrome.value).toBe(true);
    expect(sessionReadyForPrompt(session)).toBe(false);
  });

  it("queues a send on a priming session that has no client yet", () => {
    const session = new Session();
    session.priming = true;
    expect(session.client).toBeUndefined();
    expect(wouldQueueSend(session)).toBe(true);
    const { queuedDuringPriming } = queueThenFlushModel(
      session,
      "from the phone during sign-out",
    );
    expect(queuedDuringPriming).toEqual([{ text: "from the phone during sign-out", chips: [] }]);
  });

  it("queues a send during priming and flushes the same text when ready", () => {
    const session = new Session();
    session.priming = true;
    session.client = fakeClient(undefined);
    session.chips = [
      { id: "c1", path: "/ws/a.ts", relPath: "a.ts", hidden: false },
    ];

    // Send arrives (e.g. host path after a wrongly unlocked UI, or remote).
    expect(wouldQueueSend(session)).toBe(true);
    const { queuedDuringPriming, flushedWhenReady } = queueThenFlushModel(
      session,
      "do not lose this prompt",
    );
    expect(queuedDuringPriming).toEqual([{ text: "do not lose this prompt", chips: [] }]);
    // Chips must still be present — divert does not consume them.
    expect(session.chips).toHaveLength(1);
    expect(flushedWhenReady).toBe("do not lose this prompt");
    expect(sessionReadyForPrompt(session)).toBe(true);
  });

  it("mutation: unconditional locked:false + prompt-while-priming loses the text", () => {
    // Reconstruct the failure mode this fix closes.
    const session = new Session();
    session.priming = true;
    session.client = fakeClient(undefined);

    const rehydrateLockedFalse = false; // old code
    const canType = !rehydrateLockedFalse;
    expect(canType).toBe(true);

    // Old handleSend: no priming gate → would call client.prompt → throw "no session".
    // Text never reaches queuedSends; chips would be consumed at the commit point.
    const oldPathQueues = false;
    expect(oldPathQueues).toBe(false);

    // Fixed path:
    expect(rehydrateBusyChrome(session).locked).toBe(true);
    expect(wouldQueueSend(session)).toBe(true);
    const result = queueThenFlushModel(session, "important task");
    expect(result.flushedWhenReady).toBe("important task");
  });

  it("sidebar rehydrate uses rehydrateBusyChrome (not locked:false hardcode)", () => {
    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = sidebar.indexOf("private rehydrateWebviewFromFocused");
    expect(start).toBeGreaterThan(-1);
    const end = sidebar.indexOf("\n  private ", start + 10);
    const body = sidebar.slice(start, end);
    expect(body).toContain("rehydrateBusyChrome");
    expect(body).not.toMatch(/setBusy[\s\S]*locked:\s*false/);
    expect(sidebar).toContain("sessionReadyForPrompt");
  });

  it("ready case decides rehydrate BEFORE postInitialState can start a session", () => {
    // The cold-boot rail regression: postInitialState's startSession branch
    // can assign focused.client before the handler resumes; evaluating
    // shouldRehydrateOnWebviewReady afterwards misread that self-created
    // client as an incoming reload-rehydrate and skipped the catalog post.
    // Lock the ORDER, not just the presence of the call.
    const sidebar = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const caseStart = sidebar.indexOf('case "ready": {');
    expect(caseStart).toBeGreaterThan(-1);
    const caseEnd = sidebar.indexOf("break;", caseStart);
    const body = sidebar.slice(caseStart, caseEnd);
    const decide = body.indexOf("shouldRehydrateOnWebviewReady");
    const boot = body.indexOf("this.postInitialState()");
    expect(decide).toBeGreaterThan(-1);
    expect(boot).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(boot);
    expect(body).toContain("if (!rehydrating)");
    expect(body).toContain("this.postRepoCatalog()");
  });

  it("unlocks once the session is actually ready", () => {
    const session = new Session();
    session.priming = false;
    session.client = fakeClient("abc");
    session.status = "idle";
    expect(rehydrateBusyChrome(session)).toEqual({ value: false, locked: false });

    session.status = "working";
    expect(rehydrateBusyChrome(session)).toEqual({ value: true, locked: false });
  });
});
