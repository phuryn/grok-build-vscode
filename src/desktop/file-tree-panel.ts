/**
 * Desktop mount bootstrap for the shared renderer in `media/file-panel.js`.
 *
 * The executable source injected into Electron is intentionally small. Panel
 * state, rendering, editing, conflicts, tabs, and resizing live in the shared
 * media component used by the remote browser too. Desktop keeps responsibility
 * only for preparing its chat/file dock and adapting preload IPC promises.
 */
import { CHAT_MIN_WIDTH, FILES_MIN_WIDTH, FILES_RESIZER_WIDTH } from "./conversation-layout";

const fileTileSizing = { chatAndDivider: CHAT_MIN_WIDTH + FILES_RESIZER_WIDTH, dockMin: FILES_MIN_WIDTH };

// The mount bootstrap runs in the renderer. Pass the grid's sizing constants
// in explicitly so it and the host-side tests use the same pure calculation.
function desktopFilesPlanner({ chatAndDivider, dockMin }: typeof fileTileSizing) {
  return (tileWidthDips: number, zoom: number, preferred: number) => {
    const tileWidth = tileWidthDips / zoom;
    const overlay = tileWidthDips < (chatAndDivider + dockMin) * zoom;
    const minWidth = overlay ? 160 : dockMin;
    const cap = overlay ? Math.round(tileWidth * 0.62)
      : Math.floor(Math.min(tileWidth * 0.7, tileWidth - chatAndDivider));
    const maxWidth = Math.max(minWidth, cap);
    const width = Math.max(minWidth, Math.min(Math.round(preferred), maxWidth));
    return { overlay, minWidth, maxWidth, width };
  };
}

