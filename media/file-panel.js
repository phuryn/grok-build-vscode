(function (root) {
  "use strict";

  const DEFAULT_WIDTH = 280;
  const MIN_WIDTH = 200;
  const MIN_CHAT_WIDTH = 280;
  const MOBILE_BREAKPOINT = 640;
  const EDITABLE_KINDS = new Set(["markdown", "json", "text"]);
  // Shared Seti lookup data. Hosts provide only a URL rooted in their own
  // scheme; the component chooses the asset and the browser lazily loads icons
  // that actually appear on screen. This keeps Node work and SVG/data-URL
  // payloads out of both the Electron injection and the phone round trip.
  const FILE_ICON_BY_NAME = {
    "package.json": "npm", "package-lock.json": "npm", "yarn.lock": "yarn",
    "pnpm-lock.yaml": "yarn", "cargo.toml": "rust", "cargo.lock": "lock",
    "go.mod": "go", "go.sum": "go", gemfile: "ruby", "gemfile.lock": "lock",
    dockerfile: "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker",
    "compose.yml": "docker", "compose.yaml": "docker", makefile: "config",
    "cmakelists.txt": "config", "tsconfig.json": "typescript", "jsconfig.json": "javascript",
    ".gitignore": "git_ignore", ".gitattributes": "git", ".gitmodules": "git",
    ".editorconfig": "editorconfig", ".eslintrc": "config", ".eslintrc.js": "javascript",
    ".eslintrc.cjs": "javascript", ".eslintrc.json": "json", ".prettierrc": "config",
    ".prettierrc.js": "javascript", ".prettierrc.json": "json", ".env": "config",
    ".env.local": "config", ".env.development": "config", ".env.production": "config",
    license: "license", "license.md": "license", "license.txt": "license",
    "readme.md": "markdown", readme: "markdown", "changelog.md": "markdown",
  };
  const FILE_ICON_BY_SUFFIX = {
    ".d.ts": "typescript", ".test.ts": "typescript", ".spec.ts": "typescript",
    ".test.tsx": "react", ".spec.tsx": "react", ".test.js": "javascript",
    ".spec.js": "javascript", ".test.jsx": "react", ".spec.jsx": "react",
    ".module.css": "css", ".module.scss": "sass", ".module.sass": "sass",
  };
  const FILE_ICON_BY_EXTENSION = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react",
    ts: "typescript", tsx: "react", json: "json", jsonc: "json", css: "css",
    scss: "sass", sass: "sass", less: "less", styl: "stylus", html: "html",
    htm: "html", xhtml: "html", vue: "vue", svelte: "svelte", md: "markdown",
    mdx: "markdown", markdown: "markdown", yml: "yml", yaml: "yml", xml: "xml",
    svg: "svg", png: "image", jpg: "image", jpeg: "image", gif: "image",
    webp: "image", ico: "image", bmp: "image", avif: "image", py: "python",
    pyi: "python", pyw: "python", go: "go", rs: "rust", java: "java", jar: "java",
    kt: "kotlin", kts: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp",
    cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "c-sharp", fs: "f-sharp",
    fsx: "f-sharp", rb: "ruby", erb: "ruby", php: "php", swift: "swift",
    lua: "lua", ps1: "powershell", psm1: "powershell", psd1: "powershell",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", bat: "shell",
    cmd: "shell", pdf: "pdf", zip: "zip", gz: "zip", tgz: "zip", "7z": "zip",
    rar: "zip", tar: "zip", mp4: "video", webm: "video", mov: "video",
    avi: "video", mkv: "video", mp3: "audio", wav: "audio", ogg: "audio",
    flac: "audio", ttf: "font", otf: "font", woff: "font", woff2: "font",
    eot: "font", graphql: "graphql", gql: "graphql", prisma: "prisma", sql: "db",
    db: "db", sqlite: "db", sqlite3: "db", toml: "config", ini: "config",
    cfg: "config", conf: "config", env: "config", lock: "lock", ipynb: "notebook",
    hex: "hex", ex: "elixir", exs: "elixir", clj: "clojure", cljs: "clojure",
    cljc: "clojure", dart: "dart", elm: "elm", hs: "haskell", lhs: "haskell",
    ml: "ocaml", mli: "ocaml", asm: "asm", s: "asm", nim: "nim", zig: "zig",
    cr: "crystal", vala: "vala", d: "d", tf: "terraform", tfvars: "terraform",
    hcl: "terraform", bicep: "bicep", res: "rescript", resi: "rescript",
    re: "reasonml", rei: "reasonml", ejs: "ejs", pug: "pug", jade: "pug",
    hbs: "mustache", mustache: "mustache", docx: "word", doc: "word", rtf: "word",
    babelrc: "babel", gitignore: "git_ignore",
  };
  const MONOCHROME_FILE_ICONS = new Set([
    "asm", "audio", "babel", "c", "clock", "clojure", "d", "dart", "db", "default",
    "editorconfig", "f-sharp", "font", "haskell", "lock", "lua", "ocaml", "pdf", "pug",
    "reasonml", "rust", "settings", "svelte", "svg", "swift", "vala", "video", "vue",
    "word", "yarn",
  ]);

  function defaultFileIconId(kind, name) {
    if (kind === "dir") return "folder";
    const lower = String(name || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
    if (FILE_ICON_BY_NAME[lower]) return FILE_ICON_BY_NAME[lower];
    for (const suffix of Object.keys(FILE_ICON_BY_SUFFIX)) {
      if (lower.endsWith(suffix)) return FILE_ICON_BY_SUFFIX[suffix];
    }
    const dot = lower.lastIndexOf(".");
    const extension = dot >= 0 ? lower.slice(dot + 1) : "";
    if (extension && FILE_ICON_BY_EXTENSION[extension]) return FILE_ICON_BY_EXTENSION[extension];
    if (lower.startsWith(".") && dot === 0) return "config";
    return "default";
  }

  function fileName(relPath) {
    const parts = String(relPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(relPath || "") || "untitled";
  }

  /**
   * Workspace-relative form for "Copy relative path". Listings always use `/`
   * (`file-tree` `childRel`); keep that, including on a Windows desk — it is
   * what the composer and grok accept, and it is what the tree already shows.
   */
  function relativeCopyPath(relPath) {
    return String(relPath || "").replace(/\\/g, "/");
  }

  /**
   * Filesystem root of a panel scope. Production mounts put the host cwd in
   * `id` (desktop `value.root`, remote `cwd`) and the same path in `title`.
   * Tests may use a synthetic id and keep the real root in `title`.
   */
  function scopeCwd(scope) {
    if (!scope) return "";
    const id = String(scope.id || "");
    const title = String(scope.title || "");
    if (/[\\/]/.test(id)) return id;
    if (/[\\/]/.test(title)) return title;
    return id || title;
  }

  /**
   * Join a host cwd to a workspace-relative path using the **desk's** separator.
   * A phone client must not invent `/` just because it is POSIX: a backslash
   * anywhere in `cwd` means the desk is Windows (`C:\repo\src\foo.ts`, never
   * `C:\repo/src/foo.ts`).
   */
  function joinHostPath(root, relPath) {
    const cwd = String(root || "");
    const parts = String(relPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    if (!parts.length) return cwd;
    const sep = cwd.includes("\\") ? "\\" : "/";
    const base = cwd.replace(/[\\/]+$/, "");
    const tail = parts.join(sep);
    if (!base) return sep + tail;
    return base + sep + tail;
  }

  function scopeKey(scopeId, relPath) {
    return String(scopeId || "") + "\0" + String(relPath || "");
  }

  function makeScopeState(scope) {
    return {
      scope,
      tabs: new Map(),
      order: [],
      activeRelPath: null,
      tree: null,
      rootLoad: null,
      // Per-scope, because the panel element is shared: a refresh left running
      // on the project you just left must not dim or freeze the one you
      // switched to.
      refreshing: false,
      filter: "",
    };
  }

  function makeTab(scopeId, result) {
    const text = typeof result.text === "string" ? result.text : "";
    return {
      key: scopeKey(scopeId, result.relPath),
      scopeId,
      relPath: result.relPath,
      kind: result.kind,
      dataUrl: result.dataUrl,
      pretty: !!result.pretty,
      baselineText: text,
      draftText: text,
      stamp: result.stamp,
      // The identity belongs to the file that was opened. Overwrite may refresh
      // its version stamp, but never adopts a different absolute target.
      expectedAbsPath: result.absPath,
      mode: result.kind === "markdown" ? "preview" : "read",
      editing: false,
      dirty: false,
      saving: false,
      sentText: null,
      conflict: false,
      notice: "",
      readSeq: 0,
      saveSeq: 0,
      error: "",
    };
  }

  /**
   * A tab for a file that could not be opened.
   *
   * The error used to be painted over the tree instead: no tab, so nothing
   * named the file that had failed, and the tree's filter box stayed on screen
   * above a message about a file you could no longer see. Giving the failure a
   * tab makes it behave like every other open file — it says which file, it can
   * be left open while you look at something else, and it closes the same way.
   */
  function makeErrorTab(scopeId, relPath, reason) {
    return {
      ...makeTab(scopeId, { relPath, kind: "error", text: "" }),
      error: reason || "Could not open file.",
    };
  }

  function applyDraft(tab, text) {
    tab.draftText = String(text);
    tab.dirty = tab.draftText !== tab.baselineText;
    return tab;
  }

  function applySaveSuccess(tab, sentText, result) {
    // The remote editor learned this the hard way: the textarea remains live
    // while Save is in flight. Only the captured payload reached the host.
    tab.baselineText = sentText;
    tab.stamp = result.stamp;
    tab.sentText = null;
    tab.saving = false;
    tab.conflict = false;
    tab.dirty = tab.draftText !== sentText;
    // Saving does not mean "I am finished with this file". Dropping out of edit
    // mode on every successful save meant a save mid-thought threw you back to
    // the read view and you had to click Edit again to carry on — for the very
    // common case of saving as you work. You leave editing by asking to.
    tab.editing = true;
    tab.notice = tab.dirty ? "Saved — you have typed more since." : "Saved.";
    return tab;
  }

  function anyDirty(scopes) {
    for (const state of scopes.values()) {
      for (const tab of state.tabs.values()) if (tab.dirty) return true;
    }
    return false;
  }

  function defaultConfirm(request) {
    const primary = request.actions && request.actions[0];
    const ok = typeof root.confirm === "function"
      ? root.confirm(request.title + "\n\n" + request.body)
      : false;
    return Promise.resolve(ok && primary ? primary.id : "cancel");
  }

  function panelIcon(side) {
    const x = side === "left" ? 9 : 15;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M' + x + ' 3v18"/></svg>';
  }

  // Title-strip shrink. Named states (not raw widths) so CSS and tests share
  // one decision. Compact / extreme only shrink the PROJECT TITLE now — tabs
  // are planned by `planStrip` (A named / B icon-only inactive / C chip).
  // Breakpoints are against the panel's own width. No tabs → neither class.
  const STRIP_COMPACT_MAX = 360;
  const STRIP_EXTREME_MAX = 240;
  const STRIP_CHIP_WIDTH = 36;

  function stripShrinkState(panelWidth, tabCount) {
    const width = Number(panelWidth) || 0;
    const tabs = Number(tabCount) || 0;
    if (tabs <= 0 || width <= 0) return { compact: false, extreme: false };
    return {
      compact: width <= STRIP_COMPACT_MAX,
      extreme: width <= STRIP_EXTREME_MAX,
    };
  }

  function stripRange(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }

  function stripSum(values) {
    let total = 0;
    for (const value of values) total += Number(value) || 0;
    return total;
  }

  /**
   * Pure layout planner for the file-panel tab strip.
   *
   * State A (fits): folder+name title, every tab is icon+name, X only on active.
   * State B (tight): inactive tabs demote to icon-only (dirty dot kept) BEFORE
   *   any tab is hidden; active keeps icon+name+X; title may drop to icon-only.
   * State C (minimal): folder icon + the active tab + one "…" chip of the rest.
   *
   * No layout: stripWidth<=0 (happy-dom) always returns A so DOM tests see every
   * tab. The renderer measures real widths and applies this plan in at most two
   * passes — it never scrolls the strip.
   */
  function planStrip(input) {
    const src = input || {};
    const stripWidth = Number(src.stripWidth) || 0;
    const titleWidth = Math.max(0, Number(src.titleWidth) || 0);
    const titleIconWidth = Math.max(0, Number(src.titleIconWidth) || 0);
    const trailingWidth = Math.max(0, Number(src.trailingWidth) || 0);
    const tabCount = Math.max(0, Math.floor(Number(src.tabCount) || 0));
    const activeIndex = Number.isInteger(src.activeIndex) ? src.activeIndex : -1;
    const tabFullWidths = Array.isArray(src.tabFullWidths) ? src.tabFullWidths : [];
    const tabIconWidths = Array.isArray(src.tabIconWidths) ? src.tabIconWidths : [];
    const chipWidth = Math.max(0, Number(src.chipWidth) || STRIP_CHIP_WIDTH);
    const slack = Math.max(0, Number(src.slack) || 0);
    const all = stripRange(tabCount);
    const fullModes = all.map(() => "full");

    function result(state, title, visible, overflow, tabModes) {
      return { state: state, title: title, visible: visible, overflow: overflow, tabModes: tabModes };
    }

    if (tabCount <= 0 || stripWidth <= 0) {
      return result("a", "full", all, [], fullModes);
    }

    const avail = Math.max(0, stripWidth - trailingWidth - slack);
    const fullAt = (i) => Number(tabFullWidths[i]) || 0;
    const iconAt = (i) => Number(tabIconWidths[i]) || 0;
    const allFull = stripSum(all.map(fullAt));

    if (titleWidth + allFull <= avail) {
      return result("a", "full", all, [], fullModes);
    }

    const bModes = all.map((i) => (i === activeIndex ? "full" : "icon"));
    const bTabs = stripSum(all.map((i) => (i === activeIndex ? fullAt(i) : iconAt(i))));
    // Leftover space names MORE tabs, most-recently-opened first (owner: with
    // room, show 2-3 names including the current one; icons for the rest).
    const promoteIdles = (modes, budget) => {
      let leftover = budget;
      const out = modes.slice();
      for (let k = all.length - 1; k >= 0; k--) {
        if (k === activeIndex || out[k] !== "icon") continue;
        const gain = fullAt(k) - iconAt(k);
        if (gain <= leftover) {
          out[k] = "full";
          leftover -= Math.max(0, gain);
        }
      }
      return out;
    };
    if (titleWidth + bTabs <= avail) {
      return result("b", "full", all, [], promoteIdles(bModes, avail - titleWidth - bTabs));
    }
    if (titleIconWidth + bTabs <= avail) {
      return result("b", "icon", all, [], promoteIdles(bModes, avail - titleIconWidth - bTabs));
    }

    const visible = activeIndex >= 0 && activeIndex < tabCount ? [activeIndex] : [];
    const overflow = all.filter((i) => i !== activeIndex);
    const cModes = all.map((i) => (i === activeIndex ? "full" : "icon"));
    return result("c", "icon", visible, overflow, cModes);
  }

  const ICON = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
    // lucide maximize-2 / minimize-2 — expand the panel over chat, then restore.
    // lucide `maximize` / `minimize` (corner brackets) — the owner's explicit
    // pick over the -2 diagonal-arrow variants.
    maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    // lucide `refresh-cw` — re-list from disk. A listing is cached for the
    // lifetime of the scope and nothing invalidates it, so a file the agent
    // wrote a moment ago is invisible until somebody asks again (#134).
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    // book-open-text / code — the two Markdown modes, kept as the icon pair the
    // desktop panel has always used rather than a worded toggle. A worded
    // button made Markdown the odd one out beside the pencil every other text
    // file gets.
    preview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 12h2"/><path d="M6 8h2"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  };

  function createFilePanel(options) {
    if (!options || !options.access) throw new Error("file panel requires an access adapter");
    const access = options.access;
    const ui = options.ui || {};
    const confirmChoice = typeof ui.confirm === "function" ? ui.confirm : defaultConfirm;
    const renderMarkdown = typeof ui.renderMarkdown === "function"
      ? ui.renderMarkdown
      : (source) => "<pre>" + escapeHtml(source) + "</pre>";
    const doc = options.document || root.document;
    const win = options.window || root;
    const mount = options.mount || {};
    const elementIds = mount.elementIds || {};
    const panelHost = mount.panelHost || doc.body;
    const scopes = new Map();
    const pendingControllers = new Set();
    const directorySeq = new Map();
    let currentScope = null;
    let currentState = null;
    let destroyed = false;
    let open = false;
    let treeMode = true;
    /** Which tab the live textarea belongs to, so a repaint only restores a
     *  caret into the same file it came from. */
    let editingTabKey = null;
    let renderedTreeState = null;
    let unsubscribeScope = null;
    let menu = null;
    /** The control that opened `menu` (a button). Used so a second click on
     *  that same control toggles closed instead of close-and-reopen. */
    let menuAnchor = null;
    let overflowRelPaths = [];
    let copyFlashTimer = null;
    let lastStripPlan = null;
    let forcedStripPlan = null;
    let stripBusy = false;
    let cachedTitleWidth = 0;

    const rootEl = doc.createElement("aside");
    rootEl.id = mount.id || "grok-file-panel";
    rootEl.className = "gfp-panel desk-ft-panel";
    rootEl.setAttribute("aria-label", "Workspace files");
    rootEl.hidden = true;

    const resizer = doc.createElement("div");
    resizer.className = "gfp-resizer desk-ft-resizer";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("aria-label", "Resize file panel");
    resizer.hidden = true;

    const header = doc.createElement("div");
    header.className = "gfp-header desk-ft-header";
    const title = doc.createElement("button");
    title.type = "button";
    title.className = "gfp-title desk-ft-title";
    title.title = "Show file tree";
    const tabsEl = doc.createElement("div");
    tabsEl.className = "gfp-tabs desk-ft-tabs";
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Open files");
    const closePanel = doc.createElement("button");
    closePanel.type = "button";
    closePanel.className = "gfp-close files-browse-close";
    closePanel.title = "Close";
    closePanel.setAttribute("aria-label", "Close file panel");
    closePanel.innerHTML = ICON.close;

    // Re-list the tree. Present on every mount — the phone needs it most, since
    // it is the surface watching an agent write files it did not open itself.
    // It is also the control that pins the trailing group to the right edge
    // when no tabs are open; see .gfp-refresh in file-panel.css.
    const refreshBtn = doc.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "gfp-icon-button gfp-refresh desk-ft-refresh";
    refreshBtn.innerHTML = ICON.refresh;
    refreshBtn.title = "Refresh";
    refreshBtn.setAttribute("aria-label", "Refresh file tree");
    refreshBtn.addEventListener("click", () => void refreshTree());

    // Content-area maximize. The mount opts in (desktop and the wide browser);
    // the phone overlay already goes full-viewport at the 899 dock breakpoint,
    // so applyPresentation hides the control there rather than fighting that
    // layout. Remote used to omit the flag entirely, which also hid it on a
    // desktop monitor where the panel docks beside the chat.
    const canMaximize = !!mount.maximize;
    let maximized = false;
    const maximizeBtn = canMaximize ? doc.createElement("button") : null;
    if (maximizeBtn) {
      maximizeBtn.type = "button";
      maximizeBtn.className = "gfp-icon-button gfp-maximize desk-ft-maximize";
      maximizeBtn.setAttribute("aria-pressed", "false");
      header.append(title, tabsEl, refreshBtn, maximizeBtn, closePanel);
    } else {
      header.append(title, tabsEl, refreshBtn, closePanel);
    }

    const filter = doc.createElement("input");
    filter.type = "search";
    filter.className = "gfp-filter desk-ft-filter";
    filter.placeholder = "Filter…";
    filter.autocomplete = "off";
    filter.spellcheck = false;

    const tree = doc.createElement("div");
    tree.className = "gfp-tree desk-ft-body files-browse-body";
    const viewer = doc.createElement("div");
    viewer.className = "gfp-viewer desk-ft-viewer files-browse-viewer";
    viewer.hidden = true;

    if (elementIds.resizer) resizer.id = elementIds.resizer;
    if (elementIds.title) title.id = elementIds.title;
    if (elementIds.tabs) tabsEl.id = elementIds.tabs;
    if (elementIds.tree) tree.id = elementIds.tree;
    if (elementIds.viewer) viewer.id = elementIds.viewer;
    if (maximizeBtn && elementIds.maximize) maximizeBtn.id = elementIds.maximize;

    rootEl.append(header, filter, tree, viewer);
    panelHost.appendChild(resizer);
    panelHost.appendChild(rootEl);

    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "gfp-toggle desk-ft-top-toggle";
    toggle.setAttribute("aria-label", "Toggle file panel");
    toggle.innerHTML = panelIcon("right");
    toggle.addEventListener("click", () => setOpen(!open));
    closePanel.addEventListener("click", () => setOpen(false));
    title.addEventListener("click", showTree);
    if (maximizeBtn) maximizeBtn.addEventListener("click", () => setMaximized(!maximized));
    filter.addEventListener("input", () => {
      if (!currentState) return;
      currentState.filter = filter.value;
      applyTreeFilter();
    });

    if (mount.toggleHost) mount.toggleHost.appendChild(toggle);

    function isOverlay() {
      if (mount.presentation === "overlay") return true;
      if (mount.presentation !== "responsive") return false;
      if (!dockHostIsDisplayed()) return true;
      const breakpoint = Number(mount.breakpointPx) || MOBILE_BREAKPOINT;
      return typeof win.matchMedia === "function" && win.matchMedia("(max-width: " + breakpoint + "px)").matches;
    }

    function dockHostIsDisplayed() {
      if (!mount.dockHost) return false;
      for (let element = mount.dockHost; element; element = element.parentElement) {
        if (element.hidden) return false;
        const style = typeof win.getComputedStyle === "function" ? win.getComputedStyle(element) : null;
        if (style && style.display === "none") return false;
      }
      return true;
    }

    function applyPresentation() {
      const overlay = isOverlay();
      rootEl.classList.toggle("gfp-overlay", overlay);
      rootEl.classList.toggle("gfp-docked", !overlay);
      // An overlay starts below the host's own bar, so it occupies the same band
      // the docked panel does instead of painting over the chrome — including,
      // on a phone, the button that just opened it. Measured rather than
      // hardcoded because the bar wraps to two rows on a narrow screen, and
      // re-measured here because this runs on every resize.
      // Its BOTTOM edge, not its height: the relay page has a second header
      // above this bar, and a height alone would start the panel that much too
      // high. Clamped at zero so a scrolled-away bar cannot push it off-screen.
      //
      // Resolved on every call rather than captured at mount, because WHICH bar
      // is on screen changes at runtime: the relay hides `.top-bar` and shows
      // `#session-head` the moment the host sends a project catalog. A captured
      // reference measured a hidden element, got zero, and left the overlay
      // covering the conversation header — the exact thing this offset exists to
      // prevent. Defaulting to the toggle's own container keeps it honest: the
      // panel starts below whichever bar its button lives in.
      const from = typeof mount.overlayTopFrom === "function"
        ? mount.overlayTopFrom()
        : mount.overlayTopFrom;
      const bar = overlay && (from || toggle.parentElement);
      const top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
      rootEl.style.setProperty("--gfp-overlay-top", top + "px");
      resizer.hidden = !open || overlay || maximized;
      closePanel.hidden = !overlay;
      // Overlay is already the full remaining viewport (phone / <900). A second
      // maximize would fight that layout, so drop it and hide the control.
      if (overlay && maximized) {
        maximized = false;
        rootEl.classList.toggle("gfp-maximized", false);
        paintMaximize();
        applyMaximizedBodyClass();
        if (typeof options.onMaximizedChanged === "function") options.onMaximizedChanged(false);
      }
      if (maximizeBtn) maximizeBtn.hidden = overlay;
      if (!overlay && mount.dockHost && rootEl.parentElement !== mount.dockHost) {
        mount.dockHost.appendChild(resizer);
        mount.dockHost.appendChild(rootEl);
      } else if (overlay && rootEl.parentElement !== panelHost) {
        panelHost.appendChild(resizer);
        panelHost.appendChild(rootEl);
      }
      applyStripShrink();
    }

    function setOpen(next) {
      open = !!next;
      rootEl.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.title = open ? "Hide file panel" : "Show file panel";
      if (!open) setMaximized(false);
      applyPresentation();
      if (open && currentState && !currentState.tree) void loadRootTree();
      if (typeof options.onOpenChanged === "function") options.onOpenChanged(open);
    }

    function paintMaximize() {
      if (!maximizeBtn) return;
      maximizeBtn.innerHTML = maximized ? ICON.restore : ICON.maximize;
      maximizeBtn.title = maximized ? "Restore" : "Maximize";
      maximizeBtn.setAttribute("aria-label", maximized ? "Restore file panel" : "Maximize file panel");
      maximizeBtn.setAttribute("aria-pressed", String(maximized));
    }

    /**
     * The refresh control is a property of the TREE, so it goes away with the
     * tree. In the viewer there is no listing on screen to re-list, and the
     * viewer's own Reload already covers the open file — a second button there
     * would either do nothing visible or reload something you cannot see.
     *
     * Hiding it is safe for the strip layout because it is only ever hidden
     * while a file is open, and an open file means a tab, and `.gfp-tabs` grows
     * to hold the trailing controls against the right edge.
     */
    function paintRefresh() {
      const wasHidden = refreshBtn.hidden;
      refreshBtn.hidden = !treeMode;
      // In flight covers both loads: pressing refresh during the first listing
      // would ask for the same thing twice.
      refreshBtn.disabled = !currentState || !!currentState.rootLoad;
      refreshBtn.classList.toggle("gfp-busy", !!(currentState && currentState.rootLoad));
      // Read from the scope on screen, never left behind by the one that
      // started it. `rootEl` is shared, and a refresh whose requests are still
      // outstanding on a project you have left would otherwise dim — and, via
      // pointer-events, freeze — the project you moved to. The adapters ignore
      // the abort signal, so that wait is 30s on a remote and open-ended on
      // the desk.
      rootEl.classList.toggle("gfp-refreshing", !!(currentState && currentState.refreshing));
      if (refreshBtn.hidden !== wasHidden) applyStripShrink();
    }

    function applyMaximizedBodyClass() {
      // Shared key for desktop (.desk-ft-chat) and the browser (#chat-stack).
      // Owned here so chat.js never has to mention a desk-ft- class.
      if (doc.body) doc.body.classList.toggle("desk-ft-maximized", maximized);
    }

    function setMaximized(next) {
      if (!canMaximize) return false;
      const overlay = isOverlay();
      // Overlay is already full-viewport; refuse rather than fight that layout.
      const value = !!next && open && !overlay;
      if (maximized === value) {
        paintMaximize();
        if (maximizeBtn) maximizeBtn.hidden = overlay;
        return maximized;
      }
      maximized = value;
      rootEl.classList.toggle("gfp-maximized", maximized);
      paintMaximize();
      applyMaximizedBodyClass();
      applyPresentation();
      applyStripShrink();
      if (typeof options.onMaximizedChanged === "function") options.onMaximizedChanged(maximized);
      return maximized;
    }

    function paintTitle() {
      const label = currentScope ? currentScope.label : "Files";
      title.textContent = "";
      const icon = doc.createElement("span");
      icon.className = "gfp-title-icon";
      renderFileIcon(icon, label, "dir");
      const name = doc.createElement("span");
      name.className = "gfp-title-label";
      name.textContent = label;
      title.append(icon, name);
    }

    function applyStripShrink() {
      applyStripPlan();
    }

    function collectStripMeasurements() {
      const stripWidth = header.getBoundingClientRect().width || 0;
      // No layout engine (happy-dom) or hidden panel: the plan is A by
      // definition, so skip the per-tab getComputedStyle sweep — it is the
      // expensive part, and a test opening N files pays it N times.
      if (stripWidth <= 0) {
        return { stripWidth: 0, titleWidth: 0, titleIconWidth: 0, trailingWidth: 0, tabCount: 0, activeIndex: -1, tabFullWidths: [], tabIconWidths: [] };
      }
      const titleIconEl = title.querySelector(".gfp-title-icon");
      const titleCs = typeof win.getComputedStyle === "function" ? win.getComputedStyle(title) : null;
      const titlePad = titleCs
        ? (parseFloat(titleCs.paddingLeft) || 0) + (parseFloat(titleCs.paddingRight) || 0)
        : 20;
      const titleIconWidth = (titleIconEl ? titleIconEl.getBoundingClientRect().width : 16) + titlePad;
      if (!title.classList.contains("gfp-title-icon-only")) {
        const live = title.getBoundingClientRect().width || title.scrollWidth || 0;
        if (live > 0) cachedTitleWidth = live;
      }
      const titleWidth = cachedTitleWidth || titleIconWidth;

      let trailingWidth = 0;
      function addTrailing(el) {
        if (!el || el.hidden) return;
        const box = el.getBoundingClientRect();
        const cs = typeof win.getComputedStyle === "function" ? win.getComputedStyle(el) : null;
        trailingWidth += box.width
          + (cs ? (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0) : 0);
      }
      addTrailing(refreshBtn);
      addTrailing(maximizeBtn);
      addTrailing(closePanel);
      // Gap floor on the tab row (padding-right on .gfp-tabs) is measured
      // here so A/B/C still plan against the width the last tab may use.
      const tabsCs = typeof win.getComputedStyle === "function" ? win.getComputedStyle(tabsEl) : null;
      if (tabsCs) {
        trailingWidth += (parseFloat(tabsCs.paddingLeft) || 0) + (parseFloat(tabsCs.paddingRight) || 0);
      }

      const tabs = [...tabsEl.querySelectorAll(".gfp-tab")];
      const tabFullWidths = [];
      const tabIconWidths = [];
      let activeIndex = -1;
      tabs.forEach((el, i) => {
        if (el.classList.contains("gfp-tab-active")) activeIndex = i;
        const cachedFull = Number(el.dataset.fullW) || 0;
        const cachedIcon = Number(el.dataset.iconW) || 0;
        if (el.hidden) {
          tabFullWidths.push(cachedFull);
          tabIconWidths.push(cachedIcon);
          return;
        }
        const cs = typeof win.getComputedStyle === "function" ? win.getComputedStyle(el) : null;
        const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 11;
        const gap = cs ? parseFloat(cs.columnGap || cs.gap) || 0 : 5;
        const iconEl = el.querySelector(".gfp-tab-icon");
        const dirtyEl = el.querySelector(".gfp-tab-dirty");
        const iconW = iconEl ? iconEl.getBoundingClientRect().width : 16;
        // Two dirty numbers: the SLOT is always rendered on a full tab
        // (flex-basis 10px, empty or not) — counting it only when dirty
        // under-budgeted clean tabs by slot+gap and the shortfall came out of
        // the name. Icon-only mode display:nones the EMPTY slot, so there the
        // dot counts only when actually dirty.
        const dirtyOn = dirtyEl && dirtyEl.textContent;
        const dirtySlotW = dirtyEl ? Math.max(dirtyEl.getBoundingClientRect().width, 10) : 0;
        const dirtyDotW = dirtyOn ? Math.max(dirtyEl.getBoundingClientRect().width, 10) : 0;
        // Floor so an unloaded img (0×0) cannot convince the planner that
        // icon-only tabs are free. 28px is pad+icon in the icon-only rule.
        const iconOnly = Math.max(28, pad + Math.max(iconW, 16) + (dirtyDotW ? gap + dirtyDotW : 0));
        const wasIconOnly = el.classList.contains("gfp-tab-icon-only");
        const box = el.getBoundingClientRect().width || 0;
        // A tab's own scrollWidth cannot see through the NAME's ellipsis (the
        // span hides its own overflow), so a tab that ever rendered squeezed
        // would measure its squeezed width as "full" and the plan would
        // believe it forever. Sum the parts with the name's scrollWidth — the
        // one number that still knows the untruncated text.
        const nameEl = el.querySelector(".gfp-tab-name");
        const nameW = nameEl
          ? Math.max(nameEl.scrollWidth || 0, nameEl.getBoundingClientRect().width || 0)
          : 0;
        const closeEl = el.querySelector(".gfp-tab-close");
        const closeW = closeEl && !closeEl.hidden ? Math.max(closeEl.getBoundingClientRect().width, 22) : 0;
        // +2 on the name: integer scrollWidth under-reports fractional text
        // widths at mobile DPRs (measured: CLAUDE.md needed 69, got 68 at
        // dpr 2.625) and the shortfall ellipsized the last glyph.
        const parts = pad + 1 + Math.max(iconW, 16)
          + (nameW ? gap + nameW + 2 : 0)
          + (dirtySlotW ? gap + dirtySlotW : 0)
          + (closeW ? gap + closeW : 0);
        // Parts-FIRST, never max(box, parts): the rendered box is the previous
        // ceiled basis, so feeding it back ratchets every named tab +1px per
        // apply pass — tabs slowly grew across resizes and never shrank back
        // to content size (owner: "never longer than needed").
        const liveFull = parts > (pad + 17) ? parts : box;
        const full = wasIconOnly ? (cachedFull || liveFull) : (liveFull || cachedFull);
        el.dataset.fullW = String(full);
        el.dataset.iconW = String(iconOnly);
        tabFullWidths.push(full);
        tabIconWidths.push(iconOnly);
      });

      let chipWidth = STRIP_CHIP_WIDTH;
      const chip = tabsEl.querySelector(".gfp-overflow-chip");
      if (chip && !chip.hidden) {
        const w = chip.getBoundingClientRect().width;
        if (w > 0) chipWidth = w;
      }

      return {
        stripWidth,
        titleWidth,
        titleIconWidth,
        trailingWidth,
        tabCount: tabs.length,
        activeIndex,
        tabFullWidths,
        tabIconWidths,
        chipWidth,
      };
    }

    function applyPlanToDom(plan) {
      lastStripPlan = plan;
      rootEl.dataset.stripState = plan.state;
      rootEl.classList.toggle("gfp-strip-a", plan.state === "a");
      rootEl.classList.toggle("gfp-strip-b", plan.state === "b");
      rootEl.classList.toggle("gfp-strip-c", plan.state === "c");
      title.classList.toggle("gfp-title-icon-only", plan.title === "icon");
      title.classList.toggle("gfp-title-selected", !!treeMode);

      const tabs = [...tabsEl.querySelectorAll(".gfp-tab")];
      overflowRelPaths = [];
      tabs.forEach((el, i) => {
        const hidden = plan.overflow.indexOf(i) !== -1;
        el.hidden = hidden;
        const mode = plan.tabModes[i];
        el.classList.toggle("gfp-tab-icon-only", mode === "icon");
        // Named tabs get their measured full width as an explicit basis:
        // Chromium's intrinsic sizing contributes the name below its real
        // max-content (the CLAUDE…-beside-free-space bug), so "auto" cannot
        // be trusted to show the full name. The planner already budgeted
        // exactly this number; flex-shrink still yields under true pressure.
        const fullW = Number(el.dataset.fullW) || 0;
        el.style.flexBasis = !hidden && mode === "full" && fullW > 0
          ? Math.ceil(fullW) + "px"
          : "";
        if (hidden && el.dataset.rel) overflowRelPaths.push(el.dataset.rel);
      });

      let chip = tabsEl.querySelector(".gfp-overflow-chip");
      if (plan.state === "c" && overflowRelPaths.length) {
        if (!chip) {
          chip = doc.createElement("button");
          chip.type = "button";
          chip.className = "gfp-overflow-chip";
          chip.setAttribute("aria-haspopup", "menu");
          chip.setAttribute("aria-label", "More open files");
          chip.textContent = "…";
          chip.addEventListener("click", () => openOverflowMenu(chip));
          tabsEl.appendChild(chip);
        }
        chip.title = overflowRelPaths.map((rel) => fileName(rel)).join(", ");
        chip.setAttribute("aria-expanded", menu && menu.classList.contains("gfp-overflow-menu") ? "true" : "false");
        chip.hidden = false;
      } else if (chip) {
        chip.remove();
        if (menu && menu.classList.contains("gfp-overflow-menu")) closeMenu();
      }
    }

    function tabsRowOverflows() {
      const client = tabsEl.clientWidth;
      const scroll = tabsEl.scrollWidth;
      if (client <= 0 || scroll <= 0) return false;
      return scroll > client + 1;
    }

    /**
     * The truth the plan math cannot see: flex-shrink absorbs an over-packed
     * row silently (no scroll overflow), ellipsizing names the plan promised.
     * Post-apply, ask the DOM whether any visible NAMED tab actually shows
     * its whole name — measurement drift then demotes instead of truncating.
     */
    function namesTruncated() {
      for (const el of tabsEl.querySelectorAll(".gfp-tab:not([hidden]):not(.gfp-tab-icon-only)")) {
        const name = el.querySelector(".gfp-tab-name");
        if (name && name.clientWidth > 0 && name.scrollWidth > name.clientWidth + 1) return true;
      }
      return false;
    }

    /** Strip B-state promotions back to the base plan (icons for every idle). */
    function withoutPromotions(plan) {
      if (plan.state !== "b") return plan;
      const tabs = [...tabsEl.querySelectorAll(".gfp-tab")];
      const activeIndex = tabs.findIndex((el) => el.classList.contains("gfp-tab-active"));
      return {
        ...plan,
        tabModes: plan.tabModes.map((m, i) => (i === activeIndex ? "full" : "icon")),
      };
    }

    function forceTighterPlan(plan) {
      const tabs = [...tabsEl.querySelectorAll(".gfp-tab")];
      const n = tabs.length;
      const activeIndex = tabs.findIndex((el) => el.classList.contains("gfp-tab-active"));
      const all = stripRange(n);
      const bModes = all.map((i) => (i === activeIndex ? "full" : "icon"));
      if (plan.state === "a") {
        return { state: "b", title: plan.title, visible: all, overflow: [], tabModes: bModes };
      }
      return {
        state: "c",
        title: "icon",
        visible: activeIndex >= 0 ? [activeIndex] : [],
        overflow: all.filter((i) => i !== activeIndex),
        tabModes: bModes,
      };
    }

    function applyStripPlan() {
      // Bound the measure→plan→apply cycle: ResizeObserver can fire when we
      // hide tabs / add the chip, and a nested pass would thrash. At most two
      // applies — the second only if the first still overflows the row.
      if (stripBusy) return;
      stripBusy = true;
      try {
        const width = rootEl.getBoundingClientRect().width || 0;
        const tabCount = currentState ? currentState.order.length : 0;
        const shrink = stripShrinkState(width, tabCount);
        rootEl.classList.toggle("gfp-strip-compact", shrink.compact);
        rootEl.classList.toggle("gfp-strip-extreme", shrink.extreme);
        let plan = forcedStripPlan || planStrip({
          ...collectStripMeasurements(),
          slack: 12,
        });
        applyPlanToDom(plan);
        // Promotions are speculative: verify against the RENDERED truth and
        // back them out before ever letting a promised name ellipsize.
        if (!forcedStripPlan && plan.state === "b" && namesTruncated()) {
          plan = withoutPromotions(plan);
          applyPlanToDom(plan);
        }
        if (!forcedStripPlan && (tabsRowOverflows() || namesTruncated()) && plan.state !== "c") {
          plan = forceTighterPlan(plan);
          applyPlanToDom(plan);
          if ((tabsRowOverflows() || namesTruncated()) && plan.state !== "c") {
            applyPlanToDom(forceTighterPlan(plan));
          }
        }
      } finally {
        stripBusy = false;
      }
    }

    function setPanelWidth(px, persist) {
      // What a drag may eat into is the ROW the panel shares with the chat, not
      // the panel's own column.
      //
      // Those are the same element on the desktop and different on the relay,
      // where the dock host is shrink-wrapped around the panel (`flex: 0 0
      // auto`). Measuring the column there returns the panel's own width, so
      // `hostWidth - MIN_CHAT_WIDTH` falls below MIN_WIDTH and the first drag
      // pins the panel at 200px with no way to enlarge it again.
      //
      // The host names the row instead of the component guessing: any
      // climb-until-an-ancestor-looks-wider rule is a heuristic that breaks the
      // next time either layout moves. `win.innerWidth` is not a substitute
      // either — on the relay the rail lives inside that width, so the chat
      // would be squeezed below its own minimum.
      // `widthPeer` is the element the panel must not starve — the chat column.
      // Available space is that column plus whatever the panel already occupies,
      // which is exactly the width the two of them share and nothing else.
      //
      // A whole-row basis is wrong for the same reason the panel's own column
      // was: on the relay the row also contains the project rail, so reserving
      // MIN_CHAT_WIDTH from the row let a drag squeeze the chat to ~150px on a
      // 1366px window and persist it.
      const peer = mount.widthPeer && mount.widthPeer.getBoundingClientRect().width;
      const hostWidth = (peer ? peer + rootEl.getBoundingClientRect().width : 0)
        || (mount.widthBasis && mount.widthBasis.getBoundingClientRect().width)
        || (rootEl.parentElement && rootEl.parentElement.getBoundingClientRect().width)
        || win.innerWidth || 800;
      const max = Math.max(MIN_WIDTH, Math.min(hostWidth * 0.7, hostWidth - MIN_CHAT_WIDTH));
      const value = Math.max(MIN_WIDTH, Math.min(max, Math.round(Number(px) || DEFAULT_WIDTH)));
      rootEl.style.setProperty("--gfp-width", value + "px");
      if (persist !== false && options.preferences && options.preferences.setWidth) {
        options.preferences.setWidth(value);
      }
      applyStripShrink();
      return value;
    }

    (function wireResize() {
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      // Body `--chat-zoom` scales VISUAL rects and clientX, while --gfp-width
      // is layout px. Convert both ends of the gesture so the edge tracks the
      // cursor (a no-op at zoom 1). Converting only the delta jumps on grab.
      // Helper lookup matches positionMenu: an older embedding without the
      // helpers degrades to today's uncorrected drag instead of throwing.
      const layoutPx = (clientPx) => {
        const helpers = (win.GrokWebviewHelpers || root.GrokWebviewHelpers || {});
        const zoomOf = typeof helpers.chatZoomFactor === "function" ? helpers.chatZoomFactor : () => 1;
        const unzoom = typeof helpers.unzoomClientPx === "function" ? helpers.unzoomClientPx : (px) => px;
        return unzoom(clientPx, zoomOf(doc));
      };
      resizer.addEventListener("pointerdown", (event) => {
        if (!open || isOverlay()) return;
        dragging = true;
        startX = layoutPx(event.clientX);
        startWidth = layoutPx(rootEl.getBoundingClientRect().width);
        rootEl.classList.add("gfp-resizing");
        try { resizer.setPointerCapture(event.pointerId); } catch (_) { /* noop */ }
        event.preventDefault();
      });
      resizer.addEventListener("pointermove", (event) => {
        if (dragging) setPanelWidth(startWidth + startX - layoutPx(event.clientX));
      });
      const stop = (event) => {
        if (!dragging) return;
        dragging = false;
        rootEl.classList.remove("gfp-resizing");
        try { resizer.releasePointerCapture(event.pointerId); } catch (_) { /* noop */ }
      };
      resizer.addEventListener("pointerup", stop);
      resizer.addEventListener("pointercancel", stop);
    })();

    function abortPending() {
      for (const controller of pendingControllers) controller.abort();
      pendingControllers.clear();
    }

    async function callAccess(method, scopeId, value) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      if (controller) pendingControllers.add(controller);
      try {
        return await access[method](scopeId, value, controller ? { signal: controller.signal } : undefined);
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error || "Request failed") };
      } finally {
        if (controller) pendingControllers.delete(controller);
      }
    }

    function scopeState(scope) {
      let state = scopes.get(scope.id);
      if (!state) {
        state = makeScopeState(scope);
        scopes.set(scope.id, state);
      } else {
        state.scope = scope;
      }
      return state;
    }

    async function setScope(scope) {
      if (destroyed) return;
      const nextState = scope ? scopeState(scope) : null;
      if (currentState !== nextState) abortPending();
      currentState = nextState;
      currentScope = nextState ? nextState.scope : null;
      title.title = scope && (scope.title || scope.label) || "Show file tree";
      paintTitle();
      filter.value = currentState ? currentState.filter : "";
      treeMode = !(currentState && currentState.activeRelPath);
      renderTabs();
      if (!currentState) {
        renderedTreeState = null;
        paintRefresh();
        tree.textContent = "No repository selected.";
        viewer.textContent = "";
        viewer.hidden = true;
        tree.hidden = false;
        return;
      }
      if (treeMode) {
        showTree();
        if (open && !currentState.tree) await loadRootTree();
      } else {
        renderViewer();
      }
    }

    async function loadRootTree() {
      if (!currentScope || !currentState) return;
      const state = currentState;
      const scopeId = state.scope.id;
      // Hosts may reassert one scope from adjacent state/catalog events. Share
      // its in-flight root load so that one transition produces one request.
      // A late result is cached only on the scope that requested it and is
      // never rendered into whichever scope happens to be current by then.
      if (state.rootLoad) return state.rootLoad;
      tree.textContent = "";
      appendStatus(tree, "Loading…");
      state.rootLoad = (async () => {
        const result = await callAccess("list", scopeId, "");
        if (result && result.ok) state.tree = result;
        if (destroyed || currentState !== state) return;
        tree.textContent = "";
        if (!result || !result.ok) {
          appendStatus(tree, result && result.reason || "Could not list folder.", true);
          return;
        }
        renderRootTree(state);
      })();
      paintRefresh();
      try {
        await state.rootLoad;
      } finally {
        state.rootLoad = null;
        paintRefresh();
      }
    }

    /**
     * Re-list the whole tree, keeping the place you were in.
     *
     * The old tree stays on screen, dimmed, until the replacement is complete:
     * the root AND every folder you had expanded are fetched together, then the
     * DOM is rebuilt once. Wiping to "Loading…" first would make a fast refresh
     * flash and a slow one look broken, and rebuilding level by level would
     * collapse the tree in front of you and grow it back.
     *
     * Everything else is deliberately untouched — open tabs, the filter text,
     * scroll position. A refresh that cost you your place is not worth pressing.
     */
    async function refreshTree() {
      if (destroyed || !currentScope || !currentState) return;
      const state = currentState;
      // A first listing already in flight is as fresh as anything we would ask
      // for, so join it rather than racing a second request against it.
      if (state.rootLoad) return state.rootLoad;
      const scopeId = state.scope.id;
      const remembered = expandedPaths();
      const scrollTop = tree.scrollTop;
      state.refreshing = true;
      state.rootLoad = (async () => {
        const [rootResult, ...folderResults] = await Promise.all([
          callAccess("list", scopeId, ""),
          ...remembered.map((relPath) => callAccess("list", scopeId, relPath)),
        ]);
        if (destroyed || currentState !== state) return;
        if (!rootResult || !rootResult.ok) {
          // Keep the tree you had. A refresh that failed is a failed refresh,
          // not a reason to lose the listing that was working — so the message
          // goes under the rows rather than over them, replacing only the
          // message a previous failed refresh left there.
          const previous = tree.querySelector(":scope > .gfp-refresh-error");
          if (previous) previous.remove();
          const status = statusLine(rootResult && rootResult.reason || "Could not list folder.", true);
          status.classList.add("gfp-refresh-error");
          tree.appendChild(status);
          return;
        }
        const listings = new Map();
        remembered.forEach((relPath, index) => {
          const result = folderResults[index];
          if (result && result.ok) listings.set(relPath, result);
        });
        state.tree = rootResult;
        renderRootTree(state, listings);
        tree.scrollTop = scrollTop;
      })();
      paintRefresh();
      try {
        await state.rootLoad;
      } finally {
        state.rootLoad = null;
        state.refreshing = false;
        paintRefresh();
      }
    }

    /**
     * The folders open ON SCREEN, deepest path last, read from the tree itself.
     *
     * Deliberately not a remembered Set. Bookkeeping kept alongside the DOM has
     * to be corrected at every point the two can diverge — collapsing a parent,
     * a folder deleted on disk, a listing that failed, a listing truncated
     * before the folder appeared — and each correction was its own defect. The
     * tree already knows which folders are open, so ask it: descending only
     * into expanded nodes means a folder inside a collapsed parent is never
     * reached, and one no longer on disk is not there to find.
     */
    function expandedPaths() {
      const out = [];
      (function walk(container) {
        for (const node of container.querySelectorAll(":scope > .gfp-node")) {
          if (node.dataset.kind !== "dir") continue;
          if (!node.classList.contains("gfp-expanded")) continue;
          out.push(node.dataset.rel);
          const children = node.querySelector(":scope > .gfp-children");
          if (children) walk(children);
        }
      })(tree);
      return out;
    }

    /**
     * Re-list one folder in place, from the row's ⋯ menu or its empty state.
     * Dropping `data-loaded` is what makes the expand re-fetch; clearing the
     * expanded class hands the work to `toggleDirectory`, which re-sets it
     * synchronously, so the folder never visibly closes.
     */
    async function refreshFolder(relPath) {
      if (destroyed || !currentScope || !currentState) return;
      const node = findNode(relPath);
      if (!node || node.dataset.kind !== "dir") return;
      const lead = node.querySelector(":scope > .gfp-row > .gfp-lead");
      const children = node.querySelector(":scope > .gfp-children");
      if (!lead || !children) return;
      children.removeAttribute("data-loaded");
      node.classList.remove("gfp-expanded", "desk-ft-open");
      await toggleDirectory(node, { name: node.dataset.name, relPath, kind: "dir" }, lead);
    }

    function findNode(relPath) {
      for (const node of tree.querySelectorAll(".gfp-node")) {
        if (node.dataset.rel === relPath) return node;
      }
      return null;
    }

    function renderRootTree(state, listings) {
      renderDirectory(tree, state.tree, "", listings);
      renderedTreeState = state;
      applyTreeFilter();
    }

    function renderDirectory(container, result, parentRelPath, listings) {
      container.textContent = "";
      if (!result.entries || !result.entries.length) {
        appendStatus(container, "Empty folder");
        // An empty folder is exactly where somebody suspects the panel is
        // wrong, so the cure is offered where the doubt is rather than up in
        // the header.
        const actions = doc.createElement("div");
        actions.className = "gfp-status-actions";
        const rel = String(parentRelPath || "");
        actions.appendChild(actionButton("Refresh", "", () => {
          void (rel ? refreshFolder(rel) : refreshTree());
        }));
        container.appendChild(actions);
        return;
      }
      for (const entry of result.entries) container.appendChild(makeTreeNode(entry, parentRelPath, listings));
      // Below the rows, not instead of them: appendStatus clears its host, so
      // this used to throw away every entry of a folder big enough to be cut.
      if (result.truncated) container.appendChild(statusLine("Folder truncated — more entries exist."));
    }

    function makeTreeNode(entry, parentRelPath, listings) {
      const node = doc.createElement("div");
      node.className = "gfp-node desk-ft-node";
      node.dataset.name = entry.name;
      node.dataset.rel = entry.relPath;
      node.dataset.kind = entry.kind;
      const row = doc.createElement("div");
      row.className = "gfp-row desk-ft-row files-browse-row";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.title = entry.relPath;
      const depth = String(entry.relPath).split("/").length - 1;
      row.style.setProperty("--gfp-depth", String(depth));
      const lead = doc.createElement("span");
      lead.className = "gfp-lead desk-ft-lead files-browse-row-icon";
      if (entry.kind === "dir") {
        lead.classList.add("desk-ft-twist");
        lead.innerHTML = ICON.chevronRight;
      }
      else renderFileIcon(lead, entry.name, entry.kind);
      const name = doc.createElement("span");
      name.className = "gfp-name desk-ft-name files-browse-row-name";
      name.textContent = entry.name;
      const actions = doc.createElement("div");
      actions.className = "gfp-row-actions desk-ft-row-actions";
      // Copy path is host-free, so every row has a menu — including remote,
      // which has no openExternal/reveal, and directories, which have a path.
      const more = doc.createElement("button");
      more.type = "button";
      more.className = "gfp-icon-button desk-ft-action-btn";
      more.innerHTML = ICON.more;
      more.title = "More actions";
      more.setAttribute("aria-label", "More actions");
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        openRowMenu(more, entry);
      });
      actions.appendChild(more);
      row.append(lead, name, actions);
      node.appendChild(row);
      if (entry.kind === "dir") {
        const children = doc.createElement("div");
        children.className = "gfp-children desk-ft-children";
        node.appendChild(children);
        // A refresh hands the whole tree over at once: this folder was open
        // before, and its new listing came back with the root's, so it is
        // rebuilt already open rather than re-fetched on the way past.
        const reopened = listings && listings.get(entry.relPath);
        if (reopened) {
          node.classList.add("gfp-expanded", "desk-ft-open");
          lead.innerHTML = ICON.chevronDown;
          children.dataset.loaded = "1";
          renderDirectory(children, reopened, entry.relPath, listings);
        }
      }
      const activate = () => entry.kind === "dir" ? toggleDirectory(node, entry, lead) : openFile(entry.relPath);
      row.addEventListener("click", (event) => {
        if (event.target && event.target.closest && event.target.closest(".gfp-row-actions")) return;
        void activate();
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openRowMenu(row, entry, event);
      });
      row.addEventListener("keydown", (event) => {
        if (event.target === row && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          void activate();
        }
      });
      return node;
    }

    async function toggleDirectory(node, entry, lead) {
      if (!currentScope || !currentState) return;
      const children = node.querySelector(":scope > .gfp-children");
      const opening = !node.classList.contains("gfp-expanded");
      node.classList.toggle("gfp-expanded", opening);
      node.classList.toggle("desk-ft-open", opening);
      lead.innerHTML = opening ? ICON.chevronDown : ICON.chevronRight;
      if (!opening) return;
      if (children.dataset.loaded === "1") return;
      appendStatus(children, "Loading…");
      const state = currentState;
      const scopeId = state.scope.id;
      const seq = (directorySeq.get(scopeKey(scopeId, entry.relPath)) || 0) + 1;
      directorySeq.set(scopeKey(scopeId, entry.relPath), seq);
      const result = await callAccess("list", scopeId, entry.relPath);
      if (
        destroyed || currentState !== state
        || directorySeq.get(scopeKey(scopeId, entry.relPath)) !== seq
      ) return;
      children.textContent = "";
      if (!result || !result.ok) {
        appendStatus(children, result && result.reason || "Could not list folder.", true);
        return;
      }
      children.dataset.loaded = "1";
      renderDirectory(children, result, entry.relPath);
      applyTreeFilter();
    }

    function renderFileIcon(host, name, kind) {
      const icons = ui.fileIcons;
      if (!icons || !icons.baseUrl) {
        host.innerHTML = kind === "dir" ? ICON.folder : ICON.file;
        return;
      }
      const id = typeof icons.idFor === "function"
        ? icons.idFor(kind, name)
        : icons.extensionToId
          ? iconIdFromTable(name, icons.extensionToId, icons.defaultId)
          : defaultFileIconId(kind, name);
      const src = joinUrl(icons.baseUrl, id + ".svg");
      const monochrome = Array.isArray(icons.monochromeIds)
        ? icons.monochromeIds.indexOf(id) >= 0
        : MONOCHROME_FILE_ICONS.has(id);
      if (monochrome) {
        // An external SVG with no fill defaults to black. Use it as a mask so
        // the same lazy-loaded asset follows the active host theme instead.
        const glyph = doc.createElement("span");
        glyph.className = "gfp-file-icon-mono desk-ft-icon-mono";
        glyph.style.setProperty("--gfp-icon-url", 'url("' + src.replace(/"/g, "%22") + '")');
        host.appendChild(glyph);
      } else {
        const img = doc.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.src = src;
        host.appendChild(img);
      }
    }

    function applyTreeFilter() {
      if (!currentState) return;
      const query = String(currentState.filter || "").trim().toLowerCase();
      function visit(container) {
        let visible = 0;
        for (const node of container.querySelectorAll(":scope > .gfp-node")) {
          const children = node.querySelector(":scope > .gfp-children");
          const childVisible = children ? visit(children) : 0;
          const matches = !query || String(node.dataset.name || "").toLowerCase().includes(query) || childVisible > 0;
          node.hidden = !matches;
          if (matches) visible++;
        }
        return visible;
      }
      visit(tree);
    }

    async function openFile(relPath, force) {
      if (!currentScope || !currentState || !relPath) return { ok: false, reason: "no repository scope" };
      const state = currentState;
      const scopeId = state.scope.id;
      if (!force && state.tabs.has(relPath)) {
        activateTab(relPath);
        return { ok: true };
      }
      const existing = state.tabs.get(relPath);
      const readSeq = existing ? ++existing.readSeq : 1;
      const result = await callAccess("read", scopeId, relPath);
      if (destroyed || currentState !== state) return { ok: false, reason: "scope changed" };
      if (existing && existing.readSeq !== readSeq) return { ok: false, reason: "superseded" };
      if (!result || !result.ok) {
        // Open it as a tab rather than painting the message over the tree, so
        // the failure names its own file. Same path as a success from here on.
        //
        // This used to hand a non-previewable file straight to the OS on the
        // desktop (`result.openExternal`), which meant the same click did two
        // different things depending on which client you were sitting at — a
        // tab with a message in the browser, a silently launched external app
        // on the desktop. The tab is now the answer everywhere, and the OS
        // route is offered INSIDE it rather than taken on your behalf.
        const failed = makeErrorTab(scopeId, relPath, result && result.reason);
        failed.canOpenExternally = !!(result && result.openExternal && access.openExternal);
        state.tabs.set(relPath, failed);
        if (!state.order.includes(relPath)) state.order.push(relPath);
        state.activeRelPath = relPath;
        treeMode = false;
        renderTabs();
        renderViewer();
        setOpen(true);
        return result || { ok: false, reason: "read failed" };
      }
      const tab = makeTab(scopeId, result);
      state.tabs.set(relPath, tab);
      if (!state.order.includes(relPath)) state.order.push(relPath);
      state.activeRelPath = relPath;
      treeMode = false;
      renderTabs();
      renderViewer();
      setOpen(true);
      return { ok: true, kind: result.kind };
    }

    function activateTab(relPath) {
      if (!currentState || !currentState.tabs.has(relPath)) return;
      currentState.activeRelPath = relPath;
      treeMode = false;
      renderTabs();
      renderViewer();
    }

    async function closeTab(relPath) {
      if (!currentState) return false;
      // Capture the scope before the await: switching projects while
      // "Discard changes?" is open swaps currentState, and the same relPath
      // can exist in both scopes — mutating the module variable afterwards
      // would discard the OTHER scope's draft. (The identifier-stale-after-
      // await class; review find, 2026-08-14.)
      const state = currentState;
      const tab = state.tabs.get(relPath);
      if (!tab) return false;
      if (tab.dirty) {
        const answer = await confirmChoice({
          title: "Discard changes?",
          body: "Your edits have not been saved.",
          actions: [{ id: "discard", label: "Discard", danger: true }],
        });
        if (answer !== "discard") return false;
      }
      state.tabs.delete(relPath);
      state.order = state.order.filter((item) => item !== relPath);
      if (state.activeRelPath === relPath) {
        state.activeRelPath = state.order.length
          ? state.order[state.order.length - 1]
          : null;
      }
      // Repaint only if this scope is still the one on screen — the close
      // took effect in its own scope either way.
      if (state !== currentState) return true;
      renderTabs();
      if (state.activeRelPath) renderViewer();
      else showTree();
      return true;
    }

    function renderTabs() {
      tabsEl.textContent = "";
      overflowRelPaths = [];
      if (!currentState) {
        applyStripPlan();
        return;
      }
      for (const relPath of currentState.order) {
        const tab = currentState.tabs.get(relPath);
        if (!tab) continue;
        const isActive = !treeMode && currentState.activeRelPath === relPath;
        const item = doc.createElement("div");
        item.className = "gfp-tab desk-ft-tab" + (isActive ? " gfp-tab-active desk-ft-tab-active" : "");
        item.setAttribute("role", "tab");
        item.dataset.rel = relPath;
        item.title = relPath;
        item.tabIndex = 0;
        const icon = doc.createElement("span");
        icon.className = "gfp-tab-icon";
        renderFileIcon(icon, fileName(relPath), tab.kind === "dir" ? "dir" : "file");
        const name = doc.createElement("span");
        name.className = "gfp-tab-name desk-ft-tab-name";
        name.textContent = fileName(relPath);
        const dirty = doc.createElement("span");
        dirty.className = "gfp-tab-dirty desk-ft-tab-dirty";
        dirty.textContent = tab.dirty ? "•" : "";
        item.append(icon, name, dirty);
        // Inactive tabs never render an X. The active tab's close is structural
        // (not CSS-hidden) so it cannot be clipped away by a shrink rule.
        if (isActive) {
          const close = doc.createElement("button");
          close.type = "button";
          close.className = "gfp-tab-close desk-ft-tab-close";
          close.innerHTML = ICON.close;
          close.title = "Close";
          close.setAttribute("aria-label", "Close " + fileName(relPath));
          close.addEventListener("click", (event) => {
            event.stopPropagation();
            void closeTab(relPath);
          });
          item.appendChild(close);
        }
        item.addEventListener("click", () => activateTab(relPath));
        tabsEl.appendChild(item);
      }
      applyStripPlan();
    }

    function currentTab() {
      return currentState && currentState.activeRelPath
        ? currentState.tabs.get(currentState.activeRelPath) || null
        : null;
    }

    function showTree() {
      treeMode = true;
      rootEl.classList.remove("gfp-viewing");
      if (mount.viewingBodyClass) doc.body.classList.remove(mount.viewingBodyClass);
      tree.hidden = false;
      viewer.hidden = true;
      renderTabs();
      paintRefresh();
      if (currentState && currentState.tree && renderedTreeState !== currentState) {
        renderRootTree(currentState);
      } else if (currentState && !currentState.tree && open) {
        void loadRootTree();
      }
    }


    /**
     * The open file's action row. No back chevron and no filename: both were
     * saying something the panel already says. The tab strip above names the
     * file and marks it dirty, and the project title beside it is the way back
     * to the tree — so the breadcrumb row was a third copy of the same two
     * facts, costing a row of height on a phone.
     */
    function viewerHead() {
      const head = doc.createElement("div");
      head.className = "gfp-viewer-head desk-ft-toolbar files-browse-viewer-head";
      return head;
    }

    /** The highlighter, or null where it was not loaded (VS Code does not ship
     *  the panel at all, and a stale relay page may predate this script). Every
     *  use is guarded: no highlighter means plain text, never a broken viewer. */
    function highlighter() {
      const api = root.GrokSyntaxHighlight;
      return api && typeof api.highlightCode === "function" ? api : null;
    }

    /** Paint `text` into `el` as code — highlighted when we recognise the
     *  language, plain otherwise. The ONLY place file contents become markup;
     *  the highlighter escapes everything it emits, and the fallback assigns
     *  textContent so raw source can never reach innerHTML. */
    function paintCode(el, text, relPath) {
      const api = highlighter();
      const lang = api ? api.languageForPath(relPath || "") : "";
      if (!api || !lang) {
        el.textContent = text;
        return;
      }
      el.innerHTML = api.highlightCode(text, lang);
    }

    /**
     * The editable surface.
     *
     * With a known language this is the textarea-over-`<pre>` overlay: the
     * textarea keeps its real text but paints it transparent (caret and
     * selection stay visible), and an aria-hidden `<pre>` behind it shows the
     * highlighted copy. The textarea remains the single source of truth for the
     * bytes — the underlay is decoration and never feeds a save, so the worst
     * failure this can produce is misaligned colour, never a wrong file.
     *
     * Alignment is the whole trick: both layers must agree on font, size,
     * line-height, padding AND wrapping, which is why the CSS pins
     * `white-space: pre-wrap` + `overflow-wrap: break-word` on both rather than
     * leaving the textarea on its default soft wrap.
     *
     * Without a language (or without the highlighter) it degrades to exactly
     * the plain textarea this replaced — the deliberate escape hatch, since a
     * mobile keyboard's IME over transparent text is the one risk here that
     * cannot be settled by reading the code.
     */
    function buildEditor(tab) {
      const editor = doc.createElement("textarea");
      editor.className = "gfp-editor desk-ft-editor files-browse-editor";
      editor.value = tab.draftText;
      editor.spellcheck = false;
      // Held, not hidden, while a Reload is in flight — see reloadTab.
      editor.readOnly = !!tab.reloading;
      editor.setAttribute("aria-label", "Edit " + tab.relPath);

      const api = highlighter();
      const lang = api ? api.languageForPath(tab.relPath || "") : "";
      if (!api || !lang) {
        editor.addEventListener("input", () => {
          applyDraft(tab, editor.value);
          patchDirtyUi(tab);
        });
        return editor;
      }

      const wrap = doc.createElement("div");
      wrap.className = "gfp-code-edit";
      const under = doc.createElement("pre");
      under.className = "gfp-code-underlay";
      under.setAttribute("aria-hidden", "true");
      editor.classList.add("gfp-editor-overlaid");

      // A textarea shows a final empty line for a trailing newline; a `<pre>`
      // does not. Without this sentinel the two drift apart by one line the
      // moment the file ends in a newline — which is nearly every file.
      const repaint = () => {
        const text = editor.value;
        under.innerHTML = api.highlightCode(text.endsWith("\n") ? text + " " : text, lang);
      };
      repaint();

      // Small files repaint SYNCHRONOUSLY — highlighting a few KB costs well
      // under a millisecond, and deferring it puts a visible frame of stale
      // colour behind the caret for no gain. Only past the threshold is it
      // worth coalescing to one repaint per frame, where the cost is real and a
      // fast typist can outrun it.
      //
      // Scheduled THROUGH the view, not by pulling the function off it —
      // `requestAnimationFrame` called detached from its window throws
      // "Illegal invocation" in a browser, which a happy-dom test would never
      // have shown because it falls through to the setTimeout branch there.
      const COALESCE_ABOVE_BYTES = 32 * 1024;
      const view = doc.defaultView || root;
      let queued = false;
      const schedule = () => {
        if (editor.value.length <= COALESCE_ABOVE_BYTES) return repaint();
        if (queued) return;
        queued = true;
        const run = () => {
          queued = false;
          repaint();
        };
        if (typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(run);
        else view.setTimeout(run, 16);
      };
      editor.addEventListener("input", () => {
        applyDraft(tab, editor.value);
        patchDirtyUi(tab);
        schedule();
      });
      // Both layers scroll as one. Vertical is what matters (wrapping is
      // identical, so there is no horizontal scroll), but syncing both costs
      // nothing and survives a future change to the wrap mode.
      editor.addEventListener("scroll", () => {
        under.scrollTop = editor.scrollTop;
        under.scrollLeft = editor.scrollLeft;
      });

      wrap.appendChild(under);
      wrap.appendChild(editor);
      return wrap;
    }

    function renderViewer() {
      const tab = currentTab();
      if (!tab) return showTree();
      // Where the caret was, so a repaint does not throw it away.
      //
      // This function rebuilds the viewer from scratch, textarea included, and a
      // save repaints — so saving mid-sentence moved the cursor to the start and
      // lost the selection and the scroll position. Captured for THIS tab only;
      // a repaint that swaps files should not move a caret into someone else's
      // text.
      const live = viewer.querySelector(".gfp-editor");
      const carry = live && editingTabKey === tab.key
        ? {
            start: live.selectionStart,
            end: live.selectionEnd,
            scrollTop: live.scrollTop,
            focused: doc.activeElement === live,
          }
        : null;
      editingTabKey = tab.editing ? tab.key : null;
      treeMode = false;
      paintRefresh();
      rootEl.classList.add("gfp-viewing");
      if (mount.viewingBodyClass) doc.body.classList.add(mount.viewingBodyClass);
      tree.hidden = true;
      viewer.hidden = false;
      viewer.textContent = "";
      const head = viewerHead();
      renderViewerActions(head, tab);
      viewer.appendChild(head);
      if (tab.notice) {
        const notice = doc.createElement("div");
        notice.className = "gfp-notice desk-ft-notice files-browse-notice" + (tab.conflict ? " gfp-notice-warning files-browse-notice-warn" : "");
        notice.textContent = tab.notice;
        viewer.appendChild(notice);
      }
      if (tab.conflict) renderConflictActions(tab);
      const body = doc.createElement("div");
      body.className = "gfp-viewer-body desk-ft-viewer-body files-browse-viewer-body";
      if (elementIds.viewerBody) body.id = elementIds.viewerBody;
      if (tab.error) {
        // Inside the tab's own body, under its own tab. The message is the
        // content of this file as far as the panel is concerned.
        //
        // The action row above is dropped when it would be EMPTY. Copy path
        // is always in the ⋯ menu, so a failed open still keeps the bar (you
        // can copy the path of a file you could not preview). An older
        // client with nothing at all in the menu still drops it.
        if (!head.childNodes.length) head.remove();
        appendStatus(body, tab.error, true);
        // The desktop can still hand it to the OS — offered here, not done for
        // you, so the same click means the same thing on every client.
        if (tab.canOpenExternally && access.openExternal) {
          const open = actionButton("Open in default app", "", () => {
            void access.openExternal(tab.scopeId, tab.relPath);
          });
          open.classList.add("gfp-open-external");
          const row = doc.createElement("div");
          row.className = "gfp-status-actions";
          row.appendChild(open);
          body.appendChild(row);
        }
      } else if (tab.editing) {
        body.appendChild(buildEditor(tab));
      } else if (tab.kind === "image" && tab.dataUrl) {
        const image = doc.createElement("img");
        image.src = tab.dataUrl;
        image.alt = tab.relPath;
        body.appendChild(image);
      } else if (tab.kind === "markdown" && tab.mode === "preview") {
        const markdown = doc.createElement("div");
        markdown.className = "gfp-markdown desk-ft-md files-browse-md";
        markdown.innerHTML = renderMarkdown(tab.draftText);
        // A relative link in a rendered README points at a file in this
        // workspace, not at a URL. Left alone the browser navigates away from
        // the app entirely — on a remote client, to the relay's 404. Open it
        // here instead; links that are genuinely external fall through to the
        // browser untouched (see resolveMarkdownLink).
        markdown.addEventListener("click", (event) => {
          const node = event.target;
          const anchor = node && node.closest ? node.closest("a[href]") : null;
          if (!anchor || !markdown.contains(anchor)) return;
          const target = resolveMarkdownLink(tab.relPath, anchor.getAttribute("href"));
          if (!target) return;
          event.preventDefault();
          void openFile(target);
        });
        body.appendChild(markdown);
      } else {
        const pre = doc.createElement("pre");
        paintCode(pre, tab.draftText, tab.relPath);
        body.appendChild(pre);
      }
      viewer.appendChild(body);
      // Put the caret back where the repaint found it.
      if (carry) {
        const next = viewer.querySelector(".gfp-editor");
        if (next) {
          try {
            next.setSelectionRange(carry.start, carry.end);
            next.scrollTop = carry.scrollTop;
          } catch (_) { /* a non-text control has no selection range */ }
          if (carry.focused) next.focus({ preventScroll: true });
        }
      }
    }

    function renderViewerActions(head, tab) {
      // Right-end group: Cancel / Save (text buttons) and ⋯ (bar-icon).
      // margin-left:auto on this node parks them at the toolbar's trailing edge.
      const end = doc.createElement("div");
      end.className = "gfp-viewer-end";
      if (EDITABLE_KINDS.has(tab.kind) && access.write && tab.stamp && tab.expectedAbsPath) {
        if (tab.kind === "markdown") {
          // Modes are a segmented control (`.gfp-seg`), not bar-icons. A
          // worded toggle made Markdown the odd one out beside the pencil
          // every other text file gets; an accent-underline on a bar-icon
          // pair read as two actions rather than one chosen mode.
          const seg = doc.createElement("div");
          seg.className = "gfp-seg";
          seg.setAttribute("role", "group");
          seg.setAttribute("aria-label", "View mode");
          const modeButton = (icon, label, mode) => {
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "gfp-seg-btn gfp-mode files-browse-action";
            // "Edit source" IS Markdown's edit control, so it keeps the class
            // every other text file's pencil carries. One selector means
            // "the control that puts this file into edit mode", whatever the
            // file type — which is what callers and tests actually want.
            if (mode === "code") button.classList.add("gfp-edit");
            if (tab.mode === mode) button.classList.add("gfp-seg-on");
            button.innerHTML = icon;
            button.title = label;
            button.setAttribute("aria-label", label);
            button.setAttribute("aria-pressed", String(tab.mode === mode));
            button.addEventListener("click", () => {
              tab.mode = mode;
              tab.editing = mode === "code";
              if (mode === "code") {
                tab.notice = "";
                tab.conflict = false;
              }
              renderViewer();
              const editor = viewer.querySelector(".gfp-editor");
              if (editor) editor.focus();
            });
            return button;
          };
          seg.appendChild(modeButton(ICON.preview, "Preview", "preview"));
          seg.appendChild(modeButton(ICON.code, "Edit source", "code"));
          head.appendChild(seg);
        } else if (!tab.editing) {
          const edit = actionButton("", "", () => {
            tab.editing = true;
            tab.notice = "";
            tab.conflict = false;
            renderViewer();
            const editor = viewer.querySelector(".gfp-editor");
            if (editor) editor.focus();
          });
          edit.classList.add("gfp-edit", "files-browse-action");
          edit.innerHTML = ICON.pencil;
          edit.title = "Edit file";
          edit.setAttribute("aria-label", "Edit file");
          head.appendChild(edit);
        }
        if (tab.editing) {
          const cancel = actionButton("Cancel", "", () => void cancelChanges(tab));
          cancel.classList.add("gfp-cancel", "files-browse-action");
          cancel.disabled = tab.saving;
          const save = actionButton(tab.saving ? "Saving…" : "Save", "primary", () => void saveTab(tab));
          save.classList.add("gfp-save", "files-browse-action", "files-browse-action-primary");
          save.disabled = tab.saving || !tab.dirty;
          end.append(cancel, save);
        }
      }
      const more = actionButton("", "", () => openRowMenu(more, { relPath: tab.relPath, kind: "file", name: fileName(tab.relPath) }));
      more.classList.add("gfp-more");
      more.classList.add("desk-ft-open-ext");
      more.innerHTML = ICON.more;
      more.title = "More actions";
      more.setAttribute("aria-label", "More actions");
      end.appendChild(more);
      if (end.childNodes.length) head.appendChild(end);
    }

    function patchDirtyUi(tab) {
      const save = viewer.querySelector(".gfp-save");
      if (save) save.disabled = tab.saving || !tab.dirty;
      const item = tabsEl.querySelector('[data-rel="' + cssEscape(tab.relPath) + '"] .gfp-tab-dirty');
      if (item) item.textContent = tab.dirty ? "•" : "";
      applyStripPlan();
    }

    async function cancelChanges(tab) {
      if (tab.dirty) {
        const answer = await confirmChoice({
          title: "Cancel changes?",
          body: "This discards your unsaved edits and restores the last loaded version.",
          actions: [{ id: "discard", label: "Discard", danger: true }],
        });
        if (answer !== "discard") return false;
      }
      tab.draftText = tab.baselineText;
      tab.dirty = false;
      tab.editing = false;
      tab.conflict = false;
      tab.notice = "";
      renderTabs();
      renderViewer();
      return true;
    }

    /**
     * Whether `tab` is the one actually painted right now.
     *
     * Async work must not repaint the viewer for a tab nobody is looking at:
     * `renderViewer()` rebuilds the live textarea, and takes the caret, the
     * selection and any in-progress IME composition with it. Save A, switch to
     * B, start typing, and A's answer landing would disturb what you are typing
     * in B. `reloadTab` learned this the hard way; keeping the rule in one
     * place is what stops the next awaiting path from having to.
     */
    function isOnScreen(tab) {
      const state = scopes.get(tab.scopeId);
      return !!state
        && currentState === state
        && state.activeRelPath === tab.relPath
        && state.tabs.get(tab.relPath) === tab;
    }

    /** Repaint only what `tab` actually owns on screen. */
    function repaintFor(tab) {
      if (scopes.get(tab.scopeId) === currentState) renderTabs();
      if (isOnScreen(tab)) renderViewer();
    }

    async function saveTab(tab) {
      if (!access.write || !tab.dirty || tab.saving || !tab.stamp || !tab.expectedAbsPath) return false;
      const sentText = tab.draftText;
      const seq = ++tab.saveSeq;
      tab.saving = true;
      tab.sentText = sentText;
      tab.notice = "";
      renderViewer();
      const result = await access.write(tab.scopeId, {
        relPath: tab.relPath,
        text: sentText,
        stamp: tab.stamp,
        expectedAbsPath: tab.expectedAbsPath,
      });
      if (destroyed || tab.saveSeq !== seq) return false;
      if (result && result.ok) {
        applySaveSuccess(tab, sentText, result);
        repaintFor(tab);
        return true;
      }
      tab.saving = false;
      tab.sentText = null;
      if (result && result.reason === "changed") {
        tab.conflict = true;
        tab.notice = "File changed on disk. Reload the host's version, or keep your edits and overwrite.";
      } else if (result && result.reason === "workspace changed") {
        tab.conflict = false;
        tab.notice = "This file is no longer the one you opened. Re-open it from the tree.";
      } else {
        tab.conflict = false;
        tab.notice = result && result.reason || "Save refused.";
      }
      repaintFor(tab);
      return false;
    }

    function renderConflictActions(tab) {
      const actions = doc.createElement("div");
      actions.className = "gfp-conflict-actions files-browse-conflict-actions";
      const reload = actionButton("Reload", "", () => void reloadTab(tab));
      const overwrite = actionButton("Overwrite", "danger", () => void overwriteTab(tab));
      // Reload and Overwrite resolve the SAME conflict in opposite directions,
      // so running both is not a faster way to decide — it is a way to end up
      // with a panel that misreports the file. Click Reload, then Overwrite
      // while the first read is still out, and the write lands while the reload
      // replaces the tab: the panel then shows the host's version, clean, over a
      // file that actually holds the draft, and closing it warns about nothing.
      // Whichever is chosen first owns the conflict until it finishes.
      reload.disabled = overwrite.disabled = !!(tab.reloading || tab.saving);
      actions.append(reload, overwrite);
      viewer.appendChild(actions);
    }

    async function reloadTab(tab) {
      const state = scopes.get(tab.scopeId);
      if (!state || state.tabs.get(tab.relPath) !== tab || tab.reloading) return false;
      // Reload replaces the whole tab with the host's version, so anything typed
      // while the read is in flight would vanish without a word — and on a phone
      // that flight is long enough to type into. The editor is held read-only
      // for the duration instead: Reload means "take the file's version", and
      // the honest way to say that is to stop accepting edits, not to accept
      // them and then drop them.
      tab.reloading = true;
      tab.notice = "Reloading…";
      repaintFor(tab);
      const result = await access.read(tab.scopeId, tab.relPath);
      tab.reloading = false;
      if (destroyed || state.tabs.get(tab.relPath) !== tab) return false;
      if (!result || !result.ok) {
        tab.conflict = false;
        tab.notice = result && result.reason || "Could not reload the current file version.";
        repaintFor(tab);
        return false;
      }
      const fresh = makeTab(tab.scopeId, result);
      state.tabs.set(tab.relPath, fresh);
      repaintFor(fresh);
      return true;
    }

    async function overwriteTab(tab) {
      if (!access.write || tab.saving) return false;
      const state = scopes.get(tab.scopeId);
      if (!state || state.tabs.get(tab.relPath) !== tab) return false;
      tab.saving = true;
      tab.conflict = false;
      tab.notice = "Refreshing version…";
      renderViewer();
      const fresh = await access.read(tab.scopeId, tab.relPath);
      if (destroyed || state.tabs.get(tab.relPath) !== tab) return false;
      if (!fresh || !fresh.ok || !fresh.stamp || !fresh.absPath) {
        tab.saving = false;
        tab.notice = fresh && fresh.reason || "Could not reload the current file version.";
        return renderViewer();
      }
      // Overwrite means “replace the newer bytes of the file I opened.” It may
      // refresh a stamp; it never adopts a different file identity.
      if (fresh.absPath !== tab.expectedAbsPath) {
        tab.saving = false;
        tab.notice = "This file is no longer the one you opened. Re-open it from the tree.";
        return renderViewer();
      }
      tab.stamp = fresh.stamp;
      tab.saving = false;
      // Dirty against what is ON DISK NOW, not against the version this tab was
      // opened at. Overwrite exists precisely because the file moved underneath
      // us, so the opened baseline is the one value that is certainly stale.
      // Comparing against it meant that typing your way back to the opened text
      // during the refresh made the tab read "clean", `saveTab` then refused to
      // run, and the panel showed the older content as saved while the disk kept
      // the newer bytes — and closing it would not have warned.
      if (typeof fresh.text === "string") tab.baselineText = fresh.text;
      tab.dirty = tab.draftText !== tab.baselineText;
      if (!tab.dirty) {
        // The refresh proved the file already holds exactly this text, so there
        // is nothing to overwrite. `saveTab` refuses a clean tab and returns
        // silently, which left "Refreshing version…" on screen forever — an
        // operation that never finished, for the one case where it was already
        // done.
        tab.notice = "Already matches the file on disk.";
        tab.editing = false;
        repaintFor(tab);
        return true;
      }
      return saveTab(tab);
    }

    function actionButton(label, tone, listener) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "gfp-action" + (tone ? " gfp-action-" + tone : "");
      if (!label) button.classList.add("gfp-icon-only");
      button.textContent = label;
      button.addEventListener("click", listener);
      return button;
    }

    function positionMenu(anchor, pointerEvent) {
      // Zoom-corrected and clamped to the viewport.
      //
      // The chat scales with `--chat-zoom`, and body zoom scales VISUAL rects
      // while `position: fixed` top/left are LAYOUT pixels — so a menu placed at
      // a raw `clientX/clientY` lands further off the further you are from the
      // origin, which is what "appears randomly" looks like. `unzoomClientPx`
      // converts between the two and is a no-op at zoom 1.
      //
      // This is the same maths the released desktop panel used and `openRailMenu`
      // in chat.js still uses; the extraction dropped it, along with the flip-up
      // and the bottom clamp, so the menu could also run off the screen.
      const helpers = (win.GrokWebviewHelpers || root.GrokWebviewHelpers || {});
      const zoomOf = typeof helpers.chatZoomFactor === "function" ? helpers.chatZoomFactor : () => 1;
      const unzoom = typeof helpers.unzoomClientPx === "function" ? helpers.unzoomClientPx : (px) => px;
      const z = zoomOf();
      const size = menu.getBoundingClientRect();
      const menuH = unzoom(size.height, z);
      const menuW = unzoom(size.width, z);
      const vh = unzoom(win.innerHeight, z);
      const vw = unzoom(win.innerWidth, z);
      const gap = 4;
      let top;
      let left;
      if (pointerEvent) {
        top = unzoom(pointerEvent.clientY, z);
        left = unzoom(pointerEvent.clientX, z);
        if (top + menuH > vh - 8) top = Math.max(8, vh - menuH - 8);
        if (left + menuW > vw - 8) left = Math.max(8, vw - menuW - 8);
      } else {
        const box = anchor.getBoundingClientRect();
        top = unzoom(box.bottom, z) + gap;
        // Flip above the button rather than off the bottom of the panel.
        if (top + menuH > vh - 8) top = Math.max(8, unzoom(box.top, z) - menuH - gap);
        left = unzoom(box.right, z) - menuW;
        left = Math.max(8, Math.min(left, vw - menuW - 8));
      }
      menu.style.top = Math.round(top) + "px";
      menu.style.left = Math.round(left) + "px";
      menu.style.right = "auto";
    }

    function setMenuAnchorExpanded(anchor, open) {
      if (!anchor || typeof anchor.setAttribute !== "function") return;
      if (String(anchor.tagName || "").toLowerCase() !== "button") return;
      anchor.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function setRowMenuOpen(anchor, open) {
      setMenuAnchorExpanded(anchor, open);
      if (!anchor || typeof anchor.closest !== "function") return;
      const row = anchor.closest(".gfp-row");
      // A context-menu on the row itself uses the row as the anchor — do not
      // pin the ⋯. The ⋯ button is a descendant, so closest is the row and
      // not the row-as-anchor.
      if (!row || row === anchor) return;
      row.classList.toggle("gfp-menu-open", !!open);
    }

    /** True when this click should toggle the open menu rather than dismiss
     *  it from outside. Only a BUTTON (or the chip) counts — a tree row used
     *  as a context-menu origin is too large to treat as the opener. */
    function isOpenMenuAnchor(target) {
      if (!menu || !menuAnchor || !target) return false;
      if (menuAnchor === target) return true;
      if (!menuAnchor.contains || !menuAnchor.contains(target)) return false;
      const tag = String(menuAnchor.tagName || "").toLowerCase();
      return tag === "button";
    }

    /** Shared by every gfp-menu opener: a second click on the same anchor
     *  closes and does not reopen. Returns false when the caller should stop. */
    function beginMenu(anchor) {
      if (menu && menuAnchor === anchor) {
        closeMenu();
        return false;
      }
      closeMenu();
      return true;
    }

    function openRowMenu(anchor, entry, pointerEvent) {
      if (!beginMenu(anchor)) return;
      menu = doc.createElement("div");
      menu.className = "gfp-menu desk-ft-overflow-menu desk-ft-open";
      menu.setAttribute("role", "menu");
      // Folders only: it is the folder's own listing being re-read, and a file
      // row has none. The header control covers the whole tree.
      if (entry.kind === "dir") {
        menu.appendChild(menuItem("Refresh this folder", () => refreshFolder(entry.relPath)));
      }
      if (entry.kind !== "dir" && access.openExternal) {
        menu.appendChild(menuItem("Open in default app", () => access.openExternal(currentScope.id, entry.relPath)));
      }
      if (access.reveal) {
        menu.appendChild(menuItem(ui.revealLabel || "Reveal in file manager", () => access.reveal(currentScope.id, entry.relPath)));
      }
      const rel = relativeCopyPath(entry && entry.relPath);
      if (rel) {
        menu.appendChild(menuItem("Copy relative path", () => copyEntryPath(anchor, rel)));
      }
      const cwd = scopeCwd(currentScope);
      if (cwd) {
        menu.appendChild(menuItem("Copy path", () => copyEntryPath(anchor, joinHostPath(cwd, entry && entry.relPath))));
      }
      if (!menu.childNodes.length) return closeMenu();
      menuAnchor = anchor;
      setRowMenuOpen(anchor, true);
      doc.body.appendChild(menu);
      positionMenu(anchor, pointerEvent);
    }

    function writeClipboard(text) {
      const clip = win.navigator && win.navigator.clipboard;
      if (!clip || typeof clip.writeText !== "function") return Promise.resolve(false);
      return Promise.resolve(clip.writeText(String(text == null ? "" : text)))
        .then(() => true)
        .catch(() => false);
    }

    function flashCopied(anchor) {
      if (!anchor) return;
      const isButton = anchor.classList
        && (anchor.classList.contains("gfp-icon-button") || anchor.classList.contains("gfp-more"));
      const btn = isButton
        ? anchor
        : (anchor.querySelector && anchor.querySelector(".gfp-icon-button, .gfp-more"));
      if (!btn) return;
      const prev = btn.innerHTML;
      btn.innerHTML = ICON.check;
      btn.classList.add("copied");
      btn.dataset.gfpCopied = "1";
      if (copyFlashTimer) win.clearTimeout(copyFlashTimer);
      copyFlashTimer = win.setTimeout(() => {
        copyFlashTimer = null;
        if (btn.dataset.gfpCopied) {
          delete btn.dataset.gfpCopied;
          btn.innerHTML = prev;
        }
        btn.classList.remove("copied");
      }, 1500);
    }

    async function copyEntryPath(anchor, text) {
      const ok = await writeClipboard(text);
      if (ok) flashCopied(anchor);
    }

    function openOverflowMenu(anchor) {
      if (!overflowRelPaths.length || !currentState) return;
      if (!beginMenu(anchor)) return;
      menu = doc.createElement("div");
      menu.className = "gfp-menu gfp-overflow-menu desk-ft-overflow-menu desk-ft-open";
      menu.setAttribute("role", "menu");
      for (const relPath of overflowRelPaths) {
        const tab = currentState.tabs.get(relPath);
        if (!tab) continue;
        menu.appendChild(overflowMenuItem(relPath, tab));
      }
      if (!menu.childNodes.length) return closeMenu();
      menuAnchor = anchor;
      setRowMenuOpen(anchor, true);
      doc.body.appendChild(menu);
      positionMenu(anchor);
    }

    function overflowMenuItem(relPath, tab) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "gfp-menu-item gfp-overflow-item desk-ft-overflow-item";
      button.setAttribute("role", "menuitem");
      const icon = doc.createElement("span");
      icon.className = "gfp-tab-icon";
      renderFileIcon(icon, fileName(relPath), tab.kind === "dir" ? "dir" : "file");
      const name = doc.createElement("span");
      name.className = "gfp-overflow-name";
      name.textContent = fileName(relPath);
      button.append(icon, name);
      if (tab.dirty) {
        const dirty = doc.createElement("span");
        dirty.className = "gfp-overflow-dirty";
        dirty.textContent = "•";
        button.appendChild(dirty);
      }
      button.addEventListener("click", () => {
        closeMenu();
        activateTab(relPath);
      });
      return button;
    }

    function menuItem(label, listener) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "gfp-menu-item desk-ft-overflow-item";
      button.textContent = label;
      button.addEventListener("click", async () => {
        closeMenu();
        await listener();
      });
      return button;
    }

    function closeMenu() {
      setRowMenuOpen(menuAnchor, false);
      if (menu) menu.remove();
      menu = null;
      menuAnchor = null;
      const chip = tabsEl.querySelector(".gfp-overflow-chip");
      if (chip) chip.setAttribute("aria-expanded", "false");
    }

    function statusLine(message, error) {
      const status = doc.createElement("div");
      status.className = "gfp-status desk-ft-empty" + (error ? " gfp-error desk-ft-error" : "");
      status.textContent = message;
      return status;
    }

    /** Replaces whatever the host was showing. Use `statusLine` directly for a
     *  note that belongs BESIDE the content rather than instead of it. */
    function appendStatus(host, message, error) {
      host.textContent = "";
      host.appendChild(statusLine(message, error));
    }

    function confirmClose() {
      if (!anyDirty(scopes)) return Promise.resolve(true);
      return confirmChoice({
        title: "Discard changes?",
        body: "Your edits have not been saved.",
        actions: [{ id: "discard", label: "Discard", danger: true }],
      }).then((answer) => answer === "discard");
    }

    function clearMemory() {
      abortPending();
      scopes.clear();
      currentState = currentScope ? scopeState(currentScope) : null;
      renderedTreeState = null;
      treeMode = true;
      renderTabs();
      showTree();
      if (open && currentState) void loadRootTree();
    }

    function destroy() {
      destroyed = true;
      abortPending();
      closeMenu();
      if (copyFlashTimer) {
        win.clearTimeout(copyFlashTimer);
        copyFlashTimer = null;
      }
      setMaximized(false);
      if (stripObserver) {
        try { stripObserver.disconnect(); } catch (_) { /* noop */ }
        stripObserver = null;
      }
      if (typeof unsubscribeScope === "function") unsubscribeScope();
      win.removeEventListener("beforeunload", beforeUnload);
      win.removeEventListener("resize", applyPresentation);
      win.removeEventListener("keydown", onChromeKey);
      // The `true` must match the registration, or this removes nothing and the
      // listener outlives the panel.
      doc.removeEventListener("click", closeMenuFromOutside, true);
      toggle.remove();
      resizer.remove();
      rootEl.remove();
    }

    function closeMenuFromOutside(event) {
      if (!menu) return;
      if (menu.contains(event.target)) return;
      // The open menu's own button must not be an "outside" click — the
      // opener's handler is about to run and is what toggles. Closing here
      // first made every second click close-and-reopen.
      if (isOpenMenuAnchor(event.target)) return;
      closeMenu();
    }
    // CAPTURE phase. On the bubble phase this ran AFTER the button that opened
    // the menu, saw a click outside the (brand new) menu, and closed it again
    // — so the viewer's "More actions" button did nothing at all on the
    // desktop, silently. The tree's own more-button had been papered over with
    // `stopPropagation`, which fixes one button and leaves the trap set for
    // the next one. On capture, this runs BEFORE any opener: `menu` is still
    // null on the opening click (so it cannot close what has not opened), and
    // on a second click of the same button it skips so `beginMenu` can toggle.
    doc.addEventListener("click", closeMenuFromOutside, true);
    win.addEventListener("resize", applyPresentation);
    function onChromeKey(event) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (menu) {
        closeMenu();
        event.preventDefault();
        return;
      }
      if (!canMaximize || !maximized || !open) return;
      if (doc.getElementById("preview-overlay")) return;
      setMaximized(false);
      event.preventDefault();
    }
    win.addEventListener("keydown", onChromeKey);
    let stripObserver = typeof win.ResizeObserver === "function"
      ? new win.ResizeObserver(() => applyStripShrink())
      : null;
    if (stripObserver) stripObserver.observe(rootEl);
    rootEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        const tab = currentTab();
        if (tab && tab.editing) {
          event.preventDefault();
          void saveTab(tab);
        }
      }
    });

    function beforeUnload(event) {
      if (!anyDirty(scopes)) return;
      event.preventDefault();
      event.returnValue = "";
    }
    win.addEventListener("beforeunload", beforeUnload);

    paintTitle();
    paintMaximize();
    paintRefresh();
    setPanelWidth(options.preferences && options.preferences.getWidth
      ? options.preferences.getWidth() : DEFAULT_WIDTH, true);
    if (typeof access.onScopeChanged === "function") {
      unsubscribeScope = access.onScopeChanged((scope) => void setScope(scope));
    }
    Promise.resolve(access.currentScope()).then((scope) => setScope(scope));

    if (options.initialOpen) setOpen(true);
    else {
      applyPresentation();
      if (typeof options.onOpenChanged === "function") options.onOpenChanged(false);
    }

    return {
      element: rootEl,
      resizer,
      toggleElement: toggle,
      setOpen,
      isOpen: () => open,
      setScope,
      setWidth: setPanelWidth,
      setMaximized,
      isMaximized: () => maximized,
      openPath: openFile,
      hasDirty: () => anyDirty(scopes),
      confirmClose,
      clearMemory,
      destroy,
      _scopes: scopes,
      _applyStripShrink: applyStripPlan,
      _forceStripPlan: (plan) => {
        forcedStripPlan = plan || null;
        applyStripPlan();
      },
      _lastStripPlan: () => lastStripPlan,
    };
  }

  function iconIdFromTable(name, table, fallback) {
    const lower = String(name || "").toLowerCase();
    const dot = lower.lastIndexOf(".");
    const ext = dot >= 0 ? lower.slice(dot + 1) : lower;
    return table && (table[lower] || table[ext]) || fallback || "default";
  }

  function joinUrl(base, leaf) {
    return String(base || "").replace(/\/?$/, "/") + leaf;
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === "function") return root.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Resolve a link written inside a Markdown file to a workspace-relative path,
   * or null when it is not ours to open.
   *
   * A rendered `[auth](_shared/auth.ts)` is a plain `<a href>`, so the browser
   * resolves it against the PAGE — which on a remote client is the relay, and
   * the user lands on `https://<relay>/_shared/auth.ts` instead of the file.
   * That is not a remote-only bug (a webview would resolve it against its own
   * origin too), it is just most visible there.
   *
   * Returns null for anything that is not a workspace file — a scheme
   * (`https:`, `mailto:`), a protocol-relative `//host`, a bare `#fragment` —
   * so the browser keeps handling those normally. A `..` that would climb above
   * the workspace root also returns null rather than a path outside it: the
   * host re-checks containment anyway, but a link should not be the thing that
   * asks.
   */
  function resolveMarkdownLink(fromRelPath, href) {
    if (typeof href !== "string") return null;
    let raw = href.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) {
      return null;
    }
    if (/^file:\/\//i.test(raw)) {
      raw = raw.replace(/^file:\/\//i, "");
      if (/^\/[a-zA-Z]:[/\\]/.test(raw)) raw = raw.slice(1);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return null;
    }
    const clean = raw.split(/[?#]/)[0];
    if (!clean) return null;
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch (_) {
      /* a malformed escape is still a path we can try verbatim */
    }
    // A leading slash means workspace root, not filesystem root.
    const rooted = decoded.charAt(0) === "/" || decoded.charAt(0) === "\\";
    const base = rooted ? [] : String(fromRelPath || "").split(/[\\/]/).slice(0, -1);
    const out = [];
    for (const part of base.concat(decoded.split(/[\\/]/))) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!out.length) return null;
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out.length ? out.join("/") : null;
  }

  const api = {
    createFilePanel,
    resolveMarkdownLink,
    fileName,
    relativeCopyPath,
    scopeCwd,
    joinHostPath,
    scopeKey,
    defaultFileIconId,
    stripShrinkState,
    planStrip,
    STRIP_COMPACT_MAX,
    STRIP_EXTREME_MAX,
    STRIP_CHIP_WIDTH,
    makeTab,
    applyDraft,
    applySaveSuccess,
    anyDirty,
    panelIcon,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GrokFilePanel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
