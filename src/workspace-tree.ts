import * as vscode from "vscode";
import * as path from "node:path";
import type { GrokSidebar } from "./sidebar";
import { SessionListEntry, defaultFs, resolveGrokHome } from "./sessions";
import {
  WorkspaceRef,
  addWorkspacePath,
  buildWorkspaceList,
  canonicalizeWorkspacePath,
  discoverWorkspaces,
  dotColorId,
  dotTooltip,
  formatAgo,
  removeWorkspacePath,
} from "./workspaces";

/**
 * The Grok Workspaces panel — a native tree view in the primary side bar
 * (`grokPrimary` container) listing every workspace's session history with the
 * same status dots as the chat's history popover, across workspaces.
 *
 * Two levels: workspace nodes (this window's folder(s) first — never removable —
 * then user-added ones, persisted in globalState) and session rows (paginated
 * per workspace via a trailing "Load more…" node). Clicking a session opens it
 * in the chat panel, spawning grok in the SESSION's workspace (the Session.cwd
 * threading in sidebar.ts) — a live pool member re-focuses instantly.
 *
 * All data access goes through GrokSidebar's panel API (shared mtime cache, live
 * overlay, dots) and the pure `workspaces.ts` helpers; this module is only
 * VS Code glue, deliberately thin because vitest can't load `vscode`.
 */

export const WORKSPACES_VIEW_ID = "grok.workspaces";
/** globalState key for the user-added workspace folders (display spellings). */
const ADDED_WORKSPACES_KEY = "grok.addedWorkspaces";
/** Session rows shown per workspace per "Load more…" step. */
const TREE_PAGE_SIZE = 100;

type SessionEntry = SessionListEntry & { storageCwd: string };

interface WorkspaceNode { kind: "workspace"; ref: WorkspaceRef }
interface SessionNode { kind: "session"; entry: SessionEntry }
interface MoreNode { kind: "more"; wsKey: string }
export type WorkspacesNode = WorkspaceNode | SessionNode | MoreNode;

export class GrokWorkspacesProvider implements vscode.TreeDataProvider<WorkspacesNode> {
  private readonly changeEmitter = new vscode.EventEmitter<WorkspacesNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  /** Rows currently shown per workspace (canonical key → limit); grows per "Load more…". */
  private readonly limits = new Map<string, number>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sidebar: GrokSidebar,
  ) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  private addedWorkspaces(): string[] {
    return this.context.globalState.get<string[]>(ADDED_WORKSPACES_KEY, []);
  }

  /** Workspace nodes: this window's folder(s), then the persisted additions —
   *  matched against grok's on-disk store for their real storage spellings. */
  private workspaceRefs(): WorkspaceRef[] {
    const discovered = discoverWorkspaces({
      fs: defaultFs,
      grokHome: resolveGrokHome(process.env),
      log: (m) => this.sidebar.log(m),
    });
    return buildWorkspaceList({
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      added: this.addedWorkspaces(),
      discovered,
    });
  }

  getChildren(node?: WorkspacesNode): WorkspacesNode[] {
    if (!node) return this.workspaceRefs().map((ref) => ({ kind: "workspace", ref }));
    if (node.kind !== "workspace") return [];
    const limit = this.limits.get(node.ref.canonicalKey) ?? TREE_PAGE_SIZE;
    const { entries, total } = this.sidebar.listWorkspaceSessions(node.ref.storageCwds, limit);
    const children: WorkspacesNode[] = entries.map((entry) => ({ kind: "session", entry }));
    if (entries.length < total) children.push({ kind: "more", wsKey: node.ref.canonicalKey });
    return children;
  }

  getTreeItem(node: WorkspacesNode): vscode.TreeItem {
    if (node.kind === "workspace") {
      const { ref } = node;
      const item = new vscode.TreeItem(
        path.basename(ref.displayPath) || ref.displayPath,
        // The window's own workspace opens expanded; added ones start collapsed.
        // TreeItem.id keeps the user's collapse choices stable across refreshes.
        ref.source === "active"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = "ws:" + ref.canonicalKey;
      item.description = path.dirname(ref.displayPath);
      item.tooltip = ref.displayPath;
      item.iconPath = new vscode.ThemeIcon(ref.source === "active" ? "root-folder-opened" : "folder");
      item.contextValue = ref.source === "active" ? "grokWorkspaceActive" : "grokWorkspaceAdded";
      return item;
    }
    if (node.kind === "more") {
      const item = new vscode.TreeItem("Load more…", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("ellipsis");
      item.command = { command: "grok.workspaces.loadMore", title: "Load more", arguments: [node] };
      return item;
    }
    const { entry } = node;
    const dot = this.sidebar.dotForSession(entry.id);
    const active = entry.id === this.sidebar.focusedSessionId();
    const item = new vscode.TreeItem(entry.displayName || "Untitled", vscode.TreeItemCollapsibleState.None);
    item.id = "s:" + entry.id;
    const parts: string[] = [];
    if (entry.numMessages) parts.push(`${entry.numMessages} msg`);
    parts.push(formatAgo(entry.updatedAt, Date.now()));
    item.description = parts.join(" · ");
    const hint = dotTooltip(dot);
    item.tooltip = [entry.rawSummary || entry.displayName, hint].filter(Boolean).join("\n");
    item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(dotColorId(dot)));
    // The focused session gets a distinct context value so Delete isn't offered
    // on it (mirrors the popover: the live CLI re-persists it, so a delete
    // wouldn't stick).
    item.contextValue = active ? "grokSessionActive" : "grokSession";
    item.command = { command: "grok.workspaces.openSession", title: "Open", arguments: [node] };
    return item;
  }

  loadMore(wsKey: string): void {
    this.limits.set(wsKey, (this.limits.get(wsKey) ?? TREE_PAGE_SIZE) + TREE_PAGE_SIZE);
    this.refresh();
  }

  /** "+" toolbar action: quick-pick of workspaces grok already knows (from the
   *  store, with session counts) not yet in the panel, plus Browse… for any
   *  folder. Multi-select capable via Browse. */
  async addWorkspace(): Promise<void> {
    const existing = new Set(this.workspaceRefs().map((r) => r.canonicalKey));
    const discovered = discoverWorkspaces({
      fs: defaultFs,
      grokHome: resolveGrokHome(process.env),
    }).filter((d) => !existing.has(d.canonicalKey));
    type Pick = vscode.QuickPickItem & { folder?: string; browse?: boolean };
    const items: Pick[] = discovered.map((d) => ({
      label: path.basename(d.displayPath) || d.displayPath,
      description: d.displayPath,
      detail: `${d.sessionCount} session${d.sessionCount === 1 ? "" : "s"}`,
      folder: d.displayPath,
    }));
    items.push({ label: "$(folder-opened) Browse…", detail: "Pick any folder on disk", browse: true });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Add a workspace to the Grok panel",
    });
    if (!picked) return;
    let folders: string[] = [];
    if (picked.browse) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: true,
        openLabel: "Add to Grok panel",
      });
      if (!uris || uris.length === 0) return;
      folders = uris.map((u) => u.fsPath);
    } else if (picked.folder) {
      folders = [picked.folder];
    }
    const activeKeys = (vscode.workspace.workspaceFolders ?? []).map((f) =>
      canonicalizeWorkspacePath(f.uri.fsPath),
    );
    let added = this.addedWorkspaces();
    for (const f of folders) added = addWorkspacePath(added, f, activeKeys);
    await this.context.globalState.update(ADDED_WORKSPACES_KEY, added);
    this.refresh();
  }

  /** Forget an added workspace — never deletes the folder or its grok sessions. */
  async removeWorkspace(node: WorkspacesNode): Promise<void> {
    if (node.kind !== "workspace" || node.ref.source === "active") return;
    await this.context.globalState.update(
      ADDED_WORKSPACES_KEY,
      removeWorkspacePath(this.addedWorkspaces(), node.ref.canonicalKey),
    );
    this.refresh();
  }
}

