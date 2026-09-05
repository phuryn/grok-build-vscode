import { describe, it, expect, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import {
  parseRewindPoint,
  parseRewindPoints,
  parseRewindExecute,
  formatRewindPointLabel,
  formatRewindPointDetail,
  selectableRewindPoints,
  userFacingRewindPoints,
  resolveUserBubbleRewind,
  isHiddenRewindPoint,
  rewindConfirmMessage,
  resolveEditRewindTarget,
  survivingUserMessagesAfterRewind,
  truncateReplayBuffer,
  anyFilesAfter,
  bubbleMapIsConsistent,
  editRewindConfirmMessage,
  REWIND_MODES,
} from "../src/rewind";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeRewindSidebar(hasFiles = true) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.activeSessionId = "original-session";
  session.hasHistory = true;
  session.userMessageCount = 2;
  session.status = "done";
  const points = [0, 1].map((promptIndex) => ({
    promptIndex, createdAt: "t", promptPreview: `message ${promptIndex}`,
    hasFileChanges: hasFiles, numFileSnapshots: hasFiles ? 1 : 0,
  }));
  const fakeClient = () => ({
    listRewindPoints: vi.fn(async () => points),
    executeRewind: vi.fn(async () => "unsupported"),
  });
  const original = fakeClient();
  const replacement = fakeClient();
  session.client = original as any;
  sidebar.focused = session;
  sidebar.workspaceRoot = () => "/repo";
  sidebar.remoteClients = new RemoteClientState<Session>("/repo");
  sidebar.remoteClients.ready("browser-view");
  sidebar.remoteClients.setActive("browser-view", session);
  sidebar.pendingConfirms = new Map();
  sidebar.confirmSeq = 0;
  const confirmation = deferred<string>();
  sidebar.emit = vi.fn((_session, msg) => {
    if (msg.type === "uiConfirmRequest") confirmation.resolve(msg.id);
  });
  sidebar.host = {
    appendLine: vi.fn(), showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(), showErrorMessage: vi.fn(),
  };
  sidebar.sendRemoteClient = vi.fn();
  vi.spyOn(sidebar, "reportRequester");
  sidebar.applyRewindToView = vi.fn();
  sidebar.restoreComposerFor = vi.fn();
  sidebar.truncateSessionCardsAfterRewind = vi.fn();
  return { sidebar, session, original, replacement, points, confirmation };
}

