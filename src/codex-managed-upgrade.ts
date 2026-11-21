import * as fs from "node:fs";
import * as path from "node:path";
import {
  codexManagedRoot,
  installManagedCodex,
  managedCodexBinaryVersion,
  resolveCodexManagedRelease,
  type CodexManagedRelease,
} from "./codex-managed-installer";
import { versionIsOlder } from "./provider-ui";

// The package is about 215 MB (GitHub's asset size for Windows x64, 0.171.0),
// so 15 minutes covers a link of about 2 Mbit/s. It runs in the background.
export const CODEX_MANAGED_UPGRADE_TIMEOUT_MS = 900_000;

/** Shared by host windows. Claim before I/O so a failed attempt also counts. */
export async function claimManagedCodexUpgrade(storageRoot: string, afkVersion: string): Promise<boolean> {
  if (!afkVersion) return false;
  const root = codexManagedRoot(storageRoot);
  await fs.promises.mkdir(root, { recursive: true });
  try {
    await fs.promises.writeFile(path.join(root, `.afk-update-${encodeURIComponent(afkVersion)}`), "", { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function updateManagedCodexOnUpgrade(options: {
  storageRoot: string;
  binary: string;
  afkVersion: string;
  signal: AbortSignal;
  onRelease: (release: CodexManagedRelease) => void;
  log: (line: string) => void;
  resolve?: typeof resolveCodexManagedRelease;
  install?: typeof installManagedCodex;
}): Promise<string | undefined> {
  const { storageRoot, binary, afkVersion, onRelease, log } = options;
  const installed = managedCodexBinaryVersion(storageRoot, binary);
  if (!installed || options.signal.aborted) return undefined;
  try {
    if (!await claimManagedCodexUpgrade(storageRoot, afkVersion)) return undefined;
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(CODEX_MANAGED_UPGRADE_TIMEOUT_MS)]);
    const release = await (options.resolve ?? resolveCodexManagedRelease)({
      signal,
      onLookupFailure: (error) => log(`[codex] Managed release lookup failed: ${String(error)}`),
    });
    signal.throwIfAborted();
    if (!release) return undefined;
    onRelease(release);
    if (!versionIsOlder(installed, release.version)) return undefined;
    return await (options.install ?? installManagedCodex)({ storageRoot, release, signal, keepBinary: binary });
  } catch (error) {
    log(`[codex] Managed update failed; continuing with the installed CLI: ${String(error)}`);
    return undefined;
  }
}
