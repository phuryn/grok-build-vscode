/**
 * VS Code implementation of the portable {@link Host} interface (and the
 * HostContext / HostWebviewView adapters).
 *
 * Lives in its own module so `host.ts` and `sidebar.ts` stay free of the
 * `vscode` import — that is the whole point of the seam (a desktop host
 * implements Host without this file existing at all).
 */
import * as vscode from "vscode";
import {
  ensureConfigToml,
  globalConfigPath,
  GLOBAL_CONFIG_STUB,
  projectConfigPath,
  PROJECT_CONFIG_STUB,
} from "./grok-config";
import type {
  ConfigInspect,
  ConfigTarget,
  Host,
  HostCancellationToken,
  HostConfiguration,
  HostContext,
  HostFileSystem,
  HostFileSystemWatcher,
  HostInputBoxOptions,
  HostMessageOptions,
  HostOpenDialogOptions,
  HostProgressOptions,
  HostQuickPickItem,
  HostQuickPickOptions,
  HostSaveDialogOptions,
  HostTerminal,
  HostTerminalOptions,
  HostTextDocumentContentProvider,
  HostTextEditor,
  HostTextShowOptions,
  HostWebview,
  HostWebviewView,
  HostEditorWebview,
} from "./host";
import { Uri, isFsPathInWorkspace, untitledTextOpenOptions } from "./host";
import {
  GROK_CHAT_VIEW_ID,
  hostAcceptedSecondarySideBar,
  SECONDARY_SIDE_BAR_PROBE_KEY,
  type PanelPosition,
} from "./view-move";

function toVsCodeTarget(target: ConfigTarget | undefined): vscode.ConfigurationTarget {
  switch (target) {
    case "workspace":
      return vscode.ConfigurationTarget.Workspace;
    case "workspaceFolder":
      return vscode.ConfigurationTarget.WorkspaceFolder;
    case "global":
    default:
      return vscode.ConfigurationTarget.Global;
  }
}

function wrapConfiguration(cfg: vscode.WorkspaceConfiguration): HostConfiguration {
  return {
    get<T>(section: string, defaultValue?: T): T | undefined {
      if (arguments.length >= 2) return cfg.get<T>(section, defaultValue as T);
      return cfg.get<T>(section);
    },
    update(section, value, target) {
      return cfg.update(section, value, toVsCodeTarget(target));
    },
    inspect<T>(section: string): ConfigInspect<T> | undefined {
      const raw = cfg.inspect<T>(section);
      if (!raw) return undefined;
      return {
        key: raw.key,
        defaultValue: raw.defaultValue,
        globalValue: raw.globalValue,
        workspaceValue: raw.workspaceValue,
        workspaceFolderValue: raw.workspaceFolderValue,
      };
    },
  };
}

/** Split a rest-arg list that may lead with `{ modal?: boolean }` (VS Code's
 *  MessageOptions overload) from the trailing string button labels. */
function splitMessageArgs(
  items: Array<string | HostMessageOptions>,
): { options?: HostMessageOptions; buttons: string[] } {
  if (items.length > 0 && typeof items[0] === "object" && items[0] !== null) {
    return { options: items[0] as HostMessageOptions, buttons: items.slice(1) as string[] };
  }
  return { buttons: items as string[] };
}

function wrapTerminal(term: vscode.Terminal): HostTerminal {
  return {
    show(preserveFocus) {
      term.show(preserveFocus);
    },
    sendText(text, addNewLine) {
      term.sendText(text, addNewLine);
    },
    dispose() {
      term.dispose();
    },
  };
}

/** Single encoder for portable → VS Code URI. All comparisons against
 *  VS Code-produced URI strings must convert through this first.
 *  Exported so integration tests can assert encoder symmetry. */
