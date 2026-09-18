import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { ALWAYS_APPROVE_NOTICE_KEY } from "../src/grok-config";
import {
  GROK_VIEW_ID,
  hostAcceptedSecondarySideBar,
  moveViewContainerFor,
  PANEL_CONTAINER_ID,
  panelPositionFor,
  PRIMARY_CONTAINER_ID,
  revealCommandFor,
  SECONDARY_CONTAINER_ID,
  isFirstEverRun,
  MOVE_VIEW_HINT_USED_KEY,
  SECONDARY_SIDE_BAR_PROBE_KEY,
  shouldShowMoveViewHint,
  VIEW_PLACEMENT_KEY,
  viewPlacementCorrection,
} from "../src/view-move";

const VIEW_FOCUS = `${GROK_VIEW_ID}.focus`;
/** What VS Code registers: all three containers plus the view's focus command. */
const VSCODE = [SECONDARY_CONTAINER_ID, PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID, VIEW_FOCUS];
/** Cursor 3.15: the secondary container is refused, so its command never exists. */
const CURSOR = [PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID, VIEW_FOCUS];

describe("the one automatic placement correction", () => {
  const correct = (availableCommands: readonly string[], isFirstEverRun: boolean) =>
    viewPlacementCorrection({ availableCommands, isFirstEverRun });

  it("leaves VS Code alone — the secondary side bar stays the intended home", () => {
    expect(correct(VSCODE, true)).toBeNull();
  });

  it("moves to the activity-bar container where the secondary one was refused", () => {
    // Cursor drops the view into Explorer and never registers our container, so
    // grok.open threw "command not found" and the chat could not be opened.
    expect(correct(CURSOR, true)).toEqual({
      containerId: PRIMARY_CONTAINER_ID,
      panelPosition: null,
    });
  });

  it("only ever fires on a FIRST-EVER run", () => {
    // The hard rule, and the reason it is phrased this way: there is no way to
    // ask where a view lives. `resetViewLocation` exists for every view in the
    // workbench whether moved or not, and the context key that separates them
    // cannot be read from an extension — so "correct it only when it is in
    // Explorer" is unimplementable. What CAN be established is that nobody has
    // chosen anything yet — see isFirstEverRun for what counts as evidence.
    expect(correct(CURSOR, false)).toBeNull();
  });

  it("never rearranges the workbench", () => {
    // Panel position is workbench-wide — it carries Terminal, Problems and
    // Output across the window. An earlier revision did that to reach a panel
    // the view was never going to appear in.
    expect(correct(CURSOR, true)?.panelPosition).toBeNull();
  });

  it("does not move into a container the host never created", () => {
    // Issuing a move at a container that was never registered is how 3.2.8's
    // attempt failed silently while recording itself as a success.
    expect(correct([VIEW_FOCUS], true)).toBeNull();
  });

  it("decides on capability, not on which editor this is", () => {
    // No appName check anywhere: a fork adopting the same restriction is handled
    // without naming it, and a Cursor release that lifts it stops triggering
    // this with no code change.
    expect(correct(VSCODE.filter((c) => c !== SECONDARY_CONTAINER_ID), true)).toEqual({
      containerId: PRIMARY_CONTAINER_ID,
      panelPosition: null,
    });
  });
});

