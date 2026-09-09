import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fileTreePanelBootSource } from "../src/desktop/file-tree-panel";
import { Window } from "happy-dom";

const iconsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "file-icons");
const filePanelJs = fs.readFileSync(path.join(iconsDir, "..", "file-panel.js"), "utf8");
const filePanelCss = fs.readFileSync(path.join(iconsDir, "..", "file-panel.css"), "utf8");
const iconWindow = new Window();
(iconWindow as never as { eval: (source: string) => void }).eval(filePanelJs);
const sharedIconId = (iconWindow as never as {
  GrokFilePanel: { defaultFileIconId: (kind: string, name: string) => string };
}).GrokFilePanel.defaultFileIconId;

function isMonochromeSvg(svg: string): boolean {
  const fills = [...svg.matchAll(/\bfill\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1].trim().toLowerCase())
    .filter((fill) => fill !== "none" && fill !== "currentcolor");
  return fills.length === 0;
}

describe("fileIconId (Seti mapping)", () => {
  it("maps known extensions and directories", () => {
    expect(sharedIconId("dir", "src")).toBe("folder");
    expect(sharedIconId("file", "app.js")).toBe("javascript");
    expect(sharedIconId("file", "app.ts")).toBe("typescript");
    expect(sharedIconId("file", "App.tsx")).toBe("react");
    expect(sharedIconId("file", "photo.png")).toBe("image");
    expect(sharedIconId("file", "photo.PNG")).toBe("image");
    expect(sharedIconId("file", "readme.md")).toBe("markdown");
    expect(sharedIconId("file", "package.json")).toBe("npm");
    expect(sharedIconId("file", "styles.css")).toBe("css");
    expect(sharedIconId("file", "unknown.xyz")).toBe("default");
  });
});

