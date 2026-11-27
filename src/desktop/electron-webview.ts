/**
 * HostWebview over Electron IPC + a custom `app-resource://` protocol.
 *
 * The sidebar sets `html` (built by `getHtml`) and never hand-writes a page.
 * Scripts/styles resolve through {@link asWebviewUri} → `app-resource://` path
 * URLs under full-serve roots (canonical containment). Generated media and
 * other host-chosen files go through a {@link ResourceRegistry} opaque handle
 * so the renderer cannot invent paths into `~/.grok`.
 *
 * Renderer → host messages are schema-validated ({@link parseWebviewMsg})
 * before any sidebar listener runs.
 */
import type { WebContents } from "electron";
import * as path from "node:path";
import type { HostDisposable, HostWebview, Uri } from "../host";
import {
  appResourceMayServeStaticPath,
  resolveAppResourceServe,
  rootServePolicy,
} from "./app-resource-policy";
import {
  authorizeDesktopWebviewMsg,
  type DesktopOpenFileContext,
} from "./desktop-policy";
import { FileSelectionRegistry } from "./file-selection-registry";
import {
  RESOURCE_REGISTRY_URL_SEGMENT,
  ResourceRegistry,
} from "./resource-registry";
import { parseWebviewMsg } from "./webview-msg-validate";
import { DESKTOP_CONVERSATION_LAYOUT_BOOT, DESKTOP_CONVERSATION_PANE_BOOT } from "./conversation-layout";

const SCHEME = "app-resource";
const AUTHORITY = "vsc-resource";

/**
 * Fixed document URL under the privileged `app-resource` scheme.
 *
 * The main window must load a **standard, secure** origin so Chromium grants
 * `localStorage` (and friends). A `data:` document has an opaque origin and
 * storage is unavailable — every chat.js preference helper then no-ops silently.
 *
 * Path is a narrow, non-filesystem capability: the protocol serves the in-memory
 * HTML from {@link ElectronWebview}, never an arbitrary path. Origin is always
 * {@link APP_ORIGIN} (`app-resource://vsc-resource`) across launches.
 */
export const APP_DOCUMENT_PATH = "/__app__/index.html";
export const APP_DOCUMENT_URL = `${SCHEME}://${AUTHORITY}${APP_DOCUMENT_PATH}`;
/** Stable origin for the main renderer (scheme + host; no port). */
export const APP_ORIGIN = `${SCHEME}://${AUTHORITY}`;

