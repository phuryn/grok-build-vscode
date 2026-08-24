# Desktop conversation turn rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Desktop-only left-gutter index of one bar per Q&A so a long chat can jump by click and preview by hover.

**Architecture:** New UMD module `media/turn-rail.js` (+ CSS) draws the rail. `chat.js` only supplies a host (`listTurns` / `scrollToTurn` / `subscribe` / `isStickToBottom`). Countable-user membership lives in `webview-helpers.js` so Rewind and the rail cannot drift, and VS Code never has to load `turn-rail.js`. Desktop `getHtml` mounts `#turn-rail`; VS Code HTML omits the node and assets.

**Tech Stack:** Vanilla JS webview (happy-dom + vitest), existing `media/chat.js` transcript DOM, desktop `getHtml` in `src/sidebar.ts`.

**Spec:** `docs/superpowers/specs/2026-08-24-desktop-turn-rail-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `media/webview-helpers.js` | `isCountableUserBubble(el)` |
| `media/turn-rail.js` | Truncation, question/answer extraction, `createTurnRail` |
| `media/turn-rail.css` | Gutter, bars, popover, `#messages.has-turn-rail` padding |
| `test/turn-rail.dom.test.ts` | Module tests with fixture DOM + fake host |
| `test/webview-helpers.test.ts` | `isCountableUserBubble` cases |
| `src/sidebar.ts` | Desktop mount + CSS/JS tags |
| `media/chat.js` | Host wiring; Rewind uses `isCountableUserBubble` |
| `test/desktop-host-pure.test.ts` | Desktop HTML includes assets; VS Code does not |
| `docs/architecture.md` | Module map line |
| `README.md` | One GitHub-page feature bullet |
| `CHANGELOG.md` | Added bullet |

Do not touch `README.marketplace.md`. Do not add Electron / `test:integration` coverage.

Host object passed to `createTurnRail`:

```js
{
  messagesEl,          // #messages
  listTurns,           // () => [{ userEl, question, answer, pending }]
  scrollToTurn,        // (userEl) => boolean  (false if disconnected)
  subscribe,           // (listener) => unsubscribe
  isStickToBottom,     // () => boolean
  hoverDelayMs,        // optional, default 150
}
```

`question` / `answer` from `listTurns` are **raw** (fallbacks applied, not truncated). The rail truncates for `aria-label` and the popover. Empty `answer` + `pending: true` → display `"Answering…"`.

---

### Task 1: Countable user-bubble helper

**Files:**
- Modify: `media/webview-helpers.js`
- Test: `test/webview-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the import list in `test/webview-helpers.test.ts`: `isCountableUserBubble`.

Append:

```js
describe("isCountableUserBubble", () => {
  const { document } = new Window();
  function el(cls: string, attrs: Record<string, string> = {}) {
    const node = document.createElement("div");
    node.className = cls;
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  it("counts a sent user bubble", () => {
    expect(isCountableUserBubble(el("msg user"))).toBe(true);
  });

  it("rejects queued and steer bubbles", () => {
    expect(isCountableUserBubble(el("msg user queued"))).toBe(false);
    expect(isCountableUserBubble(el("msg user", { "data-steer": "1" }))).toBe(false);
  });

  it("rejects agent and missing nodes", () => {
    expect(isCountableUserBubble(el("msg agent"))).toBe(false);
    expect(isCountableUserBubble(null)).toBe(false);
  });
});
```

Vitest `environment` is `node`. Always use `new Window()` from happy-dom (already imported in this file).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/webview-helpers.test.ts -t isCountableUserBubble`

Expected: FAIL (`isCountableUserBubble` is not exported).

- [ ] **Step 3: Implement the helper**

In `media/webview-helpers.js`, add before `const api = {`:

```js
  function isCountableUserBubble(el) {
    if (!el || !el.classList) return false;
    if (!el.classList.contains("msg") || !el.classList.contains("user")) return false;
    if (el.classList.contains("queued")) return false;
    if (el.dataset && el.dataset.steer === "1") return false;
    return true;
  }
```

Add `isCountableUserBubble` to the `api` object (after `partitionHistoryCards`).

- [ ] **Step 4: Re-run the tests**

Run: `npx vitest run test/webview-helpers.test.ts -t isCountableUserBubble`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/webview-helpers.js test/webview-helpers.test.ts
git commit -m "$(cat <<'EOF'
Name the user bubbles Rewind and the turn rail both count

Queued and steer messages are not prompts. One helper so the left-gutter
index cannot drift from data-user-bubble-index.
EOF
)"
```

---

### Task 2: Truncation

**Files:**
- Create: `media/turn-rail.js`
- Create: `test/turn-rail.dom.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/turn-rail.dom.test.ts`:

```js
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/turn-rail.dom.test.ts`

Expected: FAIL (cannot find module `../media/turn-rail.js`).

- [ ] **Step 3: Implement truncation**

Create `media/turn-rail.js`:

```js
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
```

- [ ] **Step 4: Re-run the tests**

Run: `npx vitest run test/turn-rail.dom.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/turn-rail.js test/turn-rail.dom.test.ts
git commit -m "$(cat <<'EOF'
Truncate turn-rail previews by grapheme, 80 / 160

