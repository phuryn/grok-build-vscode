/**
 * Find ffmpeg, and when it cannot be found, say something the user can act on.
 *
 * Pure: every filesystem and environment fact is injected, so the interesting
 * cases are testable without a machine that happens to be configured that way.
 *
 * Three real failures motivated this, all observed rather than imagined:
 *
 *   • **A GUI-launched app has a stripped PATH.** VS Code resolves the login
 *     shell's environment on macOS, so an extension host sees `/opt/homebrew/bin`
 *     and `spawn("ffmpeg")` works. The desktop app does not, so the same code
 *     reported ffmpeg missing on a machine where `which ffmpeg` answered fine.
 *   • **`brew info` prints the Cellar directory**, and pasting that produced
 *     `spawn /opt/homebrew/Cellar/ffmpeg EACCES` — macOS refusing to execute a
 *     folder. The error echoed the path back and left the user to spot that it
 *     was a directory.
 *   • **The remedy offered was "Open Settings"**, which is a dead end when the
 *     binary does not exist yet. It sends you to a text field to name a file you
 *     have not installed.
 */

/**
 * Directories package managers use that a GUI process's PATH routinely misses.
 * Ordered by how likely they are to be the one that matters.
 */
export const FFMPEG_WELL_KNOWN_DIRS: Readonly<Record<string, readonly string[]>> = {
  // Apple silicon Homebrew, then Intel Homebrew, then MacPorts.
  darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"],
  linux: ["/usr/local/bin", "/usr/bin", "/snap/bin", "/var/lib/flatpak/exports/bin"],
  // Windows installs land on PATH via the installer; there is no conventional
  // fixed location worth guessing, and guessing wrong is worse than not.
  win32: [],
};

export interface FfmpegEnv {
  platform: NodeJS.Platform;
  /** `process.env.PATH` — split on the platform's delimiter by the caller's OS. */
  pathEnv: string | undefined;
  /** Exists AND is a regular file. A directory must answer false. */
  isFile(candidate: string): boolean;
  /** Distinguishes "you pointed at a folder" from "nothing is there". */
  isDirectory(candidate: string): boolean;
}

export type FfmpegResolution =
  /** Spawn this. `bare` means hand "ffmpeg" to the OS and let PATH resolve it. */
  | { ok: true; path: string; source: "configured" | "path" | "well-known" }
  /** grok.ffmpegPath names a directory — the `brew info` copy-paste mistake. */
  | { ok: false; reason: "configured-is-directory"; configured: string; hint?: string }
  /** Configured, but nothing is there. */
  | { ok: false; reason: "configured-missing"; configured: string }
  /** Not configured and not findable anywhere. */
  | { ok: false; reason: "not-installed" };

const BINARY = (platform: NodeJS.Platform) => (platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * An explicit setting always wins — including when it is wrong. Silently
 * substituting a different binary for the one someone named would be worse than
 * failing, and it makes a misconfiguration impossible to diagnose.
 */
export function resolveFfmpeg(env: FfmpegEnv): FfmpegResolution {
  const binary = BINARY(env.platform);

  const dirs = (env.pathEnv || "")
    .split(env.platform === "win32" ? ";" : ":")
    .map((d) => d.trim())
    .filter(Boolean);

  for (const dir of dirs) {
    const candidate = join(dir, binary);
    if (env.isFile(candidate)) {
      // Bare, not absolute: spawn resolves it the same way, and the log line
      // stays readable. The scan only establishes that it is findable.
      return { ok: true, path: binary, source: "path" };
    }
  }

  for (const dir of FFMPEG_WELL_KNOWN_DIRS[env.platform] || []) {
    const candidate = join(dir, binary);
    if (env.isFile(candidate)) {
      return { ok: true, path: candidate, source: "well-known" };
    }
  }

  return { ok: false, reason: "not-installed" };
}

/** The configured-path branch, kept separate so the PATH scan stays simple. */
export function resolveConfiguredFfmpeg(configured: string, env: FfmpegEnv): FfmpegResolution {
  const trimmed = configured.trim();
  if (!trimmed) return resolveFfmpeg(env);

  if (env.isFile(trimmed)) return { ok: true, path: trimmed, source: "configured" };

  if (env.isDirectory(trimmed)) {
    // `brew info ffmpeg` prints the Cellar root; the binary is under bin/. Offer
    // the corrected path rather than making the user infer it from an errno.
    const inner = join(join(trimmed, "bin"), BINARY(env.platform));
    return {
      ok: false,
      reason: "configured-is-directory",
      configured: trimmed,
      hint: env.isFile(inner) ? inner : undefined,
    };
  }

  return { ok: false, reason: "configured-missing", configured: trimmed };
}

export interface FfmpegInstallHint {
  /** The exact command to run. */
  command: string;
  /**
   * True when we can pre-fill a terminal and let the user press Enter, and the
   * result is visible to the already-running editor. Only where the package
   * manager installs into a directory that is *already* on PATH — Homebrew adds
   * /opt/homebrew/bin to the shell profile when Homebrew itself is installed.
   * winget typically creates a new directory and appends it to PATH, which the
   * running process never sees, so a button there would appear to do nothing.
   */
  offerToRun: boolean;
}

/**
 * What to tell someone who does not have ffmpeg. `hasBrew` is injected because
 * offering `brew install` on a Mac without Homebrew is worse than useless — the
 * next step would be installing Homebrew itself, which is not a decision this
 * extension gets to make for someone.
 */
export function ffmpegInstallHint(platform: NodeJS.Platform, hasBrew: boolean): FfmpegInstallHint | undefined {
  if (platform === "darwin") {
    return hasBrew ? { command: "brew install ffmpeg", offerToRun: true } : undefined;
  }
  if (platform === "win32") return { command: "winget install ffmpeg", offerToRun: false };
  if (platform === "linux") return { command: "sudo apt install ffmpeg", offerToRun: false };
  return undefined;
}

/** One sentence, specific to what actually went wrong. */
export function describeFfmpegProblem(r: FfmpegResolution, hint?: FfmpegInstallHint): string {
  if (r.ok) return "";
  switch (r.reason) {
    case "configured-is-directory":
      return (
        `grok.ffmpegPath points at a folder, not a program: ${r.configured}` +
        (r.hint ? `. The binary is at ${r.hint}` : "") +
        "."
      );
    case "configured-missing":
      return `No ffmpeg at ${r.configured} — check grok.ffmpegPath.`;
    default:
      return (
        "ffmpeg is required to record the microphone and was not found." +
        (hint ? ` Install it with: ${hint.command}` : " See https://ffmpeg.org/download.html.")
      );
  }
}
