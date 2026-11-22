import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agyGeminiHome, agySessionPathKey } from "./agy-backend";

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

async function existingPath(file: string): Promise<string | undefined> {
  try { return await fs.realpath(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

/** Remove only complete installs with the layout the AFK installer wrote. */
export async function removeRetiredAgyInstall(
  storageRoot: string,
  configuredPaths: readonly string[],
  geminiHomes = [path.join(os.homedir(), ".gemini"), agyGeminiHome()],
): Promise<void> {
  const root = path.resolve(storageRoot, "agy-managed");
  const realRoot = await existingPath(root);
  if (!realRoot || agySessionPathKey(root, process.platform) !== agySessionPathKey(realRoot, process.platform)) return;

  for (const home of geminiHomes) {
    const resolved = path.resolve(home);
    const real = await existingPath(resolved);
    if (contains(resolved, root) || (real && contains(real, root))) return;
  }
  const protectedPaths = await Promise.all(configuredPaths.filter(Boolean).map(async value => {
    const resolved = path.resolve(value);
    return [resolved, await existingPath(resolved)];
  }));
  const protectedLocations = protectedPaths.flat().filter((file): file is string => !!file);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+\.\d+\.\d+$/.test(entry.name)) continue;
    const version = path.join(root, entry.name);
    if (protectedLocations.some(file => contains(version, file) || contains(file, version))) continue;
    const files = await fs.readdir(version, { withFileTypes: true }).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    const names = new Set(files.filter(file => file.isFile()).map(file => file.name));
    if (files.length !== 2 || names.size !== 2) continue;
    if (!((names.has("agy_acp_server.exe") && names.has("localharness_external.exe"))
      || (names.has("agy_acp_server.par") && names.has("localharness_external")))) continue;
    await fs.rm(version, { recursive: true, force: true });
  }
}
