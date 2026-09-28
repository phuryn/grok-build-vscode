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
import { ClaudeWorkflows } from "./claude-workflows";

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
export const CLAUDE_PINNED_CLI_VERSION = "2.1.281";

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

/** The picker shows the DESCRIPTION's lead when it is a fuller spelling of the
 *  name (`modelPickerLabel`) — which is how Codex's rows read "6 Astra" rather
 *  than "GPT-6". Claude's Opus row breaks that: measured 2026-09-14, its name
 *  is "Opus 5" and its description "Opus 5 with 1M context · Best for everyday,
 *  complex tasks", so the fuller-spelling rule promoted a CAPABILITY qualifier
 *  into the model's name and the composer chip read "Opus 5 with 1M context".
 *  Every sibling row is `<name> · <blurb>`; this one row is not, so the fix
 *  belongs here rather than in the shared label rule that Codex depends on. */
export function claudeModelDescription(description: unknown): string | undefined {
  if (typeof description !== "string") return undefined;
  return description.replace(/\s+with\s+\d+(?:\.\d+)?[KM]\s+context\b/i, "");
}

/** The vendor's "Default (recommended)" row. Dropped from the picker: its own
 *  description names the model it resolves to ("Opus (1M context)"), so it sits
 *  in a list of models as a second, differently-named way to pick one that is
 *  already there — and the picker is for choosing a model, not a policy.
 *
 *  Kept when it is the CURRENT value, because a session really can be on it
 *  (it is the value a fresh Claude install carries) and a row that is selected
 *  but absent leaves the picker with nothing checked and the composer chip
 *  reading the raw id. Nothing else restores it: moving off it is one-way
 *  inside this picker, and `claude`'s own `/model` is the way back. */