/** True when `url` is exactly the main app document (not a static/registry asset). */
export function isAppDocumentUrl(url: string): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${SCHEME}:`) return false;
    if (parsed.hostname !== AUTHORITY) return false;
    return parsed.pathname === APP_DOCUMENT_PATH;
  } catch {
    return false;
  }
}

/**
 * Desktop theme tokens — port of AFK Pilot `web/chat.html` palette (dark + light).
 * The extension has no equivalent shell; VS Code supplies its own tokens.
 * Active row grey: --vscode-list-activeSelectionBackground (#37373d / #e4e6f1),
 * not Dark+ blue (#094771).
 */
/**
 * localStorage key for the desktop light/dark preference.
 * Requires a real origin ({@link APP_DOCUMENT_URL}); no separate IPC store.
 */
export const DESKTOP_THEME_STORAGE_KEY = "grok-desktop-theme";

/** Early head boot: localStorage → OS matchMedia fallback; body.vscode-light sync. */
const DESKTOP_THEME_BOOT = `(function(){
  var root=document.documentElement;
  var system=window.matchMedia&&matchMedia("(prefers-color-scheme: light)");
  function readTheme(){
    try{
      var saved=localStorage.getItem(${JSON.stringify(DESKTOP_THEME_STORAGE_KEY)});
      if(saved==="light"||saved==="dark")return saved;
    }catch(e){}
    return system&&system.matches?"light":"dark";
  }
  var initial=readTheme();
  root.setAttribute("data-theme",initial);
  function syncBodyTheme(){
    if(document.body)document.body.classList.toggle("vscode-light",root.getAttribute("data-theme")==="light");
  }
  function wireThemeToggle(){
    var btn=document.getElementById("desk-theme-toggle");
    if(!btn||btn.dataset.themeWired)return;
    btn.dataset.themeWired="1";
    btn.addEventListener("click",function(){window.__toggleDesktopTheme();});
  }
  document.addEventListener("DOMContentLoaded",function(){syncBodyTheme();wireThemeToggle();});
  function refreshTheme(){
    root.setAttribute("data-theme",readTheme());
    syncBodyTheme();
  }
  window.__grokRefreshDesktopTheme=refreshTheme;
  system?.addEventListener?.("change",function(){
    if(document.body?.dataset.editorChat||document.getElementById("desk-conversation-columns"))refreshTheme();
  });
  window.addEventListener("storage",function(event){
    if(event.key===${JSON.stringify(DESKTOP_THEME_STORAGE_KEY)})refreshTheme();
  });
  syncBodyTheme();
  window.__toggleDesktopTheme=function(){
    var next=root.getAttribute("data-theme")==="dark"?"light":"dark";
    root.setAttribute("data-theme",next);
    try{localStorage.setItem(${JSON.stringify(DESKTOP_THEME_STORAGE_KEY)},next);}catch(e){}
    syncBodyTheme();
  };
  if(document.readyState!=="loading"){syncBodyTheme();wireThemeToggle();}
})();`;

export const DESKTOP_THEME_CSS = `
:root {
  color-scheme: dark;
  /* AFK Pilot dark palette (web/chat.html :root) */
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, Helvetica, Arial, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: "SF Mono", Menlo, Consolas, monospace;
  --vscode-foreground: #e6e6e6;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-editor-background: #1e1e1e;
  --vscode-sideBar-background: #1e1e1e;
  --vscode-editorWidget-background: #252526;
  --vscode-editorWidget-border: #454545;
  --vscode-widget-border: #454545;
  --vscode-panel-border: #2b2b2b;
  --vscode-focusBorder: #007fd4;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #e6e6e6;
  --vscode-button-secondaryHoverBackground: #45494e;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #e6e6e6;
  --vscode-input-border: #3c3c3c;
  --vscode-textLink-foreground: #3794ff;
  --vscode-textLink-activeForeground: #3794ff;
  --vscode-textCodeBlock-background: #0a0a0a;
  --vscode-textPreformat-foreground: #d7ba7d;
  --vscode-list-hoverBackground: #2a2d2e;
  /* Neutral selection grey (not Dark+ blue #094771) — active rail row. */
  --vscode-list-activeSelectionBackground: #37373d;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-inactiveSelectionBackground: #37373d;
  --vscode-toolbar-hoverBackground: #383b3d;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-errorForeground: #f48771;
  --vscode-charts-green: #4ec9b0;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-yellow: #d7ba7d;
  --vscode-charts-red: #f48771;
  --e1: #4ec9b0;
  --e2: #3794ff;
  --e3: #a978f5;
  --e4: #f48771;
  --vscode-scrollbarSlider-background: rgba(121,121,121,0.4);
  --vscode-scrollbarSlider-hoverBackground: rgba(100,100,100,0.7);
  --vscode-scrollbarSlider-activeBackground: rgba(191,191,191,0.5);
  /* Desktop-only chrome (menus / keybindings) — keep usable defaults */
  --vscode-keybindingLabel-background: rgba(128,128,128,0.17);
  --vscode-keybindingLabel-border: rgba(51,51,51,0.6);
  --vscode-keybindingLabel-foreground: #e6e6e6;
  --vscode-widget-shadow: rgba(0,0,0,0.36);
  --vscode-dropdown-background: #313131;
  --vscode-dropdown-foreground: #e6e6e6;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #e6e6e6;
  --vscode-menu-selectionBackground: #37373d;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-border: #454545;
  --vscode-progressBar-background: #0e70c0;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorBorder: #be1100;
}
:root[data-theme="light"] {
  color-scheme: light;
  --vscode-foreground: #3b3b3b;
  --vscode-descriptionForeground: #6e6e6e;
  --vscode-editor-background: #ffffff;
  --vscode-sideBar-background: #ffffff;
  --vscode-editorWidget-background: #f8f8f8;
  --vscode-editorWidget-border: #d4d4d4;
  --vscode-widget-border: #d4d4d4;
  --vscode-panel-border: #e5e5e5;
  --vscode-focusBorder: #005fb8;
  --vscode-button-background: #005fb8;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0258a8;
  --vscode-button-secondaryBackground: #e5e5e5;
  --vscode-button-secondaryForeground: #3b3b3b;
  --vscode-button-secondaryHoverBackground: #cccccc;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #3b3b3b;
  --vscode-input-border: #cecece;
  --vscode-textLink-foreground: #005fb8;
  --vscode-textLink-activeForeground: #005fb8;
  --vscode-textCodeBlock-background: #f6f6f6;
  --vscode-list-hoverBackground: #f2f2f2;
  --vscode-list-activeSelectionBackground: #e4e6f1;
  --vscode-list-activeSelectionForeground: #3b3b3b;
  --vscode-list-inactiveSelectionBackground: #e4e6f1;
  --vscode-toolbar-hoverBackground: #e5e5e5;
  --vscode-badge-background: #cccccc;
  --vscode-badge-foreground: #333333;
  --vscode-errorForeground: #cd3131;
  --vscode-charts-green: #388a34;
  --vscode-charts-blue: #1a85ff;
  --vscode-charts-yellow: #bf8803;
  --vscode-charts-red: #cd3131;
  --e1: #1a8f7d;
  --e2: #1a85ff;
  --e3: #8250df;
  --e4: #cd3131;
  --vscode-scrollbarSlider-background: rgba(100,100,100,0.35);
  --vscode-scrollbarSlider-hoverBackground: rgba(100,100,100,0.55);
  --vscode-scrollbarSlider-activeBackground: rgba(0,0,0,0.6);
  --vscode-keybindingLabel-foreground: #3b3b3b;
  --vscode-dropdown-background: #ffffff;
  --vscode-dropdown-foreground: #3b3b3b;
  --vscode-dropdown-border: #cecece;
  --vscode-menu-background: #f8f8f8;
  --vscode-menu-foreground: #3b3b3b;
  --vscode-menu-selectionBackground: #e4e6f1;
  --vscode-menu-selectionForeground: #3b3b3b;
  --vscode-menu-border: #d4d4d4;
  --vscode-progressBar-background: #005fb8;
  --vscode-inputValidation-errorBackground: #f2dede;
  --vscode-inputValidation-errorBorder: #be1100;
}
html { background: #1a1a1a; }
:root[data-theme="light"] { background: #fbfbfc; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: #1a1a1a; color: var(--vscode-foreground); }
:root[data-theme="light"] body { background: #fbfbfc; }
:root:has(> body[data-editor-chat]),
:root[data-theme] > body[data-editor-chat] { background: var(--vscode-sideBar-background); }
body.desk #projects-rail .rail-session.open {
  --rail-selection-bg: color-mix(in srgb,
    var(--vscode-list-inactiveSelectionBackground, var(--rail-hover-bg)),
    var(--vscode-sideBar-background) 40%);
  background: var(--rail-selection-bg);
  --provider-badge-ring: var(--rail-selection-bg);
  color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground));
}
body.desk #projects-rail .rail-session.open .rail-session-actions {
  background: linear-gradient(to right, transparent 0%, var(--rail-selection-bg) 28%);
}
/* Theme toggle sun/moon (rail footer) — same as AFK Pilot */
:root[data-theme="dark"] .i-sun { display: block; }
:root[data-theme="dark"] .i-moon { display: none; }
:root[data-theme="light"] .i-sun { display: none; }
:root[data-theme="light"] .i-moon { display: block; }

