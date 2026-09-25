import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AcpProvider } from "./acp-backend";

/** Account-wide capacity only. Never put the billing response itself on the wire. */
export interface SubscriptionWindow {
  usedPercent: number;
  label: string;
  periodType: string;
  periodStart?: string;
  periodEnd?: string;
  observedAt: string;
}

const isoDate = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};
const percentage = (value: unknown, scale = 1): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(100, value * scale) : undefined;

/** Only WEEKLY has been measured (SuperGrok Heavy, 2026-09-13), and the enum
 *  name says there are siblings. Gating on it would blank the panel for every
 *  other plan forever — but `creditUsagePercent` sits on `config`, not on the
 *  period, so it means the same thing whatever the period is; the period only
 *  supplies the dates. An unrecognized type therefore keeps the number under a
 *  label that claims no period length, rather than guessing "Weekly" or
 *  showing nothing. */
const GROK_PERIOD_LABELS: Record<string, string> = {
  USAGE_PERIOD_TYPE_WEEKLY: "Weekly",
};

export function grokSubscriptionWindows(raw: any, now = Date.now()): SubscriptionWindow[] {
  const config = raw?.config;
  const usedPercent = percentage(config?.creditUsagePercent);
  const period = config?.currentPeriod;
  const periodType = typeof period?.type === "string" ? period.type.trim() : "";
  const periodStart = isoDate(period?.start);
  const periodEnd = isoDate(period?.end);
  if (usedPercent === undefined || !periodType
    || !periodStart || !periodEnd || periodEnd <= periodStart) return [];
  return [{ usedPercent, label: GROK_PERIOD_LABELS[periodType] ?? "Current period", periodType,
    periodStart, periodEnd, observedAt: new Date(now).toISOString() }];
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_overage_included: "Weekly · included overage",
  overage: "Overage",
};

/** undefined = no event; [] = an event without a usable measurement.
 *
 *  `utilization` here is a FRACTION (0..1), hence the x100 — and this is the
 *  one line in the file most likely to be "corrected" into a bug, because the
 *  SDK's *other* utilization means the opposite. `SDKControlGetUsageResponse`
 *  (the `/usage` command's shape, from the claude.ai usage endpoint) documents
 *  "Percentage of the window used, 0-100", and the adapter's own renderer
 *  prints it as `${utilization}%`. Same word, same vendor, different scale.
 *
 *  MEASURED in the shipped Claude binary, 2026-09-14: `rate_limit_info` is
 *  built from the response headers (`anthropic-ratelimit-unified-*`), and the
 *  CLI's own key for those objects is `Math.round(e.utilization*100)`. Getting
 *  this backwards does not fail visibly — it pins every user at 100% used,
 *  which reads as "you are out of quota". Do not change it without re-measuring. */
export function claudeSubscriptionWindows(update: any, now = Date.now()): SubscriptionWindow[] | undefined {
  if (update?.sessionUpdate !== "usage_update") return undefined;
  const rate = update?._meta?.["_claude/rateLimit"];
  if (rate === undefined) return undefined;
  const usedPercent = percentage(rate?.utilization, 100);
  const periodType = rate?.rateLimitType;
  const label = typeof periodType === "string" && Object.prototype.hasOwnProperty.call(CLAUDE_WINDOW_LABELS, periodType)
    ? CLAUDE_WINDOW_LABELS[periodType] : undefined;
  if (usedPercent === undefined || !label) return [];
  let periodEnd: string | undefined;
  if (rate.resetsAt !== undefined) {
    if (typeof rate.resetsAt !== "number" || !Number.isFinite(rate.resetsAt) || rate.resetsAt <= 0) return [];
    const reset = new Date(rate.resetsAt * 1000);
    if (!Number.isFinite(reset.getTime())) return [];
    periodEnd = reset.toISOString();
  }
  return [{ usedPercent, label, periodType, ...(periodEnd ? { periodEnd } : {}),
    observedAt: new Date(now).toISOString() }];
}

