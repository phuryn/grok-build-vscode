/**
 * Settings → Advanced → Move view, against the REAL shipped chat.js.
 *
 * The section exists for exactly one situation: an editor that refuses to create
 * our container in the secondary side bar (Cursor reserves it for its own agent
 * UI). Everywhere else it is absent, because an editor that gives us that dock
 * also offers its own "Move To" on the view's context menu — our version could
 * only name CONTAINERS, and a container cannot reach a dock the editor draws for
 * itself.
 *
 * These assert the SHAPE of the menu per host and the message the item sends.
 * The mapping from message to workbench command is covered by view-move.test.ts;
 * this is the half that decides what a user is offered.
 */
import { describe, expect, it } from "vitest";
import { openAppSettings, bootWebview, click, dispatch, type Harness } from "./webview-harness";

type Caps = Record<string, boolean>;

function boot(capabilities: Caps, opts: { remote?: boolean } = {}): Harness {
  const h = bootWebview({ ready: true, remote: opts.remote });
  dispatch(h.window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "9.9.9",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    inputNeededSound: false,
    readRepliesAloud: false,
    capabilities: { uploadFile: true, remoteVoice: true, ...capabilities },
  });
  return h;
}

/** Open Settings → Advanced, where Move view lives. */
function openMoveView(h: Harness): void {
  openAppSettings(h.window, h.doc);
  const advanced = [...h.doc.querySelectorAll("#settings-overlay .settings-nav-item")]
    .find((el) => (el.textContent || "").trim() === "Advanced");
  if (advanced) click(h.window, advanced);
}