/* Reading measure — desktop shell only (mirrors AFK Pilot web/chat.html).
   Shared chat.css is left alone so VS Code's narrow panel is unchanged.
   The top bar and scrollport fill the chat column; messages + composer use
   padding to keep their reading measure centered without moving the scrollbar. */
body.desk #messages,
body.desk .composer {
  max-width: none;
  width: 100%;
  margin-left: 0;
  margin-right: 0;
  box-sizing: border-box;
  padding-inline: max(calc(var(--pad) + 5px), calc((100% - 800px) / 2));
}
/* Without the file-tree shell, a slightly wider reading column is fine. */
body.desk:not(.desk-with-ft) #messages,
body.desk:not(.desk-with-ft) .composer {
  padding-inline: max(calc(var(--pad) + 5px), calc((100% - 1120px) / 2));
}
/* Keep the wrapper full-bleed so its child remains the pane's scrollport. */
body.desk #messages-wrap {
  max-width: none;
  width: 100%;
  margin-left: 0;
  margin-right: 0;
  box-sizing: border-box;
}
/* Top bar: full width of the chat column (not the reading measure). */
body.desk > .top-bar,
body.desk .app-main > .top-bar,
body.desk .desk-ft-chat > .top-bar {
  max-width: none;
  width: 100%;
  margin-left: 0;
  margin-right: 0;
  box-sizing: border-box;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  flex-shrink: 0;
}

