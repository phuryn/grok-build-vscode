/**
 * The project-mark picker — one grid, three surfaces.
 *
 * Hand-written, unlike its neighbour `repo-icons.js` (which is generated path
 * data). Shared rather than copied because the VS Code rail and the
 * desktop/browser rail each own their own popover machinery but must offer the
 * SAME 95 marks in the same order with the same search: two copies of a
 * 95-cell grid drift the first time one of them is touched, and the drift is
 * invisible until someone opens the other surface.
 *
 * The caller owns placement, dismissal and the message — this returns an
 * element and calls back. That is the seam the two rails already disagree
 * about (one anchors to a ⋯ button, one re-anchors to a saved rect), and it is
 * the only thing they are allowed to disagree about here.
 */
(function (root) {
  "use strict";

  const { l10n } = root.GrokWebviewHelpers;
  const ALL = "all";

  /**
   * Build a picker.
   *
   * @param {object} opts
   * @param {string} opts.currentIcon  the project's stored id, "" for default
   * @param {(id: string) => void} opts.onPick   called with the chosen id ("" = default)
   * @param {() => void} [opts.onClose]  Escape, or a click on the current choice
   * @returns {{ el: HTMLElement, focus: () => void } | null}
   */
  function create(opts) {
    const marks = root.GrokRepoIcons;
    if (!marks) return null;
    const doc = root.document;
    const current = typeof opts.currentIcon === "string" ? opts.currentIcon : "";
    const onPick = typeof opts.onPick === "function" ? opts.onPick : () => {};
    const onClose = typeof opts.onClose === "function" ? opts.onClose : () => {};

    const el = doc.createElement("div");
    el.className = "repo-icon-picker";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Project icon");

    const search = doc.createElement("input");
    search.type = "search";
    search.className = "repo-icon-search";
    search.placeholder = "Search icons";
    search.setAttribute("aria-label", "Search icons");
    // The webview's own find-on-type and the rail's shortcuts both listen at the
    // document; a keystroke meant for this box is not meant for either.
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { onClose(); return; }
      // Type three letters and press Enter — the whole point of a search box
      // over 95 cells is that you never have to reach the grid.
      if (e.key === "Enter" || e.key === "ArrowDown") {
        const first = visibleCells()[0];
        if (!first) return;
        e.preventDefault();
        if (e.key === "Enter") first.click();
        else { first.tabIndex = 0; first.focus(); }
      }
    });
    el.appendChild(search);

    const tabs = doc.createElement("div");
    tabs.className = "repo-icon-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Icon groups");
    el.appendChild(tabs);

    const grid = doc.createElement("div");
    grid.className = "repo-icon-grid";
    grid.setAttribute("role", "listbox");
    grid.setAttribute("aria-label", "Project icon");
    el.appendChild(grid);

    const empty = doc.createElement("div");
    empty.className = "repo-icon-empty";
    empty.textContent = "No icons match.";
    empty.hidden = true;
    el.appendChild(empty);

    let group = ALL;
    const tabButtons = [];
    function addTab(id, label) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "repo-icon-tab";
      btn.setAttribute("role", "tab");
      btn.dataset.group = id;
      btn.textContent = label;
      btn.onclick = (e) => {
        e.stopPropagation();
        group = id;
        apply();
      };
      tabs.appendChild(btn);
      tabButtons.push(btn);
    }
    addTab(ALL, "All");
    for (const g of marks.GROUPS) addTab(g.id, g.label);

    /** @type {{ btn: HTMLElement, group: string, terms: string }[]} */
    const cells = [];

    function addCell(id, label, groupId, extraClass) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "repo-icon-cell" + (extraClass ? " " + extraClass : "") +
        (id === current ? " is-selected" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", id === current ? "true" : "false");
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.dataset.icon = id;
      btn.tabIndex = -1;
      btn.innerHTML = marks.svg(id) || marks.svg(marks.DEFAULT_ID);
      btn.onclick = (e) => {
        e.stopPropagation();
        // Re-picking what is already set should not churn the catalog, or cost
        // a remote round trip, so it closes and writes nothing.
        if (id === current) { onClose(); return; }
        onPick(id);
      };
      grid.appendChild(btn);
      // Underscores are how the vendor spells its ids; people type spaces.
      cells.push({ btn, group: groupId, terms: (label + " " + id.replace(/_/g, " ")).toLowerCase() });
    }

    // The default sits first and belongs to no group, so it is reachable from
    // every tab: "put it back" should never be behind a tab you have to guess.
    addCell("", "Default folder", ALL, "is-default");
    for (const g of marks.GROUPS) {
      for (const [id, label] of g.icons) addCell(id, label, g.id, "");
    }

    function visibleCells() {
      return cells.filter((c) => !c.btn.hidden).map((c) => c.btn);
    }

    function apply() {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const c of cells) {
        const inGroup = group === ALL || c.group === group || c.group === ALL;
        const matches = !q || c.terms.includes(q);
        c.btn.hidden = !(inGroup && matches);
        if (!c.btn.hidden) shown++;
      }
      empty.hidden = shown > 0;
      for (const btn of tabButtons) {
        const on = btn.dataset.group === group;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      }
      const visible = visibleCells();
      // Exactly one cell is tab-reachable, so Tab leaves the grid rather than
      // walking 95 buttons — arrows move within it (roving tabindex).
      for (const btn of visible) btn.tabIndex = -1;
      const focused = visible.find((b) => b.classList.contains("is-selected")) || visible[0];
      if (focused) focused.tabIndex = 0;
    }

    search.addEventListener("input", () => {
      // Typing must never leave a match hidden behind a tab, so a query widens
      // the scope back to everything rather than searching inside one group.
      if (search.value.trim()) group = ALL;
      apply();
    });

    grid.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!keys.includes(e.key)) return;
      const visible = visibleCells();
      const i = visible.indexOf(doc.activeElement);
      if (i < 0 || !visible.length) return;
      e.preventDefault();
      e.stopPropagation();
      // Column count is a CSS decision and changes with the popover width, so
      // it is measured rather than assumed: up/down step by whatever a row
      // actually holds, and fall back to one when nothing has laid out yet.
      const perRow = columnsIn(visible);
      let next = i;
      if (e.key === "ArrowRight") next = (i + 1) % visible.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + visible.length) % visible.length;
      else if (e.key === "ArrowDown") next = Math.min(visible.length - 1, i + perRow);
      else if (e.key === "ArrowUp") next = Math.max(0, i - perRow);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = visible.length - 1;
      visible[i].tabIndex = -1;
      visible[next].tabIndex = 0;
      visible[next].focus();
    });

    function columnsIn(visible) {
      if (visible.length < 2 || typeof visible[0].getBoundingClientRect !== "function") return 1;
      const top = visible[0].getBoundingClientRect().top;
      let n = 0;
      for (const btn of visible) {
        if (Math.abs(btn.getBoundingClientRect().top - top) > 1) break;
        n++;
      }
      return n || 1;
    }

    apply();

    return {
      el,
      /** `preferGrid` focuses the current mark rather than the search box, for
       *  a caller that does not want an on-screen keyboard raised over the
       *  grid. Default stays the search box: with a keyboard already present,
       *  typing is the fastest way to 96 marks, and arrows reach the grid. */
      focus(preferGrid) {
        try {
          if (preferGrid) {
            const cell = el.querySelector(".repo-icon-cell.is-selected") ||
              el.querySelector(".repo-icon-cell");
            if (cell) { cell.tabIndex = 0; cell.focus(); return; }
          }
          search.focus();
        } catch (_) { /* detached */ }
      },
    };
  }

  root.GrokRepoIconPicker = { create };
})(typeof globalThis !== "undefined" ? globalThis : window);
