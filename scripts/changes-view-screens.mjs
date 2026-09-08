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
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const OUT = path.join(process.env.SCREENS_DIR || ".screens", "changes");
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(`[changes-screens] ${m}`);
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const chatCss = read("media", "chat.css");
const panelCss = read("media", "file-panel.css");
const panelJs = read("media", "file-panel.js");

// A trimmed VS Code palette plus the git decoration colours the change badges
// use. Values are VS Code's own defaults, not invented ones.
const DARK = {
  foreground: "#CCCCCC",
  descriptionForeground: "rgba(204,204,204,0.7)",
  "editor-background": "#1F1F1F",
  "editor-foreground": "#CCCCCC",
  "editorWidget-background": "#202020",
  "editorWidget-border": "#454545",
  "sideBar-background": "#181818",
  "sideBar-border": "#2B2B2B",
  "panel-border": "#2B2B2B",
  "widget-border": "#313131",
  "input-background": "#313131",
  "input-foreground": "#CCCCCC",
  "input-border": "#3C3C3C",
  "input-placeholderForeground": "#989898",
  focusBorder: "#0078D4",
  "button-background": "#0078D4",
  "button-foreground": "#FFFFFF",
  "button-hoverBackground": "#026EC1",
  "button-secondaryBackground": "#313131",
  "button-secondaryForeground": "#CCCCCC",
  "button-secondaryHoverBackground": "#3C3C3C",
  "list-hoverBackground": "#2A2D2E",
  "list-hoverForeground": "#CCCCCC",
  "list-activeSelectionBackground": "#04395E",
  "list-activeSelectionForeground": "#FFFFFF",
  "toolbar-hoverBackground": "#5A5D5E50",
  "activityBarBadge-background": "#0078D4",
  "activityBarBadge-foreground": "#FFFFFF",
  "textLink-foreground": "#4DAAFC",
  "textPreformat-foreground": "#D7BA7D",
  errorForeground: "#F85149",
  "editorWarning-foreground": "#CCA700",
  "charts-red": "#F14C4C",
  "charts-green": "#89D185",
  "charts-yellow": "#CCA700",
  "gitDecoration-modifiedResourceForeground": "#E2C08D",
  "gitDecoration-addedResourceForeground": "#81B88B",
  "gitDecoration-deletedResourceForeground": "#C74E39",
  "gitDecoration-renamedResourceForeground": "#73C991",
  "gitDecoration-untrackedResourceForeground": "#73C991",
  "gitDecoration-conflictingResourceForeground": "#E4676B",
  "editorGutter-addedBackground": "#2EA043",
  "editorGutter-deletedBackground": "#F85149",
  "diffEditor-insertedTextBackground": "#3FB95033",
  "diffEditor-removedTextBackground": "#F8514933",
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
  "sideBar-background": "#F8F8F8",
  "sideBar-border": "#E5E5E5",
  "panel-border": "#E5E5E5",
  "widget-border": "#E5E5E5",
  "input-background": "#FFFFFF",
  "input-border": "#CECECE",
  "input-foreground": "#3B3B3B",
  "input-placeholderForeground": "#767676",
  "button-secondaryBackground": "#E5E5E5",
  "button-secondaryForeground": "#3B3B3B",
  "button-secondaryHoverBackground": "#CCCCCC",
  "list-hoverBackground": "#E8E8E8",
  "list-hoverForeground": "#3B3B3B",
  "list-activeSelectionBackground": "#0060C0",
  "toolbar-hoverBackground": "#B8B8B850",
  "textLink-foreground": "#005FB8",
  "textPreformat-foreground": "#A31515",
  "editorWarning-foreground": "#BF8803",
  "gitDecoration-modifiedResourceForeground": "#895503",
  "gitDecoration-addedResourceForeground": "#587C0C",
  "gitDecoration-deletedResourceForeground": "#AD0707",
  "gitDecoration-renamedResourceForeground": "#007100",
  "gitDecoration-untrackedResourceForeground": "#007100",
  "gitDecoration-conflictingResourceForeground": "#AD0707",
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
  failure: {
    snapshot: snap({
      ahead: 1,
      unpushed: [{ sha: "9f2c1ab", subject: "Read git status without taking the index lock" }],
    }),
    failPush: {
      reason: "The push was rejected because the branch moved on the remote. Pull, then push again.",
      detail: "! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
    },
  },
};

