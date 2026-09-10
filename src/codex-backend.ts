import * as path from "node:path";
import packageManifest from "../package.json";
import { grokCliNeedsShell } from "./cli-process";
import type { PromptContentBlock } from "./acp";
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

export const CODEX_ACP_ADAPTER_VERSION = packageManifest.dependencies["@agentclientprotocol/codex-acp"];

export interface CompositeModelId {
  modelId: string;
  reasoningEffort: string;
}

export function parseCompositeModelId(value: unknown): CompositeModelId | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(.*)\[([^\[\]]+)\]$/.exec(value);
  if (!match || !match[1] || !match[2]) return undefined;
  return { modelId: match[1], reasoningEffort: match[2] };
}

export function compositeModelId(modelId: string, reasoningEffort: string): string {
  return `${modelId}[${reasoningEffort}]`;
}

export function normalizeCodexModels(models: any): any {
  const available = Array.isArray(models?.availableModels) ? models.availableModels : [];
  const current = parseCompositeModelId(models?.currentModelId);
  const grouped = new Map<string, { source: any; efforts: string[] }>();
  for (const source of available) {
    const parsed = parseCompositeModelId(source?.modelId);
    if (!parsed) continue;
    let group = grouped.get(parsed.modelId);
    if (!group) {
      group = { source, efforts: [] };
      grouped.set(parsed.modelId, group);
    }
    if (!group.efforts.includes(parsed.reasoningEffort)) group.efforts.push(parsed.reasoningEffort);
  }
  return {
    ...(models ?? {}),
    currentModelId: current?.modelId ?? models?.currentModelId,
    availableModels: [...grouped.entries()].map(([modelId, group]) => {
      // The adapter embeds the variant's effort in the display name — usually
      // parenthesized ("GPT-5.6-Sol (low)") — but effort is a separate
      // setting here, so the family name must carry no effort at all.
      const effortAlternation = group.efforts
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      const name = typeof group.source?.name === "string"
        ? (effortAlternation
          ? group.source.name
            .replace(/\[[^\[\]]+\]$/, "")
            .replace(new RegExp(`\\s*\\((?:${effortAlternation})\\)$`, "i"), "")
            .replace(new RegExp(`\\s+(?:${effortAlternation})$`, "i"), "")
          : group.source.name)
          .trim()
        : "";
      return {
        ...group.source,
        modelId,
        name: name || modelId,
        _meta: {
          ...(group.source?._meta ?? {}),
          supportsReasoningEffort: true,
          reasoningEfforts: group.efforts.map((value) => ({ value })),
          ...(current?.modelId === modelId ? { reasoningEffort: current.reasoningEffort } : {}),
        },
      };
    }),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeCodexPromptResult(result: any): any {
  const usage = result?.usage;
  if (!usage || typeof usage !== "object") return result;
  const normalizedUsage = {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    totalTokens: finiteNumber(usage.totalTokens),
    cachedReadTokens: finiteNumber(usage.cachedReadTokens),
    cachedWriteTokens: finiteNumber(usage.cachedWriteTokens),
    reasoningTokens: finiteNumber(usage.thoughtTokens),
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
      reasoningTokens: finiteNumber(usage.thoughtTokens),
      usage: normalizedUsage,
    },
  };
}

function normalizeDiffContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object" || (block as any).type !== "diff") return block;
    return (block as any).oldText === null ? { ...(block as any), oldText: "" } : block;
  });
}

// Codex MCP reuses the shell mapper (`kind: "execute"` + title
// `mcp.<server>.<tool>`). Remap to Claude's `kind: "other"` so the
// row shows that title instead of a bare "Run".
export function isCodexMcpToolCall(update: any): boolean {
  if (update?._meta?.is_mcp_tool_call === true) return true;
  const raw = update?.rawInput;
  return !!(raw && typeof raw === "object"
    && typeof raw.server === "string" && raw.server
    && typeof raw.tool === "string" && raw.tool
    && typeof raw.command !== "string");
}

