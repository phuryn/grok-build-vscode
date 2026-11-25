import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, type ModelInfo } from "./acp";
import { execGrokCli } from "./cli-process";
import { CodexBackend, type CodexBackendOptions } from "./codex-backend";

export interface WarmCodexModelCacheOptions {
  cliPath: string;
  signal?: AbortSignal;
  onModels: (models: readonly ModelInfo[], currentModelId?: string) => void | PromiseLike<void>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  backend?: CodexBackendOptions;
  /** Where to retry when Codex refuses the scratch directory. The workspace, in
   *  practice — the same cwd a real session uses. */
  fallbackCwd?: string;
}

/**
 * ACP's session/delete archives the thread, and Codex lists archived threads:
 * a daily read would leave one "Untitled" there every day. `codex delete` takes
 * exactly the id it is given. A Codex without it refuses the flag, and the
 * thread stays archived.
 */
async function deleteArchivedThread(id: string, options: WarmCodexModelCacheOptions): Promise<void> {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  try {
    await execGrokCli(options.cliPath, ["delete", "--force", id], {
      env: options.env ?? { ...process.env },
      timeout: 15_000,
      windowsHide: true,
      signal: options.signal,
      closeStdin: true,
    });
  } catch {
    options.log?.("[codex] could not delete the throwaway session; it stays archived");
  }
}

async function readModelsIn(cwd: string, options: WarmCodexModelCacheOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const client = new AcpClient({
    signal: options.signal,
    cliPath: options.cliPath,
    cwd,
    env: options.env ?? { ...process.env },
    backend: new CodexBackend(options.backend),
    log: options.log ?? (() => {}),
  });
  let archived: string | undefined;
  try {
    await client.start();
    options.signal?.throwIfAborted();
    const created = await client.newSession();
    options.signal?.throwIfAborted();
    await options.onModels(client.availableModels, client.currentModelId);
    try {
      options.signal?.throwIfAborted();
      await client.deleteSession(created.sessionId);
      archived = created.sessionId;
    } catch (error) {
      // codex 0.147 answers session/delete with "Internal error: no rollout
      // found for thread id …" for a throwaway that never wrote one. The
      // models are already delivered by this point — hygiene must not fail
      // the warm-up. It did: this doubles as the post-login credential probe,
      // so a perfectly valid sign-in read as "no usable credential" on every
      // cloud machine (first real cloud test, 2026-08-31). Nothing rolled out
      // also means there is nothing to clean.
      options.log?.(`[codex] throwaway session cleanup failed (${(error as Error).message}); models already cached, continuing`);
    }
  } finally {
    await client.dispose();
    if (archived) await deleteArchivedThread(archived, options);
  }
}

/**
 * Read Codex's advertised models by opening one throwaway session.
 *
 * A scratch directory is tried first, because this session exists only to be
 * asked a question and should not appear in the user's project. But Codex can
 * refuse a bare temp directory outright — observed on Windows as
 * `session/new` answering "Internal error", with the adapter exiting 0 seconds
 * later. When that happened the cache stayed empty forever, so a newly
 * connected Codex never appeared in the model picker, while a real session in
 * the workspace worked fine.
 *
 * So: fall back to the workspace, which is the same cwd a real session uses and
 * is therefore known to be acceptable. The throwaway session is archived
 * through ACP and then deleted either way.
 */
export async function warmCodexModelCache(options: WarmCodexModelCacheOptions): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "grok-codex-models-"));
  try {
    await readModelsIn(scratch, options);
    return;
  } catch (error) {
    if (options.signal?.aborted || !options.fallbackCwd) throw error;
    options.log?.(
      `[codex] model-cache warm-up in a scratch dir failed (${(error as Error).message}); retrying in the workspace`,
    );
  } finally {
    // Best effort, and never fatal. The adapter process can still hold this
    // directory for a moment after it answers, so Windows throws EBUSY on
    // rmdir — and thrown from a `finally` that beat the retry line, it replaced
    // the retry with its own failure. A leftover temp directory is harmless;
    // losing the model cache over one is not.
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch (cleanup) {
      options.log?.(`[codex] left a scratch dir behind: ${(cleanup as Error).message}`);
    }
  }
  await readModelsIn(options.fallbackCwd, options);
}
