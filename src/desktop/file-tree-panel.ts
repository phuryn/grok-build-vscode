/**
 * Desktop mount bootstrap for the shared renderer in `media/file-panel.js`.
 *
 * The executable source injected into Electron is intentionally small. Panel
 * state, rendering, editing, conflicts, tabs, and resizing live in the shared
 * media component used by the remote browser too. Desktop keeps responsibility
 * only for preparing its chat/file dock and adapting preload IPC promises.
 */
/** Minimal open-tab fields retained for callers/tests of the old pure surface. */
export interface DeskFtTabLike {
  dirty: boolean;
  text: string;
  originalText: string;
}

export function anyTabDirty(tabs: Iterable<DeskFtTabLike>): boolean {
  for (const tab of tabs) if (tab.dirty) return true;
  return false;
}

export function revertTabEdits<T extends DeskFtTabLike>(tab: T): T {
  tab.text = tab.originalText;
  tab.dirty = false;
  return tab;
}

export function revealInFolderLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Reveal in Explorer";
  return "Show in file manager";
}

export function tabFileName(relPath: string): string {
  const norm = String(relPath || "").replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : norm || "untitled";
}

/** Kept as an empty compatibility export; CSS now has one source in media/. */
export const FILE_TREE_PANEL_CSS = "";

/**
 * Inject the desktop mount around the already-loaded shared component.
 *
 * The only generated executable left here is host adaptation. Seti lookup data
 * lives in the shared component; SVGs are lazy requests against the component
 * script's sibling `file-icons/` directory.
 */
