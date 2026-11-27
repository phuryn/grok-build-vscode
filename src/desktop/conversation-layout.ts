export const DESKTOP_CONVERSATIONS_ARG = "--grok-desktop-conversations";
export const DESKTOP_CONVERSATION_PANE_ARG = "--grok-desktop-conversation-pane";

export const CHAT_MIN_WIDTH = 360;
export const FILES_MIN_WIDTH = 200;
// The 5px grab area overlaps its neighbours by 2px on each side.
export const FILES_RESIZER_WIDTH = 1;
const ROW_MIN_HEIGHT = 200;
const MAX_ROWS = 3;
const GRID_GRAB_WIDTH = 5;

type Cell = { x: number; y: number; width: number; height: number };
type Divider = Cell & { axis: "column" | "row"; column: number; row: number };
export interface ConversationGridSizes {
  shape: number[];
  columns: { fractions: number[]; docked: boolean[]; gutterDockCount: number } | null;
  rows: (number[] | null)[];
}

function matchesShape(sizes: unknown, shape: number[]): sizes is ConversationGridSizes {
  if (!sizes || typeof sizes !== "object") return false;
  const stored = sizes as ConversationGridSizes;
  const fractions = (values: unknown, count: number) => Array.isArray(values) && values.length === count &&
    values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) &&
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-8;
  return Array.isArray(stored.shape) && stored.shape.length === shape.length &&
    shape.every((count, i) => count === stored.shape[i]) &&
    Array.isArray(stored.rows) && stored.rows.length === shape.length &&
    shape.every((count, i) => stored.rows[i] === null || fractions(stored.rows[i], count)) &&
    (stored.columns === null || (!!stored.columns && fractions(stored.columns.fractions, shape.length) &&
      Array.isArray(stored.columns.docked) && stored.columns.docked.length === shape.length &&
      stored.columns.docked.every(value => typeof value === "boolean") &&
      Number.isSafeInteger(stored.columns.gutterDockCount) &&
      stored.columns.gutterDockCount >= 0 && stored.columns.gutterDockCount <= shape.length));
}

function equalTracks(space: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const size = Math.ceil(space / (count - i));
    space -= size;
    return size;
  });
}

function fractionTracks(space: number, fractions: number[], minimums: number[]): number[] {
  const tracks = fractions.map(() => 0);
  let active = fractions.map((_, i) => i);
  while (active.length) {
    const weight = active.reduce((sum, i) => sum + fractions[i], 0);
    const ideal = (i: number) => weight ? space * fractions[i] / weight : space / active.length;
    const clamped = active.filter(i => ideal(i) < minimums[i]);
    if (!clamped.length) {
      // Round cumulative boundaries so every DIP belongs to a track.
      let boundary = 0;
      let rounded = 0;
      for (const i of active) {
        boundary += ideal(i);
        tracks[i] = Math.round(boundary) - rounded;
        rounded += tracks[i];
      }
      break;
    }
    for (const i of clamped) {
      tracks[i] = minimums[i];
      space -= tracks[i];
    }
    active = active.filter(i => !clamped.includes(i));
  }
  return tracks;
}

function gridGap(space: number, count: number, minimum: number, grabWidth: number): number {
  if (count < 2 || space < 2 * count - 1) return 0;
  if (grabWidth === 1) return 1;
  const sparePerGap = Math.floor((space - minimum) / (count - 1));
  return Math.min(grabWidth, sparePerGap >= 0 ? sparePerGap : Math.floor((space - count) / (count - 1)));
}

const total = (tracks: readonly number[]) => tracks.reduce((sum, size) => sum + size, 0);

/** Phase 5 geometry with hairline gaps. */
export function planConversationGrid(width: number, height: number, filesOpen: readonly boolean[], zoom = 1) {
  return planResizableConversationGrid(width, height, filesOpen, zoom, undefined, 1).cells;
}

