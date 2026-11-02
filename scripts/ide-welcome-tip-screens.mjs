// Screens check for empty-state advice on the IDE surface — real Chromium
// layout at SIDE BAR widths, screenshots left behind for a person to look at.
//
// WHY A FOURTH HARNESS. `e2e:screens` drives the desktop app at 1440px and the
// relay repo's drives the browser client at 1440/820/414. Neither is the shape
// this feature is most likely to break in: a VS Code primary side bar is
// commonly 300–360px, the panel dock is shorter than it is wide, and the tip's
// measure was chosen on a 1440px screen. A line that reads as two lines on the
// desk becomes six in a side bar, and no DOM test can see that — happy-dom has
// no layout engine, so rects are zeros and stylesheets never apply.
//
// It boots the SHIPPED media/ scripts against the same body skeleton the DOM
// tests mirror getHtml() with, so nothing here can drift from what ships.
//
// Run: npm run e2e:welcome-tip   (frames land in .screens/, gitignored)
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const OUT = process.env.SCREENS_DIR || ".screens";
const media = path.join(root, "media");
const log = (m) => console.log(`[welcome-tip] ${m}`);

// Both borrowed rather than copied, so neither can drift from what ships: the
// body skeleton the DOM tests already mirror getHtml() with, and the desktop
// shell's VS Code palette.
const harness = fs.readFileSync(path.join(root, "test", "webview-harness.ts"), "utf8");
const BODY = harness.match(/export const BODY = `([\s\S]*?)`;/)[1];
const shell = fs.readFileSync(path.join(root, "src", "desktop", "electron-webview.ts"), "utf8");
const PALETTE = shell.match(/:root \{[\s\S]*?\n\}/)[0];

fs.mkdirSync(OUT, { recursive: true });
// Inside the repo, not os.tmpdir(): the scaffold's main.js does
// require("electron"), which only resolves from a path under this node_modules.
const tmp = fs.mkdtempSync(path.join(root, OUT, "tip-"));
const pageFile = path.join(tmp, "chat.html");
fs.writeFileSync(pageFile, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(media, "chat.css")}">
<style>${PALETTE}
html, body { margin: 0; height: 100%; }
body { display: flex; flex-direction: column;
       background: var(--vscode-editor-background); color: var(--vscode-foreground);
       font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
#messages { flex: 1; overflow: auto; }</style>
</head><body>
<script>
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__posted.push(m),
    setState: () => {},
    getState: () => undefined,
  });
