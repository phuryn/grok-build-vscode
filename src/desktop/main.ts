/**
 * Electron main process — constructs GrokSidebar with an Electron Host so the
 * same agent runs with no VS Code present.
 *
 * Launch: `npm run desktop` → `electron out/desktop/main.js`
 *
 * Test harness flags (also accepted as env):
 *   --workspace=<path>     skip folder picker
 *   --user-data-dir=<path>  isolated prefs / memento
 *   --config-json=<path>    merge dotted config overrides from a JSON file
 *   GROK_DESKTOP_TEST_ALLOW_MULTIPLE=1 lets isolated test profiles coexist
 *   with a developer instance (honored only when NODE_ENV=test)
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  shell,
  systemPreferences,
  desktopCapturer,
  globalShortcut,
  type Menu as ElectronMenu,
  type ProtocolRequest,
} from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createLogFileSink,
  desktopLogPath,
  formatLogLine,
  prepareLogFile,
} from "./log-file";
import { GrokSidebar } from "../sidebar";
import { Uri } from "../host";
import type { HostContext, HostDisposable } from "../host";
import { ConfigStore, SensitiveConfigStore } from "./config-store";
import { createAppResourceHandler } from "./app-resource-handler";
import type { DesktopOpenFileContext } from "./desktop-policy";
import { createElectronHost, ensureWorkspaceRoot, type ElectronRemoteActions } from "./electron-host";
import {
  APP_RESOURCE_SCHEME,
  desktopChromeBootSource,
  ElectronWebview,
  isAppDocumentUrl,
} from "./electron-webview";
import {
  DESKTOP_APP_FULL_NAME,
  DESKTOP_APP_DISPLAY_NAME,
  DESKTOP_APP_SHORT_NAME,
  DESKTOP_PUBLIC_REPO_URL,
} from "./host-dialogs";
import { createFileMemento } from "./memento";
import { extensionIdFromPackageMeta, isCloudBuildFromPackageMeta } from "./package-meta";
import {
  desktopUserHomeDir,
  provisionDefaultProjectDir,
  resolveDesktopProfileDir,
  resolveExtensionRoot,
  resolveUserDataDir,
} from "./paths";
import { createSafeStorageSecrets } from "./safe-secrets";
import {
  RELAY_DEVICE_TOKEN_ENV,
  RELAY_DEVICE_TOKEN_SECRET,
  consumeInjectedDeviceToken,
  withInjectedSecret,
} from "../remote-frames";
import {
  injectFileTreePanelLogged,
  registerFileTreeIpc,
} from "./file-tree-ipc";
import {
  installWindowSecurityLocks,
  isTrustedMainFrameIpc,
} from "./window-security";
import { autoUpdater } from "electron-updater";
import {
  DESKTOP_RELEASES_API_URL,
  DESKTOP_UPDATE_CHECK_INTERVAL_MS,
  attachDesktopAutoUpdate,
  noticeIfUpdateAvailable,
  type GithubReleaseLike,
} from "./app-update";
import {
  desktopAppMenuTemplate,
  desktopDevToolsAllowed,
  isDesktopDevToolsShortcut,
  secondInstanceShouldOpenDevTools,
  shouldOpenDevToolsAtStartup,
  type DesktopAppMenuActions,
} from "./app-menu";

// Electron dies with launch-failed if sandbox is left at the platform default
// in some setups; we set it explicitly on the BrowserWindow. Also strip the
// env that makes `electron` run as plain Node (breaks BrowserWindow entirely).
delete process.env.ELECTRON_RUN_AS_NODE;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_RESOURCE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

/**
 * Set once the user-data directory is known — see `log`.
 *
 * A `let` because `log()` is called before that point (argument parsing,
 * profile resolution) and those lines must not be lost or crash the app for
 * want of a directory that does not exist yet. Early lines go to stdout only.
 *
 * DECLARED ABOVE THE STARTUP BLOCK THAT CALLS `startFileLogging`, and that is
 * load-bearing rather than tidy. `function` declarations hoist; `let` bindings
 * do not — they sit in the temporal dead zone until this line is evaluated. So
 * calling `startFileLogging` from the profile-resolution block further down the
 * file, while these still sat BELOW it, threw
 * `ReferenceError: Cannot access 'desktopLogFile' before initialization` on the
 * assignment. That block has its own `catch`, which swallowed it. The app
 * launched, no sink was ever installed, and Show logs stayed the no-op it was
 * supposed to stop being — shipped in 3.19.2, and invisible because the tests
 * covered the helper module rather than this file's initialization order.
 */
let logToFile: ((text: string) => void) | undefined;
let desktopLogFile: string | undefined;

function log(line: string): void {
  const stamp = new Date().toISOString();
  const text = formatLogLine(stamp, line);
  process.stdout.write(text);
  // Synchronous, deliberately. The lines that matter are the last few before a
  // freeze, which is exactly what a buffered writer loses.
  logToFile?.(text);
}

/**
 * Start writing the log to a file the user can actually retrieve.
 *
 * Called as soon as the user-data directory is resolved. Failure is survivable
 * and silent-ish: the app runs, stdout still works, and the only cost is that
 * this session has no retrievable log.
 */