Question and answer both stop at a cluster cap so a hover card cannot
dump the whole transcript, and a CJK or emoji cluster is not split.
EOF
)"
```

---

### Task 3: Question and answer extraction

**Files:**
- Modify: `media/turn-rail.js`
- Modify: `test/turn-rail.dom.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the import: `questionFromUserEl`, `answerFromUserEl`.

Need `isCountableUserBubble` from helpers — extraction stops at the next countable user. `turn-rail.js` must call `root.GrokWebviewHelpers.isCountableUserBubble` when walking siblings. In tests, load helpers first **or** pass the predicate. Implement extraction using:

```js
const helpers = (typeof module !== "undefined" && module.exports)
  ? require("./webview-helpers.js")
  : (root.GrokWebviewHelpers || {});
```

Append tests (use happy-dom `Window`):

```js
import { Window } from "happy-dom";
import { questionFromUserEl, answerFromUserEl } from "../media/turn-rail.js";

function transcript() {
  const win = new Window();
  const doc = win.document;
  const root = doc.createElement("main");
  doc.body.appendChild(root);
  return { win, doc, root };
}

function userBubble(doc, text, opts = {}) {
  const el = doc.createElement("div");
  el.className = "msg user" + (opts.queued ? " queued" : "");
  if (opts.steer) el.dataset.steer = "1";
  if (opts.copyText != null) el._copyText = opts.copyText;
  const body = doc.createElement("div");
  body.className = "body";
  body.textContent = text;
  el.appendChild(body);
  if (opts.image) {
    const chips = doc.createElement("div");
    chips.className = "msg-chips";
    const prev = doc.createElement("button");
    prev.className = "msg-chip-preview";
    chips.appendChild(prev);
    el.appendChild(chips);
  } else if (opts.attach) {
    const chips = doc.createElement("div");
    chips.className = "msg-chips";
    const chip = doc.createElement("span");
    chip.className = "msg-chip";
    chips.appendChild(chip);
    el.appendChild(chips);
  }
  return el;
}

function agent(doc, text) {
  const el = doc.createElement("div");
  el.className = "msg agent";
  const body = doc.createElement("div");
  body.className = "body";
  body.textContent = text;
  el.appendChild(body);
  return el;
}

describe("questionFromUserEl / answerFromUserEl", () => {
  it("prefers _copyText then body text", () => {
    const { doc } = transcript();
    const a = userBubble(doc, "from body");
    expect(questionFromUserEl(a)).toBe("from body");
    a._copyText = "from copy";
    expect(questionFromUserEl(a)).toBe("from copy");
  });

  it("falls back to (image), (attachment), (empty)", () => {
    const { doc } = transcript();
    expect(questionFromUserEl(userBubble(doc, "", { image: true }))).toBe("(image)");
    expect(questionFromUserEl(userBubble(doc, "", { attach: true }))).toBe("(attachment)");
    expect(questionFromUserEl(userBubble(doc, ""))).toBe("(empty)");
  });

  it("joins agent bodies and skips thinking, tools, and cards", () => {
    const { doc, root } = transcript();
    const u1 = userBubble(doc, "q1");
    const think = doc.createElement("div");
    think.className = "msg thinking";
    const tbody = doc.createElement("div");
    tbody.className = "thinking-body";
    tbody.textContent = "secret";
    think.appendChild(tbody);
    const a1 = agent(doc, "hello");
    const tools = doc.createElement("div");
    tools.className = "tool-group";
    tools.textContent = "Ran ls";
    const a2 = agent(doc, "world");
    const card = doc.createElement("div");
    card.className = "card permission";
    card.textContent = "Allow?";
    const u2 = userBubble(doc, "q2");
    for (const n of [u1, think, a1, tools, a2, card, u2]) root.appendChild(n);
    expect(answerFromUserEl(u1)).toBe("hello\nworld");
    expect(answerFromUserEl(u2)).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/turn-rail.dom.test.ts -t questionFromUserEl`

