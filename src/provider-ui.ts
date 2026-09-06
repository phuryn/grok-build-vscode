import type { ModelInfo } from "./acp";
import type { AcpProvider, BackendSessionListEntry } from "./acp-backend";
import { isAdapterProvider } from "./acp-backend";
import { normalizeWorkspaceFsPath } from "./host";
import type { SessionListEntry, SessionMetaOverrides } from "./sessions";

export const PROVIDER_ORDER: readonly AcpProvider[] = ["grok", "codex", "claude", "gemini"];

export function providerDisplayName(provider: AcpProvider): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  if (provider === "gemini") return "Gemini";
  return "Grok";
}

export interface ProviderConnections {
  grok?: boolean;
  codex?: boolean;
  claude?: boolean;
  gemini?: boolean;
}

export interface ProviderModelCacheEntry {
  models: ModelInfo[];
  currentModelId?: string;
  seenAt: number;
}

export type ProviderModelCache = Partial<Record<AcpProvider, ProviderModelCacheEntry>>;

export interface ProjectProviderDefault {
  provider: AcpProvider;
  modelId?: string;
}

export type ProjectProviderDefaults = Record<string, ProjectProviderDefault>;

export interface CodexHistoryHighWater {
  updatedAt: number;
  id: string;
}

export interface ProviderHistoryCursor {
  grokOffset: number;
  codexHighWater?: CodexHistoryHighWater;
}

export interface GrokHistoryPage {
  entries: readonly SessionListEntry[];
  nextOffset: number;
  total: number;
}

export interface ProviderModelInfo extends ModelInfo {
  provider: AcpProvider;
  defaultImplied?: boolean;
}

export function projectProviderKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return normalizeWorkspaceFsPath(cwd, platform);
}

/** A provider session id is globally unique. Any collection crossing provider,
 * cache, or live/disk boundaries must collapse on id alone before it reaches a
 * renderer. The newest record wins because it carries the freshest title/cwd. */