/** Create the tree view, wire its refresh + visibility plumbing, and register
 *  every `grok.workspaces.*` command. Called once from activate(). */
export function registerWorkspacesView(
  context: vscode.ExtensionContext,
  sidebar: GrokSidebar,
): void {
  const provider = new GrokWorkspacesProvider(context, sidebar);
  const tree = vscode.window.createTreeView(WORKSPACES_VIEW_ID, {
    treeDataProvider: provider,
  });

  // Coalesce the sidebar's catalog/dot event bursts (a working session fires
  // several per turn) into one repaint.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestRefresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 200);
  };

  // The chat's history button hides while the panel is visible (the panel is
  // the history surface then). Seed the current state — the webview may not
  // exist yet; postInitialState re-sends it when the webview comes up.
  sidebar.setHistoryPanelVisible(tree.visible);

  context.subscriptions.push(
    tree,
    { dispose: () => { if (timer) clearTimeout(timer); } },
    sidebar.onDidChangeSessions(requestRefresh),
    tree.onDidChangeVisibility((e) => sidebar.setHistoryPanelVisible(e.visible)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.commands.registerCommand("grok.workspaces.addWorkspace", () => provider.addWorkspace()),
    vscode.commands.registerCommand("grok.workspaces.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("grok.workspaces.openSession", (node: WorkspacesNode) => {
      if (node?.kind === "session") {
        void sidebar.openSessionInWorkspace(node.entry.storageCwd, node.entry.id);
      }
    }),
    vscode.commands.registerCommand("grok.workspaces.loadMore", (node: WorkspacesNode) => {
      if (node?.kind === "more") provider.loadMore(node.wsKey);
    }),
    vscode.commands.registerCommand("grok.workspaces.newSession", (node: WorkspacesNode) => {
      if (node?.kind === "workspace") void sidebar.newSessionInWorkspace(node.ref.displayPath);
    }),
    vscode.commands.registerCommand("grok.workspaces.openInNewWindow", (node: WorkspacesNode) => {
      if (node?.kind === "workspace") {
        void vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(node.ref.displayPath),
          { forceNewWindow: true },
        );
      }
    }),
    vscode.commands.registerCommand("grok.workspaces.clearSessions", (node: WorkspacesNode) => {
      if (node?.kind === "workspace") void sidebar.clearWorkspaceSessions(node.ref.storageCwds);
    }),
    vscode.commands.registerCommand("grok.workspaces.removeWorkspace", (node: WorkspacesNode) => {
      void provider.removeWorkspace(node);
    }),
    vscode.commands.registerCommand("grok.workspaces.renameSession", (node: WorkspacesNode) => {
      if (node?.kind === "session") {
        void sidebar.renameSessionFromPanel(node.entry.id, node.entry.displayName);
      }
    }),
    vscode.commands.registerCommand("grok.workspaces.deleteSession", (node: WorkspacesNode) => {
      if (node?.kind === "session") {
        void sidebar.deleteSessionInWorkspace(node.entry.storageCwd, node.entry.id, node.entry.displayName);
      }
    }),
  );
}