function items(h: Harness): HTMLElement[] {
  return [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")] as HTMLElement[];
}

function text(el: Element): string {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

/** Whether the Move view section rendered at all — the section heading, not just
 *  its items, so removing the heading and leaving a stray item still fails. */
function hasMoveViewSection(h: Harness): boolean {
  const overlay = h.doc.getElementById("settings-overlay");
  if (overlay) return !!overlay.querySelector('[data-id="moveView"]');
  return (h.doc.getElementById("gear-popover")!.textContent || "").includes("Move view");
}

/** Which ICON each destination carries, by the distinguishing path in the SVG.
 *  `M15 3v18` is the right-hand divider, `M9 3v18` the left, `M3 15h18` the
 *  bottom — the same three glyphs VS Code uses for its own layout controls. */
function iconEdge(h: Harness, label: string): "right" | "left" | "bottom" | "none" {
  const el = items(h).find((e) => text(e) === label);
  const svg = el?.innerHTML || "";
  if (svg.includes("M15 3v18")) return "right";
  if (svg.includes("M9 3v18")) return "left";
  if (svg.includes("M3 15h18")) return "bottom";
  return "none";
}

describe("Move view menu (DOM)", () => {
  it("shows NOTHING where the editor has a secondary side bar", () => {
    // The section is gone in VS Code. It existed to work around Cursor hiding
    // the built-in "Move To" from a view's context menu — but an editor that
    // gives us the secondary side bar also has that menu, so we were
    // duplicating a control it already provides, in a worse form: our items
    // named CONTAINERS, and a container cannot reach a dock the editor draws
    // for itself.
    const h = boot({ relocateView: true, secondarySideBar: true });
    openMoveView(h);
    expect(hasMoveViewSection(h)).toBe(false);
  });

  it("shows nothing for a host that never sent the flag either", () => {
    // Absent means the editor has one — every build before Cursor refused the
    // container omits this, and none of them needed the section.
    const h = boot({ relocateView: true });
    openMoveView(h);
    expect(hasMoveViewSection(h)).toBe(false);
  });

  it("offers ONE item, the host's own picker, where the secondary side bar was refused", () => {
    // Instrumented Cursor: it keeps our other containers but ignores where they
    // declared they live, so every destination we can name lands in the primary
    // side bar. Three labels for one outcome, two of them untrue.
    const h = boot({ relocateView: true, secondarySideBar: false });
    openMoveView(h);
    const row = h.doc.querySelector('[data-id="moveView"] .settings-action');
    expect(row?.textContent).toBe("Move view…");
    expect(h.doc.querySelectorAll('[data-id="moveView"]').length).toBe(1);
  });

  it("sends the un-mappable destination, which is what reaches the host picker", () => {
    // `pick` maps to no container by design — the host falls through to its own
    // picker, which targets a LOCATION and can therefore reach docks no
    // container id of ours can address.
    const h = boot({ relocateView: true, secondarySideBar: false });
    openMoveView(h);
    const el = h.doc.querySelector('[data-id="moveView"] .settings-action') as HTMLElement;
    click(h.window, el);
    expect(h.posted.filter((m) => m.type === "moveView")).toEqual([
      { type: "moveView", location: "pick" },
    ]);
  });

  it("keeps the Move view action reachable from Settings → Advanced", () => {
    const h = boot({ relocateView: true, secondarySideBar: false });
    openMoveView(h);
    expect(h.doc.querySelector('[data-id="moveView"]')?.textContent).toContain("Move view");
  });

  it("hides the section on a host with no view containers", () => {
    // Desktop: relocateView false. Even with the secondary side bar reported
    // missing, there is nothing to move a view between.
    const h = boot({ relocateView: false, secondarySideBar: false, showOutput: false });
    openMoveView(h);
    expect(hasMoveViewSection(h)).toBe(false);
  });

  it("shows the empty-state hint when the host advertises it, and not otherwise", () => {
    const shown = boot({ relocateView: true, secondarySideBar: false, moveViewHint: true });
    const tip = shown.doc.getElementById("welcome-tip");
    expect(tip).toBeTruthy();
    const text_ = (tip!.textContent || "").replace(/\s+/g, " ");
    expect(text_).toContain("To move AFK Pilot to the right");
    // Two steps: the second cannot be automated — the host's picker command does
    // not wait for the pick, so revealing afterwards dismisses it instead.
    expect(text_).toContain("New Secondary Side Bar Entry");
    expect(text_).toContain("Toggle Agents Side Bar");
    // The follow-up step must come BEFORE the action, because acting on the link
    // dismisses the tip — anything below it is read only by someone who has
    // already lost the chance to act on it.
    expect(text_.indexOf("Toggle Agents Side Bar")).toBeLessThan(text_.indexOf("Click here"));
    // Not an anchor: an <a href="#"> makes the webview attempt a navigation, and
    // the editor answers by trying to open a file that does not exist.
    const link = tip!.querySelector("#welcome-tip-link")!;
    expect(link.tagName.toLowerCase()).not.toBe("a");
    expect(link.getAttribute("role")).toBe("button");
    expect(link.getAttribute("tabindex")).toBe("0");
    // Opt-in: the host decides, and absent means no hint.
    const hidden = boot({ relocateView: true, secondarySideBar: false });
    expect(hidden.doc.getElementById("welcome-tip")).toBeNull();
  });

  it("the hint's link sends the same message the gear does", () => {
    // This is what makes clicking the hint retire the hint: it lands in the same
    // host handler, which records that the picker has been opened. A link that
    // posted anything else would leave the tip coming back forever.
    const h = boot({ relocateView: true, secondarySideBar: false, moveViewHint: true });
    click(h.window, h.doc.getElementById("welcome-tip-link")!);
    expect(h.posted.filter((m) => m.type === "moveView")).toEqual([
      { type: "moveView", location: "pick" },
    ]);
    // And it goes immediately, rather than waiting for the next session.
    expect(h.doc.getElementById("welcome-tip")).toBeNull();
  });

  it("does not bring the hint back on the next session", () => {
    // `initialState` is not re-sent on a session swap, so the empty state is
    // rebuilt from capabilities the webview already holds. Removing only the
    // node left a still-true flag behind, and the hint returned on the next
    // new session — advice the user had already acted on.
    const h = boot({ relocateView: true, secondarySideBar: false, moveViewHint: true });
    click(h.window, h.doc.getElementById("welcome-tip-link")!);
    dispatch(h.window, { type: "clearMessages" });
    expect(h.doc.getElementById("welcome-tip")).toBeNull();
  });

  it("drops the hint when the host retires it live", () => {
    // The gear and palette routes open the same picker without the link's local
    // cleanup, and cancelling one rebuilds nothing — so the host says so
    // explicitly rather than relying on a webview restart to refresh the flag.
    const h = boot({ relocateView: true, secondarySideBar: false, moveViewHint: true });
    expect(h.doc.getElementById("welcome-tip")).toBeTruthy();
    dispatch(h.window, { type: "moveViewHint", value: false });
    expect(h.doc.getElementById("welcome-tip")).toBeNull();
    // And it stays gone across a session swap, which rebuilds the empty state.
    dispatch(h.window, { type: "clearMessages" });
    expect(h.doc.getElementById("welcome-tip")).toBeNull();
  });

  it("never shows the hint in the browser client", () => {
    // The capability is mirrored to remotes with the rest of initialState, but
    // `moveView` is host-local and the relay drops it — so a phone would be
    // given advice it cannot take. Same guard the Move view section gets.
    const h = boot(
      { relocateView: true, secondarySideBar: false, moveViewHint: true },
      { remote: true },
    );
    expect(h.doc.getElementById("welcome-tip")).toBeNull();
  });

  it("hides the section in the browser client — moveView is host-local", () => {
    // The relay drops the message, so the control could never do anything from a
    // phone. Capabilities set to the one host that WOULD show it, so this fails
    // if the remote guard is removed rather than passing for the wrong reason.
    const h = boot({ relocateView: true, secondarySideBar: false }, { remote: true });
    openMoveView(h);
    expect(hasMoveViewSection(h)).toBe(false);
  });
});
