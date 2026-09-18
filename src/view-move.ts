// View placement. The view is default-homed in the SECONDARY side bar
// (`viewsContainers.secondarySidebar`, VS Code >= 1.106 — hence the engines
// floor), with one extension-owned container contributed per dock location.
//
// Two mechanisms, and the difference between them is the whole of this file:
//
//   - `vscode.moveViews` names a CONTAINER. It is what the automatic first-run
//     correction uses. Its limit is that a host may accept our container and
//     ignore where it declared it lives — Cursor renders the panel one in the
//     primary side bar — so it can relocate the view but cannot choose the dock.
//   - `workbench.action.moveFocusedView` names a LOCATION, via the host's own
//     picker, and so reaches docks no container id of ours can address. It is
//     the only thing the gear offers where our secondary-side-bar container was
//     refused. The view-id argument is what makes it work there at all: Cursor
//     never sets the `focusedView` context key for webview views.
//
// That command does NOT wait for the pick — it resolves as the quickpick opens
// — so nothing may be issued after it. A reveal tried there stole focus and
// dismissed the picker.

import { ALWAYS_APPROVE_NOTICE_KEY } from "./grok-config";

export const GROK_VIEW_ID = "grok.chat";

/** Projects rail — its own activity-bar container (`grokProjects`). Separate from
 *  the chat view so opening it never creates a second chat client. */
export const GROK_PROJECTS_VIEW_ID = "grok.projects";

/** The chat view. Mirrors `GrokSidebar.viewId`; VS Code derives a
 *  `<id>.focus` command from every contributed view, which is how opening a
 *  conversation from the rail brings the chat forward. */
export const GROK_CHAT_VIEW_ID = "grok.chat";

/** Contributed containers, one per dock location (package.json prefixes each id
 *  with `workbench.view.extension.`). `grokSidebar` homes the chat view;
 *  `grokPrimary` and `grokPanel` are empty by default and exist only as
 *  `vscode.moveViews` targets for chat; `grokProjects` homes the rail. */
export const SECONDARY_CONTAINER_ID = "workbench.view.extension.grokSidebar";
export const PRIMARY_CONTAINER_ID = "workbench.view.extension.grokPrimary";
export const PANEL_CONTAINER_ID = "workbench.view.extension.grokPanel";

/**
 * The rail's own container — deliberately NOT `grokPrimary`.
 *
 * The rail first shipped inside `grokPrimary`, and that container is also the
 * destination the gear's "Sidebar" entry moves the CHAT view to
 * ({@link moveViewContainerFor}). One container serving both roles means the two
 * views are welded together: move chat to the sidebar and the rail comes with
 * it, and drag that container anywhere and the rail goes there too. The owner
 * hit exactly this — the rail arrived docked beside the chat and had to be
 * dragged out by hand.
 *
 * A container of its own also gets the rail a fresh default placement on
 * upgrade, which is what un-sticks anyone already living with the welded
 * layout: VS Code has no remembered location for an id it has not seen.
 */
export const PROJECTS_CONTAINER_ID = "workbench.view.extension.grokProjects";

/** Which edge the panel must be docked on for a destination to mean what its
 *  menu label says. */
export type PanelPosition = "right" | "bottom";

/** Resolve a gear-menu destination to the container `vscode.moveViews` should
 *  target, or null for an unknown location (callers fall back to the built-in
 *  destination picker preselected on the Grok view). */
export function moveViewContainerFor(location: unknown): string | null {
  if (location === "panel" || location === "panel-right" || location === "panel-bottom") {
    return PANEL_CONTAINER_ID;
  }
  if (location === "sidebar") return PRIMARY_CONTAINER_ID;
  if (location === "auxiliarybar") return SECONDARY_CONTAINER_ID;
  return null;
}

/**
 * The panel edge a destination demands, or null to leave the workbench layout
 * alone.
 *
 * Only the two edge-explicit destinations move the panel. They exist for hosts
 * that refuse an extension container in the secondary side bar (Cursor reserves
 * it for its own agent UI): there, "To Right Panel" is the closest thing to
 * "To Secondary Side Bar" the host will actually accept, and it is only the
 * closest thing if the panel is docked right — otherwise the chat lands in a
 * short strip along the bottom, which is not what the label promised.
 *
 * Plain `"panel"` — what the menu sends where the secondary side bar exists,
 * and what every extension built before this change sends — stays null on
 * purpose. Panel position is workbench-wide, so moving it drags Terminal,
 * Problems and Output along; a menu item that never claimed an edge must not
 * rearrange the workbench behind the user's back.
 */
