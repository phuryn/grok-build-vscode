import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  locateGrokCli,
  extensionWasUpgraded,
  parseGrokVersion,
  compareVersionTuple,
  grokUpdatePolicy,
  shouldReactivelyDowngrade,
  isLockedBinaryError,
  isGrokVersionBelowRequired,
  isStdioBrokenGrokVersion,
  decidePlanModeAvailability,
  probeVersionOutput,
  readCliBinaryIdentity,
  lookupCachedCliVersion,
  storeCachedCliVersion,
  resolvePlanModeAvailability,
  cliVersionCacheKey,
  PLAN_MODE_UNVERIFIED_REASON,
  CLI_VERSION_CACHE_KEY,
  GROK_REQUIRED_VERSION,
  GROK_STDIO_DOWNGRADE_TARGET,
  type CliBinaryIdentity,
  type CliVersionCache,
} from "../src/cli-locator";

// cli-path's shell fallback runs a REAL `where grok` when the PATH scan finds
// nothing, and on a machine with the CLI installed that returns the very binary
// these tests assert is absent. Mock it, as cli-path-discovery.test.ts does.
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execSync: vi.fn(() => { throw new Error("not on PATH"); }),
}));

const IS_WIN = process.platform === "win32";
const FAKE_BIN_NAME = IS_WIN ? "grok.cmd" : "grok";

describe("locateGrokCli", () => {
  let tmpDir: string;
  let fakeBin: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-locate-"));
    fakeBin = path.join(tmpDir, FAKE_BIN_NAME);
    if (IS_WIN) {
      fs.writeFileSync(fakeBin, "@echo mock\r\n");
    } else {
      fs.writeFileSync(fakeBin, "#!/bin/sh\necho mock\n");
      fs.chmodSync(fakeBin, 0o755);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the configured path when it exists", () => {
    expect(locateGrokCli(fakeBin)).toBe(fakeBin);
  });

  it("returns undefined when configured path is missing", () => {
    expect(locateGrokCli(path.join(tmpDir, "missing"))).toBeUndefined();
  });

  it("falls back to PATH when no config and no ~/.grok/bin/grok", () => {
    // An empty home points the ~/.grok/bin probe at a directory with nothing in
    // it, so the PATH scan is what answers and the fake is what it must find.
    const found = locateGrokCli("", { PATH: tmpDir, HOME: tmpDir, USERPROFILE: tmpDir });
    expect(found?.toLowerCase()).toBe(fakeBin.toLowerCase());
  });

  it("returns undefined when nothing found", () => {
    expect(locateGrokCli("", { PATH: "", HOME: tmpDir, USERPROFILE: tmpDir })).toBeUndefined();
  });
});

describe("extensionWasUpgraded", () => {
  it("leaves fresh installs and unchanged versions alone", () => {
    expect(extensionWasUpgraded(undefined, "2.2.0")).toBe(false);
    expect(extensionWasUpgraded("2.2.0", "2.2.0")).toBe(false);
  });

  it("detects an extension version change", () => {
    expect(extensionWasUpgraded("2.1.1", "2.2.0")).toBe(true);
    expect(extensionWasUpgraded("2.2.0", "2.1.1")).toBe(true);
  });
});

describe("parseGrokVersion", () => {
  it("parses the real --version banner", () => {
    expect(parseGrokVersion("grok 0.2.64 (9a9ac25b10) [stable]")).toEqual([0, 2, 64]);
  });

  it("parses a bare version string", () => {
    expect(parseGrokVersion("0.2.60")).toEqual([0, 2, 60]);
  });

  it("parses double-digit and larger components", () => {
    expect(parseGrokVersion("grok 1.10.205 (abc) [alpha]")).toEqual([1, 10, 205]);
  });

  it("returns undefined when no X.Y.Z is present", () => {
    expect(parseGrokVersion("grok (dev build)")).toBeUndefined();
    expect(parseGrokVersion("")).toBeUndefined();
    expect(parseGrokVersion(undefined as unknown as string)).toBeUndefined();
  });
});

