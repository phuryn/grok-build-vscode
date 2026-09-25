import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  grokSubscriptionWindows, claudeSubscriptionWindows, museSubscriptionWindows, subscriptionCredentialContext,
  SubscriptionUsageBinding, SubscriptionUsageCache, SUBSCRIPTION_USAGE_MIN_INTERVAL_MS,
} from "../src/subscription-usage";
import { GrokSidebar } from "../src/sidebar";
import { Session, sessionUiSnapshot } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { OUTBOUND_DISPOSITION, OUTBOUND_PROJECT_AUTH, transformHostMsgForRemote, mayDeliverRemoteHostMsg } from "../src/remote-policy";

const start = "2026-09-12T00:00:00.000Z";
const end = "2026-09-19T00:00:00.000Z";
const now = Date.parse("2026-09-14T00:00:00.000Z");
const billing = (percent: unknown = 3) => ({ config: {
  creditUsagePercent: percent,
  currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
  onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 4426 },
  isUnifiedBillingUser: true, billingPeriodStart: start, billingPeriodEnd: "2026-10-01T00:00:00Z",
}, subscription_tier: "SuperGrok Heavy" });
const windows = () => grokSubscriptionWindows(billing(), now);
const rateUpdate = (rate: object) => ({ sessionUpdate: "usage_update", _meta: { "_claude/rateLimit": rate } });