function codexMcpTitle(update: any): string | undefined {
  const raw = update?.rawInput;
  if (raw && typeof raw.server === "string" && raw.server
      && typeof raw.tool === "string" && raw.tool) {
    return `mcp.${raw.server}.${raw.tool}`;
  }
  return undefined;
}

export function normalizeCodexUpdate(update: any, meta?: any): BackendUpdate {
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
    const rawOutput = update.rawOutput;
    const normalizedRawOutput = rawOutput && typeof rawOutput === "object" && typeof rawOutput.formatted_output === "string"
      ? { ...rawOutput, output: rawOutput.formatted_output }
      : rawOutput;
    const mcp = isCodexMcpToolCall(update);
    const title = typeof update.title === "string" && update.title.trim()
      ? update.title
      : mcp && update.sessionUpdate === "tool_call" ? codexMcpTitle(update) : undefined;
    const kind = mcp && update.kind === "execute" ? "other" : update.kind;
    return {
      update: {
        ...update,
        ...(normalizedRawOutput === undefined ? {} : { rawOutput: normalizedRawOutput }),
        ...(update.content === undefined ? {} : { content: normalizeDiffContent(update.content) }),
        ...(kind !== update.kind ? { kind } : {}),
        ...(title !== undefined && title !== update.title ? { title } : {}),
      },
      meta,
    };
  }
  return { update, meta };
}

const PERMISSION_TITLE_LIMIT = 80;

export function normalizeCodexPermissionParams(params: any): any {
  const toolCall = params?.toolCall ?? {};
  const firstLine = typeof toolCall?.rawInput?.command === "string"
    ? toolCall.rawInput.command.split(/\r?\n/, 1)[0].trim()
    : "";
  const title = typeof toolCall.title === "string" && toolCall.title.trim()
    ? toolCall.title
    : firstLine.length > PERMISSION_TITLE_LIMIT
      ? `${firstLine.slice(0, PERMISSION_TITLE_LIMIT - 1)}…`
      : firstLine || `permission: ${toolCall.kind || "tool"}`;
  const options = Array.isArray(params?.options)
    ? params.options.filter((option: any) => !String(option?.optionId ?? "").includes("accept_execpolicy_amendment"))
    : [];
  return { ...(params ?? {}), toolCall: { ...toolCall, title }, options };
}

function optionId(option: any): string | undefined {
  const value = option?.id ?? option?.configId;
  return typeof value === "string" ? value : undefined;
}

function optionValue(option: any): unknown {
  return option?.currentValue ?? option?.value;
}

/**
 * Codex reports two axes at once: `collaboration_mode` (Plan vs Default) and
 * permission `mode` (`agent` / `agent-full-access`). Plan wins; otherwise the
 * permission mode is the host-facing id. Flattening collaboration `default` to
 * `"default"` discarded full-access and the toolbar then claimed Agent.
 */
export function codexEffectiveModeId(
  collaboration: unknown,
  mode: unknown,
  fallback?: string,
): string | undefined {
  if (collaboration === "plan") return "plan";
  if (typeof mode === "string") return mode;
  if (collaboration === "default") return "default";
  return fallback;
}

export function configStateFromCodexOptions(response: any, fallback: BackendConfigState): BackendConfigState {
  const options = Array.isArray(response?.configOptions) ? response.configOptions : [];
  const byId = new Map<string, unknown>();
  for (const option of options) {
    const id = optionId(option);
    if (id) byId.set(id, optionValue(option));
  }
  const model = byId.get("model");
  const effort = byId.get("reasoning_effort");
  return {
    modelId: typeof model === "string" ? model : fallback.modelId,
    reasoningEffort: typeof effort === "string" ? effort : fallback.reasoningEffort,
    modeId: codexEffectiveModeId(byId.get("collaboration_mode"), byId.get("mode"), fallback.modeId),
  };
}

