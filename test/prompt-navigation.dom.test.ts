import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const opened: Harness[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.happyDOM.abort(); });

/**
 * The preference reaches the two surfaces by different routes, and `on` has to
 * use whichever one is real: a remote holds it in its own storage, while a desk
 * is TOLD by the host, because VS Code renders Settings in a separate webview
 * from the chat and nothing client-local there can reach this page.
 */
function transcript(opts: { remote?: boolean; count?: number; height?: number; on?: boolean } = {}) {
  const { remote = false, count = 3, on = true } = opts;
  const height = opts.height ?? count * 1000;
  const h = bootWebview({
    remote,
    beforeScripts: (w) => {
      if (on && remote) (w as any).localStorage.setItem("grok.remote.promptNav", "true");
    },
  });
  opened.push(h);
  if (on && !remote) dispatch(h.window, { type: "promptNav", value: true });
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
  it("is on for a remote that has never had an opinion, and stays off for one that said no", () => {
    // The upgrade question, and the reason `storedBool` falls back only on a
    // MISSING key: flipping the default must reach a device that never chose,
    // and must not reach one that chose. Absence stays absence -- nothing
    // writes the new default into anybody's storage on the way past.
    const fresh = transcript({ remote: true, on: false });
    fresh.scroll(1700);
    expect(fresh.shown("prompt-prev-btn")).toBe(true);
    expect(fresh.window.localStorage.getItem("grok.remote.promptNav")).toBeNull();

    const refused = bootWebview({
      remote: true,
      beforeScripts: (w) => { (w as any).localStorage.setItem("grok.remote.promptNav", "false"); },
    });
    opened.push(refused);
    expect(refused.doc.getElementById("prompt-prev-btn")!.classList.contains("visible")).toBe(false);
  });

  it("turned off means the plain scroll-to-bottom button and nothing else", () => {
    // The preference is ON by default now, so this is the opt-OUT state: a
    // person who went and turned it off gets exactly the control they had
    // before #150, with nothing of the feature left behind.
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

/**
 * The mark TINTS the bubble, and a long prompt is clamped with a fade whose
 * only job is to occlude the clipped text. So the fade has to terminate on
 * whatever the bubble is actually painted -- and a highlighted bubble is no
 * longer the default colour. The fade was left on the default, so a jumped-to
 * long prompt wore a dark band across the bottom of a blue bubble (owner,
 * desktop app, dark theme, 2026-09-11).
 *
 * No DOM suite above can catch this. happy-dom applies no stylesheet and
 * composites no gradient, so the two rules are only ever visibly wrong
 * together on a real screen. Asserted against the stylesheet itself, the way
 * `confirm-stacking.test.ts` asserts a relationship no single page observes.
 */
describe("the clamp fade follows the bubble it is drawn on", () => {
  const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");

  /** The blue percentage and the surface a rule mixes it into. */
  function tint(selector: string) {
    const at = css.indexOf(selector + " {");
    expect(at, `${selector} is gone -- the pair below cannot be checked`).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("\n}", at));
    const mix = /color-mix\(in srgb, var\(--vscode-charts-blue, #3794ff\) (\d+)%, var\((--chat-surface-user(?:-opaque)?)\)\)/.exec(rule);
    expect(mix, `${selector} no longer mixes the jump blue into a bubble surface`).not.toBeNull();
    return { percent: mix![1], surface: mix![2] };
  }

  it("ends the fade on the SAME colour the tinted bubble is painted", () => {
    const bubble = tint(".msg.user.prompt-nav-target .msg-bubble");
    const fade = tint(".msg.user.collapsible.prompt-nav-target .body::after");
    expect(fade.percent).toBe(bubble.percent);
    // Not the same variable, and deliberately so. The bubble fill is
    // translucent and cannot terminate a gradient opaquely; `-opaque` is that
    // fill already composited over the sidebar. Mixing an opaque blue in
    // before compositing and after compositing give the same result, so this
    // pair lands on the painted colour exactly rather than approximately.
    expect(bubble.surface).toBe("--chat-surface-user");
    expect(fade.surface).toBe("--chat-surface-user-opaque");
  });

  it("still ends an untinted fade on the untinted bubble", () => {
    const at = css.indexOf(".msg.user.collapsible .body::after {");
    const rule = css.slice(at, css.indexOf("\n}", at));
    expect(rule).toContain("linear-gradient(to bottom, transparent, var(--chat-surface-user-opaque))");
  });
});
