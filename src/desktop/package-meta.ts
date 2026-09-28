/**
 * Packaged desktop identity.
 *
 * electron-builder's `extraMetadata.name` rewrites the asar `package.json` to
 * `grok-build-desktop`, so `${publisher}.${name}` could never match
 * `OFFICIAL_EXTENSION_ID` and desktop telemetry disabled silently — correct
 * behaviour for a fork, wrong for our own app. Measured 2026-08-22: zero
 * desktop rows in a 56,893-session export.
 *
 * The packaged file therefore carries `grokExtensionName`, which restores the
 * half packaging clobbers. It is deliberately the NAME only, never the whole
 * id: a fork changes `publisher` to publish as itself, and if the full id were
 * baked in, that fork would inherit ours and report into the official project
 * without anyone intending it. Deriving from whatever `publisher` the package
 * actually carries keeps the automatic opt-out a fork has always had.
 */
export const PACKAGED_EXTENSION_NAME_FIELD = "grokExtensionName";

/**
 * Marks a build made to run as a CLOUD ENVIRONMENT rather than on a desk.
 *
 * Injected by `dist:linux` only, which builds both the AppImage and the deb
 * in one invocation, so both carry the flag. A packaged build otherwise
 * refuses the environment entirely: no relay override, no injected device
 * token. That is right for an app on a laptop and fatal for a machine with
 * no keyboard, which can only be told who it is by the relay that created it.
 *
 * The flag is not enough on its own. `resolveRelayUrl` also requires the
 * machine to declare itself a cloud environment at runtime, so installing
 * the AppImage or the deb on a desk does not trust the environment. The mac
 * and Windows installers are unchanged and still cannot be talked into it.
 */
export const PACKAGED_CLOUD_BUILD_FIELD = "grokCloudBuild";

/**
 * Whether this package was built for cloud environments.
 *
 * Deliberately strict about what counts as true. electron-builder's
 * `extraMetadata` writes whatever it is given, and a JSON `true` and the string
 * `"true"` both arrive here depending on how the flag was passed — but anything
 * else, including a stray `"false"`, must read as false.
 */
export function isCloudBuildFromPackageMeta(pkg: { grokCloudBuild?: unknown }): boolean {
  return pkg.grokCloudBuild === true || pkg.grokCloudBuild === "true";
}

const FALLBACK_PUBLISHER = "PawelHuryn";
const FALLBACK_NAME = "grok-vscode-phuryn";

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function extensionIdFromPackageMeta(pkg: {
  grokExtensionName?: unknown;
  publisher?: unknown;
  name?: unknown;
}): string {
  const publisher = str(pkg.publisher) ?? FALLBACK_PUBLISHER;
  // `grokExtensionName` wins over `name` because packaging overwrites `name`.
  // It does not win over `publisher`, which is the fork signal.
  const name = str(pkg.grokExtensionName) ?? str(pkg.name) ?? FALLBACK_NAME;
  return `${publisher}.${name}`;
}
