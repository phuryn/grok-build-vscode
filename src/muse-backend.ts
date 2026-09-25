import * as path from "node:path";
import type { AcpBackend, BackendConfigState, BackendSpawnOptions } from "./acp-backend";

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

  spawn(options: BackendSpawnOptions) {
    return {
      command: process.execPath,
      args: [path.join(__dirname, "muse-adapter", "main.mjs")],
      env: { ...withMuseCredentialBackend(options.env), ELECTRON_RUN_AS_NODE: "1", MUSE_CODE_EXECUTABLE: options.cliPath },
      shell: false,
    };
  }

  normalizeSessionResponse(response: any) { return { ...response, models: response.models ?? response._meta?.models }; }
  normalizePromptResult(result: any) { return result; }
  normalizeUpdate(update: any, meta: any) {
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
  setMode(_sessionId: string, _modeId: string): never {
    throw new Error("Muse mode switching is unavailable");
  }
  steeringCapabilities() { return { supported: false, acceptsContent: false }; }
  interject() { return null; }
  steerDelivered() { return false; }
  configState(_response: any, fallback: BackendConfigState) { return fallback; }
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
