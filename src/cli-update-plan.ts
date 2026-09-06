/**
 * Update a CLI the way it was INSTALLED.
 *
 * `<cli> update` is the CLI's own updater, and for the shapes it recognises it
 * is the right answer. It is the wrong answer for an npm global install whose
 * package does not sit under npm's CONFIGURED prefix, because codex's updater
 * shells out to `npm install -g` and npm resolves that prefix for itself.
 *
 * Measured on our own cloud machines: codex lives in `~/.local`, while `npm
 * config get prefix` reports a root-owned nvm directory. The update dies with
 * EACCES renaming a file the user does not own — on the one surface where a
 * phone is the only screen and there is no shell to drop to.
 *
 * So derive the prefix from where the binary ACTUALLY is and hand it to npm.
 */

/** The npm package each CLI ships as, for the prefix-corrected reinstall. */
export const CLI_NPM_PACKAGE = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
} as const;

export type CliUpdatePlan =
  | { kind: "managed" }
  | { kind: "npm"; prefix: string; packageSpec: string }
  | { kind: "self" };

/**
 * The `--prefix` an npm global install was made with, read back out of the
 * binary's real path: npm puts a package at `<prefix>/lib/node_modules/...`
 * (POSIX) or `<prefix>/node_modules/...` (Windows), so the prefix is whatever
 * precedes that, minus the `lib`.
 *
 * `undefined` means this is not an npm layout — a standalone binary, a
 * Homebrew cellar, or a Windows `.cmd` shim that resolves to itself.
 */
export function npmPrefixForBinary(realPath: string): string | undefined {
  const at = realPath.search(/[\\/]node_modules[\\/]/);
  if (at < 0) return undefined;
  const prefix = realPath.slice(0, at).replace(/[\\/]lib$/, "");
  // A bare root ("/node_modules/...") is not a prefix anyone installed to.
  return prefix || undefined;
}

export function cliUpdatePlan(input: {
  /** The binary is inside our own managed store, so we own updating it. */
  managed: boolean;
  /** The located path with symlinks resolved. */
  realPath: string;
  packageName?: string;
}): CliUpdatePlan {
  if (input.managed) return { kind: "managed" };
  const prefix = input.packageName ? npmPrefixForBinary(input.realPath) : undefined;
  return prefix
    ? { kind: "npm", prefix, packageSpec: `${input.packageName}@latest` }
    : { kind: "self" };
}
