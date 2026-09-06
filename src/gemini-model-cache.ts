import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, type ModelInfo } from "./acp";
import { GeminiBackend, type GeminiBackendOptions } from "./gemini-backend";

export interface WarmGeminiModelCacheOptions {
  cliPath: string;
  onModels: (models: readonly ModelInfo[], currentModelId?: string) => void | PromiseLike<void>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  backend?: GeminiBackendOptions;
  fallbackCwd?: string;
}

async function readModelsIn(cwd: string, options: WarmGeminiModelCacheOptions): Promise<void> {
  const client = new AcpClient({
    cliPath: options.cliPath,
    cwd,
    env: options.env ?? { ...process.env },
    backend: new GeminiBackend(options.backend),
    log: options.log ?? (() => {}),
  });
  try {
    await client.start();
    const created = await client.newSession();
    await options.onModels(client.availableModels, client.currentModelId);
    try {
      await client.deleteSession(created.sessionId);
    } catch (error) {
      options.log?.(`[gemini] throwaway session cleanup failed (${(error as Error).message}); models already cached, continuing`);
    }
  } finally {
    await client.dispose();
  }
}

export async function warmGeminiModelCache(options: WarmGeminiModelCacheOptions): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "grok-gemini-models-"));
  try {
    await readModelsIn(scratch, options);
    return;
  } catch (error) {
    if (!options.fallbackCwd) throw error;
    options.log?.(
      `[gemini] model-cache warm-up in a scratch dir failed (${(error as Error).message}); retrying in the workspace`,
    );
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (cleanup) {
      options.log?.(`[gemini] left a scratch dir behind: ${(cleanup as Error).message}`);
    }
  }
  await readModelsIn(options.fallbackCwd, options);
}
