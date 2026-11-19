import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

/**
 * #181 — a fenced block clipped the reporter's text at the right edge.
 *
 * The screenshot was an `AGENTS.md` the agent had proposed: PROSE inside a
 * fence, not code. That distinction is the whole design. A sentence sheared off
 * at the right edge is simply lost — you cannot tell there is more, and the
 * horizontal scrollbar sits below the fold of a tall block. Wrapped code only
 * loses its alignment, which is visible and recoverable.
 *
 * So the default is per-language: prose fences wrap, real code keeps its
 * horizontal scroll, and a per-block toggle covers whichever default is wrong
 * for the block in front of you. Per block and not a setting, because one
 * transcript routinely mixes a proposed README with a diff and a shell command.
 */

const renderAgent = (text: string) => {
  const h = bootWebview();
  dispatch(h.window, { type: "messageChunk", text });
  dispatch(h.window, { type: "promptComplete" });
  const el = h.doc.querySelector(".msg.agent") as HTMLElement;
  return { ...h, el };
};

const blocks = (el: HTMLElement) => [...el.querySelectorAll(".code-block")] as HTMLElement[];
const only = (el: HTMLElement) => {
  const found = blocks(el);
  expect(found).toHaveLength(1);
  return found[0];
};

describe("syntax in replies", () => {
  it("labels TypeScript, renders raw HTML as text, and copies the original source", async () => {
    const source = '  const tag = "<script>&lt;</script>";  \r\n';
    const { window, el } = renderAgent("```typescript\r\n" + source + "```");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText } });
    const block = only(el);
    expect(block.querySelector(".code-language")?.textContent).toBe("TypeScript");
    expect(block.querySelector(".hl-kw")?.textContent).toBe("const");
    expect(block.querySelector(".hl-str")?.textContent).toBe('"<script>&lt;</script>"');
    expect(block.querySelector("script")).toBeNull();
    click(window, block.querySelector(".code-copy-btn")!);
    await Promise.resolve();
    expect(writeText.mock.calls).toEqual([[source]]);
  });

  it.each(["", "unknown-language"])("keeps %j fences plain", lang => {
    const { el } = renderAgent("```" + lang + "\nconst x = '<b>&';\n```");
    const block = only(el);
    expect(block.querySelector(".code-language, pre code span, pre code b")).toBeNull();
    expect(block.querySelector("pre code")?.textContent).toBe("const x = '<b>&';");
  });

  it("reuses a closed fence across stream repaints and honors the highlighter size limit", async () => {
    const { window, doc } = bootWebview();
    const highlighter = (window as any).GrokSyntaxHighlight;
    const highlight = vi.spyOn(highlighter, "highlightCode");
    const send = (text: string) => dispatch(window, { type: "messageChunk", text });
    const paint = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    send("```ts\n" + "const n = 1;\n".repeat(512));
    await paint();
    expect(highlight).not.toHaveBeenCalled();
    send("```\n");
    await paint();
    const rendered = doc.querySelector(".msg.agent .code-block");
    expect(rendered?.querySelector(".hl-kw")?.textContent).toBe("const");
    for (let i = 0; i < 8; i++) {
      send("\nstream update " + i);
      await paint();
      expect(doc.querySelector(".msg.agent")?.textContent).toContain("stream update " + i);
      expect(doc.querySelector(".msg.agent .code-block")).toBe(rendered);
    }
    expect(highlight).toHaveBeenCalledTimes(1);
    send("\n\n```ts\nconst " + "x".repeat(highlighter.MAX_HIGHLIGHT_BYTES) + "\n```");
    dispatch(window, { type: "promptComplete" });
    const large = doc.querySelectorAll(".msg.agent .code-block")[1];
    expect(large.querySelector(".code-language")?.textContent).toBe("TypeScript");
    expect(large.querySelector("pre code span")).toBeNull();
    expect(large.querySelector("pre code")?.textContent?.length).toBe(highlighter.MAX_HIGHLIGHT_BYTES + 6);
  });
});

