import { afterEach, describe, expect, it } from "vitest";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const opened: Harness[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.happyDOM.abort(); });

/**
 * `on` seeds the client-local preference the way a previous session would have
 * left it, because that is the only way in: the toggle is `localOnly`, so it
 * never becomes a host message and there is nothing to dispatch.
 */
function transcript(opts: { remote?: boolean; count?: number; height?: number; on?: boolean } = {}) {
  const { remote = false, count = 3, on = true } = opts;
  const height = opts.height ?? count * 1000;
  const h = bootWebview({
    remote,
    beforeScripts: (w) => {
      if (!on) return;
      const key = remote ? "grok.remote.promptNav" : "grok.promptNav";
      (w as any).localStorage.setItem(key, "true");
    },
  });
  opened.push(h);
  const { doc, window } = h;
  const messages = doc.getElementById("messages")!;
  for (let i = 0; i < count; i++) {
    dispatch(window, { type: "userMessage", text: `Prompt ${i + 1}` });
    dispatch(window, { type: "messageChunk", text: "A long answer\n\n".repeat(80) });
    dispatch(window, { type: "promptComplete" });
  }
  Object.defineProperties(messages, {
    clientHeight: { value: 200 }, offsetHeight: { value: 200 },
    scrollHeight: { value: height },
  });
  messages.getBoundingClientRect = () => ({ top: 0, height: 200 } as DOMRect);
  [...doc.querySelectorAll<HTMLElement>(".msg.user")].forEach((el, i) => {
    el.getBoundingClientRect = () => ({ top: i * 1000 - messages.scrollTop, height: 80 } as DOMRect);
  });
  const scroll = (top: number, gesture = true) => {
    if (gesture) messages.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -80 }));
    messages.scrollTop = top;
    messages.dispatchEvent(new window.Event("scroll"));
  };
  messages.scrollTo = (options: any) => scroll(Math.min(options.top, height - 200), false);
  const button = (id: string) => doc.getElementById(id) as HTMLButtonElement;
  const shown = (id: string) => button(id).classList.contains("visible");
  const marks = () => [...doc.querySelectorAll(".msg.user.prompt-nav-target")];
  return { ...h, messages, scroll, button, shown, marks };
}

describe("prompt navigation (#150)", () => {
  it("is off by default, and off means the plain scroll-to-bottom button and nothing else", () => {
    // Everyone keeps exactly the control they had before #150 until they opt
    // in - the shape of the feature is still an open question with the person
    // who asked for it, so it ships hidden rather than ships wrong.
    const h = transcript({ on: false });
    h.scroll(1700);
    expect(h.shown("prompt-prev-btn")).toBe(false);
    expect(h.button("prompt-prev-btn").disabled).toBe(true);
    const bottom = h.button("scroll-bottom-btn");
    expect(bottom.className).toBe("scroll-bottom-btn visible");
    expect(bottom.textContent).toContain("Scroll to bottom");
  });

  it("Previous inside an answer finds its starting prompt, and hand scrolling changes the reference", () => {
    const h = transcript();
    h.scroll(1700);
    h.button("prompt-prev-btn").click();
    expect(h.messages.scrollTop).toBe(1000);
    h.button("prompt-prev-btn").click();
    expect(h.messages.scrollTop).toBe(0);
    h.scroll(2400);
    h.button("prompt-prev-btn").click();
    expect(h.messages.scrollTop).toBe(2000);
  });

  it("hides only when there is no earlier prompt, and counts only the remote's rendered ones", () => {
    // A remote snapshot carries just the tail, so "earlier prompt" has to mean
    // earlier in the DOM, never a history ordinal the client cannot see.
    const h = transcript({ remote: true, count: 2 });
    h.scroll(0);
    expect(h.shown("prompt-prev-btn")).toBe(false);
    expect(h.button("prompt-prev-btn").disabled).toBe(true);
    h.button("prompt-prev-btn").click();
    expect(h.messages.scrollTop).toBe(0);
    h.scroll(1400);
    expect(h.shown("prompt-prev-btn")).toBe(true);
    h.button("prompt-prev-btn").click();
    expect(h.messages.scrollTop).toBe(1000);
  });

  it("stays available at the bottom, where scroll-to-bottom has nothing to say", () => {
    // The reason it is a separate control rather than part of that pill: the
    // bottom of a long answer is exactly where "what did I ask?" comes up, and
    // the pill correctly disappears there.
    const h = transcript();
    h.scroll(2800);
    expect(h.messages.classList.contains("stick-to-bottom")).toBe(true);
    expect(h.shown("scroll-bottom-btn")).toBe(false);
    expect(h.shown("prompt-prev-btn")).toBe(true);
    h.button("prompt-prev-btn").click();
    // And the jump has to release the bottom pin, or the next chunk of streamed
    // output would yank the reader straight back down again.
    expect(h.messages.scrollTop).toBe(2000);
    expect(h.messages.classList.contains("stick-to-bottom")).toBe(false);
    expect(h.shown("scroll-bottom-btn")).toBe(true);
  });

  it("marks the prompt it landed on, and hands the view back on a scroll gesture", () => {
    // The control is at the bottom and the prompt arrives at the top, so the
    // mark is the only thing joining the tap to its result.
    const h = transcript({ height: 2100 });
    h.scroll(1000);
    h.button("prompt-prev-btn").click();
    expect(h.marks()).toHaveLength(1);
    expect(h.marks()[0].textContent).toContain("Prompt 1");
    h.scroll(2000);
    expect(h.marks()).toHaveLength(0);
  });

  it("does not let a wheel flick still in its latch undo a deliberate jump", () => {
    // A trackpad flick arms user-scroll intent for 750ms and emits inertial
    // scroll events after it. A click inside that window would otherwise have
    // its mark cleared by the flick's own tail.
    const h = transcript({ height: 2100 });
    h.scroll(1500);
    h.button("prompt-prev-btn").click();
    h.messages.dispatchEvent(new h.window.Event("scroll"));
    expect(h.marks()).toHaveLength(1);
  });

  it("names the bottom control for what it does", () => {
    // Voice control acts on the visible word, so the label is the accessible
    // name; "Bottom" read as prompt-relative next to a navigation control.
    const h = transcript({ on: false });
    expect(h.button("scroll-bottom-btn").textContent).toBe("Scroll to bottom");
  });
});
