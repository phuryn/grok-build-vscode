import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import {
  CLI_VERSION_CACHE_KEY,
  PLAN_MODE_UNVERIFIED_REASON,
  readCliBinaryIdentity,
  type CliVersionCache,
} from "../src/cli-locator";

const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
const updateStart = sidebar.indexOf("  private async maybeUpdateCliOnUpgrade(");
const updateEnd = sidebar.indexOf("  /**", updateStart + 5);
const update = sidebar.slice(updateStart, updateEnd);
const compatibilityStart = sidebar.indexOf("  private async planModeCompatibility(");
const compatibilityEnd = sidebar.indexOf("  /**", compatibilityStart + 5);
const compatibility = sidebar.slice(compatibilityStart, compatibilityEnd);
const pinStart = sidebar.indexOf("  private async maybePinBrokenCli(");
const pinEnd = sidebar.indexOf("  /**", pinStart + 5);
const pin = sidebar.slice(pinStart, pinEnd);
const setModeStart = sidebar.indexOf("  async setMode(");
const setModeEnd = sidebar.indexOf("  /** Resolve a plan-review card", setModeStart);
const setMode = sidebar.slice(setModeStart, setModeEnd);
const sessionStart = sidebar.slice(
  sidebar.indexOf("  private async startSession("),
  sidebar.indexOf("    // Worktree sessions pin cwd", sidebar.indexOf("  private async startSession(")),
);
const fullSessionStart = sidebar.slice(
  sidebar.indexOf("  private async startSession("),
  sidebar.indexOf("  private remoteSessionFor(", sidebar.indexOf("  private async startSession(")),
);

