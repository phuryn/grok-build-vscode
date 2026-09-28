import { bounded } from "./acp-smoke.mjs";

export const SLOW_CLEANUP_MS = 15_000;
export function cleanupBudget(provider, platform = process.platform) {
  return provider === "muse" && platform === "win32" ? 120_000 : SLOW_CLEANUP_MS;
}

/** Observe the actual child exit as well as Playwright transport closure. */
export async function closeDesktop(app, proc, { budgetMs, provider, platform = process.platform, slowMs = SLOW_CLEANUP_MS, now = () => performance.now(), record = () => {} }) {
  const started = now();
  let exitMs, onExit;
  const exited = new Promise(resolve => {
    onExit = () => { exitMs = Math.round(now() - started); record("desktop-exit", { durationMs: exitMs, exitCode: proc.exitCode, signal: proc.signalCode }); resolve(); };
    if (proc.exitCode !== null || proc.signalCode !== null) onExit();
    else proc.once("exit", onExit);
  });
  record("desktop-quit-requested", { budgetMs, slowMs });
  let error;
  try {
    await bounded(Promise.all([Promise.resolve().then(() => app.close()), exited]), "desktop shutdown", budgetMs);
  } catch (cause) { error = cause; }
  finally { proc.removeListener("exit", onExit); }
  const durationMs = Math.round(now() - started);
  const slowChild = error?.code === "ACP_SMOKE_TIMEOUT" && provider === "muse" && platform === "win32"
    && exitMs != null && exitMs <= budgetMs;
  const row = { name: "cleanup", result: slowChild ? "WARNING" : error ? "FAIL" : durationMs > slowMs ? "WARNING" : "PASS",
    durationMs, exitMs: exitMs ?? null, budgetMs, slowMs, pageErrors: [],
    reason: slowChild ? `Muse child process cleanup exceeded ${budgetMs}ms; Electron app exited at ${exitMs}ms; app.close() still pending`
      : error ? `${error.message}; waited ${durationMs}ms; app exit ${exitMs == null ? "not observed" : `observed at ${exitMs}ms`}`
      : `desktop shutdown took ${durationMs}ms (app exit ${exitMs}ms; budget ${budgetMs}ms)${durationMs > slowMs ? "; slow cleanup, scenarios retain their own verdicts" : ""}` };
  record("desktop-cleanup", row);
  return row;
}
