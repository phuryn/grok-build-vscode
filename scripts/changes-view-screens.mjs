// Does the Changes view actually READ, on every surface it ships to?
//
// The view is drawn by media/file-panel.js from a git snapshot, and every state
// it can be in is a different shape of that snapshot — a clean repo, a conflict,
// commits with nowhere to push. Reaching each of those through a real git
// repository is slow and, for conflicts and detached heads, fiddly; the states
// themselves are pure data. So this mounts the SHIPPED component with the
// SHIPPED CSS and feeds it scripted snapshots, then photographs the result at
// the viewports and both themes the product actually runs at.
//
// Honest about what it is: real component, real stylesheet, real layout engine —
// not a live host. What it cannot catch is a host that answers something the
// snapshot type does not allow. test/git-run.test.ts covers that half against
// real repositories.
//
// Frames land in .screens/changes/ for a person to look at. The assertions are
// the part that fails the build: touch targets, no horizontal overflow, and the
// diff using the product's own --tdiff-* palette rather than a second one.
import { chromium } from "playwright";
import * as path from "node:path";
import { DARK, LIGHT, VIEWPORTS, outDir, pageHtml, readMedia } from "./lib/panel-harness.mjs";

// The palette, the page shell and the viewports live in scripts/lib/panel-harness.mjs
// — shared with the viewer/editor harness, because two copies of a page shell is
// how one of them ends up photographing dark frames on a white page.
void DARK; void LIGHT;
const OUT = outDir("changes");
const log = (m) => console.log(`[changes-screens] ${m}`);
const panelJs = readMedia("file-panel.js");
const CHANGES_VIEWPORTS = {
  ...VIEWPORTS,
  narrowPhone: { viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true },
};

// Mirrors GitStatusSnapshot in src/git-status.ts. Every field, spelled the way
// the type spells it — see the note above about what drift costs.
const snap = (over) => ({
  branch: "main",
  detached: false,
  unborn: false,
  isDefaultBranch: true,
  hasRemote: true,
  hasUpstream: true,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  unpushed: [],
  unpushedTruncated: false,
  conflicted: false,
  ...over,
});

const file = (p, status, added, deleted, over = {}) => ({
  path: p, status, added, deleted, ...over,
});

const DIFF = [
  "diff --git a/src/remote-uplink.ts b/src/remote-uplink.ts",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src/remote-uplink.ts",
  "+++ b/src/remote-uplink.ts",
  "@@ -41,9 +41,12 @@ export class RemoteUplink {",
  "   private socket: WebSocket | null = null;",
  "   private readonly url: string;",
  " ",
  "-  constructor(url: string) {",
  "+  constructor(url: string, options: UplinkOptions = {}) {",
  "     this.url = url;",
  "+    this.retryCeiling = options.retryCeiling ?? 30_000;",
  "   }",
  " ",
  "   connect(): void {",
  "@@ -128,6 +131,7 @@ export class RemoteUplink {",
  "     this.socket.onclose = () => {",
  "       this.socket = null;",
  "+      this.scheduleReconnect();",
  "     };",
  "   }",
  " }",
  "",
].join("\n");

