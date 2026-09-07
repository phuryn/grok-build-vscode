import { afterEach, describe, expect, it } from "vitest";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const opened: Harness[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.window.happyDOM.abort(); });

function transcript(remote = false, count = 3) {
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
    scrollHeight: { value: count * 1000 },
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
  messages.scrollTo = (options: any) => scroll(Math.min(options.top, count * 1000 - 200), false);
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
