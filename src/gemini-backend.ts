import * as fs from "node:fs";
import * as path from "node:path";
import { grokCliNeedsShell } from "./cli-process";
import { isAntigravityCli } from "./gemini-cli-locator";
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

const PERMISSION_TITLE_LIMIT = 80;

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

export function contextWindowForModel(modelId: string): number {
  if (modelId.startsWith("gemini-")) return 1048576;
  if (modelId.startsWith("claude-")) return 200000;
  if (modelId.startsWith("gpt-oss-")) return 131072;
  return 1048576;
}

export const DEFAULT_GEMINI_MODELS = [
  {
    modelId: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    description: "Google's newest frontier workhorse for long-horizon coding and autonomous agentic workflows (1M context, 64K output)",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      totalContextTokens: 1048576,
    },
  },
  {
    modelId: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    description: "High-speed multimodal reasoning, deep code review, and interactive streaming",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      totalContextTokens: 1048576,
    },
  },
  {
    modelId: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    description: "Balanced performance, economy, and reasoning capability",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      totalContextTokens: 1048576,
    },
  },
  {
    modelId: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    description: "Google's flagship model for deep reasoning, architectural design, and complex algorithms",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEfforts: [{ value: "low" }, { value: "high" }],
      totalContextTokens: 1048576,
    },
  },
  {
    modelId: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    description: "Anthropic frontier reasoning and refactoring model via Antigravity",
    _meta: {
      supportsReasoningEffort: false,
      totalContextTokens: 200000,
    },
  },
  {
    modelId: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    description: "Anthropic flagship model for holistic system architecture via Antigravity",
    _meta: {
      supportsReasoningEffort: false,
      totalContextTokens: 200000,
    },
  },
  {
    modelId: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    description: "Open-weight frontier model hosted via Antigravity",
    _meta: {
      supportsReasoningEffort: false,
      totalContextTokens: 131072,
    },
  },
];

export interface AgyModelEntry {
  modelId: string;
  name: string;
  description?: string;
  _meta: {
    supportsReasoningEffort: boolean;
    reasoningEfforts?: Array<{ value: string }>;
    totalContextTokens?: number;
  };
}

export function parseAgyModelsOutput(output: string): {
  rawModels: Array<{ modelId: string; name: string }>;
  availableModels: AgyModelEntry[];
} {
  const lines = output.trim().split(/\r?\n/);
  const rawModels: Array<{ modelId: string; name: string }> = [];
  const grouped = new Map<string, { baseName: string; efforts: string[] }>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Fetching")) continue;
    const parts = line.split(/\t+/);
    const modelId = parts[0]?.trim();
    if (!modelId) continue;
    const displayName = parts[1]?.trim() || modelId;
    rawModels.push({ modelId, name: displayName });

    const match = /^(.*)-(high|medium|low)$/.exec(modelId);
    if (match) {
      const baseId = match[1];
      const effort = match[2];
      const baseName = displayName.replace(/\s*\((?:High|Medium|Low)\)$/i, "").trim();
      let group = grouped.get(baseId);
      if (!group) {
        group = { baseName, efforts: [] };
        grouped.set(baseId, group);
      }
      if (!group.efforts.includes(effort)) {
        group.efforts.push(effort);
      }
    } else {
      grouped.set(modelId, { baseName: displayName, efforts: [] });
    }
  }

  const availableModels: AgyModelEntry[] = [];
  const effortOrder = ["low", "medium", "high"];

  for (const [baseId, info] of grouped.entries()) {
    const orderedEfforts = effortOrder
      .filter((e) => info.efforts.includes(e))
      .map((value) => ({ value }));

    availableModels.push({
      modelId: baseId,
      name: info.baseName,
      _meta: {
        supportsReasoningEffort: orderedEfforts.length > 0,
        totalContextTokens: contextWindowForModel(baseId),
        ...(orderedEfforts.length > 0 ? { reasoningEfforts: orderedEfforts } : {}),
      },
    });
  }

  return { rawModels, availableModels };
}

export function modelsFromGeminiConfigOptions(configOptions: any): { currentModelId?: string; availableModels: any[] } {
  const options = Array.isArray(configOptions) ? configOptions : [];
  const model = options.find((option) => optionId(option) === "model");
  const effort = options.find((option) => optionId(option) === "reasoning_effort" || optionId(option) === "effort" || optionId(option) === "thinking");
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
      const matched = DEFAULT_GEMINI_MODELS.find((m) => m.modelId === modelId);
      const totalContextTokens = matched?._meta?.totalContextTokens ?? contextWindowForModel(modelId);
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

export function normalizeGeminiSessionResponse(response: any): any {
  if (!response || typeof response !== "object") return response;
  if (Array.isArray(response.models?.availableModels) && response.models.availableModels.length) {
    return response;
  }
  const models = modelsFromGeminiConfigOptions(response.configOptions);
  if (!models.availableModels.length && !models.currentModelId) return response;
  return { ...response, models };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeGeminiPromptResult(result: any): any {
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
      occupancyFromAdapterTurn: adapterContextOccupancy(normalizedUsage),
      totalTokens: normalizedUsage.totalTokens,
      inputTokens: normalizedUsage.inputTokens,
      outputTokens: normalizedUsage.outputTokens,
      cachedReadTokens: normalizedUsage.cachedReadTokens,
      cachedWriteTokens: normalizedUsage.cachedWriteTokens,
      reasoningTokens: normalizedUsage.reasoningTokens,
      usage: normalizedUsage,
    },
    usage: normalizedUsage,
  };
}

