import { spawn } from "node:child_process";
import * as path from "node:path";
import { locateAgyCli } from "./agy-backend";
import { extensionWasUpgraded } from "./cli-locator";

export const AGY_INSTALL_TIMEOUT_MS = 180_000;
export const AGY_UPDATE_TIMEOUT_MS = 20_000;

export function agyInstallCommand(platform: NodeJS.Platform) {
  return platform === "win32"
    ? { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "irm https://antigravity.google/cli/install.ps1 | iex"] }
    : { file: "bash", args: ["-o", "pipefail", "-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"] };
}

type CommandOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  spawnChild?: typeof spawn;
  killGroup?: typeof process.kill;
};

export async function runAgyCommand(file: string, args: string[], options: CommandOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const spawnChild = options.spawnChild ?? spawn;
  const windows = (options.platform ?? process.platform) === "win32";
  return new Promise((resolve, reject) => {
    const child = spawnChild(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !windows });
    let output = "";
    let stopped: Error | undefined;
    let stopping: Promise<void> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const collect = (chunk: Buffer) => {
      const value = chunk.toString();
      output = (output + value).slice(-4096);
      if (value.trim()) options.log?.(value.trimEnd());
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const stop = (error: Error) => {
      if (stopped) return;
      stopped = error;
      stopTimer = setTimeout(() => {
        child.kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(error);
      }, 3_000);
      const pid = child.pid;
      if (!pid) return;
      if (windows) {
        stopping = new Promise<void>((done) => {
          const killer = spawnChild(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          const finish = (code: number | null) => { if (code !== 0) child.kill(); done(); };
          killer.once("error", () => finish(null));
          killer.once("exit", finish);
        });
      } else {
        try { (options.killGroup ?? process.kill)(-pid, "SIGKILL"); } catch { child.kill(); }
      }
    };
    const abort = () => stop(new Error("Installation cancelled."));
    const timer = setTimeout(() => stop(new Error(`Timed out after ${options.timeoutMs / 1000} seconds.`)), options.timeoutMs);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      options.signal?.removeEventListener("abort", abort);
      if (stopped || error) reject(stopped ?? error);
      else resolve(output);
    };
    const finish = async (error?: Error) => {
      await stopping;
      settle(error);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => void finish(error));
    child.once("close", (code) => void finish(code === 0 ? undefined : new Error(`Process exited (${code ?? "signal"}).`)));
    if (options.signal?.aborted) abort();
  });
}

export async function readAgyCliVersion(binary: string, options: Pick<CommandOptions, "signal" | "platform" | "spawnChild" | "killGroup"> = {}): Promise<string> {
  const output = await runAgyCommand(binary, ["--version"], { ...options, timeoutMs: 5_000 });
  const version = /\b\d+\.\d+\.\d+(?:[-+][\w.+-]+)?\b/.exec(output)?.[0];
  if (!version) throw new Error("agy --version did not report a version.");
  return version;
}

export async function installAgyCli(options: Omit<CommandOptions, "timeoutMs"> & {
  locate?: () => string | undefined;
  command?: ReturnType<typeof agyInstallCommand>;
  beforeVersion?: (binary: string) => Promise<void>;
}): Promise<{ binary: string; version: string }> {
  const command = options.command ?? agyInstallCommand(options.platform ?? process.platform);
  let installError: unknown;
  try {
    await runAgyCommand(command.file, command.args, { ...options, timeoutMs: AGY_INSTALL_TIMEOUT_MS });
  } catch (error) { installError = error; }
  options.signal?.throwIfAborted();
  const binary = (options.locate ?? locateAgyCli)();
  if (!binary) throw installError ?? new Error("The installer finished but agy was not found.");
  await options.beforeVersion?.(binary);
  return { binary, version: await readAgyCliVersion(binary, options) };
}

export async function updateAgyCliOnUpgrade(binary: string, current: string, last: string | undefined,
  remember: (version: string) => PromiseLike<void>, log: (line: string) => void,
  { run = runAgyCommand, signal }: { run?: typeof runAgyCommand; signal?: AbortSignal } = {}): Promise<void> {
  if (!current || current === last) return;
  try {
    if (extensionWasUpgraded(last, current)) {
      log(`[agy] AFK upgraded to ${current}; running agy update.`);
      await run(binary, ["update"], { timeoutMs: AGY_UPDATE_TIMEOUT_MS, log, ...(signal ? { signal } : {}) });
    }
  } catch (error) {
    log(`[agy] Update failed; continuing with the installed CLI: ${String(error)}`);
  } finally {
    try { await remember(current); }
    catch (error) { log(`[agy] Could not save the update version: ${String(error)}`); }
  }
}
