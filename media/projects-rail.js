// VS Code projects rail — dedicated renderer for the primary-side-bar view.
//
// Deliberately NOT media/chat.js: loading that would create a second chat client
// (ready handshake, tab identity, session ownership). This file only consumes
// catalog host messages and posts the same rail actions the host already handles.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const ICON = {
    // Solid folder marks supplied by the owner (media/icons/folder-*.svg),
    // inlined because the rail sets them with innerHTML. `fill:currentColor`
    // is the change from the originals — it is what lets a project's colour
    // tint them, and what keeps them legible in a light theme.
    folderClosed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 408 408" fill="currentColor" aria-hidden="true"><path d="M372,88.661H206.32l-33-39.24c-0.985-1.184-2.461-1.848-4-1.8H36c-19.956,0.198-36.023,16.443-36,36.4v240c-0.001,19.941,16.06,36.163,36,36.36h336c19.94-0.197,36.001-16.419,36-36.36v-199C408.001,105.08,391.94,88.859,372,88.661z"/></svg>`,
    folderOpen: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -57 511.99973 511" fill="currentColor" aria-hidden="true"><path d="m506.039062 180.988281c-7.78125-12.546875-21.53125-20.046875-36.78125-20.046875h-339.5625c-16.832031 0-32.140624 9.488282-39.011718 24.179688l-89.8125 188.308594c3.390625 13.789062 16.269531 24.089843 31.609375 24.089843h361.269531c15.445312 0 29.5625-8.734375 36.460938-22.554687l77.628906-155.59375c6.128906-12.3125 5.449218-26.660156-1.800782-38.382813zm0 0"/><path d="m72.402344 156.15625c6.863281-14.6875 22.175781-24.179688 39.011718-24.179688h319.753907v-40.898437c0-16.859375-14.222657-30.578125-31.703125-30.578125h-186.445313c-.273437 0-.460937-.070312-.53125-.121094l-33.371093-46.660156c-5.910157-8.277344-15.671876-13.21875-26.101563-13.21875h-121.304687c-17.488282 0-31.710938 13.71875-31.710938 30.578125v276.875zm0 0"/></svg>`,
    plus: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
    // New session. The SAME glyph the chat header's New button uses (ICON.squarePen
    // in media/chat.js) — one action should not have two icons depending on which
    // control you reach it from. The rail's "+" now means only "add a project".
    squarePen: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="m5 17 2-7V5l-2-2h14l-2 2v5l2 7Z"/></svg>`,
    pinFilled: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="m5 17 2-7V5l-2-2h14l-2 2v5l2 7Z" fill="currentColor"/></svg>`,
    ellipsis: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
    pencil: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`,
    archive: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,
    archiveRestore: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h4"/><path d="M20 8v11a2 2 0 0 1-2 2h-4"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/></svg>`,
    chevronRight: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
    chevronDown: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  };

  // The host fetches the expanded depth once; rendering starts at three rows.
  // Keep both values in lockstep with src/projects-rail.ts.
  const RAIL_PREVIEW = 3;
  const RAIL_EXPANDED = 20;
  // Cross-project RECENT is a shorter shortcut list than RAIL_EXPANDED.
  // Keep in lockstep with RAIL_RECENT_CAP in src/projects-rail.ts.
  const RECENT_CAP = 10;
  const RAIL_RECENT_KEY = "__recent__";
  // The same age rule the desktop/browser rail applies (media/chat.js). Without
  // it VS Code showed every project Grok has ever run in, forever — which for
  // anyone with a few years of history is a mess rather than a list.
  const RAIL_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
  // A floor, and a requirement rather than a rounding error: however quiet
  // things have been, the newest few stay in view. Coming back from a month away
  // would otherwise archive everything at once and read as broken.
  const RAIL_ALWAYS_VISIBLE = 3;

  /** Palette the host accepts — ids match REPO_COLOR_IDS in sessions.ts. */
  const REPO_COLOR_SWATCHES = [
    { id: "", label: "None" },
    { id: "blue", label: "Blue" },
    { id: "teal", label: "Teal" },
    { id: "green", label: "Green" },
    { id: "amber", label: "Amber" },
    { id: "coral", label: "Coral" },
    { id: "purple", label: "Purple" },
  ];

  const savedRailShape = loadRailShape();

  const state = {
    repos: [],
    currentCwd: "",
    /**
     * The folder the EDITOR has open. Since history follows the rail, this is
     * NOT the same as `currentCwd` (the selection): you can be working in
     * grok-build with the window still open on Editor. The "Your IDE" marker and
     * the top slot belong to THIS one — the selection is shown by the active
     * conversation, not by pinning a project.
     */
    workspaceCwd: "",
    activeCwd: "",
    activeSessionId: null,
    /** Sessions for the SELECTED project (from `sessions`) — which is the open
     *  workspace folder until you pick another one in this rail. */
    currentSessions: [],
    currentSessionsKnown: false,
    /** cwd-key → { entries, dots, total } from `repoSessions`. */
    previews: {},
    previewsAsked: {},
    pinnedSessions: [],
    pinnedKnown: false,
    showProviderGlyphs: false,
    dots: {},
    filter: "",
    /** cwd-key → true when collapsed. Repositories start expanded. */
    collapsed: savedRailShape.collapsed,
    /** cwd-key / synthetic list key -> true after Show more. */
    expanded: savedRailShape.expanded,
    /** Pinned is intentionally absent: it is the one static group. */
    groupCollapsed: savedRailShape.groupCollapsed,
    /**
     * Whether the host answers `addProjectFolder`. Carried on the `repos` frame
     * because this view is resolved on its own and gets no `initialState`, so it
     * has no `capabilities` to read — field presence, never a version. A host
     * that omits it gets no button, which is the safe way round.
     */
    canAddProject: false,
    /**
     * The other two ways in, on the same `repos` channel and for the same
     * reason. Absent on an older host, which then offers the picker alone.
     */
    canCreateProject: false,
    canCloneProject: false,
    /** Global "Use this app for". Coding gains Clone from GitHub; nothing is
     *  ever taken away by a mode. Absent on an older host = Knowledge work. */
    appPurpose: "knowledge",
    /** Display form of the one directory new projects land in (`~/Grok Build`),
     *  from `projectSetup`. The form shows the destination as you type. */
    projectRoot: "",
    projectGithub: null,
    githubState: null,
    githubRepos: null,
  };

  let menuEl = null;
  let colorPickerEl = null;

  /**
   * Identity key for a project cwd. Mirrors `cwdKey` in media/chat.js and
   * `railRepoKey` in src/projects-rail.ts — this file had it wrong.
   *
   * An absolute POSIX path keeps its case and its characters. `/work/App` and
   * `/work/app` are two directories on Linux, and a backslash is a legal
   * filename character there, so folding either merged real projects: one could
   * vanish as a "duplicate" of Current, and when both rendered their preview
   * caches collided and whichever answer landed last put one project's
   * conversations under the other. Only a Windows-shaped path is folded, where
   * `C:\Repo` and `c:/repo` genuinely are the same place.
   */
  function cwdKey(cwd) {
    const raw = String(cwd || "");
    if (raw.charAt(0) === "/") return raw.replace(/\/+$/, "");
    return raw.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  }

  function sameCwd(a, b) {
    if (!a || !b) return false;
    return cwdKey(a) === cwdKey(b);
  }

  // Same contract as createPendingOverlay in webview-helpers.js. The VS Code
  // rail is a standalone webview and does not load that file, so the helper
  // is inlined; keep the two in lockstep.
  function createPendingOverlay(opts) {
    const helpers = typeof globalThis !== "undefined" ? globalThis.GrokWebviewHelpers : null;
    if (helpers && typeof helpers.createPendingOverlay === "function") {
      return helpers.createPendingOverlay(opts);
    }
    const onExpire = opts && typeof opts.onExpire === "function" ? opts.onExpire : null;
    let pending = null;
    let timer = null;
    function resolveTimeout() {
      if (opts && typeof opts.timeoutMs === "function") {
        const n = Number(opts.timeoutMs());
        return n > 0 ? n : 8000;
      }
      if (opts && Number(opts.timeoutMs) > 0) return Number(opts.timeoutMs);
      return 8000;
    }
    function clearTimer() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    }
    function expire() {
      timer = null;
      if (!pending) return;
      pending = null;
      if (onExpire) onExpire();
    }
    return {
      paint(key, value) {
        clearTimer();
        pending = { key: String(key), value };
        timer = setTimeout(expire, resolveTimeout());
      },
      valueFor(key) {
        if (key == null || !pending || pending.key !== String(key)) return undefined;
        return pending.value;
      },
      has(key) {
        return !!(pending && key != null && pending.key === String(key));
      },
      peek() {
        return pending;
      },
      settle(key) {
        if (!pending || key == null || pending.key !== String(key)) return false;
        clearTimer();
        pending = null;
        return true;
      },
      settleAny(keys) {
        if (!pending) return false;
        for (const key of keys || []) {
          if (key != null && pending.key === String(key)) {
            clearTimer();
            pending = null;
            return true;
          }
        }
        return false;
      },
      clear() {
        clearTimer();
        pending = null;
      },
    };
  }

  const pendingRepoColor = createPendingOverlay({
    onExpire() { render(); },
  });
  const pendingRename = createPendingOverlay({
    onExpire() { render(); },
  });

  function repoColorOf(repo) {
    const painted = pendingRepoColor.valueFor(cwdKey(repo && repo.cwd));
    if (painted !== undefined) return painted;
    return typeof repo?.color === "string" ? repo.color : "";
  }

  function sessionRowName(s) {
    const painted = s && pendingRename.valueFor(s.id);
    if (painted !== undefined) return painted || "Untitled";
    return (s && s.displayName) || "Untitled";
  }

  function paintPendingRepoColor(cwd, color) {
    pendingRepoColor.paint(cwdKey(cwd), color);
    render();
  }

  function paintPendingRename(id, name) {
    if (!id) return;
    pendingRename.paint(id, name);
    render();
  }

  function settlePendingRepoColor(entries) {
    pendingRepoColor.settleAny((entries || []).map((r) => r && cwdKey(r.cwd)).filter(Boolean));
  }

  function settlePendingRename(entries) {
    pendingRename.settleAny((entries || []).map((e) => e && e.id).filter(Boolean));
  }

  function uniqueSessionRows(entries) {
    const byId = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !entry.id || byId.has(entry.id)) continue;
      byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  function defaultGroupCollapsed() {
    return { recent: true, projects: false, archived: true };
  }

  function trueMap(value) {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const key of Object.keys(value)) {
      if (value[key] === true) out[key] = true;
    }
    return out;
  }

  function loadRailShape() {
    const fallback = {
      collapsed: {},
      expanded: {},
      groupCollapsed: defaultGroupCollapsed(),
    };
    try {
      if (typeof vscode.getState !== "function") return fallback;
      const saved = vscode.getState();
      const shape = saved && typeof saved === "object" ? saved.railShape : null;
      if (!shape || typeof shape !== "object" || Array.isArray(shape)) return fallback;
      const groupCollapsed = defaultGroupCollapsed();
      if (shape.groupCollapsed && typeof shape.groupCollapsed === "object") {
        for (const key of Object.keys(groupCollapsed)) {
          if (typeof shape.groupCollapsed[key] === "boolean") {
            groupCollapsed[key] = shape.groupCollapsed[key];
          }
        }
      }
      return {
        collapsed: trueMap(shape.collapsed),
        expanded: trueMap(shape.expanded),
        groupCollapsed,
      };
    } catch (_) {
      return fallback;
    }
  }

  function saveRailShape() {
    if (typeof vscode.setState !== "function") return;
    try {
      const previous = typeof vscode.getState === "function" ? vscode.getState() : null;
      vscode.setState(Object.assign({}, previous && typeof previous === "object" ? previous : {}, {
        railShape: {
          collapsed: state.collapsed,
          expanded: state.expanded,
          groupCollapsed: state.groupCollapsed,
        },
      }));
    } catch (_) { /* Webview state is a convenience; rendering still works without it. */ }
  }

  function leaf(cwd) {
    const parts = String(cwd || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd || "";
  }

  function matchesFilter(text) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return String(text || "").toLowerCase().includes(q);
  }

  function partitionRepos() {
    // No fallback needed when the open folder has no Grok history yet: the host
    // passes it to discoverRepos as a trusted cwd, which adds a catalog row for
    // it (updatedAt 0). The current project is therefore always present here.
    const current = state.repos.find((r) => sameCwd(r.cwd, state.workspaceCwd));
    const other = state.repos
      .filter((r) => !sameCwd(r.cwd, state.workspaceCwd))
      .slice()
      .sort((a, b) => {
        const la = (a.label || leaf(a.cwd)).toLowerCase();
        const lb = (b.label || leaf(b.cwd)).toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
      });
    return { current, other };
  }

  function applyDot(el, dot) {
    if (!el) return;
    const d = dot || "none";
    el.dataset.dot = d === "none" || !d ? "" : d;
  }

  // Provider marks from Lobe Icons (MIT), adapted to inherit currentColor.
  const PROVIDER_LOGO_PATHS = {
    grok: "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815",
    codex: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
    claude: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
  };

  function makeProviderGlyph(provider, dot, sessionId) {
    const id = provider === "codex" || provider === "claude" ? provider : "grok";
    const glyph = document.createElement("span");
    glyph.className = "provider-glyph provider-" + id;
    glyph.title = id === "codex" ? "Codex" : id === "claude" ? "Claude" : "Grok";
    glyph.setAttribute("aria-label", glyph.title);
    glyph.innerHTML = `<svg class="provider-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${PROVIDER_LOGO_PATHS[id]}"></path></svg>`;
    const badge = document.createElement("span");
    badge.className = "provider-status-badge";
    badge.setAttribute("data-session-dot", sessionId);
    applyDot(badge, dot);
    glyph.appendChild(badge);
    return glyph;
  }

  function closeColorPicker() {
    if (colorPickerEl) {
      colorPickerEl.remove();
      colorPickerEl = null;
    }
  }

  /** Drop the action menu only. Colour picker is separate so "Set color" can
   *  close the menu and open the swatch grid in one click without the second
   *  step immediately dismissing itself. */
  function closeMenuOnly() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function closeMenu() {
    closeMenuOnly();
    closeColorPicker();
  }

  // A click somewhere else in VS Code never reaches this document, so a menu
  // opened here had no way to learn it had been left behind. Losing focus is
  // that signal; so is the pointer wandering well away from the popup.
  window.addEventListener("blur", closeMenu);
  document.addEventListener("mouseleave", closeMenu);
  // Walking away closes it — but only once you have actually been ON it.
  //
  // Without that condition the rule fires against a popup the pointer has not
  // reached yet, which is how a menu could vanish on the way to it: open one
  // anchored to the ⋯ button at the right of a WIDE rail, and the cursor that
  // clicked further left is already outside the radius. Requiring an entry
  // first means "leaving" is something you can only do after arriving.
  let pointerEnteredPopup = false;
  document.addEventListener("mousemove", (e) => {
    const el = menuEl || colorPickerEl;
    if (!el) {
      pointerEnteredPopup = false;
      return;
    }
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
    const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance === 0) pointerEnteredPopup = true;
    else if (pointerEnteredPopup && distance > 50) closeMenu();
  });

  /**
   * In-page confirm / prompt.
   *
   * `window.confirm` and `window.prompt` DO NOTHING in a VS Code webview — they
   * are disabled outright, return undefined, and take the caller's "cancelled"
   * branch. Rename, Delete, Clear all history and Hide project were all wired to
   * them, so every one of those menu items silently did nothing. That is why the
   * rail looked like it was ignoring the context menu.
   *
   * Resolves to the typed string for a prompt, true/false for a confirm.
   */
  function railDialog(opts) {
    return new Promise((resolve) => {
      closeMenu();
      const scrim = document.createElement("div");
      scrim.className = "rail-dialog-scrim";
      const box = document.createElement("div");
      box.className = "rail-dialog";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");

      const title = document.createElement("div");
      title.className = "rail-dialog-title";
      title.textContent = opts.title;
      box.appendChild(title);

      if (opts.body) {
        const body = document.createElement("div");
        body.className = "rail-dialog-body";
        body.textContent = opts.body;
        box.appendChild(body);
      }

      let input = null;
      if (opts.input !== undefined) {
        input = document.createElement("input");
        input.type = "text";
        input.className = "rail-dialog-input";
        input.value = opts.input || "";
        box.appendChild(input);
      }

      const actions = document.createElement("div");
      actions.className = "rail-dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "rail-dialog-btn";
      cancel.textContent = "Cancel";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "rail-dialog-btn rail-dialog-primary" + (opts.danger ? " rail-dialog-danger" : "");
      ok.textContent = opts.confirmLabel || "OK";
      actions.appendChild(cancel);
      actions.appendChild(ok);
      box.appendChild(actions);
      scrim.appendChild(box);
      document.body.appendChild(scrim);

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        scrim.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const accept = () => finish(input ? input.value : true);
      const dismiss = () => finish(input ? null : false);
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); dismiss(); }
        else if (e.key === "Enter" && input) { e.preventDefault(); accept(); }
      }
      document.addEventListener("keydown", onKey, true);
      cancel.addEventListener("click", dismiss);
      ok.addEventListener("click", accept);
      scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) dismiss(); });
      if (input) { input.focus(); input.select(); } else ok.focus();
    });
  }

  function placePopover(el, anchor, at) {
    const rect = anchor.getBoundingClientRect();
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    const anchorTop = at ? at.y : rect.top;
    let left = at ? at.x : rect.right - mw;
    let top = (at ? at.y : rect.bottom) + 2;
    left = Math.max(4, Math.min(left, window.innerWidth - mw - 4));
    if (top + mh > window.innerHeight - 4) top = Math.max(4, anchorTop - mh - 2);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  /** Where the menu stood when an item was chosen — see the item's onclick. */
  let lastMenuRect = null;

  function openMenu(anchor, items, at) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "rail-menu";
    menu.setAttribute("role", "menu");
    for (const item of items) {
      if (item === null) {
        const sep = document.createElement("div");
        sep.className = "rail-menu-sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-menu-item" + (item.danger ? " danger" : "");
      btn.setAttribute("role", "menuitem");
      btn.disabled = !!item.disabled;
      if (item.title) btn.title = item.title;
      // Icon and a second line are optional and only the Add project menu uses
      // them: its three entries differ by a verb, and "New project" against
      // "Import a folder" is not self-explanatory until you have used both.
      if (item.icon || item.description) {
        btn.classList.add("rail-menu-item-rich");
        btn.innerHTML = `<span class="rail-menu-icon">${item.icon || ""}</span>` +
          `<span class="rail-menu-text"><span class="rail-menu-label"></span><small class="rail-menu-desc"></small></span>`;
        btn.querySelector(".rail-menu-label").textContent = item.label;
        btn.querySelector(".rail-menu-desc").textContent = item.description || "";
      } else {
        btn.textContent = item.label;
      }
      btn.onclick = (e) => {
        e.stopPropagation();
        // Where the MENU was, for whatever replaces it. A submenu anchored to
        // the ⋯ button instead reopens at the right edge of the rail, which on
        // a wide one is nowhere near the item just clicked — it reads as the
        // popup jumping away, and then walking after it dismisses it.
        lastMenuRect = menuEl ? menuEl.getBoundingClientRect() : null;
        // Menu only — onSelect may open the colour picker next.
        closeMenuOnly();
        if (!item.disabled && item.onSelect) item.onSelect();
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    menuEl = menu;
    placePopover(menu, anchor, at);
  }

  // Match the desktop rail's second menu route without hijacking touch long-press.
  function wireRowContextMenu(row, getAnchor, getItems) {
    if (!row || !window.matchMedia || !window.matchMedia("(hover: hover)").matches) return;
    row.addEventListener("contextmenu", (e) => {
      const anchor = getAnchor();
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(anchor, getItems(), { x: e.clientX, y: e.clientY });
    });
  }

  /**
   * Six hues + empty "none". Host-persisted via setRepoColor; capability-gated
   * by colorSupported (field presence on catalog rows, never a version check).
   */
  function openColorPicker(anchor, repo, at) {
    closeColorPicker();
    if (!anchor || !repo) return;
    const current = repoColorOf(repo);
    const picker = document.createElement("div");
    picker.className = "rail-color-picker";
    picker.setAttribute("role", "listbox");
    picker.setAttribute("aria-label", "Project color");
    for (const sw of REPO_COLOR_SWATCHES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "rail-color-swatch" +
        (sw.id ? "" : " is-none") +
        (sw.id === current ? " is-selected" : "");
      if (sw.id) btn.dataset.repoColor = sw.id;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-label", sw.label);
      btn.setAttribute("aria-selected", sw.id === current ? "true" : "false");
      btn.title = sw.label;
      btn.onclick = (e) => {
        e.stopPropagation();
        closeColorPicker();
        // Skip a no-op write: re-picking the current colour should not churn the catalog.
        if (sw.id === current) return;
        vscode.postMessage({ type: "setRepoColor", cwd: repo.cwd, color: sw.id });
        // Paint now. The next `repos` frame that names this cwd is the
        // authority — confirm, contradict, or a silent host's expiry.
        paintPendingRepoColor(repo.cwd, sw.id);
      };
      picker.appendChild(btn);
    }
    document.body.appendChild(picker);
    colorPickerEl = picker;
    // Open over the menu it replaced when we know where that was, so the
    // swatches appear under the pointer rather than back at the ⋯ button.
    placePopover(picker, anchor, at ? { x: at.left, y: at.top } : undefined);
  }

  document.addEventListener("click", (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    else if (colorPickerEl && !colorPickerEl.contains(e.target)) closeColorPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  function requestPreviews() {
    for (const r of state.repos) {
      if (sameCwd(r.cwd, state.currentCwd)) continue;
      if (!r.available) continue;
      const key = cwdKey(r.cwd);
      if (state.previewsAsked[key]) continue;
      state.previewsAsked[key] = true;
      vscode.postMessage({ type: "listRepoSessions", cwd: r.cwd, limit: RAIL_EXPANDED });
    }
  }

  function sessionsForRepo(repo) {
    if (sameCwd(repo.cwd, state.currentCwd)) {
      return {
        entries: state.currentSessions,
        known: state.currentSessionsKnown,
      };
    }
    const hit = state.previews[cwdKey(repo.cwd)];
    if (!hit) return { entries: [], known: false };
    return { entries: hit.entries || [], known: true };
  }

  /**
   * Whether the host can store a project folder colour. Same capability rule as
   * archive / pinnedSessions: `color` is present (even as `""`) on every row from
   * a host that knows about it, and omitted entirely by one that does not.
   */
  function colorSupported() {
    return state.repos.some((r) => typeof r.color === "string");
  }

  /**
   * Most-recent conversations across every loaded project + pinned rows.
   * Mirrors collectRecentSessions in src/projects-rail.ts (RECENT_CAP).
   * Duplication with PINNED / project lists is intentional — a shortcut.
   */
  function recentRows() {
    const byId = new Map();
    if (state.currentSessionsKnown) {
      for (const s of state.currentSessions) {
        if (s && s.id) byId.set(s.id, s);
      }
    }
    for (const key of Object.keys(state.previews)) {
      const entries = state.previews[key].entries || [];
      for (const s of entries) {
        if (s && s.id) byId.set(s.id, s);
      }
    }
    if (state.pinnedKnown) {
      for (const s of state.pinnedSessions || []) {
        if (!s || !s.id) continue;
        const prev = byId.get(s.id);
        byId.set(s.id, prev ? Object.assign({}, prev, s) : s);
      }
    }
    return [...byId.values()]
      .sort(
        (a, b) =>
          (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) ||
          String(b.id || "").localeCompare(String(a.id || "")),
      )
      .slice(0, RECENT_CAP);
  }

  /**
   * Carry the pointer's hover across a wholesale rebuild.
   *
   * `render()` empties #rail-scroll and builds it again, and one boot does that
   * a dozen times or more as each project's rows arrive. The browser recomputes
   * :hover only AFTER the lifecycle that paints the new nodes, so the row under
   * a cursor that never moved paints WITHOUT its hover fill and without its
   * action buttons for one frame, every time — which is the blinking the owner
   * saw while the rail loaded. .rail-rebuilding only silenced the fade; the
   * frame at the wrong state was still painted.
   *
   * So find the row the pointer is over in the same task that builds it and mark
   * it, before anything is painted. The mark is dropped on the next real pointer
   * move, which is exactly when :hover becomes authoritative again.
   */
  let railPointer = null;
  let railHoverHeld = null;

  function dropHoverHold() {
    if (railHoverHeld) railHoverHeld.classList.remove("rail-hover-hold");
    railHoverHeld = null;
  }

  function holdHoverAfterRebuild() {
    dropHoverHold();
    if (!railPointer || typeof document.elementFromPoint !== "function") return;
    const at = document.elementFromPoint(railPointer.x, railPointer.y);
    const row = at && at.closest ? at.closest(".rail-session, .rail-repo-head") : null;
    if (!row) return;
    row.classList.add("rail-hover-hold");
    railHoverHeld = row;
  }

  document.addEventListener("pointermove", (e) => {
    railPointer = { x: e.clientX, y: e.clientY };
    dropHoverHold();
  }, true);
  // Leaving the window (or a touch ending) means there is no pointer to carry.
  // documentElement, and NOT capturing: pointerleave does not bubble, but a
  // capturing listener on document would still see the copy fired at every row
  // the pointer crosses, and switch the carry off on the first move.
  document.documentElement.addEventListener("pointerleave", () => { railPointer = null; dropHoverHold(); });
  document.addEventListener("pointercancel", () => { railPointer = null; dropHoverHold(); }, true);

  function render() {
    const root = document.getElementById("rail-scroll");
    if (!root) return;
    root.classList.add("rail-rebuilding");
    root.innerHTML = "";
    closeMenu();

    const q = state.filter.trim();
    let shown = false;

    // Section order matches desktop: PINNED → RECENT → projects → archived.
    // Pinned first when the host has proven it speaks the frame — capability,
    // never a version. An older host that never sends pinnedSessions shows no
    // group rather than an empty one.
    if (state.pinnedKnown) {
      const pinned = uniqueSessionRows(state.pinnedSessions).filter(
        (s) => matchesFilter(s.displayName) || matchesFilter(repoLabelFor(s.cwd)),
      );
      if (pinned.length) {
        root.appendChild(staticGroupHead("Pinned"));
        const list = document.createElement("div");
        list.className = "rail-list rail-pinned";
        for (const s of pinned) {
          list.appendChild(renderSession(s, { cwd: s.cwd, available: true }, { showRepo: true }));
        }
        root.appendChild(list);
        shown = true;
      }
    }

    // RECENT sits above the project list: VS Code has no other cross-project
    // surface, so this is the short cross-project jump list. Duplication with
    // PINNED / projects is intentional — a shortcut, not a partition. Dedupe is
    // PER GROUP only (owner, 2026-08-13): a cross-group claim made a session
    // vanish from under its project while Recent held it.
    const recentAll = recentRows().filter(
      (s) => matchesFilter(s.displayName) || matchesFilter(repoLabelFor(s.cwd)),
    );
    if (recentAll.length) {
      const forcedOpen = !!q;
      const open = forcedOpen || !state.groupCollapsed.recent;
      root.appendChild(collapsibleGroupHead({
        title: "Recent",
        group: "recent",
        open,
        forcedOpenBySearch: forcedOpen,
        openTitle: "Hide recent conversations",
        closedTitle: "Show recent conversations",
        searchTitle: "Open while your search matches a conversation",
      }));
      if (open) {
        const list = document.createElement("div");
        list.className = "rail-list rail-recent";
        appendSessionSlice(list, recentAll, RAIL_RECENT_KEY, (s) =>
          renderSession(s, { cwd: s.cwd, available: true }, { showRepo: true }),
          RECENT_CAP,
        );
        root.appendChild(list);
      }
      shown = true;
    }

    const { current, other } = partitionRepos();
    const { active, archived } = splitByArchive(other);

    // Open folder stays first inside Projects; everything else remains alphabetical.
    const projectRepos = (current ? [current, ...active] : active)
      .filter((r) => !q || repoHasMatch(r));
    if (projectRepos.length) {
      const forcedOpen = !!q;
      const open = forcedOpen || !state.groupCollapsed.projects;
      root.appendChild(collapsibleGroupHead({
        title: "Projects",
        group: "projects",
        open,
        forcedOpenBySearch: forcedOpen,
        openTitle: "Hide projects",
        closedTitle: "Show projects",
        searchTitle: "Open while your search matches a project",
        action: state.canAddProject ? addProjectButton : undefined,
      }));
      if (open) {
        const list = document.createElement("div");
        list.className = "rail-list rail-projects";
        for (const repo of projectRepos) {
          list.appendChild(renderRepo(repo, {
            isCurrent: !!current && sameCwd(repo.cwd, current.cwd),
            inArchive: false,
          }));
        }
        root.appendChild(list);
        // A full-width target under the list, not only the small "+" beside the
        // group title. The owner's reason, and it is about where the eye goes:
        // with one project or none the rail is mostly empty space, and the only
        // way to add another is a 28px glyph in a header. Same control, said
        // where there is room to say it.
        if (state.canAddProject && !q) root.appendChild(addProjectWideButton());
      }
      shown = true;
    }

    const visibleArchived = archived.filter((r) => !q || repoHasMatch(r));
    if (visibleArchived.length) {
      const forcedOpen = !!q;
      const open = forcedOpen || !state.groupCollapsed.archived;
      root.appendChild(collapsibleGroupHead({
        title: "Project Archive",
        group: "archived",
        open,
        forcedOpenBySearch: forcedOpen,
        openTitle: "Hide archived projects",
        closedTitle: "Show archived projects",
        searchTitle: "Open while your search matches an archived project",
      }));
      if (open) {
        const list = document.createElement("div");
        list.className = "rail-list rail-archived";
        for (const repo of visibleArchived) {
          list.appendChild(renderRepo(repo, { isCurrent: false, inArchive: true }));
        }
        root.appendChild(list);
      }
      shown = true;
    }

    if (!shown) {
      const note = document.createElement("div");
      note.className = "rail-note";
      note.textContent = q ? "No matches." : "No projects yet";
      // An empty rail that only says "No projects yet" is a dead end on the one
      // screen where the user has nothing else to click — and with no group
      // heads rendered, the "+" above has nowhere to be.
      if (!q && state.canAddProject) note.appendChild(addProjectWideButton());
      root.appendChild(note);
    }

    holdHoverAfterRebuild();
    requestAnimationFrame(() => root.classList.remove("rail-rebuilding"));
  }

  /**
   * "+ Add project", full width, at button height.
   *
   * ONE builder for both places it appears — under the project list and in the
   * empty rail — because two spellings of the same control is how the two drift
   * into different wording, which has happened here before with the clone hint.
   * It replaces the empty state's text link: a link and a button offering the
   * same action in the same rail is a second mechanism, not a second affordance.
   */
  function addProjectWideButton() {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "rail-add-project-wide";
    const plus = document.createElement("span");
    plus.className = "rail-add-project-wide-plus";
    plus.setAttribute("aria-hidden", "true");
    plus.textContent = "+";
    add.appendChild(plus);
    add.appendChild(document.createTextNode("Add project"));
    add.onclick = () => openAddProjectMenu(add);
    return add;
  }

  function staticGroupHead(title) {
    const head = document.createElement("div");
    head.className = "rail-head";
    const label = document.createElement("span");
    label.className = "rail-head-title";
    label.textContent = title;
    head.appendChild(label);
    return head;
  }

  function collapsibleGroupHead(opts) {
    const head = document.createElement("div");
    head.className = "rail-head rail-head-fold";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-head-btn";
    btn.setAttribute("aria-expanded", String(opts.open));
    if (opts.icon) {
      const icon = document.createElement("span");
      icon.className = "rail-head-icon";
      icon.innerHTML = opts.icon;
      btn.appendChild(icon);
    }
    const titleEl = document.createElement("span");
    titleEl.className = "rail-head-title";
    titleEl.textContent = opts.title;
    btn.appendChild(titleEl);
    const twisty = document.createElement("span");
    twisty.className = "rail-head-twisty";
    twisty.innerHTML = opts.open ? ICON.chevronDown : ICON.chevronRight;
    btn.appendChild(twisty);
    btn.disabled = !!opts.forcedOpenBySearch;
    btn.title = opts.forcedOpenBySearch
      ? opts.searchTitle
      : (opts.open ? opts.openTitle : opts.closedTitle);
    btn.onclick = (e) => {
      e.stopPropagation();
      state.groupCollapsed[opts.group] = opts.open;
      saveRailShape();
      render();
    };
    head.appendChild(btn);
    // Trailing control, outside the fold button so clicking it never folds the
    // group it sits on. Same arrangement as the desktop rail's head.
    if (opts.action) head.appendChild(opts.action());
    return head;
  }

  /**
   * "Add project" — folder picker on the host.
   *
   * VS Code's answer is not the desktop's: the folder is recorded in the rail's
   * own catalog rather than added to the VS Code workspace, because
   * `updateWorkspaceFolders` on a single-folder window converts it to multi-root
   * and restarts the extension host, taking running conversations with it. See
   * EXTRA_PROJECT_FOLDERS_KEY in src/sidebar.ts.
   */
  function addProjectButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-action-btn rail-add-project";
    btn.innerHTML = ICON.plus;
    btn.title = "Add project";
    btn.setAttribute("aria-label", "Add project");
    btn.onclick = (e) => {
      e.stopPropagation();
      openAddProjectMenu(btn);
    };
    return btn;
  }

  const ADD_PROJECT_ICON = {
    "new": `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 10v6M9 13h6"/></svg>`,
    "import": `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>`,
    clone: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 15V9a3 3 0 0 1 3-3h6"/></svg>`,
  };

  /**
   * Add project, this view's copy.
   *
   * The MENU and the FORM are shared with the chat rail (webview-helpers.js) so
   * the two surfaces cannot drift into different wording or different rules;
   * only the popover primitive differs, because these two views have different
   * ones. A host too old to advertise the new entries falls straight through to
   * the picker, with no menu at all.
   */
  function addProjectCaps() {
    return {
      appPurpose: state.appPurpose === "coding" ? "coding" : "knowledge",
      canImport: state.canAddProject,
      canCreate: state.canCreateProject,
      canClone: state.canCloneProject,
    };
  }

  function openAddProjectMenu(anchor) {
    const helpers = window.GrokWebviewHelpers;
    if (!helpers || typeof helpers.addProjectMenuItems !== "function") {
      vscode.postMessage({ type: "addProjectFolder" });
      return;
    }
    const spec = helpers.addProjectMenuItems(addProjectCaps());
    const run = (id) => {
      // Same hint as the chat rail, and the same rule: it acts rather than
      // instructs. This view has no settings overlay of its own, so it asks the
      // host for the editor tab.
      if (id === "import") vscode.postMessage({ type: "addProjectFolder" });
      else openAddProjectForm(id);
    };
    // One way in is a click, not a menu that asks permission to be a click.
    // NONE at all means the host has not said yet — the no-project onboarding
    // card can be on screen before `initialState` lands, and its button has to
    // do something. Falling through to the picker is what it did before.
    if (spec.length <= 1) { run(spec.length ? spec[0].id : "import"); return; }
    openMenu(
      anchor,
      spec.map((item) => ({
        label: item.label,
        description: item.description,
        icon: ADD_PROJECT_ICON[item.id] || "",
        onSelect: () => run(item.id),
      })),
    );
  }

  let addProjectFormApi = null;
  let addProjectFormScrim = null;
  let addProjectFormKeydown = null;

  function closeAddProjectForm() {
    const wasClone = !!(addProjectFormApi && addProjectFormApi.el && addProjectFormApi.el.dataset.kind === "clone");
    if (wasClone) {
      state.projectGithub = null;
      vscode.postMessage({ type: "cancelDeviceLogin", provider: "github" });
    }
    if (addProjectFormScrim) addProjectFormScrim.remove();
    // Capture-phase listener: leaving it attached would swallow Escape in this
    // view for the rest of the window.
    if (addProjectFormKeydown) document.removeEventListener("keydown", addProjectFormKeydown, true);
    addProjectFormKeydown = null;
    addProjectFormScrim = null;
    addProjectFormApi = null;
  }

  function openAddProjectForm(kind) {
    const helpers = window.GrokWebviewHelpers;
    if (!helpers || typeof helpers.addProjectForm !== "function") return;
    closeAddProjectForm();
    closeMenu();
    if (kind === "clone") {
      state.projectGithub = null;
      vscode.postMessage({ type: "cancelDeviceLogin", provider: "github" });
    }
    const api = helpers.addProjectForm({
      kind,
      root: state.projectRoot,
      onSubmit: (value, extra) => {
        vscode.postMessage(
          kind === "clone"
            ? { type: "cloneProject", url: value, ...(extra && extra.name ? { name: extra.name } : {}) }
            : { type: "createProject", name: value },
        );
      },
      onCancel: closeAddProjectForm,
      onFix: (fix) => vscode.postMessage({
        type: "setupGithubCli",
        action: fix === "install-gh" ? "install" : "auth",
      }),
      onConnect: () => vscode.postMessage({ type: "setupGithubCli", action: "auth" }),
      onLoginWithToken: (token) => vscode.postMessage({ type: "githubLoginWithToken", token }),
      onRequestRepos: () => vscode.postMessage({ type: "listGithubRepos" }),
      githubState: state.githubState || undefined,
      repos: state.githubRepos,
      touch: typeof window.matchMedia === "function"
        && window.matchMedia("(hover: none), (pointer: coarse)").matches,
    });
    if (!api) return;
    const scrim = document.createElement("div");
    scrim.className = "add-project-scrim";
    scrim.appendChild(api.el);
    scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) closeAddProjectForm(); });
    document.body.appendChild(scrim);
    addProjectFormScrim = scrim;
    addProjectFormApi = api;
    addProjectFormKeydown = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAddProjectForm();
    };
    document.addEventListener("keydown", addProjectFormKeydown, true);
    api.update({
      root: state.projectRoot,
      githubState: state.githubState || undefined,
      repos: state.githubRepos,
    });
    api.focus();
  }

  // Labels deliberately carry no counts: host totals, loaded rows and the cap
  // can disagree, and a lying digit must never strand a reachable conversation.
  function appendSessionSlice(body, entries, expandKey, rowFactory, expandedLimit = RAIL_EXPANDED) {
    const expanded = !!state.expanded[expandKey];
    const visible = expanded ? expandedLimit : RAIL_PREVIEW;
    const shown = entries.slice(0, visible);
    for (const entry of shown) body.appendChild(rowFactory(entry));
    const reachable = Math.min(entries.length, expandedLimit);
    if (!expanded && reachable > shown.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "rail-more";
      more.textContent = "Show more";
      more.onclick = (e) => {
        e.stopPropagation();
        state.expanded[expandKey] = true;
        saveRailShape();
        render();
      };
      body.appendChild(more);
    } else if (expanded && entries.length > RAIL_PREVIEW) {
      const less = document.createElement("button");
      less.type = "button";
      less.className = "rail-more";
      less.textContent = "Show less";
      less.onclick = (e) => {
        e.stopPropagation();
        delete state.expanded[expandKey];
        saveRailShape();
        render();
      };
      body.appendChild(less);
    }
  }

  /** Newest conversation in a project, or the catalog stamp when unknown. */
  function repoActivity(repo) {
    const { entries, known } = sessionsForRepo(repo);
    if (!known) return Number(repo.updatedAt) || 0;
    let newest = 0;
    for (const s of entries) {
      const at = Number(s && s.updatedAt) || 0;
      if (at > newest) newest = at;
    }
    return newest;
  }

  /**
   * Where a project belongs, counting the age rule — not just the stored flag.
   *
   * Mirrors `railRepoArchived` in media/chat.js, including the parts that look
   * like hedging and are not:
   *  - the folder VS Code has OPEN is never archived. Opening an archived
   *    project brings it straight back out, which is what the owner asked for
   *    and needs no bookkeeping;
   *  - a stored choice stands until the project is worked in again;
   *  - the age rule NEVER runs on a guess. `updatedAt` is the session
   *    directory's mtime and does not move when you continue an existing
   *    conversation, so without the project's own rows we leave it in view
   *    rather than hide one that is in daily use;
   *  - and a project with no conversations at all is archived — there is nothing
   *    for it to have been recent about.
   */
  function repoIsArchived(repo, floorKeys, now) {
    if (sameCwd(repo.cwd, state.workspaceCwd)) return false;
    if (sameCwd(repo.cwd, state.currentCwd)) return false;
    const { known } = sessionsForRepo(repo);
    const at = repoActivity(repo);
    const archivedAt = Number(repo.archivedAt) || 0;
    if (archivedAt > 0 && (!known || archivedAt >= at)) return !!repo.archived;
    if (!known) return !!repo.archived;
    if (floorKeys.has(cwdKey(repo.cwd))) return false;
    return at > 0 ? now - at > RAIL_ARCHIVE_AFTER_MS : true;
  }

  /** Split the catalog into what belongs in Projects and what belongs in the Archive. */
  function splitByArchive(repos) {
    const now = Date.now();
    const byActivity = state.repos.slice().sort((a, b) => repoActivity(b) - repoActivity(a));
    const floorKeys = new Set(
      byActivity
        .filter((r) => !sameCwd(r.cwd, state.workspaceCwd))
        .slice(0, RAIL_ALWAYS_VISIBLE)
        .map((r) => cwdKey(r.cwd)),
    );
    const active = [];
    const archived = [];
    for (const repo of repos) (repoIsArchived(repo, floorKeys, now) ? archived : active).push(repo);
    return { active, archived };
  }

  function repoLabelFor(cwd) {
    const hit = state.repos.find((r) => sameCwd(r.cwd, cwd));
    return hit?.label || leaf(cwd);
  }

  function repoHasMatch(repo) {
    if (matchesFilter(repo.label) || matchesFilter(leaf(repo.cwd))) return true;
    const { entries } = sessionsForRepo(repo);
    return entries.some((s) => matchesFilter(s.displayName));
  }

  function renderRepo(repo, opts) {
    const key = cwdKey(repo.cwd);
    // Repositories start open until the user folds them.
    const expanded = !state.collapsed[key];
    const sec = document.createElement("section");
    sec.className = "rail-repo" + (repo.available === false ? " unavailable" : "") + (expanded ? "" : " collapsed");
    sec.dataset.expanded = expanded ? "1" : "0";
    sec.dataset.cwd = repo.cwd;

    const head = document.createElement("div");
    head.className = "rail-repo-head";
    head.title = repo.cwd;
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", String(expanded));
    head.setAttribute(
      "aria-label",
      (expanded ? "Collapse " : "Expand ") + (repo.label || leaf(repo.cwd)),
    );

    const twisty = document.createElement("span");
    twisty.className = "rail-twisty";
    twisty.innerHTML = expanded ? ICON.folderOpen : ICON.folderClosed;
    twisty.setAttribute("aria-hidden", "true");
    const repoColor = repoColorOf(repo);
    if (repoColor) twisty.dataset.repoColor = repoColor;
    head.appendChild(twisty);

    const name = document.createElement("span");
    name.className = "rail-repo-name";
    const label = document.createElement("span");
    label.className = "rail-repo-label";
    label.textContent = repo.label || leaf(repo.cwd);
    name.appendChild(label);
    if (opts.isCurrent) {
      const currentTag = document.createElement("span");
      currentTag.className = "rail-current-tag";
      currentTag.textContent = "Your IDE";
      // Named for what it IS. "Current" read as "the project you are working
      // in", which is a different thing now that history follows the rail — you
      // can be working in another project entirely while the window stays here.
      currentTag.title = "The folder this VS Code window has open";
      name.appendChild(currentTag);
    }
    head.appendChild(name);

    // Head click folds, and folds only — same as the desktop rail. Switching
    // projects is deliberately NOT bound to it: one gesture that means "fold"
    // on the project you are in and "switch" on the one you are not is two
    // gestures wearing one coat. The explicit routes are the row's "+" (start a
    // conversation there, which switches) and "Open project" in its ⋯ menu.
    const toggle = () => {
      if (expanded) state.collapsed[key] = true;
      else delete state.collapsed[key];
      saveRailShape();
      render();
    };
    head.onclick = (e) => {
      if (e.target.closest(".rail-repo-actions")) return;
      toggle();
    };
    head.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== head) return;
      e.preventDefault();
      head.click();
    };

    const actions = document.createElement("div");
    actions.className = "rail-repo-actions";
    actions.addEventListener("click", (e) => e.stopPropagation());

    // New session on ANY available project. `newSession` carries the cwd now, so
    // the host starts in the project named on the row and moves the selection
    // with it — one message, no reliance on a selectRepo arriving first and
    // being processed before this one.
    if (repo.available !== false) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "rail-action-btn";
      add.innerHTML = ICON.squarePen;
      add.title = "New session";
      add.onclick = (e) => {
        e.stopPropagation();
        // Whatever resume was still in flight is no longer what the user wants.
        cancelPendingResume();
        vscode.postMessage({ type: "newSession", cwd: repo.cwd });
      };
      actions.appendChild(add);
    }

    const archiveSupported = typeof repo.archived === "boolean";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "rail-action-btn";
    menuBtn.innerHTML = ICON.ellipsis;
    menuBtn.title = "Project actions";
    menuBtn.setAttribute("aria-label", menuBtn.title);
    const getMenuItems = () => {
      const items = [];
      // "Hide project" — the same name and the same message the desktop rail
      // uses for the same act, and it posts `removeProjectFolder` there too.
      // Nothing is deleted on either surface: the folder leaves the list, and
      // Add project brings it back.
      //
      // Only on rows that exist because the user added the folder. `added` is
      // set by the host and absent everywhere else, so this is capability by
      // field presence like the rest; every other row is listed because Grok has
      // run there, and archive is how those are put away.
      if (repo.added) {
        items.push({
          label: "Hide project",
          title: "Take this project out of the list. Nothing is deleted — the folder stays on disk, and + adds it back.",
          onSelect: async () => {
            const ok = await railDialog({
              title: `Hide “${repo.label || leaf(repo.cwd)}”?`,
              // The row vanishes from every linked device at once, and a phone
              // editing a file in it loses the route back to its unsaved text.
              // The desk cannot see whether that is happening, so say it first.
              body:
                "Nothing is deleted — the folder stays on disk and Add project brings "
                + "it back. Any conversation still working in it ends. If a linked "
                + "device has this project open, unsaved file edits there are lost.",
              confirmLabel: "Hide",
              danger: true,
            });
            if (ok) vscode.postMessage({ type: "removeProjectFolder", cwd: repo.cwd });
          },
        });
        items.push(null);
      }
      if (archiveSupported) {
        // The verb follows the SECTION this row is drawn in, not the stored
        // flag. Since the age rule arrived those disagree all the time: a
        // project auto-archived for being quiet has no stored flag, and one held
        // in Projects by the always-visible floor may carry `archived: true`. So
        // the menu offered "Move to Projects" on a row already under Projects.
        const inArchive = !!opts.inArchive;
        items.push({
          label: inArchive ? "Move to Projects" : "Archive project",
          title: inArchive
            ? "Show this project under Projects again"
            : "Move this project out of the way. Its conversations stay, and working here brings it back.",
          onSelect: () =>
            vscode.postMessage({
              type: "setRepoArchived",
              cwd: repo.cwd,
              archived: !inArchive,
            }),
        });
        items.push(null);
      }
      // Folder colour — host-persisted, capability-gated the same way as archive
      // (`color` present on catalog rows). Swatch grid, not nested menu, so six
      // hues + none stay one glance away.
      if (colorSupported()) {
        items.push({
          label: "Set color",
          title: "Tint this project's folder icon so it is easy to find",
          onSelect: () => openColorPicker(menuBtn, repo, lastMenuRect),
        });
        items.push(null);
      }
      items.push({
        label: "Clear all history",
        danger: true,
        disabled: repo.available === false,
        onSelect: async () => {
          const ok = await railDialog({
            title: `Clear history for “${repo.label || leaf(repo.cwd)}”?`,
            body: "Every conversation in this project is deleted. This cannot be undone.",
            confirmLabel: "Clear all",
            danger: true,
          });
          if (ok) vscode.postMessage({ type: "clearAllSessions", cwd: repo.cwd });
        },
      });
      return items;
    };
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      openMenu(menuBtn, getMenuItems());
    };
    actions.appendChild(menuBtn);
    head.appendChild(actions);
    wireRowContextMenu(head, () => menuBtn, getMenuItems);
    sec.appendChild(head);

    if (expanded) sec.appendChild(renderSessions(repo));
    return sec;
  }

  function renderSessions(repo) {
    const body = document.createElement("div");
    body.className = "rail-sessions";
    if (repo.available === false) {
      body.appendChild(note("Unavailable"));
      return body;
    }
    const rows = sessionsForRepo(repo);
    const known = rows.known;
    if (!known) {
      body.appendChild(note("Loading…"));
      return body;
    }
    const q = state.filter.trim();
    const repoNameMatched = !q || matchesFilter(repo.label || leaf(repo.cwd));
    if (q && !repoNameMatched) {
      const hits = uniqueSessionRows(rows.entries)
        .filter((s) => matchesFilter(s.displayName))
        .slice(0, RAIL_EXPANDED);
      for (const s of hits) body.appendChild(renderSession(s, repo, {}));
      if (!hits.length) body.appendChild(note("No matches."));
      return body;
    }
    const entries = uniqueSessionRows(rows.entries);
    if (!entries.length) {
      body.appendChild(note("No sessions yet"));
      return body;
    }
    appendSessionSlice(body, entries, cwdKey(repo.cwd), (s) => renderSession(s, repo, {}));
    return body;
  }

  function note(text) {
    const el = document.createElement("div");
    el.className = "rail-note";
    el.textContent = text;
    return el;
  }

  /**
   * Optimistic selection.
   *
   * The desktop rail lives in the SAME document as the chat, so a click can
   * move the highlight itself and be right. Here the rail is a separate
   * webview: the click posts `resumeSession`, the host loads the conversation,
   * and only the frame coming back moved the highlight — a visible dead beat
   * on a loaded machine. So paint it now and reconcile when the host answers.
   *
   * While a resume is in flight, an `activeId` naming some OTHER conversation
   * is stale by definition — it was sent before the click — and applying it
   * would flick the highlight back to where it started.
   */
  let pendingResume = null;
  function markResuming(id) {
    if (!id) return;
    // Chained clicks keep the ORIGINAL selection as the thing to fall back to;
    // the one we painted a moment ago was never real.
    const previous = pendingResume ? pendingResume.previous : state.activeSessionId;
    if (pendingResume) clearTimeout(pendingResume.timer);
    state.activeSessionId = id;
    pendingResume = {
      id,
      previous,
      // A resume that dies without a word — host restart, a session file that
      // vanished — must not leave the highlight on a conversation nobody opened.
      timer: setTimeout(() => {
        if (!pendingResume || pendingResume.id !== id) return;
        pendingResume = null;
        state.activeSessionId = previous;
        render();
      }, 8000),
    };
    render();
  }

  /** Whether a host-sent active id may be written to state. */
  function acceptActiveId(id) {
    if (!pendingResume) return true;
    if (id !== pendingResume.id) return false;
    clearTimeout(pendingResume.timer);
    pendingResume = null;
    return true;
  }

  /**
   * Abandon a pending resume because the user asked for something else.
   *
   * The in-flight rule — ignore any active id that is not the one we are
   * waiting for — is right for a frame that was already on the wire, and wrong
   * the moment a NEW action starts: a conversation created after a resume that
   * failed would have its own identity ignored for the rest of the timeout, and
   * then the timer would put the old highlight back. The newest intent wins.
   */
  function cancelPendingResume() {
    if (!pendingResume) return;
    clearTimeout(pendingResume.timer);
    pendingResume = null;
  }

  function renderSession(s, repo, opts) {
    const row = document.createElement("div");
    const active = !!(state.activeSessionId && s.id === state.activeSessionId);
    row.className = "rail-session" + (active ? " active" : "");
    row.title = sessionRowName(s);
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    if (active) row.setAttribute("aria-current", "true");
    row.dataset.sessionId = s.id || "";

    row.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== row) return;
      e.preventDefault();
      row.click();
    };

    if (state.showProviderGlyphs) {
      row.appendChild(makeProviderGlyph(s.provider, state.dots[s.id], s.id));
    } else {
      const dot = document.createElement("span");
      dot.className = "history-row-dot";
      dot.setAttribute("data-session-dot", s.id);
      applyDot(dot, state.dots[s.id]);
      row.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "rail-session-name";
    label.textContent = sessionRowName(s);
    row.appendChild(label);

    if (opts && opts.showRepo) {
      const where = document.createElement("span");
      where.className = "rail-session-repo";
      where.textContent = repoLabelFor(s.cwd);
      where.title = s.cwd || "";
      row.appendChild(where);
    }

    const isPinned = typeof s.pinnedAt === "number";
    if (isPinned) row.classList.add("pinned");

    const actions = document.createElement("div");
    actions.className = "rail-session-actions";

    if (state.pinnedKnown) {
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "rail-action-btn rail-pin-btn" + (isPinned ? " active" : "");
      pinBtn.innerHTML = isPinned ? ICON.pinFilled : ICON.pin;
      pinBtn.title = isPinned ? "Unpin conversation" : "Pin conversation";
      pinBtn.setAttribute("aria-label", pinBtn.title);
      pinBtn.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: "toggleSessionPin",
          id: s.id,
          cwd: s.cwd || repo.cwd,
          pinned: !isPinned,
        });
      };
      actions.appendChild(pinBtn);
    }

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "rail-action-btn";
    menuBtn.innerHTML = ICON.ellipsis;
    menuBtn.title = "Session actions";
    menuBtn.setAttribute("aria-label", menuBtn.title);
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const cwd = s.cwd || repo.cwd;
      openMenu(menuBtn, [
        {
          label: "Rename",
          onSelect: async () => {
            const next = await railDialog({
              title: "Rename conversation",
              input: s.displayName || "",
              confirmLabel: "Rename",
            });
            if (next == null) return;
            const name = next.trim();
            if (!name || name === s.displayName) return;
            vscode.postMessage({ type: "renameSession", id: s.id, name, cwd });
            paintPendingRename(s.id, name);
          },
        },
        {
          label: isPinned ? "Unpin conversation" : "Pin conversation",
          disabled: !state.pinnedKnown,
          onSelect: () =>
            vscode.postMessage({
              type: "toggleSessionPin",
              id: s.id,
              cwd,
              pinned: !isPinned,
            }),
        },
        null,
        {
          label: "Delete",
          danger: true,
          onSelect: async () => {
            const ok = await railDialog({
              title: `Delete “${s.displayName || "session"}”?`,
              body: "The conversation and its history are removed. This cannot be undone.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (ok) vscode.postMessage({ type: "deleteSession", id: s.id, name: s.displayName, cwd });
          },
        },
      ]);
    };
    actions.appendChild(menuBtn);
    row.appendChild(actions);
    if (window.matchMedia && window.matchMedia("(hover: hover)").matches) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        menuBtn.click();
      });
    }

    // Plain resume — no selectRepo, no window reload. The host already trusts
    // any discovered catalog cwd for local sessions (localTrustedSessionCwds).
    row.onclick = () => {
      if (active) return;
      markResuming(s.id);
      vscode.postMessage({
        type: "resumeSession",
        id: s.id,
        cwd: s.cwd || repo.cwd,
        claim: true,
      });
    };

    return row;
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "providerState":
        state.showProviderGlyphs = Array.isArray(msg.providers) && msg.providers.filter((provider) => provider && provider.connected).length > 1;
        render();
        break;
      case "appPurpose":
        state.appPurpose = msg.value === "coding" ? "coding" : "knowledge";
        break;
      case "projectSetup":
        if (typeof msg.root === "string" && msg.root) state.projectRoot = msg.root;
        // `done` is the only close signal: a failed attempt also stops being
        // busy, and closing on that would throw away the error to be read.
        if (msg.done) {
          state.projectGithub = null;
          closeAddProjectForm();
          break;
        }
        if (msg.busy) state.projectGithub = null;
        else if (addProjectFormApi && msg.github && typeof msg.github === "object") state.projectGithub = msg.github;
        else if (msg.error) state.projectGithub = null;
        if (addProjectFormApi) addProjectFormApi.update({
          ...msg,
          github: state.projectGithub || msg.github,
          githubState: state.githubState || undefined,
          repos: state.githubRepos,
        });
        break;
      case "githubState":
        state.githubState = msg.github && typeof msg.github === "object" ? msg.github : null;
        if (addProjectFormApi) addProjectFormApi.update({ githubState: state.githubState });
        break;
      case "githubRepos":
        state.githubRepos = Array.isArray(msg.repos) ? msg.repos : [];
        if (addProjectFormApi) {
          addProjectFormApi.update({
            repos: state.githubRepos,
            reposTruncated: msg.truncated === true,
            reposError: typeof msg.error === "string" ? msg.error : "",
          });
        }
        break;
      case "repos": {
        const leaving = state.currentCwd;
        state.repos = Array.isArray(msg.entries) ? msg.entries : [];
        settlePendingRepoColor(state.repos);
        state.currentCwd = msg.selectedCwd || "";
        state.activeCwd = msg.activeCwd || "";
        // Older host: no separate workspace root, so fall back to the selection
        // and behave as before rather than losing the marker entirely.
        state.workspaceCwd = msg.workspaceCwd || msg.selectedCwd || "";
        state.canAddProject = msg.canAddProject === true;
        state.canCreateProject = msg.canCreateProject === true;
        state.canCloneProject = msg.canCloneProject === true;
        // Forget projects that have left the catalog — otherwise their rows keep
        // feeding Recent and the search index after they are gone, and the two
        // maps grow for the life of the window.
        //
        // What this deliberately does NOT do is wipe `previewsAsked` wholesale.
        // It used to, so every catalog push re-asked every other project for its
        // rows: measured on a real store that is 18 `listRepoSessions` round
        // trips, each one a session-index pass on the host (~9-30 ms), and
        // `postRepoCatalog()` has 26 call sites — most of which push an
        // unchanged catalog because a selection or a pin moved. A project that
        // is new to the catalog still gets asked, because it has no entry here.
        //
        // Freshness does not depend on the storm. The host re-pushes the
        // affected project's `repoSessions` itself after a rename or a delete
        // (`sendLocalRepoSessionsPreview`, and its comment says why), leaving a
        // project hands its live rows back below, and the selected project is
        // never drawn from this cache at all. The residue is that a project you
        // never visit can show rows from earlier in the window if it was changed
        // from somewhere else — cosmetic, and a reload cures it.
        {
          const live = new Set(state.repos.map((r) => cwdKey(r.cwd)));
          for (const key of Object.keys(state.previewsAsked)) {
            if (!live.has(key)) delete state.previewsAsked[key];
          }
          for (const key of Object.keys(state.previews)) {
            if (!live.has(key)) delete state.previews[key];
          }
        }
        // The selection moved. `currentSessions` still holds the OLD project's
        // rows and the `sessions` frame carries no cwd of its own, so anything
        // rendered between here and its arrival would file A's conversations
        // under B's heading — and stay that way if that refresh never comes
        // (a catalog-only push, or the selected folder disappearing).
        //
        // The rows are not thrown away: they are handed back to the project
        // they belong to, which is where they were always going to be shown.
        if (leaving && !sameCwd(leaving, state.currentCwd)) {
          if (state.currentSessionsKnown) {
            state.previews[cwdKey(leaving)] = {
              entries: state.currentSessions.slice(0, RAIL_EXPANDED),
            };
            state.previewsAsked[cwdKey(leaving)] = true;
          }
          state.currentSessions = [];
          state.currentSessionsKnown = false;
        }
        render();
        requestPreviews();
        break;
      }
      case "sessions": {
        // Local `sessions` is the SELECTED project's list — it used to be the
        // workspace root unconditionally, which is why this frame and
        // `repos.selectedCwd` can be trusted to name the same repo (see
        // historyCwdFor). Rows land under `state.currentCwd` on that basis.
        if (msg.offset === 0 || msg.offset == null) {
          state.currentSessions = uniqueSessionRows(msg.entries);
          state.currentSessionsKnown = true;
          settlePendingRename(state.currentSessions);
          if (msg.activeId != null && acceptActiveId(msg.activeId || null)) {
            state.activeSessionId = msg.activeId || null;
          }
          if (msg.dots && typeof msg.dots === "object") {
            Object.assign(state.dots, msg.dots);
          }
          render();
        }
        break;
      }
      case "repoSessions": {
        const key = cwdKey(msg.cwd);
        state.previews[key] = {
          entries: uniqueSessionRows(msg.entries),
          total: msg.total || 0,
        };
        settlePendingRename(state.previews[key].entries);
        if (msg.dots && typeof msg.dots === "object") {
          Object.assign(state.dots, msg.dots);
        }
        render();
        break;
      }
      case "pinnedSessions": {
        state.pinnedSessions = uniqueSessionRows(msg.entries);
        state.pinnedKnown = true;
        settlePendingRename(state.pinnedSessions);
        if (msg.dots && typeof msg.dots === "object") {
          Object.assign(state.dots, msg.dots);
        }
        render();
        break;
      }
      case "sessionDot": {
        if (msg.id) {
          state.dots[msg.id] = msg.dot;
          const el = document.querySelector(`[data-session-dot="${CSS.escape(msg.id)}"]`);
          applyDot(el, msg.dot);
        }
        break;
      }
      case "session":
      case "sessionName": {
        if (msg.sessionId && acceptActiveId(msg.sessionId)) {
          state.activeSessionId = msg.sessionId;
          render();
        }
        break;
      }
      default:
        break;
    }
  }

  window.addEventListener("message", (e) => onMessage(e.data));

  const search = document.getElementById("rail-search");
  if (search) {
    search.addEventListener("input", () => {
      state.filter = search.value || "";
      render();
    });
  }

  // Export for tests (happy-dom harness).
  window.__grokProjectsRail = {
    state,
    render,
    onMessage,
    partitionRepos,
    sameCwd,
    recentRows,
    colorSupported,
    RAIL_PREVIEW,
    RAIL_EXPANDED,
    RECENT_CAP,
  };

  // Coming back to the rail is a refresh. Conversations move up the Recent list
  // whenever a turn finishes — including turns driven from a phone, which this
  // view never sees — so a rail restored after being hidden is showing an order
  // that stopped being true while it was away. `ready` is the same push the view
  // does on boot: catalog, then previews for every project.
  //
  // Only on the way IN. Firing on hide would ask a view nobody is looking at to
  // rescan every project's session directory.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // THIS is where other projects get re-read, and the only place. Recent ranks
    // by transcript mtime, which moves whenever a turn finishes anywhere —
    // including turns driven from a phone this view never sees — so a rail
    // coming back from hidden is showing a stale order and has earned the
    // rescan. Dropping the asked-set makes the `repos` answer to this `ready`
    // re-probe every project.
    //
    // The catalog handler deliberately does not do this. It runs on every
    // `postRepoCatalog()` — 26 call sites, most of them a selection or a pin
    // moving — and each rescan is one session-index pass per project on the
    // host. Becoming visible is rare and is a real signal; a catalog push is
    // neither.
    state.previewsAsked = {};
    vscode.postMessage({ type: "ready" });
  });

  vscode.postMessage({ type: "ready" });
})();