describe("CLI startup compatibility", () => {
  it("has no startup freshness cache or background update check", () => {
    for (const removed of [
      "cliUpdateAvailable",
      "cliUpdateCheckedAt",
      "refreshCliUpdateAvailability",
      "grokFreshnessAction",
      "GROK_UPDATE_CHECK_COOLDOWN_MS",
    ]) {
      expect(sidebar).not.toContain(removed);
    }
  });

  it("keeps the original once-per-extension-upgrade update trigger", () => {
    expect(update).toContain("if (this.cliUpdateChecked) return");
    expect(update).toContain("extensionWasUpgraded(lastSeen, current)");
    expect(update).toContain('execProviderCli("grok", cliPath, args');
    // Same store, different accessor: CLI_UPDATE_VERSION_KEY is not one of the
    // keys that moved to ~/.grok, so it still lands in globalState. See
    // persisted-state.ts.
    expect(update).toContain("this.state.update(CLI_UPDATE_VERSION_KEY, current)");
    expect(sessionStart).toContain("await this.maybeUpdateCliOnUpgrade(cliPath, session)");
  });

  it("bounds the silent update at 20s and spends it ONCE per extension version", () => {
    // This runs before the spawn with the composer locked, so its budget is
    // the user's typing time. It used to get 180s AND leave the marker
    // unwritten on failure so the next window retried — correct for a Windows
    // binary lock (instant, free to retry), pathological for an unreachable
    // x.ai, where a no-op `grok update` costs ~68s and the retry re-charged it
    // on every window forever (funkpopo, PR #129).
    expect(update).toContain('execProviderCli("grok", cliPath, args, { timeout: 20_000 })');
    // No conditional around the marker write: a failed attempt still counts.
    expect(update).not.toContain("updateFailed");
    const finallyBlock = update.slice(update.indexOf("} finally {"));
    expect(finallyBlock).toMatch(/void this\.state\.update\(CLI_UPDATE_VERSION_KEY, current\);/);
    expect(finallyBlock).not.toMatch(/if\s*\(/);
  });

  it("keeps version gating separate from all update orchestration", () => {
    expect(compatibility).toContain("resolvePlanModeAvailability");
    expect(compatibility).toContain("readCliBinaryIdentity(cliPath)");
    expect(compatibility).toContain("this.readGrokVersion(cliPath)");
    expect(compatibility).toContain("CLI_VERSION_CACHE_KEY");
    expect(compatibility).not.toContain("runGrokUpdate");
    expect(compatibility).not.toContain("execGrokCli");
    expect(compatibility).not.toContain("execProviderCli");
    expect(compatibility).not.toContain("this.pool");
  });

  it("proactively pins only the bounded Windows hang range before compatibility and spawn", () => {
    expect(pin).toContain("if (this.brokenCliPinned) return");
    expect(pin).toContain("isStdioBrokenGrokVersion(versionOutput, process.platform)");
    expect(pin).toContain('this.downgradeBrokenCli(cliPath, detected, "proactive")');
    expect(sidebar).toContain('reason: "proactive" | "reactive"');

    const update = sessionStart.indexOf("await this.maybeUpdateCliOnUpgrade(cliPath, session)");
    const proactivePin = sessionStart.indexOf("await this.maybePinBrokenCli(cliPath)", update);
    const compatibilityCheck = sessionStart.indexOf("await this.planModeCompatibility(cliPath)", proactivePin);
    expect(proactivePin).toBeGreaterThan(update);
    expect(compatibilityCheck).toBeGreaterThan(proactivePin);
  });

  it("disables only Plan for a parseable CLI below the floor", () => {
    expect(compatibility).toContain("planModeAvailable: false");
    expect(compatibility).toContain("planModeVersionVerified: true");
    expect(compatibility).toContain("decision.reason");
    expect(sessionStart).toContain("this.applyPlanModeCompatibility(session, compatibility)");
    expect(sidebar).toContain('type: "planModeAvailability"');
    expect(setMode).toContain('modeId === "plan" && !session.planModeAvailable');
    expect(setMode).toContain("session.planModeUnavailableReason");
    expect(setMode).toContain("!session.planModeAvailable && session.planActive");
    expect(setMode).toContain("this.recoverUnavailablePlanMode(session, session.client, session.gen)");
  });

  it("fails closed for Plan when the installed version cannot be verified, without latching", () => {
    expect(compatibility).toContain("planModeVersionVerified: false");
    expect(compatibility).toContain("Continuing best-effort with the current binary");
    expect(compatibility).toContain("planModeAvailable: false");
    // Unverified copy must not lead with the "requires X or newer" floor line alone.
    expect(compatibility).toMatch(/Could not verify the Grok CLI version/);
    expect(compatibility).toMatch(/failed or timed out/);
    expect(compatibility).toMatch(/reload the window to retry/);
    // A later Plan pick re-probes instead of forcing a session restart (#105).
    expect(setMode).toContain("!session.planModeVersionVerified");
    expect(setMode).toContain("this.recheckPlanModeAvailability(session)");
    expect(sidebar).toContain("private async recheckPlanModeAvailability");
  });

  it("re-enables Plan for a later session that meets the floor", () => {
    expect(compatibility).toContain("planModeVersionVerified: decision.verified");
    expect(sessionStart).toContain("this.applyPlanModeCompatibility(session, compatibility)");
  });

  it("does not treat a cache substitute as a verified Plan decision", () => {
    expect(compatibility).toContain("using last verified version for Plan mode");
    expect(compatibility).toContain("planModeVersionVerified: decision.verified");
    expect(setMode).toContain("!session.planModeVersionVerified");
    expect(setMode).toContain("this.recheckPlanModeAvailability(session)");
  });

  it("does not feed a cache stand-in into the initialize handshake", () => {
    expect(sessionStart).toContain("grokVersionVerified = compatibility.planModeVersionVerified");
    expect(sessionStart).toMatch(
      /grokHandshakeVersion = grokVersionVerified\s*\?\s*compatibility\.cliVersion\s*:\s*undefined/,
    );
    expect(fullSessionStart).toContain("grokVersion: grokHandshakeVersion, grokVersionVerified");
    expect(fullSessionStart).not.toMatch(/grokHandshakeVersion = compatibility\.cliVersion\s*;/);
  });

  it("awaits the replaced process before the upgrade trigger can replace the binary", () => {
    const capture = fullSessionStart.indexOf("const replacedClient = session.client");
    const clear = fullSessionStart.indexOf("session.client = undefined", capture);
    const dispose = fullSessionStart.indexOf("await replacedClient.dispose()", clear);
    const update = fullSessionStart.indexOf("await this.maybeUpdateCliOnUpgrade(cliPath, session)", dispose);

    expect(capture).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(capture);
    expect(dispose).toBeGreaterThan(clear);
    expect(update).toBeGreaterThan(dispose);
  });

  it("disposes the detached client before any lookup can take an early return", () => {
    const capture = fullSessionStart.indexOf("const replacedClient = session.client");
    const clear = fullSessionStart.indexOf("session.client = undefined", capture);
    const dispose = fullSessionStart.indexOf("await replacedClient.dispose()", clear);
    const lookup = fullSessionStart.indexOf("const cliPath = this.locateProvider(session.provider)", dispose);
    expect(dispose).toBeGreaterThan(clear);
    expect(lookup).toBeGreaterThan(dispose);
    expect(fullSessionStart.slice(clear, dispose)).not.toMatch(/\breturn(?:\s+undefined)?;/);
  });
});

describe("planModeCompatibility cache substitute", () => {
  let cliPath: string;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "plan-cache-"));
    cliPath = path.join(tmp, "grok");
    writeFileSync(cliPath, "x");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  function matchingCache(versionOutput: string): CliVersionCache {
    const identity = readCliBinaryIdentity(cliPath);
    if (!identity) throw new Error("expected identity for temp CLI");
    return {
      [identity.path]: {
        mtimeMs: identity.mtimeMs,
        size: identity.size,
        versionOutput,
      },
    };
  }

  function makeSidebar(versionOutput: string, cache?: CliVersionCache) {
    const instance = Object.create(GrokSidebar.prototype) as any;
    const store: Record<string, unknown> = {
      [CLI_VERSION_CACHE_KEY]: cache ?? {},
    };
    instance.state = {
      get: (key: string, fallback: unknown) => (key in store ? store[key] : fallback),
      update: async (key: string, value: unknown) => { store[key] = value; },
    };
    instance.host = {
      appendLine: vi.fn(),
      showWarningMessage: vi.fn(),
    };
    instance.readGrokVersion = vi.fn(async () => versionOutput);
    instance.emit = vi.fn();
    instance.store = store;
    instance.providerCliVersions = {};
    return instance;
  }

  type Compat = {
    planModeAvailable: boolean;
    planModeVersionVerified: boolean;
    usedCache?: boolean;
    planModeUnavailableReason?: string;
  };

  async function runCompatibility(sidebar: { planModeCompatibility: (cliPath: string) => Promise<Compat> }): Promise<Compat> {
    vi.useFakeTimers();
    try {
      const pending = sidebar.planModeCompatibility(cliPath);
      await vi.runAllTimersAsync();
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it("timeout + cached 1.x stays unverified even when the number is at the image-read floor", async () => {
    const sidebar = makeSidebar("", matchingCache("grok 1.0.4 (x) [stable]"));
    const result = await runCompatibility(sidebar);
    expect(result).toMatchObject({
      planModeAvailable: true,
      planModeVersionVerified: false,
      usedCache: true,
      cliVersion: "1.0.4",
    });
  });

  it("timeout + cached-good keeps Plan available and unverified", async () => {
    const sidebar = makeSidebar("", matchingCache("grok 0.2.117 (x) [stable]"));
    const result = await runCompatibility(sidebar);
    expect(result).toMatchObject({
      planModeAvailable: true,
      planModeVersionVerified: false,
      usedCache: true,
      cliVersion: "0.2.117",
    });
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(
      "grok --version failed; using last verified version for Plan mode.",
    );
    expect(sidebar.host.showWarningMessage).not.toHaveBeenCalled();

    const session = new Session();
    sidebar.applyPlanModeCompatibility(session, result);
    expect(session.planModeAvailable).toBe(true);
    expect(session.planModeVersionVerified).toBe(false);
    expect(sidebar.emit).toHaveBeenCalledWith(session, {
      type: "planModeAvailability",
      available: true,
      reason: undefined,
      recheckable: false,
    });
  });

  it("timeout + cached-old stays unavailable, recheckable, and retryable", async () => {
    const sidebar = makeSidebar("", matchingCache("grok 0.2.100 (x) [stable]"));
    const result = await runCompatibility(sidebar);
    expect(result).toMatchObject({
      planModeAvailable: false,
      planModeVersionVerified: false,
      usedCache: true,
      planModeUnavailableReason: PLAN_MODE_UNVERIFIED_REASON,
    });
    expect(result.planModeUnavailableReason).not.toContain("installed version is");

    const session = new Session();
    sidebar.applyPlanModeCompatibility(session, result);
    expect(session.planModeVersionVerified).toBe(false);
    expect(sidebar.emit).toHaveBeenCalledWith(session, {
      type: "planModeAvailability",
      available: false,
      reason: PLAN_MODE_UNVERIFIED_REASON,
      recheckable: true,
    });
  });

  it("a live probe stays verified, is not recheckable, and writes the cache", async () => {
    const sidebar = makeSidebar("grok 0.2.117 (x) [stable]");
    const result = await runCompatibility(sidebar);
    expect(result).toMatchObject({
      planModeAvailable: true,
      planModeVersionVerified: true,
      usedCache: false,
      cliVersion: "0.2.117",
    });
    const identity = readCliBinaryIdentity(cliPath);
    if (!identity) throw new Error("expected identity for temp CLI");
    const cache = sidebar.store[CLI_VERSION_CACHE_KEY] as CliVersionCache;
    expect(cache[identity.path]?.versionOutput).toBe("grok 0.2.117 (x) [stable]");

    const session = new Session();
    sidebar.applyPlanModeCompatibility(session, result);
    expect(sidebar.emit).toHaveBeenCalledWith(session, {
      type: "planModeAvailability",
      available: true,
      reason: undefined,
      recheckable: false,
    });
  });

  it("a later live probe replaces a cache-derived verdict in both directions", async () => {
    const sidebar = makeSidebar("", matchingCache("grok 0.2.117 (x) [stable]"));
    const cachedGood = await runCompatibility(sidebar);
    expect(cachedGood.planModeAvailable).toBe(true);
    expect(cachedGood.planModeVersionVerified).toBe(false);

    sidebar.readGrokVersion = vi.fn(async () => "grok 0.2.100 (x) [stable]");
    const liveOld = await runCompatibility(sidebar);
    expect(liveOld).toMatchObject({
      planModeAvailable: false,
      planModeVersionVerified: true,
      usedCache: false,
    });
    expect(liveOld.planModeUnavailableReason).toContain("installed version is 0.2.100");

    sidebar.readGrokVersion = vi.fn(async () => "");
    const cachedOld = await runCompatibility(sidebar);
    expect(cachedOld).toMatchObject({
      planModeAvailable: false,
      planModeVersionVerified: false,
      planModeUnavailableReason: PLAN_MODE_UNVERIFIED_REASON,
    });

    sidebar.readGrokVersion = vi.fn(async () => "grok 0.2.117 (x) [stable]");
    const liveNew = await runCompatibility(sidebar);
    expect(liveNew).toMatchObject({
      planModeAvailable: true,
      planModeVersionVerified: true,
      usedCache: false,
    });
  });
});
