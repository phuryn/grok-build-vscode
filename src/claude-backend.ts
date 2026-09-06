import * as fs from "node:fs";
import * as path from "node:path";
import packageManifest from "../package.json";
import { grokCliNeedsShell } from "./cli-process";
import type {
  AcpBackend,
  BackendConfigState,
  BackendSessionListEntry,
  BackendSessionListResult,
  BackendSpawnOptions,
  BackendSpawnSpec,
  BackendUpdate,
} from "./acp-backend";
import { adapterContextOccupancy } from "./acp-dispatch";

export const CLAUDE_ACP_ADAPTER_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_ACP_ADAPTER_VERSION = packageManifest.dependencies[CLAUDE_ACP_ADAPTER_PACKAGE];

/** The Claude Code CLI version this release is built and tested against.
 *
 *  Codex has had `CODEX_MANAGED_VERSION` all along, and Claude had nothing —
 *  so the Settings row offered to update Claude forever, including seconds
 *  after an update had just reported success. "We cannot know what is current"
 *  was true of the wire and false of the product: we know which version we
 *  built against, which is the same thing the Codex pin claims.
 *
 *  There is no managed installer behind this the way there is for Codex; it
 *  is a comparison point, nothing more. Bump it when a release is validated
 *  against a newer CLI. Falling behind Anthropic's latest is the safe
 *  direction — it means we stop offering, not that we offer wrongly. */
export const CLAUDE_PINNED_CLI_VERSION = "2.1.263";

const PERMISSION_TITLE_LIMIT = 80;

export function resolveClaudeAgentAcpAdapter(
  resolvePath: (specifier: string) => string = require.resolve,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): string {
  // The package exports no CJS main — require.resolve(package) throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED. package.json is exported via "./*".
  const manifestPath = resolvePath(`${CLAUDE_ACP_ADAPTER_PACKAGE}/package.json`);
  let bin: unknown;
  try {
    const manifest = JSON.parse(readFile(manifestPath)) as { bin?: string | Record<string, string> };
    bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["claude-agent-acp"];
  } catch {
    bin = undefined;
  }
  if (typeof bin !== "string" || !bin.trim()) {
    throw new Error(`${CLAUDE_ACP_ADAPTER_PACKAGE} does not declare a claude-agent-acp bin entry.`);
  }
  return path.join(path.dirname(manifestPath), bin);
}

function optionId(option: any): string | undefined {
  const value = option?.id ?? option?.configId;
  return typeof value === "string" ? value : undefined;
}

function optionValue(option: any): unknown {
  return option?.currentValue ?? option?.value;
}

function selectOptions(option: any): any[] {
  return Array.isArray(option?.options) ? option.options : [];
}

/** session/new returns configOptions, not the models envelope the host picker reads. */
export function modelsFromClaudeConfigOptions(configOptions: any): { currentModelId?: string; availableModels: any[] } {
  const options = Array.isArray(configOptions) ? configOptions : [];
  const model = options.find((option) => optionId(option) === "model");
  const effort = options.find((option) => optionId(option) === "effort");
  const currentModelId = typeof optionValue(model) === "string" ? optionValue(model) as string : undefined;
  const currentEffort = typeof optionValue(effort) === "string" ? optionValue(effort) as string : undefined;
  const effortValues = selectOptions(effort)
    .map((entry) => entry?.value)
    .filter((value): value is string => typeof value === "string" && value !== "default");
  return {
    currentModelId,
    availableModels: selectOptions(model).flatMap((entry) => {
      const modelId = typeof entry?.value === "string" ? entry.value : "";
      if (!modelId) return [];
      return [{
        modelId,
        name: typeof entry?.name === "string" && entry.name.trim() ? entry.name : modelId,
        description: typeof entry?.description === "string" ? entry.description : undefined,
        _meta: {
          supportsReasoningEffort: effortValues.length > 0,
          reasoningEfforts: effortValues.map((value) => ({ value })),
          ...(currentModelId === modelId && currentEffort && currentEffort !== "default"
            ? { reasoningEffort: currentEffort }
            : {}),
        },
      }];
    }),
  };
}