Expected: FAIL (named export missing).

- [ ] **Step 3: Implement extraction**

In `media/turn-rail.js`, after `truncatePreview`:

```js
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
```

Add both functions to `api`.

User bubbles in production wrap the body in `.msg-bubble` (see `addMessage` in `media/chat.js`). The selector above covers both the fixture (`:scope > .body`) and production (`:scope > .msg-bubble .body`).

- [ ] **Step 4: Re-run the tests**

Run: `npx vitest run test/turn-rail.dom.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/turn-rail.js test/turn-rail.dom.test.ts
git commit -m "$(cat <<'EOF'
Read turn-rail question and answer from the transcript DOM

One user bubble plus following agent bodies. Thinking, tool groups, and
permission cards stay out of the hover preview.
EOF
)"
```

---

### Task 4: Rail render, click, stale click

**Files:**
- Modify: `media/turn-rail.js`
- Modify: `test/turn-rail.dom.test.ts`

- [ ] **Step 1: Write the failing tests**

```js
import { createTurnRail } from "../media/turn-rail.js";

function mountRail(doc, turns, opts = {}) {
  const messagesEl = doc.createElement("main");
  messagesEl.id = "messages";
  messagesEl.className = "messages";
  const rail = doc.createElement("aside");
  rail.id = "turn-rail";
  rail.hidden = true;
  doc.body.appendChild(messagesEl);
  doc.body.appendChild(rail);
  const clicks = [];
  const host = {
    messagesEl,
    listTurns: () => (typeof turns === "function" ? turns() : turns),
    scrollToTurn: (userEl) => {
      clicks.push(userEl);
      if (opts.scrollFalse) return false;
      return !!(userEl && userEl.isConnected);
    },
    subscribe: (fn) => {
      host._notify = fn;
      return () => { host._notify = null; };
    },
    isStickToBottom: () => !!opts.stick,
    hoverDelayMs: 0,
  };
  const ctl = createTurnRail(rail, host);
  ctl.refresh();
  return { rail, messagesEl, host, clicks, ctl };
}

describe("createTurnRail", () => {
  it("hides the rail when there are no turns", () => {
    const { doc } = transcript();
    const { rail, messagesEl } = mountRail(doc, []);
    expect(rail.hidden).toBe(true);
    expect(messagesEl.classList.contains("has-turn-rail")).toBe(false);
  });

  it("renders one bar per turn and unhides", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "hello world");
    const { rail, messagesEl } = mountRail(doc, [
      { userEl: u, question: "hello world", answer: "hi", pending: false },
    ]);
    expect(rail.hidden).toBe(false);
    expect(messagesEl.classList.contains("has-turn-rail")).toBe(true);
    const bars = rail.querySelectorAll("button.turn-rail-bar");
    expect(bars.length).toBe(1);
    expect(bars[0].getAttribute("aria-label")).toBe("hello world");
  });

  it("click calls scrollToTurn with that userEl", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "q");
    doc.body.appendChild(u);
    const { rail, clicks } = mountRail(doc, [
      { userEl: u, question: "q", answer: "a", pending: false },
    ]);
    rail.querySelector("button.turn-rail-bar").dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
    expect(clicks[0]).toBe(u);
  });

  it("a disconnected target does not throw", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "q");
    const { rail } = mountRail(doc, [
      { userEl: u, question: "q", answer: "a", pending: false },
    ], { scrollFalse: true });
    expect(() => {
      rail.querySelector("button.turn-rail-bar").dispatchEvent(new doc.defaultView.MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
  });
});
```

