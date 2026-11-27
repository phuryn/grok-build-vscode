export const DESKTOP_CONVERSATIONS_ARG = "--grok-desktop-conversations";
export const DESKTOP_CONVERSATION_PANE_ARG = "--grok-desktop-conversation-pane";

export const CHAT_MIN_WIDTH = 360;
export const FILES_MIN_WIDTH = 200;
// The 5px grab area overlaps its neighbours by 2px on each side.
export const FILES_RESIZER_WIDTH = 1;

/** Keep chat/panel pairs together. Size the pairs evenly unless one needs more room. */
export function planConversationColumns(width: number, filesOpen: readonly boolean[], preferred = -1, zoom = 1) {
  const minimum = (index: number) => Math.ceil(zoom * (CHAT_MIN_WIDTH +
    (filesOpen[index] ? FILES_MIN_WIDTH + FILES_RESIZER_WIDTH : 0)));
  const visible = [0];
  let remaining = width - minimum(0);
  const tryFit = (index: number) => {
    const cost = minimum(index) + 1;
    if (remaining < cost) return;
    visible.push(index);
    remaining -= cost;
  };
  if (preferred > 0 && preferred < filesOpen.length) tryFit(preferred);
  for (let index = 1; index < filesOpen.length; index++) {
    if (index !== preferred) tryFit(index);
  }
  visible.sort((a, b) => a - b);
  let space = width - (visible.length - 1);
  const widths = new Map<number, number>();
  for (const index of [...visible].sort((a, b) => minimum(b) - minimum(a))) {
    const share = Math.ceil(space / (visible.length - widths.size));
    const size = visible.length === 1 ? space : Math.max(minimum(index), share);
    widths.set(index, size);
    space -= size;
  }
  return visible.map(index => ({ index, width: widths.get(index)! }));
}

// The DOM measures the space after Projects. The host assigns the first pair
// and the native views within that rectangle in window DIPs.
export const DESKTOP_CONVERSATION_LAYOUT_BOOT = `
(() => {
  const CHAT_MIN_WIDTH = ${CHAT_MIN_WIDTH};
  const compactWidth = CHAT_MIN_WIDTH + 180 + 200 + 8;
  let columns;
  let slot;
  let picker;
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
  window.__grokConversationPicker = (hidden, stacked) => {
    if (!picker) return;
    picker.hidden = hidden.length === 0 && !stacked;
    if (picker.hidden && document.activeElement === picker) document.getElementById("input")?.focus();
    const unread = hidden.filter(chat => chat.unread).length;
    const label = hidden.length ? "More chats (" + hidden.length + ")" : "Chats";
    const option = (title, value) => {
      const node = document.createElement("option");
      node.value = value;
      node.textContent = title;
      return node;
    };
    picker.replaceChildren(option(label + (unread ? " · " + unread + " unread" : ""), ""),
      ...hidden.map(chat => option(chat.title + (chat.unread ? " · Unread" : ""), String(chat.id))));
    picker.options[0].disabled = true;
    picker.value = "";
    picker.dataset.unread = String(unread > 0);
    if (stacked) picker.append(option(picker.dataset.firstChatLabel, "0"));
  };
  window.__grokCloseCompactProjects = () => {
    if (body().dataset.splitDrawer === "projects") setDrawer("");
  };
  window.__grokConversationGeometry = (width, stacked, nativeCount) => {
    if (!columns?.isConnected) return;
    columns.classList.toggle("desk-chat-stacked", stacked);
    columns.style.setProperty("--desk-first-column-width", width + "px");
    slot.hidden = !nativeCount;
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
      picker?.remove();
      columns = undefined;
      slot = undefined;
      measuredZoom = undefined;
      window.__grokReclampSidePanels?.();
      window.__grokFitDesktopFiles?.();
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
      slot = document.createElement("div");
      slot.id = "desk-conversation-slot";
      slot.setAttribute("aria-hidden", "true");
      columns.append(shell, slot);
      window.__grokReclampSidePanels?.();
      window.__grokFitDesktopFiles?.();
      window.__grokRefreshDesktopTheme?.();
      picker = document.createElement("select");
      picker.id = "desk-conversation-picker";
      picker.dataset.firstChatLabel = header?.dataset.firstChatLabel || "";
      picker.setAttribute("aria-label", "Switch to an open chat");
      picker.hidden = true;
      picker.addEventListener("change", () => {
        if (picker.value !== "") {
          if (body().dataset.splitDrawer) setDrawer("");
          bridge()?.showPane(Number(picker.value));
        }
        picker.value = "";
      });
      header?.after(picker);
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
