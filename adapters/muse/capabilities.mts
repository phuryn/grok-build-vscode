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
    const { command, args } = museCliInvocation(executable, ["schema", "generate-json-schema", "--out", dir]);
    await run(command, args, { timeout: 5_000, windowsHide: true });
    return museSchemaMethods(JSON.parse(await readFile(join(dir, "msp.schema.json"), "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
