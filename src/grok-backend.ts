import { readFileSync, statSync } from "node:fs";
import { isCredentialError } from "./acp-dispatch";
import type { AcpBackend, BackendConfigState, BackendSessionListResult, BackendSpawnOptions } from "./acp-backend";
import type { EffortLevel, PromptContentBlock } from "./acp";
import { grokCliNeedsShell } from "./cli-process";
import { compareVersionTuple, parseGrokVersion } from "./cli-locator";
import { workspaceGrokHome } from "./workspace-grok-home";
import type { RunAutoCompact } from "./auto-compact";
import { globalConfigPath, projectConfigPath } from "./grok-config";

const GROK_COMPACT_PERCENT = "GROK_AUTO_COMPACT_THRESHOLD_PERCENT";
const GROK_DEFAULT_COMPACT_PERCENT = 80;

function grokOwnCompactPercent(options: BackendSpawnOptions): number {
  const configured: number[] = [];
  for (const file of [globalConfigPath(options.env), projectConfigPath(options.cwd)]) {
    try {
      if (statSync(file).size > 256 * 1024) continue;
      let inSection = false;
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const section = line.match(/^\s*\[([^\]]+)\]/)?.[1].trim();
        if (section) {
          inSection = section === "session" || (options.modelId !== undefined &&
            [`model.${options.modelId}`, `model."${options.modelId}"`, `model.'${options.modelId}'`].includes(section));
        } else if (inSection) {
          const value = line.match(/^\s*auto_compact_threshold_percent\s*=\s*(\d+)\s*(?:#.*)?$/)?.[1];
          if (value !== undefined && Number(value) <= 100) configured.push(Number(value));
        }
      }
    } catch { /* Grok reads its own config. */ }
  }
  const inherited = options.env[GROK_COMPACT_PERCENT]?.trim();
  if (inherited && Number(inherited) >= 0 && Number(inherited) <= 100) configured.push(Number(inherited));
  return Math.min(GROK_DEFAULT_COMPACT_PERCENT, ...configured);
}

function grokAutoCompact(options: BackendSpawnOptions): { percent?: number; threshold?: RunAutoCompact } {
  const { compactAt, modelWindow } = options;
  if (compactAt === undefined) return {};
  const native = grokOwnCompactPercent(options);
  const wanted = modelWindow ? Math.floor(compactAt * 100 / modelWindow) : undefined;
  const percent = wanted && wanted < native ? wanted : undefined;
  return { percent, threshold: (window, reportedPercent) => {
    const effective = reportedPercent;
    if (!window || effective === undefined || effective <= 0 || effective > 100) return null;
    return {
      tokens: Math.floor(window * effective / 100),
      source: percent === effective && window * effective / 100 <= compactAt ? "limit" : "agent",
    };
  } };
}

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

export function buildGrokAgentArgs(effort?: EffortLevel, isolateLeader = false): string[] {
  return ["agent", ...(isolateLeader ? ["--no-leader"] : []),
    ...(effort ? ["--reasoning-effort", effort] : []), "stdio"];
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
    const compact = grokAutoCompact(options);
    return {
      command: options.cliPath,
      args: buildGrokAgentArgs(options.effort, !!workspaceGrokHome() || compact.percent !== undefined),
      env: compact.percent === undefined ? options.env : { ...options.env, [GROK_COMPACT_PERCENT]: String(compact.percent) },
      shell: grokCliNeedsShell(options.cliPath),
      autoCompact: compact.threshold,
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
