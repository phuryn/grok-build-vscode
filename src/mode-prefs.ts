// Pure policies for remembered mode (#25) and provider-scoped effort (#151),
// kept out of sidebar.ts so they can be tested without vscode/spawn.

import type { ConfigTarget } from "./host";

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

/** Modes this session's picker offers. Codex's plan review is outside this menu; Muse has no Plan. */
export function sessionModes(provider: string): ModeId[] {
  return provider === "codex" || provider === "muse"
    ? ["agent", "yolo"]
    : ["agent", "plan", "yolo"];
}

export const EFFORT_PREFS_KEY = "grok.defaultEffortByProvider";
export type EffortPrefs = Record<string, string>;

/**
 * Where a write of `section` has to land for the next `get(section)` to read it
 * back. `get` returns the EFFECTIVE value — folder > workspace > global — so a
 * setting that declares no `scope` (and is therefore `window`-scoped, as
 * `grok.defaultEffort` and `grok.defaultModel` are) can be overridden per
 * workspace. Writing Global underneath such an override persists a value
 * nothing will ever read: the picker records the level, the next spawn re-reads
 * the workspace's level, and the strip snaps back to it on every change (#162).
 *
 * Deliberately writes where the value ALREADY lives rather than forcing Global:
 * a per-workspace effort or model is a legitimate thing to have configured, and
 * the point is only that the picker must move the value the session actually
 * uses.
 */
export function configWriteTarget(
  inspected: { workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined,
): ConfigTarget {
  if (inspected?.workspaceFolderValue !== undefined) return "workspaceFolder";
  if (inspected?.workspaceValue !== undefined) return "workspace";
  return "global";
}

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
