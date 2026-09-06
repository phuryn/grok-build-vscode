import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

const IS_WIN = process.platform === "win32";

function candidateNames(): string[] {
  return IS_WIN ? ["grok.cmd", "grok.exe", "grok.bat", "grok"] : ["grok"];
}

function effectiveHome(): string {
  // Respect env overrides first so tests + users can redirect the home lookup.
  const fromEnv = IS_WIN ? process.env.USERPROFILE : process.env.HOME;
  return fromEnv || homedir();
}

export function locateGrokCli(configuredPath: string): string | undefined {
  if (configuredPath) {
    return existsSync(configuredPath) ? configuredPath : undefined;
  }
  const homeBin = path.join(effectiveHome(), ".grok", "bin");
  for (const name of candidateNames()) {
    const candidate = path.join(homeBin, name);
    if (existsSync(candidate)) return candidate;
  }
  const pathVar = process.env.PATH || process.env.Path || "";
  const sep = IS_WIN ? ";" : ":";
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const name of candidateNames()) {
      const candidate = path.join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  try {
    const cmd = IS_WIN ? "where grok" : "command -v grok";
    const out = execSync(cmd, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && existsSync(first)) return first;
  } catch {
    // ignore — not on PATH
  }
  return undefined;
}

/** Whether this activation follows a previously-recorded extension version. */
export function extensionWasUpgraded(lastSeen: string | undefined, current: string): boolean {
  return !!lastSeen && !!current && lastSeen !== current;
}

/**
 * Oldest grok CLI whose ACP behavior this extension supports. Native
 * exit_plan_mode verdicts are part of this contract, so every platform must
 * meet this floor. It is also the Windows-verified reactive recovery target.
 */
export const GROK_REQUIRED_VERSION = "0.2.117";

// Reactive Windows stdio recovery lands on the same fully-supported baseline.
export const GROK_STDIO_DOWNGRADE_TARGET = GROK_REQUIRED_VERSION;

/**
 * Parse a grok `--version` banner ("grok 0.2.64 (9a9ac25b10) [stable]") into a
 * `[major, minor, patch]` tuple, or undefined when no `X.Y.Z` is present. Pure.
 */