// Each entry is one photograph: a snapshot, and optionally a diff to open or a
// message already typed. Named for the question the frame answers.
const CASES = {
  clean: { snapshot: snap({}) },
  dirty: {
    snapshot: snap({
      files: [
        file("src/remote-uplink.ts", "M", 12, 3),
        file("media/chat.js", "M", 140, 26),
        file("src/git-run.ts", "A", 288, 0),
        file("src/legacy/poller.ts", "D", 0, 91),
        file("docs/architecture.md", "R", 4, 4, { origPath: "docs/design.md" }),
        // Untracked files carry null counts by design — counting them means
        // reading every one, and the number is a diff away.
        file("notes/scratch.md", "?", null, null),
      ],
    }),
  },
  dirtyAndUnpushed: {
    snapshot: snap({
      ahead: 2,
      files: [file("src/remote-uplink.ts", "M", 12, 3), file("src/git-run.ts", "A", 288, 0)],
      unpushed: [
        { sha: "9f2c1ab", subject: "Read git status without taking the index lock" },
        { sha: "3ce4402", subject: "Refuse a push when the repository has no remote" },
      ],
    }),
  },
  unpushedOnly: {
    snapshot: snap({
      ahead: 3,
      unpushed: [
        { sha: "9f2c1ab", subject: "Read git status without taking the index lock" },
        { sha: "3ce4402", subject: "Refuse a push when the repository has no remote" },
        { sha: "77b0d15", subject: "Plan every git write from the host's own snapshot" },
      ],
    }),
  },
  noRemote: {
    snapshot: snap({
      upstream: null,
      hasRemote: false,
      hasUpstream: false,
      behind: null,
      ahead: 4,
      unpushed: [
        { sha: "9f2c1ab", subject: "Read git status without taking the index lock" },
        { sha: "3ce4402", subject: "Refuse a push when the repository has no remote" },
        { sha: "77b0d15", subject: "Plan every git write from the host's own snapshot" },
        { sha: "5518cc0", subject: "Start the Changes view" },
      ],
    }),
  },
  noRemoteDirty: {
    snapshot: snap({ hasRemote: false, hasUpstream: false, upstream: null, behind: null,
      files: [file("docs/loremipsum.md", "?", null, null)] }),
  },
  // The strip with real tabs in it, at both ends of the rule: the Changes list
  // showing over three open files, and one of those files showing instead.
  tabsInChanges: {
    snapshot: snap({ files: [file("src/remote-uplink.ts", "M", 12, 3), file("media/chat.js", "M", 140, 26)] }),
    openFiles: ["src/remote-uplink.ts", "media/chat.js", "docs/architecture.md"],
  },
  tabsViewingFile: {
    snapshot: snap({ files: [file("src/remote-uplink.ts", "M", 12, 3)] }),
    openFiles: ["src/remote-uplink.ts", "media/chat.js", "docs/architecture.md"],
    viewFile: "media/chat.js",
  },
  conflicts: {
    snapshot: snap({
      conflicted: true,
      files: [
        file("src/protocol.ts", "U", 0, 0),
        file("media/chat.js", "U", 0, 0),
        file("src/git-run.ts", "M", 8, 1),
      ],
    }),
  },
  detached: {
    snapshot: snap({
      branch: null,
      upstream: null,
      hasUpstream: false,
      isDefaultBranch: false,
      detached: true,
      files: [file("src/remote-uplink.ts", "M", 12, 3)],
    }),
  },
  newBranch: {
    snapshot: snap({
      branch: "feature/changes-view",
      isDefaultBranch: false,
      hasUpstream: false,
      upstream: null,
      behind: null,
      ahead: 2,
      unpushed: [
        { sha: "9f2c1ab", subject: "Read git status without taking the index lock" },
        { sha: "3ce4402", subject: "Refuse a push when the repository has no remote" },
      ],
    }),
  },
  behind: {
    snapshot: snap({
      ahead: 1,
      behind: 4,
      unpushed: [{ sha: "9f2c1ab", subject: "Read git status without taking the index lock" }],
    }),
  },
  longPaths: {
    snapshot: snap({
      files: [
        file("packages/relay-transport/src/internal/reconnect/backoff-scheduler.ts", "M", 31, 12),
        file("apps/desktop/src/main/windows/preload/file-tree-bridge.ts", "M", 9, 2),
        file("a-single-very-long-unbroken-filename-with-no-separators-at-all.txt", "A", 1, 0),
      ],
    }),
  },
  typed: {
    snapshot: snap({ files: [file("src/remote-uplink.ts", "M", 12, 3)] }),
    message: "Reconnect the uplink with a bounded retry",
  },
  diff: {
    snapshot: snap({
      files: [file("src/remote-uplink.ts", "M", 12, 3), file("media/chat.js", "M", 140, 26)],
    }),
    openDiff: "src/remote-uplink.ts",
  },
  namingBranch: {
    snapshot: snap({ files: [file("src/remote-uplink.ts", "M", 12, 3)] }),
    message: "Reconnect the uplink with a bounded retry",
    nameBranch: "feature/bounded-retry",
  },
  badges: {
    snapshot: snap({ files: Array.from({ length: 12 }, (_, i) => file(`src/file-${i + 1}.ts`, "M", 1, 0)) }),
  },
  manyFiles: {
    snapshot: snap({ files: Array.from({ length: 100 }, (_, i) => file(`src/file-${i + 1}.ts`, "M", 1, 0)) }),
  },
  authFailure: {
    snapshot: snap({ ahead: 1 }),
    failPush: {
      reason: "Push needs GitHub. Connect it in Settings.",
      detail: "fatal: Authentication failed for 'https://github.com/example/project.git/'",
    },
  },
  branchPull: {
    snapshot: snap({ branch: "feature/reconcile-the-latest-remote-changes-with-local-work" }),
  },
  failure: {
    snapshot: snap({
      ahead: 1,
      unpushed: [{ sha: "9f2c1ab", subject: "Read git status without taking the index lock" }],
    }),
    failPush: {
      reason: "The remote has commits you do not have. Pull before pushing.",
      detail: "! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
    },
  },
};