describe.each(["editLastMessage", "rewindSession"] as const)("%s lifecycle", (type) => {
  const request = { type, userBubbleIndex: 0, text: "original draft", totalUserBubbles: 2 };

  describe.each(["confirmation", "listing"] as const)("delayed %s", (delay) => {
    it.each(["new-turn", "started-and-finished-turn", "replaced-client"])("refuses a stale browser request after %s", async (change) => {
      // Both views hold the same Session object. Listing-only cases have no
      // file changes, so they must be guarded even without a confirmation.
      const { sidebar, session, original, replacement, points, confirmation } = makeRewindSidebar(delay === "confirmation");
      const listing = deferred<typeof points>();
      if (delay === "listing") original.listRewindPoints.mockReturnValueOnce(listing.promise);
      const pending = sidebar.onMessage(request, "remote", "browser-view");
      const id = delay === "confirmation" ? await confirmation.promise : undefined;
      expect(original.listRewindPoints).toHaveBeenCalledOnce();
      expect(original.executeRewind).not.toHaveBeenCalled();

      if (change !== "replaced-client") {
        // The desk starts another turn while the browser is waiting.
        session.status = "working";
        session.userMessageCount++;
        // Finishing leaves client, generation and session id unchanged.
        if (change === "started-and-finished-turn") session.status = "done";
      } else {
        session.gen++;
        session.activeSessionId = "replacement-session";
        session.client = replacement as any;
      }

      if (id) await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: true }, "remote", "browser-view");
      else listing.resolve(points);
      await pending;

      expect(original.executeRewind).not.toHaveBeenCalled();
      expect(replacement.executeRewind).not.toHaveBeenCalled();
      expect(sidebar.reportRequester).toHaveBeenCalledOnce();
      expect(sidebar.reportRequester).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: "browser-view" }), "warning",
        expect.stringMatching(/(?:Edit|Rewind) cancelled because the conversation changed or another turn started/),
      );
      expect(sidebar.sendRemoteClient).toHaveBeenCalledWith("browser-view", expect.objectContaining({
        type: "hostNotice", level: "warning", text: expect.stringContaining("Nothing was rewound."),
      }));
      expect(sidebar.host.showWarningMessage).not.toHaveBeenCalled();
      expect(sidebar.applyRewindToView).not.toHaveBeenCalled();
      expect(sidebar.restoreComposerFor).not.toHaveBeenCalled();
      expect(sidebar.truncateSessionCardsAfterRewind).not.toHaveBeenCalled();
    });
  });

  it.each(["client", "generation", "session-id", "needs-you"])("independently rechecks %s for a desk confirmation", async (change) => {
    const { sidebar, session, original, replacement, confirmation } = makeRewindSidebar();
    const pending = sidebar.onMessage(request, "local");
    const id = await confirmation.promise;
    if (change === "client") session.client = replacement as any;
    if (change === "generation") session.gen++;
    if (change === "session-id") session.activeSessionId = "replacement-session";
    if (change === "needs-you") session.status = "needs-you";
    await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: true }, "local");
    await pending;
    expect(original.executeRewind).not.toHaveBeenCalled();
    expect(replacement.executeRewind).not.toHaveBeenCalled();
    expect(sidebar.reportRequester).toHaveBeenCalledOnce();
    expect(sidebar.reportRequester).toHaveBeenCalledWith(
      undefined, "warning", expect.stringContaining("Nothing was rewound."),
    );
    expect(sidebar.host.showWarningMessage).toHaveBeenCalledOnce();
    expect(sidebar.sendRemoteClient).not.toHaveBeenCalled();
  });

  it.each([true, false])("still executes an unchanged, finished conversation (file changes: %s)", async (hasFiles) => {
    const { sidebar, original, confirmation } = makeRewindSidebar(hasFiles);
    const pending = sidebar.onMessage(request, "remote", "browser-view");
    if (hasFiles) {
      const id = await confirmation.promise;
      await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: true }, "remote", "browser-view");
    }
    await pending;
    expect(original.executeRewind).toHaveBeenCalledOnce();
    expect(original.executeRewind).toHaveBeenCalledWith({ targetPromptIndex: 0, mode: "all" });
  });

  it("still cancels when the confirmation is declined", async () => {
    const { sidebar, original, confirmation } = makeRewindSidebar();
    const pending = sidebar.onMessage(request, "remote", "browser-view");
    const id = await confirmation.promise;
    await sidebar.onMessage({ type: "uiConfirmAnswer", id, ok: false }, "remote", "browser-view");
    await pending;
    expect(original.executeRewind).not.toHaveBeenCalled();
    expect(sidebar.reportRequester).not.toHaveBeenCalled();
  });
});

describe("parseRewindPoints", () => {
  const row = {
    prompt_index: 0,
    created_at: "2026-07-23T03:00:00Z",
    num_file_snapshots: 2,
    has_file_changes: true,
    prompt_preview: "Fix the auth bug",
  };

  it("parses bare { rewind_points }", () => {
    const pts = parseRewindPoints({ rewind_points: [row] });
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({
      promptIndex: 0,
      createdAt: "2026-07-23T03:00:00Z",
      numFileSnapshots: 2,
      hasFileChanges: true,
      promptPreview: "Fix the auth bug",
    });
  });

  it("unwraps a double-wrapped result", () => {
    expect(parseRewindPoints({ result: { rewind_points: [row] } })).toHaveLength(1);
  });

  it("parses a bare array", () => {
    expect(parseRewindPoints([row])).toHaveLength(1);
  });

  it("returns [] for empty / garbage", () => {
    expect(parseRewindPoints(null)).toEqual([]);
    expect(parseRewindPoints({})).toEqual([]);
    expect(parseRewindPoints({ rewind_points: [] })).toEqual([]);
  });

  it("skips rows without a valid prompt_index", () => {
    expect(parseRewindPoint({ prompt_preview: "x" })).toBeNull();
    expect(parseRewindPoint({ prompt_index: -1 })).toBeNull();
  });

  it("accepts camelCase fallbacks", () => {
    const p = parseRewindPoint({
      promptIndex: 3,
      createdAt: "t",
      numFileSnapshots: 0,
      hasFileChanges: false,
      promptPreview: "hi",
    });
    expect(p?.promptIndex).toBe(3);
    expect(p?.promptPreview).toBe("hi");
  });
});