describe("compareVersionTuple", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersionTuple([0, 2, 60], [0, 2, 61])).toBeLessThan(0);
    expect(compareVersionTuple([0, 2, 64], [0, 2, 60])).toBeGreaterThan(0);
    expect(compareVersionTuple([0, 2, 60], [0, 2, 60])).toBe(0);
    expect(compareVersionTuple([1, 0, 0], [0, 9, 9])).toBeGreaterThan(0);
    expect(compareVersionTuple([0, 3, 0], [0, 2, 99])).toBeGreaterThan(0);
  });
});

describe("required grok behavior floor", () => {
  it("identifies versions below 0.2.117, including versions outside the old Windows regression", () => {
    for (const version of ["0.1.999", "0.2.60", "0.2.71", "0.2.100", "0.2.116"]) {
      expect(isGrokVersionBelowRequired(`grok ${version} (x) [stable]`)).toBe(true);
    }
    expect(GROK_REQUIRED_VERSION).toBe("0.2.117");
    expect(GROK_STDIO_DOWNGRADE_TARGET).toBe(GROK_REQUIRED_VERSION);
  });

  it("accepts the floor and newer versions, and leaves unverifiable banners to the caller", () => {
    for (const version of ["0.2.117", "0.2.118", "0.3.0", "1.0.0"]) {
      expect(isGrokVersionBelowRequired(`grok ${version} (x) [stable]`)).toBe(false);
    }
    expect(isGrokVersionBelowRequired("grok (dev build)")).toBe(false);
  });
});

describe("decidePlanModeAvailability (#105 — verified-old vs unverified)", () => {
  it("enables Plan for the floor and newer (including 1.0.0)", () => {
    for (const version of ["0.2.117", "0.2.118", "1.0.0"]) {
      expect(decidePlanModeAvailability(`grok ${version} (x) [stable]`)).toEqual({
        available: true,
        verified: true,
      });
    }
  });

  it("disables Plan with a latched verified-old reason for a parseable below-floor CLI", () => {
    const decision = decidePlanModeAvailability("grok 0.2.100 (x) [stable]");
    expect(decision).toEqual({
      available: false,
      verified: true,
      installed: "0.2.100",
      reason: `Plan mode requires Grok CLI ${GROK_REQUIRED_VERSION} or newer; installed version is 0.2.100.`,
    });
    // Distinct from the unverified copy — users must not conclude "too old" from a probe miss.
    expect(decision.reason).toContain("installed version is");
    expect(decision.reason).not.toMatch(/could not verify/i);
  });

  it("fails closed but marks unverified when the banner cannot be parsed", () => {
    for (const banner of ["", "grok (dev build)", "not a version"]) {
      const decision = decidePlanModeAvailability(banner);
      expect(decision.available).toBe(false);
      expect(decision.verified).toBe(false);
      if (decision.available || decision.verified) throw new Error("expected unverified");
      expect(decision.reason).toBe(PLAN_MODE_UNVERIFIED_REASON);
      expect(decision.reason).toMatch(/could not verify/i);
      expect(decision.reason).toMatch(/timed out/i);
      expect(decision.reason).toMatch(/reload/i);
      expect(decision.reason).toContain(GROK_REQUIRED_VERSION);
      expect(decision.reason).not.toContain("installed version is");
    }
  });

  it("keeps the two unavailable reasons distinguishable", () => {
    const old = decidePlanModeAvailability("grok 0.2.50 (x)");
    const unverified = decidePlanModeAvailability("");
    expect(old.available).toBe(false);
    expect(unverified.available).toBe(false);
    expect(old.verified).toBe(true);
    expect(unverified.verified).toBe(false);
    if (!old.available && old.verified && !unverified.available && !unverified.verified) {
      expect(old.reason).not.toBe(unverified.reason);
      expect(old.reason).toContain("installed version is 0.2.50");
      expect(unverified.reason).toBe(PLAN_MODE_UNVERIFIED_REASON);
      expect(unverified.reason).toMatch(/could not verify/i);
      expect(unverified.reason).toMatch(/timed out/i);
      expect(unverified.reason).toMatch(/reload/i);
    }
  });
});

