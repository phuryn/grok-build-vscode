export const DESKTOP_CONVERSATIONS_ARG = "--grok-desktop-conversations";
export const DESKTOP_CONVERSATION_PANE_ARG = "--grok-desktop-conversation-pane";

export const CHAT_MIN_WIDTH = 360;
export const FILES_MIN_WIDTH = 200;
// The 5px grab area overlaps its neighbours by 2px on each side.
export const FILES_RESIZER_WIDTH = 1;
const ROW_MIN_HEIGHT = 200;
const MAX_ROWS = 3;

/** Return cells in chat order with integer bounds relative to the conversation area, in DIPs. */
export function planConversationGrid(width: number, height: number, filesOpen: readonly boolean[], zoom = 1) {
  const count = filesOpen.length;
  if (!count) return [];
  const fit = Math.max(1, Math.floor((width + 1) / (CHAT_MIN_WIDTH * zoom + 1)));
  const rowsMax = Math.min(MAX_ROWS, Math.max(1, Math.floor((height + 1) / (ROW_MIN_HEIGHT * zoom + 1))));
  const columnCount = Math.min(count, Math.max(fit, Math.ceil(count / rowsMax)));
  const rows: number[] = Array(columnCount).fill(1);
  let extra = count - columnCount;
  for (let row = 1; row < rowsMax && extra > 0; row++) {
    for (let column = columnCount - 1; column >= 0 && extra > 0; column--) {
      rows[column]++;
      extra--;
    }
  }

  // Reserve the divider only when there is room for it. A transient empty
  // rectangle (e.g. while resizing) must still yield in-bounds cells.
  const columnGap = width >= 2 * columnCount - 1 ? 1 : 0;
  let widthLeft = width - columnGap * (columnCount - 1);
  let start = 0;
  const filesWidth = FILES_MIN_WIDTH + FILES_RESIZER_WIDTH;
  const columns = rows.map((rowCount, index) => {
    const hasFiles = filesOpen.slice(start, start + rowCount).some(Boolean);
    start += rowCount;
    return { index, need: Math.ceil(zoom * (CHAT_MIN_WIDTH + (hasFiles ? filesWidth : 0))) };
  });
  const minimumsFit = columns.reduce((sum, { need }) => sum + need, 0) <= widthLeft;
  const widths: number[] = [];
  if (minimumsFit) columns.sort((a, b) => b.need - a.need);
  for (const [i, { index, need }] of columns.entries()) {
    const share = Math.ceil(widthLeft / (columnCount - i));
    const assigned = minimumsFit ? Math.max(need, share) : share;
    widths[index] = assigned;
    widthLeft -= assigned;
  }

  const cells: { x: number; y: number; width: number; height: number }[] = [];
  let x = 0;
  for (const [column, rowCount] of rows.entries()) {
    const rowGap = height >= 2 * rowCount - 1 ? 1 : 0;
    let heightLeft = height - rowGap * (rowCount - 1);
    let y = 0;
    for (let row = 0; row < rowCount; row++) {
      const rowHeight = Math.ceil(heightLeft / (rowCount - row));
      cells.push({ x, y, width: widths[column], height: rowHeight });
      y += rowHeight + rowGap;
      heightLeft -= rowHeight;
    }
    x += widths[column] + columnGap;
  }
  return cells;
}

