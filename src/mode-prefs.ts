// Pure helpers for the remembered-mode preference (#25). Kept out of sidebar.ts
// so the policy — "remember the last Agent/Auto-accept switch, never Plan; apply
// it to new sessions only" — is unit-testable without vscode/spawn.

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

/** Remembered reasoning effort, per agent. */
export type EffortPrefs = Record<string, string>;

/**
 * The effort to start a new session at.
 *
 * `grok.defaultEffort` is a single global value, and it only ever meant grok —
 * its own description names `--reasoning-effort`. Applying it to Claude and
 * Gemini too meant a level someone once picked for grok silently set how hard
 * every Claude turn thought, and that is paid for per turn. It is now the
 * fallback for grok alone; every agent remembers its own choice.
 */
export function rememberedEffort(
  prefs: EffortPrefs | undefined,
  provider: string,
  legacy: string | undefined,
): string {
  const own = prefs?.[provider];
  if (typeof own === "string" && own) return own;
  return provider === "grok" && legacy ? legacy : "";
}

/** The map to persist after a switch. An empty level means "back to the model
 *  default", which is an absence, not a value. */
export function withRememberedEffort(
  prefs: EffortPrefs | undefined,
  provider: string,
  level: string,
): EffortPrefs {
  const next: EffortPrefs = { ...(prefs ?? {}) };
  if (level) next[provider] = level;
  else delete next[provider];
  return next;
}