describe("probeVersionOutput (#105 — retry empty probe, latch parseable)", () => {
  it("returns the first parseable answer without retrying", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = await probeVersionOutput(
      async () => {
        calls += 1;
        return "grok 0.2.50 (x) [stable]";
      },
      async (ms) => { sleeps.push(ms); },
    );
    expect(out).toBe("grok 0.2.50 (x) [stable]");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("retries once after backoff when the first read is empty, then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = await probeVersionOutput(
      async () => {
        calls += 1;
        return calls === 1 ? "" : "grok 1.0.0 (x) [stable]";
      },
      async (ms) => { sleeps.push(ms); },
      50,
    );
    expect(out).toBe("grok 1.0.0 (x) [stable]");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([50]);
    // End state after fail-then-succeed: Plan available (the behaviour that matters).
    expect(decidePlanModeAvailability(out)).toEqual({ available: true, verified: true });
  });

  it("retries unparseable output once and stays fail-closed if still empty", async () => {
    let calls = 0;
    const out = await probeVersionOutput(
      async () => {
        calls += 1;
        return "";
      },
      async () => {},
    );
    expect(out).toBe("");
    expect(calls).toBe(2);
    const decision = decidePlanModeAvailability(out);
    expect(decision.available).toBe(false);
    expect(decision.verified).toBe(false);
  });

  it("does not retry a parseable below-floor CLI however many times asked", async () => {
    // Simulate "user reaches for Plan" N times: each probe sees a stable old banner.
    for (let i = 0; i < 3; i++) {
      let calls = 0;
      const out = await probeVersionOutput(
        async () => {
          calls += 1;
          return "grok 0.2.100 (x) [stable]";
        },
        async () => { throw new Error("sleep should not run for parseable output"); },
      );
      expect(calls).toBe(1);
      const decision = decidePlanModeAvailability(out);
      expect(decision).toMatchObject({ available: false, verified: true, installed: "0.2.100" });
    }
  });
});