// The DOM measures the space after Projects. The host assigns the main chat
// and the native views their cells within that rectangle in window DIPs.
export const DESKTOP_CONVERSATION_LAYOUT_BOOT = `
(() => {
  const CHAT_MIN_WIDTH = ${CHAT_MIN_WIDTH};
  const compactWidth = CHAT_MIN_WIDTH + 180 + 200 + 8;
  let columns;
  let observer;
  let layers;
  let covered;
  let frame;
  let measuredZoom;
  const body = () => document.body;
  const bridge = () => window.grokDesktopConversations;
  const syncCoverage = () => {
    const flags = body().classList;
    const next = !!body().dataset.modalAbove
      || !!window.afkpilotLayers?.depth
      || !!body().querySelector(":scope > :is(#preview-overlay, .confirm-overlay)")
      || (flags.contains("desk-split-compact") && !!body().dataset.splitDrawer);
    if (next === covered) return;
    covered = next;
    bridge()?.setCovered(next);
  };
  const setDrawer = name => {
    if (name) body().dataset.splitDrawer = name;
    else delete body().dataset.splitDrawer;
    const projects = document.getElementById("desk-rail-open-btn");
    const compact = body().classList.contains("desk-split-compact");
    if (compact) {
      projects?.setAttribute("aria-expanded", String(name === "projects"));
    } else {
      projects?.removeAttribute("aria-expanded");
    }
    syncCoverage();
  };
  const drawerClick = event => {
    if (!body().classList.contains("desk-split-compact")) return;
    const button = event.target.closest?.("#desk-rail-open-btn, #desk-rail-toggle");
    if (!button) return;
    event.stopImmediatePropagation();
    if (button.id === "desk-rail-toggle") { setDrawer(""); return; }
    setDrawer(body().dataset.splitDrawer === "projects" ? "" : "projects");
  };
  const measure = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!columns?.isConnected) return;
      const zoom = Number(getComputedStyle(body()).zoom) || 1;
      if (measuredZoom !== zoom) {
        measuredZoom = zoom;
        window.__grokReclampSidePanels?.();
      }
      const compact = window.innerWidth / zoom < compactWidth;
      const wasCompact = body().classList.contains("desk-split-compact");
      body().classList.toggle("desk-split-compact", compact);
      if (wasCompact !== compact) setDrawer("");
      const header = document.querySelector(".desk-ft-chat > .top-bar");
      if (compact && header) {
        const top = Math.ceil(header.getBoundingClientRect().bottom / zoom) + "px";
        if (body().style.getPropertyValue("--desk-drawer-top") !== top) body().style.setProperty("--desk-drawer-top", top);
      }
      const { left, top, right, bottom } = columns.getBoundingClientRect();
      const x = Math.ceil(left);
      const y = Math.ceil(top);
      bridge()?.setBounds({
        x, y, width: Math.max(0, Math.floor(right) - x), height: Math.max(0, Math.floor(bottom) - y)
      }, zoom, !!window.__grokDeskFilePanel?.isOpen());
    });
  };
  window.__grokCloseCompactProjects = () => {
    if (body().dataset.splitDrawer === "projects") setDrawer("");
  };
  window.__grokConversationGeometry = (width, height) => {
    if (!columns?.isConnected) return;
    columns.style.setProperty("--desk-main-cell-width", width + "px");
    columns.style.setProperty("--desk-main-cell-height", height + "px");
  };
  window.__grokMeasureConversationLayout = measure;
  window.__grokConversationLayout = (count) => {
    if (count === 0) {
      if (!columns) return;
      observer?.disconnect();
      layers?.disconnect();
      window.removeEventListener("afkpilot-layers", syncCoverage);
      window.removeEventListener("resize", measure);
      document.removeEventListener("click", drawerClick, true);
      covered = undefined;
      if (columns?.isConnected) {
        const shell = columns.firstElementChild;
        const chat = shell?.querySelector(".desk-ft-chat");
        const header = chat?.querySelector(":scope > .top-bar");
        if (header) columns.before(header);
        columns.before(shell);
        columns.remove();
      }
      body().classList.remove("desk-split-compact");
      body().style.removeProperty("--desk-drawer-top");
      setDrawer("");
      columns = undefined;
      measuredZoom = undefined;
      window.__grokFitDesktopFiles?.();
      window.__grokReclampSidePanels?.();
      return;
    }
    if (!columns?.isConnected) {
      const chat = document.querySelector(".desk-ft-chat");
      if (!chat) return;
      const shell = chat.parentElement;
      const header = shell.parentElement.querySelector(":scope > .top-bar");
      if (header) chat.prepend(header);
      columns = document.createElement("div");
      columns.id = "desk-conversation-columns";
      shell.before(columns);
      columns.append(shell);
      window.__grokReclampSidePanels?.();
      window.__grokFitDesktopFiles?.();
      window.__grokRefreshDesktopTheme?.();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(columns);
      layers?.disconnect();
      layers = new MutationObserver(records => {
        syncCoverage();
        if (records.some(record => record.attributeName === "style")) measure();
      });
      layers.observe(body(), {
        childList: true, attributes: true, attributeFilter: ["class", "style", "data-modal-above"]
      });
      window.addEventListener("afkpilot-layers", syncCoverage);
      window.addEventListener("resize", measure);
      document.addEventListener("click", drawerClick, true);
      syncCoverage();
    }
    measure();
  };
})();
`;

export interface DesktopChatDraftSnapshot {
  text: string | null;
  chipIds: string[];
  revision: number;
}

export interface DesktopMainCloseSnapshot extends DesktopChatDraftSnapshot {
  sessionId: string | null;
}

export interface DesktopPaneCloseSnapshot extends DesktopChatDraftSnapshot {
  binding: number;
  scrollTop: number | null;
  files?: unknown;
}