function startFileLogging(userDataDir: string): void {
  const target = desktopLogPath(userDataDir);
  if (!prepareLogFile(target, fs)) return;
  desktopLogFile = target;
  logToFile = createLogFileSink(target);
  log(`logging to ${target}`);
}

function parseArgs(argv: string[]): {
  workspace?: string;
  userDataDir?: string;
  configJson?: string;
} {
  const out: { workspace?: string; userDataDir?: string; configJson?: string } = {};
  for (const a of argv) {
    if (a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--user-data-dir=")) out.userDataDir = a.slice("--user-data-dir=".length);
    else if (a.startsWith("--config-json=")) out.configJson = a.slice("--config-json=".length);
  }
  if (!out.workspace && process.env.GROK_DESKTOP_WORKSPACE) {
    out.workspace = process.env.GROK_DESKTOP_WORKSPACE;
  }
  if (!out.userDataDir && process.env.GROK_DESKTOP_USER_DATA) {
    out.userDataDir = process.env.GROK_DESKTOP_USER_DATA;
  }
  if (!out.configJson && process.env.GROK_DESKTOP_CONFIG_JSON) {
    out.configJson = process.env.GROK_DESKTOP_CONFIG_JSON;
  }
  return out;
}

// Name + userData MUST be set before anything resolves getPath("userData") —
// Electron otherwise parks the profile under the generic "Electron" folder.
// Tests pass --user-data-dir for isolation (skips branding/migration).
const earlyArgs = parseArgs(process.argv.slice(1));
try {
  app.setName(DESKTOP_APP_SHORT_NAME);
  // Windows groups taskbar buttons by AppUserModelID, and an unpackaged run
  // without one inherits electron.exe's identity — so the taskbar showed
  // Electron's atom whatever icon the window set. Installed builds were never
  // affected (their shortcut carries an ID), which is why this only ever looked
  // wrong while developing. Must match electron-builder.yml's appId, or a dev
  // run and the installed app would occupy separate taskbar buttons.
  app.setAppUserModelId("com.productcompass.grok-build-desktop");
} catch {
  /* app module edge cases in tests */
}
try {
  const { userData: ud, migratedFrom } = resolveDesktopProfileDir({
    appData: app.getPath("appData"),
    override: earlyArgs.userDataDir,
  });
  app.setPath("userData", ud);
  // As early as the directory is known. Everything logged before this line is
  // stdout-only, so the window is deliberately small: the interesting failures
  // (a session that will not load, a window that stops painting) all happen
  // long after startup.
  startFileLogging(ud);
  if (migratedFrom) {
    log(`migrated profile from ${migratedFrom} → ${ud}`);
  }
} catch {
  /* best-effort; createApp still resolves via resolveUserDataDir */
}

function readPackageMeta(
  extensionRoot: string,
): { version: string; id: string; cloudBuild: boolean } {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
    ) as {
      version?: string; publisher?: string; name?: string;
      grokExtensionName?: string; grokCloudBuild?: unknown;
    };
    return {
      version: pkg.version ?? "0.0.0",
      id: extensionIdFromPackageMeta(pkg),
      cloudBuild: isCloudBuildFromPackageMeta(pkg),
    };
  } catch {
    // Unreadable metadata must not promote a build to one that trusts its
    // environment. The safe answer to "is this a cloud build" is no.
    return { version: "0.0.0", id: "PawelHuryn.grok-vscode-phuryn", cloudBuild: false };
  }
}

/**
 * Chromium per-origin zoomFactor must stay 1. Chat scale is CSS `--chat-zoom`
 * only; stacking the two is the boot-layout overflow. Re-pin on every
 * app-document load (including reload) because a leftover origin zoom survives.
 */
function pinAppDocumentZoom(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const url = win.webContents.getURL();
  if (url && url !== "about:blank" && !isAppDocumentUrl(url)) return;
  try {
    void win.webContents.setVisualZoomLevelLimits(1, 1);
  } catch {
    /* older Electron */
  }
  try {
    win.webContents.setZoomFactor(1);
  } catch {
    /* zoomFactor unavailable */
  }
}

/**
 * Application menu: no stock Electron Help links; public repo only.
 * File → Add/Close Project Folder drive multi-folder (rail + config store).
 * Developer Tools only when `!isPackaged` (default: `app.isPackaged`).
 */
export function buildDesktopAppMenu(
  actions?: DesktopAppMenuActions,
  opts?: { isPackaged?: boolean },
): ElectronMenu {
  const isPackaged = opts?.isPackaged ?? app.isPackaged;
  return Menu.buildFromTemplate(
    desktopAppMenuTemplate({
      isPackaged,
      platform: process.platform,
      actions,
      openPublicRepo: () => {
        void shell.openExternal(DESKTOP_PUBLIC_REPO_URL);
      },
    }),
  );
}

let mainWindow: BrowserWindow | null = null;
// Set on ready-to-show (or did-fail-load): gates every other show() path.
let mainWindowReadyToShow = false;
let sidebar: GrokSidebar | null = null;
let webview: ElectronWebview | null = null;