describe("whether this install has ever been used", () => {
  it("an untouched install is a first-ever run", () => {
    expect(isFirstEverRun([])).toBe(true);
  });

  it("our OWN bookkeeping does not count as use", () => {
    // The one that mattered: the capability probe persists on every activation,
    // so a first run whose correction returned no target — or threw — found
    // globalState non-empty on the second run and skipped forever. The gate was
    // being closed by our own write rather than by anything the user did,
    // stranding exactly the fresh install this exists for.
    expect(isFirstEverRun([SECONDARY_SIDE_BAR_PROBE_KEY])).toBe(true);
    expect(isFirstEverRun([VIEW_PLACEMENT_KEY, SECONDARY_SIDE_BAR_PROBE_KEY])).toBe(true);
    // Same class: we write this ourselves the first time a session starts
    // under a global always-approve config. Counting it as use would close
    // the first-run placement gate on a machine that already had grok's TUI.
    expect(isFirstEverRun([ALWAYS_APPROVE_NOTICE_KEY])).toBe(true);
  });

  it("anything the user's use produced does count", () => {
    expect(isFirstEverRun(["grok.installId"])).toBe(false);
    expect(isFirstEverRun(["grok.repoPins", SECONDARY_SIDE_BAR_PROBE_KEY])).toBe(false);
    // Including the picker flag: opening the move picker is plainly use.
    expect(isFirstEverRun([MOVE_VIEW_HINT_USED_KEY])).toBe(false);
  });
});

describe("the empty-state move hint", () => {
  const hint = (o: Partial<Parameters<typeof shouldShowMoveViewHint>[0]>) =>
    shouldShowMoveViewHint({
      hostAcceptedSecondarySideBar: false,
      canRelocateView: true,
      pickerAlreadyUsed: false,
      ...o,
    });

  it("shows only where the editor refused our secondary-side-bar container", () => {
    // The one case where the dock a user probably wants is reachable by the
    // editor and not by us, so saying so is the only thing left to do.
    expect(hint({})).toBe(true);
    expect(hint({ hostAcceptedSecondarySideBar: true })).toBe(false);
  });

  it("retires itself once the picker has been opened", () => {
    // Advice acted on is advice spent — and "opened", not "completed", because
    // finding the control is the whole point and a cancel still found it.
    expect(hint({ pickerAlreadyUsed: true })).toBe(false);
  });

  it("stays hidden where there is nothing to move a view between", () => {
    expect(hint({ canRelocateView: false })).toBe(false);
  });
});

describe("both routes to the host picker retire the hint BEFORE moving", () => {
  // Ordering, not behaviour, so it is asserted against the source — the same
  // technique webview-reload-policy.test.ts uses for capability declarations.
  // No DOM or extension-host test can reach it: the picker is modal, and what
  // goes wrong is a race with the webview teardown that a move causes.
  //
  // Writing afterwards means the rebuilt webview asks for capabilities before
  // the flag lands, reads the old value, and shows the hint the user just acted
  // on. It was fixed in the gear path and left in the palette one; this is here
  // so the pair cannot drift apart again.
  const root = path.resolve(__dirname, "..");

  const before = (src: string, a: string, b: string) => {
    const ia = src.indexOf(a);
    const ib = src.indexOf(b);
    expect(ia, `missing: ${a}`).toBeGreaterThan(-1);
    expect(ib, `missing: ${b}`).toBeGreaterThan(-1);
    return ia < ib;
  };

  it("the palette command retires the hint, then opens the picker", () => {
    const src = readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    expect(
      before(src, "sidebar.retireMoveViewHint()", "workbench.action.moveFocusedView"),
    ).toBe(true);
  });

  it("the gear handler retires the hint, then relocates", () => {
    const src = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(before(src, "this.retireMoveViewHint()", "this.host.relocateView(")).toBe(true);
  });

  it("the startup correction checks for a user move before applying one", () => {
    // `activate` starts the correction without awaiting it, so the palette
    // command can run during its probe. Re-reading the flag right before the
    // move is what stops a correction landing on top of a choice just made.
    const src = readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    expect(before(src, "MOVE_VIEW_HINT_USED_KEY) === true", "await applyPlacement(")).toBe(true);
  });

  it("retiring persists AND tells the live webview, in that order", () => {
    // Two things, because one is not enough: persist for future windows, post
    // for this one. A webview holding a stale flag rebuilds the hint on the next
    // session swap, and cancelling the picker causes no rebuild that would
    // refresh it.
    const src = readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(before(src, "MOVE_VIEW_HINT_USED_KEY, true", '{ type: "moveViewHint", value: false }')).toBe(
      true,
    );
  });
});

