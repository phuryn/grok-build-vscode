// Check the shipped picker CSS with desktop palettes, VS Code contrast
// tokens and Chromium forced colours. Captures use a small picker fixture.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const out = process.env.SCREENS_DIR || ".screens";
fs.mkdirSync(out, { recursive: true });
const css = fs.readFileSync("media/chat.css", "utf8").replace(/^\uFEFF/, "");
const desktop = fs.readFileSync("src/desktop/electron-webview.ts", "utf8");
const palette = desktop.match(/:root \{[\s\S]*?\n\}/)[0];
const light = desktop.match(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/)[0];
const cases = [
  { name: "dark" },
  { name: "light", light: true },
  // Dark High Contrast tokens from VS Code’s bundled workbench.
  { name: "dark-high-contrast", body: "vscode-high-contrast", tokens: `
    --vscode-editorWidget-background: #0c141f; --vscode-foreground: #fff;
    --vscode-descriptionForeground: rgba(255,255,255,.7); --vscode-textLink-foreground: #21a6ff;
    --vscode-contrastBorder: #6fc3df; --vscode-list-inactiveSelectionBackground: #0c141f;` },
  { name: "light-high-contrast", light: true, body: "vscode-high-contrast-light", tokens: `
    --vscode-editorWidget-background: #fff; --vscode-contrastBorder: #0f4a85;
    --vscode-list-inactiveSelectionBackground: #fff;` },
  { name: "forced-colours", light: true, forced: true },
];
const levels = ["Low", "Medium", "High", "Extra high"];
const bars = (index) => `<span class="effort-bars" aria-hidden="true" style="--effort-bar-color:color-mix(in srgb,var(--e2),var(--e3) 89.583333%)">${
  [4, 7, 10, 13].map((height, i) => `<i class="${i <= index ? "filled" : ""}" style="height:${height}px"></i>`).join("")
}</span>`;
const segments = levels.map((label, i) => `<button type="button" class="effort-strip-stop" role="radio" aria-checked="${i === 2}">${bars(i)}<span>${label}</span></button>`).join("");

const browser = await chromium.launch({ executablePath: process.env.COMPOSER_CHROMIUM ||
  (process.platform === "win32" && fs.existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) });
try {
  for (const fixture of cases) {
    const p = await browser.newPage({ viewport: { width: 330, height: 290 }, deviceScaleFactor: 2,
      colorScheme: fixture.light ? "light" : "dark", forcedColors: fixture.forced ? "active" : "none" });
    await p.setContent(`<!doctype html><html data-theme="${fixture.light ? "light" : "dark"}"><head><style>
      ${palette}${light}${css}
      body { ${fixture.tokens || ""} padding: 14px; background: var(--vscode-editorWidget-background); }
      #gear-popover { position: relative; }
    </style></head><body class="${fixture.body || (fixture.light ? "vscode-light" : "")}">
      <div id="gear-popover" class="toolbar-popover gear-popover model-picker">
        <div class="model-effort-strip">
          <div class="effort-strip-header"><span>Effort</span><button class="effort-reset">Reset</button></div>
          <div class="effort-strip-segments" role="radiogroup" aria-label="Reasoning effort">${segments}</div>
          <div class="effort-strip-tip">High — deeper reasoning</div>
        </div>
        <div class="model-picker-list" role="radiogroup" aria-label="Model">
          <div class="model-picker-option active">
            <button class="toolbar-popover-item model-picker-row active" role="radio" aria-checked="true">
              <span class="model-picker-name">Gemini 4 Neon</span><span class="popover-check">✓</span>
            </button>
          </div>
          <div class="model-picker-option">
            <button class="toolbar-popover-item model-picker-row" role="radio" aria-checked="false">Gemini 4 Carbon</button>
          </div>
        </div>
      </div>
      <div><button id="gear-btn" class="toolbar-btn model-chip">
        <span class="model-chip-name">Gemini 4 Neon</span>${bars(2)}<span class="model-chip-effort">High</span>
      </button></div>
    </body></html>`);
    const mark = await p.evaluate(() => {
      const stop = document.querySelector(".effort-strip-stop[aria-checked=true]");
      const other = document.querySelector(".effort-strip-stop[aria-checked=false]");
      const row = document.querySelector(".model-picker-option.active");
      const check = row.querySelector(".popover-check");
      const bg = (el) => getComputedStyle(el).backgroundColor;
      const outlines = [stop, row].map((el) => getComputedStyle(el).outlineStyle);
      const bar = bg(stop.querySelector(".filled")), empty = bg(stop.querySelector("i:not(.filled)"));
      const filled = bg(other.querySelector(".filled")), chip = bg(document.querySelector("#gear-btn .filled"));
      const surface = bg(document.querySelector("#gear-popover"));
      // Canvas resolves both rgb() and color-mix() results and composites washes.
      const canvas = document.createElement("canvas").getContext("2d");
      const luminance = (...colors) => {
        canvas.clearRect(0, 0, 1, 1);
        for (const color of colors) { canvas.fillStyle = color; canvas.fillRect(0, 0, 1, 1); }
        const rgb = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => v / 255)
          .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      };
      const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const barRatio = ratio(luminance(surface, bg(stop), bar), luminance(surface, bg(stop)));
      const checkRatio = ratio(luminance(surface, bg(row), bg(check), getComputedStyle(check).color), luminance(surface, bg(row), bg(check)));
      return { outlines, bar, empty, filled, chip, barRatio, checkRatio };
    });
    const file = path.join(out, `hc-picker-${fixture.name}.png`);
    await p.screenshot({ path: file });
    assert.deepEqual(mark.outlines, ["solid", "solid"], `${fixture.name}: selection outlines`);
    assert.equal(new Set([mark.bar, mark.empty, mark.filled]).size, 3, `${fixture.name}: distinguish all three bar tones`);
    assert(mark.barRatio >= 3 && mark.checkRatio >= 3, `${fixture.name}: visible selected marks ${JSON.stringify(mark)}`);
    assert.equal(mark.chip, fixture.forced ? mark.filled : mark.bar, `${fixture.name}: chip bar colour`);
    console.log(`[hc-colour] ${fixture.name}: selected effort ${mark.barRatio.toFixed(2)}:1, model check ${mark.checkRatio.toFixed(2)}:1 → ${file}`);
    await p.close();
  }
} finally { await browser.close(); }
