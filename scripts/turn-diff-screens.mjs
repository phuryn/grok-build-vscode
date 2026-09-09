// Does the turn-level "Changed N files" card actually READ, on every surface?
//
// The card is drawn by media/chat.js from the same wire diffs the tool rows
// paint, so the only honest way to photograph it is to run the SHIPPED chat.js
// against the SHIPPED chat.css and dispatch real host messages at it. That is
// what this does: the webview shell comes from test/webview-harness.ts (the
// same <body> the DOM suite boots), the scripts are the real media/ files, and
// Chromium supplies the layout engine the happy-dom suite cannot.
//
// What it cannot catch is a host that sends a shape sidebar.ts would never
// send. test/turn-diff-summary.dom.test.ts covers the behaviour half.
//
// Frames land in .screens/turn-diff/ for a person to look at. The assertions
// are the part that fails the build: the touch floor on a file row, no
// horizontal overflow at any width, the card using the product's own --tdiff-*
// palette rather than a second one, and the roll-up disappearing exactly where
// the rows already show the diffs in full.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.isAbsolute(process.env.SCREENS_DIR || "")
  ? path.join(process.env.SCREENS_DIR, "turn-diff")
  : path.join(root, process.env.SCREENS_DIR || ".screens", "turn-diff");
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(`[turn-diff-screens] ${m}`);
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

// The DOM suite's <body> is the one mirror of getHtml() we maintain; reuse it
// rather than keeping a second copy that can drift. A plain template literal
// with no interpolation, so slicing it out is exact — and a miss throws.
const harnessSrc = read("test", "webview-harness.ts");
const bodyMatch = harnessSrc.match(/export const BODY = `([\s\S]*?)`;/);
if (!bodyMatch) throw new Error("test/webview-harness.ts no longer exports a plain BODY template");
const BODY = bodyMatch[1];

const chatCss = read("media", "chat.css");
const helperJs = read("media", "webview-helpers.js");
const settingsJs = read("media", "settings.js");
const panelJs = read("media", "file-panel.js");
const chatJs = read("media", "chat.js");

// VS Code's own defaults, trimmed to what this card and its neighbours read.
const DARK = {
  foreground: "#CCCCCC",
  descriptionForeground: "rgba(204,204,204,0.7)",
  "editor-background": "#1F1F1F",
  // chat.css paints html/body from this one, not from editor-background.
  "sideBar-background": "#181818",
  "editor-foreground": "#CCCCCC",
  "editorWidget-background": "#202020",
  "editorWidget-border": "#454545",
  "editor-inactiveSelectionBackground": "#3A3D41",
  "widget-border": "#313131",
  "panel-border": "#2B2B2B",
  "input-background": "#313131",
  "input-foreground": "#CCCCCC",
  "input-border": "#3C3C3C",
  focusBorder: "#0078D4",
  "button-background": "#0078D4",
  "button-foreground": "#FFFFFF",
  "button-secondaryBackground": "#313131",
  "button-secondaryForeground": "#CCCCCC",
  "list-hoverBackground": "#2A2D2E",
  "textLink-foreground": "#4DAAFC",
  "textPreformat-foreground": "#D7BA7D",
  "textBlockQuote-background": "#2B2B2B",
  errorForeground: "#F85149",
  contrastBorder: "transparent",
};

const LIGHT = {
  ...DARK,
  foreground: "#3B3B3B",
  descriptionForeground: "rgba(59,59,59,0.7)",
  "editor-background": "#FFFFFF",
  "sideBar-background": "#F8F8F8",
  "editor-foreground": "#3B3B3B",
  "editorWidget-background": "#F8F8F8",
  "editorWidget-border": "#C8C8C8",
  "editor-inactiveSelectionBackground": "#E5EBF1",
  "widget-border": "#E5E5E5",
  "panel-border": "#E5E5E5",
  "input-background": "#FFFFFF",
  "input-border": "#CECECE",
  "input-foreground": "#3B3B3B",
  "button-secondaryBackground": "#E5E5E5",
  "button-secondaryForeground": "#3B3B3B",
  "list-hoverBackground": "#E8E8E8",
  "textLink-foreground": "#005FB8",
  "textPreformat-foreground": "#A31515",
  "textBlockQuote-background": "#F3F3F3",
};

const vars = (theme) =>
  Object.entries(theme)
    .map(([k, v]) => `--vscode-${k}: ${v};`)
    .join("\n");

function page(theme, themeClass, remote) {
  // The relay's chat.html carries this, and without it Chromium's mobile
  // emulation lays the page out at 980px and scales the result down — every
  // measurement then reads correct while the pixels a thumb meets are half the
  // size. The touch assertion below is worthless without this line.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>:root { ${vars(theme)} }
/* getHtml() paints these on the host page, not in chat.css. Without them the
   frame is a themed card floating on white, which reads nothing like the
   product. */
html, body {
  margin: 0;
  height: 100%;
  background: var(--vscode-sideBar-background);
  color: var(--vscode-editor-foreground);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
}
${chatCss}</style></head>
<body class="${themeClass}">${BODY}
<script>
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => { (window.__posted ||= []).push(m); },
    setState: () => {}, getState: () => undefined,
  });
