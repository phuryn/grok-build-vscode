export const AUTO_COMPACT_PRESETS = [200_000, 300_000, 400_000, 500_000, 750_000] as const;
export const DEFAULT_AUTO_COMPACT_AT = 300_000;

export function isAutoCompactPreset(value: unknown): value is typeof AUTO_COMPACT_PRESETS[number] {
  return AUTO_COMPACT_PRESETS.some(preset => preset === value);
}

export interface AutoCompactSettings {
  enabled: boolean;
  tokens: number;
}

export interface AutoCompactThreshold {
  tokens: number;
  source: "limit" | "agent";
}

export interface ReportedAutoCompaction {
  id?: string;
  before?: number;
  after?: number;
}

export type RunAutoCompact = (window: number | undefined, reportedPercent?: number) => AutoCompactThreshold | null;

export function compactCeiling(limit: number, native: number): AutoCompactThreshold {
  return native <= limit ? { tokens: native, source: "agent" } : { tokens: limit, source: "limit" };
}

export function autoCompactNotice(report: ReportedAutoCompaction, threshold?: AutoCompactThreshold | null): string {
  const tokenLabel = (value: number) => value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value);
  const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const { before, after } = report;
  const limit = threshold?.source === "limit" && count(before) && before >= threshold.tokens
    ? ` at your ${tokenLabel(threshold.tokens)} limit` : "";
  const usage = count(before) && count(after) ? `: ${tokenLabel(before)}, now ${tokenLabel(after)}`
    : count(after) ? `. Now ${tokenLabel(after)}` : "";
  return `Context compacted${limit}${usage}.`;
}
