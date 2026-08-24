import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
// @ts-expect-error Plain-JS webview module, no TS build step.
import { QUESTION_MAX, ANSWER_MAX, truncatePreview, questionFromUserEl, answerFromUserEl } from "../media/turn-rail.js";

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
