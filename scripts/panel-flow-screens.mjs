// Viewing and editing a file, photographed as a SEQUENCE rather than as states.
//
// The Changes harness next door asks "does each state read?"; a state is a
// snapshot and a snapshot is easy to get right one at a time. This one asks the
// question that has actually cost us bugs: does the panel still make sense
// after you have done three things in a row? Every defect the tab strip has
// produced was ordinal — two tabs looking selected because Changes was entered
// AFTER a file was opened, a tab click coming back unselected because the paint
// ran before the mode changed, a close pressed from the tree opening an editor
// over the tree. None of them exist in any single state; all of them are
// visible in a filmstrip.
//
// So a case here is a list of steps, and every step is a frame. The frames land
// numbered, in order, in .screens/flow/ — read them like a strip. The
// assertions run after EVERY step, not at the end, because "it settles
// correctly" is exactly the excuse an ordinal bug hides behind.
//
// Honest about what it is: real component, real stylesheet, real layout engine,
// scripted host adapters. A host that answers something the adapter contract
// does not allow is test/file-panel.dom.test.ts's half of the job.
import { chromium } from "playwright";
import * as path from "node:path";
import { VIEWPORTS, outDir, pageHtml, readMedia } from "./lib/panel-harness.mjs";

const OUT = outDir("flow");
const log = (m) => console.log("[flow-screens] " + m);
const panelJs = readMedia("file-panel.js");

// Files the scripted host serves. Between them they cover every branch
// renderViewer has: a language file, markdown (which alone gets a
// preview/source segmented control), JSON, an image, and one that cannot be
// read at all.
const FILES = {
  "src/remote-uplink.ts": {
    kind: "text",
    text: [
      'import { WebSocket } from "ws";',
      "",
      "export interface UplinkOptions {",
      "  retryCeiling?: number;",
      "}",
      "",
      "export class RemoteUplink {",
      "  private socket: WebSocket | null = null;",
      "  private readonly url: string;",
      "",
      "  constructor(url: string, options: UplinkOptions = {}) {",
      "    this.url = url;",
      "    this.retryCeiling = options.retryCeiling ?? 30_000;",
      "  }",
      "",
      "  connect(): void {",
      "    this.socket = new WebSocket(this.url);",
      "    this.socket.onclose = () => {",
      "      this.socket = null;",
      "      this.scheduleReconnect();",
      "    };",
      "  }",
      "}",
    ].join("\n"),
  },
  "README.md": {
    kind: "markdown",
    text: [
      "# afkpilot",
      "",
      "Drive the extension from a phone. The relay ferries the host's own",
      "protocol; nothing about a prompt is ever written down.",
      "",
      "- One workspace, one phone",
      "- Payloads are ephemeral",
      "",
      "See [docs/architecture.md](docs/architecture.md).",
    ].join("\n"),
  },
  "package.json": {
    kind: "json",
    text: '{\n  "name": "afkpilot",\n  "version": "4.3.0"\n}',
  },
  "docs/architecture.md": { kind: "markdown", text: "# Architecture\n\nThe hub.\n" },
  "media/logo.png": {
    kind: "image",
    dataUrl:
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgZmlsbD0iIzM4N2VkOCIvPjwvc3ZnPg==",
  },
  "build/app.bin": { ok: false, reason: "This file is not text.", openExternal: true },
};

// The tree the panel browses. Enough shape that the root listing is a real
// listing rather than one row.
const ENTRIES = [
  { name: "docs", relPath: "docs", kind: "dir" },
  { name: "media", relPath: "media", kind: "dir" },
  { name: "src", relPath: "src", kind: "dir" },
  { name: "README.md", relPath: "README.md", kind: "file" },
  { name: "package.json", relPath: "package.json", kind: "file" },
];

// Each step is one frame. `body` is source run in the page against four verbs;
// `label` names what the reader is looking at and becomes the filename suffix,
// so a directory listing reads as prose.
const step = (label, body) => ({ label, body });

