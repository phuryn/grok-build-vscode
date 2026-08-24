import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
// @ts-expect-error Plain-JS webview module, no TS build step.
import { QUESTION_MAX, ANSWER_MAX, truncatePreview, questionFromUserEl, answerFromUserEl, createTurnRail } from "../media/turn-rail.js";

type CopyEl = HTMLElement & { _copyText?: string };

function transcript() {
  const win = new Window();
  const doc = win.document;
  const root = doc.createElement("main");
  doc.body.appendChild(root);
  return { win, doc, root };
}

function userBubble(doc: Document, text: string, opts: {
  queued?: boolean;
  steer?: boolean;
  copyText?: string;
  image?: boolean;
  attach?: boolean;
  wrapBubble?: boolean;
} = {}) {
  const el = doc.createElement("div") as CopyEl;
  el.className = "msg user" + (opts.queued ? " queued" : "");
  if (opts.steer) el.dataset.steer = "1";
  if (opts.copyText != null) el._copyText = opts.copyText;
  const body = doc.createElement("div");
  body.className = "body";
  body.textContent = text;
  if (opts.wrapBubble) {
    const bubble = doc.createElement("div");
    bubble.className = "msg-bubble";
    bubble.appendChild(body);
    el.appendChild(bubble);
  } else {
    el.appendChild(body);
  }
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

function agent(doc: Document, text: string) {
  const el = doc.createElement("div");
  el.className = "msg agent";
  const body = doc.createElement("div");
  body.className = "body";
  body.textContent = text;
  el.appendChild(body);
  return el;
}

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

describe("questionFromUserEl / answerFromUserEl", () => {
  it("prefers _copyText then body text", () => {
    const { doc } = transcript();
    const a = userBubble(doc, "from body");
    expect(questionFromUserEl(a)).toBe("from body");
    a._copyText = "from copy";
    expect(questionFromUserEl(a)).toBe("from copy");
  });

  it("reads body text through a production .msg-bubble wrap", () => {
    const { doc } = transcript();
    expect(questionFromUserEl(userBubble(doc, "wrapped", { wrapBubble: true }))).toBe("wrapped");
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

  it("does not stop at queued or steer user bubbles", () => {
    const { doc, root } = transcript();
    const u1 = userBubble(doc, "q1");
    const queued = userBubble(doc, "later", { queued: true });
    const a1 = agent(doc, "hello");
    const steer = userBubble(doc, "steer", { steer: true });
    const a2 = agent(doc, "world");
    const next = userBubble(doc, "q2");
    for (const n of [u1, queued, a1, steer, a2, next]) root.appendChild(n);
    expect(answerFromUserEl(u1)).toBe("hello\nworld");
  });
});

function mountRail(doc: Document, turns: unknown, opts: { scrollFalse?: boolean; stick?: boolean } = {}) {
  const messagesEl = doc.createElement("main");
  messagesEl.id = "messages";
  messagesEl.className = "messages";
  const rail = doc.createElement("aside");
  rail.id = "turn-rail";
  rail.hidden = true;
  doc.body.appendChild(messagesEl);
  doc.body.appendChild(rail);
  const clicks: unknown[] = [];
  const host: {
    messagesEl: HTMLElement;
    listTurns: () => unknown;
    scrollToTurn: (userEl: unknown) => boolean;
    subscribe: (fn: () => void) => () => void;
    isStickToBottom: () => boolean;
    hoverDelayMs: number;
    _notify?: (() => void) | null;
  } = {
    messagesEl,
    listTurns: () => (typeof turns === "function" ? (turns as () => unknown)() : turns),
    scrollToTurn: (userEl) => {
      clicks.push(userEl);
      if (opts.scrollFalse) return false;
      return !!(userEl && (userEl as Node).isConnected);
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

function dispatchDom(el: Element, type: string) {
  const doc = el.ownerDocument!;
  const MouseEventCtor = doc.defaultView!.MouseEvent;
  try {
    el.dispatchEvent(new MouseEventCtor(type, { bubbles: true }));
  } catch {
    const ev = doc.createEvent("Event");
    ev.initEvent(type, true, true);
    el.dispatchEvent(ev);
  }
}

function dispatchClick(_doc: Document, bar: Element) {
  dispatchDom(bar, "click");
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
    const bar = rail.querySelector("button.turn-rail-bar")!;
    dispatchClick(doc, bar);
    expect(clicks[0]).toBe(u);
  });

  it("a disconnected target does not throw", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "q");
    const { rail } = mountRail(doc, [
      { userEl: u, question: "q", answer: "a", pending: false },
    ], { scrollFalse: true });
    expect(() => {
      const bar = rail.querySelector("button.turn-rail-bar")!;
      dispatchClick(doc, bar);
    }).not.toThrow();
  });

  it("does not rebuild bars on transcript scroll", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "hello");
    const { rail, messagesEl } = mountRail(doc, [
      { userEl: u, question: "hello", answer: "hi", pending: false },
    ]);
    const bar = rail.querySelector("button.turn-rail-bar")!;
    dispatchDom(messagesEl, "scroll");
    expect(bar.isConnected).toBe(true);
    expect(rail.querySelector("button.turn-rail-bar")).toBe(bar);
  });

  it("does not hide bar B popover after leaving bar A", async () => {
    const { doc } = transcript();
    const u1 = userBubble(doc, "q1");
    const u2 = userBubble(doc, "q2");
    const { rail } = mountRail(doc, [
      { userEl: u1, question: "q1", answer: "a1", pending: false },
      { userEl: u2, question: "q2", answer: "a2", pending: false },
    ]);
    const bars = rail.querySelectorAll("button.turn-rail-bar");
    expect(bars.length).toBe(2);
    dispatchDom(bars[0], "mouseenter");
    dispatchDom(bars[0], "mouseleave");
    dispatchDom(bars[1], "mouseenter");
    await new Promise((r) => setTimeout(r, 80));
    expect(doc.querySelector(".turn-rail-popover")).toBeTruthy();
  });

  it("reuses bars when the same userEls stream a longer answer", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "q");
    doc.body.appendChild(u);
    const live = [{ userEl: u, question: "q", answer: "", pending: true }];
    const { rail, ctl, clicks } = mountRail(doc, () => live);
    const bar = rail.querySelector("button.turn-rail-bar")!;
    dispatchDom(bar, "mouseenter");
    const pop = doc.querySelector(".turn-rail-popover");
    expect(pop).toBeTruthy();
    expect(pop!.querySelector(".turn-rail-a")!.textContent).toBe("Answering…");
    live[0] = { userEl: u, question: "q", answer: "hello world", pending: true };
    ctl.refresh();
    expect(rail.querySelector("button.turn-rail-bar")).toBe(bar);
    expect(doc.querySelector(".turn-rail-popover")).toBe(pop);
    expect(pop!.querySelector(".turn-rail-a")!.textContent).toBe("hello world");
    dispatchClick(doc, bar);
    expect(clicks[0]).toBe(u);
  });

  it("rebuilds bars when userEls change even if the count matches", () => {
    const { doc } = transcript();
    const a = userBubble(doc, "old");
    const b = userBubble(doc, "new");
    let live = [{ userEl: a, question: "old", answer: "1", pending: false }];
    const { rail, ctl } = mountRail(doc, () => live);
    const bar = rail.querySelector("button.turn-rail-bar")!;
    live = [{ userEl: b, question: "new", answer: "2", pending: false }];
    ctl.refresh();
    const next = rail.querySelector("button.turn-rail-bar")!;
    expect(next).not.toBe(bar);
    expect(next.getAttribute("aria-label")).toBe("new");
  });

  it("rebuilds when a turn is added", () => {
    const { doc } = transcript();
    const u1 = userBubble(doc, "q1");
    const u2 = userBubble(doc, "q2");
    let live = [{ userEl: u1, question: "q1", answer: "a", pending: false }];
    const { rail, ctl } = mountRail(doc, () => live);
    live = [
      { userEl: u1, question: "q1", answer: "a", pending: false },
      { userEl: u2, question: "q2", answer: "", pending: true },
    ];
    ctl.refresh();
    expect(rail.querySelectorAll("button.turn-rail-bar").length).toBe(2);
  });
});

describe("turn-rail hover", () => {
  it("shows truncated question and answer", () => {
    const { doc } = transcript();
    const u = userBubble(doc, "q");
    const { rail } = mountRail(doc, [
      { userEl: u, question: "hello".repeat(30), answer: "world".repeat(50), pending: false },
    ]);
    const bar = rail.querySelector("button.turn-rail-bar");
    bar.dispatchEvent(new doc.defaultView.MouseEvent("mouseenter", { bubbles: true }));
    const pop = doc.querySelector(".turn-rail-popover");
    expect(pop).toBeTruthy();
    expect(pop.querySelector(".turn-rail-q").textContent.endsWith("…")).toBe(true);
    expect(pop.querySelector(".turn-rail-a").textContent.endsWith("…")).toBe(true);
    expect(pop.querySelector(".turn-rail-q").textContent.length).toBe(81);
    const labels = [...pop.querySelectorAll(".turn-rail-k")].map((el) => el.textContent);
    expect(labels).toEqual(["Question", "Answer"]);
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
