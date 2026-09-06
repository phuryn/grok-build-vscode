/**
 * chat.js publishes its markdown renderer on `window.__grokRenderMarkdown` so
 * the desktop file panel — injected into the SAME document after load — can
 * preview `.md` files with the conversation's renderer instead of the ~35-line
 * private subset it used to carry (headings, fences and bold only: no bullets,
 * no tables, no links, no italics).
 *
 * The export is a contract between two surfaces in different files, so it needs
 * its own coverage: deleting it would leave the panel silently degraded to its
 * fallback rather than failing anything.
 */
import { describe, expect, it } from "vitest";
import { bootWebview } from "./webview-harness";

function render(md: string): string {
  const h = bootWebview({ ready: true });
  const fn = (h.window as any).__grokRenderMarkdown;
  expect(typeof fn).toBe("function");
  return String(fn(md));
}

describe("shared markdown renderer (window.__grokRenderMarkdown)", () => {
  it("renders bullets — the panel's own parser never did", () => {
    const html = render("- alpha\n- beta\n");
    expect(html).toContain("<li>");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  it("renders GFM tables", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("md-table-wrap");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("still renders what the old subset did", () => {
    const html = render("# Title\n\n**bold** and `code`\n\n```\nfenced\n```\n");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>");
    expect(html).toContain("fenced");
  });

  it("escapes raw HTML in the source — repo files are not trusted markup", () => {
    // The panel previews files from whatever repository is open. If a README
    // could inject live markup it would run inside the Electron renderer, which
    // holds the preload bridge. `inline()` escapes &, < and > first, so this
    // must come back inert.
    const html = render('<img src=x onerror="alert(1)">\n');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders markdown images as safe img tags", () => {
    const html = render("![Diagram](images/flow.png)\n");
    expect(html).toContain('<img class="md-image" src="images/flow.png" alt="Diagram" loading="lazy" />');
  });

  it("renders GitHub alerts for NOTE, TIP, WARNING, IMPORTANT, CAUTION", () => {
    const noteHtml = render("> [!NOTE]\n> This is a note.\n");
    expect(noteHtml).toContain("md-alert md-alert-note");
    expect(noteHtml).toContain("NOTE");
    expect(noteHtml).toContain("This is a note.");

    const warnHtml = render("> [!WARNING]\n> Warning details.\n");
    expect(warnHtml).toContain("md-alert md-alert-warning");
    expect(warnHtml).toContain("WARNING");
    expect(warnHtml).toContain("Warning details.");
  });

  it("renders standard blockquotes", () => {
    const html = render("> Plain quote line 1\n> Plain quote line 2\n");
    expect(html).toContain("<blockquote>Plain quote line 1<br>Plain quote line 2</blockquote>");
  });

  it("renders file:// links in markdown", () => {
    const html = render("[Plan File](file:///C:/Users/test/implementation_plan.md)\n");
    expect(html).toContain('<a href="file:///C:/Users/test/implementation_plan.md">Plan File</a>');
  });

  it("survives a null or undefined body without throwing", () => {
    const h = bootWebview({ ready: true });
    const fn = (h.window as any).__grokRenderMarkdown;
    expect(() => fn(null)).not.toThrow();
    expect(() => fn(undefined)).not.toThrow();
  });
});

describe("CRLF files render like LF ones", () => {
  // Most files on Windows are CRLF, and the desktop panel renders whole files
  // off disk, so this was the normal case rather than an edge one.
  //
  // The renderer splits on a newline and then tests each line with $-anchored
  // patterns. A carriage return is a line terminator in JS regex, so `.` cannot
  // match one, and every $-anchored rule failed at the final character:
  // headings kept their hashes, bullets kept their dashes, and both fell
  // through to the paragraph path. Tables, links and bold are not $-anchored,
  // so they kept working — which is why it looked like the renderer was mostly
  // fine, and why this survived review.
  const CRLF = "# Title\r\n\r\n## Section\r\n\r\n- one\r\n- two\r\n\r\n1. first\r\n";

  it("renders headings from a CRLF document", () => {
    const out = render(CRLF);
    expect(out).toContain("<h1");
    expect(out).toContain("<h2");
    expect(out).not.toContain("# Title");
    expect(out).not.toContain("## Section");
  });

  it("renders bullets and numbered lists from a CRLF document", () => {
    const out = render(CRLF);
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
    expect(out).toContain("<li");
  });

  it("produces exactly the same html as the LF form", () => {
    // The strongest statement of the rule: line endings must not be able to
    // change the output at all.
    expect(render(CRLF)).toBe(render(CRLF.replace(/\r\n/g, "\n")));
  });

  it("survives a lone-CR document", () => {
    expect(render("# Old Mac\r\r- item\r")).toContain("<h1");
  });
});

/**
 * #143 — a code span is LITERAL, and so is a link's href.
 *
 * `inline()` used to run its emphasis pass over its own output, by which point
 * the <code> tags were just characters and the asterisks inside two separate
 * code spans could pair with each other ACROSS the prose between them. The
 * reporter's example rendered `1*2` and `3*4` as one italic run.
 */
describe("markdown: code spans and hrefs are literal (#143)", () => {
  it("does not italicise across two code spans — the reported case", () => {
    const html = render("`1*2` and `3*4`\n");
    expect(html).not.toContain("<em>");
    expect(html).toContain("<code>1*2</code>");
    expect(html).toContain("<code>3*4</code>");
  });

  it("leaves a single code span's asterisks alone", () => {
    expect(render("`a *b* c`\n")).toContain("<code>a *b* c</code>");
  });

  it("does not read markdown syntax inside a code span", () => {
    // Backticks won the first pass even before the fix, but the LINK pass then
    // matched the [a](b) sitting inside the <code> element it had just made.
    const html = render("`[a](b)` stays literal\n");
    expect(html).not.toContain('<a href="b"');
    expect(html).toContain("<code>[a](b)</code>");
  });

  it("keeps an asterisk in a URL out of the emphasis pass", () => {
    const html = render("[x](https://e.com/a*b*c)\n");
    expect(html).toContain('href="https://e.com/a*b*c"');
    expect(html).not.toContain("<em>");
  });

  it("still emphasises LINK TEXT — only the href is held", () => {
    // Deliberate: [**bold**](url) is valid markdown and rendered correctly
    // before, so the fix must not flatten it.
    const html = render("[**bold**](https://e.com)\n");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://e.com"');
  });

  it("still emphasises ordinary prose around code", () => {
    const html = render("*yes* and `no` and **also**\n");
    expect(html).toContain("<em>yes</em>");
    expect(html).toContain("<strong>also</strong>");
    expect(html).toContain("<code>no</code>");
  });

  it("leaves no placeholder sentinel in the output", () => {
    // The holder uses a NUL-delimited token, same family as the document-level
    // fence and math placeholders. One escaping to the output would be visible
    // garbage, so assert the restore pass is total.
    const NUL = new RegExp(String.fromCharCode(0));
    expect(render("`a` `b` [c](d) *e*\n")).not.toMatch(NUL);
  });
});
