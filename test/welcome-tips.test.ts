/**
 * Empty-state advice — the two pure halves.
 *
 *  - `src/welcome-tips.ts`: the host's bounded store of retired ids. Knows
 *    nothing about which tips exist, on purpose.
 *  - `media/webview-helpers.js`: the catalogue and the eligibility rule, which
 *    is where every fact a tip reads actually lives.
 *
 * The seam between them is that an unknown id is harmless in both directions —
 * the host stores anything id-shaped, the client skips anything it does not
 * recognise — so the two never need a version check.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  WELCOME_TIPS_DISMISS_LIMIT,
  WELCOME_TIPS_KEY,
  WELCOME_TIPS_SHOWN_KEY,
  isWelcomeTipId,
  localDayKey,
  parseDismissedTips,
  parseShownTips,
  shownOn,
  withDismissedTip,
  withShownTip,
} from "../src/welcome-tips";
import {
  WELCOME_TIPS,
  splitWelcomeTipCopy,
  welcomeTipById,
  welcomeTipsFor,
} from "../media/webview-helpers.js";

/** A fully set-up desk user: every tip that CAN retire itself, has. */
const SETTLED = {
  appPurpose: "knowledge",
  isRemote: false,
  altAgentConnected: true,
  routineCount: 3,
  connectorCount: 2,
  readRepliesAloud: true,
  voiceConfigured: true,
  remoteLinked: true,
  dismissed: [] as string[],
};

/** A first-run desk user: nothing set up, everything eligible. */
const FRESH = {
  appPurpose: "knowledge",
  isRemote: false,
  altAgentConnected: false,
  routineCount: 0,
  connectorCount: 0,
  readRepliesAloud: false,
  voiceConfigured: false,
  remoteLinked: false,
  dismissed: [] as string[],
};

const ids = (facts: unknown) =>
  (welcomeTipsFor(facts) as { id: string }[]).map((t) => t.id);

describe("host store (src/welcome-tips.ts)", () => {
  it("keys off client-state, not a VS Code-only globalState bucket", () => {
    expect(WELCOME_TIPS_KEY).toBe("grok.welcomeTips");
  });

  it("accepts id-shaped strings and refuses anything path-like", () => {
    expect(isWelcomeTipId("routines")).toBe(true);
    expect(isWelcomeTipId("read_aloud-2")).toBe(true);
    expect(isWelcomeTipId("")).toBe(false);
    expect(isWelcomeTipId("../../etc/passwd")).toBe(false);
    expect(isWelcomeTipId("a.b")).toBe(false);
    expect(isWelcomeTipId("has space")).toBe(false);
    expect(isWelcomeTipId("x".repeat(65))).toBe(false);
    expect(isWelcomeTipId(42)).toBe(false);
  });

  it("reads a record map and ignores everything that is not id -> true", () => {
    expect(parseDismissedTips({ plan: true, mentions: true })).toEqual(["mentions", "plan"]);
    expect(parseDismissedTips({ plan: false })).toEqual([]);
    expect(parseDismissedTips({ "../x": true })).toEqual([]);
  });

  it("degrades a legacy array (or junk) to nothing retired rather than throwing", () => {
    // An array is exactly what PersistedState.validValue rejects, so this is the
    // shape a hand-edited or pre-migration file would hold.
    expect(parseDismissedTips(["plan"])).toEqual([]);
    expect(parseDismissedTips(null)).toEqual([]);
    expect(parseDismissedTips("plan")).toEqual([]);
    expect(parseDismissedTips(undefined)).toEqual([]);
  });

  it("adds an id and carries the existing entries through verbatim", () => {
    expect(withDismissedTip({ plan: true }, "mentions")).toEqual({ plan: true, mentions: true });
  });

  it("keeps an id a NEWER client wrote that this host has never heard of", () => {
    // The whole reason the host holds no catalogue: a client one version ahead
    // must not have its retirement dropped on the next write.
    expect(withDismissedTip({ somethingNewer: true }, "plan")).toEqual({
      somethingNewer: true,
      plan: true,
    });
  });

  it("answers null for a no-op write so the caller does not re-broadcast", () => {
    expect(withDismissedTip({ plan: true }, "plan")).toBeNull();
    expect(withDismissedTip({}, "../etc")).toBeNull();
    expect(withDismissedTip({}, "")).toBeNull();
    expect(withDismissedTip({}, undefined)).toBeNull();
  });

  it("refuses to grow past the ceiling", () => {
    const full: Record<string, true> = {};
    for (let i = 0; i < WELCOME_TIPS_DISMISS_LIMIT; i++) full[`tip${i}`] = true;
    expect(withDismissedTip(full, "onemore")).toBeNull();
    // One under the limit still writes.
    delete full.tip0;
    expect(withDismissedTip(full, "onemore")).not.toBeNull();
  });
});