</script>
${BODY}
<script src="${path.join(media, "webview-helpers.js")}"></script>
<script src="${path.join(media, "settings.js")}"></script>
<script src="${path.join(media, "syntax-highlight.js")}"></script>
<script src="${path.join(media, "file-panel.js")}"></script>
<script src="${path.join(media, "chat.js")}"></script>
</body></html>`);

const mainJs = path.join(tmp, "main.js");
fs.writeFileSync(mainJs, `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 360, height: 760, show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false } });
  w.loadFile(${JSON.stringify(pageFile)});
});
app.on("window-all-closed", () => app.quit());
`);

/** The frames sidebar.ts posts, in the order it posts them. */
const initialState = (capabilities) => ({
  type: "initialState",
  effort: "", cwd: "/work/project", useCtrlEnter: false, extVersion: "3.17.2",
  showThinking: false, expandCommandOutputs: false, steerByDefault: false,
  soundNotifications: false, processingSound: false, inputNeededSound: false, readRepliesAloud: false,
  appPurpose: "knowledge", hostKind: "extension", hostName: "Pawel-Desk",
  capabilities: { uploadFile: true, remoteVoice: true, ...capabilities },
});

const electronExe = createRequire(path.join(root, "x.js"))("electron");
// ELECTRON_RUN_AS_NODE=1 is set inside a VS Code extension host, and a session
// driving this from there inherits it — Electron then runs as plain Node, never
// opens a window, and Playwright reports only "Process failed to launch!".
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: electronExe,
  args: [mainJs, `--user-data-dir=${path.join(tmp, "udata")}`],
  env,
  timeout: 60000,
});

try {
  const page = await app.firstWindow({ timeout: 60000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));
  await page.waitForSelector("#input", { timeout: 30000 });

  const send = (msg) =>
    page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), msg);

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    log(`captured ${name}.png`);
  };

  /** Everything a real layout can say about the advice row and a DOM run cannot. */
  const measure = () => page.evaluate(() => {
    const el = document.getElementById("welcome-tip");
    if (!el) return null;
    const body = el.querySelector(".welcome-tip-body");
    const close = el.querySelector(".welcome-tip-dismiss");
    const act = el.querySelector(".muted-link, b");
    const welcome = document.getElementById("welcome");
    const composer = document.querySelector("footer.composer");
    const r = el.getBoundingClientRect();
    const wr = welcome.getBoundingClientRect();
    const cr = composer ? composer.getBoundingClientRect() : null;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 17.6;
    return {
      id: el.dataset.tip || "",
      text: (body?.textContent || "").replace(/\s+/g, " ").trim(),
      width: Math.round(r.width),
      height: Math.round(r.height),
      lines: Math.round((r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lineHeight),
      overflowsSelf: el.scrollWidth > el.clientWidth + 1,
      insideWelcome: r.left >= wr.left - 1 && r.right <= wr.right + 1,
      aboveComposer: !cr || r.bottom <= cr.top + 1,
      close: close ? close.getBoundingClientRect() : null,
      act: act ? { w: act.getBoundingClientRect().width, h: act.getBoundingClientRect().height, tag: act.tagName } : null,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      // WHICH element is wider than the viewport — a bare scrollWidth says the
      // page overflows, not who did it, and at 260px the composer toolbar
      // overflows on its own with no tip on screen at all.
      widest: [...document.querySelectorAll("body *")]
        .map((n) => ({ w: Math.round(n.getBoundingClientRect().right), sel: n.id || n.className || n.tagName }))
        .filter((n) => n.w > document.documentElement.clientWidth + 1)
        .sort((a, b) => b.w - a.w)
        .slice(0, 4),
      tipCausesOverflow: r.right > document.documentElement.clientWidth + 1,
    };
  });

  const assertTip = (tip, where, { maxLines }) => {
    assert.ok(tip, `${where}: empty-state advice must render on a settled welcome screen`);
    assert.ok(tip.id, `${where}: the tip must carry its id`);
    assert.ok(tip.text.length > 10, `${where}: tip text looks empty — ${JSON.stringify(tip)}`);
    assert.ok(!tip.overflowsSelf, `${where}: tip text overflows its box — ${JSON.stringify(tip)}`);
    assert.ok(tip.insideWelcome, `${where}: tip escapes the welcome column — ${JSON.stringify(tip)}`);
    assert.ok(tip.aboveComposer, `${where}: tip paints under the composer — ${JSON.stringify(tip)}`);
    assert.ok(
      tip.docScrollW <= tip.docClientW + 1 || !tip.tipCausesOverflow,
      `${where}: the tip made the page scroll sideways — ${JSON.stringify(tip)}`,
    );
    assert.ok(
      tip.close && tip.close.width >= 6 && tip.close.height >= 6,
      `${where}: dismiss control rendered with no size — ${JSON.stringify(tip)}`,
    );
    assert.ok(
      tip.act && tip.act.w >= 20 && tip.act.h >= 6,
      `${where}: the actionable span rendered with no size — ${JSON.stringify(tip)}`,
    );
    // The measure exists to keep one sentence to a few lines. A tall column in
    // a narrow side bar is the failure this harness was written for.
    assert.ok(
      tip.lines <= maxLines,
      `${where}: advice wrapped to ${tip.lines} lines (max ${maxLines}) — ${JSON.stringify(tip)}`,
    );
  };

  // ---- 1. VS Code primary side bar, the narrowest place this ever renders ---
  await send(initialState({ settingsEditor: true, relocateView: true }));
  await send({ type: "providerState", providers: [{ id: "grok", connected: true }] });
  await send({ type: "remoteStatus", linked: false });
  await send({ type: "welcomeTips", routineCount: 0, connectorCount: 0, dismissed: [] });
  await send({ type: "initialized", info: { provider: "grok", version: "1.0.5" } });
  await send({ type: "setBusy", value: false });
  await page.waitForTimeout(300);

  let tip = await measure();
  assertTip(tip, "ide side bar (360px)", { maxLines: 5 });
  log(`side bar: ${tip.id} — "${tip.text}" (${tip.width}x${tip.height}, ${tip.lines} lines)`);
  await shot("ide-1-welcome-tip-sidebar");

  // The link opens the settings TAB here rather than an overlay — VS Code is
  // the one surface that hosts the page itself. Both routes take a category.
  await page.click("#welcome-tip .muted-link");
  await page.waitForTimeout(200);
  const posted = await page.evaluate(() => window.__posted);
  const open = posted.find((m) => m.type === "openSettingsSurface");
  assert.ok(open, `ide: taking a tip must ask the host for the settings tab — ${JSON.stringify(posted)}`);
  assert.equal(open.category, "providers", `ide: wrong settings category — ${JSON.stringify(open)}`);
  assert.ok(
    posted.some((m) => m.type === "dismissWelcomeTip" && m.id === "providers"),
    `ide: acting on advice must retire it — ${JSON.stringify(posted)}`,
  );
  const next = await measure();
  assert.notEqual(next?.id, "providers", "ide: the taken tip must leave the slot");
  log(`side bar: took "providers" → settings tab on "${open.category}", slot moved to "${next?.id}"`);
  await shot("ide-2-welcome-tip-after-take");

  // ---- 2. The move-view hint still owns the slot where it applies ----------
  await send({ type: "moveViewHint", value: true });
  await page.waitForTimeout(150);
  const hint = await page.evaluate(() => {
    const el = document.getElementById("welcome-tip");
    return el ? { id: el.dataset.tip, text: (el.textContent || "").replace(/\s+/g, " ").trim() } : null;
  });
  assert.equal(hint?.id, "moveView", `ide: the move-view hint outranks advice — ${JSON.stringify(hint)}`);
  await shot("ide-3-move-view-hint");
  log("side bar: move-view hint keeps the slot while the host offers it");
  await send({ type: "moveViewHint", value: false });

  // ---- 3. Panel dock: wide and SHORT, where vertical room runs out ---------
  await page.setViewportSize({ width: 900, height: 320 });
  await page.waitForTimeout(250);
  tip = await measure();
  assertTip(tip, "ide panel dock (900x320)", { maxLines: 5 });
  log(`panel dock: ${tip.id} — (${tip.width}x${tip.height}, ${tip.lines} lines)`);
  await shot("ide-4-welcome-tip-panel");

  // ---- 4. The narrowest side bar anyone drags to ---------------------------
  await page.setViewportSize({ width: 260, height: 760 });
  await page.waitForTimeout(250);
  tip = await measure();
  assertTip(tip, "ide side bar (260px)", { maxLines: 7 });
  log(`narrow side bar: ${tip.id} — (${tip.width}x${tip.height}, ${tip.lines} lines)`);
  // Recorded, not asserted: at 260px the composer toolbar overflows on its own
  // (it does so with no tip on screen at all), so this harness reports who is
  // wide rather than blaming the feature it was written for.
  if (tip.widest.length) log(`narrow side bar: pre-existing overflow — ${JSON.stringify(tip.widest)}`);
  await shot("ide-5-welcome-tip-narrow");

  // ---- Add project, at side bar width --------------------------------------
  // The form is 380px wide by design and a VS Code side bar is often narrower.
  // This is where "min(380px, 100%)" either holds or pushes the page sideways.
  await page.setViewportSize({ width: 340, height: 760 });
  // Re-state capabilities with all three ways in. The welcome-tip section above
  // deliberately advertises none of them, and a host that offers only the
  // picker is supposed to skip the menu entirely.
  await send(initialState({ settingsEditor: true, relocateView: true, addProjectFolder: true, createProject: true, cloneProject: true }));
  await send({ type: "projectSetup", root: "~/Grok Build" });
  await send({ type: "appPurpose", value: "coding" });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const card = document.getElementById("welcome-onboarding");
    card.innerHTML = '<button class="onb-action" type="button" data-act="addProjectFolder">Add project folder</button>';
    card.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector(".rail-menu", { timeout: 5000 });
  const ideMenu = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".rail-menu-item")];
    const box = document.querySelector(".rail-menu").getBoundingClientRect();
    return {
      labels: rows.map((r) => r.querySelector(".rail-menu-label")?.textContent?.trim() || ""),
      clipped: rows.some((r) => r.scrollWidth > r.clientWidth + 1),
      onScreen: box.left >= -1 && box.right <= window.innerWidth + 1,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    };
  });
  assert.deepEqual(
    ideMenu.labels,
    ["Clone from GitHub", "New project", "Import a folder"],
    `ide: coding mode adds cloning at the top — ${JSON.stringify(ideMenu)}`,
  );
  assert.ok(!ideMenu.clipped, `ide: menu rows clipped at 340px — ${JSON.stringify(ideMenu)}`);
  assert.ok(ideMenu.onScreen, `ide: menu runs outside the side bar — ${JSON.stringify(ideMenu)}`);
  await shot("ide-6-add-project-menu");
  log(`ide add project menu (340px): ${ideMenu.labels.join(" / ")}`);

  await page.click(".rail-menu-item");
  await page.waitForSelector(".add-project-form", { timeout: 5000 });
  await page.fill(".add-project-input", "https://github.com/phuryn/grok-remote.git");
  const ideForm = await page.evaluate(() => {
    const el = document.querySelector(".add-project-form");
    const b = el.getBoundingClientRect();
    return {
      dest: document.querySelector(".add-project-dest").textContent.trim(),
      width: Math.round(b.width),
      inside: b.left >= -1 && b.right <= window.innerWidth + 1,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
      overflowsSelf: el.scrollWidth > el.clientWidth + 1,
    };
  });
  assert.equal(ideForm.dest, "~/Grok Build/grok-remote", `ide: clone preview — ${JSON.stringify(ideForm)}`);
  assert.ok(ideForm.inside, `ide: the form escapes a 340px side bar — ${JSON.stringify(ideForm)}`);
  assert.ok(!ideForm.overflowsSelf, `ide: the form scrolls sideways inside itself — ${JSON.stringify(ideForm)}`);
  assert.ok(
    ideForm.docScrollW <= ideForm.docClientW + 1,
    `ide: the form made the page scroll sideways — ${JSON.stringify(ideForm)}`,
  );
  await shot("ide-7-add-project-form");
  log(`ide add project form (340px): ${ideForm.dest}, ${ideForm.width}px wide`);
  await page.keyboard.press("Escape");

  // ---- happy path: New project, all the way to a closed form ---------------
  // Every other shot stops at the form. This one follows it to the end, which
  // is the only place the `done` frame is proved to close anything.
  await page.setViewportSize({ width: 420, height: 760 });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const card = document.getElementById("welcome-onboarding");
    card.innerHTML = '<button class="onb-action" type="button" data-act="addProjectFolder">Add project</button>';
    card.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector(".rail-menu", { timeout: 5000 });
  const newRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".rail-menu-item")];
    const i = rows.findIndex((r) => (r.querySelector(".rail-menu-label")?.textContent || "").trim() === "New project");
    if (i >= 0) rows[i].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return i;
  });
  assert.ok(newRow >= 0, "ide: New project must be on the menu");
  await page.waitForSelector(".add-project-form", { timeout: 5000 });
  await page.fill(".add-project-input", "Q3 Positioning");
  const preview = await page.evaluate(() => document.querySelector(".add-project-dest").textContent.trim());
  assert.equal(preview, "~/Grok Build/Q3 Positioning", `ide: destination preview — ${preview}`);
  await shot("ide-8-new-project-typed");

  // Busy, then done. Both frames drive the same form.
  await send({ type: "projectSetup", root: "~/Grok Build", busy: "new" });
  await page.waitForTimeout(120);
  const busy = await page.evaluate(() => ({
    label: document.querySelector(".add-project-primary").textContent.trim(),
    disabled: document.querySelector(".add-project-primary").disabled,
    inputDisabled: document.querySelector(".add-project-input").disabled,
  }));
  assert.equal(busy.label, "Creating…", `ide: busy label — ${JSON.stringify(busy)}`);
  assert.ok(busy.disabled && busy.inputDisabled, `ide: busy must lock the form — ${JSON.stringify(busy)}`);
  await shot("ide-9-new-project-busy");

  await send({ type: "projectSetup", root: "~/Grok Build", done: true });
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => ({
    form: !!document.querySelector(".add-project-form"),
    scrim: !!document.querySelector(".add-project-scrim"),
  }));
  assert.ok(!closed.form && !closed.scrim, `ide: done must close the form AND its scrim — ${JSON.stringify(closed)}`);
  log("new project: typed -> busy -> done -> form closed");

  // ---- the worktree tip, which is Coding-only and now has an action --------
  // Clear the button this harness injected to reach the menu: a non-empty
  // onboarding card correctly suppresses tips, so leaving it there would be the
  // harness hiding the thing it came to photograph.
  await page.evaluate(() => { document.getElementById("welcome-onboarding").innerHTML = ""; });
  await send({
    type: "welcomeTips",
    routineCount: 3,
    connectorCount: 7,
    dismissed: ["providers", "routines", "connectors", "remote", "readAloud", "voice", "mentions"],
    shownToday: [],
  });
  await send({ type: "remoteStatus", linked: true });
  await page.waitForTimeout(200);
  const wt = await page.evaluate(() => {
    const el = document.getElementById("welcome-tip");
    if (!el) return null;
    const act = el.querySelector(".muted-link");
    const b = act ? act.getBoundingClientRect() : null;
    return {
      id: el.dataset.tip,
      text: (el.querySelector(".welcome-tip-body")?.textContent || "").replace(/\s+/g, " ").trim(),
      action: act ? act.textContent.trim() : null,
      actionW: b ? Math.round(b.width) : 0,
      closeTitle: el.querySelector(".welcome-tip-dismiss")?.title || "",
    };
  });
  assert.ok(wt, "ide: the worktree tip must be the one left standing");
  assert.equal(wt.id, "worktrees", `ide: expected the worktree tip — ${JSON.stringify(wt)}`);
  assert.equal(wt.action, "Start it in a worktree", `ide: worktree action — ${JSON.stringify(wt)}`);
  assert.ok(wt.actionW > 20, `ide: worktree action has no box — ${JSON.stringify(wt)}`);
  // The owner's rule, visible in the tooltip.
  assert.equal(wt.closeTitle, "Not today", `ide: X must say what it means — ${JSON.stringify(wt)}`);
  await shot("ide-10-worktree-tip");
  log(`worktree tip: "${wt.text}" -> ${wt.action}`);

  // It fires the real thing.
  await page.click("#welcome-tip .muted-link");
  await page.waitForTimeout(150);
  const fired = await page.evaluate(() => window.__posted.filter((m) => m.type === "newWorktreeSession").length);
  assert.equal(fired, 1, "ide: the worktree link must start a worktree session");
  log("worktree tip link posts newWorktreeSession");

  assert.deepEqual(errors, [], `page errors: ${JSON.stringify(errors)}`);
  log("ALL CHECKS PASSED — frames in .screens/");
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