describe("subscription usage normalization and wire", () => {
  it("mirrors only the minimized account window within project authorization", async () => {
    const message = { type: "subscriptionUsage" as const, windows: windows() };
    expect(OUTBOUND_DISPOSITION.subscriptionUsage).toBe("mirror");
    expect(OUTBOUND_PROJECT_AUTH.subscriptionUsage).toBe("scope");
    expect(mayDeliverRemoteHostMsg(message, ["/proj"], "/proj", (a, b) => a === b)).toBe(true);
    expect(mayDeliverRemoteHostMsg(message, [], "/proj", (a, b) => a === b)).toBe(false);
    const remote = await transformHostMsgForRemote(message, {} as any);
    expect(remote).toEqual({ type: "subscriptionUsage", windows: [{
      usedPercent: 3, label: "Weekly", periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      periodStart: start, periodEnd: end, observedAt: new Date(now).toISOString(),
    }] });
    for (const field of ["prepaidBalance", "onDemandCap", "onDemandUsed", "isUnifiedBillingUser",
      "billingPeriodStart", "billingPeriodEnd", "subscription_tier", "config"]) {
      expect(JSON.stringify(remote)).not.toContain(field);
    }
    expect(JSON.stringify(remote)).not.toContain("2026-10-01");
  });

  it.each([undefined, null, "3", NaN, Infinity, -1])("rejects missing/malformed percentage %s", (percent) => {
    const raw = billing();
    raw.config.creditUsagePercent = percent;
    expect(grokSubscriptionWindows(raw)).toEqual([]);
  });
  it("preserves real zero, clamps over-limit usage and requires a valid current period", () => {
    expect(grokSubscriptionWindows(billing(0))[0].usedPercent).toBe(0);
    expect(grokSubscriptionWindows(billing(102))[0].usedPercent).toBe(100);
    expect(grokSubscriptionWindows({ config: { ...billing().config, currentPeriod: undefined } })).toEqual([]);
    for (const currentPeriod of [{ type: "USAGE_PERIOD_TYPE_WEEKLY", start, end: "invalid" },
      { type: "USAGE_PERIOD_TYPE_WEEKLY", start: end, end: start }]) {
      expect(grokSubscriptionWindows({ config: { ...billing().config, currentPeriod } })).toEqual([]);
    }
  });

  it("keeps an unrecognized Grok period rather than blanking the panel for that plan", () => {
    // Only WEEKLY has ever been measured. Gating on it would leave any other
    // plan reading "No subscription usage reported yet." for ever, with the
    // number sitting right there in the response.
    const currentPeriod = { type: "USAGE_PERIOD_TYPE_MONTHLY", start, end };
    const [window] = grokSubscriptionWindows({ config: { ...billing().config, currentPeriod } }, now);
    expect(window).toMatchObject({ usedPercent: 3, periodType: "USAGE_PERIOD_TYPE_MONTHLY" });
    // ...but it must not claim a period length it does not know.
    expect(window.label).toBe("Current period");
    for (const type of [undefined, "", "   ", 7]) {
      expect(grokSubscriptionWindows({ config: { ...billing().config, currentPeriod: { type, start, end } } }))
        .toEqual([]);
    }
  });

  it("labels singular Claude windows and never manufactures their missing start/reset", () => {
    for (const [rateLimitType, label] of Object.entries({ five_hour: "5-hour", seven_day: "Weekly",
      seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet",
      seven_day_overage_included: "Weekly · included overage", overage: "Overage" })) {
      expect(claudeSubscriptionWindows(rateUpdate({ utilization: 0.3, rateLimitType }), now)).toEqual([
        { usedPercent: 30, label, periodType: rateLimitType, observedAt: new Date(now).toISOString() },
      ]);
    }
    expect(claudeSubscriptionWindows({ sessionUpdate: "usage_update" })).toBeUndefined();
    expect(claudeSubscriptionWindows(rateUpdate({ rateLimitType: "five_hour" }))).toEqual([]);
    expect(claudeSubscriptionWindows(rateUpdate({ utilization: 0, rateLimitType: "five_hour", resetsAt: "123" }))).toEqual([]);
    expect(claudeSubscriptionWindows(rateUpdate({ utilization: 0, rateLimitType: "toString" }))).toEqual([]);
  });

  it("reads Muse resetsAtMs as milliseconds, labels both windows, and clamps", () => {
    const windowReset = Date.parse("2026-09-14T05:00:00.000Z");
    const weeklyReset = Date.parse("2026-09-21T00:00:00.000Z");
    // These two readings of the same stamp must stay distinct. The assertion
    // below is only a pin if multiplying by 1000 would have produced a
    // different instant.
    expect(new Date(windowReset).toISOString()).not.toBe(new Date(windowReset * 1000).toISOString());
    const usage = {
      tier: "hidden-tier", observedAtMs: now,
      window: { usedPercent: 150, resetsAtMs: windowReset, windowDurationMins: 300 },
      weekly: { usedPercent: 0, resetsAtMs: weeklyReset },
    };
    expect(museSubscriptionWindows(usage, now)).toEqual([
      { usedPercent: 100, label: "5-hour", periodType: "window_300m",
        periodEnd: new Date(windowReset).toISOString(), observedAt: new Date(now).toISOString() },
      { usedPercent: 0, label: "Weekly", periodType: "weekly",
        periodEnd: new Date(weeklyReset).toISOString(), observedAt: new Date(now).toISOString() },
    ]);
    expect(JSON.stringify(museSubscriptionWindows(usage, now))).not.toContain("hidden-tier");
  });

  it("drops a malformed Muse window instead of guessing, and keeps the other", () => {
    const windowReset = Date.parse("2026-09-14T05:00:00.000Z");
    const weeklyReset = Date.parse("2026-09-21T00:00:00.000Z");
    const usage = {
      tier: "hidden-tier",
      window: { usedPercent: 12, resetsAtMs: windowReset, windowDurationMins: 300 },
      weekly: { usedPercent: 40, resetsAtMs: weeklyReset },
    };
    for (const window of [
      { usedPercent: "12", resetsAtMs: windowReset, windowDurationMins: 300 },
      { usedPercent: -1, resetsAtMs: windowReset, windowDurationMins: 300 },
      { usedPercent: 12, resetsAtMs: windowReset / 1000, windowDurationMins: 0 },
      { usedPercent: 12, resetsAtMs: "2026-09-14T05:00:00.000Z", windowDurationMins: 300 },
      undefined,
    ]) {
      expect(museSubscriptionWindows({ ...usage, window }, now)).toEqual([
        { usedPercent: 40, label: "Weekly", periodType: "weekly",
          periodEnd: new Date(weeklyReset).toISOString(), observedAt: new Date(now).toISOString() },
      ]);
    }
    expect(museSubscriptionWindows({ ...usage, weekly: { usedPercent: 40, resetsAtMs: null } }, now))
      .toEqual([{ usedPercent: 12, label: "5-hour", periodType: "window_300m",
        periodEnd: new Date(windowReset).toISOString(), observedAt: new Date(now).toISOString() }]);
    expect(museSubscriptionWindows(null)).toEqual([]);
    expect(museSubscriptionWindows({ tier: "hidden-tier" })).toEqual([]);
  });
});

