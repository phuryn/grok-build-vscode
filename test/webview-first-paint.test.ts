import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * VS Code serves `media/` through the webview's service worker, and that worker
 * can cold-start a beat AFTER the HTML has rendered — most visibly on the first
 * load after an install, when nothing is warm. A `<link>` does not block that
 * paint, so for one frame the panel is its own markup with no stylesheet: white
 * skeleton bars, a bare textarea, a raw percentage.
 *
 * Each webview head therefore carries a critical inline style, and two rules
 * make it safe. The background must be painted, or the gap is white on a dark
 * theme. And a head that hides the body until its stylesheet lands must link a
 * stylesheet that REVEALS it — an unpaired hide is not a flash, it is a panel
 * that never appears at all, which no other test would notice.
 *
 * Source text rather than pixels, because the pair spans two files and it is
 * the pairing that breaks. Scoped to the VS Code webviews: the desktop app
 * loads its HTML and CSS off disk with no worker in between.
 */
const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

const heads = [...src.matchAll(/<head>([\s\S]*?)<\/head>/g)].map((m) => m[1]);

/** The `media/*.css` files a head links, in order. */
function stylesheets(head: string): string[] {
  return [...head.matchAll(/mediaUri\("([^"]+\.css)"\)/g)].map((m) => m[1]);
}

function css(file: string): string {
  return readFileSync(new URL(`../media/${file}`, import.meta.url), "utf8");
}

/** Does a rule whose selector list contains a bare `body` set it visible? */
function revealsBody(text: string): boolean {
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const chunk of bare.split("}")) {
    const brace = chunk.indexOf("{");
    if (brace === -1) continue;
    const selectors = chunk.slice(0, brace).split(",").map((s) => s.trim());
    if (!selectors.includes("body")) continue;
    if (/visibility\s*:\s*visible/.test(chunk.slice(brace + 1))) return true;
  }
  return false;
}

describe("the first frame of a VS Code webview", () => {
  it("has three heads — a new one must decide what it paints before its CSS lands", () => {
    expect(heads.length).toBe(3);
  });

  it("paints a background inline, so the cold-start gap is the theme colour", () => {
    const unpainted = heads
      .filter((head) => !/html, body \{ background: var\(--vscode-/.test(head))
      .map((head) => stylesheets(head).join(" + ") || "(no stylesheet)");
    expect(unpainted).toEqual([]);
  });

  it("is never held invisible by a stylesheet that does not bring it back", () => {
    const unpaired = heads
      .filter((head) => /body \{ visibility: hidden; \}/.test(head))
      .filter((head) => !stylesheets(head).some((file) => revealsBody(css(file))))
      .map((head) => stylesheets(head).join(" + ") || "(no stylesheet)");
    expect(unpaired).toEqual([]);
  });

  it("holds the whole chat panel, not one screen of it", () => {
    // The welcome screen was held on its own until an install-time recording
    // caught the other half: a restored session paints skeletons, composer and
    // context meter through the same gap.
    const chat = heads.find((head) => stylesheets(head).includes("chat.css"));
    expect(chat).toBeDefined();
    expect(chat).toContain("body { visibility: hidden; }");
    expect(chat).not.toContain(".welcome { visibility: hidden; }");
  });
});