export function panelPositionFor(location: unknown): PanelPosition | null {
  if (location === "panel-right") return "right";
  if (location === "panel-bottom") return "bottom";
  return null;
}

/**
 * Whether the host actually created our secondary-side-bar container.
 *
 * The same probe {@link viewPlacementCorrection} runs, published to the webview so
 * the gear can offer destinations that exist. Capability, never `env.appName`.
 */
export function hostAcceptedSecondarySideBar(availableCommands: readonly string[]): boolean {
  return availableCommands.includes(SECONDARY_CONTAINER_ID);
}

/** Diagnostics only — which release performed the one correction. Writing it is
 *  also what makes `globalState` non-empty afterwards, which is the gate below. */
export interface PlacementRecord {
  correctedByVersion?: string;
}

export const VIEW_PLACEMENT_KEY = "grok.viewPlacement";

/**
 * Set once the user has opened the host's move-view picker from anywhere.
 *
 * Retires the empty-state hint, and is the only in-process evidence that the
 * user has taken placement into their own hands — so the startup correction
 * checks it before acting. It may ABORT our move; it may never redirect one.
 * Anything more would make it a guess about a placement we cannot see.
 */
export const MOVE_VIEW_HINT_USED_KEY = "grok.moveViewPickerUsed";

/** Where `createVsCodeHost` caches its capability probe. Named here because the
 *  first-run test below has to know about it. */
export const SECONDARY_SIDE_BAR_PROBE_KEY = "grok.hostAcceptedSecondarySideBar";

/**
 * Whether this install has never been used — the gate for the one automatic
 * placement correction.
 *
 * Keys the extension writes ON ITS OWN INITIATIVE do not count. That is the
 * whole subtlety: the capability probe persists on every activation, so a first
 * run whose correction returned no target, or threw, would find `globalState`
 * non-empty on the second run and skip forever — a gate closed by our own
 * bookkeeping rather than by anything the user did, stranding exactly the fresh
 * install this exists for. The always-approve notice key is the same class:
 * we write it the first time a session starts under a global config setting.
 *
 * Everything else counts, including the picker flag: a user who has opened the
 * move picker has plainly used the extension.
 */
export function isFirstEverRun(storedKeys: readonly string[]): boolean {
  const selfWritten: readonly string[] = [
    SECONDARY_SIDE_BAR_PROBE_KEY,
    VIEW_PLACEMENT_KEY,
    ALWAYS_APPROVE_NOTICE_KEY,
  ];
  return storedKeys.every((k) => selfWritten.includes(k));
}

/**
 * Whether to show the empty-state hint pointing at the host's own picker.
 *
 * Only where our secondary-side-bar container was refused: that is the one case
 * where the dock the user probably wants is reachable by the host and not by us,
 * so telling them is the only thing left to do. Retired as soon as they open
 * that picker — advice acted on is advice spent.
 */
export function shouldShowMoveViewHint(opts: {
  hostAcceptedSecondarySideBar: boolean;
  canRelocateView: boolean;
  pickerAlreadyUsed: boolean;
}): boolean {
  if (!opts.canRelocateView) return false;
  if (opts.hostAcceptedSecondarySideBar) return false;
  return !opts.pickerAlreadyUsed;
}

/** Location value that means "hand off to the host's own destination picker"
 *  — deliberately mapped to no container. */
export const PICK_LOCATION = "pick";

/** Record that the correction has happened, for diagnostics. */
export function withAttempt(
  prev: PlacementRecord | undefined,
  extensionVersion: string,
): PlacementRecord {
  return { ...(prev ?? {}), correctedByVersion: extensionVersion };
}