export function parseGrokVersion(versionOutput: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput ?? "");
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two `[major, minor, patch]` tuples: <0, 0, or >0. Pure. */
export function compareVersionTuple(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Windows grok 0.2.61-0.2.70 can hang before ACP startup completes. */
export function isStdioBrokenGrokVersion(versionOutput: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const version = parseGrokVersion(versionOutput);
  if (!version) return false;
  const [major, minor, patch] = version;
  return major === 0 && minor === 2 && patch >= 61 && patch <= 70;
}

/** Whether a parseable installed CLI is older than the behavior baseline. */
export function isGrokVersionBelowRequired(versionOutput: string): boolean {
  const installed = parseGrokVersion(versionOutput);
  const required = parseGrokVersion(GROK_REQUIRED_VERSION)!;
  return !!installed && compareVersionTuple(installed, required) < 0;
}

/**
 * Pause between an empty/unparseable `grok --version` and one retry. A fresh
 * binary's first spawn is often the slow one (Windows AV scanning); a second
 * attempt a beat later is usually instant. Only "no answer" retries — a
 * parseable below-floor banner is a stable answer and must not be re-probed.
 */
export const VERSION_PROBE_RETRY_BACKOFF_MS = 400;

/**
 * Read version with one short retry when the first attempt yields nothing
 * parseable. `readOnce` / `sleep` are injected so unit tests stay process-free.
 */
export async function probeVersionOutput(
  readOnce: () => Promise<string>,
  sleep: (ms: number) => Promise<void>,
  backoffMs = VERSION_PROBE_RETRY_BACKOFF_MS,
): Promise<string> {
  const first = (await readOnce())?.trim() ?? "";
  if (parseGrokVersion(first)) return first;
  await sleep(backoffMs);
  return (await readOnce())?.trim() ?? "";
}

/**
 * Last successfully parsed `grok --version` banner for one resolved CLI path.
 * `mtimeMs` + `size` are the binary's identity: a replaced file must not inherit
 * the previous verdict. Persisted under {@link CLI_VERSION_CACHE_KEY}.
 */
export type CachedCliVersion = {
  mtimeMs: number;
  size: number;
  versionOutput: string;
};

/** Resolved-path → last verified banner. Path keys are {@link cliVersionCacheKey}. */
export type CliVersionCache = Record<string, CachedCliVersion>;

export type CliBinaryIdentity = {
  path: string;
  mtimeMs: number;
  size: number;
};

/** globalState key for {@link CliVersionCache}. Not in DISK_KEYS — this is a local binary. */
export const CLI_VERSION_CACHE_KEY = "grok.cliVersionCache";

/**
 * Unverified-probe copy. Names the likely cause (failed/timed-out check) and the
 * fix (pick Plan again / reload) so it does not read as a permanent "too old".
 */
export const PLAN_MODE_UNVERIFIED_REASON =
  `Could not verify the installed Grok CLI version, so Plan mode is unavailable. ` +
  `The version check failed or timed out — a first run after install can be slow. ` +
  `Pick Plan again or reload the window to retry. ` +
  `Once verified, Plan requires ${GROK_REQUIRED_VERSION} or newer.`;

/** Stable cache key for a resolved CLI path (Windows is case-insensitive). */
export function cliVersionCacheKey(cliPath: string): string {
  const normalized = path.normalize(cliPath);
  return IS_WIN ? normalized.toLowerCase() : normalized;
}

function defaultCliStat(cliPath: string): { mtimeMs: number; size: number } {
  const st = statSync(cliPath);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

/** Identity of the file at `cliPath`, or undefined when it cannot be measured. */
export function readCliBinaryIdentity(
  cliPath: string,
  stat: (p: string) => { mtimeMs: number; size: number } = defaultCliStat,
): CliBinaryIdentity | undefined {
  if (!cliPath) return undefined;
  try {
    const st = stat(cliPath);
    if (!Number.isFinite(st.mtimeMs) || !Number.isFinite(st.size) || st.size < 0) return undefined;
    return { path: cliVersionCacheKey(cliPath), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

/**
 * Cached banner only when the on-disk file is still the one we measured.
 * Missing identity or a mtime/size mismatch is a miss — never a guess.
 */
export function lookupCachedCliVersion(
  cache: CliVersionCache | undefined,
  identity: CliBinaryIdentity | undefined,
): string | undefined {
  if (!cache || !identity) return undefined;
  const entry = cache[identity.path];
  if (!entry || typeof entry !== "object") return undefined;
  if (entry.mtimeMs !== identity.mtimeMs || entry.size !== identity.size) return undefined;
  if (typeof entry.versionOutput !== "string" || !parseGrokVersion(entry.versionOutput)) return undefined;
  return entry.versionOutput;
}

/** Merge a freshly parsed banner into the store. Undefined when there is nothing to persist. */
export function storeCachedCliVersion(
  cache: CliVersionCache | undefined,
  identity: CliBinaryIdentity | undefined,
  versionOutput: string,
): CliVersionCache | undefined {
  if (!identity || !parseGrokVersion(versionOutput)) return undefined;
  return {
    ...(cache ?? {}),
    [identity.path]: {
      mtimeMs: identity.mtimeMs,
      size: identity.size,
      versionOutput,
    },
  };
}

/**
 * Plan-mode gate from a `grok --version` banner. Fail-closed when the banner
 * cannot be parsed (`verified:false` — re-checkable later) or when the install
 * is below the floor (`verified:true` — latched for that process). A cache
 * substitute may keep `available` but is never `verified`. Pure.
 */
export type PlanModeAvailabilityDecision =
  | { available: true; verified: boolean }
  | { available: false; verified: true; installed: string; reason: string }
  | { available: false; verified: false; reason: string };

export function decidePlanModeAvailability(versionOutput: string): PlanModeAvailabilityDecision {
  const parsed = parseGrokVersion(versionOutput);
  if (!parsed) {
    // Lead with "could not verify" — leading with the version floor reads as
    // "your CLI is too old" when the probe simply did not answer (#105).
    return {
      available: false,
      verified: false,
      reason: PLAN_MODE_UNVERIFIED_REASON,
    };
  }
  const installed = parsed.join(".");
  if (isGrokVersionBelowRequired(versionOutput)) {
    return {
      available: false,
      verified: true,
      installed,
      reason:
        `Plan mode requires Grok CLI ${GROK_REQUIRED_VERSION} or newer; ` +
        `installed version is ${installed}.`,
    };
  }
  return { available: true, verified: true };
}

export type PlanModeAvailabilityResolution = {
  decision: PlanModeAvailabilityDecision;
  /** Present only after a parseable live probe, so the host can persist it. */
  nextCache?: CliVersionCache;
  usedCache: boolean;
  /** Live banner, else the matching cache banner, else the unparseable probe text. */
  versionOutput: string;
};

/**
 * Probe (one retry on empty/unparseable) then decide Plan availability.
 * A failed probe may use {@link lookupCachedCliVersion}; a successful probe
 * always wins and is what gets written back. A cache hit keeps that
 * availability but is never `verified` — the host must not latch Plan from a
 * stand-in banner. Injected I/O keeps this process-free.
 */
export async function resolvePlanModeAvailability(opts: {
  readOnce: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  identity?: CliBinaryIdentity;
  cache?: CliVersionCache;
  backoffMs?: number;
}): Promise<PlanModeAvailabilityResolution> {
  const versionOutput = await probeVersionOutput(opts.readOnce, opts.sleep, opts.backoffMs);
  if (parseGrokVersion(versionOutput)) {
    return {
      decision: decidePlanModeAvailability(versionOutput),
      nextCache: storeCachedCliVersion(opts.cache, opts.identity, versionOutput),
      usedCache: false,
      versionOutput,
    };
  }
  const cached = lookupCachedCliVersion(opts.cache, opts.identity);
  if (cached) {
    const fromBanner = decidePlanModeAvailability(cached);
    // Cache is a substitute, not a live reading — keep availability, drop latch.
    const decision: PlanModeAvailabilityDecision = fromBanner.available
      ? { available: true, verified: false }
      : { available: false, verified: false, reason: PLAN_MODE_UNVERIFIED_REASON };
    return { decision, usedCache: true, versionOutput: cached };
  }
  return { decision: decidePlanModeAvailability(versionOutput), usedCache: false, versionOutput };
}

/**
 * Decision for "Update Grok Build CLI" (manual and extension-upgrade updates),
 * given the installed version + platform.
 *
 * The #22 Windows update pause is **lifted** now that 0.2.71 fixes the regression —
 * updates proceed normally on every platform (to `latest`). The behavior floor
 * handles old builds; reactive recovery handles a newer Windows build that
 * actually exhibits the stdio failure.
 */
export interface GrokUpdatePolicy {
  /** May the update run at all? */
  allow: boolean;
  /** When allowed, pin to this exact version instead of `latest` (undefined ⇒ latest). */
  target?: string;
  /** When blocked, the reason to surface in the menu / log. */
  note?: string;
}

export function grokUpdatePolicy(_versionOutput: string, _platform: NodeJS.Platform): GrokUpdatePolicy {
  // Updates are no longer gated for #22 (fixed in 0.2.71). Always allow, to latest.
  return { allow: true };
}

/**
 * Should the host REACTIVELY downgrade the CLI after an *observed* `agent stdio`
 * init failure (handshake timeout / "exited code null")?
 *
 * The proactive bounded-range pin covers known-broken Windows builds before
 * spawning. This is the evidence-driven backstop for a future still-broken build
 * above the Windows-verified target. It fires on the real failure (`initialize` or
 * `session/new`), not a version guess, and restores the supported baseline.
 *
 * Windows-only (the regression is). A build at/below the target is never
 * reactively replaced; that is the loop guard once recovery lands. A later
 * manual upgrade above the target re-arms recovery. Unparseable version means
 * leave it alone. Pure.
 */
export function shouldReactivelyDowngrade(versionOutput: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const v = parseGrokVersion(versionOutput);
  if (!v) return false;
  const target = parseGrokVersion(GROK_STDIO_DOWNGRADE_TARGET)!;
  return compareVersionTuple(v, target) > 0;
}

/**
 * Does a failed `grok update` error mean the binary was still locked? On Windows
 * `grok update` renames `grok.exe` in place, which fails while any grok process
 * (or a backgrounded subagent child) still holds it open — the OS releases the
 * lock a beat after the process is killed, so a too-eager update races it. grok
 * reports this as *"cannot rename locked executable … Access is denied. (os error
 * 5)"*. Used to decide whether a retry is worth it (the lock clears on its own);
 * any other failure is real and shouldn't be retried. Pure.
 */
export function isLockedBinaryError(message: string): boolean {
  return /locked executable|os error 5|access is denied/i.test(message);
}