describe("resolvePlanModeAvailability (#105 — cache fallback)", () => {
  const identity: CliBinaryIdentity = { path: cliVersionCacheKey("/home/.grok/bin/grok"), mtimeMs: 1_700_000_000_000, size: 50_000 };
  const newEnough = "grok 0.2.117 (x) [stable]";
  const old = "grok 0.2.100 (x) [stable]";
  const cache: CliVersionCache = {
    [identity.path]: { mtimeMs: identity.mtimeMs, size: identity.size, versionOutput: newEnough },
  };

  it("keeps Plan available when the probe times out but a matching cache exists", async () => {
    let calls = 0;
    const result = await resolvePlanModeAvailability({
      readOnce: async () => {
        calls += 1;
        return "";
      },
      sleep: async () => {},
      identity,
      cache,
    });
    expect(calls).toBe(2);
    expect(result.usedCache).toBe(true);
    expect(result.nextCache).toBeUndefined();
    expect(result.versionOutput).toBe(newEnough);
    expect(result.decision).toEqual({ available: true, verified: false });
  });

  it("fails closed with the retryable unverified reason when there is no cache", async () => {
    const result = await resolvePlanModeAvailability({
      readOnce: async () => "",
      sleep: async () => {},
      identity,
    });
    expect(result.usedCache).toBe(false);
    expect(result.nextCache).toBeUndefined();
    expect(result.versionOutput).toBe("");
    expect(result.decision).toEqual({
      available: false,
      verified: false,
      reason: PLAN_MODE_UNVERIFIED_REASON,
    });
    expect(result.decision.available).toBe(false);
    if (!result.decision.available && !result.decision.verified) {
      expect(result.decision.reason).toMatch(/timed out/i);
      expect(result.decision.reason).toMatch(/reload/i);
    }
  });

  it("gates off a cached below-floor version when the live probe fails", async () => {
    const oldCache: CliVersionCache = {
      [identity.path]: { mtimeMs: identity.mtimeMs, size: identity.size, versionOutput: old },
    };
    const result = await resolvePlanModeAvailability({
      readOnce: async () => "",
      sleep: async () => {},
      identity,
      cache: oldCache,
    });
    expect(result.usedCache).toBe(true);
    expect(result.decision).toEqual({
      available: false,
      verified: false,
      reason: PLAN_MODE_UNVERIFIED_REASON,
    });
    if (!result.decision.available && !result.decision.verified) {
      expect(result.decision.reason).toMatch(/timed out/i);
      expect(result.decision.reason).toMatch(/reload/i);
      expect(result.decision.reason).not.toContain("installed version is");
    }
  });

  it("gates off a live old version even when the cache says the floor", async () => {
    const result = await resolvePlanModeAvailability({
      readOnce: async () => old,
      sleep: async () => { throw new Error("sleep should not run for parseable output"); },
      identity,
      cache,
    });
    expect(result.usedCache).toBe(false);
    expect(result.decision).toMatchObject({ available: false, verified: true, installed: "0.2.100" });
    expect(result.nextCache?.[identity.path]?.versionOutput).toBe(old);
  });

  it("ignores the cache when the binary identity changed", async () => {
    const result = await resolvePlanModeAvailability({
      readOnce: async () => "",
      sleep: async () => {},
      identity: { ...identity, mtimeMs: 9_999, size: 99 },
      cache,
    });
    expect(result.usedCache).toBe(false);
    expect(result.decision).toEqual({
      available: false,
      verified: false,
      reason: PLAN_MODE_UNVERIFIED_REASON,
    });
  });

  it("writes the cache after a successful probe and does not persist a failed one", async () => {
    const written = await resolvePlanModeAvailability({
      readOnce: async () => newEnough,
      sleep: async () => { throw new Error("sleep should not run for parseable output"); },
      identity,
    });
    expect(written.usedCache).toBe(false);
    expect(written.versionOutput).toBe(newEnough);
    expect(written.nextCache?.[identity.path]).toEqual({
      mtimeMs: identity.mtimeMs,
      size: identity.size,
      versionOutput: newEnough,
    });

    const failed = await resolvePlanModeAvailability({
      readOnce: async () => "",
      sleep: async () => {},
      identity,
      cache: written.nextCache,
    });
    expect(failed.usedCache).toBe(true);
    expect(failed.nextCache).toBeUndefined();
    expect(failed.decision).toEqual({ available: true, verified: false });
  });

  it("replaces a cache-derived verdict when a later live probe succeeds, both directions", async () => {
    const goodCache: CliVersionCache = {
      [identity.path]: { mtimeMs: identity.mtimeMs, size: identity.size, versionOutput: newEnough },
    };
    const cachedGood = await resolvePlanModeAvailability({
      readOnce: async () => "",
      sleep: async () => {},
      identity,
      cache: goodCache,
    });
    expect(cachedGood).toMatchObject({ usedCache: true, decision: { available: true, verified: false } });

    const liveOld = await resolvePlanModeAvailability({
      readOnce: async () => old,
      sleep: async () => { throw new Error("sleep should not run for parseable output"); },
      identity,
      cache: goodCache,
    });
    expect(liveOld.usedCache).toBe(false);
    expect(liveOld.decision).toMatchObject({ available: false, verified: true, installed: "0.2.100" });
    expect(liveOld.nextCache?.[identity.path]?.versionOutput).toBe(old);

    const oldCache: CliVersionCache = {
      [identity.path]: { mtimeMs: identity.mtimeMs, size: identity.size, versionOutput: old },
    };
    const cachedOld = await resolvePlanModeAvailability({
      readOnce: async () => "",
      sleep: async () => {},
      identity,
      cache: oldCache,
    });
    expect(cachedOld).toMatchObject({
      usedCache: true,
      decision: { available: false, verified: false, reason: PLAN_MODE_UNVERIFIED_REASON },
    });

    const liveNew = await resolvePlanModeAvailability({
      readOnce: async () => newEnough,
      sleep: async () => { throw new Error("sleep should not run for parseable output"); },
      identity,
      cache: oldCache,
    });
    expect(liveNew.usedCache).toBe(false);
    expect(liveNew.decision).toEqual({ available: true, verified: true });
    expect(liveNew.nextCache?.[identity.path]?.versionOutput).toBe(newEnough);
  });
});