export function normalizeClaudeSessionResponse(response: any): any {
  if (!response || typeof response !== "object") return response;
  if (Array.isArray(response.models?.availableModels) && response.models.availableModels.length) {
    return response;
  }
  const models = modelsFromClaudeConfigOptions(response.configOptions);
  if (!models.availableModels.length && !models.currentModelId) return response;
  return { ...response, models };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeClaudePromptResult(result: any): any {
  const usage = result?.usage;
  if (!usage || typeof usage !== "object") return result;
  const normalizedUsage = {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    totalTokens: finiteNumber(usage.totalTokens),
    cachedReadTokens: finiteNumber(usage.cachedReadTokens),
    cachedWriteTokens: finiteNumber(usage.cachedWriteTokens),
    reasoningTokens: finiteNumber(usage.thoughtTokens ?? usage.reasoningTokens),
  };
  return {
    ...result,
    _meta: {
      ...(result?._meta ?? {}),
      // Donut occupancy, not the billed sum the adapter puts in usage.totalTokens.
      totalTokens: adapterContextOccupancy(normalizedUsage) ?? finiteNumber(usage.totalTokens),
      inputTokens: finiteNumber(usage.inputTokens),
      outputTokens: finiteNumber(usage.outputTokens),
      cachedReadTokens: finiteNumber(usage.cachedReadTokens),
      cachedWriteTokens: finiteNumber(usage.cachedWriteTokens),
      reasoningTokens: normalizedUsage.reasoningTokens,
      usage: normalizedUsage,
    },
  };
}

export function normalizeClaudeUpdate(update: any, meta?: any): BackendUpdate {
  if (!update || typeof update !== "object") return { update, meta };
  if (update.sessionUpdate === "session_info_update") {
    const title = [update.title, update.sessionTitle, update.name, update.sessionInfo?.title, update._meta?.title]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    return { sessionTitle: title?.trim() };
  }
  if (update.sessionUpdate === "usage_update") {
    const used = finiteNumber(update.used);
    const size = finiteNumber(update.size);
    return {
      update,
      meta,
      contextWindow: size,
      usageUpdateUsed: used,
    };
  }
  return { update, meta };
}

export function normalizeClaudePermissionParams(params: any): any {
  const toolCall = params?.toolCall ?? {};
  if (typeof toolCall.title === "string" && toolCall.title.trim()) return params;
  const firstLine = typeof toolCall?.rawInput?.command === "string"
    ? toolCall.rawInput.command.split(/\r?\n/, 1)[0].trim()
    : "";
  const title = firstLine.length > PERMISSION_TITLE_LIMIT
    ? `${firstLine.slice(0, PERMISSION_TITLE_LIMIT - 1)}…`
    : firstLine || `permission: ${toolCall.kind || "tool"}`;
  return { ...(params ?? {}), toolCall: { ...toolCall, title } };
}

export function configStateFromClaudeOptions(response: any, fallback: BackendConfigState): BackendConfigState {
  const options = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const byId = new Map<string, unknown>();
  for (const option of options) {
    const id = optionId(option);
    if (id) byId.set(id, optionValue(option));
  }
  const model = byId.get("model");
  const effort = byId.get("effort");
  const mode = byId.get("mode") ?? response?.modes?.currentModeId;
  return {
    modelId: typeof model === "string" ? model : fallback.modelId,
    reasoningEffort: typeof effort === "string" && effort !== "default" ? effort : fallback.reasoningEffort,
    modeId: typeof mode === "string" ? mode : fallback.modeId,
  };
}

/** Host Agent/Plan/Auto-accept ids onto Claude's native permission modes. */
export function claudeModeId(modeId: string): string {
  if (modeId === "yolo") return "bypassPermissions";
  if (modeId === "agent") return "default";
  return modeId;
}

export function claudeSessionPathKey(value: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path;
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function listClaudeSessions(
  fetchPage: (cursor?: string) => Promise<any>,
  cwd: string,
  platform: NodeJS.Platform,
  maxPages = 100,
): Promise<BackendSessionListResult> {
  const target = claudeSessionPathKey(cwd, platform);
  const sessions: BackendSessionListEntry[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    for (const entry of Array.isArray(result?.sessions) ? result.sessions : []) {
      if (!entry || typeof entry.sessionId !== "string" || typeof entry.cwd !== "string") continue;
      if (claudeSessionPathKey(entry.cwd, platform) !== target || ids.has(entry.sessionId)) continue;
      ids.add(entry.sessionId);
      sessions.push(entry);
    }
    const next = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!next || cursors.has(next)) return { sessions, nextCursor: null };
    cursors.add(next);
    cursor = next;
  }
  return { sessions, nextCursor: null };
}

export function isClaudeCredentialError(error: unknown): boolean {
  const value = error as any;
  const message = String(value?.message ?? value?.data?.message ?? value ?? "");
  // Quota/rate-limit stays out of this classifier so it cannot open a login screen.
  return /not logged in|please run \/login|sign.?in required|authentication required|auth[_ ]?required|session expired|missing (?:claude|anthropic) credentials?|invalid api key|does not support using claude\.ai subscriptions/i.test(message);
}

export interface ClaudeBackendOptions {
  adapterPath?: string;
  nodePath?: string;
}

export class ClaudeBackend implements AcpBackend {
  readonly provider = "claude" as const;
  readonly processName = "Claude ACP adapter";
  // Claude's Plan mode is a native SDK permission mode ("no actual tool
  // execution"). The client gate exists because grok's Plan still lets shell
  // through; do not port that workaround here.
  readonly usesClientPlanGate = false;

  constructor(private readonly options: ClaudeBackendOptions = {}) {}

  private adapterPath(): string {
    if (this.options.adapterPath) return this.options.adapterPath;
    const testAdapter = process.env.NODE_ENV === "test"
      ? process.env.GROK_TEST_CLAUDE_ACP_ADAPTER_PATH?.trim()
      : undefined;
    if (testAdapter) return testAdapter;
    return resolveClaudeAgentAcpAdapter();
  }

  spawn(options: BackendSpawnOptions): BackendSpawnSpec {
    const command = this.options.nodePath || process.execPath;
    // Deliberately omit `--hide-claude-auth`. That flag makes the adapter
    // reject Claude subscription accounts that already work in official Claude
    // Code. We never handle the credential either way — Anthropic's CLI does.
    return {
      command,
      args: [this.adapterPath()],
      env: {
        ...options.env,
        // User's official Claude Code binary. Without this the adapter looks
        // for the SDK's optional native package, which we do not ship.
        CLAUDE_CODE_EXECUTABLE: options.cliPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
      shell: grokCliNeedsShell(command),
    };
  }

  normalizeSessionResponse(response: any): any {
    return normalizeClaudeSessionResponse(response);
  }

  normalizePromptResult(result: any): any { return normalizeClaudePromptResult(result); }
  normalizeUpdate(update: any, meta: any): BackendUpdate { return normalizeClaudeUpdate(update, meta); }
  normalizePermissionParams(params: any): any { return normalizeClaudePermissionParams(params); }

  setModel(sessionId: string, modelId: string): { method: string; params: any } {
    return { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelId } };
  }

  setReasoningEffort(sessionId: string, _modelId: string | undefined, level: string): { method: string; params: any } | null {
    return level
      ? { method: "session/set_config_option", params: { sessionId, configId: "effort", value: level } }
      : { method: "session/set_config_option", params: { sessionId, configId: "effort", value: "default" } };
  }

  setMode(sessionId: string, modeId: string): { method: string; params: any } {
    return { method: "session/set_mode", params: { sessionId, modeId: claudeModeId(modeId) } };
  }

  configState(response: any, fallback: BackendConfigState): BackendConfigState {
    return configStateFromClaudeOptions(response, fallback);
  }

  modelSetSucceeded(_response: any): boolean { return true; }

  listSessions(
    request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult> {
    return listClaudeSessions(
      (cursor) => request("session/list", cursor ? { cwd, cursor } : { cwd }),
      cwd,
      platform,
    );
  }

  isCredentialError(error: unknown): boolean { return isClaudeCredentialError(error); }
}