/**
 * Fallback synthesis for a native `gemini --acp` edit tool that reports raw
 * parameters instead of a diff block (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md
 * § 4.4). Antigravity (agy) never reaches this — its adapter process already
 * synthesizes the block before the update leaves the subprocess, so
 * `contentHasDiff` short-circuits here for that path. The field names below
 * (`old_string`/`new_string`, `file_path`/`content`) are the common ACP-tool
 * convention, not a confirmed native-Gemini capture (plan § Offene Fragen
 * #3) — harmless when wrong, since a real diff block always wins.
 */
function synthesizeGeminiDiff(rawInput: any): AcpDiffBlock | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const path = rawInput.file_path ?? rawInput.path;
  if (typeof path !== "string" || !path) return undefined;
  if (typeof rawInput.old_string === "string" && typeof rawInput.new_string === "string") {
    return synthesizeEditDiff({
      path,
      oldText: rawInput.old_string,
      newText: rawInput.new_string,
      replaceAll: rawInput.replace_all === true,
    });
  }
  const content = rawInput.content ?? rawInput.contents;
  if (typeof content === "string") {
    return synthesizeEditDiff({ path, oldText: "", newText: content });
  }
  return undefined;
}

export function normalizeGeminiUpdate(update: any, meta: any): BackendUpdate {
  const size = typeof update?.size === "number" ? update.size : (typeof update?.contextWindow === "number" ? update.contextWindow : 1048576);
  if (update?.rawInput && typeof update.rawInput === "object") {
    const r = update.rawInput;
    if (r.CommandLine && !r.command) {
      r.command = r.CommandLine;
      r.cmd = r.CommandLine;
    }
    if (r.TargetFile && !r.file_path) {
      r.file_path = r.TargetFile;
      r.path = r.TargetFile;
      r.target_file = r.TargetFile;
    }
    if (r.AbsolutePath && !r.file_path) {
      r.file_path = r.AbsolutePath;
      r.path = r.AbsolutePath;
    }
    if (r.DirectoryPath && !r.directory) {
      r.directory = r.DirectoryPath;
      r.target_directory = r.DirectoryPath;
      r.path = r.DirectoryPath;
    }
    if (r.Query && !r.pattern) {
      r.pattern = r.Query;
      r.query = r.Query;
    }
    if (r.Url && !r.url) {
      r.url = r.Url;
      r.uri = r.Url;
    }
  }
  if (update?.sessionUpdate === "usage_update") {
    return {
      update,
      meta,
      contextWindow: size,
      usageUpdateUsed: typeof update?.used === "number" ? update.used : undefined,
    };
  }
  if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
    if (!contentHasDiff(update.content)) {
      const diff = synthesizeGeminiDiff(update.rawInput);
      if (diff) {
        return {
          update: { ...update, content: mergeDiffIntoContent(update.content, diff) },
          meta,
          contextWindow: size,
        };
      }
    }
  }
  return { update, meta, contextWindow: size };
}

export function normalizeGeminiPermissionParams(params: any): any {
  const toolCall = params?.toolCall;
  if (!toolCall || typeof toolCall !== "object") return params;
  const diff = contentHasDiff(toolCall.content) ? undefined : synthesizeGeminiDiff(toolCall.rawInput);
  const withDiff = diff ? { ...toolCall, content: mergeDiffIntoContent(toolCall.content, diff) } : toolCall;
  if (typeof withDiff.title === "string" && withDiff.title.trim()) {
    return diff ? { ...(params ?? {}), toolCall: withDiff } : params;
  }
  const firstLine = typeof toolCall.rawInput?.command === "string"
    ? toolCall.rawInput.command.split(/\r?\n/, 1)[0].trim()
    : "";
  const title = firstLine.length > PERMISSION_TITLE_LIMIT
    ? `${firstLine.slice(0, PERMISSION_TITLE_LIMIT - 1)}…`
    : firstLine || `permission: ${toolCall.kind || "tool"}`;
  return { ...(params ?? {}), toolCall: { ...withDiff, title } };
}

