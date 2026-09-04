// Screens check for the DESKTOP app — drives the real Electron build through a
// scripted session and asserts what a DOM test cannot, leaving screenshots
// behind for a person (or a model) to look at.
//
// WHY THIS EXISTS. `test/*.dom.test.ts` runs in happy-dom, which has no layout
// engine: rects are zeros and stylesheets never apply. So an icon with no size,
// a control pushed off-screen, or a panel overlapping the top bar all satisfy
// every assertion those suites can make. The file panel's action row shipped as
// three EMPTY BOXES — every icon 0x0 — through a green suite and three review
// rounds, and was found by a human looking at a screenshot.
//
// Its sibling is `npm run e2e:screens` in the relay repo, which does the same
// for the browser client. Between them they cover both surfaces of the one
// shared panel.
//
// Run: npm run e2e:screens   (frames land in .screens/, gitignored)
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildQaFixture } from "./qa-fixture.mjs";
import { assertPinnedAfterZoomedExpandedTurn, hostMsg } from "./desk-stick-to-bottom.mjs";

const root = process.cwd();
const OUT = process.env.SCREENS_DIR || ".screens";
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = await resolveElectronExe(root);
const fixtureCli = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
const log = (m) => console.log(`[desk-screens] ${m}`);

/** Electron's own binary, which is NOT `dist/electron` everywhere: macOS keeps
 *  it inside `Electron.app`. The `electron` package exports the resolved path
 *  for exactly this reason, so ask it rather than rebuilding the path here. */
async function resolveElectronExe(root) {
  try {
    const mod = await import("electron");
    const exe = typeof mod.default === "string" ? mod.default : undefined;
    if (exe && fs.existsSync(exe)) return exe;
  } catch {
    // fall through to the layout-based guess
  }
  const dist = path.join(root, "node_modules", "electron", "dist");
  if (process.platform === "win32") return path.join(dist, "electron.exe");
  if (process.platform === "darwin") return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  return path.join(dist, "electron");
}


