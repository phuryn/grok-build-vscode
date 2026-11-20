import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { SubscriptionWindow } from "./subscription-usage";

const PERSONAL_QUOTA_HOSTS = ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"];
const USER_AGENT = "AFK-Pilot";

interface GoogleCredential {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  project_id?: string;
}

function readGoogleCredential(profile: string, methodId: string | undefined): GoogleCredential | undefined {
  if (methodId !== "oauth-personal" && methodId !== "oauth-business") return;
  try {
    const file = path.join(profile, "acp_token.json");
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 16_384) return;
    const credential = JSON.parse(readFileSync(file, "utf8"));
    const { client_id, client_secret, refresh_token, project_id } = credential;
    if (typeof client_id !== "string" || !client_id || typeof client_secret !== "string" || !client_secret
      || typeof refresh_token !== "string" || !refresh_token) return;
    return { client_id, client_secret, refresh_token, ...(typeof project_id === "string" && project_id ? { project_id } : {}) };
  } catch { return undefined; }
}

/** A silent, memory-only cache identity. Refreshing an access token leaves it unchanged. */
export function agyUsageCredentialContext(profile: string, methodId: string | undefined): string | undefined {
  const credential = readGoogleCredential(profile, methodId);
  if (!credential) return;
  return `agy:${createHash("sha256").update(JSON.stringify([profile, methodId, credential])).digest("hex")}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function groupLabel(group: unknown, bucketId: string): string | undefined {
  if (typeof group === "string" && group.trim()) {
    if (/^gemini models$/i.test(group.trim())) return "Gemini";
    if (/^claude and gpt models$/i.test(group.trim())) return "Claude & GPT";
    return group.replace(/\s+/g, " ").trim().slice(0, 80);
  }
  if (bucketId.startsWith("gemini-argon-")) return "Gemini Argon";
  if (bucketId.startsWith("gemini-carbon-")) return "Gemini Carbon";
  if (bucketId.startsWith("gemini-")) return "Gemini";
  if (bucketId.startsWith("3p-")) return "Claude & GPT";
  return undefined;
}

/** The same grouped quota summary used by the server's /usage command. */
export function agySubscriptionWindows(raw: unknown, now = Date.now()): SubscriptionWindow[] {
  if (!isRecord(raw)) return [];
  const groups = Array.isArray(raw.groups) ? raw.groups.filter(isRecord) : [];
  const sources = groups.some(group => Array.isArray(group.buckets) && group.buckets.length) ? groups : [raw];
  const windows = new Map<string, SubscriptionWindow>();
  const observedAt = new Date(now).toISOString();
  for (const group of sources) {
    if (!Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || bucket.disabled === true) continue;
      const bucketId = bucket.bucketId ?? bucket.bucket_id;
      const remaining = bucket.remainingFraction ?? bucket.remaining_fraction;
      const window = bucket.window;
      if (typeof bucketId !== "string" || !bucketId || (window !== "weekly" && window !== "5h")
        || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      const family = groupLabel(group.displayName ?? group.display_name, bucketId);
      if (!family) continue;
      const reset = bucket.resetTime ?? bucket.reset_time;
      const resetTime = typeof reset === "string" ? Date.parse(reset) : NaN;
      const periodType = `${bucketId}_${window}`;
      windows.set(periodType, {
        usedPercent: 100 - remaining * 100,
        label: `${family} · ${window === "weekly" ? "Weekly" : "5-hour"}`,
        periodType,
        ...(Number.isFinite(resetTime) ? { periodEnd: new Date(resetTime).toISOString() } : {}),
        observedAt,
      });
    }
  }
  return [...windows.values()];
}

/** Read-only and best-effort. The host's subscription cache owns scheduling and invalidation. */
export async function readAgySubscriptionUsage(
  profile: string,
  methodId: string | undefined,
  request: typeof fetch = fetch,
): Promise<SubscriptionWindow[]> {
  const credential = readGoogleCredential(profile, methodId);
  if (!credential) return [];
  const { project_id, ...refresh } = credential;
  const options = { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000) } as const;
  let accessToken: string;
  try {
    const response = await request("https://oauth2.googleapis.com/token", {
      ...options, headers: { "User-Agent": USER_AGENT },
      body: new URLSearchParams({ ...refresh, grant_type: "refresh_token" }),
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const token = isRecord(body) ? body.access_token : undefined;
    if (typeof token !== "string" || !token) return [];
    accessToken = token;
  } catch { return []; }
  const hosts = methodId === "oauth-business" ? [...PERSONAL_QUOTA_HOSTS].reverse() : PERSONAL_QUOTA_HOSTS;
  for (const host of hosts) {
    try {
      const response = await request(`https://${host}/v1internal:retrieveUserQuotaSummary`, {
        ...options,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "User-Agent": USER_AGENT },
        body: JSON.stringify(project_id ? { project: project_id } : {}),
      });
      if (!response.ok) continue;
      const windows = agySubscriptionWindows(await response.json());
      if (windows.length) return windows;
    } catch { /* Try the other quota host before leaving the meter empty. */ }
  }
  return [];
}