export function configStateFromGeminiOptions(response: any, fallback: BackendConfigState): BackendConfigState {
  const options = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const byId = new Map<string, unknown>();
  for (const option of options) {
    const id = optionId(option);
    if (id) byId.set(id, optionValue(option));
  }
  const model = byId.get("model");
  const effort = byId.get("reasoning_effort") ?? byId.get("effort") ?? byId.get("thinking");
  const mode = byId.get("mode") ?? response?.modes?.currentModeId;
  return {
    modelId: typeof model === "string" ? model : fallback.modelId,
    reasoningEffort: typeof effort === "string" && effort !== "default" ? effort : fallback.reasoningEffort,
    modeId: typeof mode === "string" ? mode : fallback.modeId,
  };
}

export function geminiSessionPathKey(value: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path;
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function listGeminiSessions(
  fetchPage: (cursor?: string) => Promise<any>,
  cwd: string,
  platform: NodeJS.Platform,
  maxPages = 100,
): Promise<BackendSessionListResult> {
  const target = geminiSessionPathKey(cwd, platform);
  const sessions: BackendSessionListEntry[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    for (const entry of Array.isArray(result?.sessions) ? result.sessions : []) {
      if (!entry || typeof entry.sessionId !== "string" || typeof entry.cwd !== "string") continue;
      if (geminiSessionPathKey(entry.cwd, platform) !== target || ids.has(entry.sessionId)) continue;
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

export function isGeminiCredentialError(error: unknown): boolean {
  const value = error as any;
  const message = String(value?.message ?? value?.data?.message ?? value ?? "");
  return /not logged in|please run \/?login|sign.?in required|authentication required|auth[_ ]?required|session expired|invalid api key|gemini auth/i.test(message);
}

export interface GeminiBackendOptions {
  cliPath?: string;
  args?: string[];
  adapterPath?: string;
  nodePath?: string;
}

export function resolveAgyAcpAdapterPath(): string {
  const testAdapter = process.env.GROK_TEST_AGY_ACP_ADAPTER_PATH?.trim();
  if (testAdapter) return testAdapter;
  const candidateOut = path.join(__dirname, "agy-acp-adapter.js");
  if (fs.existsSync(candidateOut)) return candidateOut;
  const candidateSrc = path.join(__dirname, "agy-acp-adapter.ts");
  if (fs.existsSync(candidateSrc)) return candidateSrc;
  return candidateOut;
}

export class GeminiBackend implements AcpBackend {
  readonly provider = "gemini" as const;
  readonly processName = "Gemini ACP";
  readonly usesClientPlanGate = false;

  constructor(private readonly options: GeminiBackendOptions = {}) {}

  private adapterPath(): string {
    return this.options.adapterPath || resolveAgyAcpAdapterPath();
  }

  spawn(options: BackendSpawnOptions): BackendSpawnSpec {
    const cliPath = options.cliPath;
    if (isAntigravityCli(cliPath)) {
      const command = this.options.nodePath || process.execPath;
      return {
        command,
        args: [this.adapterPath()],
        env: {
          ...options.env,
          AGY_PATH: cliPath,
          AGY_CWD: options.cwd || "",
          ELECTRON_RUN_AS_NODE: "1",
        },
        shell: grokCliNeedsShell(command),
      };
    }
    const command = cliPath;
    const args = this.options.args ?? ["--acp"];
    return {
      command,
      args,
      env: {
        ...options.env,
      },
      shell: grokCliNeedsShell(command),
    };
  }

  normalizeSessionResponse(response: any): any {
    return normalizeGeminiSessionResponse(response);
  }

  normalizePromptResult(result: any): any {
    return normalizeGeminiPromptResult(result);
  }

  normalizeUpdate(update: any, meta: any): BackendUpdate {
    return normalizeGeminiUpdate(update, meta);
  }

  normalizePermissionParams(params: any): any {
    return normalizeGeminiPermissionParams(params);
  }

  setModel(sessionId: string, modelId: string): { method: string; params: any } {
    return { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelId } };
  }

  setReasoningEffort(sessionId: string, _modelId: string | undefined, level: string): { method: string; params: any } | null {
    return level
      ? { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: level } }
      : { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: "default" } };
  }

  setMode(sessionId: string, modeId: string): { method: string; params: any } {
    return { method: "session/set_mode", params: { sessionId, modeId } };
  }

  configState(response: any, fallback: BackendConfigState): BackendConfigState {
    return configStateFromGeminiOptions(response, fallback);
  }

  modelSetSucceeded(_response: any): boolean {
    return true;
  }

  listSessions(
    request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult> {
    return listGeminiSessions(
      (cursor) => request("session/list", cursor ? { cwd, cursor } : { cwd }),
      cwd,
      platform,
    );
  }

  isCredentialError(error: unknown): boolean {
    return isGeminiCredentialError(error);
  }
}
