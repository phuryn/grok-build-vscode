/**
 * Empty-state advice, in the real webview.
 *
 * The pure half is covered in welcome-tips.test.ts. What only a DOM run can
 * show is that the slot is SHARED — with the move-view hint, with the status
 * line's busy state and with the onboarding card — and that the actionable span
 * reaches the destination it names. happy-dom has no layout, so this suite
 * proves wiring; the screenshot gate in scripts/desk-screens-check.mjs proves
 * the line actually fits on screen.
 *
 * Every test drives the real status cycle rather than poking the DOM: the host
 * posts `initialized` (welcome goes "Starting", busy) and then `setBusy:false`
 * (welcome goes "Connected", idle), which is the exact moment the advice slot
 * becomes available. That cycle repeats per session, which is what gives the
 * rotation somewhere to happen.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const INITIAL_STATE = {
  type: "initialState",
  effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.17.2",
  showThinking: false, expandCommandOutputs: false, steerByDefault: false,
  soundNotifications: false, processingSound: false, readRepliesAloud: false,
};

type TipFacts = Partial<{
  routineCount: number;
  connectorCount: number;
  dismissed: string[];
  shownToday: string[];
}>;

/** The host frame carrying the two counts and the retired list. */
function tips(h: Harness, over: TipFacts = {}) {
  dispatch(h.window, {
    type: "welcomeTips", routineCount: 0, connectorCount: 0, dismissed: [], shownToday: [], ...over,
  });
}

/** Take the welcome from "Starting" to "Connected" the way the host does. */
function connect(h: Harness) {
  dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.0.5" } });
  dispatch(h.window, { type: "setBusy", value: false });
}

/** A settled empty screen: agents known, device answered, counts delivered. */
function settle(h: Harness, over: TipFacts & { providers?: unknown[]; linked?: boolean } = {}) {
  dispatch(h.window, {
    type: "providerState",
    providers: over.providers ?? [{ id: "grok", connected: true }],
  });
  dispatch(h.window, { type: "remoteStatus", linked: over.linked ?? false });
  tips(h, over);
  connect(h);
}

const tipEl = (h: Harness) => h.doc.getElementById("welcome-tip");
const tipId = (h: Harness) => tipEl(h)?.getAttribute("data-tip") ?? null;
const tipText = (h: Harness) => (tipEl(h)?.textContent || "").replace(/\s+/g, " ").trim();
const action = (h: Harness) => h.doc.querySelector("#welcome-tip .muted-link") as HTMLElement | null;
const dismiss = (h: Harness) =>
  h.doc.querySelector("#welcome-tip .welcome-tip-dismiss") as HTMLElement | null;

/** Walk the whole pool by dismissing, and report what was offered. */
function offeredTips(h: Harness, limit = 14): string[] {
  const seen: string[] = [];
  for (let i = 0; i < limit; i++) {
    const id = tipId(h);
    if (!id) break;
    seen.push(id);
    click(h.window, dismiss(h)!);
  }
  return seen;
}

