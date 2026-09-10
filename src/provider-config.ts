import * as os from "node:os";
import * as path from "node:path";

/** No caller-supplied paths or home overrides: these are the entire surface. */
export const PROVIDER_CONFIG_FILES = {
  grok: ".grok/config.toml",
  codex: ".codex/config.toml",
  claude: ".claude/settings.json",
} as const;

export function resolveProviderConfigFile(
  provider: unknown,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
) {
  if (typeof provider !== "string" || !Object.prototype.hasOwnProperty.call(PROVIDER_CONFIG_FILES, provider)) {
    return { ok: false, reason: "unknown provider config" } as const;
  }
  const configPath = PROVIDER_CONFIG_FILES[provider as keyof typeof PROVIDER_CONFIG_FILES];
  const paths = platform === "win32" ? path.win32 : path.posix;
  return {
    ok: true,
    root: { filePath: paths.join(home, configPath) },
    relPath: paths.basename(configPath),
    configPath,
  } as const;
}
