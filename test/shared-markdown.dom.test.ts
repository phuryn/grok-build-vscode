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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bootWebview, click } from "./webview-harness";

const chatCss = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");

// Same idea as test/nested-scroll.test.ts. A selector may share its rule with
// others, so the match runs from that selector through the declaration block.
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return chatCss.match(new RegExp(`${escaped}\\s*,?[^{]*\\{([^}]*)\\}`))?.[1] ?? "";
}

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

  it("turns a Pull request line into a chip that opens that PR", () => {
    const html = render(
      "Done.\n\nPull request: https://github.com/lines-frlp-utn/byo-kv-cache/pull/16\n",
    );
    expect(html).toContain('class="pr-open"');
    expect(html).toContain('href="https://github.com/lines-frlp-utn/byo-kv-cache/pull/16"');
    expect(html).toContain("PR #16");
    expect(html).toContain("lines-frlp-utn/byo-kv-cache");
    expect(html).not.toContain("Pull request:");
  });

  it("chips a bare GitHub pull URL on its own line, and a bold label", () => {
    const bare = render("https://github.com/acme/widgets/pull/82\n");
    expect(bare).toContain('href="https://github.com/acme/widgets/pull/82"');
    expect(bare).toContain("PR #82");
    const bold = render("**Pull request:** https://github.com/acme/widgets/pull/3\n");
    expect(bold).toContain("PR #3");
    expect(bold).not.toContain("**");
  });

  it("asks the host to open the pull request when the chip is clicked", () => {
    const h = bootWebview({ ready: true });
    const html = String(
      (h.window as any).__grokRenderMarkdown(
        "Pull request: https://github.com/acme/widgets/pull/82\n",
      ),
    );
    const host = h.doc.createElement("div");
    host.innerHTML = html;
    h.doc.body.appendChild(host);
    click(h.window, host.querySelector("a.pr-open")!);
    expect(h.posted).toContainEqual({
      type: "openUrl",
      url: "https://github.com/acme/widgets/pull/82",
    });
  });

  it("chips a pull URL inside a sentence and leaves the surrounding words", () => {
    const sentence = render(
      "El PR ya está abierto: https://github.com/lines-frlp-utn/byo-kv-cache/pull/17\n",
    );
    expect(sentence).toContain("El PR ya está abierto:");
    expect(sentence).toContain('class="pr-open"');
    expect(sentence).toContain("PR #17");
    expect(sentence).toContain('href="https://github.com/lines-frlp-utn/byo-kv-cache/pull/17"');
    expect(sentence).not.toContain(">https://github.com/lines-frlp-utn/byo-kv-cache/pull/17<");
  });

  it("links a bare http address and keeps sentence punctuation outside the href", () => {
    const html = render("Notas en https://example.com/docs.\n");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain(">https://example.com/docs</a>.");
    expect(html).not.toContain("pr-open");
  });

  it("leaves a pull URL inside a fence, a code span, or a named link as-is", () => {
    const fenced = render("```\nPull request: https://github.com/acme/widgets/pull/82\n```\n");
    expect(fenced).not.toContain("pr-open");
    const code = render("El id es `https://github.com/acme/widgets/pull/82` en el log.\n");
    expect(code).not.toContain("pr-open");
    expect(code).toContain("<code>https://github.com/acme/widgets/pull/82</code>");
    const linked = render("[#82](https://github.com/acme/widgets/pull/82)\n");
    expect(linked).not.toContain("pr-open");
    expect(linked).toContain('href="https://github.com/acme/widgets/pull/82"');
  });

  it("survives a null or undefined body without throwing", () => {
    const h = bootWebview({ ready: true });
    const fn = (h.window as any).__grokRenderMarkdown;
    expect(() => fn(null)).not.toThrow();
    expect(() => fn(undefined)).not.toThrow();
  });
});