If happy-dom `MouseEvent` construction fails, use `const ev = doc.createEvent("Event"); ev.initEvent("click", true, true); bar.dispatchEvent(ev);`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/turn-rail.dom.test.ts -t createTurnRail`

Expected: FAIL (`createTurnRail` missing).

- [ ] **Step 3: Implement `createTurnRail`**

Append to `media/turn-rail.js` (before `const api`):

```js
  function displayQuestion(turn) {
    return truncatePreview(turn.question || "", QUESTION_MAX);
  }

  function displayAnswer(turn) {
    const raw = turn.answer || "";
    if (!raw && turn.pending) return "Answering…";
    return truncatePreview(raw, ANSWER_MAX);
  }

  function createTurnRail(mount, host) {
    if (!mount || !host) return { refresh: function () {} };
    const hoverDelay = host.hoverDelayMs == null ? 150 : host.hoverDelayMs;
    let hoverTimer = 0;
    let popover = null;

    function hidePopover() {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
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
      let top = br.top;
      if (top + pr.height > doc.defaultView.innerHeight - 8) {
        top = Math.max(8, br.bottom - pr.height);
      }
      popover.style.position = "fixed";
      popover.style.left = Math.round(br.right + 6) + "px";
      popover.style.top = Math.round(top) + "px";
      popover.addEventListener("mouseleave", hidePopover);
    }

    function activeIndex(turns) {
      if (!turns.length) return -1;
      if (host.isStickToBottom && host.isStickToBottom()) return turns.length - 1;
      const box = host.messagesEl.getBoundingClientRect();
      let best = 0;
      let bestDist = Infinity;
      turns.forEach((t, i) => {
        if (!t.userEl || !t.userEl.getBoundingClientRect) return;
        const r = t.userEl.getBoundingClientRect();
        if (r.bottom < box.top || r.top > box.bottom) return;
        const dist = Math.abs(r.top - box.top);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      return best;
    }

    function refresh() {
      hidePopover();
      const turns = (host.listTurns && host.listTurns()) || [];
      mount.replaceChildren();
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
      turns.forEach((turn, i) => {
        const bar = mount.ownerDocument.createElement("button");
        bar.type = "button";
        bar.className = "turn-rail-bar";
        bar.setAttribute("aria-label", displayQuestion(turn));
        if (i === current) bar.setAttribute("aria-current", "true");
        bar.addEventListener("click", () => {
          const el = turn.userEl;
          if (!el) return;
          const ok = host.scrollToTurn(el);
          if (ok && typeof bar.scrollIntoView === "function") {
            bar.scrollIntoView({ block: "nearest" });
          }
        });
        bar.addEventListener("mouseenter", () => {
          if (hoverTimer) clearTimeout(hoverTimer);
          hoverTimer = setTimeout(() => showPopover(bar, turn), hoverDelay);
        });
        bar.addEventListener("mouseleave", () => {
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
          // leave popover open if the pointer is moving onto it; popover mouseleave hides
          setTimeout(() => {
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
      host.messagesEl.addEventListener("scroll", refresh, { passive: true });
    }
    return { refresh, hidePopover };
  }
```

Add `createTurnRail`, `questionFromUserEl`, `answerFromUserEl` to `api` (already adding createTurnRail).

- [ ] **Step 4: Re-run the tests**

Run: `npx vitest run test/turn-rail.dom.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/turn-rail.js test/turn-rail.dom.test.ts
git commit -m "$(cat <<'EOF'
Draw one turn-rail bar per Q&A and jump on click

An empty transcript hides the gutter. A click whose bubble is already
gone is a no-op.
EOF
)"
```

---

### Task 5: Hover popover and pending copy

**Files:**
- Modify: `test/turn-rail.dom.test.ts`
- Modify: `media/turn-rail.js` only if Task 4 left a gap

- [ ] **Step 1: Write the failing tests**

```js
describe("turn-rail hover", () => {
  it("shows truncated question and answer", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "q");
    const { rail, ctl } = mountRail(doc, [
      { userEl: u, question: "hello".repeat(30), answer: "world".repeat(50), pending: false },
    ]);
    const bar = rail.querySelector("button.turn-rail-bar");
    bar.dispatchEvent(new doc.defaultView.MouseEvent("mouseenter", { bubbles: true }));
    const pop = doc.querySelector(".turn-rail-popover");
    expect(pop).toBeTruthy();
    expect(pop.querySelector(".turn-rail-q").textContent.endsWith("…")).toBe(true);
    expect(pop.querySelector(".turn-rail-a").textContent.endsWith("…")).toBe(true);
    expect(pop.querySelector(".turn-rail-q").textContent.length).toBe(81); // 80 + ellipsis
  });

  it("uses Answering… when pending and empty", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "q");
    const { rail } = mountRail(doc, [
      { userEl: u, question: "q", answer: "", pending: true },
    ]);
    const bar = rail.querySelector("button.turn-rail-bar");
    bar.dispatchEvent(new doc.defaultView.MouseEvent("mouseenter", { bubbles: true }));
    expect(doc.querySelector(".turn-rail-a").textContent).toBe("Answering…");
  });
});
```

`hoverDelayMs: 0` still uses `setTimeout(..., 0)`. Either flush with `await new Promise((r) => setTimeout(r, 0))` in the test, or when `hoverDelay === 0` call `showPopover` synchronously in `createTurnRail`. Prefer the synchronous path when `hoverDelay <= 0` so tests stay simple — change Task 4's mouseenter handler if this test needs it:

```js
bar.addEventListener("mouseenter", () => {
  if (hoverTimer) clearTimeout(hoverTimer);
  if (hoverDelay <= 0) showPopover(bar, turn);
  else hoverTimer = setTimeout(() => showPopover(bar, turn), hoverDelay);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/turn-rail.dom.test.ts -t hover`

Expected: FAIL until popover DOM exists (if Task 4 already added it, this step may already pass — then skip Step 3).

- [ ] **Step 3: Implement any missing popover bits**

Ensure labels are exactly `Question` and `Answer`, classes `turn-rail-k` / `turn-rail-q` / `turn-rail-a`, and pending empty → `Answering…` via `displayAnswer`.

- [ ] **Step 4: Re-run the tests**

Run: `npx vitest run test/turn-rail.dom.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media/turn-rail.js test/turn-rail.dom.test.ts
git commit -m "$(cat <<'EOF'
Preview a truncated question and answer on turn-rail hover

Pending turns with no agent prose yet say Answering… instead of a blank
card.
EOF
)"
```

---

### Task 6: CSS gutter

**Files:**
- Create: `media/turn-rail.css`

- [ ] **Step 1: Write the stylesheet** (no failing unit test for raw CSS; the packaging test in Task 7 locks the file's existence and the class names)

Create `media/turn-rail.css`:

```css
#turn-rail {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 16px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 4px;
  overflow-x: hidden;
  overflow-y: auto;
  box-sizing: border-box;
  scrollbar-width: none;
}
#turn-rail::-webkit-scrollbar { display: none; width: 0; height: 0; }
#turn-rail[hidden] { display: none !important; }

.turn-rail-bar {
  flex-shrink: 0;
  height: 3px;
  width: 8px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: var(--vscode-descriptionForeground);
  opacity: 0.45;
  cursor: pointer;
}
.turn-rail-bar:hover,
.turn-rail-bar:focus-visible {
  opacity: 1;
}
.turn-rail-bar[aria-current="true"] {
  opacity: 1;
  background: var(--vscode-textLink-foreground);
  width: 10px;
}

.messages.has-turn-rail {
  padding-left: calc(var(--pad) + 16px);
}

.turn-rail-popover {
  z-index: 30;
  width: 240px;
  max-width: calc(100vw - 24px);
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  color: var(--vscode-foreground);
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-input-border));
  box-shadow: 0 8px 24px color-mix(in oklab, var(--vscode-widget-shadow, #000) 35%, transparent);
  pointer-events: auto;
}
.turn-rail-k {
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 3px;
}
.turn-rail-k + .turn-rail-k,
.turn-rail-q { margin-bottom: 8px; }
.turn-rail-q {
  font-weight: 600;
  color: var(--vscode-foreground);
}
.turn-rail-a {
  color: var(--vscode-descriptionForeground);
}

.desk-transcript {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.desk-transcript > .messages {
  flex: 1 1 auto;
  min-height: 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add media/turn-rail.css
git commit -m "$(cat <<'EOF'
Style the desktop turn rail with theme tokens

Sixteen pixels of gutter, accent on the in-view turn, extra message
padding only while the rail is showing.
EOF
)"
```

---

### Task 7: Desktop `getHtml` mount (TDD against packaging tests)

**Files:**
- Modify: `test/desktop-host-pure.test.ts` (the test that slices `const filePanelStyle`)
- Modify: `src/sidebar.ts`

- [ ] **Step 1: Extend the existing packaging test so it fails**

In `test/desktop-host-pure.test.ts`, in the test that currently does:

```ts
    const assetGate = sidebar.slice(
      sidebar.indexOf("const filePanelStyle"),
      sidebar.indexOf("return `<!DOCTYPE html>", sidebar.indexOf("const filePanelStyle")),
    );
    expect(assetGate).toContain("this.host.canSwitchWorkspaceFolder");
    expect(assetGate).toContain('mediaUri("file-panel.css")');
    expect(assetGate).toContain('mediaUri("file-panel.js")');
    expect(assetGate.match(/:\s*"";/g)).toHaveLength(2);
```

Change `toHaveLength(2)` to `toHaveLength(4)` and add:

```ts
    expect(assetGate).toContain('mediaUri("turn-rail.css")');
    expect(assetGate).toContain('mediaUri("turn-rail.js")');
    expect(sidebar).toContain('id="turn-rail"');
    expect(sidebar).toContain('aria-label="Conversation turns"');
    expect(sidebar).toContain("desk-transcript");
```

Also assert VS Code HTML would not include those strings when the gate is false: keep the empty-string branches as the off switch (same pattern as file-panel).

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/desktop-host-pure.test.ts -t "keeps rendering in the shared asset"`

Expected: FAIL (length 2, no turn-rail.css).

- [ ] **Step 3: Patch `src/sidebar.ts` `getHtml`**

Next to `filePanelStyle` / `filePanelScript` (around lines 16553–16562):

```ts
    const turnRailStyle = this.host.canSwitchWorkspaceFolder
      ? `<link rel="stylesheet" href="${mediaUri("turn-rail.css")}" />`
      : "";
    const turnRailScript = this.host.canSwitchWorkspaceFolder
      ? `<script nonce="${nonce}" src="${mediaUri("turn-rail.js")}"></script>`
      : "";
```

In `firstFrameLayout` add:

```
  body.desk.has-rail .desk-transcript { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; height: 100%; }
  body.desk.has-rail .desk-transcript > .messages { flex: 1 1 auto; min-height: 0; }
```

In the HTML head, after `${filePanelStyle}`:

```
${turnRailStyle}
```

Replace the bare `#messages` block with (desktop only — wrap when `canSwitchWorkspaceFolder`):

When `this.host.canSwitchWorkspaceFolder` is true, emit:

```html
  <div class="desk-transcript">
  <aside id="turn-rail" hidden aria-label="Conversation turns"></aside>
  <main id="messages" class="messages">
    ...existing welcome...
  </main>
  </div>
```

When false, keep today's bare `<main id="messages">`.

Easiest: `const transcriptOpen = this.host.canSwitchWorkspaceFolder ? `<div class="desk-transcript"><aside id="turn-rail" hidden aria-label="Conversation turns"></aside>` : "";` and `const transcriptClose = this.host.canSwitchWorkspaceFolder ? `</div>` : "";` around the existing `<main id="messages">` … `</main>`.

After `${filePanelScript}` and **before** `chat.js`:

```
  ${turnRailScript}
```

Order must be: `webview-helpers.js` → `settings.js` → file-panel (desktop) → **turn-rail.js** → `chat.js`.

- [ ] **Step 4: Re-run the packaging test**

Run: `npx vitest run test/desktop-host-pure.test.ts -t "keeps rendering in the shared asset"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts test/desktop-host-pure.test.ts
git commit -m "$(cat <<'EOF'
Mount the turn rail only in the desktop HTML

VS Code still gets no node and no assets. Absence of #turn-rail is the
off switch.
EOF
)"
```

---

### Task 8: Wire `chat.js`

**Files:**
- Modify: `media/chat.js`

- [ ] **Step 1: Add `isCountableUserBubble` to the helper destructure**

At the `const { looksLikeFileRef, ... } = globalThis.GrokWebviewHelpers;` line (around 1055), add `isCountableUserBubble`.

- [ ] **Step 2: Use it in Rewind indexing**

Replace both:

```js
    const rendered = liveTranscriptQueryAll(".msg.user:not(.queued)")
      .filter((el) => el.dataset.steer !== "1").length;
```

in `visibleUserBubbleCount` and:

```js
    const users = liveTranscriptQueryAll(".msg.user:not(.queued)")
      .filter((el) => el.dataset.steer !== "1");
```

in `refreshUserRewindButtons` with:

```js
    const users = liveTranscriptQueryAll(".msg.user").filter(isCountableUserBubble);
```

(`visibleUserBubbleCount` uses `.length` on that list plus `historyPrefixUserCount`).

Keep the loop that hides rewind/edit on `[data-steer="1"]` bubbles.

- [ ] **Step 3: Implement the host and boot it**

Place near the bottom of the IIFE, **before** `claimRemoteTabIdentity` (around 16660):

```js
  function listTurnRailTurns() {
    const extract = (globalThis.GrokTurnRail || {});
    const users = liveTranscriptQueryAll(".msg.user").filter(isCountableUserBubble);
    return users.map((userEl, i) => ({
      userEl,
      question: typeof extract.questionFromUserEl === "function"
        ? extract.questionFromUserEl(userEl)
        : "",
      answer: typeof extract.answerFromUserEl === "function"
        ? extract.answerFromUserEl(userEl)
        : "",
      pending: i === users.length - 1 && !!state.busy,
    }));
  }

  function scrollToTurnRail(userEl) {
    if (!userEl || !userEl.isConnected) return false;
    const users = liveTranscriptQueryAll(".msg.user").filter(isCountableUserBubble);
    const last = users[users.length - 1];
    if (userEl !== last) {
      noteUserScrollIntent();
      setStickToBottom(false);
      updateScrollBtn();
    }
    if (typeof userEl.scrollIntoView === "function") {
      userEl.scrollIntoView({ block: "start", inline: "nearest" });
    }
    return true;
  }

  function subscribeTurnRail(listener) {
    let frame = 0;
    const kick = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        listener();
      });
    };
    const mo = new MutationObserver(kick);
    mo.observe(messagesEl, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }

  function bootTurnRail() {
    const mount = document.getElementById("turn-rail");
    const api = globalThis.GrokTurnRail;
    if (!mount || !api || typeof api.createTurnRail !== "function") return;
    const ctl = api.createTurnRail(mount, {
      messagesEl,
      listTurns: listTurnRailTurns,
      scrollToTurn: scrollToTurnRail,
      subscribe: subscribeTurnRail,
      isStickToBottom: () => !!state.stickToBottom,
    });
    if (ctl && typeof ctl.refresh === "function") ctl.refresh();
  }

  bootTurnRail();
```

Do **not** create `#turn-rail` if it is missing.

- [ ] **Step 4: Run the grok-free suite (or the cheap subset first)**

Run: `npx vitest run test/turn-rail.dom.test.ts test/webview-helpers.test.ts test/desktop-host-pure.test.ts test/find-in-session.dom.test.ts test/history-window.dom.test.ts test/stick-to-bottom.dom.test.ts test/turn-feedback.dom.test.ts`

Expected: PASS. Then `npm test`. Expected: PASS (4150+ tests, floor must stay green; count may rise).

If a chat.js DOM test fails because `isCountableUserBubble` is undefined, `test/webview-harness.ts` evals helpers before chat.js — exporting the new helper is enough as long as chat.js reads it from `GrokWebviewHelpers` at startup.

- [ ] **Step 5: Commit**

```bash
git add media/chat.js
git commit -m "$(cat <<'EOF'
Wire the desktop turn rail through a chat.js host

listTurns walks the same bubbles Rewind counts. scrollToTurn unpins
stick-to-bottom unless the jump is the live last turn. Streaming
refreshes coalesce on rAF.
EOF
)"
```

---

### Task 9: Docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Architecture module map**

In `docs/architecture.md` § Module map, immediately after the `media/chat.{js,css}` row, add:

```
| `media/turn-rail.{js,css}` | Desktop-only conversation turn index (`createTurnRail`). Overlay gutter on `#messages`; one bar per countable user bubble; hover preview truncates question 80 / answer 160. Absent `#turn-rail` (VS Code, remote) is the off switch. Membership is `isCountableUserBubble` in `webview-helpers.js` so Rewind indexing cannot drift |
```

In the `media/webview-helpers.js` row, mention `isCountableUserBubble` in the same sentence list as the other predicates.

- [ ] **Step 2: README GitHub page**

In `README.md` under Features & capabilities, after the Session history `<details>` block (the status-dot table), add:

```html
<details>
<summary><strong>Turn rail (Desktop)</strong> — jump a long chat from the left gutter</summary>

On Grok Build Desktop, a pinned column of bars sits on the left edge of the conversation — one bar per question and answer. Click to jump there. Hover to preview a truncated question and answer. The gutter stays on screen while the transcript scrolls; VS Code's sidebar does not show it.

</details>
```

Do **not** edit `README.marketplace.md`.

- [ ] **Step 3: Changelog**

Under the current `## 3.15.0` (or whatever version `package.json` has) **Added** list, prepend:

```
- **Desktop: jump a long conversation from the left gutter.** Each question/answer pair gets a bar on the left edge of the chat. Click jumps to that turn; hover previews a truncated question and answer. VS Code is unchanged.
```

If a release already shipped 3.15.0, add a new `## Unreleased` / next-version **Added** section instead of rewriting a published version. Read `package.json` `version` and the top `CHANGELOG.md` heading: if they match a released tag, create `## Unreleased` at the top with that bullet.

- [ ] **Step 4: Run `npm test`**

Expected: PASS, including `test/readme-images.test.ts` (no new screenshot paths).

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
Document the desktop conversation turn rail

Module map, GitHub README, changelog. Marketplace listing stays
extension-only, so it does not mention this gutter.
EOF
)"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| Desktop-only mount / no VS Code node | 7 |
| Overlay gutter, 16px padding while visible | 6, 7 |
| Countable = non-queued, non-steer user bubble | 1, 8 |
| Question/answer extraction + fallbacks | 3 |
| Truncate 80 / 160 grapheme-safe | 2 |
| Click jump `block: "start"`, unpin stick-to-bottom | 8 |
| Stale click no-op | 4, 8 |
| Hover 150ms, Question/Answer, clamp | 4, 5, 6 |
| `Answering…` pending | 5, 8 |
| Active bar follows scroll / stick-to-bottom | 4, 8 |
| Independent rail scroll, hidden at 0 turns | 4, 6 |
| Buttons + aria-label / aria-current | 4 |
| rAF-coalesced subscribe | 8 |
| `npm test` only | 4–8 |
| Packaging assertions | 7 |
| Docs (architecture, README, changelog) | 9 |
| No marketplace screenshot | 9 |

## Notes for the implementer

- Existing `test/webview-harness.ts` `BODY` has no `#turn-rail`. That is required: chat.js DOM tests must keep passing with the rail unmounted.
- `test/desktop-host-pure.test.ts` currently expects exactly **two** `: "";` branches in the file-panel asset gate. Task 7 changes that to **four**.
- User bubbles in production wrap `.body` in `.msg-bubble`; fixtures in unit tests may not. `questionFromUserEl` must accept both.
- Do not load `turn-rail.js` in VS Code HTML just to share `isCountableUserBubble`.