describe("empty-state advice", () => {
  it("shows one tip once the screen has settled", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    expect(tipEl(h)).toBeTruthy();
    expect(tipText(h)).toContain("Grok isn");
    expect(action(h)?.textContent).toBe("Connect Codex or Claude Code");
  });

  it("stays silent while the status line is busy", () => {
    // A tip under a spinner competes with the one line the reader is waiting for.
    const h = bootWebview({ ready: false });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    dispatch(h.window, { type: "remoteStatus", linked: false });
    tips(h);
    dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.0.5" } });
    expect(h.doc.getElementById("welcome-version")!.classList.contains("welcome-status-busy")).toBe(true);
    expect(tipEl(h)).toBeNull();
    // …and appears the moment the wait ends.
    dispatch(h.window, { type: "setBusy", value: false });
    expect(tipEl(h)).toBeTruthy();
  });

  it("stays silent while an onboarding card owns the empty state", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    expect(tipEl(h)).toBeTruthy();
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "win32" });
    expect(h.doc.getElementById("welcome-onboarding")!.childNodes.length).toBeGreaterThan(0);
    tips(h);
    expect(tipEl(h)).toBeNull();
  });

  it("never flashes over an onboarding card that is still being built", () => {
    // showOnboarding sets the mode, reveals the welcome — which stamps the
    // status line, which re-renders this slot — and only THEN writes the card's
    // HTML. Checking the node alone left a gap where a tip rendered over an
    // empty state about to have a call to action in it, and spent its
    // once-a-day turn doing so. A remote no-project card caught it: that card
    // has no buttons, and the tip posted a frame from a screen that should have
    // been silent.
    const h = bootWebview({ ready: false, remote: true });
    settle(h);
    expect(tipEl(h)).toBeTruthy();
    h.posted.length = 0;
    dispatch(h.window, { type: "onboarding", state: "no-project" });
    expect(tipEl(h)).toBeNull();
    expect(h.posted).toEqual([]);
  });

  it("yields the slot to the move-view hint while the host still offers it", () => {
    const h = bootWebview({ ready: false, vscode: true });
    dispatch(h.window, {
      ...INITIAL_STATE,
      capabilities: { uploadFile: true, remoteVoice: true, moveViewHint: true },
    });
    settle(h);
    expect(tipId(h)).toBe("moveView");
    expect(tipText(h)).toContain("To move Grok to the right");
    // Retracted → the slot falls through to advice without a reload.
    dispatch(h.window, { type: "moveViewHint", value: false });
    expect(tipId(h)).toBe("providers");
  });

  it("opens the named settings category and retires the tip", () => {
    const h = bootWebview({ ready: false, vscode: true });
    // VS Code hosts the settings surface as an editor tab, so the client posts
    // rather than mounting an overlay — which is what makes the target visible
    // to this test. Desktop and remote open the same category in an overlay.
    dispatch(h.window, {
      ...INITIAL_STATE,
      capabilities: { uploadFile: true, remoteVoice: true, settingsEditor: true },
    });
    settle(h);
    expect(tipId(h)).toBe("providers");
    click(h.window, action(h)!);
    expect(h.posted).toContainEqual({ type: "openSettingsSurface", category: "providers" });
    expect(h.posted).toContainEqual({ type: "dismissWelcomeTip", id: "providers" });
    // Retired locally too, so the slot moves on this click rather than waiting
    // for the host's answering frame.
    expect(tipId(h)).not.toBe("providers");
  });

  it("routes every settings-backed tip to its own category", () => {
    const seen: Record<string, string | undefined> = {};
    for (const start of [[], ["providers"], ["providers", "routines"], ["providers", "routines", "connectors"]]) {
      const h = bootWebview({ ready: false, vscode: true });
      dispatch(h.window, {
        ...INITIAL_STATE,
        capabilities: { uploadFile: true, remoteVoice: true, settingsEditor: true },
      });
      settle(h, { dismissed: start });
      const id = tipId(h)!;
      click(h.window, action(h)!);
      seen[id] = h.posted.find((m) => m.type === "openSettingsSurface")?.category as string;
    }
    expect(seen).toEqual({
      providers: "providers",
      routines: "routines",
      connectors: "connectors",
      remote: "account",
    });
  });

  it("closes for TODAY, not for ever", () => {
    // The owner's rule, and the one the first version got wrong: X means "not
    // today". Tips already record themselves as shown when they render, so
    // closing one only has to release the pin that keeps it on screen — it must
    // never write a permanent retirement.
    const h = bootWebview({ ready: false });
    settle(h);
    const first = tipId(h)!;
    expect(dismiss(h)!.title).toBe("Not today");
    click(h.window, dismiss(h)!);
    expect(tipId(h)).not.toBe(first);
    expect(h.posted).toContainEqual({ type: "welcomeTipShown", id: first });
    expect(h.posted.some((m) => m.type === "dismissWelcomeTip")).toBe(false);
    expect(h.posted.some((m) => m.type === "openSettingsSurface")).toBe(false);
  });

  it("still retires a tip for good when its link is TAKEN", () => {
    // Acting on advice is different from closing it: you have been where it
    // pointed, so it does not come back tomorrow either.
    const h = bootWebview({ ready: false, vscode: true });
    dispatch(h.window, {
      ...INITIAL_STATE,
      capabilities: { uploadFile: true, remoteVoice: true, settingsEditor: true },
    });
    settle(h);
    const first = tipId(h)!;
    click(h.window, action(h)!);
    expect(h.posted).toContainEqual({ type: "dismissWelcomeTip", id: first });
  });

  it("empties the slot when every tip is retired", () => {
    const h = bootWebview({ ready: false });
    settle(h, {
      routineCount: 4,
      connectorCount: 2,
      linked: true,
      dismissed: ["providers", "readAloud", "voice", "mentions", "dragShift", "pasteScreenshot"],
    });
    expect(tipEl(h)).toBeNull();
  });

  it("suppresses the count tips until the host has sent counts", () => {
    // No welcomeTips frame at all — an older host. Advice still appears, but
    // never advice that would be wrong for someone already running routines.
    const h = bootWebview({ ready: false });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    dispatch(h.window, { type: "remoteStatus", linked: false });
    connect(h);
    const offered = offeredTips(h);
    expect(offered).toContain("providers");
    expect(offered).not.toContain("routines");
    expect(offered).not.toContain("connectors");
  });

  it("drops the agents tip as soon as one of Codex or Claude is connected", () => {
    const h = bootWebview({ ready: false });
    settle(h, { providers: [{ id: "grok", connected: true }, { id: "codex", connected: true }] });
    expect(offeredTips(h)).not.toContain("providers");
  });

  it("never offers desk-only advice to a phone", () => {
    const h = bootWebview({ ready: false, remote: true });
    settle(h);
    const offered = offeredTips(h);
    for (const deskOnly of ["providers", "connectors", "remote", "worktrees", "moveView"]) {
      expect(offered, deskOnly).not.toContain(deskOnly);
    }
    // `voiceConfigured` starts optimistically true and only the host says
    // otherwise, so a phone whose desk has a voice key is not told to set one up.
    // pasteScreenshot is NOT desk-only and correctly survives: it is gated on the
    // pointer, and this harness is a browser with no coarse pointer — which is
    // a laptop on the relay, where pasting a screenshot works exactly as it
    // does on the desk. A real phone loses it on the same fact.
    expect(offered).toEqual(["routines", "readAloud", "mentions", "pasteScreenshot"]);
  });

  it("offers voice setup only once the host says voice is unconfigured", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    expect(offeredTips(h)).not.toContain("voice");
    const fresh = bootWebview({ ready: false });
    dispatch(fresh.window, { type: "voiceConfigured", value: false });
    settle(fresh);
    expect(offeredTips(fresh)).toContain("voice");
  });

  it("puts an @ in the composer and opens the mention popover", () => {
    const h = bootWebview({ ready: false });
    settle(h, {
      dismissed: ["providers", "routines", "connectors", "remote", "readAloud", "voice"],
    });
    expect(tipId(h)).toBe("mentions");
    click(h.window, action(h)!);
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    expect(input.value).toBe("@");
    // The OUTCOME, not the mechanism. An earlier version of this test asserted
    // only the input value and passed while the popover never opened at all:
    // the click bubbled to a document handler that closes every popover, so the
    // affordance was built and hidden again in the same tick. Asking the host
    // for matches is what proves the flow actually started.
    expect(h.posted.some((m) => m.type === "mentionQuery")).toBe(true);
    //  is a string[] on the wire, and the client only renders rows whose
    // query still matches the token under the caret — so echo back the query it
    // actually asked with rather than assuming one.
    const asked = h.posted.find((m) => m.type === "mentionQuery") as { query: string };
    dispatch(h.window, {
      type: "mentionResults",
      query: asked.query,
      files: ["README.md", "src/app.ts"],
    });
    expect(h.doc.getElementById("mention-popover")!.hidden).toBe(false);
    expect(h.posted).toContainEqual({ type: "dismissWelcomeTip", id: "mentions" });
  });

  it("does not let a tip click reach the document popover closers", () => {
    // The bug this pins cost the Plan tip its entire reason to exist: several
    // document handlers close every popover on any outside click, they run
    // after this one, and a target that opens a popover therefore opened and
    // closed it in the same tick.
    const h = bootWebview({ ready: false });
    settle(h);
    let reachedDocument = false;
    h.doc.addEventListener("click", () => { reachedDocument = true; });
    click(h.window, action(h)!);
    expect(reachedDocument).toBe(false);
  });

  it("records a tip as shown, once, and stops offering it that day", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    const first = tipId(h)!;
    expect(h.posted).toContainEqual({ type: "welcomeTipShown", id: first });
    // Once. A repaint must not rewrite the file all afternoon.
    tips(h);
    tips(h);
    expect(h.posted.filter((m) => m.type === "welcomeTipShown" && m.id === first)).toHaveLength(1);
    // A new empty screen moves on rather than repeating it.
    dispatch(h.window, { type: "clearMessages" });
    connect(h);
    expect(tipId(h)).not.toBe(first);
  });

  it("keeps the tip on screen when the host echoes it back as shown", () => {
    // It joined that list the moment it rendered. Without the exemption the
    // host's answering frame would blank the line the reader is halfway
    // through.
    const h = bootWebview({ ready: false });
    settle(h);
    const first = tipId(h)!;
    tips(h, { shownToday: [first] });
    expect(tipId(h)).toBe(first);
  });

  it("dismisses even when the host has never sent a frame", () => {
    // The X used to write only into the host's list, so with no frame it had
    // nowhere to record anything: the next render recomputed the same pool and
    // put the same tip straight back. Against a host too old to answer it was
    // inert for ever — and the owner hit exactly that, on the last tip left,
    // where there was nothing else for the slot to move on to.
    const h = bootWebview({ ready: false, remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    connect(h);
    const offered: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = tipId(h);
      if (!id) break;
      offered.push(id);
      click(h.window, dismiss(h)!);
      expect(tipId(h), `X did nothing on ${id}`).not.toBe(id);
    }
    expect(offered.length).toBeGreaterThan(0);
    // …all the way to an empty slot, which is what the owner asked for: being
    // able to close the last one even when nothing replaces it.
    expect(tipEl(h)).toBeNull();
  });

  it("goes quiet once every tip has had its turn today", () => {
    const h = bootWebview({ ready: false });
    settle(h, {
      shownToday: [
        "providers", "routines", "connectors", "remote", "readAloud", "voice", "mentions",
        "dragShift", "pasteScreenshot",
      ],
    });
    expect(tipEl(h)).toBeNull();
  });

  it("starts a worktree session, and only in Coding", () => {
    const h = bootWebview({ ready: false });
    const allButWorktrees = [
      "providers", "routines", "connectors", "remote", "readAloud", "voice", "mentions",
      "dragShift", "pasteScreenshot",
    ];
    settle(h, { dismissed: allButWorktrees });
    // Knowledge work is the default — nothing left to say.
    expect(tipEl(h)).toBeNull();
    dispatch(h.window, { type: "appPurpose", value: "coding" });
    tips(h, { dismissed: allButWorktrees });
    expect(tipId(h)).toBe("worktrees");
    // The copy names what the click does. The menu path it used to describe
    // ("… > Continue in a new chat > Use a new worktree") is three steps nobody
    // remembers, which is what made the first version unactionable.
    expect(action(h)?.textContent).toBe("Start it in a worktree");
    click(h.window, action(h)!);
    expect(h.posted).toContainEqual({ type: "newWorktreeSession" });
  });

  it("renders advice with no destination as bold text, not a dead link", () => {
    // dragShift and pasteScreenshot are the first tips with `target: null`, so this
    // branch of the renderer had no coverage. An <a href="#"> here would make
    // the webview attempt a navigation and the editor answer by opening a file
    // that does not exist — the reason targeted tips are a span rather than an
    // anchor in the first place.
    const h = bootWebview({ ready: false });
    settle(h, {
      dismissed: [
        "providers", "routines", "connectors", "remote", "readAloud", "voice", "mentions",
        "dragShift",
      ],
    });
    expect(tipId(h)).toBe("pasteScreenshot");
    // No .muted-link, so nothing looks clickable.
    expect(action(h)).toBeNull();
    const bold = h.doc.querySelector("#welcome-tip b") as HTMLElement;
    expect(bold.textContent).toBe("Paste it straight into the message box.");
    expect(bold.getAttribute("role")).toBeNull();
    expect(bold.getAttribute("tabindex")).toBeNull();
    // Clicking it must not post anything, and must not retire the tip.
    const before = h.posted.length;
    click(h.window, bold);
    expect(h.posted.length).toBe(before);
    expect(tipId(h)).toBe("pasteScreenshot");
  });

  it("rotates on a new empty screen, not on a repaint", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    const first = tipId(h);
    tips(h);
    tips(h);
    expect(tipId(h)).toBe(first);
    // clearMessages is the screen genuinely becoming empty; the next session's
    // own Starting → Connected cycle then reveals the rotated line.
    dispatch(h.window, { type: "clearMessages" });
    connect(h);
    expect(tipId(h)).not.toBe(first);
  });

  it("marks the tip with a drawn icon, not an emoji", () => {
    // An emoji is whatever the reader's OS decides — a saturated yellow
    // cartoon on one platform, a flat outline on another, and never the muted
    // colour of the sentence it introduces.
    const h = bootWebview({ ready: false });
    settle(h);
    const bulb = h.doc.querySelector("#welcome-tip .welcome-tip-bulb")!;
    expect(bulb.querySelector("svg")).toBeTruthy();
    expect(bulb.textContent).toBe("");
    // Lucide's own conventions, which is what makes it consistent with every
    // other glyph: a stroked 24 viewBox in currentColor, so it takes the tip's
    // colour in both themes.
    const svg = bulb.querySelector("svg")!;
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(bulb.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives the move-view hint the same mark, since they share the slot", () => {
    const h = bootWebview({ ready: false, vscode: true });
    dispatch(h.window, {
      ...INITIAL_STATE,
      capabilities: { uploadFile: true, remoteVoice: true, moveViewHint: true },
    });
    settle(h);
    expect(tipId(h)).toBe("moveView");
    expect(h.doc.querySelector("#welcome-tip .welcome-tip-bulb svg")).toBeTruthy();
    expect(tipText(h)).not.toContain("\u{1F4A1}");
  });

  it("does not render tip copy as markup", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    // Every tip is built from text nodes; the only elements in the body are the
    // one action span and (for an unlinked tip) a <b>.
    const body = h.doc.querySelector("#welcome-tip .welcome-tip-body")!;
    for (const child of Array.from(body.children)) {
      expect(["SPAN", "B"]).toContain(child.tagName);
    }
  });
});