describe("cli version cache identity", () => {
  it("keys Windows paths case-insensitively and Unix paths as normalized", () => {
    if (IS_WIN) {
      expect(cliVersionCacheKey("C:\\Users\\A\\.grok\\bin\\grok.exe"))
        .toBe(cliVersionCacheKey("c:\\users\\a\\.grok\\bin\\grok.exe"));
    } else {
      expect(cliVersionCacheKey("/home/a/.grok/bin/grok")).toBe("/home/a/.grok/bin/grok");
    }
  });

  it("returns identity from stat and drops unreadable or non-finite stamps", () => {
    expect(readCliBinaryIdentity("/x/grok", () => ({ mtimeMs: 10, size: 20 }))).toEqual({
      path: cliVersionCacheKey("/x/grok"),
      mtimeMs: 10,
      size: 20,
    });
    expect(readCliBinaryIdentity("/x/grok", () => { throw new Error("ENOENT"); })).toBeUndefined();
    expect(readCliBinaryIdentity("/x/grok", () => ({ mtimeMs: Number.NaN, size: 20 }))).toBeUndefined();
    expect(readCliBinaryIdentity("")).toBeUndefined();
  });

  it("lookup requires a matching identity and a parseable banner", () => {
    const identity: CliBinaryIdentity = { path: cliVersionCacheKey("/x/grok"), mtimeMs: 1, size: 2 };
    const cache: CliVersionCache = {
      [identity.path]: { mtimeMs: 1, size: 2, versionOutput: "grok 0.2.117 (x)" },
    };
    expect(lookupCachedCliVersion(cache, identity)).toBe("grok 0.2.117 (x)");
    expect(lookupCachedCliVersion(cache, { ...identity, size: 3 })).toBeUndefined();
    expect(lookupCachedCliVersion(undefined, identity)).toBeUndefined();
    expect(lookupCachedCliVersion({ [identity.path]: { mtimeMs: 1, size: 2, versionOutput: "" } }, identity)).toBeUndefined();
  });

  it("store writes only parseable banners and does not mutate the previous store", () => {
    const identity: CliBinaryIdentity = { path: cliVersionCacheKey("/x/grok"), mtimeMs: 1, size: 2 };
    const prev: CliVersionCache = { "/other": { mtimeMs: 9, size: 9, versionOutput: "grok 0.2.118 (x)" } };
    const next = storeCachedCliVersion(prev, identity, "grok 0.2.117 (x)");
    expect(next).toEqual({
      "/other": prev["/other"],
      [identity.path]: { mtimeMs: 1, size: 2, versionOutput: "grok 0.2.117 (x)" },
    });
    expect(prev[identity.path]).toBeUndefined();
    expect(storeCachedCliVersion(prev, identity, "")).toBeUndefined();
    expect(storeCachedCliVersion(prev, undefined, "grok 0.2.117 (x)")).toBeUndefined();
  });

  it("names the persisted globalState key", () => {
    expect(CLI_VERSION_CACHE_KEY).toBe("grok.cliVersionCache");
  });
});