/** Codex publishes its account windows NOWHERE on the wire we speak: the
 *  adapter receives `account/rateLimits/updated`, files it into its own session
 *  state for the `/status` markdown, and returns null to the client (measured
 *  in @agentclientprotocol/codex-acp, 2026-09-14). What it does do is write
 *  each one into the session's rollout as a `token_count` event, so that file
 *  is the only structured source a client can read without occupying the
 *  session with a prompt.
 *
 *  That makes this a read of a VENDOR-PRIVATE on-disk format, and the failure
 *  mode when Codex changes it is the one to keep: every field below is checked,
 *  and an unrecognized record yields NO window rather than a wrong number. The
 *  panel then says the same thing it says today.
 *
 *  `usedPercent` here is already 0..100 (`used_percent: 50.0` = half the
 *  weekly allowance), unlike Claude's 0..1 fraction two functions up. */
const CODEX_WINDOW_LABELS: Record<number, string> = {
  300: "5-hour",
  1440: "Daily",
  10080: "Weekly",
  43200: "Monthly",
};

/** A window we have no name for still has a length, and saying "10,080 minutes"
 *  is not saying it. Hours up to a day, then days — and never a guess. */
export function codexWindowLabel(windowMinutes: unknown): string | undefined {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return undefined;
  const named = CODEX_WINDOW_LABELS[windowMinutes];
  if (named) return named;
  if (windowMinutes < 60) return `${Math.round(windowMinutes)}-minute`;
  if (windowMinutes < 1440) return `${Math.round(windowMinutes / 60)}-hour`;
  return `${Math.round(windowMinutes / 1440)}-day`;
}

function codexWindow(slot: string, raw: any, observedAt: string): SubscriptionWindow | undefined {
  const usedPercent = percentage(raw?.used_percent);
  const label = codexWindowLabel(raw?.window_minutes);
  if (usedPercent === undefined || !label) return undefined;
  // Unix SECONDS, like Claude's resetsAt. A present-but-unusable value is a
  // record we do not understand, so it takes the window with it.
  let periodEnd: string | undefined;
  if (raw.resets_at !== undefined && raw.resets_at !== null) {
    if (typeof raw.resets_at !== "number" || !Number.isFinite(raw.resets_at) || raw.resets_at <= 0) return undefined;
    const reset = new Date(raw.resets_at * 1000);
    if (!Number.isFinite(reset.getTime())) return undefined;
    periodEnd = reset.toISOString();
  }
  return { usedPercent, label, periodType: `${slot}_${raw.window_minutes}m`,
    ...(periodEnd ? { periodEnd } : {}), observedAt };
}

/** `rateLimits` as Codex writes it, plus when it was written. */
export function codexSubscriptionWindows(rateLimits: any, observedAt: string): SubscriptionWindow[] {
  if (!isoDate(observedAt)) return [];
  const at = isoDate(observedAt)!;
  return ["primary", "secondary"]
    .map((slot) => codexWindow(slot, rateLimits?.[slot], at))
    .filter((window): window is SubscriptionWindow => window !== undefined);
}

/** `resetsAtMs` is epoch milliseconds. Claude's `resetsAt` and Codex's
 *  `resets_at` are Unix seconds — multiplying this stamp puts the reset
 *  tens of thousands of years out. `usedPercent` is already 0..100. `tier`
 *  stays off the wire. A window we cannot label is dropped, not guessed. */
function musePeriodEnd(resetsAtMs: unknown): string | undefined {
  if (typeof resetsAtMs !== "number" || !Number.isFinite(resetsAtMs) || resetsAtMs <= 0) return undefined;
  const reset = new Date(resetsAtMs);
  return Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined;
}

export function museSubscriptionWindows(usage: any, now = Date.now()): SubscriptionWindow[] {
  if (!usage || typeof usage !== "object") return [];
  const observedAt = new Date(now).toISOString();
  const windows: SubscriptionWindow[] = [];
  const rolling = usage.window;
  const rollingPercent = percentage(rolling?.usedPercent);
  const rollingLabel = codexWindowLabel(rolling?.windowDurationMins);
  const rollingEnd = musePeriodEnd(rolling?.resetsAtMs);
  if (rollingPercent !== undefined && rollingLabel && rollingEnd) {
    windows.push({ usedPercent: rollingPercent, label: rollingLabel,
      periodType: `window_${rolling.windowDurationMins}m`, periodEnd: rollingEnd, observedAt });
  }
  const weekly = usage.weekly;
  const weeklyPercent = percentage(weekly?.usedPercent);
  const weeklyEnd = musePeriodEnd(weekly?.resetsAtMs);
  if (weeklyPercent !== undefined && weeklyEnd) {
    windows.push({ usedPercent: weeklyPercent, label: "Weekly", periodType: "weekly",
      periodEnd: weeklyEnd, observedAt });
  }
  return windows;
}