// The cases where layout can genuinely break get the whole matrix; the rest are
// one frame each. Photographing thirteen states at three widths twice over is
// forty minutes of nobody looking at any of them.
const WIDE_MATRIX = new Set([
  "dirty", "diff", "dirtyAndUnpushed", "noRemote", "noRemoteDirty", "longPaths", "typed",
  "tabsInChanges", "tabsViewingFile", "badges", "authFailure", "failure", "branchPull",
]);

async function mountCase(page, testCase, diffText) {
  await page.evaluate((c) => {
    const shared = window.GrokFilePanel;
    window.__lastRun = null;
    const access = {
      currentScope: async () => ({
        id: "/home/pawel/afkpilot", label: "afkpilot", title: "/home/pawel/afkpilot",
      }),
      list: async () => ({ ok: true, cwd: "/home/pawel/afkpilot", relPath: "", entries: [] }),
      read: async (scopeId, relPath) => ({
        ok: true, kind: "text", relPath, text: "one two three",
        stamp: { mtimeMs: 1, size: 14 }, absPath: "/home/pawel/afkpilot/" + relPath,
      }),
      gitStatus: async () => ({ ok: true, snapshot: c.snapshot }),
      gitDiff: async () => ({ ok: true, patch: c.patch, truncated: false, untracked: false }),
      gitRun: async (scopeId, request) => {
        window.__lastRun = request;
        if (c.failPush) {
          return { ok: false, reason: c.failPush.reason, detail: c.failPush.detail, snapshot: c.snapshot };
        }
        return { ok: true, snapshot: c.snapshot };
      },
    };
    window.__panel = shared.createFilePanel({
      access,
      mount: {
        panelHost: document.querySelector(".app-main"),
        dockHost: document.getElementById("file-panel-dock"),
        widthPeer: document.getElementById("chat-stack"),
        toggleHost: document.querySelector(".harness-toggles"),
        presentation: "responsive",
        id: "harness-panel",
        maximize: true,
      },
      ui: {
        confirm: async (request) => (request.actions && request.actions[0] ? request.actions[0].id : "cancel"),
        renderMarkdown: (s) => "<pre>" + s + "</pre>",
        askAgent: (text) => { window.__askedAgent = text; },
        openSettings: () => { window.__openedSettings = true; },
      },
      gitEnabled: () => true,
      initialOpen: true,
    });
  }, { snapshot: testCase.snapshot, patch: diffText, failPush: testCase.failPush || null });

  await page.waitForTimeout(150);
  // Files open BEFORE entering Changes, because that is the order that used to
  // leave two tabs looking selected at once.
  for (const relPath of testCase.openFiles || []) {
    await page.evaluate((p) => window.__panel.openPath(p), relPath);
    await page.waitForTimeout(80);
  }
  // Enter the view the way a person does — by pressing the button.
  await page.click(".gfp-changes-btn");
  await page.waitForTimeout(200);
  if (testCase.viewFile) {
    // Back out to a file, to photograph the other end of the same rule.
    // Through the panel API rather than a tab click: at phone width the tab
    // is in the overflow menu, and the route is the same `activateTab`.
    await page.evaluate((p) => window.__panel.openPath(p), testCase.viewFile);
    await page.waitForTimeout(200);
  }
  if (testCase.message) {
    await page.fill(".gfp-changes-message", testCase.message);
    await page.waitForTimeout(80);
  }
  if (testCase.openDiff) {
    await page.click(`.gfp-change-row[data-path="${testCase.openDiff}"]`);
    await page.waitForTimeout(280);
  }
  if (typeof testCase.nameBranch === "string") {
    await page.click(".gfp-changes-move-branch");
    await page.waitForTimeout(120);
    await page.fill(".gfp-changes-branch-input", testCase.nameBranch);
    await page.waitForTimeout(80);
  }
  if (testCase.failPush) {
    await page.click(".gfp-changes-primary");
    await page.waitForTimeout(280);
  }
}