/** Return cells and dividers in integer DIPs relative to the measured area. */
export function planResizableConversationGrid(
  width: number, height: number, filesOpen: readonly boolean[], zoom = 1, stored?: unknown, grabWidth = GRID_GRAB_WIDTH,
) {
  const count = filesOpen.length;
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

  const sizes = matchesShape(stored, rows) ? stored : undefined;
  const zoomedMinimum = (size: number) => Math.ceil(zoom * size);
  const chatMin = zoomedMinimum(CHAT_MIN_WIDTH);
  const dockMin = zoomedMinimum(CHAT_MIN_WIDTH + FILES_MIN_WIDTH + FILES_RESIZER_WIDTH);
  const rowMin = zoomedMinimum(ROW_MIN_HEIGHT);
  let start = 0;
  const openByColumn = rows.map(rowCount => {
    const hasFiles = filesOpen.slice(start, start + rowCount).some(Boolean);
    start += rowCount;
    return hasFiles;
  });
  const gaps = Math.max(0, columnCount - 1);
  const baseMinimum = chatMin * columnCount;
  const defaultDocks = openByColumn.filter(Boolean).length;
  const dockBudget = (docks: number) => baseMinimum + docks * (dockMin - chatMin);
  const preferredFit = dockBudget(defaultDocks) <= width - gaps;
  // Freeze the gutter allowance with the sizes so that Files toggles cannot
  // change even the gap width. Near the dock threshold, the grab area narrows.
  const gutterDockCount = sizes?.columns?.gutterDockCount ?? (preferredFit ? defaultDocks : 0);
  const gutterMinimum = dockBudget(gutterDockCount);
  const columnGap = gridGap(width, columnCount, gutterMinimum <= width - gaps ? gutterMinimum : baseMinimum, grabWidth);
  let widthLeft = width - columnGap * gaps;
  let widths = equalTracks(widthLeft, columnCount);
  if (sizes?.columns) {
    const minimums = sizes.columns.docked.map(docked => docked ? dockMin : chatMin);
    if (baseMinimum <= widthLeft) {
      widths = fractionTracks(widthLeft, sizes.columns.fractions,
        total(minimums) <= widthLeft ? minimums : rows.map(() => chatMin));
    }
  } else if (preferredFit) {
    const ordered = openByColumn.map((open, index) => ({ need: open ? dockMin : chatMin, index }))
      .sort((a, b) => b.need - a.need);
    for (const [i, { index, need }] of ordered.entries()) {
      const assigned = Math.max(need, Math.ceil(widthLeft / (columnCount - i)));
      widths[index] = assigned;
      widthLeft -= assigned;
    }
  }

  const cells: Cell[] = [];
  const dividers: Divider[] = [];
  const heights: number[][] = [];
  let x = 0;
  for (const [column, rowCount] of rows.entries()) {
    const rowGap = gridGap(height, rowCount, rowMin * rowCount, grabWidth);
    const heightLeft = height - rowGap * (rowCount - 1);
    const fractions = sizes?.rows[column];
    const rowHeights = fractions && rowMin * rowCount <= heightLeft
      ? fractionTracks(heightLeft, fractions, Array(rowCount).fill(rowMin))
      : equalTracks(heightLeft, rowCount);
    heights.push(rowHeights);
    let y = 0;
    for (const [row, rowHeight] of rowHeights.entries()) {
      cells.push({ x, y, width: widths[column], height: rowHeight });
      y += rowHeight;
      if (row + 1 < rowCount) {
        if (rowGap && widths[column]) dividers.push({ axis: "row", column, row, x, y, width: widths[column], height: rowGap });
        y += rowGap;
      }
    }
    x += widths[column];
    if (column + 1 < columnCount) {
      if (columnGap && height) dividers.push({ axis: "column", column, row: 0, x, y: 0, width: columnGap, height });
      x += columnGap;
    }
  }
  const docked = openByColumn.map((open, i) => open && widths[i] >= dockMin);
  return { cells, dividers, shape: rows, sizes, widths, heights, width, height, rowMin, dockMin,
    openByColumn, gutterDockCount, columnDragMinimums: docked.map(open => open ? dockMin : chatMin) };
}

type Grid = ReturnType<typeof planResizableConversationGrid>;
export const DESKTOP_GRID_SIZES_KEY = "grok.desktopConversationGridSizes";

