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
import { contentHasDiff, mergeDiffIntoContent, synthesizeEditDiff, type AcpDiffBlock } from "./diff-synthesize";

export const CLAUDE_ACP_ADAPTER_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_ACP_ADAPTER_VERSION = packageManifest.dependencies[CLAUDE_ACP_ADAPTER_PACKAGE];

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

export function contextWindowForClaudeModel(modelId?: string, name?: string, description?: string): number {
  const combined = `${modelId ?? ""} ${name ?? ""} ${description ?? ""}`.toLowerCase();
  if (/\b1m\b/i.test(combined)) return 1_000_000;
  if (/\b200k\b/i.test(combined)) return 200_000;
  if (/\bhaiku\b/i.test(combined) && !/\b1m\b/i.test(combined)) return 200_000;
  if (/\bclaude-3\b/i.test(combined) && !/\b1m\b/i.test(combined)) return 200_000;
  return 1_000_000;
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
      const totalContextTokens = contextWindowForClaudeModel(modelId, entry?.name, entry?.description);
      return [{
        modelId,
        name: typeof entry?.name === "string" && entry.name.trim() ? entry.name : modelId,
        description: typeof entry?.description === "string" ? entry.description : undefined,
        _meta: {
          supportsReasoningEffort: effortValues.length > 0,
          reasoningEfforts: effortValues.map((value) => ({ value })),
          totalContextTokens,
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

/**
 * Build a `{ type: "diff" }` block from a Claude tool call's `rawInput`
 * (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 4.2). Claude's Edit tool reports
 * `old_string`/`new_string`/`file_path`(/`replace_all`); its Write tool
 * reports `file_path`/`content` with no prior text at all. The Write side
 * therefore always synthesizes `oldText: ""` — a real disk read would need an
 * async host hook this synchronous normalizer cannot make, so an overwrite
 * renders as a pure add here and gets corrected only if Claude's own
 * completed update later carries a real diff (idempotency rule: a native
 * diff for the path always wins).
 */
function synthesizeClaudeDiff(rawInput: any): AcpDiffBlock | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  if (typeof rawInput.old_string === "string" && typeof rawInput.new_string === "string") {
    const path = rawInput.file_path ?? rawInput.path;
    if (typeof path !== "string" || !path) return undefined;
    return synthesizeEditDiff({
      path,
      oldText: rawInput.old_string,
      newText: rawInput.new_string,
      replaceAll: rawInput.replace_all === true,
    });
  }
  const path = rawInput.file_path ?? rawInput.path;
  const content = rawInput.content ?? rawInput.contents;
  if (typeof path === "string" && path && typeof content === "string") {
    return synthesizeEditDiff({ path, oldText: "", newText: content });
  }
  return undefined;
}

export function normalizeClaudeUpdate(
  update: any,
  meta?: any,
  diffCache?: Map<string, AcpDiffBlock>,
): BackendUpdate {
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
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (contentHasDiff(update.content)) {
      if (id && diffCache) {
        const diff = (update.content as any[]).find((b) => b && typeof b === "object" && b.type === "diff");
        if (diff) diffCache.set(id, diff);
      }
      return { update, meta };
    }
    const diff = synthesizeClaudeDiff(update.rawInput);
    if (diff) {
      if (id && diffCache) diffCache.set(id, diff);
      return { update: { ...update, content: mergeDiffIntoContent(update.content, diff) }, meta };
    }
    if (id && diffCache) {
      const cached = diffCache.get(id);
      if (cached) {
        return { update: { ...update, content: mergeDiffIntoContent(update.content, cached) }, meta };
      }
    }
    return { update, meta };
  }
  return { update, meta };
}

export function normalizeClaudePermissionParams(params: any): any {
  const toolCall = params?.toolCall ?? {};
  const diff = contentHasDiff(toolCall.content) ? undefined : synthesizeClaudeDiff(toolCall.rawInput);
  const withDiff = diff ? { ...toolCall, content: mergeDiffIntoContent(toolCall.content, diff) } : toolCall;
  if (typeof withDiff.title === "string" && withDiff.title.trim()) {
    return diff ? { ...(params ?? {}), toolCall: withDiff } : params;
  }
  const firstLine = typeof toolCall?.rawInput?.command === "string"
    ? toolCall.rawInput.command.split(/\r?\n/, 1)[0].trim()
    : "";
  const title = firstLine.length > PERMISSION_TITLE_LIMIT
    ? `${firstLine.slice(0, PERMISSION_TITLE_LIMIT - 1)}…`
    : firstLine || `permission: ${toolCall.kind || "tool"}`;
  return { ...(params ?? {}), toolCall: { ...withDiff, title } };
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
  private readonly toolDiffsById = new Map<string, AcpDiffBlock>();

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
  normalizeUpdate(update: any, meta: any): BackendUpdate {
    const res = normalizeClaudeUpdate(update, meta, this.toolDiffsById);
    if (this.toolDiffsById.size > 500) {
      const oldest = this.toolDiffsById.keys().next().value;
      if (oldest) this.toolDiffsById.delete(oldest);
    }
    return res;
  }
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