// The assertions. Each is a rule the product already holds itself to elsewhere,
// applied to the new surface.
async function audit(page, label, touch, viewer) {
  return page.evaluate(({ label, touch, viewer }) => {
    const bad = [];
    const panel = document.getElementById("harness-panel");
    if (!panel) return [`${label}: the panel did not mount`];

    // 0. ONE selected thing in the strip. The folder, the Changes button and
    //    the open files share one row and used to answer "where am I" three
    //    different ways — entering Changes underlined its button and left the
    //    last file wearing the active treatment too. A count, not a look, so
    //    it holds whatever the selected treatment becomes.
    const header = panel.querySelector(".gfp-header");
    if (!header) bad.push(`${label}: no header`);
    else {
      const lit = header.querySelectorAll(
        ".gfp-title-selected, .gfp-changes-selected, .gfp-tab-active",
      ).length;
      if (lit !== 1) bad.push(`${label}: ${lit} selected things in the strip, expected exactly 1`);
      // Every tab that shows its name offers its own close — the phone case,
      // where opening a file to shut it is the whole cost.
      for (const tab of header.querySelectorAll(".gfp-tab")) {
        if (tab.hidden || tab.classList.contains("gfp-tab-icon-only")) continue;
        const close = tab.querySelector(".gfp-tab-close");
        if (!close || !close.offsetParent) {
          bad.push(`${label}: a named tab (${tab.dataset.rel}) has no visible close`);
        }
      }
    }

    const changes = panel.querySelector(".gfp-changes");
    if (viewer) return bad;
    if (!changes || changes.hidden) return bad.concat([`${label}: the Changes body is not showing`]);

    // Typing clears one hint and keeps another (the no-remote explanation).
    // The box and buttons must hold still at phone AND desk widths, and the
    // longer sentence must grow naturally instead of overflowing a fixed slot.
    const message = changes.querySelector(".gfp-changes-message");
    const hint = changes.querySelector(".gfp-changes-hint");
    if (message && hint) {
      if (hint.nextElementSibling !== message) bad.push(`${label}: hint is not above the message`);
      const button = changes.querySelector(".gfp-changes-primary");
      const before = [message.getBoundingClientRect().top, button.getBoundingClientRect().top];
      const text = message.value;
      message.value = text ? "" : "Describe the change";
      message.dispatchEvent(new Event("input", { bubbles: true }));
      const after = [message.getBoundingClientRect().top, button.getBoundingClientRect().top];
      if (before.some((y, i) => Math.abs(y - after[i]) > 0.5)) bad.push(`${label}: typing shifts the commit controls`);
      message.value = text;
      message.dispatchEvent(new Event("input", { bubbles: true }));
      if (hint.scrollHeight > hint.clientHeight + 1) bad.push(`${label}: hint text is clipped`);
      if (getComputedStyle(hint).minHeight === "0px") bad.push(`${label}: hint reserves no height`);
    }

    // 1. Nothing scrolls sideways. A phone that has to be dragged left to read
    //    a filename is the commonest way a panel like this fails.
    const boxes = [changes, ...changes.querySelectorAll(
      ".gfp-changes-list, .gfp-changes-commits, .gfp-changes-actions, .gfp-change-row, .gfp-changes-headline",
    )];
    for (const el of boxes) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible") {
        bad.push(`${label}: ${el.className} overflows sideways (${el.scrollWidth} > ${el.clientWidth})`);
      }
    }

    // Commit choices stay side by side, inside their row, at 320px too.
    const actionRow = changes.querySelector(".gfp-changes-action-row");
    if (actionRow) {
      const r = actionRow.getBoundingClientRect();
      const buttons = [...actionRow.querySelectorAll("button")];
      const primary = actionRow.querySelector(".gfp-changes-primary").getBoundingClientRect();
      const only = actionRow.querySelector(".gfp-changes-commit-only");
      for (const btn of buttons) {
        const b = btn.getBoundingClientRect();
        if (b.left < r.left - 1 || b.right > r.right + 1 || btn.scrollWidth > btn.clientWidth + 1) {
          bad.push(`${label}: ${btn.className} is clipped in its action row`);
        }
      }
      if (only) {
        const secondary = only.getBoundingClientRect();
        if (buttons.length !== 2 || Math.abs(primary.top - secondary.top) > 1 || secondary.right > primary.left) {
          bad.push(`${label}: commit choices are not side by side`);
        }
        if (primary.width + 1 < secondary.width) bad.push(`${label}: primary is narrower than Commit`);
      } else if (Math.abs(primary.width - r.width) > 1) {
        bad.push(`${label}: lone primary does not fill the row`);
      }
    }
    if (header.querySelector(".gfp-refresh") || changes.querySelector(".gfp-refresh")) {
      bad.push(`${label}: refresh must stay in the tree filter`);
    }
    const title = header.querySelector(".gfp-title");
    const branchName = changes.querySelector(".gfp-changes-branch-name");
    if (title && branchName && getComputedStyle(title).color !== getComputedStyle(branchName).color) {
      bad.push(`${label}: idle project title is not muted like the branch context`);
    }
    if (title && getComputedStyle(title).fontWeight !== "400") bad.push(`${label}: project title is bold`);
    // Badge dimensions are real layout, including the smaller toggle corner.
    for (const [selector, size] of [[".gfp-changes-count", 18], [".gfp-toggle-count", 14]]) {
      const badge = document.querySelector(selector);
      if (!badge || badge.hidden) continue;
      const r = badge.getBoundingClientRect();
      if (Math.abs(r.height - size) > 0.5 || (badge.textContent.length <= 2 && Math.abs(r.width - size) > 0.5)) {
        bad.push(`${label}: ${selector} is not a ${size}px circle (${r.width}x${r.height})`);
      }
      if (badge.scrollWidth > badge.clientWidth + 1) bad.push(`${label}: badge text is clipped`);
      if (selector === ".gfp-toggle-count") {
        const glyph = badge.parentElement.querySelector("svg").getBoundingClientRect();
        if (r.top >= glyph.top || r.right <= glyph.right) bad.push(`${label}: toggle badge does not overhang its glyph`);
        if (getComputedStyle(badge.parentElement).overflow !== "visible") bad.push(`${label}: toggle clips its badge`);
      }
    }

    const branchPull = changes.querySelector(".gfp-changes-ask-pull");
    if (branchPull) {
      const b = branchPull.getBoundingClientRect();
      const row = branchPull.parentElement.getBoundingClientRect();
      const name = changes.querySelector(".gfp-changes-branch-name").getBoundingClientRect();
      if (b.left < row.left || b.right > row.right + 1 || name.right > b.left || branchPull.scrollWidth > branchPull.clientWidth + 1) {
        bad.push(`${label}: branch pull button is clipped or overlaps the branch name`);
      }
      if (Math.abs(b.right - row.right) > 1) bad.push(`${label}: branch pull button is not at the right edge`);
    }
    const noticeText = changes.querySelector(".gfp-changes-notice-text")?.textContent;
    const action = changes.querySelector(".gfp-changes-notice-action");
    if (noticeText === "The remote has commits you do not have. Pull before pushing."
      && action?.textContent !== "Ask the agent to pull") bad.push(`${label}: rejected push has no pull action`);
    if (noticeText === "Push needs GitHub. Connect it in Settings."
      && action?.textContent !== "Connect GitHub") bad.push(`${label}: GitHub notice has no Settings action`);
    if (action && action.scrollWidth > action.clientWidth + 1) bad.push(`${label}: notice action is clipped`);

    // 2. Every control a finger has to hit clears 36px on a touch viewport.
    if (touch) {
      for (const btn of changes.querySelectorAll("button")) {
        if (btn.hidden || !btn.offsetParent) continue;
        const r = btn.getBoundingClientRect();
        if (r.height < 35.5) {
          bad.push(`${label}: ${btn.className} is ${Math.round(r.width)}x${Math.round(r.height)}, under the 36px touch floor`);
        }
      }
    }

    // 3. The headline is the one sentence the view exists to say. It must have
    //    a colour, and not the colour of what is behind it.
    const headline = changes.querySelector(".gfp-changes-headline");
    if (headline) {
      const fg = getComputedStyle(headline).color;
      if (fg === "rgba(0, 0, 0, 0)") bad.push(`${label}: the headline has no colour`);
      if (!(headline.textContent || "").trim()) bad.push(`${label}: the headline is empty`);
    }

    // 4. The diff uses the PRODUCT's diff palette, not a second one invented for
    //    this view. The design-token rule with teeth: if somebody later writes
    //    .gfp-diff-add with its own green, this fails.
    const region = changes.querySelector(".tool-diff-region");
    if (region) {
      const add = region.querySelector(".tdl-add");
      const del = region.querySelector(".tdl-del");
      const tokenBg = getComputedStyle(document.documentElement).getPropertyValue("--tdiff-add-bg").trim();
      if (!tokenBg) bad.push(`${label}: --tdiff-add-bg is undefined, so the diff is off the shared palette`);
      if (!add || !del) bad.push(`${label}: the diff rendered without add/del rows`);
      else {
        if (getComputedStyle(add).backgroundColor === "rgba(0, 0, 0, 0)") bad.push(`${label}: added lines have no tint`);
        if (getComputedStyle(del).backgroundColor === "rgba(0, 0, 0, 0)") bad.push(`${label}: removed lines have no tint`);
      }
      if (region.scrollWidth > region.clientWidth + 1 && getComputedStyle(region).overflowX === "visible") {
        bad.push(`${label}: the diff is wider than its box and does not scroll`);
      }
    }

    // 5. A run that failed says so. The frame that exists to show the failure
    //    path is worthless if the click silently did nothing, which is exactly
    //    what a wrong confirm adapter produced.
    if (window.__expectNotice && !changes.querySelector(".gfp-changes-notice")) {
      bad.push(`${label}: the operation failed but no notice is on screen`);
    }

    // 6. One primary action a person can actually press. The design of the
    //    view is that there is exactly one obvious next thing to do — a
    //    disabled button is not competing for it, a second live one is.
    const live = [...changes.querySelectorAll(".gfp-changes-primary")]
      .filter((b) => !b.disabled && b.offsetParent);
    if (live.length > 1) {
      bad.push(`${label}: ${live.length} live primary actions (${live.map((b) => b.textContent).join(" / ")})`);
    }

    // 7. No control is a mystery to a screen reader.
    for (const btn of changes.querySelectorAll("button")) {
      if (btn.hidden || !btn.offsetParent) continue;
      const named = (btn.textContent || "").trim() || btn.getAttribute("aria-label") || btn.title;
      if (!named) bad.push(`${label}: an unnamed button (${btn.className})`);
    }
    return bad;
  }, { label, touch, viewer });
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const failures = [];
  let frames = 0;

  for (const [name, testCase] of Object.entries(CASES)) {
    for (const theme of ["dark", "light"]) {
      const viewports = WIDE_MATRIX.has(name) ? Object.keys(CHANGES_VIEWPORTS) : ["desk"];
      for (const vp of viewports) {
        const page = await browser.newPage(CHANGES_VIEWPORTS[vp]);
        await page.setContent(pageHtml(theme));
        await page.addScriptTag({ content: panelJs });
        await page.evaluate((v) => { window.__expectNotice = v; }, !!testCase.failPush);
        await mountCase(page, testCase, DIFF);
        // Mode changes can move the title under the pointer that clicked
        // Changes. Photograph idle treatment, not an accidental hover.
        await page.mouse.move(0, CHANGES_VIEWPORTS[vp].viewport.height - 1);
        if (name === "badges" && vp === "desk") {
          // Place the real toggle beside the dock for a review frame containing
          // both badge sizes. The harness's otherwise empty chat has no toolbar.
          await page.evaluate(() => {
            const panel = document.getElementById("harness-panel").getBoundingClientRect();
            Object.assign(document.querySelector(".harness-toggles").style, {
              left: `${panel.left - 48}px`, top: "12px",
            });
          });
          const panel = await page.locator("#harness-panel").boundingBox();
          await page.screenshot({
            path: path.join(OUT, `badges.${theme}.desk.controls.png`),
            clip: { x: panel.x - 52, y: 0, width: panel.width + 52, height: 80 },
          });
          frames += 1;
        }
        await page.screenshot({ path: path.join(OUT, `${name}.${theme}.${vp}.png`) });
        frames += 1;
        failures.push(...await audit(page, `${name}/${theme}/${vp}`, vp !== "desk", !!testCase.viewFile));
        await page.close();
      }
    }
  }

  // The project marks use a separate renderer in the IDE sidebar. Photograph
  // its shipped markup/CSS together so open and closed read at the same scale.
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 340, height: 360 }, deviceScaleFactor: 2 });
    const palette = theme === "light" ? LIGHT : DARK;
    const vars = Object.entries(palette).map(([k, v]) => `--vscode-${k}:${v};`).join("\n");
    await page.setContent(`<!doctype html><html><head><style>:root { ${vars} }
      ${readMedia("projects-rail.css")}</style></head><body class="vscode-${theme}">
      <aside id="projects-rail" class="projects-rail" aria-label="Projects">
        <div class="rail-search-wrap"><input id="rail-search" class="rail-search" type="search" placeholder="Search conversations" /></div>
        <div id="rail-scroll" class="rail-scroll"></div>
      </aside></body></html>`);
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} });
    });
    await page.addScriptTag({ content: readMedia("projects-rail.js") });
    await page.evaluate(() => {
      const send = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
      send({ type: "repos", selectedCwd: "/work/alpha", activeCwd: "/work/alpha", entries: [
        { cwd: "/work/alpha", label: "alpha", available: true, updatedAt: 2, color: "blue" },
        { cwd: "/work/beta", label: "beta", available: true, updatedAt: 1, color: "amber" },
      ] });
      send({ type: "sessions", entries: [
        { id: "one", cwd: "/work/alpha", displayName: "Refine the Changes view", updatedAt: 2, createdAt: 1, numMessages: 2 },
      ], activeId: "one", dots: {}, offset: 0, total: 1, hasMore: false, nextOffset: 1, query: "" });
      const beta = [...document.querySelectorAll(".rail-repo")].find(
        (el) => el.querySelector(".rail-repo-label")?.textContent === "beta",
      );
      if (beta?.dataset.expanded === "1") beta.querySelector(".rail-repo-head").click();
    });
    failures.push(...await page.evaluate((theme) => {
      const bad = [];
      const marks = [...document.querySelectorAll(".rail-repo .rail-twisty svg")];
      const open = marks.find((m) => m.querySelector("path")?.getAttribute("d").startsWith("m6 14 1.5-2.9"));
      const closed = marks.find((m) => m.querySelector("path")?.getAttribute("d").startsWith("M20 20a2 2"));
      if (!open || !closed) return [`projects/${theme}: missing open/closed project pair`];
      for (const mark of [open, closed]) {
        const r = mark.getBoundingClientRect();
        if (r.width < 14 || r.height < 14 || mark.getAttribute("fill") !== "none" || mark.getAttribute("stroke") !== "currentColor") {
          bad.push(`projects/${theme}: project mark is not a visible outline at rail scale`);
        }
      }
      return bad;
    }, theme));
    await page.screenshot({ path: path.join(OUT, `projects.${theme}.desk.png`) });
    frames += 1;
    await page.close();
  }
  await browser.close();
  log(`${frames} frames in ${OUT}`);
  if (failures.length) {
    for (const f of failures) console.error(`[changes-screens] FAIL ${f}`);
    process.exit(1);
  }
  log("all assertions passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