assert.ok(fs.existsSync(mainJs), `Missing ${mainJs} — run \`npm run compile\` first`);
assert.ok(fs.existsSync(electronExe), `Missing Electron at ${electronExe}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// The shared grok-qa fixture: a fixed project AND a fixed session store, so the
// rail has real history in it and the frames are comparable between runs.
// Which root new projects go in is a per-machine decision the product makes
// from the disk (`shouldUseLegacyRoot`), so ask the product rather than mirror
// it — the same reason `qa-fixture.mjs` imports the real catalog encoder.
const { projectRoot, shouldUseLegacyRoot, legacyProjectRootPath, displayPath } =
  await import("../out/project-create.js");
const home = os.homedir();
const legacyRoot = legacyProjectRootPath(home);
let legacyIsDirectory = false;
try {
  legacyIsDirectory = fs.statSync(legacyRoot).isDirectory();
} catch {
  legacyIsDirectory = false; // absent (or unreadable) is not legacy
}
const useLegacyRoot = shouldUseLegacyRoot({ legacyIsDirectory });
const expectedProjectDest = displayPath(
  path.join(projectRoot(home, { useLegacyRoot }), "Q3 Positioning"),
  home,
);
log(`project root for this machine: ${expectedProjectDest} (legacy folder ${legacyIsDirectory ? "present" : "absent"})`);

const qa = buildQaFixture();
const workspace = qa.project;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-screens-ud-"));
fs.writeFileSync(path.join(userData, "test-config.json"), JSON.stringify({ "grok.cliPath": fixtureCli }), "utf8");

/** Every icon meant to be painted must occupy space — see the header. */
const BLANK_ICONS = `() => {
  const bad = [];
  for (const svg of document.querySelectorAll("button svg, .gfp-action svg, .icon-btn svg")) {
    const host = svg.closest("button, .gfp-action, .icon-btn");
    if (!host || host.hidden || host.offsetParent === null) continue;
    if (getComputedStyle(svg).display === "none") continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) {
      bad.push((host.title || host.id || host.className || "?") + " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
  }
  return bad;
}`;

/** Bar-icon primitive: an unpainted box (no border, transparent background)
 *  around a glyph at one of TWO sizes, split by region rather than by class.
 *
 *  20px — chat chrome that is not part of a panel: the composer's buttons and
 *         the rail's open control.
 *  16px — the PANEL scale, shared by the file explorer (header and rows), the
 *         row above the messages, and the project rail's in-row controls. These
 *         three sit side by side on one screen, and until 2026-09-02 the rail's
 *         were 13px against the explorer's 20px, which is what the owner saw.
 *
 *  Pencil stays 16; the in-tab X stays 14 (15 on coarse). Overflow … is a tab,
 *  not a member. */
const BAR_ICONS = `() => {
  const isTransparent = (c) => {
    if (!c || c === "transparent") return true;
    const m = String(c).match(/^rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\)$/);
    return !!(m && m[1] === "0" && m[2] === "0" && m[3] === "0" && (m[4] === undefined || Number(m[4]) === 0));
  };
  const isVisible = (el) => {
    if (!el || el.hidden) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (el.offsetParent !== null || s.position === "fixed");
  };
  const paintedSvg = (el) => [...el.querySelectorAll("svg")].find((n) => getComputedStyle(n).display !== "none");
  const glyphW = (el) => {
    const svg = paintedSvg(el);
    return svg ? Math.round(svg.getBoundingClientRect().width) : 0;
  };
  const noPaintedBox = (el) => {
    const s = getComputedStyle(el);
    const sides = ["Top", "Right", "Bottom", "Left"];
    const borderNone = sides.every((side) => s["border" + side + "Style"] === "none" || parseFloat(s["border" + side + "Width"]) === 0);
    return { borderNone, bgClear: isTransparent(s.backgroundColor), bg: s.backgroundColor, border: s.borderTopStyle };
  };
  const labelOf = (el) => el.id || el.getAttribute("aria-label") || el.title || String(el.className || "").trim().split(/\\s+/)[0] || "?";
  // What is LEFT at 20: the composer's own buttons. Everything that belongs to a
  // panel or to the bar above the messages is 16 (14 in VS Code).
  const CHROME = [
    ".icon-btn:not(.session-name-edit):not(#session-head-edit):not(#session-head .icon-btn):not(.top-bar .icon-btn)",
  ].join(",");
  const PANEL = [
    // The whole header bar, not just its .rail-action-btn members: on remote,
    // session-history and session-new are .icon-btn and sat at 20 beside a 16.
    "#session-head .icon-btn:not(.session-name-edit):not(#session-head-edit)",
    ".top-bar .icon-btn:not(.session-name-edit):not(#session-head-edit)",
    ".rail-icon-btn",
    ".desk-rail-open-btn",
    ".gfp-toggle",
    ".gfp-icon-button",
    ".gfp-close",
    ".gfp-viewer .gfp-action.gfp-icon-only",
    "#session-head .rail-action-btn",
    "#session-head-actions .rail-action-btn",
    "#vscode-session-actions .rail-action-btn",
  ].join(",");
  const SEL = CHROME + "," + PANEL;
  const TOUCH = window.matchMedia && window.matchMedia("(hover: none)").matches;
  const bad = [];
  const seen = [];
  const members = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.includes(el) || !isVisible(el)) continue;
    seen.push(el);
    const g = glyphW(el);
    const box = noPaintedBox(el);
    const what = labelOf(el);
    members.push({ what, glyph: g, bg: box.bg, border: box.border });
    // THREE tiers, and the third is the viewport's, not the selector's: under
    // (hover: none) the panel scale goes back to 20, because a 16px glyph read
    // at arm's length inside a 36px target is not the same problem as a 16px
    // glyph read at desk distance. Asserting 16 everywhere failed on the tablet
    // render for a UI that was behaving correctly.
    const want = el.matches(PANEL) ? (TOUCH ? 20 : 16) : 20;
    if (Math.abs(g - want) > 1) bad.push(what + " glyph " + g + "px (want " + want + ")");
    if (!box.borderNone) bad.push(what + " border-style " + box.border);
    if (!box.bgClear) bad.push(what + " background " + box.bg);
  }
  const pencil = document.querySelector("#session-head-edit, button.session-name-edit");
  if (pencil && isVisible(pencil)) {
    const g = glyphW(pencil);
    const box = noPaintedBox(pencil);
    members.push({ what: "pencil", glyph: g, exempt: true });
    const pw = TOUCH ? 20 : 16;
    if (Math.abs(g - pw) > 1) bad.push("pencil glyph " + g + "px (want " + pw + ")");
    if (!box.borderNone) bad.push("pencil border-style " + box.border);
    if (!box.bgClear) bad.push("pencil background " + box.bg);
  }
  const tabX = document.querySelector(".gfp-tab-active:not([hidden]) .gfp-tab-close");
  if (tabX && isVisible(tabX)) {
    const g = glyphW(tabX);
    const coarse = matchMedia("(hover: none) and (pointer: coarse)").matches;
    const want = coarse ? 15 : 14;
    members.push({ what: "tab-X", glyph: g, exempt: true });
    if (Math.abs(g - want) > 1) bad.push("tab-X glyph " + g + "px (want " + want + ")");
  }
  return { bad, members };
}`;

// GROK_HOME is the supported override for the session store (`resolveGrokHome`),
// so the app reads the fixture's history instead of this machine's.
const env = { ...process.env, GROK_HOME: qa.grokHome };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: electronExe,
  args: [
    mainJs,
    `--workspace=${workspace}`,
    `--user-data-dir=${userData}`,
    `--config-json=${path.join(userData, "test-config.json")}`,
  ],
  env,
  timeout: 60000,
});

try {
  const page = await app.firstWindow({ timeout: 60000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    log(`captured ${name}.png`);
  };
  const assertNoBlankIcons = async (where) => {
    const blank = await page.evaluate(`(${BLANK_ICONS})()`);
    assert.deepEqual(blank, [], `${where}: icons rendered with no size — ${JSON.stringify(blank)}`);
  };
  const assertBarIcons = async (where) => {
    const { bad, members } = await page.evaluate(`(${BAR_ICONS})()`);
    assert.ok(members.length > 0, `${where}: bar-icon gate measured nothing`);
    assert.deepEqual(bad, [], `${where}: bar-icon primitive — ${JSON.stringify(bad)} (saw ${JSON.stringify(members)})`);
    const selected = await page.evaluate(() => {
      const group = document.querySelector(".gfp-viewer .gfp-seg");
      if (!group || group.offsetParent === null) return null;
      const gs = getComputedStyle(group);
      const on = group.querySelector(".gfp-seg-on");
      const os = on ? getComputedStyle(on) : null;
      return {
        groupBorder: gs.borderTopStyle,
        groupBorderW: gs.borderTopWidth,
        onTitle: on?.title || "",
        onBg: os?.backgroundColor || "",
        onCount: group.querySelectorAll(".gfp-seg-on").length,
      };
    });
    if (selected) {
      assert.ok(
        selected.groupBorder !== "none" && parseFloat(selected.groupBorderW) > 0,
        `${where}: .gfp-seg must paint a group border (style ${selected.groupBorder}, width ${selected.groupBorderW})`,
      );
      assert.equal(selected.onCount, 1, `${where}: segmented control must have exactly one .gfp-seg-on`);
      const clear = !selected.onBg || selected.onBg === "transparent" || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(selected.onBg);
      assert.ok(!clear, `${where}: selected "${selected.onTitle}" must have a filled background (${selected.onBg})`);
    }
  };

  const assertToolbarEnd = async (where) => {
    const info = await page.evaluate(() => {
      const bar = document.querySelector(".gfp-viewer-head");
      const end = document.querySelector(".gfp-viewer-end");
      if (!bar || !end || end.offsetParent === null) return null;
      const b = bar.getBoundingClientRect();
      const e = end.getBoundingClientRect();
      return { barRight: b.right, endRight: e.right, gap: Math.round(b.right - e.right) };
    });
    if (!info) return;
    assert.ok(
      info.gap >= -2 && info.gap <= 12,
      `${where}: toolbar end (Cancel/Save/⋯) must sit at the bar's right edge (gap ${info.gap}px) — ${JSON.stringify(info)}`,
    );
  };

  await page.waitForSelector("#input", { timeout: 45000 });
  await page.waitForSelector("#desk-ft-top-toggle", { timeout: 25000 });
  await page.waitForTimeout(500);

  const zoomFactor = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.webContents.getZoomFactor() : null;
  });
  assert.ok(
    typeof zoomFactor === "number" && Math.abs(zoomFactor - 1) < 0.001,
    `desk: Chromium zoomFactor must stay 1 (got ${zoomFactor})`,
  );
  const bootLayout = await page.evaluate(() => ({
    top: document.documentElement.scrollTop,
    left: document.documentElement.scrollLeft,
  }));
  assert.equal(bootLayout.top, 0, `desk: documentElement.scrollTop must stay 0 after boot (got ${bootLayout.top})`);
  assert.equal(bootLayout.left, 0, `desk: documentElement.scrollLeft must stay 0 after boot (got ${bootLayout.left})`);
  await shot("desk-1-chat");
  await assertNoBlankIcons("desk chat");
  await assertBarIcons("desk chat");

  // ---- empty-state advice -------------------------------------------------
  // happy-dom proves the wiring; only a real engine can say whether the line
  // fits. Three ways this fails invisibly to a DOM suite: the row overflows the
  // 30ch measure, the dismiss glyph renders as a zero-size box (the exact bug
  // that shipped three empty icons through a green suite), or the tip paints
  // UNDER the composer because the welcome column ran out of room.
  const tip = await page.evaluate(() => {
    const el = document.getElementById("welcome-tip");
    if (!el) return null;
    const welcome = document.getElementById("welcome");
    const body = el.querySelector(".welcome-tip-body");
    const close = el.querySelector(".welcome-tip-dismiss");
    const action = el.querySelector(".muted-link, b");
    const composer = document.querySelector("footer.composer");
    const r = el.getBoundingClientRect();
    const wr = welcome ? welcome.getBoundingClientRect() : null;
    const cr = composer ? composer.getBoundingClientRect() : null;
    const clr = close ? close.getBoundingClientRect() : null;
    const ar = action ? action.getBoundingClientRect() : null;
    return {
      id: el.dataset.tip || "",
      text: (body?.textContent || "").replace(/\s+/g, " ").trim(),
      width: Math.round(r.width),
      height: Math.round(r.height),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      insideWelcome: !!(wr && r.top >= wr.top - 1 && r.bottom <= wr.bottom + 1),
      aboveComposer: !!(cr && r.bottom <= cr.top + 1),
      close: clr ? { w: Math.round(clr.width), h: Math.round(clr.height) } : null,
      action: ar ? { w: Math.round(ar.width), h: Math.round(ar.height), tag: action.tagName } : null,
      // A 512-viewBox SVG with no width/height renders as an empty box, which
      // is precisely the defect class this harness was written for.
      bulb: (() => {
        const svg = el.querySelector(".welcome-tip-bulb svg");
        if (!svg) return null;
        const b = svg.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), fill: getComputedStyle(svg).fill };
      })(),
      actionColor: action ? getComputedStyle(action).color : "",
      bodyColor: body ? getComputedStyle(body).color : "",
    };
  });
  assert.ok(tip, "desk chat: empty-state advice must render on a settled welcome screen");
  assert.ok(tip.id, "desk chat: the tip must carry its id, so a screenshot says WHICH tip it is");
  assert.ok(tip.text.length > 10, `desk chat: tip text looks empty — ${JSON.stringify(tip)}`);
  assert.ok(tip.height > 10 && tip.width > 80, `desk chat: tip has no box — ${JSON.stringify(tip)}`);
  assert.ok(
    tip.scrollW <= tip.clientW + 1,
    `desk chat: tip text overflows its own box (${tip.scrollW} > ${tip.clientW}) — ${JSON.stringify(tip)}`,
  );
  assert.ok(tip.insideWelcome, `desk chat: tip must sit inside the welcome block — ${JSON.stringify(tip)}`);
  assert.ok(tip.aboveComposer, `desk chat: tip must not paint under the composer — ${JSON.stringify(tip)}`);
  assert.ok(
    tip.close && tip.close.w >= 6 && tip.close.h >= 6,
    `desk chat: dismiss control rendered with no size — ${JSON.stringify(tip)}`,
  );
  assert.ok(
    tip.action && tip.action.w >= 20 && tip.action.h >= 6,
    `desk chat: the actionable span rendered with no size — ${JSON.stringify(tip)}`,
  );
  assert.ok(
    tip.bulb && tip.bulb.w >= 8 && tip.bulb.h >= 8,
    `desk chat: the advice mark rendered with no size — ${JSON.stringify(tip)}`,
  );
  log(`welcome tip: ${tip.id} — "${tip.text}" (${tip.width}x${tip.height}), mark ${tip.bulb.w}x${tip.bulb.h} ${tip.bulb.fill}`);
  await shot("desk-1b-welcome-tip");

  // Taking the advice opens the settings page it names and retires the line.
  await page.click("#welcome-tip .muted-link");
  await page.waitForTimeout(400);
  const afterTake = await page.evaluate(() => ({
    settingsOpen: !!document.getElementById("settings-overlay"),
    category: document.querySelector(".settings-nav-item.active")?.dataset.category || "",
    tip: document.getElementById("welcome-tip")?.dataset.tip || null,
  }));
  assert.ok(afterTake.settingsOpen, `desk chat: taking a tip must open Settings — ${JSON.stringify(afterTake)}`);
  // The whole point of the owner's third request: the link must land on the
  // RIGHT page, not merely open Settings somewhere.
  assert.equal(
    afterTake.category,
    "providers",
    `desk chat: the agents tip must open Settings on Providers — ${JSON.stringify(afterTake)}`,
  );
  await shot("desk-1c-welcome-tip-target");
  log(`welcome tip target: settings open on "${afterTake.category}"`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const retired = await page.evaluate(
    () => document.getElementById("welcome-tip")?.dataset.tip || null,
  );
  assert.notEqual(retired, tip.id, "desk chat: acting on advice must retire that advice");
  // Proves the host actually READ the fixture store. Without this the check
  // passes just as happily against an empty rail, which is exactly what a wrong
  // session-directory encoding produces — silently.
  // ---- Add project ---------------------------------------------------------
  // The menu and the form are built from the shared spec, so what a DOM test
  // cannot see is whether the three rows fit the rail's popover width and
  // whether the modal is centred over the app rather than clipped by it.
  await page.click(".rail-add-project");
  await page.waitForSelector(".rail-menu", { timeout: 5000 });
  const menu = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".rail-menu-item")];
    const box = document.querySelector(".rail-menu").getBoundingClientRect();
    return {
      labels: rows.map((r) => r.querySelector(".rail-menu-label")?.textContent?.trim() || ""),
      descriptions: rows.map((r) => r.querySelector(".rail-menu-desc")?.textContent?.trim() || ""),
      clipped: rows.some((r) => r.scrollWidth > r.clientWidth + 1),
      onScreen: box.left >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
      iconSizes: rows.map((r) => {
        const svg = r.querySelector("svg");
        const b = svg ? svg.getBoundingClientRect() : { width: 0, height: 0 };
        return [Math.round(b.width), Math.round(b.height)];
      }),
    };
  });
  // Knowledge work is the desktop default, and since 4.1.6 cloning WORKS here
  // rather than being a hint pointing at a setting. That hint existed because
  // an absent affordance explains nothing; an affordance that simply works
  // explains even less badly, and cloning was never a coding-only act — it is
  // how you get a project at all. Order matters: it leads, because someone who
  // opened this menu to clone something should meet it first.
  assert.deepEqual(
    menu.labels,
    ["Clone from GitHub", "New project", "Import a folder"],
    `desk: add-project menu — ${JSON.stringify(menu)}`,
  );
  assert.ok(menu.descriptions.every(Boolean), `desk: every entry needs its second line — ${JSON.stringify(menu)}`);
  assert.ok(!menu.clipped, `desk: menu rows are clipped — ${JSON.stringify(menu)}`);
  assert.ok(menu.onScreen, `desk: menu runs off the window — ${JSON.stringify(menu)}`);
  // Painted, not a specific size: the rail scales its own glyphs, and pinning
  // the number here would fail the next time that scale is tuned. Zero is the
  // failure worth catching — three empty boxes once shipped through a green
  // suite and three review rounds.
  // Nothing is exempt any more: the one iconless row was the knowledge-work
  // hint, and it is gone. Kept as an empty set rather than deleted, because the
  // exemption is expressed by LABEL — the next row that legitimately has no
  // icon names itself here, instead of the rule being relaxed to "some row may
  // have none", which would hand back the bug this catches.
  const iconExempt = new Set([]);
  const mustPaint = menu.iconSizes.filter((_, i) => !iconExempt.has(menu.labels[i]));
  assert.equal(
    mustPaint.length,
    menu.labels.length - menu.labels.filter((l) => iconExempt.has(l)).length,
    `desk: icon exemption did not match a row — ${JSON.stringify(menu)}`,
  );
  assert.ok(
    mustPaint.every(([w, h]) => w >= 10 && h >= 10),
    `desk: menu icons rendered with no size — ${JSON.stringify(menu)}`,
  );
  await shot("desk-1d-add-project-menu");
  log(`add project menu: ${menu.labels.join(" / ")}`);

  // By LABEL, not by position. This used to click the first row because
  // "New project" happened to be it; cloning now leads, so an index would
  // silently exercise a different form and assert the wrong thing about it.
  await page.click('.rail-menu-item:has(.rail-menu-label:text-is("New project"))');
  await page.waitForSelector(".add-project-form", { timeout: 5000 });
  await page.fill(".add-project-input", "Q3 Positioning");
  const formBox = await page.evaluate(() => {
    const el = document.querySelector(".add-project-form");
    const b = el.getBoundingClientRect();
    return {
      dest: document.querySelector(".add-project-dest").textContent.trim(),
      submitLabel: document.querySelector(".add-project-primary").textContent.trim(),
      submitEnabled: !document.querySelector(".add-project-primary").disabled,
      onScreen: b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth,
      width: Math.round(b.width),
      focused: document.activeElement?.className || "",
      scrimCovers: (() => {
        const s = document.querySelector(".add-project-scrim").getBoundingClientRect();
        return Math.round(s.width) === window.innerWidth && Math.round(s.height) === window.innerHeight;
      })(),
    };
  });
  // The point of the whole feature: nobody types a path, and everybody sees one.
  //
  // The expected path is DERIVED from the product's own rule, not written out.
  // It was written out — as `~/Grok Build/…` — and that only holds on a machine
  // which already has the legacy folder. This dev box does; the macOS test box
  // does not and correctly showed `~/AFK Pilot/…`, so the check failed on a
  // product that was working. A CI runner would have failed the same way.
  assert.equal(formBox.dest, expectedProjectDest, `desk: destination preview — ${JSON.stringify(formBox)}`);
  assert.ok(formBox.submitEnabled, `desk: Create stayed disabled — ${JSON.stringify(formBox)}`);
  assert.ok(formBox.onScreen, `desk: the form is clipped by the window — ${JSON.stringify(formBox)}`);
  assert.ok(formBox.scrimCovers, `desk: the scrim does not cover the window — ${JSON.stringify(formBox)}`);
  assert.ok(
    formBox.focused.includes("add-project-input"),
    `desk: the form must open with the caret in the field — ${JSON.stringify(formBox)}`,
  );
  await shot("desk-1e-add-project-form");
  log(`add project form: ${formBox.dest} (${formBox.width}px, focus ${formBox.focused})`);

  // A failure keeps the form up with something to act on. Driven through the
  // host frame rather than a real clone — the shape is what is being checked.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "projectSetup",
    root: "~/Grok Build",
    error: "Git couldn't authenticate. If the repository is private, you need to sign in first.",
    fix: "auth-gh",
  } })));
  const failed = await page.evaluate(() => {
    const err = document.querySelector(".add-project-error");
    const fix = document.querySelector(".add-project-fix");
    return {
      stillOpen: !!document.querySelector(".add-project-form"),
      error: err && !err.hidden ? err.textContent.trim() : "",
      fix: fix && !fix.hidden ? fix.textContent.trim() : "",
      fixBox: fix ? Math.round(fix.getBoundingClientRect().height) : 0,
    };
  });
  assert.ok(failed.stillOpen, "desk: a failed attempt must not close the form");
  assert.ok(failed.error.includes("sign in"), `desk: failure text — ${JSON.stringify(failed)}`);
  assert.equal(failed.fix, "Sign in to GitHub", `desk: the offered fix — ${JSON.stringify(failed)}`);
  assert.ok(failed.fixBox >= 10, `desk: the fix button has no box — ${JSON.stringify(failed)}`);
  await shot("desk-1f-add-project-failure");
  log(`add project failure: "${failed.error}" → ${failed.fix}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => !!document.querySelector(".add-project-form")),
    false,
    "desk: Escape must close the form",
  );

  const railTitles = await page.evaluate(
    () => [...document.querySelectorAll(".rail-session .rail-session-name, .rail-session")]
      .map((n) => (n.textContent || "").trim()).filter(Boolean),
  );
  // The rail previews only the newest few per project, so this asserts ORDER
  // rather than presence of all four: whichever fixture conversations are shown
  // must be the newest ones, newest first. That is the property worth pinning —
  // ordering by transcript mtime is what a merely-opened session used to break.
  const shown = [];
  for (const text of railTitles) {
    const hit = qa.expectedOrder.find((t) => text.startsWith(t));
    if (hit && !shown.includes(hit)) shown.push(hit);
  }
  assert.ok(shown.length >= 2, `desk: the rail showed no fixture history — saw ${JSON.stringify(railTitles.slice(0, 8))}`);
  assert.deepEqual(
    shown,
    qa.expectedOrder.slice(0, shown.length),
    "desk: the rail must list the fixture conversations newest first",
  );
  log(`rail shows ${shown.length} fixture conversations, newest first`);

  if (!(await page.locator("#desk-ft-panel").isVisible().catch(() => false))) {
    await page.locator("#desk-ft-top-toggle").click();
  }
  await page.waitForSelector("#desk-ft-panel", { state: "visible", timeout: 25000 });
  await page.waitForSelector(".gfp-row", { timeout: 25000 });
  await page.waitForTimeout(400);
  await shot("desk-2-tree");
  await assertNoBlankIcons("desk tree");
  await assertBarIcons("desk tree");

  await page.locator(".gfp-row", { hasText: "README.md" }).first().click();
  await page.waitForSelector(".gfp-viewer:not([hidden])", { timeout: 25000 });
  await page.waitForTimeout(500);
  await shot("desk-3-file");
  await assertNoBlankIcons("desk file open");
  await assertBarIcons("desk file open");
  assert.equal(
    await page.evaluate(() => { const f = document.querySelector(".gfp-filter"); return !!f && getComputedStyle(f).display !== "none"; }),
    false,
    "desk: the tree filter must hide once a file is open — it has no tree to search",
  );
  assert.deepEqual(
    // Modes live in .gfp-seg now; titles still paint in this order because
    // Preview / Edit source stay first in the toolbar and ⋯ is in the
    // right-end group. Query by [title] so text buttons (no title) drop out.
    await page.evaluate(() => [...document.querySelectorAll(".gfp-viewer-head [title]")].map((b) => b.title)),
    ["Preview", "Edit source", "More actions"],
    "desk: Markdown shows the mode pair, plus the host-local actions menu",
  );
  await assertToolbarEnd("desk file open");

  await page.locator(".gfp-viewer [title='Edit source']").click();
  await page.waitForSelector(".gfp-editor", { timeout: 25000 });
  await page.waitForTimeout(400);
  await shot("desk-4-edit");
  await assertNoBlankIcons("desk editing");
  await assertBarIcons("desk editing");
  await assertToolbarEnd("desk editing");

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const bar = document.querySelector("#desk-ft-top-toggle")?.closest("header, .top-bar");
    const r = panel?.getBoundingClientRect();
    return {
      panelTop: r ? Math.round(r.top) : null,
      panelRight: r ? Math.round(r.right) : null,
      barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
      viewportWidth: window.innerWidth,
      docWidth: document.documentElement.scrollWidth,
    };
  });
  assert.ok(
    geometry.panelTop >= geometry.barBottom - 1,
    `desk: the panel must start below the bar holding its toggle (panel ${geometry.panelTop}, bar bottom ${geometry.barBottom})`,
  );
  assert.ok(
    geometry.panelRight <= geometry.viewportWidth + 1,
    `desk: the panel must not run off the right edge (${geometry.panelRight} > ${geometry.viewportWidth})`,
  );
  assert.ok(
    geometry.docWidth <= geometry.viewportWidth + 1,
    `desk: the window must not scroll horizontally (${geometry.docWidth} > ${geometry.viewportWidth})`,
  );

  const measureStrip = () =>
    page.evaluate(() => {
      const strip = document.querySelector(".gfp-header");
      const tabs = document.querySelector(".gfp-tabs");
      const panel = document.querySelector(".gfp-panel");
      const sr = strip?.getBoundingClientRect();
      const visibleTabs = [...(tabs?.querySelectorAll(".gfp-tab:not([hidden])") || [])];
      const iconOf = (root, sel) => [...(root?.querySelectorAll(sel) || [])].map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const close = document.querySelector(".gfp-tab-active:not([hidden]) .gfp-tab-close");
      const cr = close?.getBoundingClientRect();
      const cs = close ? getComputedStyle(close) : null;
      return {
        state: panel?.dataset.stripState || "",
        titleIcons: iconOf(strip, ".gfp-title-icon img, .gfp-title-icon .gfp-file-icon-mono, .gfp-title-icon svg"),
        tabIcons: visibleTabs.flatMap((tab) => iconOf(tab, ".gfp-tab-icon img, .gfp-tab-icon .gfp-file-icon-mono, .gfp-tab-icon svg")),
        tabCount: visibleTabs.length,
        overflow: strip ? strip.scrollWidth > strip.clientWidth + 1 : true,
        scrollW: strip ? strip.scrollWidth : 0,
        clientW: strip ? strip.clientWidth : 0,
        tabsScroll: tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : true,
        tabsOverflowX: tabs ? getComputedStyle(tabs).overflowX : "",
        closeVisible: !!close && !!cs && cs.display !== "none" && cs.visibility !== "hidden",
        closeLeft: cr ? cr.left : null,
        closeRight: cr ? cr.right : null,
        stripLeft: sr ? sr.left : null,
        stripRight: sr ? sr.right : null,
        chip: !!document.querySelector(".gfp-overflow-chip"),
      };
    });

  const assertStripGeometry = async (where, opts = {}) => {
    const strip = await measureStrip();
    assert.ok(strip.titleIcons.length >= 1, `${where}: title strip must paint a folder icon — ${JSON.stringify(strip)}`);
    if (strip.tabCount > 0) {
      assert.equal(strip.tabIcons.length, strip.tabCount, `${where}: every rendered tab must have an icon — ${JSON.stringify(strip)}`);
    }
    const blank = [...strip.titleIcons, ...strip.tabIcons].filter((icon) => icon.w < 6 || icon.h < 6);
    assert.deepEqual(blank, [], `${where}: title-strip icons rendered with no size — ${JSON.stringify(strip)}`);
    assert.equal(strip.overflow, false, `${where}: title strip overflowed horizontally (${strip.scrollW} > ${strip.clientW})`);
    assert.ok(strip.scrollW <= strip.clientW + 1, `${where}: strip scrollWidth ${strip.scrollW} > clientWidth ${strip.clientW}`);
    assert.equal(strip.tabsScroll, false, `${where}: tab row scrolled (${strip.tabsOverflowX})`);
    assert.ok(
      strip.tabsOverflowX !== "auto" && strip.tabsOverflowX !== "scroll",
      `${where}: .gfp-tabs must not scroll (overflow-x ${strip.tabsOverflowX})`,
    );
    if (strip.closeVisible) {
      assert.ok(
        strip.closeLeft >= strip.stripLeft - 1 && strip.closeRight <= strip.stripRight + 1,
        `${where}: active tab X is clipped by the strip — ${JSON.stringify(strip)}`,
      );
    }
    if (opts.expectChip) {
      assert.equal(strip.chip, true, `${where}: expected the overflow chip — ${JSON.stringify(strip)}`);
    }
    // The maximize control may never vanish or be overlapped, in ANY state —
    // pinned after the owner asked whether right-alignment had eaten it.
    const maxi = await page.evaluate(() => {
      const btn = document.querySelector(".gfp-maximize");
      const header = document.querySelector(".gfp-header");
      if (!btn || btn.hidden || !header) return { present: false };
      const b = btn.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      return {
        present: b.width >= 16 && b.height >= 16,
        inside: b.left >= h.left - 1 && b.right <= h.right + 1,
        clearOfTabs: ![...document.querySelectorAll(".gfp-tab:not([hidden]), .gfp-overflow-chip")]
          .some((t) => { const r = t.getBoundingClientRect(); return r.right > b.left + 1 && r.left < b.right - 1; }),
      };
    });
    assert.ok(maxi.present, `${where}: maximize control missing or unsized`);
    assert.ok(maxi.inside, `${where}: maximize control clipped outside the strip`);
    assert.ok(maxi.clearOfTabs, `${where}: a tab or the chip overlaps the maximize control`);
    return strip;
  };

  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".gfp-header img")];
    return imgs.length > 0 && imgs.every((img) => img.complete);
  }, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(200);
  await assertStripGeometry("desk 1440 title strip");

  const beforeMax = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const chat = document.querySelector(".desk-ft-chat");
    return {
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      chatVisible: !!chat && getComputedStyle(chat).display !== "none",
      stored: localStorage.getItem("desk-ft-width"),
    };
  });
  assert.ok(beforeMax.panelW >= 200, `desk: panel has no width before maximize (${beforeMax.panelW})`);
  const maximizeBtn = page.locator("#desk-ft-maximize");
  assert.ok(await maximizeBtn.isVisible().catch(() => false), "desk: maximize control must be visible on the desktop panel");
  await maximizeBtn.click();
  await page.waitForFunction(() => document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);
  await shot("desk-3b-maximized");
  await assertNoBlankIcons("desk maximized");
  await assertBarIcons("desk maximized");
  const maximized = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const chat = document.querySelector(".desk-ft-chat");
    const shell = document.getElementById("desk-ft-shell");
    const pr = panel?.getBoundingClientRect();
    const sr = shell?.getBoundingClientRect();
    const chatCs = chat ? getComputedStyle(chat) : null;
    return {
      panelW: pr ? Math.round(pr.width) : 0,
      shellW: sr ? Math.round(sr.width) : 0,
      chatDisplay: chatCs?.display || "missing",
      stored: localStorage.getItem("desk-ft-width"),
    };
  });
  assert.equal(maximized.chatDisplay, "none", `desk: chat must hide while the panel is maximized — ${JSON.stringify(maximized)}`);
  assert.ok(
    maximized.panelW >= maximized.shellW - 20 && maximized.panelW <= maximized.shellW + 4,
    `desk: maximized panel must fill the content area (panel ${maximized.panelW} vs shell ${maximized.shellW})`,
  );
  assert.equal(
    maximized.stored,
    beforeMax.stored,
    `desk: maximize must not persist a width (stored ${maximized.stored}, was ${beforeMax.stored})`,
  );
  await assertStripGeometry("desk maximized title strip");
  await maximizeBtn.click();
  await page.waitForFunction(() => !document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);
  const restored = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const chat = document.querySelector(".desk-ft-chat");
    return {
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      chatVisible: !!chat && getComputedStyle(chat).display !== "none",
    };
  });
  assert.equal(restored.chatVisible, true, "desk: chat must return after restore");
  assert.ok(
    Math.abs(restored.panelW - beforeMax.panelW) <= 8,
    `desk: restore must return the prior split width (was ${beforeMax.panelW}, now ${restored.panelW})`,
  );
  await shot("desk-3c-restored");

  // Three-state strip: open several files, then walk widths until A/B/C each
  // appear. The old scroll model hid later tabs; this is the replacement.
  const showTree = async () => {
    if (await page.locator(".gfp-viewer:not([hidden])").isVisible().catch(() => false)) {
      await page.locator("#desk-ft-title").click();
      await page.waitForSelector(".gfp-tree:not([hidden])", { timeout: 10000 });
      await page.waitForTimeout(150);
    }
  };
  const openTreeRow = async (label) => {
    await showTree();
    await page.locator(".gfp-row", { hasText: label }).first().click();
    await page.waitForTimeout(200);
  };
  const setPanelWidth = async (px) => {
    await page.evaluate((w) => {
      const panel = document.querySelector(".gfp-panel");
      if (panel) panel.style.setProperty("--gfp-width", `${w}px`);
    }, px);
    await page.waitForTimeout(280);
  };
  await openTreeRow("package.json");
  await openTreeRow("src");
  await openTreeRow("index.ts");
  await openTreeRow("util.ts");
  await openTreeRow("docs");
  await openTreeRow("notes.md");
  const openTabCount = await page.evaluate(() => document.querySelectorAll(".gfp-tab").length);
  assert.ok(openTabCount >= 3, `desk: need 3+ open files to reach B/C (got ${openTabCount})`);

  const seenStates = new Set();
  const recordState = async (name) => {
    const strip = await assertStripGeometry(name);
    seenStates.add(strip.state);
    await shot(name);
    return strip;
  };

  await maximizeBtn.click();
  await page.waitForFunction(() => document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);
  await recordState("desk-strip-a");
  await maximizeBtn.click();
  await page.waitForFunction(() => !document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);

  let stateC = null;
  // A SWEEP, not a list of six magic widths. Which width flips the strip from
  // one state to the next is a function of font metrics, and those are not the
  // same on every platform: the old list walked straight over state B on macOS
  // (saw a and c, never b) and failed a strip that was working correctly. Step
  // finely enough that no state can fall between two probes; the loop still
  // breaks as soon as B and C have both been seen, so this costs nothing on the
  // platform where the old widths happened to line up.
  const sweep = [];
  for (let w = 420; w >= 180; w -= 10) sweep.push(w);
  for (const width of sweep) {
    await setPanelWidth(width);
    const strip = await assertStripGeometry(`desk strip @${width}`);
    if (strip.state && !seenStates.has(strip.state)) {
      seenStates.add(strip.state);
      await shot(`desk-strip-${strip.state}`);
    }
    if (strip.state === "c") stateC = strip;
    if (seenStates.has("b") && seenStates.has("c")) break;
  }
  assert.ok(seenStates.has("a"), `desk: never reached strip state A — saw ${[...seenStates]}`);
  assert.ok(seenStates.has("b"), `desk: never reached strip state B — saw ${[...seenStates]}`);
  assert.ok(seenStates.has("c"), `desk: never reached strip state C — saw ${[...seenStates]}`);
  assert.equal(stateC?.chip, true, `desk: state C must show the overflow chip — ${JSON.stringify(stateC)}`);

  // Resize convergence (owner: "tabs never longer than needed, always match
  // the last resolution"). Bounce the width and settle back wide, twice: every
  // named tab must sit at its measured content width (no wider), and the
  // second settle must reproduce the first — a +1px-per-pass basis ratchet
  // once made tabs grow forever across resizes.
  const settleMeasure = async () => {
    await setPanelWidth(430);
    await page.waitForTimeout(300);
    return page.evaluate(() =>
      [...document.querySelectorAll(".gfp-tab:not([hidden]):not(.gfp-tab-icon-only)")]
        .map((el) => ({
          rel: el.dataset.rel,
          w: Math.round(el.getBoundingClientRect().width),
          fullW: Math.round(Number(el.dataset.fullW) || 0),
        })));
  };
  // BOTH settles must follow the same bounce. This one used to measure straight
  // out of the state sweep above while the second measured after a bounce to
  // 220 — so the two sides of the comparison had different histories, and the
  // check only passed because the sweep happened to end somewhere that produced
  // the same number. Widening the sweep by a few widths broke it on Windows and
  // macOS alike, reporting a 157→138 "ratchet" in a product that was fine. A
  // ratchet still shows: it would make settled2 WIDER than settled1.
  await setPanelWidth(220);
  await page.waitForTimeout(300);
  const settled1 = await settleMeasure();
  await setPanelWidth(220);
  await page.waitForTimeout(300);
  const settled2 = await settleMeasure();
  assert.ok(settled1.length >= 1, `desk: expected named tabs at 430px — ${JSON.stringify(settled1)}`);
  for (const t of settled2) {
    assert.ok(
      t.w <= t.fullW + 2,
      `desk: tab ${t.rel} renders wider than its content (${t.w} > fullW ${t.fullW})`,
    );
  }
  assert.deepEqual(
    settled2, settled1,
    "desk: re-settling at the same width must reproduce identical tab widths (basis ratchet?)",
  );
  // Back to the narrow width the chip interaction below expects (state C).
  await setPanelWidth(200);
  await page.waitForTimeout(300);

  await page.locator(".gfp-overflow-chip").click();
  await page.waitForSelector(".gfp-overflow-menu", { timeout: 5000 });
  const overflowMenu = await page.evaluate(() => {
    const menu = document.querySelector(".gfp-overflow-menu");
    const rows = [...(menu?.querySelectorAll(".gfp-overflow-item") || [])].map((row) => ({
      name: row.querySelector(".gfp-overflow-name")?.textContent || "",
      icon: !!row.querySelector(".gfp-tab-icon img, .gfp-tab-icon .gfp-file-icon-mono, .gfp-tab-icon svg"),
      dirty: !!row.querySelector(".gfp-overflow-dirty"),
    }));
    return { open: !!menu, rows };
  });
  assert.equal(overflowMenu.open, true, "desk: overflow chip must open a dropdown");
  assert.ok(overflowMenu.rows.length >= 2, `desk: overflow menu should list the other files — ${JSON.stringify(overflowMenu)}`);
  assert.ok(
    overflowMenu.rows.every((row) => row.icon && row.name),
    `desk: every overflow row needs an icon and a name — ${JSON.stringify(overflowMenu)}`,
  );
  await shot("desk-strip-c-menu");
  await page.locator(".gfp-overflow-chip").click();
  await page.waitForFunction(() => !document.querySelector(".gfp-overflow-menu"), { timeout: 5000 });
  await setPanelWidth(280);

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForTimeout(300);
  await assertStripGeometry("desk 1024 title strip");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  // RENAME MUST NOT RESIZE THE BAR. Clicking the conversation name swaps a
  // label for an input, and if the two boxes measure differently the whole row
  // moves and the separator under it follows. This is measurable only with a
  // layout engine, which is why it went unnoticed: happy-dom reports zeros for
  // both boxes and agrees they match.
  //
  // Verified sensitive by mutation: giving `.session-name-input` 9px of vertical
  // padding instead of 3px moves the bar 35→42 and the chip 30→38 and fails
  // here. Note the fixture opens a conversation with no project line, so
  // `repoTop` is 0 in both samples — it is carried for the day the chip's second
  // row is populated (a height pinned on the wrong box would hold the bar steady
  // while shoving that line around), and proves nothing on its own today.
  const renameBoxes = () =>
    page.evaluate(() => {
      const bar = document.querySelector("#desk-ft-top-toggle")?.closest("header, .top-bar");
      const chip = document.querySelector(".session-name-chip");
      const repo = document.querySelector(".session-name-repo");
      const px = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
      return { bar: px(bar), chip: px(chip), repoTop: repo ? Math.round(repo.getBoundingClientRect().top) : null };
    });

  const nameLabel = page.locator(".session-name-label").first();
  assert.ok(
    await nameLabel.isVisible().catch(() => false),
    "desk: no conversation name to rename — the check cannot be skipped silently, so this is a failure",
  );
  const beforeRename = await renameBoxes();
  // Every member of that object degrades to null when its selector misses, and
  // `{bar:null, chip:null}` compares equal to itself — so a renamed selector
  // would leave this gate printing ALL CHECKS PASSED while measuring nothing.
  // Prove there are real heights before the comparison can mean anything.
  for (const key of ["bar", "chip"]) {
    assert.ok(
      typeof beforeRename[key] === "number" && beforeRename[key] > 0,
      `desk: rename gate measured nothing for '${key}' (selector renamed?) — ${JSON.stringify(beforeRename)}`,
    );
  }
  await nameLabel.click();
  await page.waitForSelector(".session-name-input", { timeout: 15000 });
  await page.waitForTimeout(250);
  const duringRename = await renameBoxes();
  await shot("desk-5-rename");
  await assertNoBlankIcons("desk renaming");
  await assertBarIcons("desk renaming");
  assert.deepEqual(
    duringRename,
    beforeRename,
    `desk: renaming must not resize the top bar — before ${JSON.stringify(beforeRename)}, during ${JSON.stringify(duringRename)}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  assert.deepEqual(
    await renameBoxes(),
    beforeRename,
    "desk: leaving rename must restore the bar's geometry",
  );

  assert.deepEqual(errors, [], `desk: the renderer logged errors — ${JSON.stringify(errors)}`);

  // View-all overlay: a long command must open INSIDE the main window with
  // highlighted tokens (not a second BrowserWindow of bare monospace).
  {
    const windowsBefore = app.windows().length;
    const longCmd = [
      "function Get-Status {",
      '  Write-Output "probe"',
      "  Get-ChildItem -Path C:\\work",
      "  if ($true) { return }",
      "}",
      'Write-Output "line 6"',
      'Write-Output "line 7"',
      'Write-Output "line 8"',
    ].join("\n");
    await hostMsg(page, { type: "appPurpose", value: "coding" });
    await hostMsg(page, { type: "expandCommandOutputs", value: true });
    await hostMsg(page, {
      type: "toolCall",
      call: {
        toolCallId: "desk-preview-cmd",
        kind: "execute",
        title: "Run Get-Status",
        rawInput: { variant: "Bash", command: longCmd, is_background: false },
      },
    });
    await hostMsg(page, { type: "messageChunk", text: "done" });
    await hostMsg(page, {
      type: "commandOutput",
      command: longCmd,
      output: "ok\n".repeat(8),
      exitCode: 0,
      truncated: false,
    });
    await page.waitForSelector(".command-view-all", { timeout: 15000 });
    await page.locator(".command-view-all").first().click();
    await page.waitForSelector("#preview-overlay", { timeout: 15000 });
    await page.waitForTimeout(300);
    await shot("desk-6-preview-overlay");
    assert.equal(
      app.windows().length,
      windowsBefore,
      "desk: View all must not open a new BrowserWindow",
    );
    const overlay = await page.evaluate(() => {
      const el = document.getElementById("preview-overlay");
      const token = el?.querySelector(".hl-kw, .hl-str, .hl-fn");
      const r = el?.getBoundingClientRect();
      const tr = token?.getBoundingClientRect();
      const cs = token ? getComputedStyle(token) : null;
      return {
        inside: !!el && el.getRootNode() === document,
        title: el?.querySelector(".preview-title")?.textContent || "",
        tokenTag: token?.tagName || "",
        tokenClass: token?.className || "",
        tokenColor: cs?.color || "",
        tokenW: tr ? Math.round(tr.width) : 0,
        tokenH: tr ? Math.round(tr.height) : 0,
        left: r ? Math.round(r.left) : null,
        right: r ? Math.round(r.right) : null,
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    assert.equal(overlay.inside, true, "desk: overlay must live in the main document");
    assert.ok(overlay.tokenTag, `desk: overlay has no highlighted token — ${JSON.stringify(overlay)}`);
    assert.ok(
      overlay.tokenW >= 4 && overlay.tokenH >= 6,
      `desk: highlighted token is unstyled/0x0 — ${JSON.stringify(overlay)}`,
    );
    assert.ok(
      overlay.tokenColor && overlay.tokenColor !== "rgba(0, 0, 0, 0)",
      `desk: highlighted token has no color — ${JSON.stringify(overlay)}`,
    );
    assert.ok(
      overlay.left >= 0 && overlay.right <= overlay.viewport + 1,
      `desk: overlay must stay inside the main window (${overlay.left}–${overlay.right} vs ${overlay.viewport})`,
    );
    assert.ok(
      overlay.pageWidth <= overlay.viewport + 1,
      `desk: View all must not make the page scroll horizontally (${overlay.pageWidth} > ${overlay.viewport})`,
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("preview-overlay"), { timeout: 5000 });
    log("preview overlay opened inside the main window with highlighted tokens");
  }

  // #92 — zoomed sidebar + expanded tool details + permission resolve.
  // After the visual frames so a rail collapse / resize cannot invalidate them.
  await assertPinnedAfterZoomedExpandedTurn(page, {
    log: (m) => log(m),
    shot: async (name) => {
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      log(`captured ${name}.png`);
    },
  });

  // The desktop app must have written a log somebody can actually retrieve.
  //
  // This runs the REAL startup path, which is the only thing that would have
  // caught what 3.19.2 shipped: `startFileLogging` was called from the
  // profile-resolution block while the `let` bindings it assigns still sat
  // below it in the file. Function declarations hoist, `let` does not, so the
  // assignment threw a temporal-dead-zone ReferenceError that the surrounding
  // catch swallowed. The app launched fine, no sink was installed, and Show
  // logs stayed a no-op. The unit tests passed throughout — they covered the
  // log-file helper in isolation, never this module's initialization order.
  const logFile = path.join(userData, "logs", "desktop.log");
  assert.ok(
    fs.existsSync(logFile),
    `the desktop app must write ${logFile} — Show logs has nothing to open without it`,
  );
  const logged = fs.readFileSync(logFile, "utf8");
  assert.ok(
    logged.includes("[desktop "),
    "the log file must carry the app's own lines, not just exist",
  );
  log(`log file written (${logged.length} bytes)`);

  log(`ALL CHECKS PASSED — frames in ${OUT}/`);
} finally {
  await app.close().catch(() => {});
  qa.cleanup();
  fs.rmSync(userData, { recursive: true, force: true });
}
