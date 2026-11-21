import * as path from "node:path";
import type { AcpBackend, BackendConfigState, BackendSpawnOptions, DelegatedWorkKind } from "./acp-backend";
import { acpForkRequest } from "./acp-backend";
import type { PromptContentBlock } from "./acp";
import type { MusePosture, MuseSandboxUnavailable } from "./mode-prefs";
import { isMuseModeId } from "./mode-prefs";
import type { RunAutoCompact } from "./auto-compact";

const MUSE_DEFAULT_CONTEXT_WINDOW = 1_048_576;
const MUSE_SOFT_COMPACT_RATIO = 0.5;
const MUSE_HARD_COMPACT_RATIO = 0.9;

/**
 * Muse 1.4.0 saves a new sign-in to the OS keychain on Windows and Linux too,
 * and the save fails ("keychain write failed (internal error -2147483648)"),
 * so nobody who was not already signed in can sign in. Forcing its file store
 * saves normally; that file is what 1.3.0 wrote and what 1.4.0 still reads.
 * macOS keeps its real Keychain. A value the person set themselves wins.
 * Drop this once https://github.com/meta-models/muse-code-sdk/issues/38 is fixed.
 */
export function withMuseCredentialBackend(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "darwin" || env.TBH_CREDENTIAL_BACKEND) return env;
  return { ...env, TBH_CREDENTIAL_BACKEND: "file" };
}

/** Runs the installed vendor CLI through our ACP adapter. */
export class MuseBackend implements AcpBackend<"muse"> {
  readonly provider = "muse" as const;
  readonly processName = "Muse ACP adapter";
  readonly usesClientPlanGate = false;

  constructor(private readonly posture?: MusePosture, private readonly sandboxUnavailable?: MuseSandboxUnavailable) {}

  spawn(options: BackendSpawnOptions) {
    const window = options.modelWindow ?? MUSE_DEFAULT_CONTEXT_WINDOW;
    const hard = options.compactAt === undefined ? undefined : options.compactAt / window;
    const compact = hard !== undefined && hard < MUSE_HARD_COMPACT_RATIO
      ? { hard, soft: Math.min(MUSE_SOFT_COMPACT_RATIO, hard - 1 / window) } : undefined;
    const autoCompact: RunAutoCompact | undefined = options.compactAt === undefined ? undefined : size => {
      if (!size) return null;
      return { tokens: Math.round(size * (compact?.hard ?? MUSE_HARD_COMPACT_RATIO)), source: compact ? "limit" : "agent" };
    };
    return {
      command: process.execPath,
      args: [path.join(__dirname, "muse-adapter", "main.mjs")],
      env: { ...withMuseCredentialBackend(options.env), ELECTRON_RUN_AS_NODE: "1", MUSE_CODE_EXECUTABLE: options.cliPath,
        GROK_MUSE_POSTURE: JSON.stringify({ ...this.posture, sandboxUnavailable: this.sandboxUnavailable,
          ...(this.sandboxUnavailable ? { shellSandbox: false } : {}),
          ...(compact ? { compact } : {}) }) },
      shell: false,
      autoCompact,
    };
  }

  normalizeSessionResponse(response: any) { return { ...response, models: response.models ?? response._meta?.models }; }
  normalizePromptResult(result: any) { return result; }
  stopDelegatedWork(sessionId: string, kind: DelegatedWorkKind, id: string) {
    return { method: "_muse/stop_delegated_work", params: { sessionId, kind, id } };
  }
  normalizeUpdate(update: any, meta: any) {
    if (update?._meta?.["muse/subagent"] === true
        && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
      return { update: { ...update, kind: "subagent",
        status: update._meta["muse/cancelled"] === true ? "cancelled" : update.status,
        stopAvailable: update._meta["muse/canStop"] === true,
      }, meta };
    }
    if (update?._meta?.["muse/modeNotice"]) {
      return { update, meta, notice: update._meta["muse/modeNotice"] };
    }
    if (update?.sessionUpdate === "session_info_update" && update._meta?.["muse/workflow"]) {
      return { workflowUpdate: update._meta["muse/workflow"] };
    }
    if (update?.sessionUpdate === "session_info_update" && update._meta?.["muse/autoCompact"]) {
      return { autoCompaction: update._meta["muse/autoCompact"] };
    }
    if (update?.sessionUpdate === "usage_update") return { update,
      meta, contextUsed: update.used, contextWindow: update.size };
    return { update, meta };
  }
  normalizePermissionParams(params: any) { return params; }
  setModel(sessionId: string, modelId: string) {
    return { method: "session/set_model", params: { sessionId, modelId } };
  }
  setReasoningEffort(sessionId: string, _modelId: string | undefined, level: string) {
    return { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: level } };
  }
  setMode(sessionId: string, modeId: string) {
    if (!isMuseModeId(modeId)) throw new Error("Muse does not offer Plan mode or unknown approval modes");
    return { method: "session/set_mode", params: { sessionId, modeId } };
  }
  steeringCapabilities(init: any) {
    const supported = init?._meta?.steering?.supported === true;
    return { supported, acceptsContent: supported };
  }
  interject(sessionId: string, text: string, content?: readonly PromptContentBlock[]) {
    return { method: "_session/steering", params: { sessionId, prompt: content ?? [{ type: "text", text }] } };
  }
  steerDelivered(result: any) { return result?.outcome === "injected"; }
  fork = acpForkRequest;
  configState(response: any, fallback: BackendConfigState) {
    return { ...fallback, modeId: response?.modes?.currentModeId ?? response?._meta?.modes?.currentModeId ?? fallback.modeId };
  }
  modelSetSucceeded() { return true; }
  async listSessions(request: (method: string, params: any) => Promise<any>, cwd: string) {
    const sessions = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await request("session/list", { cwd, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.sessions)) throw new Error("Muse returned no session catalog");
      sessions.push(...page.sessions.map((entry: any) => ({ ...entry, ...entry._meta })));
      cursor = page.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error("Muse session cursor repeated");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { sessions };
  }
  isCredentialError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /authRequired|not authenticated|authentication required|please (?:log|sign) in/i.test(message);
  }
}