export const planDesktopFiles = desktopFilesPlanner(fileTileSizing);

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
  return `(async () => {
    const planFiles = (${desktopFilesPlanner.toString()})(${JSON.stringify(fileTileSizing)});
    const api = window.grokDesktopFileTree;
    const shared = window.GrokFilePanel;
    if (!api || !shared || typeof shared.createFilePanel !== "function") {
      return { ok: false, reason: !api ? "no bridge" : "no shared component" };
    }

    window.__grokDisposeDesktopFiles?.();
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
    const pane = document.body.dataset.editorChat === "true";
    if (pane && topBar) chat.prepend(topBar);
    const composer = chat.querySelector(".composer");
    const closeChat = document.getElementById("desk-conversation-close");
    document.body.classList.add("desk-with-ft");

    let separator = document.getElementById("desk-ft-top-sep");
    if (!separator && topBar) {
      separator = document.createElement("span");
      separator.id = "desk-ft-top-sep";
      separator.className = "desk-ft-top-sep";
      separator.setAttribute("aria-hidden", "true");
      topBar.insertBefore(separator, closeChat);
    }

    const normalizeRoot = (value) => value && value.ok !== false && value.root
      ? { id: value.root, label: value.name || value.root, title: value.root }
      : null;
    const initial = await api.root();
    let preference = initial?.preferencesKey;
    let root = normalizeRoot(initial);
    const preferenceKey = name => preference ? name + "." + preference : name;
    const preferredWidth = () => {
      try { return Number(localStorage.getItem(preferenceKey("desk-ft-width"))) || (preference ? 290 : 280); }
      catch (_) { return 280; }
    };
    const preferredOpen = () => {
      try { return localStorage.getItem(preferenceKey("desk-ft-open")) === "1"; }
      catch (_) { return false; }
    };
    const adapter = {
      currentScope: () => root,
      list: (scopeId, relPath) => api.list(relPath, scopeId),
      read: (scopeId, relPath) => api.read(relPath, scopeId),
      write: (scopeId, request) => api.save({
        relPath: request.relPath,
        text: request.text,
        stamp: request.stamp,
        absPath: request.expectedAbsPath,
      }, scopeId),
      openExternal: (scopeId, relPath) => api.open(relPath, scopeId),
      reveal: (scopeId, relPath) => api.reveal(relPath, scopeId),
      gitStatus: scopeId => api.gitStatus(scopeId),
      gitDiff: (scopeId, relPath) => api.gitDiff(relPath, scopeId),
      gitRun: (scopeId, request) => api.gitRun(request, scopeId),
    };

    const componentScript = document.querySelector('script[src*="file-panel.js"]');
    const iconBase = componentScript && componentScript.src
      ? new URL("file-icons/", componentScript.src).href
      : "";
    const split = () => pane || !!document.getElementById("desk-conversation-columns");
    let dockLayout;
    const fit = () => {
      const zoom = Number(getComputedStyle(document.body).zoom) || 1;
      const bounds = shell.getBoundingClientRect();
      dockLayout = split() ? planFiles(bounds.width, zoom, preferredWidth()) : undefined;
      const compact = dockLayout?.overlay === true;
      shell.classList.toggle("desk-ft-pair-compact", compact);
      panel.refreshPresentation();
      if (compact && topBar) {
        const top = Math.max(0, (topBar.getBoundingClientRect().bottom - bounds.top) / zoom);
        shell.style.setProperty("--desk-ft-pair-top", top + "px");
      }
      if (compact && composer) {
        const bottom = Math.max(0, (bounds.bottom - composer.getBoundingClientRect().top) / zoom);
        shell.style.setProperty("--desk-ft-pair-bottom", bottom + "px");
      }
      if (dockLayout) panel.setWidth(dockLayout.width, false);
    };
    const onOpen = open => {
      document.body.classList.toggle("desk-ft-closed", !open);
      try { localStorage.setItem(preferenceKey("desk-ft-open"), open ? "1" : "0"); } catch (_) { /* private mode */ }
      window.grokDesktopConversations?.filePanelChanged?.(open);
      window.__grokMeasureConversationLayout?.();
      queueMicrotask(fit);
    };
    const panel = shared.createFilePanel({
      access: adapter,
      clearScopeOnMissing: true,
        mount: {
          panelHost: shell,
          toggleHost: topBar,
          presentation: "dock",
          dockLayout: () => dockLayout,
          closeLabel: topBar?.dataset.filesCloseLabel,
          onCloseButton: () => document.getElementById("input")?.focus(),
          id: "desk-ft-panel",
          viewingBodyClass: "desk-ft-viewing",
          // The shared panel disables maximize in either overlay placement.
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
        askAgent: typeof window.__grokFilePanelAskAgent === "function"
          ? window.__grokFilePanelAskAgent
          : undefined,
        openSettings: typeof window.__grokFilePanelOpenSettings === "function"
          ? window.__grokFilePanelOpenSettings
          : undefined,
        renderMarkdown: typeof window.__grokRenderMarkdown === "function"
          ? window.__grokRenderMarkdown
          : undefined,
        revealLabel: ${JSON.stringify(revealLabel)},
        fileIcons: { baseUrl: iconBase },
        // The docked tree is injected into the CHAT document, so the renderer
        // that owns the project catalog is already on the page and publishes
        // these. Absent on a chat.js too old to publish them, which just leaves
        // the title its folder.
        projectMark: typeof window.__grokProjectMark === "function"
          ? window.__grokProjectMark
          : undefined,
        projectMarkColor: typeof window.__grokProjectMarkColor === "function"
          ? window.__grokProjectMarkColor
          : undefined,
      },
      // No gitEnabled option here, deliberately. The panel decides on evidence
      // — it withholds Changes when the host reports no git or not-a-repo —
      // and that answer is right on both mounts without either of them knowing
      // what the person is using the app FOR. This used to pass the Coding
      // purpose through, matching the remote client; the remote client stopped
      // doing it, and a desk that kept the gate would hide Changes on a real
      // repository purely because the same person also writes prose in it.
      //
      // (No backticks in this comment: the whole block is a template literal.)
      preferences: {
        getWidth: preferredWidth,
        setWidth: (width) => {
          try { localStorage.setItem(preferenceKey("desk-ft-width"), String(width)); } catch (_) { /* private mode */ }
          queueMicrotask(fit);
        },
      },
      initialOpen: preferredOpen(),
      onOpenChanged: onOpen,
    });
    panel.toggleElement.id = "desk-ft-top-toggle";
    if (topBar?.dataset.filesLabel) panel.toggleElement.setAttribute("aria-label", topBar.dataset.filesLabel);
    if (topBar && closeChat?.parentElement === topBar) topBar.insertBefore(panel.toggleElement, closeChat);

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

    fit();
    // Share narrow-window pressure with the project rail. Dragging persists the
    // preferred width in the component; coordinator reclamps are paint-only.
    if (typeof window.__grokRegisterSidePanel === "function") {
      window.__grokRegisterSidePanel({
        id: "panel",
        min: 200,
        maxFrac: 0.7,
        isOpen: () => !split() && panel.isOpen(),
        preferredWidth,
        applyWidth: (width) => { if (!split()) panel.setWidth(width, false); },
      });
      window.__grokReclampSidePanels();
    }
    const observer = new ResizeObserver(fit);
    window.addEventListener("resize", fit);
    observer.observe(shell);
    if (topBar) observer.observe(topBar);
    if (composer) observer.observe(composer);
    window.__grokFitDesktopFiles = fit;
    let request = 0;
    let adoptedTabs;
    let adopting = false;
    const applyScope = async (expectedRoot) => {
      const sequence = ++request;
      const value = await api.root();
      if (sequence !== request) return false;
      const next = normalizeRoot(value);
      const changed = adopting || preference !== value?.preferencesKey;
      if (changed) {
        preference = value?.preferencesKey;
        panel.restoreTabs(adoptedTabs);
        adoptedTabs = undefined;
        adopting = false;
        panel.setMaximized(false);
        panel.setOpen(preferredOpen());
        fit();
        window.__grokReclampSidePanels?.();
      }
      if (changed || root?.id !== next?.id) {
        root = next;
        void panel.setScope(root);
      }
      return !expectedRoot || expectedRoot === root?.id;
    };
    const refresh = () => { void applyScope().catch(() => {}); };
    const off = api.onRootChanged(refresh);
    const receive = ({ data }) => {
      if (data?.type === "desktopChatAdopted") {
        adopting = true;
        adoptedTabs = data.files;
      }
      if (["desktopChatAdopted", "editorChatBinding", "initialState", "sessionName", "repos"].includes(data?.type)) refresh();
    };
    window.addEventListener("message", receive);
    window.__grokDisposeDesktopFiles = () => {
      request++;
      off();
      observer.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("message", receive);
    };
    window.__grokDeskFilePanel = panel;
    window.__grokDeskFtBeforeClose = (anotherPanelIsDirty) => panel.confirmClose(anotherPanelIsDirty === true);
    window.__grokDeskFtOpen = async (relPath, root) => {
      if (!await applyScope(root)) return { ok: false, reason: "workspace changed" };
      const result = await panel.openPath(relPath, false, root);
      return root && result?.openExternal ? { ok: true } : result;
    };
    window.__grokDeskFtOpenDiff = async (diff, root) => {
      if (!await applyScope(root)) return { ok: false, reason: "workspace changed" };
      return panel.openDiff(diff, root);
    };
    refresh();
    try { window.__grokResetDocumentScroll?.(); } catch (_) { /* chat.js hook */ }
    return { ok: true };
  })()`;
}
