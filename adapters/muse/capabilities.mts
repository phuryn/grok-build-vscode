import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function museCliInvocation(executable: string, args: string[], platform = process.platform) {
  // Node cannot spawn a Windows command shim directly. Keep the path and
  // each argument separate so Node quotes paths with spaces for cmd.
  return platform === "win32" && /\.(cmd|bat)$/i.test(executable)
    ? { command: process.env.COMSPEC || "cmd.exe", args: ["/d", "/c", executable, ...args] }
    : { command: executable, args };
}

export function museSchemaMethods(schema: unknown): Set<string> {
  const methods = (schema as { methods?: unknown } | null)?.methods;
  return new Set(methods && typeof methods === "object" && !Array.isArray(methods) ? Object.keys(methods) : []);
}

/** MSP initialize gives a fingerprint, not a method list. Read the binary's
 * stable export offline, with no login, session, or version inference. */
export async function readMuseMethods(executable: string): Promise<Set<string>> {
  const dir = await mkdtemp(join(tmpdir(), "afk-muse-schema-"));
  try {
    // `--out .` from inside the folder: cmd strips the outer quotes of a line
    // holding two quoted paths, so a shim path and a temp folder that both
    // contain a space (a Windows user name with a space) broke the call.
    const { command, args } = museCliInvocation(executable, ["schema", "generate-json-schema", "--out", "."]);
    await run(command, args, { cwd: dir, timeout: 5_000, windowsHide: true });
    return museSchemaMethods(JSON.parse(await readFile(join(dir, "msp.schema.json"), "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