export function fileTreePanelBootSource(_iconsDir?: string): string {
  const revealLabel = revealInFolderLabel();
  return `(() => {
    const api = window.grokDesktopFileTree;
    const shared = window.GrokFilePanel;
    if (!api || !shared || typeof shared.createFilePanel !== "function") {
      return { ok: false, reason: !api ? "no bridge" : "no shared component" };
    }

    try { window.__grokDeskFilePanel?.destroy?.(); } catch (_) { /* reload */ }
    document.getElementById("desk-ft-top-sep")?.remove();
    document.body.classList.remove("desk-ft-closed", "desk-ft-resizing", "desk-ft-maximized");

    const layoutHost = document.querySelector(".app-main") || document.body;
    let shell = document.getElementById("desk-ft-shell");
    let chat = shell && shell.querySelector(".desk-ft-chat");
    // getHtml already ships the shell so the first frame is rail+files chrome.
    // Reuse it — unwrapping and rebuilding after paint is the boot flash.
    if (!shell || !chat) {
      if (shell) {
        const previousChat = shell.querySelector(".desk-ft-chat");
        const previousHost = shell.parentElement || document.body;
        if (previousChat) {
          while (previousChat.firstChild) previousHost.insertBefore(previousChat.firstChild, shell);
        }
        shell.remove();
      }
      shell = document.createElement("div");
      shell.id = "desk-ft-shell";
      shell.className = "desk-ft-shell";
      chat = document.createElement("div");
      chat.className = "desk-ft-chat";
      for (const child of Array.from(layoutHost.childNodes)) {
        if (child.nodeType !== 1) continue;
        if (child.tagName === "SCRIPT" || child.id === "projects-rail" || child.id === "desk-ft-shell") continue;
        if (child.classList && child.classList.contains("top-bar")) continue;
        chat.appendChild(child);
      }
      shell.appendChild(chat);
      const insertAt = layoutHost.querySelector(":scope > .top-bar") || layoutHost.querySelector(".top-bar");
      if (insertAt && insertAt.parentElement === layoutHost && insertAt.nextSibling) {
        layoutHost.insertBefore(shell, insertAt.nextSibling);
      } else {
        layoutHost.appendChild(shell);
      }
    }
    const topBar = layoutHost.querySelector(":scope > .top-bar") || layoutHost.querySelector(".top-bar");
    document.body.classList.add("desk-with-ft");

    let separator = document.getElementById("desk-ft-top-sep");
    if (!separator && topBar) {
      separator = document.createElement("span");
      separator.id = "desk-ft-top-sep";
      separator.className = "desk-ft-top-sep";
      separator.setAttribute("aria-hidden", "true");
      topBar.appendChild(separator);
    }

    const normalizeRoot = (value) => value && value.ok !== false && value.root
      ? { id: value.root, label: value.name || value.root, title: value.root }
      : null;
    const requireScope = async (scopeId) => {
      const current = normalizeRoot(await api.root());
      return current && current.id === scopeId ? current : null;
    };
    const adapter = {
      currentScope: async () => normalizeRoot(await api.root()),
      onScopeChanged: (listener) => api.onRootChanged(async () => listener(normalizeRoot(await api.root()))),
      list: async (scopeId, relPath) => (await requireScope(scopeId))
        ? api.list(relPath)
        : { ok: false, reason: "workspace changed" },
      read: async (scopeId, relPath) => (await requireScope(scopeId))
        ? api.read(relPath)
        : { ok: false, reason: "workspace changed" },
      write: async (scopeId, request) => (await requireScope(scopeId))
        ? api.save({
            relPath: request.relPath,
            text: request.text,
            stamp: request.stamp,
            absPath: request.expectedAbsPath,
          })
        : { ok: false, reason: "workspace changed" },
      openExternal: async (scopeId, relPath) => (await requireScope(scopeId))
        ? api.open(relPath)
        : { ok: false, reason: "workspace changed" },
      reveal: async (scopeId, relPath) => (await requireScope(scopeId))
        ? api.reveal(relPath)
        : { ok: false, reason: "workspace changed" },
      // The Changes view. Present on the desktop shell and absent on a remote
      // built against an older host, which is exactly how the panel decides
      // whether to draw the button: the affordance exists if the call does.
      gitStatus: async (scopeId) => (await requireScope(scopeId))
        ? api.gitStatus()
        : { ok: false, kind: "failed", reason: "workspace changed" },
      gitDiff: async (scopeId, relPath) => (await requireScope(scopeId))
        ? api.gitDiff(relPath)
        : { ok: false, reason: "workspace changed" },
      gitRun: async (scopeId, request) => (await requireScope(scopeId))
        ? api.gitRun(request)
        : { ok: false, reason: "workspace changed" },
    };

    const componentScript = document.querySelector('script[src*="file-panel.js"]');
    const iconBase = componentScript && componentScript.src
      ? new URL("file-icons/", componentScript.src).href
      : "";
    const panel = shared.createFilePanel({
      access: adapter,
        mount: {
          panelHost: shell,
          toggleHost: topBar,
          presentation: "dock",
          id: "desk-ft-panel",
          viewingBodyClass: "desk-ft-viewing",
          // Content-area maximize. Not persisted. The shared panel hides the
          // control itself while it is an overlay (phone / <900).
          maximize: true,
          elementIds: {
            resizer: "desk-ft-resizer",
            title: "desk-ft-title",
            tabs: "desk-ft-tabs",
            tree: "desk-ft-body",
            viewer: "desk-ft-viewer",
            viewerBody: "desk-ft-viewer-body",
            maximize: "desk-ft-maximize",
          },
        },
      onMaximizedChanged: (max) => {
        document.body.classList.toggle("desk-ft-maximized", !!max);
      },
      ui: {
        confirm: typeof window.__grokFilePanelConfirm === "function"
          ? window.__grokFilePanelConfirm
          : undefined,
        renderMarkdown: typeof window.__grokRenderMarkdown === "function"
          ? window.__grokRenderMarkdown
          : undefined,
        revealLabel: ${JSON.stringify(revealLabel)},
        fileIcons: { baseUrl: iconBase },
      },
      // Same progressive disclosure as the remote client: the Changes button
      // belongs to Coding, not to somebody writing prose. chat.js owns the
      // setting and publishes it on the window, because this bootstrap runs as
      // a separate script and cannot see into that module.
      gitEnabled: () => {
        const read = window.__grokCodingPurpose;
        return typeof read === "function" ? !!read() : true;
      },
      preferences: {
        getWidth: () => {
          try { return Number(localStorage.getItem("desk-ft-width")) || 280; } catch (_) { return 280; }
        },
        setWidth: (width) => {
          try { localStorage.setItem("desk-ft-width", String(width)); } catch (_) { /* private mode */ }
        },
      },
      initialOpen: (() => {
        try { return localStorage.getItem("desk-ft-open") === "1"; } catch (_) { return false; }
      })(),
      onOpenChanged: (open) => {
        document.body.classList.toggle("desk-ft-closed", !open);
        try { localStorage.setItem("desk-ft-open", open ? "1" : "0"); } catch (_) { /* private mode */ }
      },
    });
    panel.toggleElement.id = "desk-ft-top-toggle";

    // The project rail is desktop chrome, not part of the file component, but
    // its collapse controls used to live in the old panel bootstrap. Keep that
    // host wiring here while the renderer itself moves to media/file-panel.js.
    const rail = document.getElementById("projects-rail");
    if (rail && topBar) {
      const railToggle = document.getElementById("desk-rail-toggle");
      let railOpenButton = document.getElementById("desk-rail-open-btn");
      if (!railOpenButton) {
        railOpenButton = document.createElement("button");
        railOpenButton.type = "button";
        railOpenButton.id = "desk-rail-open-btn";
        railOpenButton.className = "icon-btn desk-rail-open-btn";
        railOpenButton.innerHTML = shared.panelIcon("left");
        railOpenButton.title = "Show projects";
        railOpenButton.setAttribute("aria-label", "Show projects");
        topBar.insertBefore(railOpenButton, topBar.firstChild);
      } else {
        railOpenButton.classList.add("icon-btn");
      }
      const applyRailOpen = (open) => {
        document.body.classList.toggle("desk-rail-collapsed", !open);
        if (railToggle) railToggle.setAttribute("aria-expanded", String(open));
        try { localStorage.setItem("desk-rail-open", open ? "1" : "0"); } catch (_) { /* private mode */ }
        window.__grokReclampSidePanels?.();
      };
      let railStartsOpen = true;
      try { railStartsOpen = localStorage.getItem("desk-rail-open") !== "0"; } catch (_) { /* private mode */ }
      applyRailOpen(railStartsOpen);
      if (railToggle && !railToggle.dataset.gfpWired) {
        railToggle.dataset.gfpWired = "1";
        railToggle.addEventListener("click", () => applyRailOpen(false));
      }
      if (!railOpenButton.dataset.gfpWired) {
        railOpenButton.dataset.gfpWired = "1";
        railOpenButton.addEventListener("click", () => applyRailOpen(true));
      }
    }

    // Share narrow-window pressure with the project rail. Dragging persists the
    // preferred width in the component; coordinator reclamps are paint-only.
    if (typeof window.__grokRegisterSidePanel === "function") {
      window.__grokRegisterSidePanel({
        id: "panel",
        min: 200,
        maxFrac: 0.7,
        isOpen: () => panel.isOpen(),
        preferredWidth: () => {
          try { return Number(localStorage.getItem("desk-ft-width")) || 280; } catch (_) { return 280; }
        },
        applyWidth: (width) => panel.setWidth(width, false),
      });
      window.__grokReclampSidePanels();
    }
    window.__grokDeskFilePanel = panel;
    window.__grokDeskFtBeforeClose = () => panel.confirmClose();
    window.__grokDeskFtOpen = (relPath) => panel.openPath(relPath);
    try { window.__grokResetDocumentScroll?.(); } catch (_) { /* chat.js hook */ }
    return { ok: true };
  })()`;
}