describe("what grok.open executes", () => {
  it("focuses the view itself, which works wherever the view lives", () => {
    // Previously hardcoded the secondary container — exactly the command that
    // does not exist in Cursor, which is what users saw fail.
    expect(revealCommandFor(VSCODE)).toBe(VIEW_FOCUS);
    expect(revealCommandFor(CURSOR)).toBe(VIEW_FOCUS);
  });

  it("falls back to a container that exists when the view focus does not", () => {
    expect(revealCommandFor([PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID])).toBe(PRIMARY_CONTAINER_ID);
    expect(revealCommandFor([PANEL_CONTAINER_ID])).toBe(PANEL_CONTAINER_ID);
  });

  it("never returns the secondary container just because it is the default", () => {
    // The regression in one line: choosing a command by convention rather than
    // by whether the host registered it.
    expect(revealCommandFor(CURSOR)).not.toBe(SECONDARY_CONTAINER_ID);
  });
});

describe("what the gear may offer", () => {
  it("reports the secondary side bar available only when the host registered it", () => {
    expect(hostAcceptedSecondarySideBar(VSCODE)).toBe(true);
    expect(hostAcceptedSecondarySideBar(CURSOR)).toBe(false);
  });

  it("agrees with the correction — one predicate, not two", () => {
    // These decide the same thing from opposite ends: whether the menu shows
    // `Move view…` at all, and whether activation repositions the view. Drifting
    // apart would show the item in an editor that never needed it.
    for (const cmds of [VSCODE, CURSOR]) {
      const offersSecondary = hostAcceptedSecondarySideBar(cmds);
      const needsCorrection =
        viewPlacementCorrection({ availableCommands: cmds, isFirstEverRun: true }) !== null;
      expect(offersSecondary).toBe(!needsCorrection);
    }
  });
});

describe("gear-menu Move view destinations", () => {
  it("maps each destination to its extension-owned container", () => {
    expect(moveViewContainerFor("panel")).toBe(PANEL_CONTAINER_ID);
    expect(moveViewContainerFor("sidebar")).toBe(PRIMARY_CONTAINER_ID);
    expect(moveViewContainerFor("auxiliarybar")).toBe(SECONDARY_CONTAINER_ID);
  });

  it("routes both edge-explicit destinations to the panel container", () => {
    expect(moveViewContainerFor("panel-right")).toBe(PANEL_CONTAINER_ID);
    expect(moveViewContainerFor("panel-bottom")).toBe(PANEL_CONTAINER_ID);
  });

  it("docks the panel only for the destinations whose label promises an edge", () => {
    expect(panelPositionFor("panel-right")).toBe("right");
    expect(panelPositionFor("panel-bottom")).toBe("bottom");
  });

  it("leaves the layout alone for plain 'panel' — including from older clients", () => {
    // Panel position is workbench-wide, so this also moves Terminal, Problems
    // and Output. A destination that never claimed an edge must not do that,
    // and every client built before the edge-explicit items sends this one.
    expect(panelPositionFor("panel")).toBeNull();
    expect(panelPositionFor("sidebar")).toBeNull();
    expect(panelPositionFor("auxiliarybar")).toBeNull();
    expect(panelPositionFor(undefined)).toBeNull();
  });

  it("returns null for anything else — callers fall back to the built-in picker", () => {
    expect(moveViewContainerFor(undefined)).toBeNull();
    expect(moveViewContainerFor("")).toBeNull();
    expect(moveViewContainerFor("editor")).toBeNull();
    expect(moveViewContainerFor(42)).toBeNull();
  });

  it("container ids carry the workbench prefix package.json contributions get", () => {
    for (const id of [PANEL_CONTAINER_ID, PRIMARY_CONTAINER_ID, SECONDARY_CONTAINER_ID]) {
      expect(id.startsWith("workbench.view.extension.")).toBe(true);
    }
  });
});