describe("parseRewindExecute", () => {
  it("parses a successful execute result", () => {
    const r = parseRewindExecute({
      success: true,
      target_prompt_index: 1,
      mode: "all",
      reverted_files: ["a.ts"],
      clean_files: [],
      conflicts: [],
      prompt_text: "Say B",
      error: null,
    });
    expect(r).toEqual({
      success: true,
      targetPromptIndex: 1,
      mode: "all",
      revertedFiles: ["a.ts"],
      cleanFiles: [],
      conflicts: [],
      promptText: "Say B",
      error: null,
    });
  });

  it("parses success:false with an error string", () => {
    const r = parseRewindExecute({
      success: false,
      target_prompt_index: 0,
      mode: "all",
      reverted_files: [],
      clean_files: [],
      conflicts: [],
      prompt_text: null,
      error: "Cannot rewind to prompt #0 — current prompt index is 0",
    });
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/Cannot rewind/);
  });

  it("returns null without a boolean success", () => {
    expect(parseRewindExecute({ target_prompt_index: 1 })).toBeNull();
    expect(parseRewindExecute(null)).toBeNull();
  });

  it("unwraps double-wrapped payloads", () => {
    const r = parseRewindExecute({
      result: {
        success: true,
        target_prompt_index: 0,
        mode: "conversation_only",
        reverted_files: [],
        clean_files: [],
        conflicts: [],
        prompt_text: "x",
        error: null,
      },
    });
    expect(r?.mode).toBe("conversation_only");
  });
});

describe("selectableRewindPoints / labels", () => {
  const pts = [
    { promptIndex: 0, createdAt: "2026-07-23T01:00:00Z", numFileSnapshots: 0, hasFileChanges: false, promptPreview: "alpha" },
    { promptIndex: 1, createdAt: "2026-07-23T01:01:00Z", numFileSnapshots: 1, hasFileChanges: true, promptPreview: "beta" },
    { promptIndex: 2, createdAt: "2026-07-23T01:02:00Z", numFileSnapshots: 0, hasFileChanges: false, promptPreview: "gamma" },
  ];

  it("drops the latest tip (no-op target)", () => {
    const sel = selectableRewindPoints(pts);
    expect(sel.map((p) => p.promptIndex)).toEqual([0, 1]);
  });

  it("returns [] when only one point exists", () => {
    expect(selectableRewindPoints([pts[0]])).toEqual([]);
    expect(selectableRewindPoints([])).toEqual([]);
  });

  it("numbers by VISIBLE position, never the wire prompt_index", () => {
    // The wire index counts turns the user can't see (hidden primer, marker-only
    // plan verdicts), so labelling with it yields "#1 #2 … #6 #8" — a sequence
    // that matches nothing on screen.
    expect(formatRewindPointLabel(pts[0], 1)).toBe("1. alpha");
    expect(formatRewindPointLabel(pts[1], 2)).toBe("2. beta · 1 file");
  });

  it("drops the number entirely when there is no visible position", () => {
    // Better no number than a wrong one.
    expect(formatRewindPointLabel(pts[0])).toBe("alpha");
    expect(formatRewindPointLabel(pts[1], 0)).toBe("beta · 1 file");
  });

  it("formats a locale timestamp detail", () => {
    const d = formatRewindPointDetail(pts[0]);
    expect(d).toBeTruthy();
    expect(formatRewindPointDetail({ ...pts[0], createdAt: "" })).toBeUndefined();
  });

  it("builds a confirm message for the target bubble", () => {
    const msg = rewindConfirmMessage(pts[1], "all");
    expect(msg).toMatch(/Rewind to this message/i);
    expect(msg).toContain("beta");
    expect(msg).toMatch(/discarded|restored/i);
  });
});

describe("REWIND_MODES", () => {
  it("lists the four wire modes", () => {
    expect(REWIND_MODES).toEqual(["all", "conversation_only", "code_only", "files_only"]);
  });
});

