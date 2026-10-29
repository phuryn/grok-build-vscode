// Real layout + wheel/touch/keyboard coverage for the pending approval box (#208).
// Run: node scripts/permission-command-screens.mjs (PNGs in .screens/issue-208/).
import { chromium } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const out = path.join(root, ".screens", "issue-208");
fs.mkdirSync(out, { recursive: true });
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const body = read("test/webview-harness.ts").match(/export const BODY = `([\s\S]*?)`;/)[1];
const palette = read("src/desktop/electron-webview.ts").match(/:root \{[\s\S]*?\n\}/)[0];
const longCommand = ["set -eu", ...Array.from({ length: 38 }, (_, i) =>
  `printf 'Review step ${String(i + 1).padStart(2, "0")} of 38\\n'`), "npm test"].join("\n");
const shortCommand = "git status --short\ngit diff --check\nnpm test";
const request = (command) => ({ type: "permissionRequest", req: {
  id: 208, toolCall: { toolCallId: "approval", kind: "execute", title: command },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Allow for this session", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} });
const browser = await chromium.launch({ executablePath: process.env.COMPOSER_CHROMIUM ||
  (process.platform === "win32" && fs.existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined) });
const results = [];
try {
  for (const [surface, viewport] of [
    ["desktop", { width: 900, height: 720 }],
    ["phone", { width: 390, height: 844 }],
    ["editor", { width: 480, height: 640 }],
    ["phone-short", { width: 390, height: 500 }],
  ]) {
    const remote = surface.startsWith("phone");
    const context = await browser.newContext({ viewport, hasTouch: remote, isMobile: remote });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${palette}</style><style>${read("media/chat.css").replace(/^\uFEFF/, "")}</style>
      </head><body>${body}</body></html>`);
    await page.evaluate(({ remote, desktop }) => {
      window.grokRemoteClient = remote;
      window.grokDesktopShell = desktop;
      window.__posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m),
        getState: () => undefined, setState: () => {} });
    }, { remote, desktop: surface === "desktop" });
    for (const script of ["webview-helpers", "repo-icons", "repo-icon-picker", "settings", "syntax-highlight", "file-panel", "chat"]) {
      await page.addScriptTag({ content: read(`media/${script}.js`) });
    }
    const send = (message) => page.evaluate((data) =>
      window.dispatchEvent(new MessageEvent("message", { data })), message);
    await send({ type: "initialState", appPurpose: "coding", showThinking: false,
      commandLanguage: "shellscript", capabilities: surface === "desktop" ? { previewInApp: true } : {} });
    await send({ type: "setBusy", value: false });
    const seed = async (command) => {
      await send({ type: "clearMessages" });
      for (let i = 0; i < 10; i++) {
        await send({ type: "userMessage", text: `Review checkpoint ${i + 1}.` });
        await send({ type: "messageChunk", text: "The next command is ready for your approval." });
      }
      await send(request(command));
      await page.waitForTimeout(150);
    };
    const geometry = () => page.evaluate(() => {
      const pre = document.querySelector(".command-card-title");
      const card = document.querySelector(".card.permission").getBoundingClientRect();
      const messages = document.querySelector("#messages").getBoundingClientRect();
      const actions = document.querySelector(".card-actions").getBoundingClientRect();
      const style = getComputedStyle(pre);
      return { height: pre.clientHeight, fullHeight: pre.scrollHeight, scrollTop: pre.scrollTop,
        overflowY: style.overflowY, overscroll: style.overscrollBehaviorY, touchAction: style.touchAction,
        cardTop: card.top, messagesTop: messages.top, actionsBottom: actions.bottom,
        messagesBottom: messages.bottom, sideways: pre.scrollWidth > pre.clientWidth + 1 ||
          document.documentElement.scrollWidth > innerWidth,
        focus: document.activeElement?.textContent,
        text: pre.textContent };
    });
    const screenshot = (name) => page.screenshot({ path: path.join(out, `${surface}-${name}.png`) });
    for (const [name, command] of [["40-lines", longCommand], ["3-lines", shortCommand]]) {
      await seed(command);
      const g = await geometry();
      await screenshot(name);
      assert.equal(g.text, command);
      assert.ok(g.cardTop >= g.messagesTop, `${surface}: entire card must fit: ${JSON.stringify(g)}`);
      assert.ok(g.actionsBottom <= g.messagesBottom, `${surface}: all actions must fit`);
      assert.equal(g.sideways, false);
      assert.equal(g.focus, "Allow once");
      results.push({ surface, name, ...g, text: undefined });
      if (name === "3-lines") {
        assert.equal(await page.locator(".permission-command-scroll").count(), 0);
        assert.equal(g.height, g.fullHeight);
        continue;
      }
      assert.equal(g.overflowY, "auto");
      assert.equal(g.overscroll, "auto");
      assert.equal(g.touchAction, "auto");
      assert.ok(g.fullHeight > g.height);
      const pre = page.locator(".permission-command-scroll");
      // Default action -> command remotely, via View all on editor/desktop.
      // No programmatic focus shortcut.
      await page.keyboard.press("Shift+Tab");
      if (remote) {
        assert.equal(await page.locator(".command-view-all").count(), 0);
        assert.equal(await page.locator("#preview-overlay").count(), 0);
      } else {
        assert.ok(await page.locator(".command-view-all").evaluate((el) => el === document.activeElement));
        await page.keyboard.press("Shift+Tab");
      }
      assert.ok(await pre.evaluate((el) => el === document.activeElement));
      await page.keyboard.press("End");
      await page.waitForTimeout(200);
      assert.ok(await pre.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1),
        "End must make the final command line reachable");
      await screenshot("40-lines-end");
      await page.keyboard.press("Home");
      await page.waitForTimeout(200);
      const rect = await pre.boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.wheel(0, 80);
      await page.waitForTimeout(200);
      assert.ok(await pre.evaluate((el) => el.scrollTop > 0), "wheel scrolls the command");
      await pre.evaluate((el) => { el.scrollTop = 0; });
      const before = await page.locator("#messages").evaluate((el) => el.scrollTop);
      await page.mouse.wheel(0, -90);
      await page.waitForTimeout(200);
      assert.ok(await page.locator("#messages").evaluate((el) => el.scrollTop) < before,
        "wheel at the command's top continues into the conversation");
      await page.locator("#messages").evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 120; });
      await pre.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(100);
      const bottomRect = await pre.boundingBox();
      await page.mouse.move(bottomRect.x + bottomRect.width / 2, bottomRect.y + bottomRect.height / 2);
      const beforeBottom = await page.locator("#messages").evaluate((el) => el.scrollTop);
      await page.mouse.wheel(0, 90);
      await page.waitForTimeout(250);
      await page.mouse.wheel(0, 90);
      await page.waitForTimeout(250);
      const afterBottom = await page.locator("#messages").evaluate((el) => el.scrollTop);
      assert.ok(afterBottom > beforeBottom,
        `wheel at the command's bottom continues into the conversation: ${JSON.stringify({ surface, beforeBottom, afterBottom, bottomRect, geometry: await geometry() })}`);
      await page.locator("#messages").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await pre.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(100);
      if (remote) {
        const cdp = await context.newCDPSession(page);
        const drag = async (down) => {
          const r = await pre.boundingBox();
          const x = r.x + r.width / 2;
          const y = down ? r.y + 15 : r.y + r.height - 15;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          for (let step = 1; step <= 6; step++) {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
              touchPoints: [{ x, y: y + (down ? 1 : -1) * step * 12 }] });
            await page.waitForTimeout(20);
          }
          // End a drag at rest, so a fling from this gesture cannot race the
          // next boundary setup on the compositor thread.
          await page.waitForTimeout(250);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.waitForTimeout(350);
        };
        await drag(false);
        assert.ok(await pre.evaluate((el) => el.scrollTop > 0), "touch drag scrolls the command");
        await pre.evaluate((el) => { el.scrollTop = 0; });
        await page.waitForTimeout(200);
        const beforeTouch = await page.locator("#messages").evaluate((el) => el.scrollTop);
        await drag(true);
        const afterTouch = await page.locator("#messages").evaluate((el) => el.scrollTop);
        assert.ok(afterTouch < beforeTouch,
          `touch drag starting at the command's edge must scroll the conversation: ${JSON.stringify({ surface, beforeTouch, afterTouch, geometry: await geometry() })}`);
        await page.locator("#messages").evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 120; });
        await pre.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(200);
        const beforeBottomTouch = await page.locator("#messages").evaluate((el) => el.scrollTop);
        await drag(false);
        assert.ok(await page.locator("#messages").evaluate((el) => el.scrollTop) > beforeBottomTouch,
          "touch at the command's bottom continues into the conversation");
        await cdp.detach();
      }
      await page.locator("#messages").evaluate((el) => { el.scrollTop = el.scrollHeight; });
      if (remote) {
        assert.equal(await page.locator(".command-view-all").count(), 0);
        assert.equal(await page.locator("#preview-overlay").count(), 0);
        assert.equal(await page.evaluate(() => window.__posted.some((m) => m.type === "openText")), false);
      } else {
        await page.locator(".command-view-all").click();
        if (surface === "editor") {
          assert.ok(await page.evaluate(() => window.__posted.some((m) => m.type === "openText")));
        } else {
          assert.ok((await page.locator("#preview-overlay .preview-body").textContent()).includes("npm test"));
          await page.locator(".preview-close-btn").click();
        }
      }
      assert.ok((await geometry()).actionsBottom <= (await geometry()).messagesBottom);
      await page.locator(".card-actions button").first().focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".perm-resolved").count(), 1);
      assert.equal(await pre.count(), 0);
      assert.ok(await page.evaluate(() => window.__posted.some((m) =>
        m.type === "permissionAnswer" && m.optionId === "allow")));
    }
    assert.deepEqual(errors, [], "no browser script errors");
    await context.close();
  }
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log("PASS: layout, full command reachability, keyboard approval, wheel chaining, phone touch chaining, editor/desktop View all, no remote View all or overlay, resolution.");
} finally {
  await browser.close();
}
