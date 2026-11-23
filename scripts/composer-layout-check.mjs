// Real layout gate for the shipped composer, independent of a running provider.
// Run npm run e2e:composer. Screenshots and measurements land in .screens/.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
const source = read("src/sidebar.ts");
// Use the actual host markup, including classes, toolbar groups and padding.
const composer = source.match(/  <footer class="composer">[\s\S]*?  <\/footer>/)[0];
const body = read("test/webview-harness.ts").match(/export const BODY = `([\s\S]*?)`;/)[1]
  .replace(/  <footer class="composer">[\s\S]*?  <\/footer>/, composer);
const shell = read("src/desktop/electron-webview.ts");
const palette = shell.match(/:root \{[\s\S]*?\n\}/)[0];
const light = shell.match(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/)[0];
const desktopCss = shell.match(/export const DESKTOP_THEME_CSS = `([\s\S]*?)`;/)[1];
const desktopLayout = source.match(/const firstFrameLayout =[\s\S]*?\? `([\s\S]*?)`/)[1];
const out = path.join(root, ".screens", "composer");
mkdirSync(out, { recursive: true });
const chrome = process.env.COMPOSER_CHROMIUM || (process.platform === "win32"
  && existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
  ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const ladders = [
  ["agy", "Gemini 4 Neon", ["Low", "Medium", "High", "Extra high"]],
  ["grok", "Grok 4.7", ["None", "Minimal", "Low", "Medium", "High", "X-high"]],
  ["codex", "GPT-6 Astra", ["Low", "Medium", "High", "X-high", "Ultra"]],
  ["claude", "Sonnet 5", ["Low", "Medium", "High", "Max"]],
  ["deepseek", "DeepSeek V4 Flash", ["Off", "Low", "High", "Max"]],
  ["muse", "Muse", ["None", "Minimal", "Low", "Medium", "High", "X-high", "Max", "Ultra"]],
];
const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
const measurements = [];
let ladderCases = 0;
try {
  for (const surface of ["vscode", "desktop", "phone", "remote"]) {
    const touch = surface === "phone";
    const remote = touch || surface === "remote";
    const context = await browser.newContext({ viewport: { width: 1400, height: 850 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const theme of ["dark", "light"]) {
      const desktop = surface === "desktop";
      const content = desktop ? body.replace('  <main id="messages"', '<div class="desk-ft-shell"><div class="desk-ft-chat"><main id="messages"') + '</div></div>' : body;
      await page.setContent(`<!doctype html><html data-theme="${theme}"><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>${palette}${light}${read("media/chat.css")}${desktop ? read("media/file-panel.css") + desktopCss + desktopLayout : ""}</style></head>
        <body class="${!remote ? "desk" : ""} ${desktop ? "desk-with-ft" : ""} ${surface !== "vscode" ? "has-rail" : ""} ${theme === "light" ? "vscode-light" : ""}">
        ${surface !== "vscode" ? '<aside id="projects-rail"><div id="rail-scroll"></div><div class="rail-foot"></div></aside>' : ""}
        ${desktop ? '<div class="app-main">' : ''}${content}${desktop ? '</div>' : ''}</body></html>`);
      await page.evaluate(({ remote }) => {
        window.grokRemoteClient = remote;
        window.__posted = [];
        window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
      }, { remote });
      for (const script of ["webview-helpers", "settings", "file-panel", "chat"]) {
        await page.addScriptTag({ content: read(`media/${script}.js`) });
      }
      await page.evaluate(({ surface }) => {
        const dispatch = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
        dispatch({ type: "initialState", effort: "high", appPurpose: "coding", capabilities: {} });
        dispatch({ type: "providerState", providers: [{ id: "claude", connected: true }] });
        if (surface !== "vscode") dispatch({ type: "repos", entries: [], selectedCwd: "/repo", activeCwd: "/repo" });
        dispatch({ type: "session", provider: "claude", currentModelId: "sonnet", models: Array.from({ length: 25 }, (_, i) => ({
          modelId: i ? `model-${i}` : "sonnet", name: i ? `Model ${i}` : "Sonnet 5", provider: "claude",
          reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high", "max"],
        })) });
        dispatch({ type: "setBusy", value: false });
      }, { surface });
      // Includes every rung, the reported 334px regression and phone widths.
      const setWidth = (width) => page.evaluate((width) => {
        document.querySelector(".composer").style.width = width + "px";
        // Desktop reading-measure padding depends on the chat pane's width.
        // Constrain that real pane along with its composer, as a split does.
        const pane = document.querySelector(".desk-ft-chat");
        if (pane) { pane.style.flex = "none"; pane.style.width = width + "px"; }
      }, width);
      for (const width of [240, 264, 282, 310, 334, 360, 390, 450, 640]) {
        await setWidth(width);
        const m = await page.evaluate(() => {
          const box = (selector) => {
            const el = document.querySelector(selector), r = el.getBoundingClientRect(), c = getComputedStyle(el);
            return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width, height: r.height,
              display: c.display, client: el.clientWidth, scroll: el.scrollWidth, text: el.textContent };
          };
          const card = document.querySelector(".composer-card"), cardStyle = getComputedStyle(card);
          return { composer: box(".composer"), query: card.clientWidth - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight),
            toolbar: box(".composer-toolbar"), left: box(".toolbar-left"), mode: box("#mode-btn .btn-label"),
            name: box(".model-chip-name"), effort: box(".model-chip-effort"), chip: box("#gear-btn"), glyph: box("#gear-btn .effort-bars"),
            donutLabel: box("#donut-label"),
            buttons: ["#add-btn", "#mic-btn", "#gear-btn", "#donut", "#mode-btn", "#send-btn"].map(box),
            padding: ["#input", ".input-highlight"].map((s) => {
              const c = getComputedStyle(document.querySelector(s)); return [c.paddingLeft, c.paddingRight];
            }), micInToolbar: document.querySelector("#mic-btn").parentElement.classList.contains("toolbar-left"),
          };
        });
        const tag = `${surface}/${theme}/${width} (query ${m.query})`;
        assert.equal(m.composer.width, width, tag);
        assert(m.micInToolbar, tag);
        for (const padding of m.padding) assert.deepEqual(padding, ["8px", "8px"], `${tag}: no mic lane`);
        // A hidden control is not a tap target that is too small — it is not a
        // tap target. Everything still on screen must fit AND meet the floor.
        const shown = m.buttons.filter((c) => c.display !== "none");
        for (const c of shown) {
          assert(c.width > 0 && c.x >= m.toolbar.x && c.right <= m.toolbar.right + .5, `${tag}: toolbar overflow ${JSON.stringify(c)}`);
          if (touch) assert(c.width >= 36 && c.height >= 36, `${tag}: under the tap floor ${JSON.stringify(c)}`);
        }
        for (const c of m.buttons.slice(0, 4)) {
          if (c.display !== "none") assert(c.right <= m.left.right + .5, `${tag}: left-group clipping ${JSON.stringify(c)}`);
        }
        // The effort word goes first on desktop, then mode, then the donut numbers.
        assert.equal(m.donutLabel.display === "none", touch || m.query <= 224, `${tag}: donut rung`);
        assert.equal(m.mode.display === "none", m.query <= 430, `${tag}: mode rung`);
        assert.equal(m.effort.display === "none", touch || m.query <= 470, `${tag}: effort word rung`);
        // The chip's effort bars outlive the word, down to the last rung, where
        // the name stub outranks them (#172).
        assert.equal(m.glyph.display === "none", m.query <= 250, `${tag}: effort glyph rung`);
        if (m.query > 250) {
          assert(m.glyph.width > 0 && m.glyph.right <= m.chip.right + .5, `${tag}: effort glyph stays visible ${JSON.stringify({ glyph: m.glyph, chip: m.chip, name: m.name })}`);
        }
        assert.notEqual(m.name.display, "none", `${tag}: name rung`);
        assert(m.name.width > 0, `${tag}: name must not silently shrink away`);
        assert(m.name.x >= m.chip.x && m.name.right <= m.chip.right + .5, `${tag}: name clipped by the chip`);
        if (surface === "vscode" && width === 334) {
          assert(m.name.width > 0 && m.name.client >= m.name.scroll, `${tag}: model rendered and unclipped`);
        }
        if (m.effort.display !== "none") {
          assert(m.effort.client >= m.effort.scroll && m.effort.right <= m.chip.right + .5, `${tag}: effort word rendered and unclipped`);
        }
        if (touch) assert.equal(m.buttons[1].width, 36, `${tag}: mic sized once`);
        measurements.push({ surface, theme, width, ...m });
      }
      // A long identity actually reaches the truncation rung, rather than
      // merely carrying an ellipsis declaration that never gets exercised.
      await setWidth(282);
      await page.evaluate(() => {
        document.querySelector(".model-chip-name").textContent = "A model with a deliberately long name";
      });
      const truncated = await page.locator(".model-chip-name").evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth, text: el.textContent }));
      assert(truncated.client > 0 && truncated.scroll > truncated.client, `${surface}/${theme}: long name truncates ${JSON.stringify(truncated)}`);
      await setWidth(334);
      await page.locator("#gear-btn").click();
      const pinned = async () => page.evaluate(() => {
        const rect = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.top, r.bottom]; };
        return { strip: rect(".model-effort-strip"), footer: rect(".model-picker-footer"), pop: rect("#gear-popover") };
      });
      const before = await pinned();
      assert(before.pop[0] >= 0 && before.pop[1] <= 850, `${surface}: picker stays in viewport ${JSON.stringify(before)}`);
      await page.locator(".model-picker-list").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      assert.deepEqual(await pinned(), before, `${surface}: pinned effort/footer`);
      assert(before.footer[1] <= before.pop[1] && before.strip[0] >= before.pop[0], `${surface}: footer reachable`);
      const listScrolled = await page.evaluate(() => {
        const list = document.querySelector(".model-picker-list");
        return list.scrollHeight > list.clientHeight && list.scrollTop > 0;
      });
      assert(listScrolled, `${surface}: list really scrolls`);
      await page.evaluate(() => { document.querySelector(".model-chip-name").textContent = "Sonnet 5"; });
      const clip = await page.evaluate(() => {
        const c = document.querySelector(".composer").getBoundingClientRect(), p = document.querySelector("#gear-popover").getBoundingClientRect();
        return { x: Math.max(0, c.x), y: Math.max(0, p.y - 8), width: c.width, height: c.bottom - Math.max(0, p.y - 8) };
      });
      await page.screenshot({ path: path.join(out, `${surface}-${theme}.png`), clip });
      for (const purpose of ["knowledge", "coding"]) {
        await page.evaluate((purpose) => {
          window.dispatchEvent(new MessageEvent("message", { data: { type: "initialState", appPurpose: purpose } }));
          window.dispatchEvent(new MessageEvent("message", { data: { type: "contextUsage", used: 90500, window: 100000 } }));
        }, purpose);
        await page.locator("#donut").click();
        const contextBar = await page.evaluate(() => {
          const pop = document.querySelector("#context-popover"), fill = pop.querySelector(".context-fullness > i");
          const compact = pop.querySelector(".context-compact"), c = getComputedStyle(compact);
          return { visible: !pop.hidden && fill.getBoundingClientRect().height > 0,
            fill: getComputedStyle(fill).backgroundColor, arc: getComputedStyle(document.querySelector("#donut-arc")).stroke,
            button: c.backgroundColor, expectedButton: getComputedStyle(document.querySelector("#send-btn")).getPropertyValue("--vscode-button-secondaryBackground").trim(),
            align: c.textAlign, width: compact.getBoundingClientRect().width };
        });
        assert(contextBar.visible && contextBar.width > 0, `${surface}/${purpose}: visible context action`);
        assert.equal(contextBar.fill, contextBar.arc, `${surface}/${purpose}: rendered colour matches donut`);
        assert.equal(contextBar.align, "center");
        assert.notEqual(contextBar.button, "rgba(0, 0, 0, 0)");
        await page.locator("#donut").click();
      }
      if (touch) await page.setViewportSize({ width: 400, height: 850 });
      await setWidth(touch ? 400 : 640);
      for (const [provider, name, words] of ladders) {
        const levels = words.map((word) => word === "X-high" || word === "Extra high" ? "xhigh" : word.toLowerCase());
        await page.evaluate(({ provider, name, levels }) => {
          const dispatch = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
          dispatch({ type: "providerState", providers: [{ id: provider, connected: true }] });
          dispatch({ type: "session", provider, currentModelId: "picker-fixture", models: [{
            modelId: "picker-fixture", name, provider, reasoningEffort: "high", reasoningEfforts: levels,
          }] });
          dispatch({ type: "setBusy", value: false });
        }, { provider, name, levels });
        const tag = `${surface}/${theme}/${provider}`;
        const nameClipping = await page.evaluate(() => {
          const name = document.querySelector(".model-chip-name"), glyph = document.querySelector("#gear-btn .effort-bars");
          const withGlyph = name.scrollWidth > name.clientWidth;
          glyph.style.display = "none";
          const withoutGlyph = name.scrollWidth > name.clientWidth;
          glyph.style.removeProperty("display");
          return { withGlyph, withoutGlyph };
        });
        if (!touch) assert.equal(nameClipping.withGlyph, nameClipping.withoutGlyph, `${tag}: glyph brings forward name truncation`);
        await page.locator("#gear-btn").click();
        const stops = await page.locator(".effort-strip-stop").evaluateAll((buttons) => buttons.map((button) => {
          const box = button.getBoundingClientRect(), group = button.parentElement.getBoundingClientRect();
          const label = button.lastElementChild, text = label.getBoundingClientRect();
          return { word: label.innerText, top: box.top, height: box.height,
            fits: text.left >= box.left && text.right <= box.right && box.right <= group.right,
            glyphFits: button.scrollWidth <= button.clientWidth };
        }));
        assert.deepEqual(stops.map(({ word }) => word), words, tag);
        assert(stops.every((s) => s.top === stops[0].top && s.height >= 44 && s.fits && s.glyphFits),
          `${tag}: segment layout ${JSON.stringify(stops)}`);
        ladderCases++;
        await page.locator("#gear-btn").click();
      }
      if (touch) await page.setViewportSize({ width: 1400, height: 850 });
      assert.deepEqual(errors, [], `${surface}: renderer errors`);
    }
    await context.close();
  }
  writeFileSync(path.join(out, "measurements.json"), JSON.stringify(measurements, null, 2));
  console.log(`Composer layout: ${measurements.length} surface/theme/width cases and ${ladderCases} effort ladder cases passed, including 334px unclipped text, 400px phone segment labels, touch sizing, collapse order and pinned picker.`);
} finally { await browser.close(); }
