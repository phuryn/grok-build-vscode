import * as vscode from "vscode";
import { GrokSidebar } from "./sidebar";
import { createVsCodeHost, createVsCodeHostContext, fromVsCodeUri, wrapWebviewView } from "./vscode-host";
import {
  GROK_VIEW_ID,
  GROK_PROJECTS_VIEW_ID,
  PANEL_CONTAINER_ID,
  PRIMARY_CONTAINER_ID,
  SECONDARY_CONTAINER_ID,
  revealCommandFor,
  viewPlacementCorrection,
  isFirstEverRun,
  MOVE_VIEW_HINT_USED_KEY,
  VIEW_PLACEMENT_KEY,
  withAttempt,
  type PanelPosition,
  type PlacementRecord,
} from "./view-move";

/**
 * Put the chat somewhere this editor will actually show it.
 *
 * Cursor 3.15 refuses `viewsContainers.secondarySidebar` — reserved for its own
 * agent UI — so our container is never created, the view is dropped into
 * Explorer, and `workbench.view.extension.grokSidebar` never registers. The
 * manifest is static and cannot branch per editor, so the correction runs here,
 * with the same `vscode.moveViews` payload the gear menu already ships
 * (`vscode-host.ts` → `relocateView`).
 *
 * Runs on **startup**, not on first use. Someone whose chat is buried in an
 * Explorer section has no way to open it, so a correction that waits for them to
 * open it never runs — which is why the manifest asks for `onStartupFinished`
 * despite that entry having been dropped as redundant back in 1.x.
 *
 * ONCE, ever — not once per release. Where a view sits is the user's, and the
 * editor's own Move To leaves no trace we can read, so after the first
 * correction there is no way to tell someone who deliberately moved the chat
 * from someone who never touched it. Correcting again would overrule the first
 * of those on every update. See {@link PlacementRecord}.
 *
 * Focus follows the move on purpose. Arriving from a chat you could not open, a
 * silent re-home to a dock you were not looking at is indistinguishable from
 * still being broken.
 *
 * It applies the move ONCE, here. An earlier revision also re-applied it when
 * the view first resolved, on the theory that a move issued at startup might be
 * lost — instrumenting a real Cursor disproved that (it never failed), and the
 * re-apply then became a hazard of its own: moving the view through the host's
 * picker rebuilds the webview, which fired the pending re-apply and dragged the
 * chat back out of the location the user had just chosen.
 *
 * It aims at a CONTAINER, which bounds what it can achieve: a host may keep our
 * container and ignore where it declared it lives — Cursor renders the panel one
 * in the primary side bar. Reaching a dock the host draws for itself needs a
 * LOCATION, and only the host's own picker takes one, which is what
 * `Grok: Move Chat View` and the gear's `Move view…` open.
 *
 * Failure is swallowed: a host that rejects the move must not take activation
 * down with it, and `grok.open` resolves its command independently.
 */
async function ensureViewPlacement(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  isFirstEverRun: boolean,
): Promise<void> {
  const log = (line: string) => output.appendLine(`[placement] ${line}`);
  const version = context.extension.packageJSON?.version ?? "";
  let correctionIssued = false;
  try {
    const availableCommands = await vscode.commands.getCommands(true);
    // The missing diagnostic in every round of this so far: WHICH of our three
    // containers this editor actually created. Whether Cursor registers the
    // panel container at all decides between two completely different fixes.
    log(
      `containers: secondary=${availableCommands.includes(SECONDARY_CONTAINER_ID)} ` +
        `primary=${availableCommands.includes(PRIMARY_CONTAINER_ID)} ` +
        `panel=${availableCommands.includes(PANEL_CONTAINER_ID)} ` +
        `viewFocus=${availableCommands.includes(`${GROK_VIEW_ID}.focus`)} ` +
        `app=${vscode.env.appName}`,
    );
    const target = viewPlacementCorrection({ availableCommands, isFirstEverRun });
    if (!target) {
      // Logged rather than silent. When someone reports the chat stuck in
      // Explorer, "why didn't it move" is the first question, and before this
      // there was nothing anywhere that could answer it.
      log(`no move — version=${version}, firstEverRun=${isFirstEverRun}`);
      return;
    }
    // Re-read immediately before acting. `activate` starts this without
    // awaiting, so the user can reach the palette command or the gear during the
    // probe above — and a correction landing after their choice would undo it.
    // This flag may ABORT our move; it may never redirect one.
    if (context.globalState.get<boolean>(MOVE_VIEW_HINT_USED_KEY) === true) {
      log("no move — the user reached the move picker first");
      return;
    }
    log(`moving -> ${target.containerId}, panel ${target.panelPosition ?? "as-is"}`);
    correctionIssued = true;
    // Held for the re-apply below. `onStartupFinished` means the extension host
    // is ready, NOT that the workbench will honour a layout change yet — and
    // there is no API to ask where a view ended up, so a move issued too early
    // fails in silence. Re-applying when the view resolves is the one moment the
    // view is provably live.
    await applyPlacement(target, { reveal: true });
    log("moved");
  } catch (e) {
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    correctionIssued = false;
  } finally {
    // Written only when a move actually went through — a startup where the
    // container had not registered yet, or where the move threw, must not count
    // as done. It is diagnostics, but it also does real work: writing ANY key
    // makes `globalState` non-empty, which is what stops the next launch from
    // reading as a first-ever run. Without it, a genuinely fresh install where
    // nothing else has persisted yet would correct again on the second launch.
    //
    // Re-read rather than reusing a snapshot from before the awaits: anything
    // else in the extension may have persisted state meanwhile, and writing a
    // stale copy back would discard it.
    if (correctionIssued) {
      const latest = context.globalState.get<PlacementRecord>(VIEW_PLACEMENT_KEY);
      await context.globalState.update(VIEW_PLACEMENT_KEY, withAttempt(latest, version));
    }
  }
}

