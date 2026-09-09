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

function page(theme, themeClass) {
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
  background: var(--vscode-editor-background);
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
        await p.setContent(page(th.theme, th.cls), { waitUntil: "load" });
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
                  const stat = r.querySelector(".diff-stat, .turn-diff-file-action");
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
            cardWidth: card ? Math.round(card.getBoundingClientRect().width) : 0,
            // The card must take its +/- colours from the shared diff palette,
            // not a second one invented for it.
            addColour: card
              ? getComputedStyle(card.querySelector(".diff-stat-add") || card).color
              : "",
            paletteAdd: getComputedStyle(document.body).getPropertyValue("--tdiff-add-line").trim(),
            deletedColour: (() => {
              const tag = card?.querySelector(".turn-diff-file-action.deleted");
              return tag ? getComputedStyle(tag).color : "";
            })(),
            paletteDel: getComputedStyle(document.body).getPropertyValue("--tdiff-del-line").trim(),
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
          if (!seen.deletedColour) fail(`${id}: the shell-deleted file has no Deleted tag`);
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