describe("the registries a device-global frame has to be named in", () => {
  // SIX of them now, and TypeScript enforces none. The one that bit here is the
  // last: DEVICE_GLOBAL_REMOTE_TYPES decides how a frame is ROUTED once
  // something posts it, while buildRemoteSnapshot decides whether a browser
  // that just connected receives it AT ALL. A frame can be in the first and
  // missing from the second, which is exactly what happened: a phone came up
  // with no tip facts, so every count read as unknown and the dismissed list
  // read as empty — a tip the user had retired came back on every empty screen
  // and the once-a-day rule never applied.
  const sidebarSrc = readFileSync(
    fileURLToPath(new URL("../src/sidebar.ts", import.meta.url)),
    "utf8",
  );

  function block(marker: string, terminator: string): string {
    const start = sidebarSrc.indexOf(marker);
    expect(start, marker).toBeGreaterThan(-1);
    const end = sidebarSrc.indexOf(terminator, start);
    expect(end, marker).toBeGreaterThan(start);
    return sidebarSrc.slice(start, end);
  }

  it("routes the tip facts device-wide rather than down the focused conversation", () => {
    expect(block("private static readonly DEVICE_GLOBAL_REMOTE_TYPES", "]);"))
      .toContain('"welcomeTips"');
  });

  it("puts the tip facts in the catch-up a newly connected remote receives", () => {
    const snapshot = block("private buildRemoteSnapshot(", "\n  }");
    expect(snapshot).toContain("this.welcomeTipsMessage()");
  });

  it("puts the project root there too, for the same reason", () => {
    // Same miss, same frame set: without it the Add project form on a phone had
    // no destination to preview until an attempt had already been made.
    const snapshot = block("private buildRemoteSnapshot(", "\n  }");
    expect(snapshot).toContain("this.projectSetupMessage(this.githubProjectSetupExtra(clientId))");
  });
});

