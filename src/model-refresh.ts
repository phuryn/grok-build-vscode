import type { ModelInfo } from "./acp";
import type { AcpProvider } from "./acp-backend";

/** When each agent's list was last asked for on a schedule, answered or not. */
export const MODEL_REFRESH_ATTEMPTS_KEY = "grok.modelRefreshAttempts";

/** A vendor adds models without a CLI update, so a list is re-read once a day. */
export const MODEL_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** An agent's boot is expensive; leave the panel's own start alone first. */
export const MODEL_REFRESH_FIRST_DELAY_MS = 2 * 60 * 1000;
/** How often an open panel looks for a list that has grown old. */
export const MODEL_REFRESH_CHECK_MS = 60 * 60 * 1000;

export type ModelRefreshAttempts = Partial<Record<AcpProvider, number>>;

/** Persisted, so the shape is untrusted. */
export function modelRefreshAttempts(stored: unknown): ModelRefreshAttempts {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return { ...(stored as ModelRefreshAttempts) };
}

/** Within the last day. A time in the future (the clock was set back) is not. */
function recent(at: unknown, now: number): boolean {
  return typeof at === "number" && at <= now && now - at < MODEL_LIST_MAX_AGE_MS;
}

/**
 * Whether to ask an agent for its models again: nothing was read in the last
 * day, and nothing was tried in it either. The second half is what keeps an
 * agent that cannot answer from being started every hour.
 */
export function modelListIsStale(seenAt: unknown, attemptedAt: unknown, now: number): boolean {
  return !recent(seenAt, now) && !recent(attemptedAt, now);
}

function comparable(model: ModelInfo): string {
  // The effort a model happens to be set to is the session's, not the list's.
  const { reasoningEffort: _effort, ...rest } = model;
  return JSON.stringify(Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Whether the picker would show the same models, in the same order. */
export function sameModelList(a: readonly ModelInfo[] | undefined, b: readonly ModelInfo[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((model, index) => comparable(model) === comparable(right[index]));
}
