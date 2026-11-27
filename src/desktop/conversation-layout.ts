export const DESKTOP_CONVERSATIONS_ARG = "--grok-desktop-conversations";
export const DESKTOP_CONVERSATION_PANE_ARG = "--grok-desktop-conversation-pane";

const CHAT_MIN_WIDTH = 360;

/** Width in CSS pixels after the rail, dock, and text scale are accounted for. */
export function conversationColumnCapacity(width: number): number {
  // Leave a pixel for the rule between each pair of columns.
  return Math.max(0, Math.floor((width + 1) / (CHAT_MIN_WIDTH + 1)) - 1);
}

// The DOM owns the space between Projects and Files. Native views occupy
// that space in window DIPs, including when CSS chat zoom scales the document.
export const DESKTOP_CONVERSATION_LAYOUT_BOOT = `
(() => {
  const capacityFor = ${conversationColumnCapacity.toString()};
  const CHAT_MIN_WIDTH = ${CHAT_MIN_WIDTH};
  const compactWidth = CHAT_MIN_WIDTH + 180 + 200 + 8;
  let columns;
  let slot;
  let picker;
  let total = 0;
  let showBelow = false;
  let observer;
  let layers;
  let filesObserver;
  let covered;
  let frame;
  let measuredZoom;
  const body = () => document.body;
  const bridge = () => window.grokDesktopConversations;
  const syncCoverage = () => {
    const flags = body().classList;
    const next = flags.contains("desk-ft-maximized") || !!body().dataset.modalAbove
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
    const files = document.getElementById("desk-ft-top-toggle");
    const compact = body().classList.contains("desk-split-compact");
    if (compact) {
      projects?.setAttribute("aria-expanded", String(name === "projects"));
    } else {
      projects?.removeAttribute("aria-expanded");
    }
    const filesOpen = compact ? name === "files" : !!window.__grokDeskFilePanel?.isOpen();
    files?.setAttribute("aria-expanded", String(filesOpen));
    files?.setAttribute("title", filesOpen ? "Hide file panel" : "Show file panel");
    syncCoverage();
  };
  const drawerClick = event => {
    if (!body().classList.contains("desk-split-compact")) return;
    const button = event.target.closest?.("#desk-rail-open-btn, #desk-rail-toggle, #desk-ft-top-toggle");
    if (!button) return;
    event.stopImmediatePropagation();
    if (button.id === "desk-rail-toggle") { setDrawer(""); return; }
    const name = button.id === "desk-ft-top-toggle" ? "files" : "projects";
    setDrawer(body().dataset.splitDrawer === name ? "" : name);
    if (name === "files" && body().dataset.splitDrawer === name) window.__grokDeskFilePanel?.setOpen(true);
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
      const capacity = capacityFor(columns.getBoundingClientRect().width / zoom);
      if (capacity > 0) showBelow = false;
      const stacked = capacity === 0 && showBelow;
      columns.classList.toggle("desk-chat-stacked", stacked);
      const count = stacked ? 1 : Math.min(total, capacity);
      slot.hidden = count === 0;
      slot.style.flexGrow = count;
      const { left, top, right, bottom } = slot.getBoundingClientRect();
      const x = Math.ceil(left) + (stacked ? 0 : 1);
      const y = Math.ceil(top) + (stacked ? 1 : 0);
      bridge()?.setBounds({
        x, y, width: Math.max(0, Math.floor(right) - x), height: Math.max(0, Math.floor(bottom) - y)
      }, count, stacked);
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
  window.__grokOpenCompactFiles = () => {
    if (body().classList.contains("desk-split-compact")) setDrawer("files");
  };
  window.__grokCloseCompactProjects = () => {
    if (body().dataset.splitDrawer === "projects") setDrawer("");
  };
  window.__grokConversationLayout = (count, below) => {
    total = count;
    showBelow = !!below;
    if (count === 0) {
      if (!columns) return;
      observer?.disconnect();
      layers?.disconnect();
      filesObserver?.disconnect();
      window.removeEventListener("afkpilot-layers", syncCoverage);
      window.removeEventListener("resize", measure);
      document.removeEventListener("click", drawerClick, true);
      covered = undefined;
      if (columns?.isConnected) {
        const chat = columns.firstElementChild;
        const header = chat?.querySelector(":scope > .top-bar");
        if (header) columns.parentElement.before(header);
        columns.before(chat);
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
      chat.before(columns);
      slot = document.createElement("div");
      slot.id = "desk-conversation-slot";
      slot.setAttribute("aria-hidden", "true");
      columns.append(chat, slot);
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
      const files = document.getElementById("desk-ft-top-toggle");
      if (files) {
        const publish = () => {
          const badge = files.querySelector(".gfp-toggle-count:not([hidden])");
          bridge()?.publishFiles(files.getAttribute("aria-expanded") === "true", files.title, badge?.textContent || "");
        };
        filesObserver = new MutationObserver(publish);
        filesObserver.observe(files, { attributes: true, childList: true, subtree: true, characterData: true });
        publish();
      }
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

export const DESKTOP_CONVERSATION_PANE_BOOT = String.raw`
document.addEventListener("DOMContentLoaded", () => {
  const files = document.getElementById("desk-ft-top-toggle");
  if (!files) return;
  files.insertAdjacentHTML("afterbegin", window.GrokFilePanel.panelIcon("right"));
  files.addEventListener("click", () => window.grokDesktopConversations?.toggleFiles());
});
window.__grokConversationFiles = (expanded, title, count) => {
  const files = document.getElementById("desk-ft-top-toggle");
  const badge = files?.querySelector(".gfp-toggle-count");
  if (!badge) return;
  files.setAttribute("aria-expanded", expanded);
  files.title = title;
  badge.textContent = count;
  badge.hidden = !count;
};
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
}
