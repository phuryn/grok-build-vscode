import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agySubscriptionWindows, agyUsageCredentialContext, readAgySubscriptionUsage } from "../src/agy-usage";

const observed = "2026-11-20T19:00:00.000Z";
const resetTime = "2026-11-20T21:18:00Z";
const summary = { groups: [
  { displayName: "Gemini Models", buckets: [
    { bucketId: "gemini-short", window: "5h", remainingFraction: 1, resetTime },
    { bucketId: "gemini-long", window: "weekly", remainingFraction: 0.47 },
  ] },
  { displayName: "Claude and GPT models", buckets: [
    { bucketId: "3p-short", window: "5h", remainingFraction: 0.82 },
    { bucketId: "3p-long", window: "weekly", remainingFraction: 0.65 },
  ] },
] };

describe("Antigravity quota windows", () => {
  it("reports use and reset for both model groups and both windows", () => {
    const windows = agySubscriptionWindows(summary, Date.parse(observed));
    expect(windows).toEqual([
      { label: "Gemini · 5-hour", periodType: "gemini-short_5h", usedPercent: 0, periodEnd: "2026-11-20T21:18:00.000Z", observedAt: observed },
      { label: "Gemini · Weekly", periodType: "gemini-long_weekly", usedPercent: 53, observedAt: observed },
      { label: "Claude & GPT · 5-hour", periodType: "3p-short_5h", usedPercent: 18, observedAt: observed },
      { label: "Claude & GPT · Weekly", periodType: "3p-long_weekly", usedPercent: 35, observedAt: observed },
    ]);
  });

  it("keeps a reported group and skips disabled, unrecognized and malformed buckets", () => {
    expect(agySubscriptionWindows({ groups: [summary.groups[1], { buckets: [
      { bucketId: "gemini-short", window: "5h", remainingFraction: 0.5, disabled: true },
      { bucketId: "gemini-short", window: "10m", remainingFraction: 0.5 },
      { bucketId: "3p-short", window: "5h", remainingFraction: "0.5" },
    ] }] }).map(window => window.label)).toEqual(["Claude & GPT · 5-hour", "Claude & GPT · Weekly"]);
    expect(agySubscriptionWindows({ buckets: summary.groups[0].buckets }).map(window => window.label)).toEqual(["Gemini · 5-hour", "Gemini · Weekly"]);
    expect(agySubscriptionWindows({ message: "unavailable" })).toEqual([]);
  });
});

describe("Antigravity usage reader", () => {
  let profile: string;
  let tokenFile: string;
  const credential = { client_id: "fake-client", client_secret: "fake-secret", refresh_token: "fake-refresh", project_id: "fake-project" };
  beforeEach(async () => {
    profile = await fs.mkdtemp(path.join(tmpdir(), "agy-usage-"));
    tokenFile = path.join(profile, "acp_token.json");
    await fs.writeFile(tokenFile, JSON.stringify(credential));
  });
  afterEach(async () => fs.rm(profile, { recursive: true, force: true }));

  it("refreshes a Google credential and uses the production host when daily cannot report", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "fake-access" }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(summary));
    expect(await readAgySubscriptionUsage(profile, "oauth-personal", request)).toHaveLength(4);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://oauth2.googleapis.com/token", "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ]);
    expect(Object.fromEntries(request.mock.calls[0][1]!.body as URLSearchParams)).toEqual({
      client_id: "fake-client", client_secret: "fake-secret", refresh_token: "fake-refresh", grant_type: "refresh_token",
    });
    expect(request.mock.calls[1][1]).toMatchObject({ redirect: "error", body: '{"project":"fake-project"}',
      headers: { Authorization: "Bearer fake-access", "User-Agent": "AFK-Pilot" } });
    expect(await fs.readFile(tokenFile, "utf8")).toBe(JSON.stringify(credential));
  });

  it.each([undefined, "gemini-api-key", "gateway"])("does not read Google usage with method %s", async (method) => {
    const request = vi.fn<typeof fetch>();
    expect(agyUsageCredentialContext(profile, method)).toBeUndefined();
    expect(await readAgySubscriptionUsage(profile, method, request)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("silently drops unreadable answers and unreadable credentials", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "fake-access" }))
      .mockResolvedValueOnce(new Response("unreadable"))
      .mockResolvedValueOnce(Response.json({ message: "no windows" }));
    expect(await readAgySubscriptionUsage(profile, "oauth-personal", request)).toEqual([]);
    await fs.writeFile(tokenFile, "{");
    request.mockClear();
    expect(await readAgySubscriptionUsage(profile, "oauth-personal", request)).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("keys the cache on the Google sign-in and ignores access token rotation", async () => {
    const original = agyUsageCredentialContext(profile, "oauth-personal");
    expect(original).toMatch(/^agy:[a-f0-9]{64}$/);
    await fs.writeFile(tokenFile, JSON.stringify({ ...credential, token: "some-access-token" }));
    expect(agyUsageCredentialContext(profile, "oauth-personal")).toBe(original);
    await fs.writeFile(tokenFile, JSON.stringify({ ...credential, refresh_token: "new-account" }));
    expect(agyUsageCredentialContext(profile, "oauth-personal")).not.toBe(original);
  });
});