describe("isStdioBrokenGrokVersion (issue #22 bounded proactive pin)", () => {
  it("matches only Windows builds 0.2.61 through 0.2.70", () => {
    for (const version of ["0.2.61", "0.2.64", "0.2.67", "0.2.70"]) {
      expect(isStdioBrokenGrokVersion(`grok ${version} (x) [stable]`, "win32")).toBe(true);
    }
    for (const version of ["0.2.60", "0.2.71", "0.2.117", "0.3.0", "1.0.0"]) {
      expect(isStdioBrokenGrokVersion(`grok ${version} (x) [stable]`, "win32")).toBe(false);
    }
  });

  it("is a no-op off Windows and for unverifiable banners", () => {
    expect(isStdioBrokenGrokVersion("grok 0.2.67 (x) [stable]", "linux")).toBe(false);
    expect(isStdioBrokenGrokVersion("grok 0.2.67 (x) [stable]", "darwin")).toBe(false);
    expect(isStdioBrokenGrokVersion("grok (dev build)", "win32")).toBe(false);
  });
});

describe("grokUpdatePolicy (issue #22 update pause lifted in 0.2.71)", () => {
  it("allows updates on every platform now that the regression is fixed (no block, no pin)", () => {
    for (const plat of ["win32", "linux", "darwin"] as const) {
      for (const v of ["0.2.60", "0.2.67", "0.2.70", "0.2.71", "0.2.72"]) {
        const p = grokUpdatePolicy(`grok ${v} (x) [stable]`, plat);
        expect(p.allow).toBe(true);
        expect(p.target).toBeUndefined();
        expect(p.note).toBeUndefined();
      }
    }
  });

  it("allows when the version is unparseable too", () => {
    const p = grokUpdatePolicy("grok (dev build)", "win32");
    expect(p.allow).toBe(true);
    expect(p.target).toBeUndefined();
  });
});

describe("shouldReactivelyDowngrade (issue #22 — backstop above the verified target)", () => {
  it("downgrades any Windows build ABOVE the supported 0.2.117", () => {
    for (const v of ["0.2.118", "0.2.199", "0.3.0", "1.0.0"]) {
      expect(shouldReactivelyDowngrade(`grok ${v} (x) [stable]`, "win32")).toBe(true);
    }
  });

  it("never downgrades 0.2.117 or below — the loop guard once recovery lands", () => {
    // The behavior floor handles older builds; reactive recovery applies only to
    // a newer build that actually failed startup.
    for (const v of ["0.2.117", "0.2.116", "0.2.72", "0.2.71", "0.2.70", "0.2.60", "0.1.211"]) {
      expect(shouldReactivelyDowngrade(`grok ${v} (x) [stable]`, "win32")).toBe(false);
    }
  });

  it("is Windows-only", () => {
    for (const plat of ["linux", "darwin"] as const) {
      expect(shouldReactivelyDowngrade("grok 0.2.99 (x) [stable]", plat)).toBe(false);
    }
  });

  it("leaves an unparseable version alone (no spurious downgrade)", () => {
    expect(shouldReactivelyDowngrade("grok (dev build)", "win32")).toBe(false);
    expect(shouldReactivelyDowngrade("", "win32")).toBe(false);
  });
});

describe("isLockedBinaryError (CLI-update lock retry)", () => {
  it("detects grok's real locked-executable failure (worth a retry)", () => {
    const real =
      "Command failed: C:\\Users\\Dell\\.grok\\bin\\grok.exe update\n" +
      "Error: Auto-update failed: cannot rename locked executable " +
      "C:\\Users\\Dell\\.grok\\bin\\grok.exe: Access is denied. (os error 5)";
    expect(isLockedBinaryError(real)).toBe(true);
  });

  it("matches each lock signature independently and is case-insensitive", () => {
    expect(isLockedBinaryError("cannot rename LOCKED EXECUTABLE")).toBe(true);
    expect(isLockedBinaryError("Access is Denied.")).toBe(true);
    expect(isLockedBinaryError("failed (os error 5)")).toBe(true);
  });

  it("does not match unrelated update failures (those are real, no retry)", () => {
    expect(isLockedBinaryError("network timeout while downloading grok")).toBe(false);
    expect(isLockedBinaryError("ENOENT: grok not found")).toBe(false);
    expect(isLockedBinaryError("")).toBe(false);
  });
});
