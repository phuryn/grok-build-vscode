import { describe, expect, it } from "vitest";
// @ts-expect-error Plain-JS webview module, no TS build step.
import { QUESTION_MAX, ANSWER_MAX, truncatePreview } from "../media/turn-rail.js";

describe("truncatePreview", () => {
  it("exports 80 / 160 caps", () => {
    expect(QUESTION_MAX).toBe(80);
    expect(ANSWER_MAX).toBe(160);
  });

  it("leaves short text alone", () => {
    expect(truncatePreview("hello", 80)).toBe("hello");
    expect(truncatePreview("", 80)).toBe("");
  });

  it("caps CJK at max clusters and appends an ellipsis", () => {
    const text = "汉".repeat(81);
    const out = truncatePreview(text, 80);
    expect(out).toBe("汉".repeat(80) + "…");
    expect([...out].length).toBe(81);
  });

  it("keeps a simple emoji whole", () => {
    const text = "👍".repeat(81);
    const out = truncatePreview(text, 80);
    expect(out.startsWith("👍")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.includes("\uD83D") && out.indexOf("\uD83D") === out.length - 1).toBe(false);
  });

  it("falls back to code points when Segmenter is missing", () => {
    const orig = globalThis.Intl && globalThis.Intl.Segmenter;
    if (globalThis.Intl) globalThis.Intl.Segmenter = undefined;
    try {
      expect(truncatePreview("abcdef", 3)).toBe("abc…");
    } finally {
      if (globalThis.Intl && orig) globalThis.Intl.Segmenter = orig;
    }
  });
});