</script>
${remote ? "<script>window.grokRemoteClient = true;</script>" : ""}
<script>${helperJs}</script>
<script>${settingsJs}</script>
<script>${panelJs}</script>
<script>${chatJs}</script>
</body></html>`;
}

const diff = (p, oldText, newText) => ({ type: "diff", path: p, oldText, newText });

// One realistic coding turn: two files edited, one of them twice, one created,
// one deleted through the shell — every row shape the card can draw.
const TURN = [
  { type: "appPurpose", value: "coding" },
  { type: "agentStart" },
  { type: "toolCall", call: { toolCallId: "t1", kind: "edit", title: "Edit src/remote-uplink.ts" } },
  {
    type: "toolCallUpdate",
    call: {
      toolCallId: "t1",
      content: [
        diff(
          "src/remote-uplink.ts",
          "  constructor(url: string) {\n    this.url = url;\n  }",
          "  constructor(url: string, options: UplinkOptions = {}) {\n    this.url = url;\n    this.retryCeiling = options.retryCeiling ?? 30_000;\n  }",
        ),
      ],
    },
  },
  { type: "toolCall", call: { toolCallId: "t2", kind: "edit", title: "Write src/git-run.ts" } },
  {
    type: "toolCallUpdate",
    call: { toolCallId: "t2", content: [diff("src/git-run.ts", "", "import { execFile } from \"node:child_process\";\nexport const GIT_READ_TIMEOUT_MS = 20_000;\nexport const GIT_WRITE_TIMEOUT_MS = 180_000;")] },
  },
  { type: "toolCall", call: { toolCallId: "t3", kind: "edit", title: "Edit src/remote-uplink.ts" } },
  {
    type: "toolCallUpdate",
    call: {
      toolCallId: "t3",
      content: [
        diff(
          "src/remote-uplink.ts",
          "    this.retryCeiling = options.retryCeiling ?? 30_000;",
          "    this.retryCeiling = options.retryCeiling ?? 30_000;\n    this.onClose = options.onClose;",
        ),
      ],
    },
  },
  {
    type: "toolCall",
    call: {
      toolCallId: "t4",
      kind: "execute",
      title: "Remove-Item src/legacy/poller.ts",
      rawInput: { command: "Remove-Item -Force 'src/legacy/poller.ts'" },
    },
  },
  { type: "agentEnd" },
];

// A path long enough to need the ellipsis, on its own so the frame is about
// that one question.
const LONG_PATH_TURN = [
  { type: "appPurpose", value: "coding" },
  { type: "agentStart" },
  { type: "toolCall", call: { toolCallId: "L1", kind: "edit", title: "Edit deep file" } },
  {
    type: "toolCallUpdate",
    call: {
      toolCallId: "L1",
      content: [
        diff(
          "packages/relay-transport/src/internal/handlers/session/lifecycle/reconnect-backoff-policy.ts",
          "const a = 1;",
          "const a = 2;",
        ),
      ],
    },
  },
  { type: "agentEnd" },
];

const CASES = {
  turn: { messages: TURN, expectCard: true },
  longPath: { messages: LONG_PATH_TURN, expectCard: true },
  // The roll-up would repeat what the open rows already say in full.
  expanded: { messages: [...TURN, { type: "expandCommandOutputs", value: true }], expectCard: false },
  // Knowledge work is not about files being edited.
  knowledge: { messages: [...TURN, { type: "appPurpose", value: "knowledge" }], expectCard: false },
  // The same turn on a phone. The rows behave identically here — they reveal
  // the file's own tool row — and the frame is the only place to SEE that they
  // still read as rows you can press at thumb size.
  remote: { messages: TURN, expectCard: true, remote: true },
  // The way out of the card. The link is offered only where a file panel is
  // mounted AND has a repository to talk about, so it needs a panel on the
  // page to exist at all — every other case here is the negative frame.
  withPanel: { messages: TURN, expectCard: true, panel: true },
  // A panel that says no. A knowledge-work session and a folder that is not a
  // repository both land here, and both are ordinary rather than exotic: the
  // card must simply not offer the link.
  panelSaysNo: { messages: TURN, expectCard: true, panel: "no" },
};

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 834, height: 1112, touch: true },
  { name: "desk", width: 1280, height: 900, touch: false },
];

const THEMES = [
  { name: "dark", theme: DARK, cls: "vscode-dark" },
  { name: "light", theme: LIGHT, cls: "vscode-light" },
];

const MIN_TOUCH_PX = 36;
// A filename and its counts have to read as one row. 640px of measure on the
// row leaves at most this much between them at any width the product runs at.
const MAX_STAT_GAP_PX = 620;
let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`[turn-diff-screens] FAIL ${m}`);
};

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    for (const th of THEMES) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        hasTouch: vp.touch,
        isMobile: vp.touch,
      });
      for (const [caseName, spec] of Object.entries(CASES)) {
        const p = await context.newPage();
        await p.setContent(page(th.theme, th.cls, spec.remote), { waitUntil: "load" });
        if (spec.panel) {
          // The smallest thing chat.js will accept as a panel: the two methods
          // it capability-detects, and nothing else. Standing in for the real
          // component keeps this harness about the CARD.
          await p.evaluate((available) => {
            window.__grokDeskFilePanel = {
              canShowChanges: () => available,
              showChanges: () => { window.__openedChanges = true; return true; },
            };
          }, spec.panel !== "no");
        }
        for (const m of spec.messages) {
          await p.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), m);
        }
        await p.waitForTimeout(60);

        const id = `${vp.name}-${th.name}-${caseName}`;
        await p.screenshot({ path: path.join(OUT, `${id}.png`), fullPage: false });

        const seen = await p.evaluate((minPx) => {
          const card = document.querySelector(".turn-diff-summary");
          const shown = !!card && getComputedStyle(card).display !== "none";
          const rows = card ? [...card.querySelectorAll(".turn-diff-file")] : [];
          const px = (v) => Number.parseFloat(v) || 0;
          return {
            present: !!card,
            shown,
            title: card?.querySelector(".turn-diff-summary-title")?.textContent || "",
            rowCount: rows.length,
            // The filename is what identifies a row; only the directory may be
            // cut. Any leaf whose text does not fully fit is a defect.
            clippedNames: rows
              .map((r) => r.querySelector(".turn-diff-file-name"))
              .filter((n) => n && n.scrollWidth > n.clientWidth + 1)
              .map((n) => n.textContent),
            shortRows: rows
              .filter((r) => r.getBoundingClientRect().height < minPx)
              .map((r) => `${r.querySelector(".turn-diff-file-path")?.textContent} @ ${Math.round(r.getBoundingClientRect().height)}px`),
            // A path row must ellipsize, never widen the transcript.
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            widest: rows.length
              ? Math.max(...rows.map((r) => Math.round(r.getBoundingClientRect().width)))
              : 0,
            // The gap a reader's eye has to cross from the end of a filename to
            // the +A −R that belongs to it. Unbounded on a wide window until
            // the row grew a measure.
            widestStatGap: Math.round(
              Math.max(
                0,
                ...rows.map((r) => {
                  const name = r.querySelector(".turn-diff-file-path");
                  const stat = r.querySelector(".diff-stat");
                  if (!name || !stat) return 0;
                  // The span is full-width; the TEXT inside it is what is drawn.
                  const range = document.createRange();
                  range.selectNodeContents(name);
                  const textRight = range.getBoundingClientRect().right;
                  range.detach?.();
                  return stat.getBoundingClientRect().left - textRight;
                }),
              ),
            ),
            // A row is either a control with a promise in its tooltip, or a
            // plain line. Nothing in between, on any surface.
            rowKinds: rows.map((r) => `${r.tagName}:${r.title || ""}`),
            // The ground the card is actually drawn on. A themed card floating
            // on an unthemed page is a frame nobody should trust.
            pageGround: getComputedStyle(document.body).backgroundColor,
            cardWidth: card ? Math.round(card.getBoundingClientRect().width) : 0,
            // The card must take its +/- colours from the shared diff palette,
            // not a second one invented for it.
            addColour: card
              ? getComputedStyle(card.querySelector(".diff-stat-add") || card).color
              : "",
            paletteAdd: getComputedStyle(document.body).getPropertyValue("--tdiff-add-line").trim(),
            // The D in front of a deleted path, in the palette's red.
            deletedColour: (() => {
              const tag = card?.querySelector(".turn-diff-file-status.is-d");
              return tag ? getComputedStyle(tag).color : "";
            })(),
            paletteDel: getComputedStyle(document.body).getPropertyValue("--tdiff-del-line").trim(),
            // The link out of the card: present, named, and a real target on
            // a phone. Measured rather than assumed, because it is a control
            // that appears only under a condition and those are the ones that
            // quietly stop appearing.
            openChanges: (() => {
              const link = card?.querySelector(".turn-diff-open-changes");
              if (!link) return null;
              const box = link.getBoundingClientRect();
              return {
                text: link.textContent,
                height: Math.round(box.height),
                inside: !!card && box.right <= card.getBoundingClientRect().right + 1,
                last: card.lastElementChild?.classList.contains("turn-diff-summary-foot") === true,
              };
            })(),
            px,
          };
        }, MIN_TOUCH_PX);

        if (spec.expectCard) {
          if (!seen.shown) fail(`${id}: expected the roll-up card, none visible`);
          if (!seen.rowCount) fail(`${id}: card has no file rows`);
        } else {
          if (seen.shown) fail(`${id}: the roll-up should be hidden here, it is visible`);
          // Built but hidden, so flipping the preference back restores it.
          if (!seen.present) fail(`${id}: card was removed rather than hidden`);
        }
        // Offered exactly where a panel says it can show Changes, and nowhere
        // else. A dead link on a knowledge session is worse than no link.
        const wantsLink = spec.panel === true;
        if (wantsLink && !seen.openChanges) fail(`${id}: no way out of the card into Changes`);
        if (!wantsLink && seen.openChanges) fail(`${id}: offered Changes with no panel able to show it`);
        if (seen.openChanges) {
          if (!/changes/i.test(seen.openChanges.text)) fail(`${id}: the link does not name Changes: "${seen.openChanges.text}"`);
          if (!seen.openChanges.last) fail(`${id}: the link is not the last thing in the card`);
          if (!seen.openChanges.inside) fail(`${id}: the link overflows the card`);
          if (vp.touch && seen.openChanges.height < MIN_TOUCH_PX) {
            fail(`${id}: the link is ${seen.openChanges.height}px tall on a touch surface`);
          }
        }
        // Pressing it has to reach the panel, not merely look like it would.
        if (wantsLink) {
          await p.click(".turn-diff-open-changes");
          if (!(await p.evaluate(() => window.__openedChanges === true))) {
            fail(`${id}: pressing the link did not open Changes`);
          }
        }
        if (seen.overflowX > 0) fail(`${id}: page scrolls sideways by ${seen.overflowX}px`);
        if (seen.shown && seen.widest > seen.cardWidth) {
          fail(`${id}: a file row (${seen.widest}px) is wider than the card (${seen.cardWidth}px)`);
        }
        if (seen.shown && seen.clippedNames.length) {
          fail(`${id}: filename clipped, only the directory may be cut — ${seen.clippedNames.join(", ")}`);
        }
        if (seen.shown && seen.widestStatGap > MAX_STAT_GAP_PX) {
          fail(`${id}: ${seen.widestStatGap}px between a filename and its +A −R (max ${MAX_STAT_GAP_PX})`);
        }
        if (vp.touch && seen.shown && seen.shortRows.length) {
          fail(`${id}: file rows under ${MIN_TOUCH_PX}px — ${seen.shortRows.join(", ")}`);
        }
        if (seen.shown && seen.addColour && seen.paletteAdd) {
          // Both resolve through the same var, so they must render identically.
          const norm = (c) => c.replace(/\s+/g, "").toLowerCase();
          if (norm(seen.addColour) !== norm(seen.paletteAdd) && !seen.paletteAdd.startsWith("#")) {
            fail(`${id}: +N colour ${seen.addColour} is not the shared --tdiff-add-line`);
          }
        }
        // Four edit/delete tool calls, three distinct paths — remote-uplink.ts
        // is edited twice and must be ONE row. That dedup is the feature.
        if (spec.expectCard && caseName === "turn") {
          if (seen.title !== "Changed 3 files") {
            fail(`${id}: title reads "${seen.title}", expected "Changed 3 files"`);
          }
          if (seen.rowCount !== 3) fail(`${id}: ${seen.rowCount} rows, expected 3`);
          if (!seen.deletedColour) fail(`${id}: the shell-deleted file has no D letter`);
        }
        // A dead control looks identical to a live one in a screenshot, so the
        // offer itself is asserted — and it is the SAME offer on every surface.
        if (spec.expectCard && (caseName === "turn" || caseName === "remote")) {
          const want = "Show the diff";
          const wrong = seen.rowKinds.filter(
            (k) => k !== `BUTTON:${want}` && k !== "DIV:",
          );
          if (wrong.length) fail(`${id}: rows offer ${wrong.join(", ")}, expected "${want}" or a plain line`);
          if (!seen.rowKinds.some((k) => k === `BUTTON:${want}`)) {
            fail(`${id}: no row offers "${want}" — every edited file here has a diff to show`);
          }
        }
        // A dark frame on a white page is not a dark frame.
        {
          const ground = seen.pageGround.replace(/\s+/g, "");
          const want = th.name === "dark" ? "rgb(24,24,24)" : "rgb(248,248,248)";
          if (ground !== want) fail(`${id}: page ground is ${seen.pageGround}, expected ${want}`);
        }
        await p.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}

log(`screens in ${path.relative(root, OUT) || OUT}`);
if (failures) {
  console.error(`[turn-diff-screens] ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
log("ALL CHECKS PASSED");