describe("Seti icon assets", () => {
  it("ships the icons used for common extensions", () => {
    for (const id of [
      "javascript",
      "typescript",
      "image",
      "markdown",
      "json",
      "css",
      "folder",
      "default",
    ]) {
      const svg = fs.readFileSync(path.join(iconsDir, `${id}.svg`), "utf8");
      expect(svg.trim().startsWith("<svg"), id).toBe(true);
    }
    expect(sharedIconId("file", "x.js")).toBe("javascript");
    expect(sharedIconId("file", "x.png")).toBe("image");
    expect(sharedIconId("dir", "lib")).toBe("folder");
  });

  it("passes a lazy icon resolver to the shared component without embedding SVG payloads", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    expect(boot).toContain('new URL("file-icons/", componentScript.src)');
    expect(boot).toContain("fileIcons: { baseUrl: iconBase }");
    expect(boot).not.toContain("fileIconId");
    expect(boot).not.toContain("monochromeIds");
    expect(boot).not.toContain("data:image/svg+xml");
    expect(sharedIconId("file", "app.test.tsx")).toBe("react");
    expect(sharedIconId("file", "package.json")).toBe("npm");
    expect(sharedIconId("file", "photo.PNG")).toBe("image");
    expect(filePanelJs).toContain('img.src = src');
    expect(filePanelCss).toContain("--rail-hover-bg");
    expect(filePanelCss).toContain("--rail-row-min-height");
  });

  it("title strip and file tabs reuse renderFileIcon, not a second mapping", () => {
    expect(filePanelJs).toContain('renderFileIcon(icon, label, "dir")');
    expect(filePanelJs).toContain("gfp-title-icon");
    expect(filePanelJs).toContain("gfp-tab-icon");
    expect(filePanelJs).toContain('renderFileIcon(icon, fileName(relPath), tab.kind === "dir" ? "dir" : "file")');
    expect(filePanelCss).toMatch(/\.gfp-title-icon[\s\S]*?width:\s*16px/);
    expect(filePanelCss).toMatch(/\.gfp-tab-icon[\s\S]*?width:\s*16px/);
    expect(filePanelCss).not.toMatch(/\.gfp-title\s*\{[^}]*text-transform:\s*uppercase/s);
    expect(filePanelCss).not.toMatch(/\.gfp-title\s*\{[^}]*font-weight:\s*700/s);
    expect(filePanelCss).toMatch(/\.gfp-tab\[hidden\][\s\S]*?display:\s*none\s*!important/);
    expect(filePanelCss).not.toMatch(/\.gfp-tabs\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it("directory rows use a disclosure chevron and no folder Seti glyph", () => {
    expect(filePanelJs).toContain('lead.innerHTML = ICON.chevronRight');
    expect(filePanelJs).toContain('else renderFileIcon(lead, entry.name, entry.kind)');
    expect(filePanelJs).toContain('lead.innerHTML = opening ? ICON.chevronDown : ICON.chevronRight');
    expect(filePanelJs).toMatch(/m9 18 6-6-6-6/);
    expect(filePanelJs).toMatch(/m6 9 6 6 6-6/);
    expect(filePanelJs).not.toMatch(/["']▶["']|["']▼["']|["']▸["']|["']▾["']/);
    expect(filePanelCss).toMatch(/\.gfp-lead\s*\{[^}]*flex:\s*0 0 16px/s);
    expect(filePanelCss).toMatch(/\.gfp-row\s*\{[^}]*min-height:\s*var\(--rail-row-min-height/s);
  });

  it("file and folder leads share the same column model and per-level indent", () => {
    expect(filePanelJs).toContain('row.style.setProperty("--gfp-depth", String(depth))');
    expect(filePanelJs).toContain('lead.className = "gfp-lead desk-ft-lead files-browse-row-icon"');
    expect(filePanelCss).toContain("calc(6px + var(--gfp-depth, 0) * 12px)");
    expect(filePanelCss).toMatch(/\.gfp-lead\s*\{[^}]*width:\s*16px/s);
    expect(filePanelCss).toMatch(/\.gfp-row\s*\{[^}]*min-height:\s*var\(--rail-row-min-height,\s*24px\)/s);
  });

  it("drops the file-tree hover fill on touch, matching the rail's in-flow actions", () => {
    const touch = filePanelCss.match(
      /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?^\}/m,
    )?.[0] ?? "";
    expect(touch).toMatch(/\.gfp-row:hover\s*\{\s*background:\s*transparent/);
    expect(touch).toMatch(/\.gfp-row-actions\s*\{[^}]*position:\s*static/s);
    expect(touch).toMatch(/\.gfp-row-actions\s*\{[^}]*background:\s*transparent/s);
    expect(touch).toMatch(/\.gfp-row-actions\s*\{[^}]*display:\s*flex/s);
  });

  it("reveals row actions on hover, :focus-visible, and an open ⋯ menu — not :focus-within", () => {
    expect(filePanelCss).not.toMatch(/\.gfp-row:focus-within\s+\.gfp-row-actions/);
    expect(filePanelCss).toMatch(/\.gfp-row:hover \.gfp-row-actions/);
    expect(filePanelCss).toMatch(/\.gfp-row:focus-visible \.gfp-row-actions/);
    expect(filePanelCss).toMatch(/\.gfp-row:has\(:focus-visible\) \.gfp-row-actions/);
    expect(filePanelCss).toMatch(/\.gfp-row\.gfp-menu-open \.gfp-row-actions/);
  });
});

describe("fill-less Seti glyphs are theme-tinted, not black", () => {
  it("classifies by the SVG's own fill, not a hand-kept list", () => {
    // A coloured glyph carries an explicit fill; a plain one carries none, and
    // SVG then defaults it to BLACK — invisible on a dark theme.
    expect(isMonochromeSvg('<svg><path fill="#cbcb41" d="M0 0"/></svg>')).toBe(false);
    expect(isMonochromeSvg('<svg><path d="M0 0"/></svg>')).toBe(true);
    // `fill="none"` is a stroke-drawn glyph, which is still uncoloured.
    expect(isMonochromeSvg('<svg><path fill="none" stroke="#abc" d="M0 0"/></svg>')).toBe(true);
  });

  it("catches the generic text icon the user reported, and its whole class", () => {
    const mono = new Set(
      fs.readdirSync(iconsDir)
        .filter((name) => name.endsWith(".svg"))
        .filter((name) => isMonochromeSvg(fs.readFileSync(path.join(iconsDir, name), "utf8")))
        .map((name) => name.slice(0, -4)),
    );
    // `.dockerignore` and every other unmapped file falls back to `default`.
    expect(mono.has("default")).toBe(true);
    // Not an isolated glyph — a third of the vendored set had the same defect.
    expect(mono.size).toBeGreaterThan(20);
    // Coloured glyphs must NOT be repainted, or Seti stops being Seti.
    expect(mono.has("javascript")).toBe(false);
    expect(mono.has("css")).toBe(false);
  });

  it("renders those in the surrounding text colour, never opacity", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    expect(boot).toContain("fileIcons: { baseUrl: iconBase }");
    expect(filePanelJs).toContain("MONOCHROME_FILE_ICONS.has(id)");
    expect(filePanelJs).toContain('"default"');
    expect(filePanelJs).toContain("gfp-file-icon-mono desk-ft-icon-mono");
    expect(filePanelJs).toContain('--gfp-icon-url');
    // The tint follows the text beside it: a tree row's lead is the muted
    // grey, an active tab is the foreground, and both resolve per theme
    // because the text colours do. It used to be pinned to the grey, which
    // left the selected tab's icon dimmed beside its lit name.
    expect(filePanelCss).toMatch(/\.gfp-file-icon-mono\s*\{[^}]*background:\s*currentColor/s);
    expect(filePanelCss).toMatch(/\.gfp-file-icon-mono\s*\{[^}]*mask:/s);
  });
});

describe("markdown preview uses the conversation's renderer", () => {
  it("delegates to chat.js and keeps a fallback", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    // One renderer for both surfaces — the private subset dropped bullets and
    // tables entirely, which is exactly what this replaces.
    expect(boot).toContain("window.__grokRenderMarkdown");
    expect(filePanelJs).toContain('"<pre>" + escapeHtml(source) + "</pre>"');
  });

  it("defers markdown typography to chat.css; keeps only panel layout bounds", () => {
    // Shared with .msg.agent .body — do not restate list/table colours here.
    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    expect(chatCss).toMatch(/\.desk-ft-md\s+ul|\.desk-ft-md ul/);
    // Shared with remote files-browse-md as well as the desktop panel class.
    expect(chatCss).toMatch(
      /\.desk-ft-md ul(?:, \.files-browse-md ul)? \{ list-style-type: disc|\.msg\.agent \.body ul,\s*\n\.desk-ft-md ul/,
    );
    expect(chatCss).toContain(".desk-ft-md th");
    expect(chatCss).toMatch(
      /\.desk-ft-md th[\s\S]*textBlockQuote-background|textBlockQuote-background[\s\S]*\.desk-ft-md th/,
    );
    // Panel only constrains table width so a wide table does not grow the column.
    expect(filePanelCss).toContain(".gfp-markdown .md-table-wrap");
    expect(filePanelCss).toMatch(
      /\.gfp-markdown \.md-table-wrap\s*\{[^}]*max-width:\s*100%/s,
    );
    expect(filePanelCss).not.toMatch(/textCodeBlock-background/);
  });
});