export function codexSessionPathKey(value: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path;
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function listAllCodexSessions(
  fetchPage: (cursor?: string) => Promise<any>,
  cwd: string,
  platform: NodeJS.Platform,
  maxPages = 100,
): Promise<BackendSessionListResult> {
  const target = codexSessionPathKey(cwd, platform);
  const sessions: BackendSessionListEntry[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    for (const entry of Array.isArray(result?.sessions) ? result.sessions : []) {
      if (!entry || typeof entry.sessionId !== "string" || typeof entry.cwd !== "string") continue;
      if (codexSessionPathKey(entry.cwd, platform) !== target || ids.has(entry.sessionId)) continue;
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

export function isCodexCredentialError(error: unknown): boolean {
  const value = error as any;
  const message = String(value?.message ?? value?.data?.message ?? value ?? "");
  // TODO: replace this conservative classifier when the adapter documents its
  // signed-out JSON-RPC error code and data shape.
  return /not logged in|sign.?in required|authentication required|missing (?:codex|openai) credentials?|invalid api key/i.test(message);
}

export interface CodexBackendOptions {
  adapterPath?: string;
  nodePath?: string;
}

export class CodexBackend implements AcpBackend {
  readonly provider = "codex" as const;
  readonly processName = "Codex ACP adapter";
  readonly usesClientPlanGate = false;

  constructor(private readonly options: CodexBackendOptions = {}) {}

  private adapterPath(): string {
    if (this.options.adapterPath) return this.options.adapterPath;
    const testAdapter = process.env.NODE_ENV === "test"
      ? process.env.GROK_TEST_CODEX_ACP_ADAPTER_PATH?.trim()
      : undefined;
    if (testAdapter) return testAdapter;
    return require.resolve("@agentclientprotocol/codex-acp");
  }

  spawn(options: BackendSpawnOptions): BackendSpawnSpec {
    const command = this.options.nodePath || process.execPath;
    return {
      command,
      args: [this.adapterPath()],
      env: {
        ...options.env,
        CODEX_PATH: options.cliPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
      shell: grokCliNeedsShell(command),
    };
  }

  normalizeSessionResponse(response: any): any {
    return response?.models ? { ...response, models: normalizeCodexModels(response.models) } : response;
  }

  normalizePromptResult(result: any): any { return normalizeCodexPromptResult(result); }
  normalizeUpdate(update: any, meta: any): BackendUpdate { return normalizeCodexUpdate(update, meta); }
  normalizePermissionParams(params: any): any { return normalizeCodexPermissionParams(params); }

  setModel(sessionId: string, modelId: string): { method: string; params: any } {
    return { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelId } };
  }

  setReasoningEffort(sessionId: string, _modelId: string | undefined, level: string): { method: string; params: any } | null {
    return level ? { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: level } } : null;
  }

  setMode(sessionId: string, modeId: string): { method: string; params: any } {
    if (modeId === "plan" || modeId === "default") {
      return { method: "session/set_config_option", params: { sessionId, configId: "collaboration_mode", value: modeId } };
    }
    return { method: "session/set_config_option", params: { sessionId, configId: "mode", value: modeId } };
  }

  steeringCapabilities(initializeResult: any) {
    const supported = initializeResult?._meta?.steering?.supported === true;
    return { supported, acceptsContent: supported };
  }

  interject(sessionId: string, text: string, content?: readonly PromptContentBlock[]) {
    return {
      method: "_session/steering",
      params: { sessionId, prompt: content?.length ? [...content] : [{ type: "text", text }] },
    };
  }

  configState(response: any, fallback: BackendConfigState): BackendConfigState {
    return configStateFromCodexOptions(response, fallback);
  }

  modelSetSucceeded(_response: any): boolean { return true; }

  listSessions(
    request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult> {
    return listAllCodexSessions(
      (cursor) => request("session/list", cursor ? { cursor } : {}),
      cwd,
      platform,
    );
  }

  isCredentialError(error: unknown): boolean { return isCodexCredentialError(error); }
}