/* Spacing rhythm — match AFK Pilot (web/chat.html), not chat.css body.desk's
   4px VS Code-panel pad. Desktop shell only; chat.css is untouched. */
body.desk {
  --pad: 8px;
}
/* Room under typed text before the toolbar (AFK Pilot: 11px). */
body.desk textarea#input,
body.desk .input-highlight {
  padding-bottom: 11px;
}
/* Extra air under the composer card vs the window edge. */
body.desk > .composer,
body.desk .desk-ft-chat > .composer {
  padding-bottom: max(12px, var(--pad));
}

#desk-conversation-columns {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
#desk-conversation-columns > .desk-ft-chat, #desk-conversation-slot {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
#desk-conversation-slot {
  border-inline-start: 1px solid var(--vscode-editorWidget-border);
  background: var(--vscode-editorWidget-border);
}
#desk-conversation-columns.desk-chat-stacked { flex-direction: column; }
.desk-chat-stacked #desk-conversation-slot {
  border-inline-start: 0;
  border-block-start: 1px solid var(--vscode-editorWidget-border);
}
/* Keep the send row in view when an autosized draft fills a short split. */
.desk-chat-stacked textarea#input {
  max-block-size: calc(2lh + 2 * var(--pad));
  overflow-y: auto !important;
}
@media (max-height: 330px) {
  body[data-editor-chat] textarea#input {
    max-block-size: calc(2lh + 2 * var(--pad));
    overflow-y: auto !important;
  }
}
body.desk-ft-maximized #desk-conversation-columns { display: none; }
#desk-conversation-picker {
  align-self: start;
  flex: none;
  field-sizing: content;
  max-inline-size: min(calc(100% - 2 * var(--pad)), 28ch);
  margin: 4px var(--pad) 0;
  padding: 3px 6px;
  font: inherit;
  color: var(--vscode-dropdown-foreground);
  background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 8px;
}
#desk-conversation-picker[data-unread="true"] { border-color: var(--vscode-charts-green); }
#desk-conversation-picker:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
body.desk-split-compact #desk-rail-open-btn { display: inline-flex; }
body.desk-split-compact #rail-resizer,
body.desk-split-compact #desk-ft-resizer,
body.desk-split-compact:not([data-split-drawer="projects"]) #projects-rail,
body.desk-split-compact:not([data-split-drawer="files"]) #desk-ft-panel { display: none !important; }
body.desk-split-compact[data-split-drawer="projects"] #projects-rail { display: flex !important; }
body.desk-split-compact #projects-rail,
body.desk-split-compact #desk-ft-panel {
  position: fixed;
  inset-block: var(--desk-drawer-top, 40px) 0;
  height: auto;
  max-inline-size: calc(100% - 2 * var(--pad));
  z-index: 40;
  box-shadow: 0 0 12px var(--vscode-widget-shadow);
}
body.desk-split-compact #projects-rail { inset-inline-start: 0; }
body.desk-split-compact #desk-ft-panel { inset-inline-end: 0; }
body.desk-split-compact #desk-ft-maximize { display: none; }
#desk-conversation-close {
  margin-inline-start: auto;
  font-size: 1.25em;
}