describe("markdown linkification edge cases (#185)", () => {
  it("keeps a standalone backticked PR URL literal", () => {
    const url = "https://github.com/acme/widgets/pull/17";
    for (const prefix of ["", "Pull request: "]) {
      const html = render(`${prefix}\`${url}\`\n`);
      expect(html).toContain(`<code>${url}</code>`);
      expect(html).not.toContain("<a ");
    }
  });

  it("keeps emphasis delimiters out of a bare URL's target", () => {
    const url = "https://example.com/docs";
    for (const [mark, tag] of [["**", "strong"], ["*", "em"], ["_", "em"]]) {
      expect(render(`${mark}${url}${mark}\n`)).toContain(
        `<${tag}><a href="${url}">${url}</a></${tag}>`,
      );
    }
  });

  it("keeps asterisks inside a bare URL literal", () => {
    for (const url of ["https://e.com/a*b*c", "https://e.com/path/*a*/file"]) {
      expect(render(`see ${url}\n`)).toBe(`see <a href="${url}">${url}</a>`);
      expect(render(`**${url}**\n`)).toBe(`<strong><a href="${url}">${url}</a></strong>`);
    }
  });

  it("keeps underscores inside a bare URL literal", () => {
    const url = "https://e.com/path/_a_/file";
    expect(render(`see ${url}\n`)).toBe(`see <a href="${url}">${url}</a>`);
    expect(render(`_${url}_\n`)).toBe(`<em><a href="${url}">${url}</a></em>`);
  });

  it("links an angle-bracket autolink without including its brackets", () => {
    const url = "https://example.com/docs";
    expect(render(`<${url}>\n`)).toBe(`<a href="${url}">${url}</a>`);
    const query = `${url}?a=1&b=2`;
    expect(render(`<${query}>\n`)).toBe(
      `<a href="${url}?a=1&amp;b=2">${url}?a=1&amp;b=2</a>`,
    );
  });

  it("links an absolute local path that contains spaces, and not a relative one", () => {
    const path = "/home/user/My Project/README.md";
    const href = `<a href="${path}">README</a>`;
    expect(render(`Notes in [README](${path}) today.\n`)).toContain(href);
    expect(render(`1. Read [README](${path})\n`)).toContain(`<li>Read ${href}`);
    expect(render(`### [README](${path})\n`)).toContain(`<h3>${href}</h3>`);

    const win = String.raw`C:\Program Files (x86)\App\readme.md`;
    const fwd = "C:/Program Files (x86)/App/readme.md";
    const unc = String.raw`\\server\share\My Folder\readme.md`;
    expect(render(`[app](${win})\n`)).toContain(`<a href="${win}">app</a>`);
    expect(render(`[app](${fwd})\n`)).toContain(`<a href="${fwd}">app</a>`);
    expect(render(`[share](${unc})\n`)).toContain(`<a href="${unc}">share</a>`);
    expect(render(`[readme](</home/user/My Project/README.md>)\n`)).toContain(
      `<a href="${path}">readme</a>`,
    );

    const other = "/home/user/Other File.md";
    expect(render(`[one](${path}) and [two](${other})\n`)).toBe(
      `<a href="${path}">one</a> and <a href="${other}">two</a>`,
    );
    expect(render("[see](the docs)\n")).toBe("[see](the docs)");
    expect(render("[keep](/home/user/My%20Project/README.md)\n")).toContain(
      'href="/home/user/My%20Project/README.md"',
    );

    const literal = render(`Use \`${path}\` as written.\n`);
    expect(literal).toContain(`<code>${path}</code>`);
    expect(literal).not.toContain("<a ");
    const linked = render("`[README](" + path + ")` stays literal\n");
    expect(linked).not.toContain('href="');
    expect(linked).toContain(`<code>[README](${path})</code>`);
  });

  it("opens a spaced local path with the spaces intact", () => {
    const path = "/home/user/My Project/README.md";
    const h = bootWebview({ ready: true });
    const host = h.doc.createElement("div");
    host.innerHTML = String((h.window as any).__grokRenderMarkdown(`[README](${path})\n`));
    h.doc.body.appendChild(host);
    click(h.window, host.querySelector("a")!);
    expect(h.posted).toContainEqual({ type: "openFile", path });
  });

  it("does not linkify a URL inside a named Markdown link's label", () => {
    for (const url of ["https://example.com/docs", "https://github.com/acme/widgets/pull/17"]) {
      const html = render(`[Read **docs** at ${url} with \`code\`](https://example.org/guide)\n`);
      expect(html).toBe(
        `<a href="https://example.org/guide">Read <strong>docs</strong> at ${url} with <code>code</code></a>`,
      );
      expect(html.match(/<a\b/g)).toHaveLength(1);
      expect(html).not.toContain(String.fromCharCode(0));
    }
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

/**
 * A file path written as a heading is still a link. The anchor is produced —
 * the label shows, the raw markdown does not — but the browser client then
 * paints every non-http anchor under #messages as inherited text and turns
 * hit-testing off (`#messages a:not([href^="http"])`). A heading whose whole
 * content is that path reads as an ordinary heading. happy-dom does not
 * compute styles, so the treatment is asserted on the stylesheet, the same
 * way nested-scroll asserts a rule body.
 */
describe("a link inside a heading stays a link", () => {
  function mount(md: string) {
    const h = bootWebview({ ready: true });
    const host = h.doc.createElement("div");
    host.className = "msg agent";
    const body = h.doc.createElement("div");
    body.className = "body";
    body.innerHTML = String((h.window as any).__grokRenderMarkdown(md));
    host.appendChild(body);
    h.doc.getElementById("messages")!.appendChild(host);
    return { h, body };
  }

  it("renders the spaced angle-bracket file headings as anchors and opens the path", () => {
    const agents = "/home/user/My Project/fde-template/AGENTS.md";
    const coverage = "/home/user/My Project/fde-template/docs/test-coverage.md";
    const { h, body } = mount(
      [
        `### 1. [AGENTS.md](<${agents}>)`,
        `### 3. [test-coverage.md](<${coverage}>)`,
      ].join("\n") + "\n",
    );
    const headings = [...body.querySelectorAll("h3")];
    expect(headings.map((el) => el.textContent)).toEqual([
      "1. AGENTS.md",
      "3. test-coverage.md",
    ]);
    const links = headings.map((el) => el.querySelector("a"));
    expect(links[0]?.getAttribute("href")).toBe(agents);
    expect(links[1]?.getAttribute("href")).toBe(coverage);
    click(h.window, links[1]!);
    expect(h.posted).toContainEqual({ type: "openFile", path: coverage });

    // A phone or browser cannot open a file on the host, so the browser
    // client deliberately paints non-http anchors as inert text
    // (`#messages a:not([href^="http"])`). A heading link must not outrank
    // that: a tappable link that does nothing is worse than plain text.
    expect(chatCss).not.toMatch(/#messages h[1-4] a/);
    expect(ruleBody(".files-browse-md h3")).toMatch(/margin\s*:\s*16px 0 8px/);
    expect(ruleBody(".files-browse-md h3")).toMatch(/font-weight\s*:\s*600/);
    expect(ruleBody(".files-browse-md h3")).not.toMatch(/\bcolor\s*:/);
    expect(chatCss).toContain(".files-browse-md h1 { font-size: 1.4em; }");
    expect(chatCss).toContain(".files-browse-md h2 { font-size: 1.25em; }");
    expect(chatCss).toContain(".files-browse-md h3 { font-size: 1.1em; }");
  });

  it("links a bare spaced path and an https address from h1 through h4", () => {
    const bare = "/home/user/My Project/a.md";
    const url = "https://example.com/docs";
    for (const marks of ["#", "##", "###", "####"]) {
      const level = marks.length;
      const { h, body } = mount(`${marks} [a](${bare})\n${marks} [docs](${url})\n`);
      const headings = [...body.querySelectorAll(`h${level}`)];
      expect(headings).toHaveLength(2);
      expect(headings[0].querySelector("a")?.getAttribute("href")).toBe(bare);
      expect(headings[1].querySelector("a")?.getAttribute("href")).toBe(url);
      click(h.window, headings[0].querySelector("a")!);
      click(h.window, headings[1].querySelector("a")!);
      expect(h.posted).toContainEqual({ type: "openFile", path: bare });
      expect(h.posted).toContainEqual({ type: "openUrl", url });
    }
  });

  it("still leaves a relative destination and a code span literal inside a heading", () => {
    expect(render("### [see](the docs)\n")).toBe("<h3>[see](the docs)</h3>");
    const literal = render("### Use `a b` as written.\n");
    expect(literal).toContain("<h3>Use <code>a b</code> as written.</h3>");
    expect(literal).not.toContain("<a ");
  });
});
