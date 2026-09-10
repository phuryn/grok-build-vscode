import { describe, expect, it } from "vitest";
import { bootWebview } from "./webview-harness";

/**
 * What happens when you DUPLICATE a browser tab.
 *
 * Duplication copies sessionStorage, so the new page starts holding the
 * original's tab token and its remembered conversation. Two tabs presenting one
 * token is not a cosmetic problem: the relay treats a repeated token as the
 * same tab reconnecting and deliberately retires the predecessor's socket, so
 * the duplicate's arrival KICKS THE ORIGINAL OFF the conversation.
 *
 * `claimRemoteTabIdentity` in media/chat.js exists to prevent that. The
 * duplicate announces itself on a BroadcastChannel and waits
 * REMOTE_TAB_CLAIM_TIMEOUT_MS (250ms) for an answer. An incumbent that answers
 * says "occupied", and the duplicate then takes a fresh identity.
 *
 * The 250ms is the whole problem, and these tests exist to pin it down.
 * `settle()` carries a latch, so the FIRST outcome wins and everything after is
 * a no-op — including the incumbent's answer when it arrives at 251ms. A
 * background tab is timer-throttled by every mobile browser, and 250ms sits
 * inside that throttling window, so a late answer is the ordinary case on a
 * phone rather than the rare one.
 *
 * This was previously filed in the backlog as a saturation flake in
 * `webview-ui.dom.test.ts`, on reasoning that turned out to be about an
 * entirely different suite. It is not a flake. It is timing-dependent, which is
 * why it surfaced on a loaded machine first, and the delivery delay here is
 * what makes it deterministic instead.
 */

const CLAIM_TIMEOUT_MS = 250;
const TOKEN_KEY = "grok.remote.tabToken:default";
const OWNER_KEY = "grok.remote.tabOwner:default";
const SESSION_KEY = "grok.remote.tabSession:default";

/**
 * A BroadcastChannel that delivers after a stated delay, so "the incumbent
 * answered in time" and "the incumbent answered late" are two runs of one test
 * rather than two outcomes of one race. The shipped fixture in
 * webview-ui.dom.test.ts delivers on a 0ms timer, which wins the race on an
 * idle box and loses it on a busy one — that is the flake, not the defect.
 */
function channelFixture(deliverAfterMs: number) {
  const channels: Array<{
    name: string;
    closed: boolean;
    onmessage?: (event: { data: unknown }) => void;
  }> = [];
  return class FakeBroadcastChannel {
    closed = false;
    onmessage?: (event: { data: unknown }) => void;

    constructor(readonly name: string) {
      channels.push(this);
    }

    postMessage(data: unknown) {
      for (const peer of channels) {
        if (peer !== this && !peer.closed && peer.name === this.name) {
          setTimeout(() => peer.onmessage?.({ data }), deliverAfterMs);
        }
      }
    }

    close() {
      this.closed = true;
    }
  };
}

const remembered = { id: "copied-session", repoCwd: "/work/repo-b", cwd: "/work/repo-b" };

/**
 * Boot an original tab, then a duplicate of it sharing one channel.
 *
 * `withIncumbent: false` is the tab that CRASHED rather than one that was
 * duplicated: sessionStorage still names a prior owner, because `pagehide`
 * never ran to clear it, but there is nobody alive to answer the probe. An
 * ordinary reload is not this case — its `pagehide` does run, the key is
 * cleared, and the reloaded page never probes at all.
 */
async function duplicateTab(opts: { deliverAfterMs: number; withIncumbent?: boolean }) {
  const FakeBroadcastChannel = channelFixture(opts.deliverAfterMs);
  const withIncumbent = opts.withIncumbent !== false;

  const original = bootWebview({
    remote: true,
    beforeScripts: (w: Window) => {
      (w as unknown as { BroadcastChannel: unknown }).BroadcastChannel = FakeBroadcastChannel;
      w.sessionStorage.setItem(SESSION_KEY, JSON.stringify(remembered));
    },
  });
  await (original.window as unknown as { __grokTabTokenReady: Promise<string> }).__grokTabTokenReady;
  const originalToken = original.window.sessionStorage.getItem(TOKEN_KEY)!;
  const originalOwner = original.window.sessionStorage.getItem(OWNER_KEY)!;

  const duplicate = bootWebview({
    remote: true,
    beforeScripts: (w: Window) => {
      // A crashed tab left the same three keys behind; what differs is whether
      // anything is listening on the channel, so the fixture is simply not
      // shared in that case.
      (w as unknown as { BroadcastChannel: unknown }).BroadcastChannel = withIncumbent
        ? FakeBroadcastChannel
        : channelFixture(opts.deliverAfterMs);
      w.sessionStorage.setItem(TOKEN_KEY, originalToken);
      w.sessionStorage.setItem(OWNER_KEY, originalOwner);
      w.sessionStorage.setItem(SESSION_KEY, JSON.stringify(remembered));
    },
  });

  const settledToken = await (duplicate.window as unknown as {
    __grokTabTokenReady: Promise<string | undefined>;
  }).__grokTabTokenReady;
  await Promise.resolve();

  return {
    originalToken,
    settledToken,
    duplicateToken: duplicate.window.sessionStorage.getItem(TOKEN_KEY),
    rememberedSession: duplicate.window.sessionStorage.getItem(SESSION_KEY),
    ready: duplicate.posted.find((message) => message.type === "ready"),
  };
}

describe("a duplicated tab must not claim the original's identity", () => {
  it("takes a fresh identity when the incumbent answers in time", async () => {
    const out = await duplicateTab({ deliverAfterMs: 0 });

    expect(out.duplicateToken).not.toBe(out.originalToken);
    expect(out.settledToken).toBe(out.duplicateToken);
    // And it drops the copied conversation, so the duplicate does not resume
    // into the original's session under a different name.
    expect(out.rememberedSession).toBeNull();
    expect(out.ready).toEqual({ type: "ready", tabToken: out.duplicateToken });
  });

  // THE DEFECT. Flip this to `it` when the claim no longer settles on a guess.
  // It is written as `it.fails` deliberately: encoded that way it fails the
  // build the moment the behaviour is fixed, so the fix cannot land while the
  // reproducer still claims the bug is present.
  //
  // 251ms is not an exotic number. It is a phone that backgrounded the first
  // tab, which every mobile browser throttles.
  it.fails("takes a fresh identity when the incumbent answers LATE", async () => {
    const out = await duplicateTab({ deliverAfterMs: CLAIM_TIMEOUT_MS + 150 });

    // Today: the 250ms timer settles first, `settled` latches, and the
    // incumbent's answer is discarded. The duplicate keeps the copied token and
    // announces `ready` with it — and the relay retires the original's socket.
    expect(out.duplicateToken).not.toBe(out.originalToken);
    expect(out.ready).toEqual({ type: "ready", tabToken: out.duplicateToken });
  }, 10_000);

  // The constraint any fix has to respect, and the reason the timeout defaults
  // to keeping the identity today. Nobody is alive to answer, so replacing here
  // would cost a restored tab its conversation for nothing.
  it("keeps its identity when there is no incumbent to answer", async () => {
    const out = await duplicateTab({
      deliverAfterMs: CLAIM_TIMEOUT_MS + 150,
      withIncumbent: false,
    });

    expect(out.duplicateToken).toBe(out.originalToken);
    expect(out.settledToken).toBe(out.originalToken);
    expect(out.ready).toEqual({ type: "ready", tabToken: out.originalToken });
  }, 10_000);
});
