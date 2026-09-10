/**
 * DOM coverage for the simplification plan:
 *  - "Use this app for" (Knowledge work / Coding)
 *  - VS Code session overflow → single "Continue in a new chat"
 *  - Knowledge work hides worktree destination + coding controls
 *  - Rail gear present when #projects-rail mounts; composer gear when not
 *  - Rewind confirm cancel answers ok:false (host must not revert)
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bootWebview, type Harness } from "./webview-harness";

function dispatch(window: any, msg: object) {
  window.dispatchEvent(
    new window.MessageEvent("message", { data: msg }),
  );
}

function click(window: any, el: Element | null | undefined) {
  if (!el) throw new Error("click target missing");
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function openGear(h: Harness) {
  const btn = h.doc.getElementById("gear-btn") || h.doc.getElementById("rail-gear-btn");
  click(h.window, btn);
  expect(h.doc.getElementById("gear-popover")!.hidden).toBe(false);
}

function gearText(h: Harness): string {
  return h.doc.getElementById("gear-popover")!.textContent || "";
}

function gearItems(h: Harness): string[] {
  return [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")].map(
    (el) => (el.textContent || "").replace(/\s+/g, " ").trim(),
  );
}

function findGearItem(h: Harness, re: RegExp): HTMLElement | undefined {
  return [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")].find((el) =>
    re.test(el.textContent || ""),
  ) as HTMLElement | undefined;
}

function openSessionMenu(h: Harness) {
  let btn = h.doc.querySelector(
    "#vscode-session-actions .rail-menu-btn, #session-head-actions .rail-menu-btn",
  );
  if (!btn) {
    dispatch(h.window, { type: "sessionName", sessionId: "active", name: "Active", cwd: "/w" });
    btn = h.doc.querySelector(
      "#vscode-session-actions .rail-menu-btn, #session-head-actions .rail-menu-btn",
    );
  }
  click(h.window, btn);
  return [...h.doc.querySelectorAll(".rail-menu-item")] as HTMLElement[];
}

function findSessionMenuItem(h: Harness, re: RegExp): HTMLElement | undefined {
  return openSessionMenu(h).find((el) => re.test(el.textContent || ""));
}

describe("app purpose + session menu (DOM)", () => {
  it("defaults to Knowledge work when initialState omits appPurpose", () => {
    const h = bootWebview({ ready: true, vscode: true });
    dispatch(h.window, {
      type: "initialState",
      effort: "",
      cwd: "/w",
      useCtrlEnter: false,
      extVersion: "9.9.9",
      showThinking: true,
      expandCommandOutputs: true,
      steerByDefault: false,
      soundNotifications: false,
      processingSound: false,
      readRepliesAloud: false,
      capabilities: {},
    });
    // Knowledge work forces thinking-hidden even when showThinking is true.
    expect(h.doc.body.classList.contains("thinking-hidden")).toBe(true);
    openGear(h);
    expect(gearText(h)).toContain("Use this app for");
    expect(gearText(h)).toContain("Knowledge work");
    expect(gearText(h)).not.toContain("Continue in a new chat");
    expect(openSessionMenu(h).some((el) => (el.textContent || "").includes("Continue in a new chat"))).toBe(true);
    // Old three-way Session menu is gone.
    expect(gearText(h)).not.toContain("Fork conversation");
    expect(gearText(h)).not.toContain("New worktree session");
    expect(gearText(h)).not.toContain("Rewind conversation");
  });

  it("Knowledge work continues straight to fork with no destination popup", async () => {
    const h = bootWebview({ ready: true, vscode: true });
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
      readRepliesAloud: false,
      appPurpose: "knowledge",
      capabilities: {},
    });
    const cont = findSessionMenuItem(h, /Continue in a new chat/);
    expect(cont).toBeTruthy();
    click(h.window, cont!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "forkSession")).toEqual({
      type: "forkSession",
      sessionId: "active",
    });
    // No destination popup — gear closes without a "Where?" panel.
    expect(gearText(h)).not.toContain("Use a new worktree");
  });

  it("Coding offers worktree destination; workspace is default", async () => {
    const h = bootWebview({ ready: true, vscode: true });
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
      readRepliesAloud: false,
      appPurpose: "coding",
      capabilities: {},
    });
    click(h.window, findSessionMenuItem(h, /Continue in a new chat/)!);
    await Promise.resolve();
    // Popup appears with both destinations.
    expect(gearText(h)).toContain("Use this workspace");
    expect(gearText(h)).toContain("Use a new worktree");
    // Workspace is focused default — click it forks.
    click(h.window, findGearItem(h, /Use this workspace/)!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "forkSession")).toEqual({
      type: "forkSession",
      sessionId: "active",
    });
  });

  it("Coding → worktree destination posts newWorktreeSession", async () => {
    const h = bootWebview({ ready: true, vscode: true });
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
      readRepliesAloud: false,
      appPurpose: "coding",
      capabilities: {},
    });
    click(h.window, findSessionMenuItem(h, /Continue in a new chat/)!);
    await Promise.resolve();
    click(h.window, findGearItem(h, /Use a new worktree/)!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "newWorktreeSession")).toEqual({
      type: "newWorktreeSession",
    });
  });

  // The host runs worktree apply/remove against ITS focused session and creates
  // one against ITS workspace root, ignoring the requesting session. So a remote
  // tab in repo B could remove the worktree the desk was standing in — and
  // Remove discards unapplied edits. The policy refuses these from remote; these
  // two make sure the UI does not offer them anyway, because a control the host
  // silently drops is worse than no control.
  it("a remote client is never offered a worktree destination", async () => {
    const h = bootWebview({ ready: true, remote: true });
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
      readRepliesAloud: false,
      appPurpose: "coding",
      capabilities: {},
    });
    dispatch(h.window, { type: "worktreeSupported", value: true } as never);
    dispatch(h.window, { type: "sessionName", sessionId: "active", name: "Active", cwd: "/w" });
    click(h.window, findSessionMenuItem(h, /Continue in a new chat/)!);
    await Promise.resolve();
    // With only one destination the picker is skipped entirely and the fork
    // goes straight through — which is the desired remote behaviour.
    expect(findGearItem(h, /Use a new worktree/)).toBeFalsy();
    expect(h.posted.find((m) => m.type === "newWorktreeSession")).toBeFalsy();
  });

  it("a remote client in a worktree is never offered Apply/Remove", async () => {
    const h = bootWebview({ ready: true, remote: true });
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
      readRepliesAloud: false,
      appPurpose: "coding",
      capabilities: {},
    });
    // `session` is what actually sets state.isWorktree — a bespoke "worktree"
    // frame sets nothing, and the test would pass without the guard.
    dispatch(h.window, {
      type: "session",
      currentModelId: "grok-4-5",
      models: [],
      worktree: { label: "feature", path: "/w/.worktrees/feature" },
    } as never);
    openGear(h);
    expect(findGearItem(h, /Apply worktree/)).toBeFalsy();
    expect(findGearItem(h, /Remove worktree/)).toBeFalsy();
  });

  it("posts forkSession / applyWorktree / removeWorktree with the confirmed-active sessionId", async () => {
    const h = bootWebview({ ready: true, vscode: true });
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
      readRepliesAloud: false,
      appPurpose: "knowledge",
      capabilities: {},
    });
    dispatch(h.window, {
      type: "session",
      sessionId: "live-1",
      models: [],
      currentModelId: "grok-build",
      worktree: { label: "feature", path: "/w/.worktrees/feature" },
    } as never);
    dispatch(h.window, { type: "sessionName", sessionId: "live-1", name: "Live", cwd: "/w" });

    click(h.window, findSessionMenuItem(h, /Continue in a new chat/)!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "forkSession")).toEqual({
      type: "forkSession",
      sessionId: "live-1",
    });

    h.posted.length = 0;
    openGear(h);
    click(h.window, findGearItem(h, /Apply worktree/)!);
    click(h.window, h.doc.querySelector(".confirm-overlay .confirm-primary")!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "applyWorktree")).toEqual({
      type: "applyWorktree",
      sessionId: "live-1",
    });

    h.posted.length = 0;
    openGear(h);
    click(h.window, findGearItem(h, /Remove worktree/)!);
    click(h.window, h.doc.querySelector(".confirm-overlay .confirm-danger")!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "removeWorktree")).toEqual({
      type: "removeWorktree",
      sessionId: "live-1",
    });
  });

  it("gear Apply/Remove bind the conversation at dialog-open time, not confirm time", async () => {
    // Confirmation overlays deliberately outlive a session swap. If the id is
    // read when the confirm RESOLVES, switching conversations while the dialog
    // sits open removes the NEW conversation's worktree — the dialog promised
    // A and acted on B (work loss). The open-time id turns that into a host
    // refusal instead. (Codex round-1 finding, 2026-08-14.)
    const h = bootWebview({ ready: true, vscode: true });
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
      readRepliesAloud: false,
      appPurpose: "knowledge",
      capabilities: {},
    });
    dispatch(h.window, {
      type: "session",
      sessionId: "live-1",
      models: [],
      currentModelId: "grok-build",
      worktree: { label: "feature", path: "/w/.worktrees/feature" },
    } as never);
    dispatch(h.window, { type: "sessionName", sessionId: "live-1", name: "Live", cwd: "/w" });

    openGear(h);
    click(h.window, findGearItem(h, /Remove worktree/)!);
    // The swap arrives while the dialog is open.
    dispatch(h.window, { type: "sessionName", sessionId: "live-2", name: "Other", cwd: "/w" });
    click(h.window, h.doc.querySelector(".confirm-overlay .confirm-danger")!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "removeWorktree")).toEqual({
      type: "removeWorktree",
      sessionId: "live-1",
    });
  });

  it("setAppPurpose posts the choice and Coding reveals thinking control", async () => {
    const h = bootWebview({ ready: true, vscode: true });
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
      readRepliesAloud: false,
      appPurpose: "knowledge",
      capabilities: { relocateView: true, showOutput: true },
    });
    openGear(h);
    click(h.window, findGearItem(h, /Coding/)!);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "setAppPurpose")).toEqual({
      type: "setAppPurpose",
      value: "coding",
    });
    click(h.window, findGearItem(h, /^Settings$|Settings$/)!);
    await Promise.resolve();
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("Show thinking traces");
    expect(overlay.textContent).toContain("Expand tool details");
  });

  it("Knowledge work General page hides thinking and tool-detail switches", async () => {
    const h = bootWebview({ ready: true });
    dispatch(h.window, {
      type: "initialState",
      effort: "",
      cwd: "/w",
      useCtrlEnter: false,
      extVersion: "9.9.9",
      showThinking: true,
      expandCommandOutputs: true,
      steerByDefault: false,
      soundNotifications: false,
      processingSound: false,
      readRepliesAloud: false,
      appPurpose: "knowledge",
      capabilities: { relocateView: true, showOutput: true },
    });
    openGear(h);
    click(h.window, findGearItem(h, /^Settings$|Settings$/)!);
    await Promise.resolve();
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).not.toContain("Show thinking traces");
    expect(overlay.textContent).not.toContain("Expand tool details");
  });

  it("Settings General exposes the three display toggles on a remote client", async () => {
    // Rail mount → Basic/Advanced (not Config & debug). Toggles are per-client
    // display prefs, so they must appear on remote before the host-config note.
    const withRail = (window: any) => {
      const el = window.document.createElement("aside");
      el.id = "projects-rail";
      el.hidden = true;
      const scroll = window.document.createElement("div");
      scroll.id = "rail-scroll";
      el.appendChild(scroll);
      const foot = window.document.createElement("div");
      foot.className = "rail-foot";
      el.appendChild(foot);
      window.document.body.appendChild(el);
    };
    const h = bootWebview({ ready: true, remote: true, beforeScripts: withRail });
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
        readRepliesAloud: false,
        appPurpose: "coding",
        capabilities: { remoteSteering: true },
      });
      dispatch(h.window, { type: "initialized", info: { provider: "grok", steeringSupported: true, init: {} } });
      click(h.window, h.doc.getElementById("rail-gear-btn") || h.doc.getElementById("gear-btn"));
    expect(gearText(h)).toMatch(/Settings/);
    expect(gearText(h)).not.toContain("Advanced settings");
    click(h.window, findGearItem(h, /Settings/)!);
    await Promise.resolve();
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("Show thinking traces");
    expect(overlay.textContent).toContain("Expand tool details");
    expect(overlay.textContent).toContain("Steer by default");
    const advancedNav = [...overlay.querySelectorAll(".settings-nav-item")]
      .find((el) => (el.textContent || "").trim() === "Advanced")!;
    click(h.window, advancedNav);
    expect(overlay.textContent).toContain("Host config is managed on the machine running this workspace");
    expect(overlay.querySelector('[data-id="showThinking"]')).toBeNull();
  });
});

describe("rail gear placement (DOM)", () => {
  const withRail = (window: any) => {
    const el = window.document.createElement("aside");
    el.id = "projects-rail";
    el.hidden = true;
    const scroll = window.document.createElement("div");
    scroll.id = "rail-scroll";
    el.appendChild(scroll);
    const foot = window.document.createElement("div");
    foot.className = "rail-foot";
    const gear = window.document.createElement("button");
    gear.id = "rail-gear-btn";
    gear.type = "button";
    gear.className = "rail-icon-btn";
    gear.hidden = true;
    foot.appendChild(gear);
    el.appendChild(foot);
    window.document.body.appendChild(el);
  };

  const liveRail = () => {
    const h = bootWebview({ ready: true, beforeScripts: withRail });
    dispatch(h.window, {
      type: "repos",
      entries: [
        { cwd: "/proj", label: "proj", available: true, pinned: false, updatedAt: 1 },
      ],
      selectedCwd: "/proj",
      activeCwd: "/proj",
    });
    return h;
  };

  it("keeps BOTH buttons when the rail is live, with different icons", () => {
    const h = liveRail();
    const railGear = h.doc.getElementById("rail-gear-btn")!;
    const composerGear = h.doc.getElementById("gear-btn")!;
    // The composer button never disappears — model + effort is the highest
    // frequency control and must stay next to the composer.
    expect(composerGear.hidden).toBe(false);
    expect(railGear.hidden).toBe(false);
    // ...but it must not be a SECOND gear: sliders (lucide settings-2) vs gear.
    // circle+circle is settings-2's signature; the gear has exactly one.
    expect((composerGear.innerHTML.match(/<circle/g) || []).length).toBe(2);
    expect(composerGear.innerHTML).not.toContain("M12.22 2h-.44");
  });

  it("splits the menu: composer = this conversation, rail = the app", () => {
    const h = liveRail();
    click(h.window, h.doc.getElementById("gear-btn"));
    const composerMenu = gearText(h);
    expect(composerMenu).toContain("Model and Effort");
    // Session actions moved to the header's ⋯ menu, so this popover is model
    // and effort ALONE — how the agent answers, nothing about which
    // conversation you are in.
    expect(composerMenu).not.toContain("Continue in a new chat");
    // App-level settings moved out — that is the whole point of the split.
    expect(composerMenu).not.toContain("Use this app for");
    expect(composerMenu).not.toContain("Settings");
    expect(composerMenu).not.toContain("Version & about");

    click(h.window, h.doc.getElementById("gear-btn")); // close
    click(h.window, h.doc.getElementById("rail-gear-btn"));
    const railMenu = gearText(h);
    expect(railMenu).toContain("Use this app for");
    expect(railMenu).toMatch(/Settings/);
    expect(railMenu).not.toContain("Basic settings");
    expect(railMenu).not.toContain("Advanced settings");
    expect(railMenu).not.toContain("Version & about");
    expect(railMenu).not.toContain("Model and Effort");
    expect(railMenu).not.toContain("Continue in a new chat");
  });

  it("hides healthy mixed provider accounts and shows them when none are connected", () => {
    const h = liveRail();
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: false },
      ],
    });
    click(h.window, h.doc.getElementById("rail-gear-btn"));
    expect(gearText(h)).not.toContain("Accounts");

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: false },
        { id: "codex", connected: false },
      ],
    });
    expect(gearText(h)).toContain("Accounts");
    expect(gearText(h)).toContain("GrokConnect");
    click(h.window, findGearItem(h, /Grok.*Connect/)!);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "grok" });
  });

  it("omits the deferred Codex CLI path row from desktop Settings", () => {
    const h = liveRail();
    click(h.window, h.doc.getElementById("rail-gear-btn"));
    click(h.window, findGearItem(h, /Settings/)!);

    expect(h.doc.getElementById("codex-cli-path")).toBeNull();
    expect(h.doc.getElementById("settings-overlay")!.textContent).not.toContain("Codex CLI path");
    expect(h.posted.map((message) => message.type)).not.toContain("setCodexCliPath");
  });

  it("puts the rail gear leftmost in the footer, not stranded mid-row", () => {
    const h = liveRail();
    const foot = h.doc.querySelector("#projects-rail .rail-foot")!;
    // `.rail-foot` packs left and pushes only its LAST child to the far edge,
    // so first-child is the one place the gear reads as aligned rather than
    // centred between the account and the theme toggle.
    expect(foot.firstElementChild!.id).toBe("rail-gear-btn");
  });

  it("switches surfaces in ONE click, and still toggles its own shut", () => {
    const h = liveRail();
    const composer = h.doc.getElementById("gear-btn")!;
    const rail = h.doc.getElementById("rail-gear-btn")!;
    const pop = h.doc.getElementById("gear-popover")!;

    click(h.window, rail);
    expect(gearText(h)).toContain("Use this app for");
    // One click on the OTHER button must land on the other menu — not merely
    // dismiss this one and make you click again.
    click(h.window, composer);
    expect(pop.hidden).toBe(false);
    expect(gearText(h)).toContain("Model and Effort");
    click(h.window, rail);
    expect(pop.hidden).toBe(false);
    expect(gearText(h)).toContain("Use this app for");
    // Clicking the button that IS showing still closes it.
    click(h.window, rail);
    expect(pop.hidden).toBe(true);
  });

  it("caps the rail-anchored popover width so About cannot span the window", () => {
    const h = liveRail();
    const railGear = h.doc.getElementById("rail-gear-btn")!;
    // jsdom gives every element a zero rect; the popover only needs the anchor
    // to exist for the fixed-position branch to run.
    click(h.window, railGear);
    const pop = h.doc.getElementById("gear-popover")! as HTMLElement;
    expect(pop.style.position).toBe("fixed");
    const cap = parseInt(pop.style.maxWidth, 10);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(240);
  });

  it("VS Code's single button keeps a gear icon and the whole menu", () => {
    const h = bootWebview({ ready: true });
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
      readRepliesAloud: false,
      capabilities: {},
    });
    dispatch(h.window, { type: "sessionName", sessionId: "active", name: "Active", cwd: "/w" });
    const composerGear = h.doc.getElementById("gear-btn")!;
    expect(composerGear.innerHTML).toContain("M12.22 2h-.44");
    openGear(h);
    // Nothing is split without a rail to split into.
    expect(gearText(h)).toContain("Model and Effort");
    expect(gearText(h)).not.toContain("Continue in a new chat");
    expect(gearText(h)).toContain("Use this app for");
    expect(gearText(h)).not.toContain("Version & about");
    click(h.window, composerGear);
    expect(openSessionMenu(h).some((el) => (el.textContent || "").includes("Continue in a new chat"))).toBe(true);
  });

  it("keeps composer gear and never mounts a rail gear without #projects-rail (VS Code)", () => {
    const h = bootWebview({ ready: true });
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
      readRepliesAloud: false,
      capabilities: {},
    });
    // A repos frame for clear-all naming must not light a rail or invent a gear.
    dispatch(h.window, {
      type: "repos",
      entries: [{ cwd: "/w", label: "w", available: true, pinned: false, updatedAt: 1 }],
      selectedCwd: "/w",
      activeCwd: "/w",
    });
    expect(h.doc.getElementById("projects-rail")).toBeNull();
    expect(h.doc.getElementById("rail-gear-btn")).toBeNull();
    expect(h.doc.getElementById("gear-btn")!.hidden).toBe(false);
  });
});

describe("rewind confirm dismiss (DOM)", () => {
  it("cancel answers ok:false so the host must not revert", async () => {
    const h = bootWebview({ ready: true });
    dispatch(h.window, {
      type: "uiConfirmRequest",
      id: "rw-1",
      title: "Rewind past this message?",
      body: "Files will be restored.",
      confirmLabel: "Rewind",
      danger: true,
    });
    const cancel = [...h.doc.querySelectorAll(".confirm-panel button")].find(
      (b) => b.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement;
    click(h.window, cancel);
    await Promise.resolve();
    expect(h.posted.find((m) => m.type === "uiConfirmAnswer")).toEqual({
      type: "uiConfirmAnswer",
      id: "rw-1",
      ok: false,
    });
    // No rewindSession was posted by the webview on cancel — only the answer.
    expect(h.posted.filter((m) => m.type === "rewindSession")).toHaveLength(0);
  });
});

describe("continue-in-a-new-chat picker is visible from the session menu", () => {
  // The picker's entry point moved from the gear to the conversation's overflow
  // menu, but it still rendered straight into the gear popover — which is closed
  // there. So it wrote into a hidden, unpositioned element: no visible response
  // at all, and on the one occasion it did appear it sat in the corner of the
  // window anchored to nothing.
  it("centres itself and offers no way back to a gear it did not come from", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    const start = src.indexOf("function renderContinueDestinationPicker(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, start + 1800);
    // Centred, because it is reached from the conversation's overflow menu and
    // has no gear button to anchor to.
    expect(body).toContain("popover-centered");
    expect(body).toContain("gearPopover.hidden = false");
    // No back link: it would return you to a panel you were never in.
    expect(body).not.toContain("popover-back");
  });
});


/**
 * The context donut in knowledge work.
 *
 * Owner, 2026-09-01: "In the knowledge work mode after clicking donut I would
 * also hide all details, just x/y and compact conversation?"
 *
 * This is not a new rule — the gear already describes the mode as "Hides
 * worktrees, thinking traces, and tool details", and the breakdown (system
 * prompt, reasoning overhead, tool definitions, per-turn cost) is exactly that
 * class. The popover was simply missed when the rule was applied.
 */