export function toVsCodeUri(u: Uri): vscode.Uri {
  // Prefer Uri.file when there is nothing beyond path identity — it is the
  // canonical VS Code constructor for on-disk paths. Query/fragment (rare on
  // file URIs) force the component form so they are not dropped.
  if (u.scheme === "file" && !u.query && !u.fragment) {
    return vscode.Uri.file(u.fsPath);
  }
  return vscode.Uri.from({
    scheme: u.scheme,
    authority: u.authority || undefined,
    path: u.path,
    query: u.query || undefined,
    fragment: u.fragment || undefined,
  });
}

/** VS Code → portable Uri. Preserves scheme, authority, query, fragment, and real fsPath. */
export function fromVsCodeUri(u: vscode.Uri): Uri {
  if (u.scheme === "file" && !u.query && !u.fragment) {
    return Uri.file(u.fsPath);
  }
  return Uri.from({
    scheme: u.scheme,
    authority: u.authority || "",
    path: u.path,
    query: u.query || "",
    fragment: u.fragment || "",
    // Carry VS Code's real fsPath (remote schemes include host-local paths).
    fsPath: u.fsPath,
  });
}

function toVsCodeShowOptions(opts: HostTextShowOptions): vscode.TextDocumentShowOptions {
  const out: vscode.TextDocumentShowOptions = {};
  if (opts.preview !== undefined) out.preview = opts.preview;
  if (opts.preserveFocus !== undefined) out.preserveFocus = opts.preserveFocus;
  if (opts.selection) {
    out.selection = new vscode.Range(
      opts.selection.start.line,
      opts.selection.start.character,
      opts.selection.end.line,
      opts.selection.end.character,
    );
  }
  return out;
}

function wrapTextEditor(editor: vscode.TextEditor): HostTextEditor {
  return {
    document: { uri: fromVsCodeUri(editor.document.uri) },
    selection: {
      isEmpty: editor.selection.isEmpty,
      start: {
        line: editor.selection.start.line,
        character: editor.selection.start.character,
      },
      end: {
        line: editor.selection.end.line,
        character: editor.selection.end.character,
      },
    },
  };
}

const hostFs: HostFileSystem = {
  async readFile(uri) {
    return vscode.workspace.fs.readFile(toVsCodeUri(uri));
  },
  async writeFile(uri, content) {
    await vscode.workspace.fs.writeFile(toVsCodeUri(uri), content);
  },
  async createDirectory(uri) {
    await vscode.workspace.fs.createDirectory(toVsCodeUri(uri));
  },
  async delete(uri, options) {
    await vscode.workspace.fs.delete(toVsCodeUri(uri), options);
  },
  async stat(uri) {
    const s = await vscode.workspace.fs.stat(toVsCodeUri(uri));
    return { type: s.type, ctime: s.ctime, mtime: s.mtime, size: s.size };
  },
};

/**
 * Build a Host that forwards every effect to the live VS Code API.
 *
 * The output channel is owned by the extension entry point (so the "Show Logs"
 * command can still call `output.show()` without going through the sidebar);
 * we only borrow it for append/show.
 */