const CLAUDE_DEFAULT_MODEL_ID = "default";

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
      if (modelId === CLAUDE_DEFAULT_MODEL_ID && currentModelId !== CLAUDE_DEFAULT_MODEL_ID) return [];
      return [{
        modelId,
        name: typeof entry?.name === "string" && entry.name.trim() ? entry.name : modelId,
        description: claudeModelDescription(entry?.description),
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

// Replay retains the generated script filename: <launched name>-<exact run id>.js.
function claudeWorkflowName(output: string, runId: string): string {
  const file = /^Script file:\s*(.+)$/m.exec(output)?.[1]?.trim().split(/[\\/]/).pop();
  const suffix = `-${runId}.js`;
  return file?.endsWith(suffix) ? file.slice(0, -suffix.length) : "Workflow";
}

const claudeText = (raw: any): string | undefined => typeof raw === "string" ? raw
  : Array.isArray(raw) ? raw.filter(c => c?.type === "text").map(c => c.text).join("\n") : undefined;
const taskTerminal = (state: string | undefined) => !!state && /^(completed|failed|stopped|cancelled)$/.test(state);
const taskTag = (text: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim();
const cleanClaudeError = (text: string) => text.replace(/^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/, "$1").trim();

/** Receipts and task edges arrive separately, sometimes in the opposite order. */
class ClaudeSubagents {
  private readonly calls = new Set<string>();
  private readonly agents = new Map<string, string>();
  private readonly tasks = new Map<string, { toolCallId?: string; taskType?: string; state?: string; output?: string; durationMs?: number; tokens?: number }>();

  accept(update: any): any {
    const claude = update._meta?.claudeCode;
    const callId = update.toolCallId;
    if ((claude?.toolName === "Agent" || claude?.subagent === true) && typeof callId === "string") this.calls.add(callId);
    const text = update.content?.type === "text" ? update.content.text : undefined;
    const notification = update.sessionUpdate === "user_message_chunk" && typeof text === "string" && /^\s*<task-notification>/.test(text);
    if (update.sessionUpdate?.startsWith("async_task_") || notification) {
      const id = notification ? taskTag(text, "task-id") : update.asyncTaskId;
      const toolId = notification ? taskTag(text, "tool-use-id") : callId;
      if (typeof id !== "string" || !id) return;
      const task = this.tasks.get(id) || {};
      const mapped = this.agents.get(id);
      if (toolId && ((mapped && mapped !== toolId) || (task.toolCallId && task.toolCallId !== toolId))) return;
      const owner = mapped || toolId || task.toolCallId;
      if (owner && [...this.agents].some(([key, value]) => value === owner && key !== id)) return;
      if (toolId) task.toolCallId = toolId;
      if (update.taskType) task.taskType = update.taskType;
      const state = notification ? taskTag(text, "status") : update.state
        ?? (["async_task_spawned", "async_task_progress"].includes(update.sessionUpdate) ? "running" : undefined);
      // A level-derived stopped edge can be corrected by the final task event.
      if (typeof state === "string" && /^(running|paused|completed|failed|stopped|cancelled)$/.test(state)
          && (!taskTerminal(task.state) || (task.state === "stopped" && taskTerminal(state)) || task.state === state)) {
        task.state = state;
        const result = notification ? taskTag(text, "result") ?? taskTag(text, "summary") : update.summary;
        if (taskTerminal(state) && typeof result === "string") task.output = cleanClaudeError(result);
      }
      const usage = update.usage;
      if (finiteNumber(usage?.durationMs) !== undefined) task.durationMs = usage.durationMs;
      if (finiteNumber(usage?.totalTokens) !== undefined) task.tokens = usage.totalTokens;
      this.tasks.set(id, task);
      if (!owner || !this.calls.has(owner) || (task.taskType && !["agent", "local_agent", "subagent", "task"].includes(task.taskType))) return;
      this.agents.set(id, owner);
      return this.snapshot(owner, task);
    }
    if (!this.calls.has(callId)) return;
    const output = claudeText(update.rawOutput) ?? claudeText(update.content?.map?.((c: any) => c.content));
    const receipt = /^\s*Async agent launched successfully\./.test(output || "");
    const response = claude?.toolResponse;
    if (!receipt && response?.isAsync !== true && response?.status !== "async_launched") return;
    const id = response?.agentId ?? response?.taskId ?? /^agentId:\s*(\S+)/m.exec(output || "")?.[1];
    if (typeof id === "string" && id) this.agents.set(id, callId);
    // Nothing from the model-facing receipt belongs in either output channel.
    const task = this.tasks.get(id);
    return { ...update, ...this.snapshot(callId, task?.toolCallId && task.toolCallId !== callId ? {} : task || {}), sessionUpdate: update.sessionUpdate };
  }

  private snapshot(toolCallId: string, task: any): any {
    // The installed adapter omits local_agent task events. A receipt alone
    // settles as background, with no claim that work is still running.
    return { sessionUpdate: "tool_call_update", toolCallId,
      status: task.state === "completed" ? "completed" : task.state === "failed" ? "failed"
        : task.state === "stopped" || task.state === "cancelled" ? "cancelled" : task.state ? "in_progress" : "background",
      rawOutput: { output: task.output || "" }, content: [],
      _meta: { claudeCode: { toolName: "Agent", subagent: true }, subagentStatusAuthoritative: true,
        subagentUsage: { durationMs: task.durationMs, tokens: task.tokens } },
    };
  }
}

export function normalizeClaudeUpdate(update: any, meta?: any, subagents = new ClaudeSubagents()): BackendUpdate {
  if (!update || typeof update !== "object") return { update, meta };
  const subagent = subagents.accept(update);
  const text = update.content?.type === "text" ? update.content.text : undefined;
  if (update.sessionUpdate === "user_message_chunk" && typeof text === "string"
      && /^\s*<task-notification>/.test(text)) {
    const status = /<status>([^<]*)<\/status>/.exec(text)?.[1];
    // This is a system wake-up, not a user prompt. Never expose its XML,
    // paths or diagnostic instructions as a user bubble on resume.
    return { update: subagent, meta, notice: `Background task ${status && /^(completed|failed|cancelled|stopped)$/.test(status) ? status : "updated"}.` };
  }
  if (subagent) return { update: subagent, meta };
  const claude = update._meta?.claudeCode;
  if (claude?.toolName === "Agent" || claude?.subagent === true) {
    const response = claude.toolResponse;
    const raw = update.rawOutput;
    let output = claudeText(raw);
    if (output !== undefined && update.status === "failed") output = cleanClaudeError(output);
    let durationMs = finiteNumber(response?.totalDurationMs);
    let tokens = finiteNumber(response?.totalTokens);
    // Replay drops toolResponse but keeps this framed hand-back, including
    // the usage trailer. Strip only that envelope, retaining report Markdown.
    if (output?.startsWith("[Subagent hand-back]")) {
      const usage = /<usage>([\s\S]*?)<\/usage>/.exec(output)?.[1] || "";
      const duration = /duration_ms:\s*(\d+)/.exec(usage);
      const tokenCount = /subagent_tokens:\s*(\d+)/.exec(usage);
      durationMs ??= duration ? Number(duration[1]) : undefined;
      tokens ??= tokenCount ? Number(tokenCount[1]) : undefined;
      output = output.replace(/^[\s\S]*?The report follows:\s*\n/, "")
        .replace(/\nagentId:[\s\S]*$/, "").replace(/^  /gm, "").trim();
    }
    if (output !== undefined || durationMs !== undefined || tokens !== undefined) return { meta, update: {
      ...update,
      _meta: { ...update._meta, subagentUsage: { durationMs, tokens } },
      ...(output === undefined ? {} : { rawOutput: { output }, content: [{ type: "content", content: { type: "text", text: output } }] }),
    } };
  }
  if (claude?.toolName === "Workflow") {
    const response = claude.toolResponse;
    const output = typeof update.rawOutput === "string" ? update.rawOutput : "";
    const launched = response?.status === "async_launched" && response.taskType === "local_workflow";
    // Replay drops toolResponse, but retains this launch acknowledgement.
    const replayRun = /^Workflow launched in background\./.test(output)
      ? /^Run ID:\s*(\S+)/m.exec(output)?.[1] : undefined;
    const runId = launched ? response.runId : replayRun;
    if (typeof runId === "string" && runId) return { update, meta, workflowUpdate: {
      sessionUpdate: "workflow_updated", run_id: runId, status: "launched",
      launchOnly: true,
      name: (launched ? response.workflowName : undefined) || claudeWorkflowName(output, runId), objective: launched ? response.summary : /^Summary:\s*(.+)$/m.exec(output)?.[1],
      controlsAvailable: false,
    } };
  }
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
  private readonly workflows = new ClaudeWorkflows();
  private readonly subagents = new ClaudeSubagents();
  normalizeUpdate(update: any, meta: any): BackendUpdate {
    this.workflows.toolInput(update);
    const result = normalizeClaudeUpdate(update, meta, this.subagents);
    if (["async_task_spawned", "async_task_progress", "async_task_state_update"].includes(update?.sessionUpdate)) {
      return { update: result.update === update ? undefined : result.update, meta, workflowUpdate: this.workflows.accept(update) };
    }
    if (result.workflowUpdate) result.workflowUpdate = this.workflows.launch(update, result.workflowUpdate);
    if (result.notice) result.workflowUpdate = this.workflows.notification(update.content.text);
    return result;
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

  steeringCapabilities() {
    return { supported: false, acceptsContent: false };
  }

  interject(): null { return null; }

  // Unreachable: `steeringCapabilities` answers no, so no steering RPC is ever
  // sent. Present because the seam is the interface, not the caller.
  steerDelivered(): boolean { return true; }

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
