import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A confirmation is the topmost thing on screen, by definition.
 *
 * It asks a question about something the person cannot undo, so nothing may
 * cover it. That has been got wrong three times, and the first two were patched
 * for the one caller that noticed rather than at the root:
 *
 *   2026-08-15  the file panel's own menus opened UNDER the phone's full-screen
 *               panel; raised 1000 -> 1300.
 *   (same era)  the connect wizard opened behind the Settings page that
 *               launched it; given its own 200 override.
 *   2026-09-09  the Changes view's Discard on a phone. The panel goes
 *               full-screen at 1200 and the dialog was painted underneath it,
 *               so tapping Discard appeared to do nothing — leaving a
 *               destructive confirmation floating invisibly behind the panel.
 *
 * No DOM suite could catch this: each drives one page's elements, and this is a
 * relationship BETWEEN stylesheets. So it is asserted against the CSS itself.
 *
 * The four files here are the whole stacking universe FOR THIS REPO, and not
 * for the phone: the relay serves this webview inside its own page, whose
 * chrome declares layers inline in a `web/chat.html` nothing here can see. An
 * independent review caught that on 2026-09-09, when this comment claimed the
 * relay declared none. Its half of the guard is grok-remote's own
 * `test/confirm-stacking.test.ts`, which compares its layers against the
 * vendored copy of the rule below. Neither test is complete alone.
 */

const mediaDir = fileURLToPath(new URL("../media/", import.meta.url));
/** Comments carry braces and the words we scan for. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const sheets = readdirSync(mediaDir)
  .filter((f) => f.endsWith(".css"))
  .map((name) => ({ name, css: stripComments(readFileSync(join(mediaDir, name), "utf8")) }));

const chatJs = readFileSync(join(mediaDir, "chat.js"), "utf8");

const zIndexes = (css: string) => [...css.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]));

function zIndexFor(css: string, className: string): number | undefined {
  const rule = new RegExp(`\\.${className}\\s*\\{[^}]*?z-index:\\s*(-?\\d+)`, "s").exec(css);
  return rule ? Number(rule[1]) : undefined;
}

const confirmZ = zIndexFor(
  sheets.find((s) => s.name === "chat.css")!.css,
  "confirm-overlay",
);

describe("a confirmation outranks everything that can launch one", () => {
  it("finds a z-index on .confirm-overlay at all", () => {
    expect(confirmZ).toBeTypeOf("number");
  });

  it("puts it strictly above every other layer in every stylesheet", () => {
    // Named per file so a failure says which sheet grew a taller layer, not
    // merely that one exists. The historical culprits are all in here:
    // file-panel.css 1200/1300, projects-rail.css 1100, chat.css 10000.
    for (const { name, css } of sheets) {
      const others = zIndexes(css).filter((z) => z !== confirmZ);
      if (others.length === 0) continue;
      expect(Math.max(...others), `${name} declares a layer at or above the confirm overlay`)
        .toBeLessThan(confirmZ as number);
    }
    expect(sheets.some((s) => zIndexes(s.css).length > 1)).toBe(true);
  });

  it("lets no class composed onto the overlay re-declare a z-index", () => {
    // The trap that made the wizard's 200 override necessary: it mounts as
    // `class="confirm-overlay connect-wizard-overlay"`, two single-class
    // selectors of equal specificity, so a z-index on the second silently wins
    // on source order and drags the dialog back under the panel. Read the
    // compositions out of the renderer rather than listing them here, so a new
    // one is covered the day it is written.
    const composed = new Set<string>();
    for (const [, list] of chatJs.matchAll(/className\s*=\s*"(confirm-overlay[^"]*)"/g)) {
      for (const cls of list.split(/\s+/)) if (cls && cls !== "confirm-overlay") composed.add(cls);
    }
    expect(composed.size).toBeGreaterThan(0);

    for (const cls of composed) {
      for (const { name, css } of sheets) {
        expect(
          zIndexFor(css, cls),
          `${name}: .${cls} is composed onto .confirm-overlay and must not set its own z-index`,
        ).toBeUndefined();
      }
    }
  });
});