const FLOWS = {
  // The ordinary journey, start to finish. If any frame here looks wrong the
  // feature is wrong — there is no exotic trigger anywhere in it.
  openEditSave: {
    steps: [
      step("1-tree", null),
      step("2-viewing", 'await open("src/remote-uplink.ts")'),
      step("3-editing", 'await click(".gfp-edit")'),
      step("4-typed", 'await type(".gfp-editor", "\\n  // reconnect with a ceiling\\n")'),
      step("5-saved", 'await click(".gfp-save")'),
    ],
    viewports: ["desk", "tablet", "phone"],
  },
  // Markdown is the only kind with two ways to be looked at, so it is the only
  // one that can show the wrong one.
  markdown: {
    steps: [
      step("1-preview", 'await open("README.md")'),
      step("2-source", 'await click(".gfp-seg-btn.gfp-edit")'),
      step("3-typed", 'await type(".gfp-editor", "\\n\\nA line typed on a phone.\\n")'),
      step("4-back-to-preview", 'await click(".gfp-seg-btn:not(.gfp-edit)")'),
    ],
    viewports: ["desk", "phone"],
  },
  // The strip, exercised in the order that produced every strip defect so far.
  // Steps 3 and 6 are the regression: closing a file you are NOT looking at
  // must leave you exactly where you were.
  stripOrder: {
    steps: [
      step("1-three-open", 'await open("src/remote-uplink.ts"); await open("README.md"); await open("package.json")'),
      step("2-changes", 'await click(".gfp-changes-btn")'),
      step("3-close-from-changes", 'await closeTabNamed("package.json")'),
      step("4-back-to-a-file", 'await open("src/remote-uplink.ts")'),
      step("5-tree", 'await click(".gfp-title")'),
      step("5b-refresh-tree", 'await click(".gfp-filter-row > .gfp-refresh")'),
      step("6-close-from-tree", 'await closeTabNamed("README.md")'),
      step("7-back-to-the-file", 'await open("src/remote-uplink.ts")'),
      step("8-close-the-one-on-screen", 'await closeTabNamed("src/remote-uplink.ts")'),
    ],
    viewports: ["desk", "phone"],
  },
  // A dirty tab is the one case where something legitimately sits between a
  // filename and the X that closes it. Both spellings end up in frame 4.
  dirtyTab: {
    steps: [
      step("1-two-open", 'await open("src/remote-uplink.ts"); await open("README.md")'),
      step("2-editing", 'await click(".gfp-seg-btn.gfp-edit")'),
      step("3-dirty", 'await type(".gfp-editor", "typed")'),
      step("4-other-file", 'await open("src/remote-uplink.ts")'),
    ],
    viewports: ["desk", "phone"],
  },
  // The save that loses: somebody else wrote the file while you were typing.
  conflict: {
    steps: [
      step("1-editing", 'await open("src/remote-uplink.ts"); await click(".gfp-edit")'),
      step("2-typed", 'await type(".gfp-editor", "\\n// mine\\n")'),
      step("3-refused", 'await click(".gfp-save")'),
    ],
    writeFails: "changed",
    viewports: ["desk", "phone"],
  },
  // Not every file opens. The message is the content, under that file's own tab.
  unreadable: {
    steps: [
      step("1-binary", 'await open("build/app.bin")'),
      step("2-image", 'await open("media/logo.png")'),
    ],
    viewports: ["desk"],
  },
};

