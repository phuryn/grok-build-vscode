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

  function displayQuestion(turn) {
    return truncatePreview(turn && turn.question || "", QUESTION_MAX);
  }

  function displayAnswer(turn) {
    const raw = (turn && turn.answer) || "";
    if (!raw && turn && turn.pending) return "Answering…";
    return truncatePreview(raw, ANSWER_MAX);
  }

  function clearChildren(el) {
    if (typeof el.replaceChildren === "function") {
      el.replaceChildren();
      return;
    }
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function createTurnRail(mount, host) {
    if (!mount || !host) return { refresh: function () {} };
    const hoverDelay = host.hoverDelayMs == null ? 150 : host.hoverDelayMs;
    let hoverTimer = 0;
    let hideTimer = 0;
    let popover = null;

    function hidePopover() {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
      if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
      popover = null;
    }

    function showPopover(bar, turn) {
      hidePopover();
      const doc = mount.ownerDocument;
      popover = doc.createElement("div");
      popover.className = "turn-rail-popover";
      popover.innerHTML =
        '<div class="turn-rail-k">Question</div>' +
        '<div class="turn-rail-q"></div>' +
        '<div class="turn-rail-k">Answer</div>' +
        '<div class="turn-rail-a"></div>';
      popover.querySelector(".turn-rail-q").textContent = displayQuestion(turn);
      popover.querySelector(".turn-rail-a").textContent = displayAnswer(turn);
      (mount.parentNode || doc.body).appendChild(popover);
      const br = bar.getBoundingClientRect();
      const pr = popover.getBoundingClientRect();
      const view = doc.defaultView;
      const viewH = view && view.innerHeight != null ? view.innerHeight : 0;
      let top = br.top;
      if (viewH && top + pr.height > viewH - 8) {
        top = Math.max(8, br.bottom - pr.height);
      }
      popover.style.position = "fixed";
      popover.style.left = Math.round(br.right + 6) + "px";
      popover.style.top = Math.round(top) + "px";
      popover.addEventListener("mouseleave", hidePopover);
    }

    function schedulePopover(bar, turn) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
      if (hoverDelay <= 0) {
        showPopover(bar, turn);
        return;
      }
      hoverTimer = setTimeout(function () { showPopover(bar, turn); }, hoverDelay);
    }

    function activeIndex(turns) {
      if (!turns.length) return -1;
      if (host.isStickToBottom && host.isStickToBottom()) return turns.length - 1;
      const box = host.messagesEl && host.messagesEl.getBoundingClientRect
        ? host.messagesEl.getBoundingClientRect()
        : null;
      if (!box) return 0;
      let best = -1;
      let bestDist = Infinity;
      let lastPassed = -1;
      turns.forEach(function (t, i) {
        if (!t.userEl || !t.userEl.getBoundingClientRect) return;
        const r = t.userEl.getBoundingClientRect();
        if (r.top <= box.top) lastPassed = i;
        if (r.bottom < box.top || r.top > box.bottom) return;
        const dist = Math.abs(r.top - box.top);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      if (best >= 0) return best;
      if (lastPassed >= 0) return lastPassed;
      return 0;
    }

    function updateActive() {
      const turns = (host.listTurns && host.listTurns()) || [];
      const current = activeIndex(turns);
      const bars = mount.querySelectorAll("button.turn-rail-bar");
      for (let i = 0; i < bars.length; i++) {
        if (i === current) bars[i].setAttribute("aria-current", "true");
        else bars[i].removeAttribute("aria-current");
      }
    }

    function refresh() {
      hidePopover();
      const turns = (host.listTurns && host.listTurns()) || [];
      clearChildren(mount);
      if (!turns.length) {
        mount.hidden = true;
        if (host.messagesEl && host.messagesEl.classList) {
          host.messagesEl.classList.remove("has-turn-rail");
        }
        return;
      }
      mount.hidden = false;
      if (host.messagesEl && host.messagesEl.classList) {
        host.messagesEl.classList.add("has-turn-rail");
      }
      const current = activeIndex(turns);
      turns.forEach(function (turn, i) {
        const bar = mount.ownerDocument.createElement("button");
        bar.type = "button";
        bar.className = "turn-rail-bar";
        bar.setAttribute("aria-label", displayQuestion(turn));
        if (i === current) bar.setAttribute("aria-current", "true");
        bar.addEventListener("click", function () {
          const el = turn.userEl;
          if (!el) return;
          let ok = false;
          try {
            ok = host.scrollToTurn(el);
          } catch (_err) {
            return;
          }
          if (ok && typeof bar.scrollIntoView === "function") {
            bar.scrollIntoView({ block: "nearest" });
          }
        });
        bar.addEventListener("mouseenter", function () {
          schedulePopover(bar, turn);
        });
        bar.addEventListener("mouseleave", function () {
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
          hideTimer = setTimeout(function () {
            hideTimer = 0;
            if (!popover) return;
            const over = popover.matches && popover.matches(":hover");
            if (!over) hidePopover();
          }, 50);
        });
        mount.appendChild(bar);
      });
    }

    if (typeof host.subscribe === "function") host.subscribe(refresh);
    if (host.messagesEl && host.messagesEl.addEventListener) {
      host.messagesEl.addEventListener("scroll", updateActive, { passive: true });
    }
    return { refresh: refresh, hidePopover: hidePopover };
  }

  const api = { QUESTION_MAX, ANSWER_MAX, truncatePreview, questionFromUserEl, answerFromUserEl, createTurnRail };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GrokTurnRail = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