/** View-menu zoom → renderer `window.__grokFontScale` (CSS path). */
function applyDesktopCssZoom(kind: "in" | "out" | "reset"): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const src =
    kind === "reset"
      ? `(function(){var a=window.__grokFontScale;if(a&&typeof a.set==="function")a.set(1);})()`
      : kind === "in"
        ? `(function(){var a=window.__grokFontScale;if(a&&typeof a.set==="function"&&typeof a.step==="function")a.set(a.step(a.get(),a.stepSize));})()`
        : `(function(){var a=window.__grokFontScale;if(a&&typeof a.set==="function"&&typeof a.step==="function")a.set(a.step(a.get(),-a.stepSize));})()`;
  void win.webContents.executeJavaScript(src, true).catch(() => {
    /* renderer not ready */
  });
}

// One process per profile: a second launch must focus the existing window, not
// spawn another sidebar / ACP pool / remote uplink on the same device token.
// A leftover process makes a new launch quit here — looks exactly like
// "nothing happened" (including --open-devtools). The first instance handles
// second-instance: focus + open DevTools when the new argv asked for it.
const allowMultipleTestInstances =
  process.env.NODE_ENV === "test" && process.env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE === "1";
const gotSingleInstanceLock = allowMultipleTestInstances || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log(
    "another instance already holds this profile; quitting " +
      "(focus the existing window — re-launch with --open-devtools opens DevTools there)",
  );
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    // Never surface a window that has not reached ready-to-show — a double
    // launch during boot must not paint the unsettled frame show:false hides.
    if (!win.isVisible() && mainWindowReadyToShow) win.show();
    win.focus();
    if (
      secondInstanceShouldOpenDevTools({
        isPackaged: app.isPackaged,
        commandLine,
      })
    ) {
      win.webContents.openDevTools({ mode: "detach" });
      log("DevTools opened (second-instance --open-devtools)");
    }
  });
}