/** Interpret a renderer's requested boundary against the current host plan. */
export function resizeConversationGrid(grid: Grid, revision: number, raw: unknown): ConversationGridSizes | undefined {
  if (!raw || typeof raw !== "object") return;
  const { axis, column, row, position, revision: requestedRevision } = raw as Record<string, unknown>;
  if (requestedRevision !== revision) return;
  const divider = grid.dividers.find(item => item.axis === axis && item.column === column && item.row === row);
  if (!divider) return;

  const isColumn = divider.axis === "column";
  const fractions = (tracks: number[]) => {
    const space = total(tracks);
    return tracks.map(size => space ? size / space : 1 / tracks.length);
  };
  const updated: ConversationGridSizes = {
    shape: grid.shape,
    columns: grid.sizes?.columns ?? null,
    rows: grid.sizes?.rows.slice() ?? grid.shape.map(() => null),
  };
  if (position === null) {
    if (isColumn ? !updated.columns : !updated.rows[divider.column]) return;
    if (isColumn) updated.columns = null;
    else updated.rows[divider.column] = null;
    return updated;
  }
  if (typeof position !== "number" || !Number.isSafeInteger(position) ||
      position < 0 || position > (isColumn ? grid.width : grid.height)) return;

  const index = isColumn ? divider.column : divider.row;
  const tracks = (isColumn ? grid.widths : grid.heights[divider.column]).slice();
  const minimums = isColumn ? grid.columnDragMinimums : tracks.map(() => grid.rowMin);
  const pair = tracks[index] + tracks[index + 1];
  if (pair <= minimums[index] + minimums[index + 1]) return;
  const boundary = isColumn ? divider.x : divider.y;
  const size = Math.max(minimums[index], Math.min(pair - minimums[index + 1], tracks[index] + position - boundary));
  if (size === tracks[index]) return;
  tracks[index] = size;
  tracks[index + 1] = pair - size;
  const columnSizes = (widths: number[]) => ({
    fractions: fractions(widths),
    docked: grid.openByColumn.map((open, i) => open && widths[i] >= grid.dockMin),
    gutterDockCount: grid.gutterDockCount,
  });
  if (isColumn) updated.columns = columnSizes(tracks);
  else {
    updated.columns ??= columnSizes(grid.widths);
    updated.rows[divider.column] = fractions(tracks);
  }
  return updated;
}

const l10nKey = (key: string) => key;