/* Scroll-edge fades — port of AFK Pilot web/chat.html (not shared chat.css). */
#messages-wrap {
  position: relative;
  z-index: 0;
  isolation: isolate;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
}
#messages-wrap > #messages {
  flex: 1 1 auto;
  min-height: 0;
}
.msg-fade {
  position: absolute;
  left: 0;
  right: 8px; /* clear the 8px scrollbar so it stays crisp */
  height: 18px;
  z-index: 4;
  pointer-events: none;
}
.msg-fade-top {
  top: 0;
  background: linear-gradient(to bottom, var(--vscode-sideBar-background), transparent);
  opacity: var(--fade-top-op, 0);
}
.msg-fade-bot {
  bottom: 0;
  background: linear-gradient(to top, var(--vscode-sideBar-background), transparent);
  opacity: var(--fade-bot-op, 0);
}
`;

export function asAppResourceUrl(uri: Uri): string {
  if (uri.scheme === "file") {
    // Portable Uri.path is POSIX-style, with a leading / before Windows drive.
    const encPath = uri.path
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `${SCHEME}://${AUTHORITY}${encPath.startsWith("/") ? encPath : `/${encPath}`}`;
  }
  // Non-file: still route through the scheme so CSP accepts it; path may be empty.
  const encPath = uri.path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${SCHEME}://${AUTHORITY}${encPath.startsWith("/") ? encPath : `/${encPath || "/"}`}`;
}

/** Build a registry-handle app-resource URL for an opaque media id. */
export function asAppResourceRegistryUrl(id: string): string {
  return `${SCHEME}://${AUTHORITY}/${RESOURCE_REGISTRY_URL_SEGMENT}/${id}`;
}