async function mount(page, flow) {
  await page.evaluate(({ files, entries, writeFails }) => {
    const shared = window.GrokFilePanel;
    const access = {
      currentScope: async () => ({
        id: "/home/pawel/afkpilot",
        label: "afkpilot",
        title: "/home/pawel/afkpilot",
      }),
      list: async (scopeId, relPath) => ({
        ok: true, cwd: "/home/pawel/afkpilot", relPath: relPath || "", entries,
      }),
      read: async (scopeId, relPath) => {
        const f = files[relPath];
        if (!f) return { ok: false, reason: "No such file." };
        if (f.ok === false) return f;
        return {
          ok: true,
          kind: f.kind,
          relPath,
          text: f.text,
          dataUrl: f.dataUrl,
          stamp: { mtimeMs: 1, size: (f.text || "").length },
          absPath: "/home/pawel/afkpilot/" + relPath,
        };
      },
      write: async () => (writeFails
        ? { ok: false, reason: writeFails }
        : { ok: true, stamp: { mtimeMs: 2, size: 1 } }),
      openExternal: async () => true,
      // Git is on only far enough for the Changes BUTTON to exist, because
      // stripOrder presses it. What the view then says is the other harness's
      // job, and duplicating it here would mean two places to keep true.
      gitStatus: async () => ({
        ok: true,
        snapshot: {
          branch: "main", detached: false, unborn: false, isDefaultBranch: true,
          hasRemote: true, hasUpstream: true, upstream: "origin/main",
          ahead: 0, behind: 0, files: [], unpushed: [], unpushedTruncated: false,
          conflicted: false,
        },
      }),
      gitDiff: async () => ({ ok: true, patch: "", truncated: false, untracked: false }),
      gitRun: async () => ({ ok: true }),
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
    // The four verbs a flow step is written in. They live in the page so a step
    // reads like the thing a person does rather than like Playwright.
    window.__open = (p) => window.__panel.openPath(p);
    window.__click = (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no such control: " + sel);
      el.click();
    };
    window.__type = (sel, text) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("nothing to type into: " + sel);
      el.focus();
      el.value = el.value + text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // Close a file BY NAME, wherever its X currently lives — on its own tab, or
    // in the … menu when the strip has demoted it. That "wherever" is the point:
    // a phone reaches the same control by a different route, and a flow written
    // against one route would silently stop testing the other.
    window.__closeTabNamed = async (rel) => {
      const own = document.querySelector('.gfp-tab[data-rel="' + CSS.escape(rel) + '"] .gfp-tab-close');
      if (own && own.offsetParent) return own.click();
      const chip = document.querySelector(".gfp-overflow-chip");
      if (!chip) throw new Error("no tab and no overflow chip for " + rel);
      chip.click();
      await new Promise((r) => setTimeout(r, 80));
      const leaf = rel.split("/").pop();
      const rows = [...document.querySelectorAll(".gfp-overflow-row")];
      const row = rows.find((r) => (r.textContent || "").includes(leaf));
      if (!row) throw new Error("not in the overflow menu: " + rel);
      row.querySelector(".gfp-overflow-close").click();
    };
  }, { files: FILES, entries: ENTRIES, writeFails: flow.writeFails || null });
  await page.waitForTimeout(220);
}

async function runStep(page, body) {
  if (!body) return;
  await page.evaluate(async (src) => {
    const run = new Function(
      "open", "click", "type", "closeTabNamed",
      "return (async () => { " + src + "; })();",
    );
    await run(window.__open, window.__click, window.__type, window.__closeTabNamed);
  }, body);
  await page.waitForTimeout(280);
}

// Assertions run after EVERY step. An ordinal defect is precisely one that a
// later step tidies away, so checking only the last frame checks nothing.
async function audit(page, label, touch) {
  return page.evaluate(({ label, touch }) => {
    const bad = [];
    const panel = document.getElementById("harness-panel");
    if (!panel) return [label + ": the panel did not mount"];
    const header = panel.querySelector(".gfp-header");
    if (!header) return [label + ": no header"];

    // 1. Exactly one selected thing in the strip — the folder, the Changes
    //    button, or one file. Written as a COUNT so it survives the treatment
    //    changing again; it has now changed three times.
    const lit = header.querySelectorAll(
      ".gfp-title-selected, .gfp-changes-selected, .gfp-tab-active",
    ).length;
    if (lit !== 1) bad.push(label + ": " + lit + " selected things in the strip, expected exactly 1");

    // 2. The strip agrees with the BODY. This is the closeTab class of defect:
    //    the folder stays underlined while an editor is on screen beneath it.
    const viewerEl = panel.querySelector(".gfp-viewer");
    const treeEl = panel.querySelector(".gfp-tree");
    const changesEl = panel.querySelector(".gfp-changes");
    const shows = changesEl && !changesEl.hidden ? "changes"
      : viewerEl && !viewerEl.hidden ? "viewer"
      : treeEl && !treeEl.hidden ? "tree"
      : "nothing";
    const says = header.querySelector(".gfp-changes-selected") ? "changes"
      : header.querySelector(".gfp-tab-active") ? "viewer"
      : "tree";
    if (says !== shows) bad.push(label + ": the strip says " + says + ", the body shows " + shows);

    const refreshes = panel.querySelectorAll(".gfp-refresh");
    if (refreshes.length !== 1 || header.querySelector(".gfp-refresh")) {
      bad.push(label + ": refresh must be one body control, never in the strip");
    }
    if (shows === "tree") {
      const row = panel.querySelector(".gfp-filter-row");
      const refresh = row?.querySelector(".gfp-refresh");
      const filter = row?.querySelector(".gfp-filter");
      if (!refresh?.offsetParent || !filter?.offsetParent) bad.push(label + ": tree filter/refresh missing");
      else {
        const r = refresh.getBoundingClientRect(), f = filter.getBoundingClientRect();
        if (r.left < f.right || Math.abs(r.right - row.getBoundingClientRect().right) > 1) {
          bad.push(label + ": refresh is not beside the filter at the right edge");
        }
      }
    } else if (refreshes[0]?.offsetParent) {
      bad.push(label + ": tree refresh is visible outside the tree");
    }
    const trailing = [...header.querySelectorAll(".gfp-maximize, .gfp-close")].filter((el) => el.offsetParent).at(-1);
    const edge = trailing?.getBoundingClientRect();
    const strip = header.getBoundingClientRect();
    if (!edge || edge.right > strip.right || strip.right - edge.right > 10) {
      bad.push(label + ": trailing controls are not pinned inside the strip");
    }

    // 3. Every tab that shows a name offers its own close, and that close sits
    //    beside the NAME rather than a slot away from it. 14px is the tab's own
    //    gap plus a hair; a dirty dot is allowed to spend the difference, and
    //    is the one thing entitled to sit between a name and its X.
    for (const tab of header.querySelectorAll(".gfp-tab")) {
      if (tab.hidden || tab.classList.contains("gfp-tab-icon-only")) continue;
      const close = tab.querySelector(".gfp-tab-close");
      const name = tab.querySelector(".gfp-tab-name");
      if (!close || !close.offsetParent) {
        bad.push(label + ": a named tab (" + tab.dataset.rel + ") has no visible close");
        continue;
      }
      const dirty = tab.querySelector(".gfp-tab-dirty");
      const isDirty = !!(dirty && (dirty.textContent || "").trim());
      // Glyph to glyph, NOT box to box. The boxes were 5px apart while the eye
      // saw 60, because the name's box is as wide as the tab's basis made it
      // and the close centres a 15px mark in a 36px touch target. A box
      // measurement passed the whole time the owner was looking at the gap.
      const range = document.createRange();
      range.selectNodeContents(name);
      const mark = close.querySelector("svg") || close;
      const gap = mark.getBoundingClientRect().left - range.getBoundingClientRect().right;
      const ceiling = isDirty ? 40 : 24;
      if (gap > ceiling) {
        bad.push(label + ": " + tab.dataset.rel + "'s close is " + Math.round(gap) + "px from the end of its name (max " + ceiling + ")");
      }
    }

    // 4. ONE idiom. With the underline as the selected treatment, no tab may
    //    also draw its own box — that hybrid is what the owner named.
    for (const tab of header.querySelectorAll(".gfp-tab")) {
      const cs = getComputedStyle(tab);
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        if (parseFloat(cs["border" + side + "Width"]) > 0) {
          bad.push(label + ": " + tab.dataset.rel + " draws a border on its " + side.toLowerCase() + " — underline and boxes at once");
        }
      }
    }

    // 5. Nothing scrolls sideways. A phone dragged left to read a line of code
    //    is fine INSIDE the code block, and never fine for the panel itself.
    for (const el of [panel, header, panel.querySelector(".gfp-viewer-head")]) {
      if (!el) continue;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible") {
        bad.push(label + ": " + el.className + " overflows sideways (" + el.scrollWidth + " > " + el.clientWidth + ")");
      }
    }

    // 6. Every control a finger has to hit clears 36px on a touch viewport.
    const controls = [...panel.querySelectorAll(".gfp-header button, .gfp-viewer-head button")];
    if (touch) {
      for (const btn of controls) {
        if (btn.hidden || !btn.offsetParent) continue;
        const r = btn.getBoundingClientRect();
        if (r.height < 35.5) {
          bad.push(label + ": " + btn.className + " is " + Math.round(r.width) + "x" + Math.round(r.height) + ", under the 36px touch floor");
        }
      }
    }

    // 7. Nothing on screen is a mystery to a screen reader.
    for (const btn of controls) {
      if (btn.hidden || !btn.offsetParent) continue;
      const named = (btn.textContent || "").trim() || btn.getAttribute("aria-label") || btn.title;
      if (!named) bad.push(label + ": an unnamed button (" + btn.className + ")");
    }

    // 8. An editor held read-only beside a live Save is the shape the conflict
    //    handling takes when it goes wrong: the button promises to write text
    //    the person can no longer change.
    const editor = panel.querySelector(".gfp-editor");
    const save = panel.querySelector(".gfp-save");
    if (editor && editor.readOnly && save && !save.disabled) {
      bad.push(label + ": the editor is read-only while Save is still live");
    }
    return bad;
  }, { label, touch });
}

async function main() {
  const browser = await chromium.launch();
  const failures = [];
  let frames = 0;

  for (const [name, flow] of Object.entries(FLOWS)) {
    for (const theme of ["dark", "light"]) {
      for (const vp of flow.viewports) {
        const page = await browser.newPage(VIEWPORTS[vp]);
        page.on("pageerror", (err) => {
          failures.push(name + "/" + theme + "/" + vp + ": the page threw — " + err.message);
        });
        await page.setContent(pageHtml(theme));
        await page.addScriptTag({ content: panelJs });
        await mount(page, flow);
        for (const s of flow.steps) {
          await runStep(page, s.body);
          await page.screenshot({
            path: path.join(OUT, name + "." + s.label + "." + theme + "." + vp + ".png"),
          });
          frames += 1;
          failures.push(...await audit(page, name + "/" + s.label + "/" + theme + "/" + vp, vp !== "desk"));
        }
        await page.close();
      }
    }
  }

  await browser.close();
  log(frames + " frames in " + OUT);
  if (failures.length) {
    for (const f of failures) console.error("[flow-screens] FAIL " + f);
    process.exit(1);
  }
  log("all assertions passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
