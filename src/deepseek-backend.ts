import * as path from "node:path";
import * as fs from "node:fs";
import type { AcpBackend, BackendConfigState, BackendSpawnOptions } from "./acp-backend";
import { isDeepSeekCredentialError } from "./deepseek-auth";
import { deepseekRuntimePaths } from "./deepseek-managed-installer";

export type DeepSeekHarness = "default" | "minimal";
export const DEEPSEEK_COLD_REOPEN = "Conversation resumed. DeepSeek retains its context, but earlier messages are unavailable in this view.";
export const DEEPSEEK_FULL_ACCESS = "Minimal runs with full access to files and shell commands, without approval prompts.";
export function deepseekShellUnsandboxed(harness: DeepSeekHarness = "default", platform: NodeJS.Platform = process.platform): boolean {
  return harness === "default" && platform === "win32";
}

function config(options: any, id: string): any { return Array.isArray(options) ? options.find((v: any) => v.id === id) : undefined; }
function choices(option: any): any[] {
  return (option?.options ?? []).flatMap((v: any) => Array.isArray(v.options) ? v.options : [v]);
}
export function deepseekModelName(name: string, value?: string): string {
  if (!/^deepseek[-\s]/i.test(name)) return name;
  const pretty = name.replace(/^deepseek/i, "DeepSeek").replace(/-/g, " ")
    .replace(/\bv(?=\d)/gi, "V").replace(/\b(flash|pro)\b/gi, v => v[0].toUpperCase() + v.slice(1).toLowerCase());
  // Mirrors dsh's own `ui-deepseek-model-label-1017` badge, under its exact
  // condition: official/account route, id deepseek-flash, catalog name
  // DeepSeek-V4.1-Flash. A renamed catalog entry drops it, as dsh's does.
  let route: unknown;
  try { route = value ? JSON.parse(value) : undefined; } catch { route = undefined; }
  const flash1017 = name === "DeepSeek-V4.1-Flash" && Array.isArray(route) && route[1] === "deepseek-flash"
    && (route[0] === "deepseek-official" || route[0] === "deepseek-account");
  return flash1017 ? pretty + " 1017" : pretty;
}
export function normalizeDeepSeekSession(response: any): any {
  const model = config(response?.configOptions, "model");
  const effort = config(response?.configOptions, "reasoning_effort");
  if (!model) return response;
  return { ...response, models: {
    currentModelId: model.currentValue,
    availableModels: choices(model).filter((v) => typeof v.value === "string" && v.value.length > 0).map((v) => ({
      modelId: v.value, name: deepseekModelName(v.name ?? v.value, v.value), description: v.description,
      _meta: { totalContextTokens: 1_000_000, supportsReasoningEffort: !!effort, reasoningEffort: effort?.currentValue,
        reasoningEfforts: choices(effort).map((e) => ({ value: e.value })) },
    })),
  } };
}

/** The official ACP bridge owns the agent loop in both compositions. */
export class DeepSeekBackend implements AcpBackend<"deepseek"> {
  readonly provider = "deepseek" as const;
  readonly processName = "DeepSeek harness";
  readonly usesClientPlanGate = false;
  constructor(private readonly options: { storageRoot: string; harness?: DeepSeekHarness; assets?: string; nodePath?: string; platform?: NodeJS.Platform }) {}
  spawn(options: BackendSpawnOptions) {
    const harness = this.options.harness ?? "default";
    const runtime = deepseekRuntimePaths(options.cliPath);
    const env: NodeJS.ProcessEnv = { ...options.env, DSH_HOME: path.join(this.options.storageRoot, "deepseek-home", harness) };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    // The managed profile must not inherit persona/permission/composition overrides.
    for (const key of Object.keys(env)) if (key.startsWith("DSH_") && key !== "DSH_HOME") delete env[key];
    // Nor the editor's own plumbing: with VSCODE_IPC_HOOK inherited, dsh 0.2.1-rc.5
    // never answers initialize (measured: >90s, vs ~15s without it).
    for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
    const args = [runtime.cli, "--profile", harness === "minimal" ? "sdk-minimal" : "acp"];
    // An external Node cannot read Electron's app.asar. Materialize the shipped
    // overlay in our own home; the profile's user patches stay isolated there.
    const overlay = harness === "minimal" ? "minimal-acp.patch.yml"
      : deepseekShellUnsandboxed(harness, this.options.platform) ? "windows-shell.patch.yml" : undefined;
    if (overlay) {
      const patch = path.join(env.DSH_HOME!, "afk-" + overlay);
      fs.mkdirSync(env.DSH_HOME!, { recursive: true });
      const content = fs.readFileSync(path.join(this.options.assets ?? path.join(__dirname, "../resources/deepseek"), overlay));
      // Another conversation can still be reading this path during startup.
      if (!fs.existsSync(patch) || !fs.readFileSync(patch).equals(content)) fs.writeFileSync(patch, content);
      args.push("--patch", patch);
    }
    return { command: this.options.nodePath ?? runtime.node, args, env, shell: false };
  }
  private models = new Set<string>();
  normalizeSessionResponse(response: any) {
    const normalized = normalizeDeepSeekSession(response);
    if (normalized?.models?.availableModels) this.models = new Set(normalized.models.availableModels.map((m: any) => m.modelId));
    return normalized;
  }
  normalizePromptResult(result: any) { return result; }
  normalizeUpdate(update: any, meta: any) {
    if (update?.sessionUpdate === "usage_update") return { update, meta, contextUsed: update.used, contextWindow: update.size };
    return { update, meta };
  }
  normalizePermissionParams(params: any) {
    return { ...params, options: (params?.options ?? []).filter((o: any) => o.kind === "allow_once" || o.kind === "reject_once") };
  }
  setModel(sessionId: string, modelId: string) {
    if (!this.models.has(modelId)) throw new Error("Select a model from the current DeepSeek catalog.");
    return { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelId } };
  }
  setReasoningEffort(sessionId: string, _model: string | undefined, level: string) { return { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: level } }; }
  setMode(_sessionId: string, _modeId: string): never { throw new Error("DeepSeek has no ACP modes."); }
  steeringCapabilities() { return { supported: false, acceptsContent: false }; }
  interject() { return null; }
  steerDelivered() { return false; }
  configState(response: any, fallback: BackendConfigState) {
    return { ...fallback, modelId: config(response?.configOptions, "model")?.currentValue ?? fallback.modelId,
      reasoningEffort: config(response?.configOptions, "reasoning_effort")?.currentValue ?? fallback.reasoningEffort };
  }
  modelSetSucceeded() { return true; }
  async listSessions(request: (method: string, params: any) => Promise<any>, cwd: string) {
    const sessions = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await request("session/list", { cwd, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.sessions)) throw new Error("DeepSeek returned no session catalog.");
      sessions.push(...page.sessions.map((entry: any) => ({ sessionId: entry.sessionId, cwd: entry.cwd, deepseekHarness: this.options.harness ?? "default" })));
      cursor = page.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error("DeepSeek session cursor repeated.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { sessions };
  }
  isCredentialError = isDeepSeekCredentialError;
}