describe("userFacingRewindPoints / resolveUserBubbleRewind", () => {
  const primer = {
    promptIndex: 0,
    createdAt: "t0",
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview: "[grok-build-vscode primer v4]\n\n## HIDDEN PRIMER",
  };
  const u0 = {
    promptIndex: 1,
    createdAt: "t1",
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview: "first user message",
  };
  const u1 = {
    promptIndex: 2,
    createdAt: "t2",
    numFileSnapshots: 1,
    hasFileChanges: true,
    promptPreview: "second user message",
  };
  const u2 = {
    promptIndex: 3,
    createdAt: "t3",
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview: "third user message",
  };
  const all = [primer, u0, u1, u2];

  it("hides the primer and system-reminder points", () => {
    expect(isHiddenRewindPoint(primer)).toBe(true);
    expect(isHiddenRewindPoint(u0)).toBe(false);
    expect(
      isHiddenRewindPoint({
        ...u0,
        promptPreview: "<system-reminder>bg task</system-reminder>",
      }),
    ).toBe(true);
  });

  it("maps bubble index past the primer to the wire prompt_index", () => {
    const facing = userFacingRewindPoints(all);
    expect(facing.map((p) => p.promptIndex)).toEqual([1, 2, 3]);
    expect(resolveUserBubbleRewind(all, 0)?.promptIndex).toBe(1);
    expect(resolveUserBubbleRewind(all, 1)?.promptIndex).toBe(2);
  });

  it("returns null for the tip bubble and out-of-range", () => {
    expect(resolveUserBubbleRewind(all, 2)).toBeNull(); // tip
    expect(resolveUserBubbleRewind(all, 99)).toBeNull();
    expect(resolveUserBubbleRewind(all, -1)).toBeNull();
  });

  it("works when there is no primer", () => {
    const bare = [u0, u1].map((p, i) => ({ ...p, promptIndex: i }));
    expect(resolveUserBubbleRewind(bare, 0)?.promptIndex).toBe(0);
    expect(resolveUserBubbleRewind(bare, 1)).toBeNull();
  });
});


// Edit-and-resend (#56).
//
// PROBE-VERIFIED SEMANTICS (research/rewind-semantics-probe.cjs, CLI 0.2.111):
// `_x.ai/rewind/execute` DISCARDS the target prompt as well as everything after
// it. A 4-prompt session rewound to #1 went 4 points -> 1; rewound to the tip
// #3 it went 4 -> 3. The tip IS a legal target.
//
// The method name reads like "rewind TO N, keeping N". It does not. Building on
// that reading made Edit eat one extra turn every time, so these tests assert
// the target is the edited message's OWN point.
describe("resolveEditRewindTarget (#56)", () => {
  const pt = (promptIndex: number, promptPreview: string) => ({
    promptIndex,
    createdAt: `t${promptIndex}`,
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview,
  });
  const primer = pt(0, "[grok-build-vscode primer v4]\n\n## HIDDEN PRIMER");
  const one = pt(1, "I'm testing something. Repeat after me: One");
  const two = pt(2, "Two");
  const three = pt(3, "Three");
  const four = pt(4, "Four");
  const all = [primer, one, two, three, four];

  it("targets the edited message ITSELF, so only that turn is discarded", () => {
    // The reported bug: editing "Four" (bubble 3) targeted "Three" and lost it
    // too. It must target #4.
    expect(resolveEditRewindTarget(all, 3)?.promptIndex).toBe(4);
  });

  it("maps every bubble to its own point, primer skipped", () => {
    expect([0, 1, 2, 3].map((i) => resolveEditRewindTarget(all, i)?.promptIndex))
      .toEqual([1, 2, 3, 4]);
  });

  it("targets the first user message's own point, leaving the primer intact", () => {
    // #1 is discarded, #0 (the primer + its "ok") survives — which it must, or
    // the session loses the plan-verdict protocol.
    expect(resolveEditRewindTarget(all, 0)?.promptIndex).toBe(1);
  });

  it("works on an unprimed session's first message", () => {
    const bare = [pt(0, "only message")];
    expect(resolveEditRewindTarget(bare, 0)?.promptIndex).toBe(0);
  });

  it("is not confused by an unsorted points array", () => {
    expect(resolveEditRewindTarget([four, primer, two, one, three], 3)?.promptIndex).toBe(4);
  });

  it("returns null for a bubble with no point — NOT a wrong-turn guess", () => {
    // A steered message paints a bubble but has no rewind point, so the index
    // can overrun the list. Guessing here would discard someone else's turn.
    expect(resolveEditRewindTarget(all, 4)).toBeNull();
    expect(resolveEditRewindTarget([], 0)).toBeNull();
  });

  it("rejects a non-integer / negative index", () => {
    expect(resolveEditRewindTarget(all, -1)).toBeNull();
    expect(resolveEditRewindTarget(all, 1.5)).toBeNull();
    expect(resolveEditRewindTarget(all, NaN)).toBeNull();
  });

  it("confirm text promises the message comes back, and names files only when there are some", () => {
    const withFiles = editRewindConfirmMessage({ ...three, hasFileChanges: true }, true);
    expect(withFiles).toContain("put back in the composer");
    expect(withFiles).toContain("files it changed in that turn will be restored");
    const noFiles = editRewindConfirmMessage(three, false);
    expect(noFiles).toContain("Earlier messages are untouched");
    expect(noFiles).not.toContain("files it changed");
  });
});