describe("the once-a-day store", () => {
  it("keys off client-state, beside the retirement list", () => {
    expect(WELCOME_TIPS_SHOWN_KEY).toBe("grok.welcomeTipsShown");
  });

  it("reads the day from LOCAL parts, not from UTC", () => {
    // toISOString is UTC: 23:30 on the 5th in Warsaw is already the 6th there,
    // and anyone west of Greenwich would roll over mid-afternoon and see the
    // whole pool again before dinner.
    expect(localDayKey(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(localDayKey(new Date(2026, 11, 31, 0, 1))).toBe("2026-12-31");
    // Zero-padded, so string comparison and the regex both hold.
    expect(localDayKey(new Date(2026, 8, 9, 12, 0))).toBe("2026-09-09");
  });

  it("reads a record of id -> day and ignores anything else", () => {
    expect(parseShownTips({ routines: "2026-08-25" })).toEqual({ routines: "2026-08-25" });
    expect(parseShownTips({ routines: true })).toEqual({});
    expect(parseShownTips({ routines: "yesterday" })).toEqual({});
    expect(parseShownTips({ "../x": "2026-08-25" })).toEqual({});
    expect(parseShownTips(["routines"])).toEqual({});
    expect(parseShownTips(null)).toEqual({});
  });

  it("answers which ids have already had their turn today", () => {
    const store = { routines: "2026-08-25", voice: "2026-08-24", remote: "2026-08-25" };
    expect(shownOn(store, "2026-08-25")).toEqual(["remote", "routines"]);
    expect(shownOn(store, "2026-08-26")).toEqual([]);
  });

  it("records a tip and drops every other day on the way through", () => {
    // No eviction policy needed: the only question ever asked of this store is
    // "did this one already appear today", so yesterday has no reader.
    expect(withShownTip({ voice: "2026-08-24" }, "routines", "2026-08-25")).toEqual({
      routines: "2026-08-25",
    });
    expect(withShownTip({ voice: "2026-08-25" }, "routines", "2026-08-25")).toEqual({
      voice: "2026-08-25",
      routines: "2026-08-25",
    });
  });

  it("answers null for a no-op write, so nothing touches the disk", () => {
    expect(withShownTip({ routines: "2026-08-25" }, "routines", "2026-08-25")).toBeNull();
    expect(withShownTip({}, "../etc", "2026-08-25")).toBeNull();
    expect(withShownTip({}, "routines", "nonsense")).toBeNull();
  });
});

describe("tip catalogue (media/webview-helpers.js)", () => {
  it("has unique ids and exactly one actionable span per line", () => {
    const seen = new Set<string>();
    for (const tip of WELCOME_TIPS as { id: string; copy: string }[]) {
      expect(seen.has(tip.id), `duplicate id ${tip.id}`).toBe(false);
      seen.add(tip.id);
      expect(tip.copy.match(/\{/g)?.length, `${tip.id} braces`).toBe(1);
      expect(tip.copy.match(/\}/g)?.length, `${tip.id} braces`).toBe(1);
      expect(splitWelcomeTipCopy(tip.copy).action.length, `${tip.id} action`).toBeGreaterThan(0);
    }
  });

  it("points every settings target at a category the settings page actually has", () => {
    // The nav ids in media/settings.js. A tip linking to a category that does
    // not exist opens the page on nothing, which is the failure this pins.
    const CATEGORIES = new Set([
      "general", "voice", "notifications", "providers",
      "routines", "connectors", "account", "advanced", "about",
    ]);
    for (const tip of WELCOME_TIPS as { id: string; target: string | null }[]) {
      if (!tip.target || tip.target.indexOf("settings:") !== 0) continue;
      const category = tip.target.slice("settings:".length);
      expect(CATEGORIES.has(category), `${tip.id} -> ${category}`).toBe(true);
    }
  });

  it("uses only targets the renderer knows how to open", () => {
    const KNOWN = new Set(["mention", "worktree"]);
    for (const tip of WELCOME_TIPS as { id: string; target: string | null }[]) {
      if (tip.target === null) continue;
      if (tip.target.indexOf("settings:") === 0) continue;
      expect(KNOWN.has(tip.target), `${tip.id} -> ${tip.target}`).toBe(true);
    }
  });

  it("returns undefined for an id from a newer host rather than throwing", () => {
    expect(welcomeTipById("routines")).toBeTruthy();
    expect(welcomeTipById("tip-from-the-future")).toBeUndefined();
  });

  it("splits copy into text, action, text", () => {
    expect(splitWelcomeTipCopy("a {b} c")).toEqual({ before: "a ", action: "b", after: " c" });
    // Copy with no braced span renders as a plain sentence rather than throwing.
    expect(splitWelcomeTipCopy("no action here")).toEqual({
      before: "no action here", action: "", after: "",
    });
    expect(splitWelcomeTipCopy(undefined)).toEqual({ before: "", action: "", after: "" });
  });
});

describe("eligibility", () => {
  it("offers the full desk pool to a first-run user", () => {
    expect(ids(FRESH)).toEqual([
      "providers", "routines", "connectors", "remote", "readAloud", "voice", "mentions",
    ]);
  });

  it("keeps only the tips nothing can retire once everything is set up", () => {
    // Mentions is a habit, not a setting — it has no state to flip, so being
    // shown for the day and then dismissed are the only things that retire it.
    expect(ids(SETTLED)).toEqual(["mentions"]);
  });

  it("drops the agents tip as soon as ONE of Codex or Claude is connected", () => {
    // The owner's rule: a second agent existing is the whole lesson.
    expect(ids(FRESH)).toContain("providers");
    expect(ids({ ...FRESH, altAgentConnected: true })).not.toContain("providers");
  });

  it("never offers worktrees in Knowledge work", () => {
    expect(ids({ ...FRESH, appPurpose: "knowledge" })).not.toContain("worktrees");
    expect(ids({ ...FRESH, appPurpose: "coding" })).toContain("worktrees");
  });

  it("offers worktrees only where the action would actually be accepted", () => {
    // Every condition continueChatDestinations() applies. The first version of
    // this checked only the mode, and then a later pass added two facts to the
    // client without adding them here — where they read as undefined, so the
    // tip silently vanished from the pool on every host.
    const coding = { ...FRESH, appPurpose: "coding" };
    expect(ids(coding)).toContain("worktrees");
    // A CLI that answered "unsupported" to a create.
    expect(ids({ ...coding, worktreeSupported: false })).not.toContain("worktrees");
    // Worktrees do not nest, and the host refuses it with a message of its own.
    expect(ids({ ...coding, inWorktree: true })).not.toContain("worktrees");
    // Opt-OUT, like the client's own default: absence means supported, because
    // most hosts never say either way.
    expect(ids({ ...coding, worktreeSupported: undefined })).toContain("worktrees");
  });

  it("gives the worktree tip a real destination", () => {
    // It shipped with none, on the reasoning that starting a worktree needs a
    // conversation to continue FROM. That was wrong: `newWorktreeSession` takes
    // no source session, it cuts from the current project — so it works from an
    // empty screen, which is the only place this tip ever appears.
    const tip = (WELCOME_TIPS as { id: string; target: string | null }[])
      .find((t) => t.id === "worktrees")!;
    expect(tip.target).toBe("worktree");
  });

  it("hides from a phone what a phone cannot do", () => {
    const remote = ids({ ...FRESH, isRemote: true });
    // Two different rules, and the distinction matters. Starting a worktree is
    // host-local and "continue on your phone" is being read ON the phone, so
    // both are deskOnly. Signing an agent in and linking a connector are NOT --
    // a phone can do either -- they are withheld here only because this host
    // advertises neither capability.
    for (const withheld of ["providers", "connectors", "remote", "worktrees"]) {
      expect(remote, withheld).not.toContain(withheld);
    }
    expect(remote).toEqual(["routines", "readAloud", "voice", "mentions"]);
  });

  it("offers a phone what its host says it can do", () => {
    // The owner asked why the connectors tip never appeared on a cloud machine
    // (2026-09-06). It was deskOnly, which on a cloud host means nobody sees it
    // at all: there is no desk user there. The gate is the capability the tip's
    // own destination uses -- Settings hides its Connectors category without
    // `mcpSettings` -- so the link can never land on a page that is not there.
    const capable = ids({ ...FRESH, isRemote: true, mcpSettings: true, remoteCanConnectAgents: true });
    expect(capable).toContain("connectors");
    expect(capable).toContain("providers");
    // deskOnly is unaffected by any capability: these need the desk itself.
    expect(capable).not.toContain("worktrees");
    expect(capable).not.toContain("remote");
    // Each capability gates only its own tip.
    expect(ids({ ...FRESH, isRemote: true, mcpSettings: true })).not.toContain("providers");
    expect(ids({ ...FRESH, isRemote: true, remoteCanConnectAgents: true })).not.toContain("connectors");
  });

  it("suppresses count-dependent tips when the host never sent the counts", () => {
    // An older host posts no welcomeTips frame at all. Reading that absence as
    // "zero routines" would advertise routines to someone running twenty.
    const noCounts = { ...FRESH, routineCount: undefined, connectorCount: undefined };
    expect(ids(noCounts)).not.toContain("routines");
    expect(ids(noCounts)).not.toContain("connectors");
    expect(ids(noCounts)).toContain("providers");
  });

  it("treats an unread device token (null) as no invitation to link", () => {
    // remoteLinked is tri-state: null means the host has not answered yet, and
    // inviting an already-linked machine to link again is the confusion that
    // tri-state exists to prevent.
    expect(ids({ ...FRESH, remoteLinked: null })).not.toContain("remote");
    expect(ids({ ...FRESH, remoteLinked: false })).toContain("remote");
    expect(ids({ ...FRESH, remoteLinked: true })).not.toContain("remote");
  });

  it("honours retirement, from either an array or a record map", () => {
    expect(ids({ ...FRESH, dismissed: ["providers"] })).not.toContain("providers");
    expect(ids({ ...FRESH, dismissed: { providers: true } })).not.toContain("providers");
  });

  it("does not offer a tip twice in the same day", () => {
    // The pool is small. Without this the same two or three lines come round
    // again every time a conversation ends, which is how advice becomes
    // wallpaper.
    expect(ids({ ...FRESH, shownToday: ["providers", "routines"] })).toEqual([
      "connectors", "remote", "readAloud", "voice", "mentions",
    ]);
  });

  it("exempts the tip currently on screen from the day filter", () => {
    // It joined that list the moment it rendered. A repaint must not make the
    // line the reader is halfway through vanish from under them.
    const shown = { ...FRESH, shownToday: ["providers", "routines"] };
    expect(ids(shown)).not.toContain("providers");
    expect(ids({ ...shown, keepId: "providers" })[0]).toBe("providers");
    // The pin exempts it from the DAY filter only — never from eligibility.
    expect(ids({ ...shown, keepId: "providers", altAgentConnected: true }))
      .not.toContain("providers");
  });

  it("empties for the day once every tip has had its turn", () => {
    const all = ["providers", "routines", "connectors", "remote", "readAloud", "voice", "mentions"];
    expect(ids({ ...FRESH, shownToday: all })).toEqual([]);
  });

  it("ignores a shownToday an older host never sent", () => {
    expect(ids({ ...FRESH, shownToday: undefined }).length).toBeGreaterThan(0);
  });

  it("can empty completely, which is what puts the screen back as it is today", () => {
    const done = { ...SETTLED, dismissed: ["mentions"] };
    expect(ids(done)).toEqual([]);
  });

  it("survives being handed nothing at all", () => {
    expect(() => welcomeTipsFor(undefined)).not.toThrow();
    expect(() => welcomeTipsFor({})).not.toThrow();
  });
});
