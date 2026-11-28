/**
 * Pure HTML builders for desktop in-app dialogs (quick pick + input box).
 * No Electron — unit-testable; electron-host opens the windows.
 *
 * Native message boxes cap at a handful of buttons, which made model selection
 * (often 10–20 items) impossible. These dialogs scale to arbitrary lists.
 */
import { escapeHtml } from "./document-view";

export interface DialogQuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface BuildQuickPickHtmlOptions {
  title?: string;
  placeHolder?: string;
  items: readonly DialogQuickPickItem[];
}

export interface BuildInputBoxHtmlOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
}

/**
 * These windows are `data:` URLs, so they cannot load chat.css and have no
 * theme tokens to inherit — the palette is DESKTOP_THEME_CSS's dark values
 * copied literally. Keep them in step: a dialog in VS Code's greys next to an
 * app in AFK Pilot's is exactly what made this read as a foreign page.
 *
 * The layout rule is the other half of that: one padded card. Full-bleed
 * header and footer rules turn a 440x230 window into a miniature web page with
 * a chrome bar at each end, which is what the owner saw.
 */
const DIALOG_CSS = `
:root { color-scheme: dark; }
html, body {
  margin: 0; height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  background: #1e1e1e; color: #e6e6e6;
}
.wrap {
  display: flex; flex-direction: column; height: 100%;
  box-sizing: border-box; padding: 20px 22px 18px;
}
.hdr { flex-shrink: 0; }
.hdr h1 { margin: 0; font-size: 15px; font-weight: 600; color: #f2f2f2; letter-spacing: -.01em; }
.hdr p { margin: 6px 0 0; font-size: 12.5px; line-height: 1.45; color: #9d9d9d; }
/* The list bleeds back out through the card padding so a hovered row reads as
   a full-width row rather than a floating pill. */
.list {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  margin: 14px -8px 0; padding: 2px 0;
}
.item {
  display: block; width: 100%; text-align: left;
  border: none; background: transparent; color: inherit;
  font: inherit; padding: 8px 10px; border-radius: 6px; cursor: pointer;
  box-sizing: border-box;
}
.item:hover { background: #2a2d2e; outline: none; }
.item:focus { background: #37373d; color: #fff; outline: none; }
.item .lab { font-weight: 500; }
.item .desc { font-size: 11px; color: #9d9d9d; margin-top: 2px; }
.item:hover .desc, .item:focus .desc { color: #c0c0c0; }
.foot {
  flex-shrink: 0; padding-top: 16px;
  display: flex; gap: 8px; justify-content: flex-end; align-items: center;
}
input[type="text"], input[type="password"] {
  width: 100%; box-sizing: border-box;
  margin: 14px 0 0; padding: 8px 11px;
  border: 1px solid #3c3c3c; border-radius: 6px;
  background: #313131; color: #e6e6e6; font: inherit; outline: none;
}
input::placeholder { color: #8a8a8a; }
input:focus { border-color: #007fd4; box-shadow: 0 0 0 1px #007fd4; }
button.btn {
  border: none; border-radius: 6px; padding: 7px 16px; font: inherit; cursor: pointer;
}
button.btn:focus-visible { outline: 2px solid #007fd4; outline-offset: 2px; }
button.primary { background: #0e639c; color: #fff; }
button.primary:hover { background: #1177bb; }
button.secondary { background: #3a3d41; color: #e6e6e6; }
button.secondary:hover { background: #45494d; }
.empty { padding: 24px 0; color: #9d9d9d; text-align: center; }
`;

