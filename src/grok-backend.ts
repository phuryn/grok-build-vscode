import { isCredentialError } from "./acp-dispatch";
import type { AcpBackend, BackendConfigState, BackendSessionListResult, BackendSpawnOptions } from "./acp-backend";
import type { EffortLevel, PromptContentBlock } from "./acp";
import { grokCliNeedsShell } from "./cli-process";
import { compareVersionTuple, parseGrokVersion } from "./cli-locator";

/** Grok 0.2.x ignores interject content. Only a live-verified 1.x accepts images. */
export const GROK_INTERJECT_CONTENT_MIN_VERSION: [number, number, number] = [1, 0, 0];

export function cliHonorsInterjectContent(grokVersion?: string | null, versionVerified = false): boolean {
  if (!versionVerified) return false;
  const parsed = parseGrokVersion(grokVersion ?? "");
  return !!parsed && compareVersionTuple(parsed, GROK_INTERJECT_CONTENT_MIN_VERSION) >= 0;
}

/** Keep Grok's legacy text wire; structured content wins when images are present. */
export function buildInterjectParams(sessionId: string, text: string, content?: readonly PromptContentBlock[]) {
  return {
    sessionId,
    text,
    ...(content?.some((block) => block.type === "image") ? { content: [...content] } : {}),
  };
}

export function buildGrokAgentArgs(effort?: EffortLevel): string[] {
  return effort ? ["agent", "--reasoning-effort", effort, "stdio"] : ["agent", "stdio"];
}

export function grokSetupDetail(phase: unknown): string | undefined {
  switch (phase) {
    case "auth": return "signing in";
    case "resolve_workspace": case "git_discovery": case "folder_trust": return "reading the project";
    case "plugin_registry": case "mcp_merge": case "tool_overrides": return "loading tools and connectors";
    default: return undefined;
  }
}

export const grokBackend: AcpBackend = {
  provider: "grok",
  processName: "Grok process",
  usesClientPlanGate: true,
  spawn(options: BackendSpawnOptions) {
    return {
      command: options.cliPath,
      args: buildGrokAgentArgs(options.effort),
      env: options.env,
      shell: grokCliNeedsShell(options.cliPath),
    };
  },
  normalizeSessionResponse: (response) => response,
  normalizePromptResult: (result) => result,
  normalizeUpdate: (update, meta) => ({
    update, meta,
    ...(update?.sessionUpdate === "session_info_update" && typeof update.title === "string" && update.title.trim()
      ? { sessionTitle: update.title.trim() } : {}),
  }),
  normalizePermissionParams: (params) => params,
  setModel(sessionId, modelId, reasoningEffort) {
    return {
      method: "session/set_model",
      params: {
        sessionId,
        modelId,
        ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
      },
    };
  },
  setReasoningEffort(sessionId, modelId, level) {
    return level ? {
      method: "session/set_model",
      params: { sessionId, modelId, _meta: { reasoningEffort: level } },
    } : null;
  },
  setMode(sessionId, modeId) {
    return { method: "session/set_mode", params: { sessionId, modeId } };
  },
  steeringCapabilities(_initializeResult, options) {
    return {
      supported: true,
      acceptsContent: cliHonorsInterjectContent(options.grokVersion, options.grokVersionVerified),
    };
  },
  interject(sessionId, text, content) {
    return { method: "_x.ai/interject", params: buildInterjectParams(sessionId, text, content) };
  },
  // `_x.ai/interject` has no outcome vocabulary: it buffers the text for the
  // running turn and reports a failure as an error, which `interject` already
  // rethrows. Nothing about Grok changes here.
  steerDelivered() { return true; },
  configState(_response, fallback: BackendConfigState) { return fallback; },
  modelSetSucceeded(response) { return !!response?._meta?.model?.Ok; },
  async listSessions(request, cwd): Promise<BackendSessionListResult> {
    return request("session/list", { cwd });
  },
  isCredentialError,
};
