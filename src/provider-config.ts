import * as os from "node:os";
import * as path from "node:path";
import { resolveCodexHome } from "./codex-cli-locator";
import { resolveGrokHome } from "./sessions";

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
  } as const;
}
