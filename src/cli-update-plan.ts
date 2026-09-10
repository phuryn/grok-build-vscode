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
  /** `target` is the exact version to move to. The SPELLING differs per CLI —
   *  grok takes `update --version X`, claude takes `install X` — so the plan
   *  carries the version and the caller carries the words. Absent means "let
   *  the CLI decide", which is the only honest thing to say about a binary we
   *  have no pinned version for. */
  | { kind: "self"; target?: string };

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

/**
 * The words a CLI's OWN updater takes for an exact version.
 *
 * Measured on a real machine (2026-09-10), because these are third-party
 * contracts and reading them off a help page is how the `gh --json` break
 * happened: claude takes `install <v>` and has no version flag on `update` at
 * all, grok takes `update --version <v>`. Codex is deliberately absent — we
 * never measured a version-capable spelling for its own updater, and guessing
 * one would turn a working plain update into a failing one. It reaches this
 * path only when it is neither managed nor an npm layout.
 */
export function selfUpdateArgs(provider: "codex" | "claude" | "grok", target?: string): string[] {
  if (!target) return ["update"];
  if (provider === "claude") return ["install", target];
  if (provider === "grok") return ["update", "--version", target];
  return ["update"];
}

export function cliUpdatePlan(input: {
  /** The binary is inside our own managed store, so we own updating it. */
  managed: boolean;
  /** The located path with symlinks resolved. */
  realPath: string;
  packageName?: string;
  /**
   * The version we want to be on. The product already NAMES one: Settings shows
   * `latestCliVersion` as the pin and computes "update available" against it, so
   * fetching `@latest` here installs something other than the number the person
   * was just shown — and on a cloud machine that is how the same build ends up
   * running three different CLI versions. Omitted only where nothing pins one.
   */
  targetVersion?: string;
}): CliUpdatePlan {
  if (input.managed) return { kind: "managed" };
  const prefix = input.packageName ? npmPrefixForBinary(input.realPath) : undefined;
  return prefix
    ? { kind: "npm", prefix, packageSpec: `${input.packageName}@${input.targetVersion ?? "latest"}` }
    : { kind: "self", ...(input.targetVersion ? { target: input.targetVersion } : {}) };
}