/** Issue the move. Shared by the automatic correction and the palette command so
 *  there is exactly one place that knows the command sequence. */
async function applyPlacement(
  target: { containerId: string; panelPosition: PanelPosition | null },
  opts: { reveal: boolean; log?: (s: string) => void },
): Promise<void> {
  await vscode.commands.executeCommand("vscode.moveViews", {
    viewIds: [GROK_VIEW_ID],
    destinationId: target.containerId,
  });
  opts.log?.("moveViews returned without throwing");
  if (target.panelPosition) {
    // Caveat worth knowing: panel position is workbench-wide, so this also moves
    // Terminal, Problems and Output. Once per update, and only in an editor that
    // refused the secondary side bar.
    await vscode.commands.executeCommand(
      target.panelPosition === "right"
        ? "workbench.action.positionPanelRight"
        : "workbench.action.positionPanelBottom",
    );
  }
  if (opts.reveal) await vscode.commands.executeCommand(`${GROK_VIEW_ID}.focus`);
}

/** What `activate` hands back through `extension.exports`. Empty in every
 *  released build — the test seam below is populated only under
 *  `ExtensionMode.Test`. */
export interface GrokExtensionApi {
  __test?: ReturnType<GrokSidebar["installTestHooks"]>;
}

export function activate(context: vscode.ExtensionContext): GrokExtensionApi {
  // Read FIRST, before anything below can persist anything. An install with no
  // stored state has never been interacted with, so wherever the editor put the
  // view, nobody chose it — that is the entire licence the placement correction
  // has to move it, and it evaporates the moment any other subsystem writes.
  const firstEverRun = isFirstEverRun(context.globalState.keys());
  const output = vscode.window.createOutputChannel("Grok");
  const host = createVsCodeHost(output, context);
  const hostContext = createVsCodeHostContext(context);
  const sidebar = new GrokSidebar(hostContext, host);
  // Test host only. Latch missing-CLI discovery before ensureViewPlacement can
  // reveal the view (ready → startSession). Production never takes this branch.
  const testHooks = context.extensionMode === vscode.ExtensionMode.Test
    ? sidebar.installTestHooks()
    : undefined;
  testHooks?.isolateFromInstalledGrok();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GrokSidebar.viewId,
      {
        resolveWebviewView(view) {
          sidebar.resolveWebviewView(wrapWebviewView(view));
        },
      },
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    // Projects rail: its own activity-bar container (`grokProjects`), never the
    // chat's move target — see PROJECTS_CONTAINER_ID for why sharing one welded
    // the two views together. No Cursor special-casing: registering a view in
    // the primary bar works the same in both editors (Cursor only reserves the
    // *secondary* bar for its agent UI).
    vscode.window.registerWebviewViewProvider(
      GROK_PROJECTS_VIEW_ID,
      {
        resolveWebviewView(view) {
          sidebar.resolveProjectsRailView(wrapWebviewView(view));
          view.onDidDispose(() => sidebar.disposeProjectsRailView());
        },
      },
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    output,
    { dispose: () => sidebar.dispose() },
    vscode.commands.registerCommand("grok.open", async () => {
      // Resolved per invocation rather than baked in: the view can be moved
      // between docks from the gear menu, and in a host that refuses the
      // secondary side bar the container this used to hardcode never exists at
      // all — which is how `grok.open` came to fail with "command not found".
      const cmds = await vscode.commands.getCommands(true);
      await vscode.commands.executeCommand(revealCommandFor(cmds));
    }),
    // Reachable from the palette when the view itself is not — which is the
    // state this whole mechanism exists for. Records nothing: the automatic
    // correction fires only on a first-ever run, so there is no later one for a
    // choice to need protecting from, and nothing to get wrong if the user opens
    // this picker and cancels.
    vscode.commands.registerCommand("grok.moveView", async () => {
      output.appendLine("[placement] palette -> host picker");
      // The host's own picker, preselected on our view. It targets a LOCATION
      // and builds its own container, so it reaches docks no container id of
      // ours can address — in Cursor, the secondary side bar it refuses to give
      // us directly. The view-id argument is what makes it work there at all:
      // without it the command reads the `focusedView` context key, which Cursor
      // never sets for webview views.
      // Same recording the gear does, through the same method, and before the
      // picker for the same reason — see GrokSidebar.retireMoveViewHint.
      await sidebar.retireMoveViewHint();
      await vscode.commands.executeCommand("workbench.action.moveFocusedView", GROK_VIEW_ID);
    }),
    vscode.commands.registerCommand("grok.newSession", () => sidebar.newSession()),
    vscode.commands.registerCommand("grok.newWorktreeSession", () => sidebar.newWorktreeSession()),
    vscode.commands.registerCommand("grok.applyWorktree", () => sidebar.applyFocusedWorktree()),
    vscode.commands.registerCommand("grok.removeWorktree", () => sidebar.removeFocusedWorktree()),
    vscode.commands.registerCommand("grok.rewind", () => sidebar.rewindFocusedSession()),
    vscode.commands.registerCommand("grok.compact", () => {
      // emulated by sending the slash command as a prompt; CLI handles it
      vscode.window.showInformationMessage(
        "Type /compact in the composer to compress the conversation.",
      );
    }),
    vscode.commands.registerCommand("grok.pickModel", () => sidebar.pickModel()),
    vscode.commands.registerCommand("grok.toggleMode", () => sidebar.openModePopover()),
    vscode.commands.registerCommand("grok.sendSelection", () =>
      sidebar.insertActiveMention({ selection: true }),
    ),
    vscode.commands.registerCommand(
      "grok.sendFile",
      // Pass the explorer Uri intact — flattening to fsPath drops remote authority.
      //
      // THE SECOND ARGUMENT IS THE EXPLORER'S WHOLE SELECTION, and ignoring it
      // is why highlighting five files and running this attached one. VS Code
      // passes the clicked resource first and the full selection second; the
      // editor-tab menu and the Command Palette pass no second argument at all,
      // so fall back to the single uri there. This is also the route that works
      // when drag-and-drop does not: a drag out of the Explorer reaches the
      // webview only with Shift held (#136), and a menu item needs no modifier.
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected = uris?.length ? uris : uri ? [uri] : [];
        if (!selected.length) {
          sidebar.insertActiveMention({ pickIfMissing: true });
          return;
        }
        // Only the first rejection speaks — a multi-selection is nearly always
        // rejected wholesale (one folder, outside the conversation's project),
        // and one warning per file would bury the composer in toasts.
        let refused = false;
        for (const one of selected) {
          if (!sidebar.insertActiveMention({ uri: fromVsCodeUri(one), quiet: refused })) {
            refused = true;
          }
        }
      },
    ),
    vscode.commands.registerCommand("grok.insertAtMention", () =>
      sidebar.insertActiveMention(),
    ),
    vscode.commands.registerCommand("grok.showLogs", () => output.show()),
    vscode.commands.registerCommand("grok.settings", () => sidebar.openSettingsEditor()),
    vscode.commands.registerCommand("grok.expandAllToolDetails", () => sidebar.setAllToolDetails(true)),
    vscode.commands.registerCommand("grok.collapseAllToolDetails", () => sidebar.setAllToolDetails(false)),
    vscode.commands.registerCommand("grok.findInSession", () => sidebar.findInSession()),
    vscode.commands.registerCommand("grok.logout", () => sidebar.logout()),
    vscode.commands.registerCommand("grok.linkRemote", () => sidebar.linkRemoteDevice()),
    vscode.commands.registerCommand("grok.unlinkRemote", () => sidebar.unlinkRemoteDevice()),
    vscode.commands.registerCommand("grok.composerForward", () => sidebar.moveComposerCaret("forward")),
    vscode.commands.registerCommand("grok.composerPreviousLine", () => sidebar.moveComposerCaret("previousLine")),
    // Internal debug helper for manually exercising the plan-review card UI
    // (Approve / Reject / Cancel flows) without a live CLI session.
    vscode.commands.registerCommand("grok._debugDummyPlan", () => sidebar.debugShowDummyPlan()),
  );

  // Not awaited: activation must not block on a workbench command, and nothing
  // below depends on where the view ended up.
  void ensureViewPlacement(context, output, firstEverRun);

  // VS Code sets ExtensionMode.Test ONLY when the extension host was launched by
  // a test runner, so an installed build can never reach this branch and the
  // seam is genuinely absent there rather than merely undocumented.
  return testHooks ? { __test: testHooks } : {};
}

export function deactivate(): void {
  // disposables handle cleanup
}