/** Decode an app-resource URL back to an absolute filesystem path (path-shaped only). */
export function appResourceUrlToFsPath(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname !== AUTHORITY) return undefined;
  let p = decodeURIComponent(parsed.pathname);
  // In-memory main document — not a filesystem path (served via getDocumentHtml).
  if (p === APP_DOCUMENT_PATH || isAppDocumentUrl(url)) return undefined;
  // Registry handles are not filesystem paths.
  if (p.includes(`/${RESOURCE_REGISTRY_URL_SEGMENT}/`) || p.startsWith(`/${RESOURCE_REGISTRY_URL_SEGMENT}/`)) {
    return undefined;
  }
  // Windows: /C:/Users/... → C:\Users\...
  if (/^\/[A-Za-z]:/.test(p)) {
    p = p.slice(1).replace(/\//g, path.sep);
  } else if (process.platform === "win32") {
    p = p.replace(/\//g, path.sep);
  }
  return p;
}

export const APP_RESOURCE_SCHEME = SCHEME;
export const APP_RESOURCE_CSP_SOURCE = `${SCHEME}:`;

export class ElectronWebview implements HostWebview {
  private _html = "";
  private _options: HostWebview["options"] = {};
  private listeners = new Set<(message: unknown) => unknown>();
  private allowedRoots: string[] = [];
  /** Host-issued media handles — only these resolve under media-only roots. */
  readonly registry = new ResourceRegistry();
  /**
   * Host-issued handles for OS picker / genuine file drops. `dropFile` carries
   * only these ids — never a renderer-invented path.
   */
  readonly fileSelection = new FileSelectionRegistry();
  /** Optional log for dropped IPC (wired from main). */
  onDroppedMessage?: (reason: string, raw: unknown) => void;
  onHostMessage?: (message: unknown) => void;
  /**
   * Workspace root for desktop openFile policy. Wired from main after the
   * folder is chosen; when unset, openFile is refused.
   * Prefer {@link getAuthContext} when session roots (worktrees) matter.
   */
  getWorkspaceRoot?: () => string | undefined;
  /**
   * Full desktop auth context (session roots + drop-handle resolver). Wired
   * from main after the sidebar exists so worktree sessions authorize correctly.
   */
  getAuthContext?: () => DesktopOpenFileContext;

  constructor(
    private readonly getContents: () => WebContents | null,
    private readonly documentUrl = APP_DOCUMENT_URL,
  ) {}

  get html(): string {
    return this._html;
  }

  set html(value: string) {
    // Store the served document (theme-injected). Reload re-fetches APP_DOCUMENT_URL
    // from this buffer — raw getHtml alone would drop desktop chrome on reload.
    this._html = injectTheme(value, this.documentUrl !== APP_DOCUMENT_URL);
    const contents = this.getContents();
    if (!contents || contents.isDestroyed()) return;
    void contents.loadURL(this.documentUrl).catch(() => {});
  }

  /**
   * HTML body for {@link APP_DOCUMENT_URL}. Empty until the sidebar assigns
   * {@link html}. Protocol handler only — not a filesystem path.
   */
  getDocumentHtml(): string {
    return this._html;
  }

  get options(): HostWebview["options"] {
    return this._options;
  }

  set options(value: HostWebview["options"]) {
    this._options = value ?? {};
    this.allowedRoots = (value?.localResourceRoots ?? [])
      .filter((u) => u.scheme === "file")
      .map((u) => path.normalize(u.fsPath));
  }

  get cspSource(): string {
    return APP_RESOURCE_CSP_SOURCE;
  }

  /**
   * Resolve an app-resource request URL to a serveable absolute path, or null.
   * Registry handles and static full-serve paths only — never free-form Grok home.
   */
  resolveResourceUrl(url: string): string | null {
    const fsPath = appResourceUrlToFsPath(url);
    const result = resolveAppResourceServe({
      urlOrPath: url,
      fsPath,
      allowedRoots: this.allowedRoots,
      registry: this.registry,
    });
    return result.ok ? result.fsPath : null;
  }

  /**
   * Whether a path-shaped URL may be served (static full-serve only).
   * @deprecated Prefer {@link resolveResourceUrl}; kept for diagnostics.
   */
  isPathAllowed(fsPath: string): boolean {
    if (!this.allowedRoots.length) return false;
    return appResourceMayServeStaticPath(fsPath, this.allowedRoots);
  }

  /** Absolute roots currently registered (tests / diagnostics). */
  getAllowedRoots(): readonly string[] {
    return this.allowedRoots;
  }

  postMessage(message: unknown): Thenable<boolean> {
    const contents = this.getContents();
    if (!contents || contents.isDestroyed()) {
      return Promise.resolve(false);
    }
    contents.send("host-to-webview", message);
    this.onHostMessage?.(message);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: (message: unknown) => unknown): HostDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Called from main when the renderer posts a webview message.
   * Schema-invalid / unknown types are dropped (never cast through).
   * Path-bearing ops pass through {@link authorizeDesktopWebviewMsg} with the
   * active session's roots (not merely the selected project folder).
   */
  dispatchMessage(message: unknown): void {
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "localChatFocus") {
      this.deliver({ type: "localChatFocus" });
      return;
    }
    const parsed = this.validateMessage(message);
    if (parsed) this.deliver(parsed);
  }

  /** Editor envelopes are local to the pane transport. Their actions still
   * pass through the same desktop validator as the main chat. */
  dispatchConversationMessage(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const frame = raw as Record<string, unknown>;
    if (frame.type === "ready") {
      const ready = this.validateMessage(raw);
      if (!ready) return false;
      this.deliver(ready);
      return true;
    }
    if (frame.type === "localChatFocus") {
      this.deliver({ type: "localChatFocus" });
      return true;
    }
    const { binding } = frame;
    if (typeof binding !== "number" || !Number.isSafeInteger(binding) || binding < 0) return false;
    if (frame.type === "editorChatDraft") {
      const { text, chipIds } = frame;
      if (typeof text !== "string" ||
          (chipIds !== undefined && (!Array.isArray(chipIds) || !chipIds.every(id => typeof id === "string")))) return false;
      this.deliver({ type: frame.type, binding, text, chipIds });
      return true;
    }
    if (frame.type !== "editorChatAction") return false;
    const message = this.validateMessage(frame.message);
    if (!message) return false;
    this.deliver({ type: frame.type, binding, message });
    return true;
  }

  private validateMessage(message: unknown) {
    const parsed = parseWebviewMsg(message);
    if (!parsed) {
      this.onDroppedMessage?.("invalid WebviewMsg", message);
      return;
    }
    const base = this.getAuthContext?.() ?? {
      workspaceRoot: this.getWorkspaceRoot?.(),
    };
    const auth = authorizeDesktopWebviewMsg(parsed, {
      ...base,
      requireDropFileHandle: true,
      resolveDropFileHandle: (id) => this.fileSelection.take(id),
    });
    if ("refused" in auth) {
      this.onDroppedMessage?.(
        `desktop policy refused ${auth.type}: ${auth.reason}`,
        message,
      );
      return;
    }
    return auth.msg;
  }

  private deliver(message: unknown): void {
    for (const listener of this.listeners) {
      try {
        void listener(message);
      } catch {
        /* best-effort — sidebar wraps handlers itself */
      }
    }
  }

  asWebviewUri(uri: Uri): string {
    if (uri.scheme !== "file") {
      return asAppResourceUrl(uri);
    }
    const fsPath = path.normalize(uri.fsPath);
    // Static full-serve roots (extension media/resources, staging): path URL
    // with canonical containment at serve time.
    for (const root of this.allowedRoots) {
      if (rootServePolicy(root) !== "full") continue;
      if (appResourceMayServeStaticPath(fsPath, [root])) {
        return asAppResourceUrl(uri);
      }
    }
    // Everything else (Grok home media, unlisted paths the host still wants
    // to stream): opaque registry handle only — and only when provenance
    // allows (canonical target under an approved root).
    try {
      const id = this.registry.register(fsPath, {
        allowedRoots: this.allowedRoots,
      });
      return asAppResourceRegistryUrl(id);
    } catch {
      // File not yet on disk, unreadable, or outside approved roots — path
      // URL still refuses at serve time unless it lands under a full-serve root.
      return asAppResourceUrl(uri);
    }
  }
}

