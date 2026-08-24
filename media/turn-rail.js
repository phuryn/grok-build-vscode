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

  function helpersApi() {
    if (typeof module !== "undefined" && module.exports) {
      try { return require("./webview-helpers.js"); } catch (err) { return {}; }
    }
    return root.GrokWebviewHelpers || {};
  }

  function isCountable(el) {
    const fn = helpersApi().isCountableUserBubble;
    return typeof fn === "function" ? fn(el) : false;
  }

  function questionFromUserEl(userEl) {
    if (!userEl) return "(empty)";
    const copied = userEl._copyText;
    const body = userEl.querySelector && userEl.querySelector(":scope > .msg-bubble .body, :scope > .body");
    const raw = String(copied != null && copied !== "" ? copied : (body && body.textContent) || "").trim();
    if (raw) return raw;
    if (userEl.querySelector && userEl.querySelector(".msg-chip-preview")) return "(image)";
    if (userEl.querySelector && userEl.querySelector(".msg-chip")) return "(attachment)";
    return "(empty)";
  }

  function answerFromUserEl(userEl) {
    if (!userEl || !userEl.nextElementSibling) return "";
    const parts = [];
    for (let n = userEl.nextElementSibling; n; n = n.nextElementSibling) {
      if (isCountable(n)) break;
      if (!n.classList || !n.classList.contains("msg") || !n.classList.contains("agent")) continue;
      const body = n.querySelector && n.querySelector(":scope > .body");
      const text = body && body.textContent ? body.textContent.trim() : "";
      if (text) parts.push(text);
    }
    return parts.join("\n");
  }

  const api = { QUESTION_MAX, ANSWER_MAX, truncatePreview, questionFromUserEl, answerFromUserEl };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GrokTurnRail = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
