// Pure policies for remembered mode (#25) and provider-scoped effort (#151),
// kept out of sidebar.ts so they can be tested without vscode/spawn.

import type { ConfigTarget } from "./host";
import type { DefaultModeCohort } from "./default-mode-cohort";

export type MuseModeId = "agent" | "yolo" | "onRequest" | "denyUnmatched";
/** `auto` is a provider's own Auto mode, offered only where one exists. */
export type ModeId = MuseModeId | "plan" | "auto";
export const MUSE_MODE_PREF_KEY = "grok.defaultMuseMode";
export const MUSE_CLOUD_ON_REQUEST_UNAVAILABLE = "Muse On request is unavailable on cloud machines. Open this conversation on a desktop to change its mode, or start a new cloud conversation in Prompt unmatched.";
export const MUSE_WINDOWS_ON_REQUEST_UNAVAILABLE = "Muse On request is unavailable on Windows because Muse's shell sandbox cannot run there. Use Prompt unmatched or Allow all.";
export type MuseSandboxUnavailable = "cloud" | "windows" | undefined;
export function museSandboxUnavailable(isCloud: boolean, platform: NodeJS.Platform = process.platform): MuseSandboxUnavailable {
  return isCloud ? "cloud" : platform === "win32" ? "windows" : undefined;
}
export function museOnRequestUnavailable(reason: Exclude<MuseSandboxUnavailable, undefined>): string {
  return reason === "cloud" ? MUSE_CLOUD_ON_REQUEST_UNAVAILABLE : MUSE_WINDOWS_ON_REQUEST_UNAVAILABLE;
}

/** A remembered choice wins; only fresh Grok, Antigravity and Muse defaults change. */
export function resolvedDefaultMode(provider: string, remembered: string | undefined,
  cohort: DefaultModeCohort = "existing"): string {
  if (remembered) return remembered;
  if (provider === "claude") return "auto";
  return cohort === "new" && ["grok", "agy", "muse"].includes(provider) ? "yolo" : "agent";
}
export const MUSE_ON_REQUEST_UNAVAILABLE = "On request requires the shell sandbox. Switch to Prompt unmatched, enable Shell sandbox in Settings → Providers → Muse Code, then start a new conversation.";

export function isMuseModeId(value: unknown): value is MuseModeId {
  return value === "agent" || value === "yolo" || value === "onRequest" || value === "denyUnmatched";
}

export function isModeId(value: unknown): value is ModeId {
  return value === "plan" || value === "auto" || isMuseModeId(value);
}

/**
 * The providers with a native Auto mode, where the agent itself decides which
 * actions are safe and asks about the rest. Claude Code's `auto` ("Claude
 * handles permission decisions") is the only unambiguous one: Codex's choices
 * are its auto-review mode (already its default, `agent`) and the classic Auto
 * preset; Grok, Muse and Antigravity's ACP server have none.
 */
export function hasNativeAutoMode(provider: string): boolean {
  return provider === "claude";
}

/**
 * Whether a brand-new session starts in the provider's native Auto: it has
 * one, nothing else was chosen (an unset `grok.defaultMode`) or Auto was, and
 * this is not a resume.
 */
export function startsInNativeAuto(provider: string, defaultMode: string | undefined, isResume: boolean): boolean {
  return hasNativeAutoMode(provider) && !isResume && (!defaultMode || defaultMode === "auto");
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

export function museShellSandboxEnabled(posture: MusePosture, sandboxUnavailable = false): boolean {
  return !sandboxUnavailable && (posture.mode === "onRequest" || (posture.mode !== "yolo" && posture.shellSandbox));
}

export function musePosture(defaultMode: string | undefined, isResume: boolean,
  saved: MusePosture | undefined, settings: MuseSettings, sandboxUnavailable = false): MusePosture {
  // Unknown/terminal-created histories start conservatively until Muse replays.
  if (isResume) return saved ? { ...saved, mode: saved.mode === "denyUnmatched" ? "agent" : saved.mode } : { mode: "agent", shellSandbox: true, sandboxNetwork: "proxy-only", trustWorkspaces: false };
  return { ...settings, mode: isMuseModeId(defaultMode) && defaultMode !== "denyUnmatched" && !(sandboxUnavailable && defaultMode === "onRequest") ? defaultMode : "agent" };
}

export function usesClientAutoAccept(provider: string): boolean {
  return provider !== "muse";
}

/**
 * The mode value to persist for a user's mode switch, or `null` to leave the
 * shared preference unchanged. Plan is transient (#25); Muse-only modes belong
 * in MUSE_MODE_PREF_KEY, never in the shared grok.defaultMode enum.
 */
export function modeToRemember(modeId: ModeId): "agent" | "yolo" | "auto" | null {
  return modeId === "agent" || modeId === "yolo" || modeId === "auto" ? modeId : null;
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

/** Modes this session's picker offers. Codex's plan review is outside this menu; Muse and Antigravity have no Plan. */
export function sessionModes(provider: string, sandboxUnavailable = false): ModeId[] {
  // Deny unmatched stalls Muse's end-of-turn reminder agent; see research/muse-modes.md.
  if (provider === "muse") return sandboxUnavailable ? ["yolo", "agent"] : ["yolo", "agent", "onRequest"];
  if (hasNativeAutoMode(provider)) return ["agent", "auto", "plan", "yolo"];
  return provider === "codex" || provider === "agy"
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