describe("context popover respects the app purpose", () => {
  const openDonut = (h: Harness) => {
    dispatch(h.window, { type: "contextUsage", used: 16017, window: 512000 } as never);
    dispatch(h.window, {
      type: "contextUsage",
      used: 16017,
      window: 512000,
      systemPromptTokens: 1039,
      toolDefinitionsTokens: 812,
      messageTokens: 12166,
      freeTokens: 495983,
    } as never);
    click(h.window, h.doc.getElementById("donut")!);
    return h.doc.getElementById("context-popover")!;
  };

  it("shows the number and Compact, and nothing else, in knowledge work", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "initialState", appPurpose: "knowledge", capabilities: {} } as never);

    const pop = openDonut(h);
    const text = pop.textContent || "";

    // VISIBILITY FIRST. The lines that position and reveal this popover are the
    // last thing the renderer does, so an early return skipped them and the
    // donut did nothing at all in the default mode — while an assertion on
    // textContent alone passed happily against the hidden element.
    expect((pop as HTMLElement).hidden).toBe(false);
    // What a person writing a document actually asked the donut.
    expect(text).toContain("Context used");
    expect(text).toContain("Compact conversation");
    // The technical account, all of it, absent.
    expect(text).not.toContain("In this window");
    expect(text).not.toContain("System");
    expect(text).not.toContain("Reasoning/overhead");
    expect(text).not.toContain("Session total");
  });

  it("still shows the full breakdown in coding mode", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);

    const pop = openDonut(h);
    const text = pop.textContent || "";

    expect((pop as HTMLElement).hidden).toBe(false);
    expect(text).toContain("Context used");
    expect(text).toContain("In this window");
    expect(text).toContain("System");
  });
});
