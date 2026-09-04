import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, type ModelInfo } from "./acp";
import { ClaudeBackend, type ClaudeBackendOptions } from "./claude-backend";

export interface WarmClaudeModelCacheOptions {
  cliPath: string;
  onModels: (models: readonly ModelInfo[], currentModelId?: string) => void | PromiseLike<void>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  backend?: ClaudeBackendOptions;
  /** Where to retry when the scratch directory is refused. The workspace, in
   *  practice — the same cwd a real session uses. */
  fallbackCwd?: string;
}

async function readModelsIn(cwd: string, options: WarmClaudeModelCacheOptions): Promise<void> {
  const client = new AcpClient({
    cliPath: options.cliPath,
    cwd,
    env: options.env ?? { ...process.env },
    backend: new ClaudeBackend(options.backend),
    log: options.log ?? (() => {}),
  });
  try {
    await client.start();
    const created = await client.newSession();
    await options.onModels(client.availableModels, client.currentModelId);
    try {
      await client.deleteSession(created.sessionId);
    } catch (error) {
      // The models are already delivered by this point, so tidying up must not
      // be able to fail the warm-up. This call doubles as the credential probe
      // that promotes the provider to connected, and a throwaway session that
      // will not delete says nothing at all about the sign-in.
      options.log?.(`[claude] throwaway session cleanup failed (${(error as Error).message}); models already cached, continuing`);
    }
  } finally {
    await client.dispose();
  }
}

/**
 * Read Claude's advertised models by opening one throwaway session.
 *
 * A scratch directory is tried first, because this session exists only to be
 * asked a question and should not appear in the user's project.
 *
 * Everything below is a port of the protections `codex-model-cache.ts` grew on
 * 2026-08-17, one day after this file was written. They were never carried
 * across, and the result was #146: on Windows, Claude never reached "Connected"
 * on any attempt, ever, while Codex on the same machine was fine.
 *
 * Two ways it failed there, both reported, and neither of them about
 * credentials:
 *
 *  - `session/new` answering `Internal error` for a session in a bare temp
 *    directory — the same refusal Codex saw, which is what `fallbackCwd` is
 *    for.
 *  - `EPERM` removing the scratch directory itself. The adapter can still hold
 *    it for a moment after it exits — the reporter's log shows
 *    `exited with code 0` immediately before the failure — and this ran
 *    unguarded in a `finally`, so it replaced a warm-up that had ALREADY cached
 *    the models with its own failure.
 *
 * The second is the one that mattered, and the shape is worth keeping in mind:
 * the caller promotes a provider to connected only on a successful return, so a
 * throw from cleanup is indistinguishable from "this account does not work".
 * A leftover temp directory is harmless; losing the model cache over one is not.
 */
export async function warmClaudeModelCache(options: WarmClaudeModelCacheOptions): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "grok-claude-models-"));
  try {
    await readModelsIn(scratch, options);
    return;
  } catch (error) {
    if (!options.fallbackCwd) throw error;
    options.log?.(
      `[claude] model-cache warm-up in a scratch dir failed (${(error as Error).message}); retrying in the workspace`,
    );
  } finally {
    // Best effort, and never fatal — see the note above. Thrown from a
    // `finally` it would also beat the retry line below and replace the retry
    // with its own failure, which is how Codex lost its fallback before this
    // was wrapped there.
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (cleanup) {
      options.log?.(`[claude] left a scratch dir behind: ${(cleanup as Error).message}`);
    }
  }
  await readModelsIn(options.fallbackCwd, options);
}
