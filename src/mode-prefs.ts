// Pure policies for remembered mode (#25) and provider-scoped effort (#151),
// kept out of sidebar.ts so they can be tested without vscode/spawn.

export type ModeId = "agent" | "plan" | "yolo";

/**
 * The mode value to persist for a user's mode switch, or `null` to leave the
 * remembered preference unchanged. Plan is a transient per-task choice, so it is
 * never remembered (#25). Mirrors how `defaultModel`/`defaultEffort` persist.
 */
export function modeToRemember(modeId: ModeId): "agent" | "yolo" | null {
  return modeId === "plan" ? null : modeId;
}

/**
 * Whether a brand-new session should start in Auto accept (YOLO), given the
 * remembered `grok.defaultMode` and whether this start is a resume. Resumed
 * sessions are verdict-driven (plan-restore decides), so they never pre-apply
 * the remembered mode.
 */
export function startsInYolo(defaultMode: string | undefined, isResume: boolean): boolean {
  return !isResume && defaultMode === "yolo";
}

export const EFFORT_PREFS_KEY = "grok.defaultEffortByProvider";
export type EffortPrefs = Record<string, string>;

/** Adapter picker choices belong to that provider; existing Grok config stays its fallback. */
export function rememberedEffort(
  prefs: EffortPrefs | undefined,
  provider: string,
  legacy: string | undefined,
): string {
  const own = prefs?.[provider];
  if (typeof own === "string") return own;
  return provider === "grok" ? legacy || "" : "";
}