function injectTheme(html: string, conversationPane: boolean): string {
  const styleTag = `<style id="grok-desktop-theme">${DESKTOP_THEME_CSS}</style>`;
  // Match getHtml's CSP nonce so the early theme boot is allowed under script-src.
  const nonceMatch = html.match(/script-src 'nonce-([^']+)'/);
  const nonce = nonceMatch?.[1];
  const scriptTag = nonce
    ? `<script nonce="${nonce}" id="grok-desktop-theme-boot">${DESKTOP_THEME_BOOT}</script>
<script nonce="${nonce}">${conversationPane ? DESKTOP_CONVERSATION_PANE_BOOT : DESKTOP_CONVERSATION_LAYOUT_BOOT}</script>`
    : "";
  const tags = styleTag + scriptTag;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${tags}</head>`);
  }
  return tags + html;
}

/**
 * Desktop chrome boot: wrap #messages for scroll-edge fades and wire the
 * opacity ramp (port of AFK Pilot web/chat.html — shell-only, not chat.js).
 * Idempotent; safe after file-tree remounts that reparent #messages.
 */
export function desktopChromeBootSource(): string {
  return `(() => {
  const m = document.getElementById("messages");
  if (!m) return { ok: false, reason: "no messages" };

  let wrap = document.getElementById("messages-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "messages-wrap";
    const parent = m.parentElement;
    if (!parent) return { ok: false, reason: "no parent" };
    parent.insertBefore(wrap, m);
    wrap.appendChild(m);
  }
  if (!wrap.querySelector(".msg-fade-top")) {
    const top = document.createElement("div");
    top.className = "msg-fade msg-fade-top";
    top.setAttribute("aria-hidden", "true");
    const bot = document.createElement("div");
    bot.className = "msg-fade msg-fade-bot";
    bot.setAttribute("aria-hidden", "true");
    wrap.appendChild(top);
    wrap.appendChild(bot);
  }

  const FADE_RAMP = 16;
  function ramp(px) {
    const v = px / FADE_RAMP;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  let raf = 0;
  function apply() {
    raf = 0;
    const msg = document.getElementById("messages");
    const w = document.getElementById("messages-wrap");
    if (!msg || !w) return;
    w.style.setProperty("--fade-top-op", String(ramp(msg.scrollTop)));
    w.style.setProperty(
      "--fade-bot-op",
      String(ramp(msg.scrollHeight - msg.clientHeight - msg.scrollTop)),
    );
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(apply);
  }
  if (!m.dataset.deskFadeWired) {
    m.dataset.deskFadeWired = "1";
    m.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
  }
  apply();
  try { window.__grokResetDocumentScroll?.(); } catch (_) { /* chat.js hook */ }
  // Theme toggle is wired by the early head boot (grok-desktop-theme-boot) —
  // do not attach a second listener here or a single click double-flips.
  return { ok: true };
})()`;
}