async function createApp(): Promise<void> {
  const args = earlyArgs;
  // Profile root = Electron userData (branded early above, or test override).
  const userData = resolveUserDataDir(args.userDataDir);
  fs.mkdirSync(userData, { recursive: true });

  const extensionRoot = resolveExtensionRoot();
  const pkg = readPackageMeta(extensionRoot);
  const configPath = path.join(userData, "config.json");
  // Construct first, then attach encryption — same production sequence tests pin.
  // Never delete a legacy plaintext credential when encrypt is unavailable.
  const config = new ConfigStore(configPath);
  try {
    config.setSensitiveStore(
      new SensitiveConfigStore(path.join(userData, "sensitive.enc.json"), safeStorage),
    );
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log(`sensitive config store init FAILED: ${msg}`);
    // Leave the credential in config.json for a later run; surface loudly so a
    // swallowed catch cannot silently destroy it (round 12).
    dialog.showErrorBox(
      "Secure storage unavailable",
      "Could not encrypt stored credentials (for example the voice API key). " +
        "They remain in config.json until OS secure storage is available, and " +
        "will migrate automatically on the next successful start.\n\n" +
        msg,
    );
  }

  if (args.configJson && fs.existsSync(args.configJson)) {
    try {
      // Strip a UTF-8 BOM — PowerShell Set-Content -Encoding utf8 writes one on
      // Windows, and JSON.parse rejects it as an unexpected token.
      const raw = fs.readFileSync(args.configJson, "utf8").replace(/^\uFEFF/, "");
      const overrides = JSON.parse(raw) as Record<string, unknown>;
      // THIS RUN ONLY — deliberately not persisted. A throwaway grok.cliPath
      // used to survive into every later launch, leaving the app starting a
      // stub agent with nothing on screen to explain it.
      config.applySessionOverrides(overrides);
      log(`applied config overrides from ${args.configJson} (this run only)`);
    } catch (e) {
      log(`failed to read config-json: ${(e as Error).message}`);
    }
  }

  // Open-folder set BEFORE the sidebar exists so workspaceRoot() is already
  // the first-run default (or a restored/discovered project). After this the
  // constructor's RemoteClientState / default provider see a real cwd.
  // Empty is still valid: a user who removed every project owns that set.
  const workspace = ensureWorkspaceRoot(config, () => mainWindow, args.workspace, {
    provisionDefaultProject: () =>
      provisionDefaultProjectDir({
        homeDir: desktopUserHomeDir(),
        userDataDir: userData,
      })?.dir,
  });
  if (workspace) log(`workspace: ${workspace}`);
  else log("workspace: (none — empty project rail; use Add Project Folder)");

  const globalStorageDir = path.join(userData, "globalStorage");
  fs.mkdirSync(globalStorageDir, { recursive: true });

  const subscriptions: HostDisposable[] = [];
  // Device token is a credential: encrypt with OS keychain via safeStorage.
  // Ciphertext file only — never plaintext next to config. Encryption-unavailable
  // fails on store/get (createSafeStorageSecrets), never silent fallback.
  //
  // A Node harness cannot pre-seed that file (the ciphertext is OS-keyed),
  // so a development overlay answers the one key from memory when
  // resolveInjectedDeviceToken is certain the relay URL was also overridden.
  // Packaged builds are isPackaged=true; the resolver returns undefined and
  // withInjectedSecret is a no-op — no token, no uplink, regardless of env.
  const storedSecrets = createSafeStorageSecrets(
    path.join(userData, "secrets.enc.json"),
    safeStorage,
  );
  // Capture then delete — sidebar copies process.env into every ACP spawn.
  const envTokenPresent = !!process.env[RELAY_DEVICE_TOKEN_ENV];
  const injectedToken = consumeInjectedDeviceToken({
    isProduction: app.isPackaged,
    env: process.env,
    cloudBuild: pkg.cloudBuild,
  });
  if (envTokenPresent && !injectedToken) {
    log("ignoring GROK_RELAY_DEVICE_TOKEN (production build or relay URL not overridden)");
  } else if (injectedToken) {
    log(pkg.cloudBuild
      ? "using the device token this cloud environment was handed"
      : "using injected development device token (relay URL override active)");
  }
  const hostContext: HostContext = {
    secrets: {
      get: withInjectedSecret(
        (key) => storedSecrets.get(key),
        RELAY_DEVICE_TOKEN_SECRET,
        injectedToken,
      ),
      store: (key, value) => storedSecrets.store(key, value),
      delete: (key) => storedSecrets.delete(key),
    },
    globalStorageUri: Uri.file(globalStorageDir),
    extensionUri: Uri.file(extensionRoot),
    extensionId: pkg.id,
    extensionVersion: pkg.version,
    isProduction: app.isPackaged,
    isCloudBuild: pkg.cloudBuild,
    globalState: createFileMemento(path.join(userData, "globalState.json")),
    subscriptions: {
      push(...items: HostDisposable[]) {
        subscriptions.push(...items);
      },
    },
  };

  webview = new ElectronWebview(() => mainWindow);
  webview.getWorkspaceRoot = () => config.getWorkspaceRoot();
  webview.onDroppedMessage = (reason, raw) => {
    const t =
      raw && typeof raw === "object" && "type" in raw
        ? String((raw as { type: unknown }).type)
        : typeof raw;
    log(`dropped renderer message (${reason}): ${t}`);
  };

  // Registry + canonical static roots — never free-form ~/.grok path serve.
  // Narrow extra lane: exact APP_DOCUMENT_URL → in-memory HTML (real origin for
  // localStorage). Not a path serve; does not widen static/registry policy.
  const serveAppResource = createAppResourceHandler({
    resolveResourceUrl: (resourceUrl) => webview?.resolveResourceUrl(resourceUrl) ?? null,
    fetchFile: (fileUrl) => net.fetch(fileUrl),
    log,
  });
  protocol.handle(APP_RESOURCE_SCHEME, async (request: Request | ProtocolRequest) => {
    const url = typeof request === "object" && "url" in request ? request.url : String(request);
    if (!webview) {
      return new Response("Forbidden", { status: 403 });
    }
    if (isAppDocumentUrl(url)) {
      const html = webview.getDocumentHtml();
      if (!html) {
        return new Response("Document not ready", { status: 404 });
      }
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    return await serveAppResource(request, url);
  });

  // Bound after GrokSidebar exists so link/unlink reuse the extension flow.
  const remoteActions: { current?: ElectronRemoteActions } = {};
  // Same auth context for message-gate (webview) and use-time openFsPath (host).
  const authContext: { get?: () => DesktopOpenFileContext } = {};
  const updateActions: { install?: () => void } = {};
  const host = createElectronHost({
    config,
    getWindow: () => mainWindow,
    getLogFile: () => desktopLogFile,
    log,
    remoteActions,
    getAuthContext: () => authContext.get?.(),
    installAppUpdate: () => updateActions.install?.(),
    onWorkspaceRootChanged: (root) => {
      // File-tree panel boots once against api.root(); rebind so the visible
      // tree matches the active project (otherwise reads resolve against B
      // while rows still show A's layout).
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send("desk-ft:root-changed", { root });
      }
    },
  });

  sidebar = new GrokSidebar(hostContext, host);
  // Session-aware roots for openFile/openDiff (worktree cwd, not only the
  // selected project folder). Wired after sidebar exists. grokHome + sessionDir
  // + sessionCatalogDirs authorize trusted session-generated media
  // (images|videos) outside the tree — absolute paths against project catalogs
  // only, relative links against the active session dir.
  // Media fields are lazy: sessionDirFor / sessionCatalogDirs readdirSync, and
  // most webview messages are not path-bearing — only openFile/openDiff
  // consumers read these fields after a workspace candidate has already missed.
  authContext.get = () => {
    let mediaCache:
      | { grokHome?: string; sessionDir?: string; sessionCatalogDirs?: string[] }
      | undefined;
    const media = () => {
      if (!mediaCache) mediaCache = sidebar!.desktopOpenMediaContext();
      return mediaCache;
    };
    return {
      workspaceRoot: config.getWorkspaceRoot(),
      allowedRoots: sidebar!.desktopAuthRoots(),
      get grokHome() {
        return media().grokHome;
      },
      get sessionDir() {
        return media().sessionDir;
      },
      get sessionCatalogDirs() {
        return media().sessionCatalogDirs;
      },
      // Path derivation is cheap, but keep it on the same path-bearing lazy seam.
      get planReviewSessionRoot() {
        return sidebar!.desktopPlanReviewSessionRoot();
      },
      // Where Claude Code writes the plans it then links to. Same narrow
      // provenance rule as above — a direct .md child, never a read root.
      get claudePlansRoot() {
        return path.join(os.homedir(), ".claude", "plans");
      },
    } satisfies DesktopOpenFileContext;
  };
  webview.getAuthContext = () => authContext.get!();
  remoteActions.current = {
    link: () => sidebar!.linkRemoteDevice(),
    unlink: () => sidebar!.unlinkRemoteDevice(),
  };

  // Host-minted file-selection handles for genuine OS drops (preload only —
  // never exposed as a free-form path API to page script).
  ipcMain.handle("desk-file-sel:register", (event, rawPaths: unknown) => {
    if (!isTrustedMainFrameIpc(event, () => mainWindow)) {
      log("refused desk-file-sel:register from non-main sender/frame");
      return [] as string[];
    }
    if (!webview || !Array.isArray(rawPaths)) return [] as string[];
    const handles: string[] = [];
    for (const p of rawPaths) {
      if (typeof p !== "string" || !p.trim()) continue;
      try {
        handles.push(webview.fileSelection.register(p));
      } catch (e) {
        log(`file selection register failed: ${(e as Error).message}`);
      }
    }
    return handles;
  });

  // Full product name for About / OS app identity (short name was set early so
  // userData resolved under a branded folder). Window title uses short name.
  app.setName(DESKTOP_APP_FULL_NAME);
  const isPackaged = app.isPackaged;
  Menu.setApplicationMenu(
    buildDesktopAppMenu(
      {
        addProjectFolder: () => {
          void sidebar?.addProjectFolder();
        },
        removeProjectFolder: () => {
          void sidebar?.removeProjectFolder();
        },
        zoomIn: () => applyDesktopCssZoom("in"),
        zoomOut: () => applyDesktopCssZoom("out"),
        resetZoom: () => applyDesktopCssZoom("reset"),
      },
      { isPackaged },
    ),
  );

  // Round icon first — same one the installers use, so a dev run and an
  // installed build look identical in the taskbar and dock. Falls back to the
  // square marketplace icon if it is somehow missing.
  const roundIcon = path.join(extensionRoot, "resources", "grok-icon-round-512.png");
  const iconPath = fs.existsSync(roundIcon)
    ? roundIcon
    : path.join(extensionRoot, "resources", "grok-icon.png");
  const iconOpt = fs.existsSync(iconPath) ? iconPath : undefined;

  // Packaged builds hard-disable DevTools at the webPreferences layer too —
  // menu-only gating would leave openDevTools() / F12-style hooks reachable.
  const allowDevTools = desktopDevToolsAllowed(isPackaged);

  mainWindow = new BrowserWindow({
    // Wider default so chat + file tree both have room; collapse shrinks the panel.
    width: 720,
    height: 800,
    minWidth: 400,
    minHeight: 480,
    title: DESKTOP_APP_DISPLAY_NAME,
    // Match AFK Pilot dark page chrome; theme toggle may lighten the document.
    backgroundColor: "#1a1a1a",
    // Windows draws a light system menu strip over a dark app otherwise. Hide
    // it by default; Alt reveals the File/Edit/View/Help menus when needed.
    autoHideMenuBar: true,
    // Hold the first paint until Chromium has a settled frame. Showing on
    // construct (NSIS --force-run relaunch is the sharp case) lays the
    // document out against an unsettled viewport; boot focus then sticks it.
    show: false,
    icon: iconOpt,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Required: without an explicit false, some Electron builds fail with
      // launch-failed before any page code runs (spike-confirmed).
      sandbox: false,
      spellcheck: false,
      devTools: allowDevTools,
    },
  });

  pinAppDocumentZoom(mainWindow);
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Re-pin right before first show: a leftover per-origin zoom applied
    // between construct and first paint would resurrect the stacked-zoom bug.
    pinAppDocumentZoom(mainWindow);
    mainWindowReadyToShow = true;
    mainWindow.show();
  });

  installWindowSecurityLocks(mainWindow, {
    log,
    openExternal: (url) => shell.openExternal(url),
  });

  // desktop-dev passes an explicit open signal (not GROK_RELAY_URL).
  if (
    shouldOpenDevToolsAtStartup({
      isPackaged,
      env: process.env,
      argv: process.argv,
    })
  ) {
    // Docked, not detached. A detached DevTools is its own window, and on
    // Windows it disappears behind the app the moment you click back into the
    // chat -- which reads as "DevTools did not open" and cost a debugging
    // session. The desktop-dev script also passes --remote-debugging-port,
    // so the same renderer is drivable over CDP without a hand-passed flag.
    mainWindow.webContents.openDevTools({ mode: "bottom" });
    log("DevTools opened (non-production build); CDP on --remote-debugging-port if passed");
  }

  // Keyboard DevTools without needing the auto-hidden menu bar (Windows).
  // Menu accelerator still works; F12 is the discoverable Chromium habit.
  // Packaged builds keep webPreferences.devTools false so this is a no-op path.
  if (allowDevTools) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      // Intercept zooming shortcuts: Cmd/Ctrl + Plus, Cmd/Ctrl + Minus.
      // We prevent the default so Chromium's native zoom (which overrides our CSS zoom) doesn't fire.
      if (input.control || input.meta) {
        // Prevent scrolling combined with Ctrl/Cmd (which defaults to native zoom in browsers)
        if (input.type === "mouseWheel") {
          event.preventDefault();
          return;
        }
        
        const key = input.key.toLowerCase();
        if (key === "+" || key === "=") {
          event.preventDefault();
          if (input.type === "keyDown") applyDesktopCssZoom("in");
          return;
        } else if (key === "-") {
          event.preventDefault();
          if (input.type === "keyDown") applyDesktopCssZoom("out");
          return;
        } else if (key === "0") {
          event.preventDefault();
          if (input.type === "keyDown") applyDesktopCssZoom("reset");
          return;
        }
      }
      
      if (!isDesktopDevToolsShortcut(input)) return;
      event.preventDefault();
      mainWindow?.webContents.toggleDevTools();
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  ipcMain.on("webview-to-host", (event, message: unknown) => {
    // Ambient authority: only the main BrowserWindow main frame may post.
    if (!isTrustedMainFrameIpc(event, () => mainWindow)) {
      log("refused webview-to-host from non-main sender/frame");
      return;
    }
    
    // Intercept mac permissions directly in main process before dispatching to extension host
    if (message && typeof message === "object" && (message as any).type === "requestMacPermissions" && process.platform === "darwin") {
      log("Handling requestMacPermissions directly in main process");
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
      setTimeout(() => {
        shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_InputMonitoring");
      }, 600);
      return; // Handled
    }

    if (message && typeof message === "object" && (message as any).type === "checkMacPermissions" && process.platform === "darwin") {
      try {
        log("[checkMacPermissions] Received check request from webview");
        const screenStatus = systemPreferences.getMediaAccessStatus ? (systemPreferences.getMediaAccessStatus("screen") === "granted") : false;
        const isAccessibilityTrusted = systemPreferences.isTrustedAccessibilityClient ? systemPreferences.isTrustedAccessibilityClient(false) : false;
        log(`[checkMacPermissions] Electron native checks: screenStatus=${screenStatus}, isAccessibilityTrusted=${isAccessibilityTrusted}`);

        const binCandidates = [
          path.join(extensionRoot.replace("app.asar", "app.asar.unpacked"), "resources/macos-dual-cmd-listener"),
          path.join(process.resourcesPath, "app.asar.unpacked/resources/macos-dual-cmd-listener"),
          path.join(process.resourcesPath, "resources/macos-dual-cmd-listener"),
          path.join(__dirname, "../../resources/macos-dual-cmd-listener"),
          path.join(extensionRoot, "resources/macos-dual-cmd-listener"),
        ];
        const binPath = binCandidates.find((p) => !p.includes("app.asar/") && fs.existsSync(p));
        log(`[checkMacPermissions] resolved binPath: ${binPath || "none"}`);
        if (binPath) {
          const cp = require("child_process");
          cp.execFile(binPath, ["--check-permissions"], (err: any, stdout: string, stderr: string) => {
            log(`[checkMacPermissions] execFile output err=${err}, stdout=${stdout?.trim()}, stderr=${stderr?.trim()}`);
            let parsed = { screenRecording: screenStatus, inputMonitoring: isAccessibilityTrusted };
            if (!err && stdout) {
              try {
                const swiftResult = JSON.parse(stdout.trim());
                parsed.screenRecording = screenStatus || !!swiftResult.screenRecording;
                parsed.inputMonitoring = !!swiftResult.inputMonitoring || isAccessibilityTrusted;
              } catch (e) {
                log(`[checkMacPermissions] JSON parse error: ${(e as Error).message}`);
              }
            }

            // Fallback for Spotlight launch: If the app is actively running on macOS, assume permissions granted if swift binary executed cleanly without error.
            if (!err && stdout && stdout.includes("true")) {
              parsed.screenRecording = true;
              parsed.inputMonitoring = true;
            }

            log(`[checkMacPermissions] final status sent to webview: ${JSON.stringify(parsed)}`);
            mainWindow?.webContents.send("host-to-webview", { type: "macPermissionsReport", ...parsed });
          });
        } else {
          mainWindow?.webContents.send("host-to-webview", {
            type: "macPermissionsReport",
            screenRecording: screenStatus,
            inputMonitoring: isAccessibilityTrusted
          });
        }
      } catch (err) {
        log(`checkMacPermissions error: ${(err as Error).message}`);
      }
      return;
    }
    
    webview?.dispatchMessage(message);
  });

  log(`extension root: ${extensionRoot}`);
  log(`cliPath config: ${String(config.getValue("grok.cliPath") || "(auto)")}`);

  // Desktop-only file tree — dedicated IPC, not Host / chat.js.
  registerFileTreeIpc({
    getWorkspaceRoot: () => config.getWorkspaceRoot(),
    getMainWindow: () => mainWindow,
    log,
    openSinkPath: process.env.GROK_DESKTOP_OPEN_SINK,
  });

  // Inject after every document load (initial + renderer reload) so the panel
  // remounts without touching getHtml() / chat.js. Chrome fades run after the
  // panel so #messages is in its final parent.
  mainWindow.webContents.on("did-finish-load", () => {
    pinAppDocumentZoom(mainWindow);
    void (async () => {
      await injectFileTreePanelLogged(mainWindow, log);
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
      try {
        await mainWindow.webContents.executeJavaScript(desktopChromeBootSource(), true);
      } catch (e) {
        log(`[desk-chrome] inject failed: ${(e as Error).message}`);
      }
    })();
  });

  sidebar.resolveWebviewView({
    webview,
    show() {
      mainWindow?.show();
    },
  });

  // Screen capture via global shortcut (macOS exclusively supported in UI, but graceful on Windows)
  let registeredShortcut: string | null = null;
  let dualCmdProcess: any = null;
  
  const triggerSnapshot = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("screen");
      const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);
      mainWindow.webContents.send("host-to-webview", { type: "macPermissionStatus", screen: status === "granted", accessibility: isTrusted });

      if (status !== "granted") {
        mainWindow.webContents.send("host-to-webview", { type: "snapshotPermissionRequested", platform: process.platform });
        return;
      }
    }

    const wasFocused = mainWindow.isFocused();
    if (wasFocused) {
      mainWindow.setOpacity(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      const { screen } = require("electron");
      const cursorPoint = screen.getCursorScreenPoint();
      const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);

      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: activeDisplay.bounds.width, height: activeDisplay.bounds.height },
      });

      const activeSource = sources.find((s) => s.display_id === activeDisplay.id.toString()) || sources[0];

      if (!activeSource) {
        log("No screen source found for snapshot");
        return;
      }

      const imgBuffer = activeSource.thumbnail.toPNG();
      const tempPath = path.join(os.tmpdir(), `grok_snapshot_${Date.now()}.png`);
      fs.writeFileSync(tempPath, imgBuffer);
      
      // Register the file for secure dropFile
      let handle: string | null = null;
      try {
        if (webview) {
          handle = webview.fileSelection.register(tempPath);
        }
      } catch (err) {
        log(`Could not register snapshot handle: ${(err as Error).message}`);
      }

      // Create a native full-screen transparent flash window across the entire active monitor
      try {
        const flashWin = new BrowserWindow({
          x: activeDisplay.bounds.x,
          y: activeDisplay.bounds.y,
          width: activeDisplay.bounds.width,
          height: activeDisplay.bounds.height,
          transparent: true,
          frame: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          focusable: false,
          hasShadow: false,
          enableLargerThanScreen: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });
        flashWin.setIgnoreMouseEvents(true);
        const flashHtml = `<!DOCTYPE html><html><body style="margin:0;overflow:hidden;background:rgba(255,255,255,0.85);transition:opacity 0.25s ease-out;opacity:1;" onload="setTimeout(()=>{document.body.style.opacity='0';},40);"></body></html>`;
        void flashWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(flashHtml)}`);
        setTimeout(() => {
          if (!flashWin.isDestroyed()) flashWin.destroy();
        }, 320);
      } catch (e) {
        log(`Failed to show native desktop flash overlay: ${(e as Error).message}`);
      }

      if (wasFocused && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setOpacity(1);
      }

      // Trigger shutter sound and composer attachment animation
      mainWindow.webContents.send("host-to-webview", { type: "snapshotTriggered" });
      mainWindow.webContents.send("host-to-webview", { type: "snapshotCompleted", imagePath: tempPath, handle });
    } catch (e) {
      log(`snapshot failed: ${(e as Error).message}`);
    } finally {
      if (wasFocused && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setOpacity(1);
      }
    }
  };

  const registerSnapshotShortcut = (shortcut: string) => {
    if (registeredShortcut === shortcut && (shortcut === "DualCommand" ? !!dualCmdProcess : true)) {
      return;
    }

    if (registeredShortcut && registeredShortcut !== "DualCommand" && registeredShortcut !== "Disabled") {
      try {
        globalShortcut.unregister(registeredShortcut);
      } catch {
        /* best-effort */
      }
    }

    if (dualCmdProcess) {
      try {
        dualCmdProcess.kill("SIGTERM");
      } catch {}
      dualCmdProcess = null;
    }

    registeredShortcut = shortcut;
    
    if (shortcut === "Disabled" || !shortcut) {
      return;
    }
    
    if (shortcut === "DualCommand" && process.platform === "darwin") {
      try {
        const binCandidates = [
          path.join(extensionRoot.replace("app.asar", "app.asar.unpacked"), "resources/macos-dual-cmd-listener"),
          path.join(process.resourcesPath, "app.asar.unpacked/resources/macos-dual-cmd-listener"),
          path.join(process.resourcesPath, "resources/macos-dual-cmd-listener"),
          path.join(process.resourcesPath, "macos-dual-cmd-listener"),
          path.join(__dirname, "../../resources/macos-dual-cmd-listener"),
          path.join(extensionRoot, "resources/macos-dual-cmd-listener"),
        ];
        const binPath = binCandidates.find((p) => !p.includes("app.asar/") && fs.existsSync(p));
        if (binPath) {
          const cp = require("child_process");
          dualCmdProcess = cp.spawn(binPath, [], { stdio: ["ignore", "pipe", "pipe"] });
          dualCmdProcess.stdout?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            if (text.includes("DUAL_CMD_TRIGGER")) {
              void triggerSnapshot();
            }
          });
          dualCmdProcess.on("exit", (code: number | null) => {
            log(`macos-dual-cmd-listener exited with code ${code}`);
            dualCmdProcess = null;
          });
          log(`Registered Dual Command (Left Cmd + Right Cmd) native listener at ${binPath}`);
        } else {
          log("Could not find macos-dual-cmd-listener binary");
        }
      } catch (e) {
        log(`Failed to spawn macos-dual-cmd-listener: ${(e as Error).message}`);
      }
    } else {
      try {
        const actualShortcut = (shortcut === "DualCommand" && process.platform !== "darwin") 
            ? "CommandOrControl+Shift+S" 
            : shortcut;
            
        const ok = globalShortcut.register(actualShortcut, () => {
          void triggerSnapshot();
        });
        log(`Registered snapshot shortcut "${actualShortcut}": ${ok}`);
      } catch (e) {
        log(`failed to register snapshot global shortcut: ${(e as Error).message}`);
      }
    }
  };

  const initialShortcut = String(config.getValue("grok.snapshotShortcut") || "Disabled");
  registerSnapshotShortcut(initialShortcut);

  config.onDidChange((e) => {
    if (e.affectsConfiguration("grok.snapshotShortcut")) {
      const nextShortcut = String(config.getValue("grok.snapshotShortcut") || "Disabled");
      registerSnapshotShortcut(nextShortcut);
    }
  });

  // In-app updater on packaged win32/darwin; GitHub notice is the fallback
  // (and the only path when unpackaged / Linux / check-or-download fails).
  // Failure is silence. Re-check every 12h. In-memory pending frame only —
  // re-post on reload so the rail button survives a document refresh.
  const appVersion = app.getVersion() || pkg.version;
  let pendingUpdate:
    | { kind: "notice"; version: string; url: string }
    | { kind: "ready"; version: string }
    | null = null;
  const postUpdateNotice = (version: string, url: string): void => {
    pendingUpdate = { kind: "notice", version, url };
    if (!webview) return;
    void webview.postMessage({ type: "updateAvailable", version, url });
  };
  const postUpdateReady = (version: string): void => {
    pendingUpdate = { kind: "ready", version };
    if (!webview) return;
    void webview.postMessage({ type: "updateReady", version });
  };
  const fetchGithubDesktopNotice = async () => {
    try {
      const res = await net.fetch(DESKTOP_RELEASES_API_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Grok-Build-Desktop/${appVersion}`,
        },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return null;
      return noticeIfUpdateAvailable(appVersion, body as GithubReleaseLike[]);
    } catch {
      return null;
    }
  };
  const desktopUpdate = attachDesktopAutoUpdate({
    // A thunk, not the value. `autoUpdater` is a getter that constructs the
    // platform updater on first read, and on Linux that constructor rejects the
    // `"0.0"` version an unpackaged app reports — so naming it here killed
    // startup before attachDesktopAutoUpdate could decide Linux has no in-app
    // updater at all. Found by running this app in a container.
    updater: () => autoUpdater,
    platform: process.platform,
    currentVersion: appVersion,
    packaged: app.isPackaged,
    forceDev: process.env.GROK_DESKTOP_UPDATE_DEV === "1",
    ui: {
      postNotice: postUpdateNotice,
      postReady: postUpdateReady,
      log,
      fetchNotice: fetchGithubDesktopNotice,
    },
  });
  updateActions.install = () => desktopUpdate.install();
  // After first paint so a slow check never races the webview boot.
  setTimeout(() => {
    void desktopUpdate.check();
  }, 4_000);
  setInterval(() => {
    void desktopUpdate.check();
  }, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
  // Re-deliver an already-known notice/ready after inject (reload wipes the button).
  // Read the live binding inside the delay — a notice→ready transition in that
  // window must not re-post the stale notice over a staged update.
  mainWindow.webContents.on("did-finish-load", () => {
    if (!pendingUpdate) return;
    setTimeout(() => {
      const live = pendingUpdate;
      if (!live) return;
      if (live.kind === "ready") postUpdateReady(live.version);
      else postUpdateNotice(live.version, live.url);
    }, 500);
  });

  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      // 0=debug,1=info,2=warning,3=error
      log(`[renderer${level >= 3 ? " error" : " warn"}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log(`did-fail-load ${code} ${desc} url=${url}`);
    // The app document failed: show the (blank) window rather than hanging
    // invisibly behind ready-to-show that will never fire.
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindowReadyToShow = true;
      mainWindow.show();
    }
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    void createApp().catch((e) => {
      log(`startup failed: ${(e as Error).stack ?? e}`);
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    sidebar?.dispose();
    app.quit();
  });

  app.on("before-quit", () => {
    try {
      sidebar?.dispose();
    } catch {
      /* best-effort */
    }
  });
}
