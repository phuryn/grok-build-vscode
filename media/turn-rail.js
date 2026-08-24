(function (root) {
  "use strict";

  const QUESTION_MAX = 80;
  const ANSWER_MAX = 160;

  function clustersOf(text) {
    const s = String(text == null ? "" : text);
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      return Array.from(seg.segment(s), (part) => part.segment);
    }
    return [...s];
  }

  function truncatePreview(text, max) {
    const n = Math.max(0, Number(max) || 0);
    const parts = clustersOf(text);
    if (parts.length <= n) return parts.join("");
    return parts.slice(0, n).join("") + "…";
  }

  const api = { QUESTION_MAX, ANSWER_MAX, truncatePreview };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GrokTurnRail = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