// The confirm dialog is the only place the user learns what they're about to
// lose. It said "Conversation AFTER this turn will be discarded", which claimed
// the clicked message survives — the opposite of what the wire does.
describe("rewindConfirmMessage matches the wire's discard semantics", () => {
  const p = {
    promptIndex: 2,
    createdAt: "t",
    numFileSnapshots: 1,
    hasFileChanges: true,
    promptPreview: "beta",
  };

  it("says THIS message goes too, not just what follows", () => {
    for (const mode of ["all", "conversation_only"] as const) {
      const msg = rewindConfirmMessage(p, mode);
      expect(msg).toContain("This message and everything after it");
      expect(msg).not.toMatch(/after this turn will be discarded/i);
    }
  });

  it("files-only still leaves the conversation alone", () => {
    expect(rewindConfirmMessage(p, "files_only")).toContain("conversation stays");
  });
});

// The count handed to truncateResolvedAfter after a rewind. Execute discards
// the target, so the survivors are the user-facing points strictly before it.
describe("survivingUserMessagesAfterRewind", () => {
  const pt = (promptIndex: number, promptPreview: string) => ({
    promptIndex,
    createdAt: `t${promptIndex}`,
    numFileSnapshots: 0,
    hasFileChanges: false,
    promptPreview,
  });
  // Mirrors the real reported session: primer, six bubbles, a marker-only plan
  // verdict at #7 that renders no bubble, then a final bubble at #8.
  const all = [
    pt(0, "[grok-build-vscode primer v4]"),
    pt(1, "One"),
    pt(2, "Two"),
    pt(3, "Three"),
    pt(6, "Present a no-op plan"),
    pt(7, "[Plan rejected]"),
    pt(8, "Repeat: Six"),
  ];

  it("counts only the bubbles before the discarded target", () => {
    expect(survivingUserMessagesAfterRewind(all, pt(8, "Repeat: Six"))).toBe(4);
  });

  it("does not count hidden plumbing points (primer / plan verdict)", () => {
    // #7 is a marker-only verdict and #0 the primer — neither is a user bubble,
    // so neither may inflate the count or every card lands one turn too late.
    expect(survivingUserMessagesAfterRewind(all, pt(6, "Present a no-op plan"))).toBe(3);
  });

  it("is 0 when the first user message is discarded", () => {
    expect(survivingUserMessagesAfterRewind(all, pt(1, "One"))).toBe(0);
  });

  it("counts every bubble when the target is past them all", () => {
    expect(survivingUserMessagesAfterRewind(all, pt(99, "future"))).toBe(5);
  });
});

// The replay buffer is what a focus-swap replays to rebuild the chat, so it has
// to be cut at the same point the DOM is — otherwise switching sessions and back
// resurrects every turn the rewind just discarded.
describe("truncateReplayBuffer", () => {
  const u = (steer?: boolean) => ({ type: "userMessage", ...(steer ? { steer: true } : {}) });
  const a = { type: "agentEnd" };
  const t = { type: "toolCall" };

  it("keeps everything before the first discarded user message", () => {
    const buf = [u(), a, u(), t, a, u(), a];
    expect(truncateReplayBuffer(buf, 2)).toEqual([u(), a, u(), t, a]);
  });

  it("keeps the whole buffer when nothing is discarded", () => {
    const buf = [u(), a, u(), a];
    expect(truncateReplayBuffer(buf, 2)).toBe(buf);
    expect(truncateReplayBuffer(buf, 5)).toBe(buf);
  });

  it("empties the buffer when no message survives", () => {
    expect(truncateReplayBuffer([u(), a, u(), a], 0)).toEqual([]);
  });

  it("does NOT count steered messages — they bubble but aren't prompts", () => {
    // Same rule as the DOM: a steer has no rewind point. Counting it would cut
    // one turn early and drop a message the CLI still has. Here the steer rides
    // inside surviving turn 1, so it stays and shifts nothing.
    const buf = [u(), a, u(true), a, u(), a, u(), a];
    expect(truncateReplayBuffer(buf, 2)).toEqual([u(), a, u(true), a, u(), a]);
  });

  it("keeps a steer that belongs to the last surviving turn", () => {
    const buf = [u(), a, u(), u(true), a, u(), a];
    expect(truncateReplayBuffer(buf, 2)).toEqual([u(), a, u(), u(true), a]);
  });

  it("does not mutate the input", () => {
    const buf = [u(), a, u(), a];
    truncateReplayBuffer(buf, 1);
    expect(buf).toHaveLength(4);
  });

  it("treats a negative count as everything discarded", () => {
    expect(truncateReplayBuffer([u(), a], -1)).toEqual([]);
  });
});