describe("fenced prose wraps, fenced code scrolls (#181)", () => {
  // The bare fence is the one that matters most: the agent opens ``` with no
  // language for file contents constantly, and that is exactly the reporter's
  // case.
  it.each(["", "md", "markdown", "text", "txt", "plain", "plaintext"])(
    "wraps a fence tagged %j, because its body is prose",
    (lang) => {
      const { el } = renderAgent(
        "```" + lang + "\n" +
        "This is a long instruction sentence of the kind an AGENTS.md carries, " +
        "and losing its right-hand half is losing the sentence.\n" +
        "```",
      );
      expect(only(el).classList.contains("wrap")).toBe(true);
    },
  );

  it.each(["js", "ts", "python", "bash", "json", "html"])(
    "leaves a fence tagged %j scrolling, because alignment is information there",
    (lang) => {
      const { el } = renderAgent("```" + lang + "\nconst x = 1;\n```");
      expect(only(el).classList.contains("wrap")).toBe(false);
    },
  );

  it("offers the toggle on both, pressed only where wrapping is the default", () => {
    const prose = only(renderAgent("```\nsome prose\n```").el);
    const code = only(renderAgent("```js\nconst x = 1;\n```").el);
    for (const block of [prose, code]) {
      const btn = block.querySelector(".code-wrap-btn");
      expect(btn).not.toBeNull();
      // The control says which state it is in rather than leaving the reader to
      // infer it from the text reflowing.
      expect(btn!.getAttribute("aria-pressed"))
        .toBe(String(block.classList.contains("wrap")));
    }
  });

  // A diff's alignment IS its content — a wrapped hunk stops being readable as a
  // diff at all — so it never wraps and is not offered the choice.
  it("gives a diff no toggle at all", () => {
    const { el } = renderAgent("```diff\n-const x = 1;\n+const x = 2;\n```");
    const block = only(el);
    expect(block.classList.contains("diff")).toBe(true);
    expect(block.classList.contains("wrap")).toBe(false);
    expect(block.querySelector(".code-wrap-btn")).toBeNull();
    // Copy is untouched by any of this.
    expect(block.querySelector(".code-copy-btn")).not.toBeNull();
  });

  it("toggles the block it was clicked on, and says so", () => {
    const { window, el } = renderAgent("```js\nconst x = 1;\n```");
    const block = only(el);
    const btn = block.querySelector(".code-wrap-btn") as HTMLElement;

    click(window, btn);
    expect(block.classList.contains("wrap")).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");

    click(window, btn);
    expect(block.classList.contains("wrap")).toBe(false);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  // The reason it is per block and not a setting: this is an ordinary message.
  it("does not move the other blocks in the same message", () => {
    const { window, el } = renderAgent(
      "```\nproposed AGENTS.md line\n```\nand then\n```js\nconst x = 1;\n```",
    );
    const [prose, code] = blocks(el);
    expect(prose.classList.contains("wrap")).toBe(true);
    expect(code.classList.contains("wrap")).toBe(false);

    click(window, code.querySelector(".code-wrap-btn") as HTMLElement);
    expect(code.classList.contains("wrap")).toBe(true);
    // Untouched.
    expect(prose.classList.contains("wrap")).toBe(true);
    expect(prose.querySelector(".code-wrap-btn")!.getAttribute("aria-pressed")).toBe("true");
  });

  // The whole transcript's click handling is one delegated listener on
  // `document`, and every action branch in it stops propagation and returns so
  // the later branches — among them "a click anywhere else closes the open
  // popover" — do not also run. Wrap is an action branch like Copy and has to
  // behave like one. Asserted at the boundary the stop actually reaches, with
  // the control case beside it so the probe cannot pass vacuously.
  it("stops at document the way every other action branch does", () => {
    const { window, el } = renderAgent("```js\nconst x = 1;\n```");
    let reachedWindow = 0;
    (window as any).addEventListener("click", () => { reachedWindow += 1; });

    click(window, el.querySelector(".code-wrap-btn") as HTMLElement);
    expect(reachedWindow).toBe(0);

    // An ordinary click inside the same block does travel the whole way, so the
    // zero above is the guard and not the harness.
    click(window, el.querySelector(".code-block pre") as HTMLElement);
    expect(reachedWindow).toBe(1);
  });
});

/**
 * The wrapping itself is a stylesheet rule and no DOM suite evaluates layout, so
 * the half that makes the class mean anything is asserted against the CSS —
 * same reasoning as `confirm-stacking.test.ts`.
 */
describe("the wrap class has a rule behind it (#181)", () => {
  const css = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "..", "media", "chat.css"),
    "utf8",
  );

  it("wraps the text of a .wrap block", () => {
    expect(css).toMatch(/\.code-block\.wrap\s+pre\s+code\s*\{[^}]*white-space:\s*pre-wrap/);
  });

  // `break-word` keeps a long unbroken token — a URL, a Windows path — on one
  // line, which pushes the block wide and reintroduces exactly the clipping this
  // fixes. `anywhere` is the load-bearing value, not a synonym.
  it("breaks a long unbroken token rather than widening the block", () => {
    expect(css).toMatch(/\.code-block\.wrap\s+pre\s+code\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("keeps Copy in the corner it has always occupied and puts Wrap left of it", () => {
    expect(css).toMatch(/\.code-wrap-btn\s*\{\s*right:\s*38px/);
  });
});
