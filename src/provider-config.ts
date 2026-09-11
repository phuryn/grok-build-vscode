import * as os from "node:os";
import * as path from "node:path";
import { resolveCodexHome } from "./codex-cli-locator";
import { resolveGrokHome } from "./sessions";
import { ensureConfigToml, GLOBAL_CONFIG_STUB } from "./grok-config";
import { readRemoteProjectFile, writeRemoteProjectFile } from "./remote-files";
import { FILE_PREVIEW_MAX_BYTES, type TreeFileStamp, type WriteTreeFileResult } from "./file-tree";

/** A missing file has no disk version; never matches a real file's stamp. */
export const MISSING_PROVIDER_CONFIG_STAMP = { mtimeMs: 0, size: -1 } as const;

const PROVIDER_CONFIG_STUBS = { grok: GLOBAL_CONFIG_STUB, codex: "", claude: "{}" } as const;

/** No caller-supplied paths or home overrides: these are the entire surface. */
export const PROVIDER_CONFIG_FILES = {
  grok: ".grok/config.toml",
  codex: ".codex/config.toml",
  claude: ".claude/settings.json",
} as const;

/** The home a CLI with no override of its own reads from. `resolveGrokHome`
 *  documents why this is not simply `os.homedir()`: on a Windows box with HOME
 *  set (git-bash) the two disagree, and the CLI follows this one. */
function configHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const fromEnv = platform === "win32" ? env.USERPROFILE : env.HOME;
  return fromEnv || os.homedir();
}

/**
 * The directory each CLI actually reads its config from.
 *
 * The table above fixes the FILE; this fixes the DIRECTORY, and it has to be
 * the same answer the CLI gives itself. `GROK_HOME` and `CODEX_HOME` both move
 * it, both are already honoured elsewhere in this extension (`resolveGrokHome`
 * backs Gear -> Config, `resolveCodexHome` backs the Codex locator), and a
 * hardcoded home here would mean this editor writes a file the CLI never reads
 * — the person edits, saves, restarts, and nothing changes. Claude has no such
 * override in anything we drive, so it takes the plain home.
 */
function configDir(
  provider: keyof typeof PROVIDER_CONFIG_FILES,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (provider === "grok") return resolveGrokHome(env, platform);
  if (provider === "codex") return resolveCodexHome(env, platform);
  return paths.join(configHome(env, platform), ".claude");
}

export function resolveProviderConfigFile(
  provider: unknown,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (typeof provider !== "string" || !Object.prototype.hasOwnProperty.call(PROVIDER_CONFIG_FILES, provider)) {
    return { ok: false, reason: "unknown provider config" } as const;
  }
  const key = provider as keyof typeof PROVIDER_CONFIG_FILES;
  const configPath = PROVIDER_CONFIG_FILES[key];
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relPath = paths.basename(configPath);
  return {
    ok: true,
    root: { filePath: paths.join(configDir(key, env, platform), relPath) },
    relPath,
    /** The STABLE identity on the wire and the label in the panel. Deliberately
     *  the table's spelling rather than the resolved directory: it is the
     *  correlation key both halves match on, so it must not move with somebody's
     *  environment. */
    configPath,
    stub: PROVIDER_CONFIG_STUBS[key],
  } as const;
}

/** Creation is confined to the three host-resolved configs, never the project writer. */
export function writeProviderConfigFile(
  target: Extract<ReturnType<typeof resolveProviderConfigFile>, { ok: true }>,
  text: string,
  stamp: TreeFileStamp,
  expectedAbsPath: string,
): WriteTreeFileResult {
  if (stamp?.mtimeMs === MISSING_PROVIDER_CONFIG_STAMP.mtimeMs && stamp.size === MISSING_PROVIDER_CONFIG_STAMP.size) {
    // Validate the intent before creating anything. A changed home must not
    // create a config at the new destination of an old buffer.
    const norm = (p: string) => process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;
    if (typeof expectedAbsPath !== "string" || norm(expectedAbsPath) !== norm(target.root.filePath)) {
      return { ok: false, reason: "workspace changed" };
    }
    if (typeof text !== "string") return { ok: false, reason: "invalid body" };
    if (Buffer.byteLength(text, "utf8") > FILE_PREVIEW_MAX_BYTES) return { ok: false, reason: "file too large" };
    try {
      if (ensureConfigToml(target.root.filePath, target.stub)) {
        const created = readRemoteProjectFile(target.root, target.relPath);
        if (!created.ok) return created;
        if (!created.stamp) return { ok: false, reason: "missing version stamp" };
        stamp = created.stamp;
      }
      // If it appeared meanwhile, retain the missing stamp: the ordinary
      // writer refuses the new version instead of adopting and overwriting it.
    } catch (e) {
      return { ok: false, reason: (e as Error).message || "could not create config" };
    }
  }
  return writeRemoteProjectFile(target.root, target.relPath, text, stamp, { expectedAbsPath });
}
