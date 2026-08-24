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
    expect(truncatePreview("hello", ANSWER_MAX)).toBe("hello");
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
    expect(out).toBe("👍".repeat(80) + "…");
  });

  it("falls back to code points when Segmenter is missing", () => {
    const intl = globalThis.Intl;
    const origDesc = intl ? Object.getOwnPropertyDescriptor(intl, "Segmenter") : undefined;
    try {
      if (intl) {
        intl.Segmenter = undefined;
        if (intl.Segmenter) {
          Object.defineProperty(intl, "Segmenter", {
            configurable: true,
            writable: true,
            value: undefined,
          });
        }
      }
      expect(intl && intl.Segmenter).toBeFalsy();
      expect(truncatePreview("abcdef", 3)).toBe("abc…");
    } finally {
      if (intl && origDesc) Object.defineProperty(intl, "Segmenter", origDesc);
    }
  });
});
