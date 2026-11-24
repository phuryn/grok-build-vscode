import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** The body of one top-level object literal, so an assertion can name WHICH table. */
const objectBody = (source: string, name: string) => {
  const at = source.indexOf(`const ${name} = {`);
  expect(at, `${name} is missing`).toBeGreaterThan(-1);
  const end = source.indexOf(String.fromCharCode(10) + "  };", at);
  expect(end).toBeGreaterThan(at);
  return source.slice(at, end);
};

describe("provider logo assets", () => {
  // settings.js carries a third copy because the VS Code settings TAB loads
  // only settings.css + settings.js — it cannot reach a shared helper.
  it.each(["media/chat.js", "media/projects-rail.js", "media/settings.js"])("inlines both currentColor Lobe marks in %s", (file) => {
    const source = read(file);
    expect(source).toContain("Provider marks from Lobe Icons (MIT)");
    expect(source).toContain('viewBox="0 0 24 24" fill="currentColor"');
    // SCOPED to the table the lookup actually reads, not merely present in the
    // file. `dd7841d` pasted Meta's mark into COMPOSER_PLACEHOLDER in chat.js --
    // one object above the right one -- and a file-level `toContain` passed
    // while `PROVIDER_LOGO_PATHS.muse` stayed undefined. The model picker then
    // drew `<path d="undefined">`, an invisible glyph, and Muse's composer
    // placeholder became a two-kilobyte path string.
    const table = objectBody(source, "PROVIDER_LOGO_PATHS");
    for (const [id, head] of [
      ["grok", "M9.27 15.29l7.978-5.897"],
      ["codex", "M9.205 8.658v-2.26"],
      ["claude", "M4.709 15.955l4.72-2.647.08-.23-.08-.128"],
      ["muse", "M6.897 4c1.915 0 3.516.932 5.43 3.376"],
      ["agy", "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508"],
    ]) {
      expect(table, `${id} must be in PROVIDER_LOGO_PATHS, not merely somewhere in ${file}`)
        .toContain(`${id}: "${head}`);
    }
    const providerSvgs = source.match(/<svg class="provider-logo"[^>]*>/g) ?? [];
    expect(providerSvgs.length).toBeGreaterThan(0);
    expect(providerSvgs.every((svg) => !svg.includes("style="))).toBe(true);
    // Meta's two loops are drawn with holes, so nonzero fills them solid and
    // the mark becomes a blob. Lobe ships all four marks with evenodd and the
    // other three render the same under it, which is why it sits on the shared
    // template rather than on one provider's path.
    expect(providerSvgs.every((svg) => svg.includes('fill-rule="evenodd"'))).toBe(true);
    // No provider draws its own initial. A letter beside three real marks is a
    // placeholder, and Muse Code carried one until 4.11.0.
    expect(source).not.toMatch(/>[A-Z]<\/span>/);
  });

// The other half of the same mistake: a value in the placeholder table that
  // is a logo path is not a typo you see, it is what the composer asks you.
  it("gives every provider a composer prompt, never a logo path", () => {
    const body = objectBody(read("media/chat.js"), "COMPOSER_PLACEHOLDER");
    for (const id of ["grok", "codex", "claude", "muse", "agy"]) {
      const found = body.match(new RegExp(`${id}: l10n\\("([^"]*)", "([^"]*)"\\)`));
      expect(found, `${id} needs a composer placeholder`).toBeTruthy();
      expect(found![1]).toBe("Ask {0}…");
      expect(found![2].length, `${id}'s placeholder is too long to be a prompt`).toBeLessThan(40);
    }
  });

  it.each(["media/chat.css", "media/projects-rail.css"])("maps every badge state and draws the one-pixel row-color ring in %s", (file) => {
    const css = read(file);
    for (const state of ["working", "needs-you", "unread", "error"]) {
      expect(css).toContain(`provider-status-badge${file.endsWith("chat.css") ? `.dot-${state}` : `[data-dot="${state}"]`}`);
    }
    expect(css).toMatch(/\.provider-status-badge\s*\{[\s\S]*?width:\s*4px;[\s\S]*?height:\s*4px;/);
    expect(css).toContain("box-shadow: 0 0 0 1px var(--provider-badge-ring");
  });
});