const VIEWPORTS = {
  desk: { viewport: { width: 1440, height: 900 } },
  tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
  phone: {
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
};

// The cases where layout can genuinely break get the whole matrix; the rest are
// one frame each. Photographing thirteen states at three widths twice over is
// forty minutes of nobody looking at any of them.
const WIDE_MATRIX = new Set(["dirty", "diff", "dirtyAndUnpushed", "noRemote", "longPaths", "typed"]);

function pageHtml(theme) {
  const palette = theme === "light" ? LIGHT : DARK;
  const vars = Object.entries(palette).map(([k, v]) => `--vscode-${k}: ${v};`).join("\n");
  // The viewport meta is not decoration. Without it, mobile emulation lays the
  // page out at Chromium's 980px desktop fallback and scales the result down —
  // so `innerWidth` reads 980 on the "phone", every width media query resolves
  // to the desktop branch, and the panel docks into a right-hand column instead
  // of covering the screen. The frames look like a phone and measure like a
  // laptop. Same line web/chat.html carries.
  return `<!doctype html><html><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
    :root { ${vars} }
    html, body { margin: 0; height: 100%; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    ${chatCss}
    ${panelCss}
    /* The harness stands in for the app shell the panel docks into. */
    .app-main { display: flex; height: 100vh; align-items: stretch; }
    #chat-stack { flex: 1 1 auto; min-width: 0; }
    .harness-toggles { position: fixed; left: -9999px; top: 0; }
  </style></head><body class="${theme === "light" ? "vscode-light" : "vscode-dark"}">
    <div class="app-main">
      <div id="chat-stack"></div>
      <div id="file-panel-dock"></div>
    </div>
    <div class="harness-toggles"></div>
  </body></html>`;
}

async function mountCase(page, testCase, diffText) {
  await page.evaluate((c) => {
    const shared = window.GrokFilePanel;
    window.__lastRun = null;
    const access = {
      currentScope: async () => ({
        id: "/home/pawel/afkpilot", label: "afkpilot", title: "/home/pawel/afkpilot",
      }),
      list: async () => ({ ok: true, cwd: "/home/pawel/afkpilot", relPath: "", entries: [] }),
      read: async () => ({ ok: false, reason: "not used by this harness" }),
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
      },
      gitEnabled: () => true,
      initialOpen: true,
    });
  }, { snapshot: testCase.snapshot, patch: diffText, failPush: testCase.failPush || null });

  await page.waitForTimeout(150);
  // Enter the view the way a person does — by pressing the button.
  await page.click(".gfp-changes-btn");
  await page.waitForTimeout(200);
  if (testCase.message) {
    await page.fill(".gfp-changes-message", testCase.message);
    await page.waitForTimeout(80);
  }
  if (testCase.openDiff) {
    await page.click(`.gfp-change-row[data-path="${testCase.openDiff}"]`);
    await page.waitForTimeout(280);
  }
  if (typeof testCase.nameBranch === "string") {
    await page.click(".gfp-changes-secondary");
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
async function audit(page, label, touch) {
  return page.evaluate(({ label, touch }) => {
    const bad = [];
    const panel = document.getElementById("harness-panel");
    if (!panel) return [`${label}: the panel did not mount`];
    const changes = panel.querySelector(".gfp-changes");
    if (!changes || changes.hidden) return [`${label}: the Changes body is not showing`];

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
  }, { label, touch });
}

async function main() {
  const browser = await chromium.launch();
  const failures = [];
  let frames = 0;

  for (const [name, testCase] of Object.entries(CASES)) {
    for (const theme of ["dark", "light"]) {
      const viewports = WIDE_MATRIX.has(name) ? Object.keys(VIEWPORTS) : ["desk"];
      for (const vp of viewports) {
        const page = await browser.newPage(VIEWPORTS[vp]);
        await page.setContent(pageHtml(theme));
        await page.addScriptTag({ content: panelJs });
        await page.evaluate((v) => { window.__expectNotice = v; }, !!testCase.failPush);
        await mountCase(page, testCase, DIFF);
        await page.screenshot({ path: path.join(OUT, `${name}.${theme}.${vp}.png`) });
        frames += 1;
        failures.push(...await audit(page, `${name}/${theme}/${vp}`, vp !== "desk"));
        await page.close();
      }
    }
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
