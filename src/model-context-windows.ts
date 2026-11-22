/**
 * The last context window each agent reported for each model, so a chat shows
 * its real size before its first turn. Some model lists carry no window (Codex,
 * and Claude rows whose description names none), and the CLI reports one only
 * once a turn has run. A number per model, never content.
 */
export type ModelContextWindows = Record<string, number>;

/** Enough for every model of every agent; the oldest entries go first. */
const MAX_ENTRIES = 64;

export function modelWindowKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** The map with this window recorded, or undefined when nothing changes. */
export function rememberModelWindow(
  map: ModelContextWindows,
  provider: string,
  modelId: string | undefined,
  window: unknown,
): ModelContextWindows | undefined {
  if (!modelId || typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
  const key = modelWindowKey(provider, modelId);
  if (map[key] === window) return undefined;
  const next: ModelContextWindows = { ...map };
  delete next[key];
  next[key] = window;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete next[old];
  return next;
}

/** The context count worth keeping from an adapter's report. agy reports 0 for
 *  a chat it has not run a turn in during this process (agy 1.5, right after
 *  session/new), which must not replace the count saved for a reopened chat. */
export function adapterContextCount(provider: string, used: number | undefined): number | undefined {
  return provider === "agy" && used === 0 ? undefined : used;
}

/** The window to assume for an agent whose model list names none, until a
 *  turn reports the real one. Claude Code: 1M (the owner, 2026-11-22: "it's
 *  1M"). Codex: 258,400, the size codex-acp reports in usage_update
 *  (test/codex-acp-integration.test.ts). */
export const DEFAULT_MODEL_WINDOWS: Readonly<Record<string, number>> = { claude: 1_000_000, codex: 258_400 };

/** Models whose window is missing, filled from what that model last reported,
 *  else the agent's default. A window the agent itself advertises always wins. */
export function withRememberedWindows<T extends { modelId: string; totalContextTokens?: number; provider?: string }>(
  models: readonly T[],
  map: ModelContextWindows,
  provider: string,
): T[] {
  return models.map((model) => {
    if (typeof model.totalContextTokens === "number" && model.totalContextTokens > 0) return model;
    const owner = model.provider ?? provider;
    const window = map[modelWindowKey(owner, model.modelId)] ?? DEFAULT_MODEL_WINDOWS[owner];
    return typeof window === "number" && window > 0 ? { ...model, totalContextTokens: window } : model;
  });
}