function shell(title: string, body: string, boot: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>${DIALOG_CSS}</style>
</head>
<body>
${body}
<script>
${boot}
</script>
</body>
</html>`;
}

/**
 * Map a dialog selection index to an item. Returns undefined for cancel /
 * out-of-range — shared by the host and tests so a 20-item pick is not
 * special-cased away.
 */
export function selectQuickPickIndex<T>(
  items: readonly T[],
  index: unknown,
): T | undefined {
  if (typeof index !== "number" || !Number.isInteger(index)) return undefined;
  if (index < 0 || index >= items.length) return undefined;
  return items[index];
}

/** Build the quick-pick HTML document (items rendered by index). */
export function buildQuickPickHtml(options: BuildQuickPickHtmlOptions): string {
  const title = options.title || "Choose";
  const placeHolder = options.placeHolder || "Select an item";
  const items = options.items;
  const rows = items.length
    ? items
        .map((it, i) => {
          const desc = it.description
            ? `<div class="desc">${escapeHtml(it.description)}${
                it.detail ? ` · ${escapeHtml(it.detail)}` : ""
              }</div>`
            : it.detail
              ? `<div class="desc">${escapeHtml(it.detail)}</div>`
              : "";
          return `<button type="button" class="item" data-index="${i}" autofocus="${
            i === 0 ? "true" : "false"
          }"><div class="lab">${escapeHtml(it.label)}</div>${desc}</button>`;
        })
        .join("\n")
    : `<div class="empty">No items</div>`;

  const body = `<div class="wrap">
  <div class="hdr"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(placeHolder)}</p></div>
  <div class="list" role="listbox">${rows}</div>
  <div class="foot"><button type="button" class="btn secondary" id="cancel">Cancel</button></div>
</div>`;

  const boot = `
(function () {
  var api = window.deskDialog;
  function cancel() { if (api) api.cancel(); }
  function pick(i) { if (api) api.submit({ kind: "quickpick", index: i }); }
  document.getElementById("cancel").onclick = cancel;
  document.querySelectorAll(".item").forEach(function (el) {
    el.addEventListener("click", function () {
      pick(parseInt(el.getAttribute("data-index"), 10));
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  var first = document.querySelector(".item");
  if (first) first.focus();
})();`;

  return shell(title, body, boot);
}

/** Build the input-box HTML document. */
export function buildInputBoxHtml(options: BuildInputBoxHtmlOptions = {}): string {
  const title = options.title || "Input";
  const prompt = options.prompt || "";
  const placeHolder = options.placeHolder || "";
  const value = options.value || "";
  const inputType = options.password ? "password" : "text";

  const body = `<div class="wrap">
  <div class="hdr">
    <h1>${escapeHtml(title)}</h1>
    ${prompt ? `<p>${escapeHtml(prompt)}</p>` : ""}
  </div>
  <input id="val" type="${inputType}" placeholder="${escapeHtml(placeHolder)}" value="${escapeHtml(value)}" />
  <div class="foot" style="margin-top:auto">
    <button type="button" class="btn secondary" id="cancel">Cancel</button>
    <button type="button" class="btn primary" id="ok">OK</button>
  </div>
</div>`;

  const boot = `
(function () {
  var api = window.deskDialog;
  var input = document.getElementById("val");
  function cancel() { if (api) api.cancel(); }
  function ok() { if (api) api.submit({ kind: "input", value: input.value }); }
  document.getElementById("cancel").onclick = cancel;
  document.getElementById("ok").onclick = ok;
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); ok(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.focus();
  input.select();
})();`;

  return shell(title, body, boot);
}

/** Parse a dialog submit payload from the dialog preload bridge. */
export function parseDialogSubmit(raw: unknown):
  | { kind: "quickpick"; index: number }
  | { kind: "input"; value: string }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "quickpick" && typeof o.index === "number" && Number.isInteger(o.index)) {
    return { kind: "quickpick", index: o.index };
  }
  if (o.kind === "input" && typeof o.value === "string") {
    return { kind: "input", value: o.value };
  }
  return null;
}

// ── Native message-box contract (VS Code show*Message parity) ─────────────
//
// VS Code returns `undefined` when a modal is dismissed / Cancelled, and modal
// dialogs get an implicit Cancel. Electron's showMessageBox returns cancelId
// as `response` on Esc/window-close — so cancelId must never point at an
// action label, or a single-button confirmation becomes un-cancellable
// (Esc "chooses" the only action).

