// Pure policies for remembered mode (#25) and provider-scoped effort (#151),
// kept out of sidebar.ts so they can be tested without vscode/spawn.

import type { ConfigTarget } from "./host";

export type MuseModeId = "agent" | "yolo" | "onRequest" | "denyUnmatched";
export type ModeId = MuseModeId | "plan";
export const MUSE_MODE_PREF_KEY = "grok.defaultMuseMode";
export const MUSE_CLOUD_ON_REQUEST_UNAVAILABLE = "Muse On request is unavailable on cloud machines. Open this conversation on a desktop to change its mode, or start a new cloud conversation in Prompt unmatched.";
export const MUSE_ON_REQUEST_UNAVAILABLE = "On request requires the shell sandbox. Switch to Prompt unmatched, enable Shell sandbox in Settings → Providers → Muse Code, then start a new conversation.";

export function isMuseModeId(value: unknown): value is MuseModeId {
  return value === "agent" || value === "yolo" || value === "onRequest" || value === "denyUnmatched";
}

export function isModeId(value: unknown): value is ModeId {
  return value === "plan" || isMuseModeId(value);
}

export interface MuseSettings {
  shellSandbox: boolean;
  sandboxNetwork: "proxy-only" | "restricted" | "enabled";
  trustWorkspaces: boolean;
}

/** Process preferences stay fixed for a conversation; only its selected mode changes. */
export interface MusePosture extends MuseSettings {
  mode: MuseModeId;
}

export function museShellSandboxEnabled(posture: MusePosture, isCloud = false): boolean {
  return !isCloud && (posture.mode === "onRequest" || (posture.mode !== "yolo" && posture.shellSandbox));
}

export function musePosture(defaultMode: string | undefined, isResume: boolean,
  saved: MusePosture | undefined, settings: MuseSettings, isCloud = false): MusePosture {
  // Unknown/terminal-created histories start conservatively until Muse replays.
  if (isResume) return saved ? { ...saved } : { mode: "agent", shellSandbox: true, sandboxNetwork: "proxy-only", trustWorkspaces: false };
  return { ...settings, mode: isMuseModeId(defaultMode) && !(isCloud && defaultMode === "onRequest") ? defaultMode : "agent" };
}

export function usesClientAutoAccept(provider: string): boolean {
  return provider !== "muse";
}

/**
 * The mode value to persist for a user's mode switch, or `null` to leave the
 * shared preference unchanged. Plan is transient (#25); Muse-only modes belong
 * in MUSE_MODE_PREF_KEY, never in the shared grok.defaultMode enum.
 */
export function modeToRemember(modeId: ModeId): "agent" | "yolo" | null {
  return modeId === "agent" || modeId === "yolo" ? modeId : null;
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
export function sessionModes(provider: string, isCloud = false): ModeId[] {
  if (provider === "muse") return isCloud ? ["yolo", "agent", "denyUnmatched"] : ["yolo", "agent", "onRequest", "denyUnmatched"];
  return provider === "codex"
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