export const SUBSCRIPTION_USAGE_MIN_INTERVAL_MS = 60_000;

/** Shared only by processes with the same effective credential context. No timers. */
export class SubscriptionUsageCache {
  windows: SubscriptionWindow[] = [];
  private attemptedAt = -Infinity;
  private pending?: Promise<void>;
  private revision = 0;

  invalidate(): void {
    this.revision++;
    this.windows = [];
    this.attemptedAt = -Infinity;
    this.pending = undefined;
  }

  async refresh(read: () => Promise<SubscriptionWindow[]>, now = Date.now()): Promise<void> {
    if (this.pending) return this.pending;
    if (now - this.attemptedAt < SUBSCRIPTION_USAGE_MIN_INTERVAL_MS) return;
    this.attemptedAt = now;
    const revision = this.revision;
    const pending = (async () => {
      let windows: SubscriptionWindow[] = [];
      try { windows = await read(); } catch { /* Optional read: absence is not zero. */ }
      if (revision === this.revision) this.windows = windows;
    })();
    this.pending = pending;
    await pending;
    if (this.pending === pending) this.pending = undefined;
  }
}

/** A running CLI may retain its old login. Never rebind it to a new account. */
export class SubscriptionUsageBinding {
  private retired = false;
  constructor(
    readonly cache: SubscriptionUsageCache,
    private readonly context: string,
    private readonly currentContext: () => string,
  ) {}
  invalidate(): void { this.retired = true; this.cache.invalidate(); }
  current(): boolean {
    if (!this.retired && this.context !== this.currentContext()) this.invalidate();
    return !this.retired;
  }
  snapshot(): SubscriptionWindow[] { return this.current() ? this.cache.windows : []; }
  observe(windows: SubscriptionWindow[]): void { if (this.current()) this.cache.windows = windows; }
  async refresh(read: () => Promise<SubscriptionWindow[]>): Promise<void> {
    if (this.current()) await this.cache.refresh(async () => {
      const windows = await read();
      return this.current() ? windows : [];
    });
  }
}

/** Opaque, memory-only key. Neither credentials nor their digest leave the host.
 * File contents also detect an external login; unreadable stores fail closed.
 * Keychain-only Claude logins are bounded by process lifetime and host sign-out. */
const CREDENTIAL_ENV_KEYS: Partial<Record<AcpProvider, string[]>> = {
  grok: ["GROK_CODE_XAI_API_KEY", "XAI_API_KEY", "GROK_CODE_BASE_URL"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
};

/** The file each CLI writes its login to, relative to that CLI's home. */
const CREDENTIAL_FILES: Partial<Record<AcpProvider, string>> = {
  grok: "auth.json",
  claude: ".credentials.json",
  codex: "auth.json",
};

export function subscriptionCredentialContext(provider: AcpProvider, env: NodeJS.ProcessEnv): string {
  if (provider === "muse") return "muse:cli-owned";
  const home = env.HOME || env.USERPROFILE || homedir();
  const root = provider === "grok" ? env.GROK_HOME || path.join(home, ".grok")
    : provider === "codex" ? env.CODEX_HOME || path.join(home, ".codex")
      : env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const keys = CREDENTIAL_ENV_KEYS[provider] ?? [];
  const effectiveEnv: NodeJS.ProcessEnv = { ...env, GROK_CODE_XAI_API_KEY: env.GROK_CODE_XAI_API_KEY || env.XAI_API_KEY };
  const hash = createHash("sha256").update(JSON.stringify([provider, root, keys.map((key) => effectiveEnv[key] ?? null)]));
  try { hash.update(readFileSync(path.join(root, CREDENTIAL_FILES[provider]!))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `${provider}:unreadable:${randomUUID()}`;
    hash.update("absent");
  }
  return `${provider}:${hash.digest("hex")}`;
}
