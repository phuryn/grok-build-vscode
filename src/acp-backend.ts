import type { EffortLevel } from "./acp";

export const ACP_PROVIDERS = ["grok", "codex", "claude", "gemini"] as const;
export type AcpProvider = (typeof ACP_PROVIDERS)[number];

export function isAcpProvider(value: unknown): value is AcpProvider {
  return value === "grok" || value === "codex" || value === "claude" || value === "gemini";
}

/** Providers whose conversations live in an adapter catalog, not ~/.grok. */
export function isAdapterProvider(provider: AcpProvider): boolean {
  return provider === "codex" || provider === "claude" || provider === "gemini";
}

export interface BackendSpawnOptions {
  cliPath: string;
  cwd: string;
  effort?: EffortLevel;
  env: NodeJS.ProcessEnv;
}

export interface BackendSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

export interface BackendConfigState {
  modelId?: string;
  reasoningEffort?: string;
  modeId?: string;
}

export interface BackendUpdate {
  update?: any;
  meta?: any;
  sessionTitle?: string;
  contextWindow?: number;
  /**
   * Ordinary `usage_update.used` is billed per model call (includes output).
   * Compact's getContextUsage is the exception — the host only adopts this
   * when a compact just completed. Otherwise these are per-call observations
   * for occupancyFromAdapterTurn, not occupancy by themselves.
   */
  usageUpdateUsed?: number;
}

export interface BackendSessionListEntry {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string | number;
}

export interface BackendSessionListResult {
  sessions: BackendSessionListEntry[];
  nextCursor?: string | null;
}

export interface AcpBackend {
  readonly provider: AcpProvider;
  readonly processName: string;
  readonly usesClientPlanGate: boolean;
  spawn(options: BackendSpawnOptions): BackendSpawnSpec;
  normalizeSessionResponse(response: any): any;
  normalizePromptResult(result: any): any;
  normalizeUpdate(update: any, meta: any): BackendUpdate;
  normalizePermissionParams(params: any): any;
  setModel(sessionId: string, modelId: string, reasoningEffort?: string): { method: string; params: any };
  setReasoningEffort(sessionId: string, modelId: string | undefined, level: string): { method: string; params: any } | null;
  setMode(sessionId: string, modeId: string): { method: string; params: any };
  configState(response: any, fallback: BackendConfigState): BackendConfigState;
  modelSetSucceeded(response: any): boolean;
  listSessions(
    request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult>;
  isCredentialError(error: unknown): boolean;
}