/**
 * Where to move the view, or null to leave it where it is.
 *
 * The manifest homes the view in the secondary side bar. Cursor 3.15 refuses to
 * create that container — *"View containers cannot be contributed to the
 * Secondary Side Bar in Cursor. It is reserved for Cursor's agent UI"* — so the
 * view is dropped into Explorer, `workbench.view.extension.grokSidebar` never
 * registers, and `grok.open` fails with "command not found". The extension
 * cannot be opened at all there.
 *
 * The manifest is static and cannot branch per editor, so the correction has to
 * happen at runtime, using the same `vscode.moveViews` call the gear menu
 * already ships.
 *
 * Decided by CAPABILITY, never by `env.appName`: any fork adopting the same
 * restriction is handled without naming it, and a Cursor build that lifts the
 * restriction stops triggering this with no change here. Same reasoning as the
 * relay's rule — gate on the thing being present, not on a version or a brand.
 *
 * **Target is the PANEL, not the activity bar.** A panel docked right occupies
 * the same screen position and the same tall, narrow shape the chat was designed
 * for; the primary side bar puts it opposite the editor and competes with the
 * file tree for the space users already keep open. The caller pairs this with
 * `workbench.action.positionPanelRight` so the result is a secondary side bar in
 * everything but name.
 *
 * **Fires only on a FIRST-EVER run**, and that is a hard rule with nothing
 * guessed in it. There is no way to ask where a view lives — `resetViewLocation`
 * exists for every view in the workbench, moved or not, and the context key that
 * distinguishes them is unreadable from an extension. So "correct it only when
 * it is in Explorer", which is the rule anyone would want, cannot be written.
 *
 * What CAN be established is that the user has not placed it: an install with no
 * stored state has never been interacted with, so wherever the view sits, nobody
 * chose it. That is provable rather than inferred. Every later run leaves the
 * layout alone — including for someone who moved the chat with the editor's own
 * Move To, which leaves no trace we could have read.
 *
 * The cost, stated plainly: a user already on a broken placement is not
 * rescued by an update. They get a chat that opens (`grok.open` no longer
 * throws — the actual outage) and one trip through `Move view…`.
 */
export function viewPlacementCorrection(opts: {
  availableCommands: readonly string[];
  /** No stored state at all — nothing on this machine has been chosen yet. */
  isFirstEverRun: boolean;
}): { containerId: string; panelPosition: PanelPosition | null } | null {
  if (!opts.isFirstEverRun) return null;
  if (hostAcceptedSecondarySideBar(opts.availableCommands)) return null;

  // The ACTIVITY-BAR container, and the panel is NOT repositioned.
  //
  // Settled by instrumenting a real Cursor rather than by inference, after two
  // wrong theories:
  //
  //   containers: secondary=false primary=true panel=true  app=Cursor
  //   moving -> workbench.view.extension.grokPanel, panel right
  //   moved
  //
  // The move always succeeded. Cursor registers our panel container and then
  // renders it in the PRIMARY SIDE BAR — it honours the contribution but not its
  // declared location. So `grokPanel` and `grokPrimary` land in the same place
  // there, and aiming at the panel bought nothing while
  // `workbench.action.positionPanelRight` moved the user's Terminal, Problems
  // and Output across the window to achieve it. Same result, no collateral.
  //
  // Reaching that host's real panel or secondary side bar needs a LOCATION,
  // which no container id can name; its own Move To is the only route, and it
  // is a picker. The correction therefore aims at "somewhere ordinary and
  // reachable", not at a side of the screen.
  // Nothing to move it INTO. Cursor refuses only the secondary-side-bar
  // container, so this should not happen — but issuing a move at a container
  // that was never registered is how 3.2.8's attempt failed silently while
  // recording itself as a success, and a move that cannot land must not be
  // reported as one that did.
  if (!opts.availableCommands.includes(PRIMARY_CONTAINER_ID)) return null;
  // Never repositions the panel: that is workbench-wide and would carry
  // Terminal, Problems and Output along with it.
  return { containerId: PRIMARY_CONTAINER_ID, panelPosition: null };
}

/**
 * The command `grok.open` should execute to reveal the chat.
 *
 * It used to hardcode the secondary container, which is precisely what threw
 * when that container did not exist. The view's own auto-generated
 * `<viewId>.focus` is better in every case: it exists wherever the view is
 * registered and reveals it in place — including when the host has dropped it
 * into Explorer, which is the state a Cursor user is in before the relocation
 * lands.
 */
export function revealCommandFor(availableCommands: readonly string[]): string {
  const viewFocus = `${GROK_VIEW_ID}.focus`;
  if (availableCommands.includes(viewFocus)) return viewFocus;
  for (const id of [SECONDARY_CONTAINER_ID, PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID]) {
    if (availableCommands.includes(id)) return id;
  }
  // Nothing of ours registered. Returning the view focus is the likeliest to
  // exist of the options and keeps the failure to one command rather than none.
  return viewFocus;
}