/** Label VS Code adds implicitly on modal confirmations. */
export const MESSAGE_BOX_CANCEL_LABEL = "Cancel";

export interface MessageBoxButtonPlan {
  /** Buttons passed to Electron `dialog.showMessageBox`. */
  dialogButtons: string[];
  /** Enter activates the first action (or OK). */
  defaultId: number;
  /** Esc / window close — always a non-action target when actions exist. */
  cancelId: number;
}

/**
 * Build the Electron button row for a host `show*Message` call.
 *
 * - No action buttons → `["OK"]` (informational; choice is always undefined).
 * - Action buttons → append Cancel when missing so Esc/dismiss cannot map to
 *   an action. Modal callers need this for VS Code parity; non-modal Electron
 *   message boxes need it too (there is no toast dismiss path).
 */
export function planMessageBoxButtons(
  actionButtons: readonly string[],
): MessageBoxButtonPlan {
  if (actionButtons.length === 0) {
    return { dialogButtons: ["OK"], defaultId: 0, cancelId: 0 };
  }
  const dialogButtons = [...actionButtons];
  if (!dialogButtons.includes(MESSAGE_BOX_CANCEL_LABEL)) {
    dialogButtons.push(MESSAGE_BOX_CANCEL_LABEL);
  }
  // Prefer the last Cancel so an explicit trailing Cancel from the caller wins.
  let cancelId = dialogButtons.length - 1;
  for (let i = dialogButtons.length - 1; i >= 0; i--) {
    if (dialogButtons[i] === MESSAGE_BOX_CANCEL_LABEL) {
      cancelId = i;
      break;
    }
  }
  return { dialogButtons, defaultId: 0, cancelId };
}

/**
 * Map an Electron `response` index to the VS Code return value.
 *
 * Returns the action label only when the user chose a caller-supplied button.
 * Cancel (implicit or window dismiss via cancelId), OK-only notices, and
 * out-of-range indices all yield `undefined`.
 */
export function resolveMessageBoxChoice(
  actionButtons: readonly string[],
  dialogButtons: readonly string[],
  response: number,
): string | undefined {
  if (actionButtons.length === 0) return undefined;
  if (!Number.isInteger(response) || response < 0 || response >= dialogButtons.length) {
    return undefined;
  }
  const chosen = dialogButtons[response];
  // Implicit Cancel we appended is not a caller action.
  if (
    chosen === MESSAGE_BOX_CANCEL_LABEL &&
    !actionButtons.includes(MESSAGE_BOX_CANCEL_LABEL)
  ) {
    return undefined;
  }
  if (!actionButtons.includes(chosen)) return undefined;
  return chosen;
}

/** Public repo linked from the Help menu — this repo only. */
export const DESKTOP_PUBLIC_REPO_URL = "https://github.com/phuryn/grok-build-vscode";

/** The name people see: window title, About, the app and tray menus, dialogs.
 *  electron-builder.yml repeats it for shortcuts, the uninstall entry, the macOS
 *  menu bar and the Linux launcher (pinned by the packaging tests). It was
 *  "Grok Build Desktop (Community)" until 2026-11-28; the "(Community)" said this
 *  is not an xAI product, which a name without "Grok" no longer suggests. */
export const DESKTOP_APP_NAME = "AFK Pilot";

/** The app's old name, kept where people never see it and changing it would
 *  cost them something: main.ts gives it to Electron before anything resolves a
 *  path, and macOS names the Keychain item that encrypts saved keys
 *  "<name> Safe Storage" from it (Linux keys its libsecret entry the same way),
 *  so a new value would leave every saved key unreadable after an update. It is
 *  also the host's appName, which telemetry reports. */
export const DESKTOP_APP_INTERNAL_NAME = "Grok Build Desktop";
