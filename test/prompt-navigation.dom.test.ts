import { afterEach, describe, expect, it } from "vitest";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const opened: Harness[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.happyDOM.abort(); });

function transcript(remote = false, count = 3, height = count * 1000) {
  const h = bootWebview({ remote });
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
  return { ...h, messages, scroll, button };
}

describe("prompt navigation (#150)", () => {
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

  it("stops at both ends, keeps all controls, and counts only the remote's rendered prompts", () => {
    const h = transcript(true, 2);
    h.scroll(0);
    expect(h.doc.getElementById("prompt-nav-count")!.textContent).toBe("Prompts 1/2");
    expect(h.button("prompt-prev-btn").disabled).toBe(true);
    h.button("prompt-prev-btn").click();
    expect(h.messages.scrollTop).toBe(0);
    h.button("prompt-next-btn").click();
    expect(h.messages.scrollTop).toBe(1000);
    expect(h.doc.getElementById("prompt-nav-count")!.textContent).toBe("Prompts 2/2");
    expect(h.button("prompt-next-btn").disabled).toBe(true);
    h.button("prompt-next-btn").click();
    expect(h.messages.scrollTop).toBe(1000);
    expect(h.doc.querySelectorAll("#prompt-nav button")).toHaveLength(3);
  });

  it("keeps counting when the last prompt cannot be scrolled to the top", () => {
    // The owner's report: "I click the chevron, the screen can even move, but
    // it can still show 6/7". The last screenful of prompts all share the
    // terminal scrollTop, so no scroll brings them to the top of the viewport
    // and geometry can never name them. Here prompt 3 sits at 2000 and the
    // scroll range ends at 1900, so its top never reaches 0.
    const h = transcript(false, 3, 2100);
    const count = () => h.doc.getElementById("prompt-nav-count")!.textContent;
    h.scroll(1000);
    expect(count()).toBe("Prompts 2/3");
    h.button("prompt-next-btn").click();
    expect(h.messages.scrollTop).toBe(1900);
    // Advanced even though the scroll clamped, and the end is now the end.
    expect(count()).toBe("Prompts 3/3");
    expect(h.button("prompt-next-btn").disabled).toBe(true);
    // The mark is what makes "3/3" mean anything: it is the only thing on
    // screen saying WHICH prompt the number is naming.
    const marked = h.doc.querySelectorAll(".msg.user.prompt-nav-target");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain("Prompt 3");
    // And Previous still walks back from where the counter says we are.
    h.button("prompt-prev-btn").click();
    expect(count()).toBe("Prompts 2/3");
    expect(h.doc.querySelectorAll(".msg.user.prompt-nav-target")[0].textContent)
      .toContain("Prompt 2");
  });

  it("hands the readout back to the scroll position once the reader scrolls", () => {
    // The pin is for navigation, not a mode. A wheel gesture means the reader
    // is driving again, so the number must describe where they actually are.
    const h = transcript(false, 3, 2100);
    h.scroll(1000);
    h.button("prompt-next-btn").click();
    expect(h.doc.querySelectorAll(".msg.user.prompt-nav-target")).toHaveLength(1);
    h.scroll(0);
    expect(h.doc.getElementById("prompt-nav-count")!.textContent).toBe("Prompts 1/3");
    expect(h.doc.querySelectorAll(".msg.user.prompt-nav-target")).toHaveLength(0);
  });

  it("does not let a wheel flick still in its latch undo a deliberate jump", () => {
    // A trackpad flick arms user-scroll intent for 750ms and emits inertial
    // scroll events after it. A chevron clicked inside that window would
    // otherwise have its pin cleared by the flick's own tail.
    const h = transcript(false, 3, 2100);
    h.scroll(1000);
    h.button("prompt-next-btn").click();
    h.messages.dispatchEvent(new h.window.Event("scroll"));
    expect(h.doc.getElementById("prompt-nav-count")!.textContent).toBe("Prompts 3/3");
    expect(h.doc.querySelectorAll(".msg.user.prompt-nav-target")).toHaveLength(1);
  });

  it("names the bottom control for what it does", () => {
    // "Latest" read as a prompt-relative move next to Previous/Next; the
    // button scrolls to the bottom of the transcript.
    const h = transcript();
    expect(h.button("scroll-bottom-btn").textContent).toContain("Bottom");
    expect(h.button("scroll-bottom-btn").getAttribute("title")).toBe("Scroll to bottom");
  });

  it("replaces the standalone button as one pill under the existing pin rule", () => {
    const h = transcript();
    const pill = h.doc.getElementById("prompt-nav")!;
    expect(pill).not.toBeNull();
    expect(pill.classList.contains("visible")).toBe(false);
    expect(h.button("scroll-bottom-btn").parentElement).toBe(pill);
    expect(h.doc.querySelector(".composer > #scroll-bottom-btn")).toBeNull();
    h.scroll(1400, false);
    expect(pill.classList.contains("visible")).toBe(false);
    h.scroll(1400);
    expect(pill.classList.contains("visible")).toBe(true);
    h.button("scroll-bottom-btn").click();
    expect(h.messages.classList.contains("stick-to-bottom")).toBe(true);
    expect(pill.classList.contains("visible")).toBe(false);
    expect(h.button("scroll-bottom-btn").disabled).toBe(true);
    expect(h.button("prompt-next-btn").disabled).toBe(true);
  });
});