// The DOM measures the space after Projects. The host assigns the main chat
// and the native views their cells within that rectangle in window DIPs.
export const DESKTOP_CONVERSATION_LAYOUT_BOOT = `
(() => {
  const CHAT_MIN_WIDTH = ${CHAT_MIN_WIDTH};
  const compactWidth = CHAT_MIN_WIDTH + 180 + 200 + 8;
  let columns;
  let dividerLayer;
  let paneCount;
  let observer;
  let layers;
  let covered;
  let frame;
  let measuredZoom;
  let grid;
  let drag;
  let dragFrame;
  let pendingDrag;
  const handles = new Map();
  const body = () => document.body;
  const bridge = () => window.grokDesktopConversations;
  const stopDrag = (discard) => {
    if (discard && pendingDrag) {
      cancelAnimationFrame(dragFrame);
      pendingDrag = undefined;
    }
    if (!drag) return;
    const { handle, pointer } = drag;
    drag = undefined;
    delete body().dataset.deskGridDrag;
    delete handle.dataset.dragging;
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
  };
  const cancelDrag = () => stopDrag(true);
  const startDrag = (event, handle, divider) => {
    if (event.button !== 0 || !event.isPrimary || covered || drag || !grid) return;
    try { handle.setPointerCapture(event.pointerId); } catch { return; }
    const coordinate = divider.axis === "column" ? "clientX" : "clientY";
    drag = { handle, pointer: event.pointerId, coordinate, start: event[coordinate],
      origin: divider.axis === "column" ? divider.x : divider.y,
      limit: divider.axis === "column" ? grid.width : grid.height,
      request: { revision: grid.revision, axis: divider.axis, column: divider.column, row: divider.row } };
    body().dataset.deskGridDrag = divider.axis;
    handle.dataset.dragging = "";
  };
  const queueDrag = event => {
    const delta = Math.round(event[drag.coordinate] - drag.start);
    if (!delta && drag.position === undefined) return;
    const position = Math.max(0, Math.min(drag.limit, drag.origin + delta));
    if (position === drag.position) return;
    drag.position = position;
    const scheduled = !!pendingDrag;
    pendingDrag = { ...drag.request, position };
    if (!scheduled) dragFrame = requestAnimationFrame(() => {
      const request = pendingDrag;
      pendingDrag = undefined;
      if (request) bridge()?.resizeGrid(request);
    });
  };
  const moveDrag = event => {
    if (event.pointerId !== drag?.pointer) return;
    if (!(event.buttons & 1)) { cancelDrag(); return; }
    queueDrag(event);
  };
  const endDrag = event => {
    if (event.pointerId !== drag?.pointer) return;
    if (event.type === "pointerup") {
      queueDrag(event);
      stopDrag(false);
    } else {
      cancelDrag();
    }
  };
  const addHandle = (key, divider) => {
    const handle = document.createElement("div");
    handle.className = "desk-grid-divider";
    const vertical = divider.axis === "column";
    const label = vertical ? ${JSON.stringify(l10nKey("Resize chat columns"))} : ${JSON.stringify(l10nKey("Resize chat rows"))};
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
    handle.setAttribute("aria-label", window.GrokWebviewHelpers?.l10n(label) ?? label);
    handle.addEventListener("pointerdown", event => startDrag(event, handle, handles.get(key).divider));
    handle.addEventListener("lostpointercapture", endDrag);
    handle.addEventListener("dblclick", () => {
      cancelDrag();
      if (!covered && grid) {
        const { axis, column, row } = handles.get(key).divider;
        bridge()?.resizeGrid({ revision: grid.revision, axis, column, row, position: null });
      }
    });
    const entry = { handle, divider };
    handles.set(key, entry);
    dividerLayer.append(handle);
    return entry;
  };
  const syncCoverage = () => {
    const flags = body().classList;
    const next = !!body().dataset.modalAbove
      || !!window.afkpilotLayers?.depth
      || !!body().querySelector(":scope > :is(#preview-overlay, .confirm-overlay)")
      || (flags.contains("desk-split-compact") && !!body().dataset.splitDrawer);
    if (next === covered) return;
    covered = next;
    if (dividerLayer) dividerLayer.hidden = next;
    if (next) cancelDrag();
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
      dividerLayer.style.left = (x - left) / zoom + "px";
      dividerLayer.style.top = (y - top) / zoom + "px";
      bridge()?.setBounds({
        x, y, width: Math.max(0, Math.floor(right) - x), height: Math.max(0, Math.floor(bottom) - y)
      }, zoom, !!window.__grokDeskFilePanel?.isOpen());
    });
  };
  window.__grokCloseCompactProjects = () => {
    if (body().dataset.splitDrawer === "projects") setDrawer("");
  };
  window.__grokConversationGeometry = (width, height, next) => {
    if (!columns?.isConnected) return;
    columns.style.setProperty("--desk-main-cell-width", width + "px");
    columns.style.setProperty("--desk-main-cell-height", height + "px");
    if (!next) return;
    if (grid?.revision !== next.revision) cancelDrag();
    grid = next;
    const px = value => value / grid.zoom + "px";
    dividerLayer.style.setProperty("--desk-grid-pixel", px(1));
    const keys = new Set();
    for (const divider of grid.dividers) {
      const key = [divider.axis, divider.column, divider.row].join("-");
      keys.add(key);
      const entry = handles.get(key) ?? addHandle(key, divider);
      entry.divider = divider;
      const { style } = entry.handle;
      style.left = px(divider.x);
      style.top = px(divider.y);
      style.width = px(divider.width);
      style.height = px(divider.height);
    }
    for (const [key, { handle }] of handles) {
      if (keys.has(key)) continue;
      handle.remove();
      handles.delete(key);
    }
  };
  window.__grokMeasureConversationLayout = measure;
  window.__grokConversationLayout = (count) => {
    if (paneCount !== count) cancelDrag();
    paneCount = count;
    if (count === 0) {
      if (!columns) return;
      observer?.disconnect();
      layers?.disconnect();
      window.removeEventListener("afkpilot-layers", syncCoverage);
      window.removeEventListener("resize", measure);
      window.removeEventListener("blur", cancelDrag);
      window.removeEventListener("pointermove", moveDrag, true);
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
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
      dividerLayer = undefined;
      grid = undefined;
      handles.clear();
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
      dividerLayer = document.createElement("div");
      dividerLayer.className = "desk-grid-dividers";
      columns.append(dividerLayer);
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
      window.addEventListener("blur", cancelDrag);
      window.addEventListener("pointermove", moveDrag, true);
      window.addEventListener("pointerup", endDrag, true);
      window.addEventListener("pointercancel", endDrag, true);
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
