/**
 * The composer's height ceiling, in lines (#144, owner 2026-09-04).
 *
 * A phone stops at 6 and everything else at 9. The reason is not screen size in
 * the abstract: on a phone the keyboard already owns the bottom half, so a box
 * that grows to nine lines on top of it leaves none of the conversation
 * readable while you write about it.
 *
 * Asserted on the decision rather than the rendered height, because happy-dom
 * performs no layout — `scrollHeight` is 0 there, so a height assertion would
 * pass no matter what the code did.
 */
import { describe, expect, it } from "vitest";
import { bootWebview } from "./webview-harness";

function maxLines(matches: boolean): number {
  const h = bootWebview({ ready: true });
  (h.window as any).matchMedia = (query: string) => ({
    media: query,
    matches: matches && /hover: none|pointer: coarse/.test(query),
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  return (h.window as any).__grokComposerMaxLines();
}

describe("composer height ceiling", () => {
  it("stops at 6 lines on a coarse-pointer device, so the keyboard leaves something to read", () => {
    expect(maxLines(true)).toBe(6);
  });

  it("allows 10 everywhere else", () => {
    expect(maxLines(false)).toBe(10);
  });

  it("falls back to the desktop ceiling when matchMedia is missing", () => {
    // Older webviews and the test harness itself: a missing capability must not
    // silently produce the phone value on a desktop.
    const h = bootWebview({ ready: true });
    (h.window as any).matchMedia = undefined;
    expect((h.window as any).__grokComposerMaxLines()).toBe(10);
  });
});