describe("subscription cache and credential boundaries", () => {
  afterEach(() => vi.useRealTimers());
  it("coalesces opens, rate-limits failures too, and never refreshes on a timer", async () => {
    vi.useFakeTimers();
    const cache = new SubscriptionUsageCache();
    const read = vi.fn().mockResolvedValue(windows());
    await Promise.all([cache.refresh(read), cache.refresh(read)]);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * SUBSCRIPTION_USAGE_MIN_INTERVAL_MS);
    expect(read).toHaveBeenCalledOnce();
    read.mockRejectedValueOnce(new Error("unavailable"));
    await cache.refresh(read);
    expect(cache.windows).toEqual([]);
    await cache.refresh(read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("clears account A immediately, discards a late response, and retires its old process", async () => {
    let context = "account-a";
    const cache = new SubscriptionUsageCache();
    cache.windows = windows();
    const binding = new SubscriptionUsageBinding(cache, context, () => context);
    let resolve!: (value: ReturnType<typeof windows>) => void;
    const pending = binding.refresh(() => new Promise((done) => { resolve = done; }));
    context = "account-b";
    expect(binding.snapshot()).toEqual([]);
    resolve(windows());
    await pending;
    const read = vi.fn();
    await binding.refresh(read);
    expect(read).not.toHaveBeenCalled();
    binding.observe(windows());
    expect(binding.snapshot()).toEqual([]);
    const replacement = new SubscriptionUsageBinding(new SubscriptionUsageCache(), context, () => context);
    await replacement.refresh(async () => grokSubscriptionWindows(billing(17)));
    expect(replacement.snapshot()[0].usedPercent).toBe(17);
  });

  it("separates effective API keys, home overrides, and external credential-file changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "subscription-context-"));
    try {
      const env = { GROK_HOME: dir, XAI_API_KEY: "key-a" };
      const initial = subscriptionCredentialContext("grok", env);
      expect(subscriptionCredentialContext("grok", { ...env, GROK_CODE_XAI_API_KEY: "key-a" })).toBe(initial);
      expect(subscriptionCredentialContext("grok", { ...env, XAI_API_KEY: "key-b" })).not.toBe(initial);
      expect(subscriptionCredentialContext("grok", { ...env, GROK_HOME: path.join(dir, "other") })).not.toBe(initial);
      writeFileSync(path.join(dir, "auth.json"), '{"token":"account-a"}');
      const accountA = subscriptionCredentialContext("grok", env);
      writeFileSync(path.join(dir, "auth.json"), '{"token":"account-b"}');
      expect(subscriptionCredentialContext("grok", env)).not.toBe(accountA);
      expect(initial).not.toContain("key-a");
      const claudeEnv = { CLAUDE_CONFIG_DIR: dir };
      const claude = subscriptionCredentialContext("claude", claudeEnv);
      writeFileSync(path.join(dir, ".credentials.json"), '{"token":"other-account"}');
      expect(subscriptionCredentialContext("claude", claudeEnv)).not.toBe(claude);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

function hostHarness(provider: Session["provider"] = "grok") {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = provider;
  session.cwd = "/proj";
  session.subscriptionUsage = new SubscriptionUsageBinding(new SubscriptionUsageCache(), "account", () => "account");
  const read = vi.fn().mockResolvedValue(windows());
  session.client = { sessionId: "session", getSubscriptionUsage: read } as any;
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.remoteClients = new RemoteClientState<Session>("/proj");
  sidebar.remoteClients.ready("phone");
  sidebar.remoteClients.setActive("phone", session);
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.sendRemoteClient = vi.fn();
  sidebar.isAuthorizedCwd = () => true;
  sidebar.captureRemoteRequester = vi.fn();
  sidebar.refreshContextFromSessionInfo = vi.fn();
  return { sidebar, session, read };
}

describe("host subscription lifecycle", () => {
  it("shares Grok reads across the same credential context but starts each Claude process empty", async () => {
    const { sidebar, session, read } = hostHarness();
    const dir = mkdtempSync(path.join(tmpdir(), "subscription-sharing-"));
    try {
      sidebar.readDotEnv = () => ({ GROK_HOME: dir });
      const env = { ...process.env, GROK_HOME: dir };
      sidebar.bindSubscriptionUsage(session, env);
      await sidebar.refreshSubscriptionUsage(session);
      const other = new Session();
      other.cwd = session.cwd;
      other.client = { sessionId: "other", getSubscriptionUsage: read } as any;
      sidebar.bindSubscriptionUsage(other, env);
      await sidebar.refreshSubscriptionUsage(other);
      expect(read).toHaveBeenCalledOnce();
      expect(other.subscriptionUsage!.snapshot()).toEqual(windows());

      session.provider = "claude";
      other.provider = "claude";
      sidebar.bindSubscriptionUsage(session, process.env);
      session.subscriptionUsage!.observe(windows());
      sidebar.bindSubscriptionUsage(other, process.env);
      expect(other.subscriptionUsage!.snapshot()).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["grok", "claude", "codex", "muse"] as const)("popover open refreshes only Grok (%s), without accumulating history", async (provider) => {
    const { sidebar, session, read } = hostHarness(provider);
    await sidebar.onMessage({ type: "refreshSubscriptionUsage" }, "remote", "phone");
    await sidebar.refreshSubscriptionUsage(session);
    expect(read).toHaveBeenCalledTimes(provider === "grok" ? 1 : 0);
    expect(session.buffer).toEqual([]);
    if (provider === "grok") expect(sidebar.sendRemoteSession).toHaveBeenLastCalledWith(session, {
      type: "subscriptionUsage", windows: windows(),
    });
  });

  it("starts each Muse process empty even though the credential key never changes", () => {
    const { sidebar, session } = hostHarness("muse");
    expect(subscriptionCredentialContext("muse", process.env)).toBe("muse:cli-owned");
    expect(subscriptionCredentialContext("muse", { ...process.env, HOME: "/somewhere-else" })).toBe("muse:cli-owned");
    sidebar.bindSubscriptionUsage(session, process.env);
    session.subscriptionUsage!.observe(windows());
    const other = new Session();
    other.provider = "muse";
    other.cwd = session.cwd;
    sidebar.bindSubscriptionUsage(other, process.env);
    expect(other.subscriptionUsage!.snapshot()).toEqual([]);
    other.subscriptionUsage!.observe(grokSubscriptionWindows(billing(17), now));
    expect(session.subscriptionUsage!.snapshot()).toEqual(windows());
    expect(other.subscriptionUsage!.snapshot()[0].usedPercent).toBe(17);
  });

  it("reconnect and history snapshots carry only the latest singular Claude window", () => {
    const { sidebar, session } = hostHarness("claude");
    for (const rateLimitType of ["five_hour", "seven_day_opus"]) {
      session.subscriptionUsage!.observe(claudeSubscriptionWindows(rateUpdate({ utilization: 0.5, rateLimitType }), now)!);
      sidebar.publishSubscriptionUsage(session);
    }
    expect(session.buffer).toEqual([]);
    const latest = sessionUiSnapshot(session, "agent").find((m) => m.type === "subscriptionUsage");
    expect(latest).toMatchObject({ windows: [{ label: "Weekly · Opus" }] });
    expect((latest as any).windows).toHaveLength(1);
    sidebar.sendRemoteHistorySnapshot(session);
    expect(sidebar.sendRemoteClient).toHaveBeenLastCalledWith("phone", latest, "/proj");
  });

  it("account sign-out invalidates cached and displayed usage on every bound surface", () => {
    const { sidebar, session } = hostHarness();
    session.subscriptionUsage!.observe(windows());
    sidebar.providerConnections = () => ({ grok: true });
    sidebar.postProviderState = vi.fn();
    sidebar.setProviderConnectedInMemory("grok", false);
    expect(session.subscriptionUsage!.snapshot()).toEqual([]);
    expect(sidebar.sendRemoteSession).toHaveBeenLastCalledWith(session, { type: "subscriptionUsage", windows: [] });
    expect(session.buffer).toEqual([]);
  });

  it("context occupancy refreshes do not perform a subscription read", async () => {
    const { sidebar, read } = hostHarness();
    await sidebar.onMessage({ type: "refreshContextDetails" }, "remote", "phone");
    expect(sidebar.refreshContextFromSessionInfo).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
});
