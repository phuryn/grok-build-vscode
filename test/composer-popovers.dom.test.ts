/**
 * One popover at a time (#148): the composer's four popovers — Add context,
 * the Settings gear, the context donut and the mode picker — dismiss each
 * other on open, and each closes on its own button. Drives the shipped
 * media/chat.js through the happy-dom harness.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click } from "./webview-harness";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const POPOVERS = ["add-popover", "gear-popover", "context-popover", "mode-popover"] as const;
const OPENER: Record<(typeof POPOVERS)[number], string> = {
  "add-popover": "add-btn",
  "gear-popover": "gear-btn",
  "context-popover": "donut",
  "mode-popover": "mode-btn",
};
const visible = (doc: Document) => POPOVERS.filter((id) => !$(doc, id).hidden);

describe("composer popovers are exclusive (#148)", () => {
  for (const first of POPOVERS) {
    for (const second of POPOVERS) {
      if (first === second) continue;
      it(`opening ${second} closes ${first}`, () => {
        const h = bootWebview();
        click(h.window, $(h.doc, OPENER[first]));
        expect(visible(h.doc)).toEqual([first]);
        click(h.window, $(h.doc, OPENER[second]));
        expect(visible(h.doc)).toEqual([second]);
      });
    }
    it(`${first} closes on its own button`, () => {
      const h = bootWebview();
      click(h.window, $(h.doc, OPENER[first]));
      expect(visible(h.doc)).toEqual([first]);
      click(h.window, $(h.doc, OPENER[first]));
      expect(visible(h.doc)).toEqual([]);
    });
  }
});