export function createVsCodeHost(
  output: vscode.OutputChannel,
  context?: vscode.ExtensionContext,
): Host {
  // `capabilities` is assembled synchronously when the webview announces itself,
  // but the only way to ask whether the host honoured our container contribution
  // is `getCommands`, which is async. So: seed from what the last run learned,
  // then correct and persist.
  //
  // Defaulting to TRUE on a first run matters — it is the pre-Cursor truth, and
  // being briefly wrong there costs one menu item that does nothing, where being
  // wrong the other way would hide the correct destination in every VS Code.
  // In practice the probe wins the race anyway: in the host this exists for, the
  // webview is not resolved until activation's relocation focuses it.
  let secondarySideBar = context?.globalState.get<boolean>(SECONDARY_SIDE_BAR_PROBE_KEY) ?? true;
  void Promise.resolve(vscode.commands.getCommands(true)).then(
    (cmds) => {
      secondarySideBar = hostAcceptedSecondarySideBar(cmds);
      void context?.globalState.update(SECONDARY_SIDE_BAR_PROBE_KEY, secondarySideBar);
    },
    () => {
      /* keep the seeded value — a failed probe is not evidence of a refusal */
    },
  );

  return {
    showInformationMessage(message, ...items) {
      return vscode.window.showInformationMessage(message, ...items);
    },
    showWarningMessage(message, ...items) {
      const { options, buttons } = splitMessageArgs(items);
      if (options) {
        return vscode.window.showWarningMessage(message, options, ...buttons);
      }
      return vscode.window.showWarningMessage(message, ...buttons);
    },
    showErrorMessage(message, ...items) {
      const { options, buttons } = splitMessageArgs(items);
      if (options) {
        return vscode.window.showErrorMessage(message, options, ...buttons);
      }
      return vscode.window.showErrorMessage(message, ...buttons);
    },

    showQuickPick<T extends HostQuickPickItem>(
      items: readonly T[],
      options?: HostQuickPickOptions,
    ) {
      return vscode.window.showQuickPick(items, options) as Thenable<T | undefined>;
    },
    showInputBox(options?: HostInputBoxOptions) {
      return vscode.window.showInputBox(options);
    },
    async showOpenDialog(options?: HostOpenDialogOptions) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: options?.canSelectFiles,
        canSelectFolders: options?.canSelectFolders,
        canSelectMany: options?.canSelectMany,
        openLabel: options?.openLabel,
        filters: options?.filters,
        defaultUri: options?.defaultPath ? vscode.Uri.file(options.defaultPath) : undefined,
      });
      return picked?.map((u) => u.fsPath);
    },
    async showSaveDialog(options?: HostSaveDialogOptions) {
      const target = await vscode.window.showSaveDialog({
        defaultUri: options?.defaultPath ? vscode.Uri.file(options.defaultPath) : undefined,
        filters: options?.filters,
        saveLabel: options?.saveLabel,
        title: options?.title,
      });
      return target?.fsPath;
    },

    getConfiguration(section?: string, resourcePath?: string) {
      const resource = resourcePath ? vscode.Uri.file(resourcePath) : undefined;
      return wrapConfiguration(
        section === undefined
          ? vscode.workspace.getConfiguration(undefined, resource)
          : vscode.workspace.getConfiguration(section, resource),
      );
    },

    openExternal(url: string) {
      return vscode.env.openExternal(vscode.Uri.parse(url));
    },
    async openSettings(section?: string) {
      await vscode.commands.executeCommand("workbench.action.openSettings", section);
    },
    openEditorWebview(opts): HostEditorWebview {
      const panel = vscode.window.createWebviewPanel(
        opts.viewType,
        opts.title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: opts.localResourceRoots.map(toVsCodeUri),
        },
      );
      return {
        webview: wrapWebview(panel.webview),
        reveal() {
          panel.reveal(vscode.ViewColumn.Active);
        },
        onDidDispose(listener) {
          return panel.onDidDispose(listener);
        },
        dispose() {
          panel.dispose();
        },
      };
    },
    async linkRemote() {
      await vscode.commands.executeCommand("grok.linkRemote");
    },
    async unlinkRemote() {
      await vscode.commands.executeCommand("grok.unlinkRemote");
    },
    setContext(key: string, value: unknown) {
      return vscode.commands.executeCommand("setContext", key, value);
    },
    async relocateView(
      viewId: string,
      destinationId?: string | null,
      panelPosition?: PanelPosition | null,
    ) {
      if (destinationId) {
        // Timed per step. Moving a webview view makes VS Code dispose and
        // rebuild it, so this is one of the few user actions that can visibly
        // stall — and which of the three steps costs it is not guessable from
        // the outside. `Grok: Show Logs` after a move answers it.
        const started = Date.now();
        const lap = (step: string) => {
          output.appendLine(`[move] ${step} ${Date.now() - started}ms`);
        };
        await vscode.commands.executeCommand("vscode.moveViews", {
          viewIds: [viewId],
          destinationId,
        });
        lap("moveViews");
        if (panelPosition) {
          // Dock the edge the menu label promised, before revealing, so the
          // view appears where the user was told it would. Best effort on
          // purpose: a fork missing these built-ins must still get the move and
          // the reveal, which are the parts that matter.
          try {
            await vscode.commands.executeCommand(
              panelPosition === "right"
                ? "workbench.action.positionPanelRight"
                : "workbench.action.positionPanelBottom",
            );
          } catch {
            /* layout nudge unavailable — the move itself already landed */
          }
          lap("positionPanel");
        }
        // Focus last: it opens whichever dock now holds the view, so "any option
        // shows the panel" falls out of the move rather than needing its own call.
        await vscode.commands.executeCommand(`${viewId}.focus`);
        lap("focus");
      } else {
        await vscode.commands.executeCommand("workbench.action.moveFocusedView", viewId);
      }
    },

    async revealChatView() {
      // `<viewId>.focus` is generated by VS Code for every contributed view, and
      // is the same command the move flow above uses to land on its destination.
      //
      // Swallowed on failure ON PURPOSE: this is a courtesy on top of opening a
      // conversation, and the conversation has already opened by the time it
      // runs. If the view is closed, or the user has dragged it somewhere this
      // cannot reach, the right outcome is a chat that did not come forward —
      // not a failed open.
      try {
        await vscode.commands.executeCommand(`${GROK_CHAT_VIEW_ID}.focus`);
      } catch {
        /* the conversation is open either way */
      }
    },

    createTerminal(nameOrOptions: string | HostTerminalOptions) {
      if (typeof nameOrOptions === "string") {
        return wrapTerminal(vscode.window.createTerminal(nameOrOptions));
      }
      return wrapTerminal(
        vscode.window.createTerminal({
          name: nameOrOptions.name,
          shellPath: nameOrOptions.shellPath,
          shellArgs: nameOrOptions.shellArgs,
          cwd: nameOrOptions.cwd,
        }),
      );
    },

    withProgress<T>(
      options: HostProgressOptions,
      task: (cancellationToken: HostCancellationToken) => Thenable<T>,
    ) {
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: options.title,
          cancellable: options.cancellable ?? false,
        },
        (_progress, token) => task(token),
      );
    },

    append(text: string) {
      output.append(text);
    },
    appendLine(line: string) {
      output.appendLine(line);
    },
    toggleDevTools() {
      // VS Code has its own Developer: Toggle Developer Tools command.
    },
    showOutput(preserveFocus?: boolean) {
      output.show(preserveFocus);
    },

    fs: hostFs,

    workspaceRoot() {
      return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    },
    workspaceFolders() {
      return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    },
    setActiveWorkspaceFolder(_cwd: string) {
      // VS Code: the window is the workspace — no folder switch surface.
      // Report success so callers do not abort; nothing moved.
      return true;
    },
    addWorkspaceFolder(_cwd: string) {
      return false;
    },
    removeWorkspaceFolder(_cwd: string) {
      return false;
    },
    asRelativePath(uri: Uri) {
      // Must pass a real vscode.Uri so remote workspace folders match.
      return vscode.workspace.asRelativePath(toVsCodeUri(uri));
    },
    async findFiles(
      include: string | { base: string; pattern: string },
      exclude?: string,
      maxResults?: number,
    ) {
      const pattern =
        typeof include === "string"
          ? include
          : new vscode.RelativePattern(include.base, include.pattern);
      const uris = await vscode.workspace.findFiles(pattern, exclude, maxResults);
      return uris.map(fromVsCodeUri);
    },
    isInWorkspace(fsPath: string) {
      // Match by fsPath so remote workspace folders (vscode-remote://…) still
      // count — Uri.file(path) cannot match those folder URIs. Comparison is
      // platform-aware (case-insensitive only on Windows) and resolves `.`/`..`
      // via path.normalize — see isFsPathInWorkspace.
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) return false;
      return isFsPathInWorkspace(
        fsPath,
        folders.map((f) => f.uri.fsPath),
      );
    },

    getActiveTextEditor() {
      const editor = vscode.window.activeTextEditor;
      return editor ? wrapTextEditor(editor) : undefined;
    },
    async openTextFile(fsPath: string, options?: HostTextShowOptions) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      await vscode.window.showTextDocument(doc, options ? toVsCodeShowOptions(options) : undefined);
    },
    async openResource(target: string | Uri, options?: HostTextShowOptions) {
      const uri = typeof target === "string" ? vscode.Uri.file(target) : toVsCodeUri(target);
      await vscode.commands.executeCommand(
        "vscode.open",
        uri,
        options ? toVsCodeShowOptions(options) : undefined,
      );
    },
    async showInFolder(fsPath: string) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fsPath));
    },
    async openGlobalConfig() {
      const p = globalConfigPath();
      ensureConfigToml(p, GLOBAL_CONFIG_STUB);
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(p));
    },
    async openProjectConfig(projectCwd: string) {
      const p = projectConfigPath(projectCwd);
      ensureConfigToml(p, PROJECT_CONFIG_STUB);
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(p));
    },
    async openHostResolvedPath(fsPath: string) {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(fsPath));
    },
    async openUntitledText(content: string, language?: string) {
      const doc = await vscode.workspace.openTextDocument(untitledTextOpenOptions(content, language));
      await vscode.window.showTextDocument(doc);
    },
    async openDiff(left: Uri, right: Uri, title: string, options?: HostTextShowOptions) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        toVsCodeUri(left),
        toVsCodeUri(right),
        title,
        options ? toVsCodeShowOptions(options) : undefined,
      );
    },
    openWorkspaceTextFiles() {
      const out: Array<{ rel: string; abs: string }> = [];
      const seen = new Set<string>();
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (!(input instanceof vscode.TabInputText)) continue;
          const uri = input.uri;
          if (uri.scheme !== "file") continue;
          if (!vscode.workspace.getWorkspaceFolder(uri)) continue;
          const abs = uri.fsPath;
          if (seen.has(abs)) continue;
          seen.add(abs);
          out.push({
            rel: vscode.workspace.asRelativePath(uri),
            abs,
          });
        }
      }
      return out;
    },
    closeDiffTabs(original: Uri, modified: Uri) {
      // Convert both sides through the same encoder as VS Code's tab URIs so a
      // space (or #/%/?) in the filename cannot desync portable vs VS Code strings.
      const originalKey = toVsCodeUri(original).toString();
      const modifiedKey = toVsCodeUri(modified).toString();
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (
            input instanceof vscode.TabInputTextDiff &&
            input.original.toString() === originalKey &&
            input.modified.toString() === modifiedKey
          ) {
            void vscode.window.tabGroups.close(tab);
          }
        }
      }
    },

    onDidChangeConfiguration(listener) {
      return vscode.workspace.onDidChangeConfiguration((e) => {
        listener({
          affectsConfiguration(section: string) {
            return e.affectsConfiguration(section);
          },
        });
      });
    },
    onDidChangeActiveTextEditor(listener) {
      return vscode.window.onDidChangeActiveTextEditor(() => listener());
    },
    onDidChangeActiveTextEditorSelection(listener) {
      return vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor !== vscode.window.activeTextEditor) return;
        listener();
      });
    },
    createFileSystemWatcher(base: string, pattern: string): HostFileSystemWatcher {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(base, pattern),
      );
      return {
        onDidCreate(listener) {
          return watcher.onDidCreate(() => listener());
        },
        onDidChange(listener) {
          return watcher.onDidChange(() => listener());
        },
        onDidDelete(listener) {
          return watcher.onDidDelete(() => listener());
        },
        dispose() {
          watcher.dispose();
        },
      };
    },
    registerTextDocumentContentProvider(scheme, provider: HostTextDocumentContentProvider) {
      return vscode.workspace.registerTextDocumentContentProvider(scheme, {
        provideTextDocumentContent(uri: vscode.Uri) {
          return provider.provideTextDocumentContent(fromVsCodeUri(uri));
        },
      });
    },

    get appName() {
      return vscode.env.appName;
    },
    get language() {
      return vscode.env.language;
    },
    get isTelemetryEnabled() {
      return vscode.env.isTelemetryEnabled;
    },

    // VS Code: webview moves / Reload Webviews recreate the document under a
    // live session — still startSession (v3.1.0), never rehydrate.
    webviewReloadsUnderLiveSession: false,
    remoteInstallIdSuffix: "",
    canRelocateView: true,
    get canUseSecondarySideBar() {
      return secondarySideBar;
    },
    canShowOutput: true,
    canToggleDevTools: false,
    canShowMcpSettings: true,
    canOpenInEditor: true,
    canSwitchWorkspaceFolder: false,
    canArchiveRepos: true,
    // Media goes through asWebviewUri, i.e. the editor's own resource pipeline.
    // We do not own it and cannot vouch for its range handling.
    canServeMediaRanges: false,
    // Deliberately off for now; enable this one capability when VS Code's
    // generated-video action should use revealFileInOS too.
    canShowInFolder: false,
    // Real editor tabs — View all / proposed diffs stay native.
    canPreviewInApp: false,
    // Editor-area settings tab. Desktop/remotes keep the in-page overlay.
    canOpenSettingsEditor: true,
  };
}

