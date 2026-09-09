// The shell every file-panel screenshot harness mounts into.
//
// Two harnesses photograph media/file-panel.js — one for the Changes view, one
// for the viewer/editor and the order in which a person moves between them —
// and both need the same three things: a VS Code palette, a page whose head
// carries the real stylesheets, and the viewports the product runs at. Keeping
// one copy is not tidiness: a palette that drifts between harnesses makes two
// frames of the same component disagree for a reason that is in neither of
// them, and the "dark frames photographed on a white page" bug (TESTS.md) was
// exactly a page shell being wrong in one harness and right in another.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Relative to THIS FILE, never to the caller's directory: the relay repo runs
// extension scripts by absolute path, and cwd there is a different checkout
// that happens to have no media/ at all.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const readMedia = (...p) => fs.readFileSync(path.join(root, "media", ...p), "utf8");

export function outDir(leaf) {
  const dir = path.isAbsolute(process.env.SCREENS_DIR || "")
    ? path.join(process.env.SCREENS_DIR, leaf)
    : path.join(root, process.env.SCREENS_DIR || ".screens", leaf);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A trimmed VS Code palette plus the git decoration colours the change badges
// use. Values are VS Code's own defaults, not invented ones.
export const DARK = {
  foreground: "#CCCCCC",
  descriptionForeground: "rgba(204,204,204,0.7)",
  "editor-background": "#1F1F1F",
  "editor-foreground": "#CCCCCC",
  "editorWidget-background": "#202020",
  "editorWidget-border": "#454545",
  "sideBar-background": "#181818",
  "sideBar-border": "#2B2B2B",
  "panel-border": "#2B2B2B",
  "widget-border": "#313131",
  "input-background": "#313131",
  "input-foreground": "#CCCCCC",
  "input-border": "#3C3C3C",
  "input-placeholderForeground": "#989898",
  focusBorder: "#0078D4",
  "button-background": "#0078D4",
  "button-foreground": "#FFFFFF",
  "button-hoverBackground": "#026EC1",
  "button-secondaryBackground": "#313131",
  "button-secondaryForeground": "#CCCCCC",
  "button-secondaryHoverBackground": "#3C3C3C",
  "list-hoverBackground": "#2A2D2E",
  "list-hoverForeground": "#CCCCCC",
  "list-activeSelectionBackground": "#04395E",
  "list-activeSelectionForeground": "#FFFFFF",
  "toolbar-hoverBackground": "#5A5D5E50",
  "activityBarBadge-background": "#0078D4",
  "activityBarBadge-foreground": "#FFFFFF",
  "textLink-foreground": "#4DAAFC",
  "textPreformat-foreground": "#D7BA7D",
  errorForeground: "#F85149",
  "editorWarning-foreground": "#CCA700",
  "charts-red": "#F14C4C",
  "charts-green": "#89D185",
  "charts-yellow": "#CCA700",
  "gitDecoration-modifiedResourceForeground": "#E2C08D",
  "gitDecoration-addedResourceForeground": "#81B88B",
  "gitDecoration-deletedResourceForeground": "#C74E39",
  "gitDecoration-renamedResourceForeground": "#73C991",
  "gitDecoration-untrackedResourceForeground": "#73C991",
  "gitDecoration-conflictingResourceForeground": "#E4676B",
  "editorGutter-addedBackground": "#2EA043",
  "editorGutter-deletedBackground": "#F85149",
  "diffEditor-insertedTextBackground": "#3FB95033",
  "diffEditor-removedTextBackground": "#F8514933",
  contrastBorder: "transparent",
};

export const LIGHT = {
  ...DARK,
  foreground: "#3B3B3B",
  descriptionForeground: "rgba(59,59,59,0.7)",
  "editor-background": "#FFFFFF",
  "editor-foreground": "#3B3B3B",
  "editorWidget-background": "#F8F8F8",
  "editorWidget-border": "#C8C8C8",
  "sideBar-background": "#F8F8F8",
  "sideBar-border": "#E5E5E5",
  "panel-border": "#E5E5E5",
  "widget-border": "#E5E5E5",
  "input-background": "#FFFFFF",
  "input-border": "#CECECE",
  "input-foreground": "#3B3B3B",
  "input-placeholderForeground": "#767676",
  "button-secondaryBackground": "#E5E5E5",
  "button-secondaryForeground": "#3B3B3B",
  "button-secondaryHoverBackground": "#CCCCCC",
  "list-hoverBackground": "#E8E8E8",
  "list-hoverForeground": "#3B3B3B",
  "list-activeSelectionBackground": "#0060C0",
  "toolbar-hoverBackground": "#B8B8B850",
  "textLink-foreground": "#005FB8",
  "textPreformat-foreground": "#A31515",
  "editorWarning-foreground": "#BF8803",
  "gitDecoration-modifiedResourceForeground": "#895503",
  "gitDecoration-addedResourceForeground": "#587C0C",
  "gitDecoration-deletedResourceForeground": "#AD0707",
  "gitDecoration-renamedResourceForeground": "#007100",
  "gitDecoration-untrackedResourceForeground": "#007100",
  "gitDecoration-conflictingResourceForeground": "#AD0707",
};

export const VIEWPORTS = {
  desk: { viewport: { width: 1440, height: 900 } },
  tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
  phone: {
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
};

export function pageHtml(theme) {
  const palette = theme === "light" ? LIGHT : DARK;
  const vars = Object.entries(palette).map(([k, v]) => "--vscode-" + k + ": " + v + ";").join("\n");
  // The viewport meta is not decoration. Without it, mobile emulation lays the
  // page out at Chromium's 980px desktop fallback and scales the result down —
  // so innerWidth reads 980 on the "phone", every width media query resolves
  // to the desktop branch, and the panel docks into a right-hand column instead
  // of covering the screen. The frames look like a phone and measure like a
  // laptop. Same line web/chat.html carries.
  return [
    '<!doctype html><html><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>',
    ':root { ' + vars + ' }',
    'html, body { margin: 0; height: 100%; }',
    'body {',
    '  background: var(--vscode-editor-background);',
    '  color: var(--vscode-foreground);',
    '  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
    '}',
    readMedia("chat.css"),
    readMedia("file-panel.css"),
    '/* The harness stands in for the app shell the panel docks into. */',
    '.app-main { display: flex; height: 100vh; align-items: stretch; }',
    '#chat-stack { flex: 1 1 auto; min-width: 0; }',
    '.harness-toggles { position: fixed; left: -9999px; top: 0; }',
    '</style></head>',
    '<body class="' + (theme === "light" ? "vscode-light" : "vscode-dark") + '">',
    '<div class="app-main"><div id="chat-stack"></div><div id="file-panel-dock"></div></div>',
    '<div class="harness-toggles"></div>',
    '</body></html>',
  ].join("\n");
}