export function dedupeSessionEntriesById(
  entries: readonly SessionListEntry[],
): SessionListEntry[] {
  const byId = new Map<string, SessionListEntry>();
  for (const entry of entries) {
    const previous = byId.get(entry.id);
    if (!previous || entry.updatedAt > previous.updatedAt) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function connectedProviderIds(
  connections: ProviderConnections,
  located: Partial<Record<AcpProvider, boolean>>,
): AcpProvider[] {
  return PROVIDER_ORDER.filter((provider) => connections[provider] === true && located[provider] === true);
}

/**
 * Connected AND able to answer — the set a new session may be handed to.
 *
 * "Connected" only means the user linked this provider and we can find its
 * binary. A provider whose credentials have since lapsed is still connected and
 * still located, so it stayed at the head of {@link connectedProviderIds} and
 * captured every new empty session: the owner had Grok and Claude unconnected,
 * Codex connected with expired credentials, and got dropped into "Complete
 * codex login" on a fresh session he might have wanted Grok for.
 *
 * Keep both functions. Deciding whether to OFFER a sign-out, or whether to show
 * a provider as stale at all, genuinely wants "connected"; deciding who runs a
 * turn wants this.
 */
export function usableProviderIds(
  connections: ProviderConnections,
  located: Partial<Record<AcpProvider, boolean>>,
  needsLogin: Partial<Record<AcpProvider, boolean>>,
): AcpProvider[] {
  return connectedProviderIds(connections, located).filter((provider) => needsLogin[provider] !== true);
}

export function providerLoginState(provider: AcpProvider): "auth-required" | "codex-login" | "claude-login" | "gemini-login" {
  if (provider === "codex") return "codex-login";
  if (provider === "claude") return "claude-login";
  if (provider === "gemini") return "gemini-login";
  return "auth-required";
}

export function missingProviderState(provider: AcpProvider): "missing-cli" | "missing-codex" | "missing-claude" | "missing-gemini" {
  if (provider === "codex") return "missing-codex";
  if (provider === "claude") return "missing-claude";
  if (provider === "gemini") return "missing-gemini";
  return "missing-cli";
}

export function findCachedAdapterSession(
  catalogs: Iterable<readonly SessionListEntry[]>,
  id: string,
  allowedCwds: readonly string[],
  belongsToAllowedCwd: (cwd: string, allowedCwds: readonly string[]) => boolean,
): SessionListEntry | undefined {
  for (const entries of catalogs) {
    const found = entries.find((entry) =>
      !!entry.provider && isAdapterProvider(entry.provider) && entry.id === id && belongsToAllowedCwd(entry.cwd, allowedCwds)
    );
    if (found) return found;
  }
  return undefined;
}

export function findCachedCodexSession(
  catalogs: Iterable<readonly SessionListEntry[]>,
  id: string,
  allowedCwds: readonly string[],
  belongsToAllowedCwd: (cwd: string, allowedCwds: readonly string[]) => boolean,
): SessionListEntry | undefined {
  const found = findCachedAdapterSession(catalogs, id, allowedCwds, belongsToAllowedCwd);
  return found?.provider === "codex" ? found : undefined;
}

export function modelsForConnectedProviders(
  providers: readonly AcpProvider[],
  cache: ProviderModelCache,
  live?: { provider: AcpProvider; models: readonly ModelInfo[]; currentModelId?: string },
): ProviderModelInfo[] {
  const out: ProviderModelInfo[] = [];
  for (const provider of PROVIDER_ORDER) {
    if (!providers.includes(provider)) continue;
    const source = live?.provider === provider && live.models.length
      ? live.models
      : cache[provider]?.models ?? [];
    if (!source.length) {
      out.push({
        provider,
        modelId: "",
        name: `${providerDisplayName(provider)} default`,
        description: "Uses this agent's default model",
        defaultImplied: true,
      });
      continue;
    }
    for (const model of source) out.push({ ...model, provider });
  }
  return out;
}

/**
 * Recency for an adapter history row.
 *
 * Prefer the activity this host observed (`activeAt` — first-seen listing
 * time as a baseline, then send and turn end). The adapter's own stamp is
 * used only when we have never seen the row.
 *
 * Claude restamps `updatedAt` on `session/load` (measured on a fresh
 * process), so `Math.max(reportedAt, activeAt)` is exactly what lets an
 * open win. Codex does not restamp (measured twice), but pinning to our
 * clock is still what we want: opening must not promote the row.
 *
 * Trade-off: work done to that session outside this extension (Claude
 * Code CLI, another host, the Codex app) stops promoting the row. Unlike
 * grok we cannot pick a different on-disk file — there is no better
 * signal available for either adapter.
 */
export function adapterActivityAt(
  provider: AcpProvider,
  reportedAt: number,
  activeAt?: number,
): number {
  if (typeof activeAt !== "number") return reportedAt;
  if (provider === "codex" || provider === "claude" || provider === "gemini") return activeAt;
  return Math.max(reportedAt, activeAt);
}

export function adapterEntriesEligibleForClear<T>(
  caches: ReadonlyArray<{ provider: AcpProvider; entries: readonly T[] }>,
  refreshed: ReadonlySet<AcpProvider>,
): T[] {
  return caches.flatMap((cache) => refreshed.has(cache.provider) ? [...cache.entries] : []);
}

export function adapterListEntry(
  raw: BackendSessionListEntry,
  overrides: SessionMetaOverrides,
  provider: AcpProvider,
  now = Date.now(),
): SessionListEntry {
  const meta = overrides[raw.sessionId];
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const parsed = typeof raw.updatedAt === "number"
    ? raw.updatedAt
    : Date.parse(String(raw.updatedAt ?? ""));
  const reportedAt = Number.isFinite(parsed) ? parsed : now;
  const updatedAt = adapterActivityAt(provider, reportedAt, meta?.activeAt);
  const customName = meta?.customName?.trim() || undefined;
  const autoName = meta?.autoName?.trim() || title;
  return {
    id: raw.sessionId,
    cwd: raw.cwd,
    displayName: customName || autoName || `Untitled (${new Date(updatedAt).toLocaleDateString()})`,
    rawSummary: title,
    customName,
    updatedAt,
    createdAt: updatedAt,
    numMessages: 0,
    provider,
    pinnedAt: meta?.pinnedAt,
  };
}

export function codexListEntry(
  raw: BackendSessionListEntry,
  overrides: SessionMetaOverrides,
  now = Date.now(),
): SessionListEntry {
  return adapterListEntry(raw, overrides, "codex", now);
}

/** Normalize `codex --version` output (`codex-cli 0.147.0`, etc.) for display. */
export function parseCodexVersionOutput(output: string): string {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output.trim())?.[1] ?? "";
}

export function versionIsOlder(current: string, target: string): boolean {
  const parts = (value: string) => value.split(/[.-]/, 3).map((part) => Number.parseInt(part, 10));
  const a = parts(current);
  const b = parts(target);
  if (a.some((part) => !Number.isFinite(part)) || b.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

export function mergeProviderSessionEntries(
  grokEntries: readonly SessionListEntry[],
  adapterEntries: readonly SessionListEntry[],
  providers: readonly AcpProvider[],
  query = "",
): SessionListEntry[] {
  const q = query.trim().toLowerCase();
  const entries = [
    // Grok rows are disk/buffer-truth (same contract as the unfiltered page).
    // Adapter rows come from session/list, so they stay connection-gated.
    ...grokEntries,
    ...adapterEntries.filter((entry) => !entry.provider || providers.includes(entry.provider)),
  ];
  return dedupeSessionEntriesById(entries)
    .filter((entry) => !q || entry.displayName.toLowerCase().includes(q) || entry.worktreeLabel?.toLowerCase().includes(q))
    .sort(compareHistoryEntries);
}

export function compareHistoryEntries(a: SessionListEntry, b: SessionListEntry): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function followsCodexHighWater(
  entry: SessionListEntry,
  highWater: CodexHistoryHighWater | undefined,
): boolean {
  if (!highWater) return true;
  return entry.updatedAt < highWater.updatedAt ||
    (entry.updatedAt === highWater.updatedAt && entry.id.localeCompare(highWater.id) > 0);
}

/** Grok owns page pacing and its cursor remains opaque to the combined path.
 * Adapter catalogs (Codex, Claude) are complete and cheap in memory. While
 * Grok has another page, emit the not-yet-consumed adapter prefix down through
 * this page's oldest Grok timestamp. Once Grok is exhausted, drain the rest.
 * `codexHighWater` is that adapter-catalog cursor — the name is historical. */
export function mergeProviderHistoryPage(
  grok: GrokHistoryPage | undefined,
  codexEntries: readonly SessionListEntry[],
  cursor: ProviderHistoryCursor,
  limit = Number.MAX_SAFE_INTEGER,
): { entries: SessionListEntry[]; providerCursor: ProviderHistoryCursor; hasMore: boolean } {
  const codexRemaining = dedupeSessionEntriesById(codexEntries)
    .sort(compareHistoryEntries)
    .filter((entry) => followsCodexHighWater(entry, cursor.codexHighWater));
  const grokHasMore = !!grok && grok.nextOffset < grok.total;
  const oldestGrokTimestamp = grok?.entries.length
    ? Math.min(...grok.entries.map((entry) => entry.updatedAt))
    : undefined;
  const codexPage = !grokHasMore
    ? codexRemaining.slice(0, Math.max(0, limit))
    : oldestGrokTimestamp === undefined
      ? []
      : codexRemaining.filter((entry) => entry.updatedAt >= oldestGrokTimestamp);
  const lastCodex = codexPage.at(-1);
  const providerCursor: ProviderHistoryCursor = {
    grokOffset: grok?.nextOffset ?? Math.max(0, cursor.grokOffset),
    ...(lastCodex
      ? { codexHighWater: { updatedAt: lastCodex.updatedAt, id: lastCodex.id } }
      : cursor.codexHighWater
        ? { codexHighWater: cursor.codexHighWater }
        : {}),
  };
  return {
    entries: dedupeSessionEntriesById([...(grok?.entries ?? []), ...codexPage]).sort(compareHistoryEntries),
    providerCursor,
    hasMore: grokHasMore || codexPage.length < codexRemaining.length,
  };
}