// Whether a rewind shows a confirm at all. mode:"all" restores files for the
// target AND every turn after it, so checking the target alone under-reports —
// and under-reporting here means silently reverting code with no warning.
describe("anyFilesAfter (drives whether we confirm)", () => {
  const pt = (promptIndex: number, hasFileChanges = false) => ({
    promptIndex, createdAt: "t", numFileSnapshots: hasFileChanges ? 1 : 0,
    hasFileChanges, promptPreview: "p" + promptIndex,
  });

  it("is false for a chat-only rewind — no dialog needed", () => {
    const pts = [pt(0), pt(1), pt(2)];
    expect(anyFilesAfter(pts, pts[1])).toBe(false);
  });

  it("is true when the target itself touched files", () => {
    const pts = [pt(0), pt(1, true), pt(2)];
    expect(anyFilesAfter(pts, pts[1])).toBe(true);
  });

  it("is true when a LATER turn touched files — the under-report case", () => {
    // Rewinding to #1 also reverts #2's edits, so the target's own flag is not
    // enough to decide whether code is at stake.
    const pts = [pt(0), pt(1), pt(2, true)];
    expect(anyFilesAfter(pts, pts[1])).toBe(true);
  });

  it("ignores file changes in EARLIER turns, which survive the rewind", () => {
    const pts = [pt(0, true), pt(1), pt(2)];
    expect(anyFilesAfter(pts, pts[1])).toBe(false);
  });

  it("handles an empty point list", () => {
    expect(anyFilesAfter([], pt(0))).toBe(false);
  });
});

// The bubble→point map rests on two heuristics that can drift: preview-text
// detection of plumbing turns, and the CLI's interjection wording for steers.
// Drift doesn't error — it targets the WRONG turn and reverts the wrong files.
// So the counts are compared before executing, and a mismatch refuses.
describe("bubbleMapIsConsistent (refuse rather than mis-target)", () => {
  const pt = (promptIndex: number, promptPreview: string) => ({
    promptIndex, createdAt: "t", numFileSnapshots: 0, hasFileChanges: false, promptPreview,
  });
  const primer = pt(0, "[grok-build-vscode primer v4]");
  const pts = [primer, pt(1, "one"), pt(2, "two")];

  it("agrees when the wire and the screen match", () => {
    expect(bubbleMapIsConsistent(pts, 2)).toBe(true);
  });

  it("catches an unrecognized plumbing turn — the dangerous direction", () => {
    // A new silent turn shape we don't filter shows up as an extra wire point,
    // so bubble N would map one turn too late and revert someone else's edits.
    const withUnknownPlumbing = [...pts, pt(3, "<new-synthetic-shape/>")];
    expect(bubbleMapIsConsistent(withUnknownPlumbing, 2)).toBe(false);
  });

  it("catches a steer we failed to recognize on restore", () => {
    // If the interjection wording changes, the webview counts the steer as a
    // real bubble: 3 on screen, 2 on the wire.
    expect(bubbleMapIsConsistent(pts, 3)).toBe(false);
  });

  it("skips the check for an older webview that sends no count", () => {
    // Absent field must not break rewind for a stale webview.
    expect(bubbleMapIsConsistent(pts, undefined)).toBe(true);
  });

  it("handles the empty conversation", () => {
    expect(bubbleMapIsConsistent([], 0)).toBe(true);
    expect(bubbleMapIsConsistent([], 1)).toBe(false);
  });
});
