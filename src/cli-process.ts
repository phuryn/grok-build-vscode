import { execFile, type ExecFileOptions } from "node:child_process";

/** Windows command shims are scripts, not directly executable binaries. */
export function grokCliNeedsShell(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(cliPath);
}

export type GrokCliExecOptions = Pick<
  ExecFileOptions,
  "cwd" | "env" | "timeout" | "windowsHide"
> & { closeStdin?: boolean };

/**
 * Run a one-shot CLI command through the same Windows-shim policy as the
 * long-lived ACP process. All version, update-check, and update calls use this
 * wrapper so a resolved grok.cmd/grok.bat keeps working everywhere.
 */
export function execGrokCli(
  cliPath: string,
  args: readonly string[],
  options: GrokCliExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { closeStdin, ...execOptions } = options;
    const child = execFile(
      cliPath,
      [...args],
      {
        ...execOptions,
        encoding: "utf8",
        shell: grokCliNeedsShell(cliPath),
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    // An in-product updater has no terminal/input channel. EOF lets an older
    // CLI fail promptly if it requires interaction instead of waiting unseen.
    if (closeStdin) child.stdin?.end();
  });
}