/** Map a real ExtensionContext onto the portable HostContext slice. */
export function createVsCodeHostContext(context: vscode.ExtensionContext): HostContext {
  return {
    secrets: {
      get: (key) => context.secrets.get(key),
      store: (key, value) => context.secrets.store(key, value),
      delete: (key) => context.secrets.delete(key),
    },
    // Preserve URI identity — remote hosts use vscode-remote://, not file://.
    globalStorageUri: fromVsCodeUri(context.globalStorageUri),
    extensionUri: fromVsCodeUri(context.extensionUri),
    extensionId: context.extension.id,
    extensionVersion: (context.extension.packageJSON as { version?: string })?.version ?? "",
    isProduction: context.extensionMode === vscode.ExtensionMode.Production,
    globalState: context.globalState,
    subscriptions: context.subscriptions,
  };
}

/** Adapt a VS Code WebviewView so `sidebar.resolveWebviewView` never sees vscode types. */
export function wrapWebviewView(view: vscode.WebviewView): HostWebviewView {
  return {
    get webview(): HostWebview {
      return wrapWebview(view.webview);
    },
    show(preserveFocus?: boolean) {
      view.show?.(preserveFocus);
    },
  };
}

/** Exported for integration tests that assert URI identity across the webview seam. */
export function wrapWebview(webview: vscode.Webview): HostWebview {
  return {
    get html() {
      return webview.html;
    },
    set html(value: string) {
      webview.html = value;
    },
    get options() {
      return {
        enableScripts: webview.options.enableScripts,
        // Round-trip through fromVsCodeUri so remote roots keep scheme/authority.
        localResourceRoots: webview.options.localResourceRoots?.map(fromVsCodeUri),
      };
    },
    set options(value) {
      webview.options = {
        enableScripts: value.enableScripts,
        // toVsCodeUri — never Uri.file on a path string (breaks vscode-remote).
        localResourceRoots: value.localResourceRoots?.map(toVsCodeUri),
      };
    },
    get cspSource() {
      return webview.cspSource;
    },
    postMessage(message) {
      return webview.postMessage(message);
    },
    onDidReceiveMessage(listener) {
      return webview.onDidReceiveMessage(listener);
    },
    asWebviewUri(uri: Uri) {
      return webview.asWebviewUri(toVsCodeUri(uri)).toString();
    },
  };
}
