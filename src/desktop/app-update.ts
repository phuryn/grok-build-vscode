/**
 * Desktop update helpers — pure, no network, no Electron.
 *
 * Packaged win32/darwin/linux run electron-updater against the relay generic
 * feed (`desktopUpdateFeedConfig`). Check/download failure falls back to the
 * GitHub Releases notice. The updater itself is injected; this module never
 * imports it.
 * Contract: docs/desktop-update-spec.md.
 */

/**
 * Anchored installer asset suffixes. `.exe.blockmap` / `.zip.blockmap` must
 * never match.
 *
 * `x86_64` is electron-builder's AppImage arch spelling. The Debian package
 * uses `amd64`. Every other target uses the short `x64`. A pattern that
 * assumed otherwise matches nothing and fails silently.
 */
export const DESKTOP_INSTALLER_SUFFIXES = [
  "-mac-arm64.dmg",
  "-mac-x64.dmg",
  "-mac-arm64.zip",
  "-mac-x64.zip",
  "-win-x64.exe",
  "-linux-x86_64.AppImage",
  "-linux-amd64.deb",
] as const;

export type Semver = { major: number; minor: number; patch: number };

/** Parse `X.Y.Z` (optional leading `v`, optional pre-release suffix after `-`/`+`). */
export function parseSemver(raw: string | null | undefined): Semver | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Take the first three numeric components; drop pre-release/build metadata.
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Numeric compare: negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** True when `a` is strictly newer than `b` (both must parse). */
export function isNewerVersion(
  candidate: string | null | undefined,
  current: string | null | undefined,
): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (!c || !cur) return false;
  return compareSemver(c, cur) > 0;
}

/**
 * True when the asset name is a desktop installer for this product, not a
 * companion file (`.blockmap`) or the vsix / source archive.
 * Anchored end-match so `…-win-x64.exe.blockmap` fails.
 */
export function isDesktopInstallerAsset(name: string | null | undefined): boolean {
  const n = String(name || "");
  if (!n) return false;
  // Refuse anything that has an extra extension after the installer suffix.
  for (const suffix of DESKTOP_INSTALLER_SUFFIXES) {
    if (n.endsWith(suffix)) return true;
  }
  return false;
}

export interface GithubReleaseLike {
  tag_name?: string;
  name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string }[] | null;
}

export interface DesktopReleaseNotice {
  version: string;
  url: string;
}

/**
 * Pick the newest non-draft release that carries at least one desktop
 * installer asset. Ignores unparseable tags. Does not compare to the running
 * version — callers use {@link isNewerVersion}.
 */
export function pickLatestDesktopRelease(
  releases: readonly GithubReleaseLike[] | null | undefined,
): DesktopReleaseNotice | null {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  let best: { version: string; url: string; semver: Semver } | null = null;
  for (const r of releases) {
    if (!r || r.draft) continue;
    // Pre-releases COUNT. Skipping them is the usual default and it was exactly
    // wrong here: the desktop app ships pre-release while it is unsigned, so a
    // stable-only check would never fire for the very users this exists to
    // reach — everyone on the first builds, told about nothing, forever.
    // Drafts stay excluded because their assets 404 for anonymous downloads.
    const assets = Array.isArray(r.assets) ? r.assets : [];
    if (!assets.some((a: { name?: string }) => isDesktopInstallerAsset(a?.name))) continue;
    const tag = r.tag_name || r.name || "";
    const semver = parseSemver(tag);
    if (!semver) continue;
    const version = `${semver.major}.${semver.minor}.${semver.patch}`;
    const url =
      (typeof r.html_url === "string" && r.html_url) ||
      `https://github.com/phuryn/grok-build-vscode/releases/tag/${encodeURIComponent(tag)}`;
    if (!best || compareSemver(semver, best.semver) > 0) {
      best = { version, url, semver };
    }
  }
  return best ? { version: best.version, url: best.url } : null;
}

/**
 * Decide whether to show an update notice. Returns the notice payload, or null
 * when current is already latest / unparseable / no release / not newer.
 */
export function noticeIfUpdateAvailable(
  currentVersion: string | null | undefined,
  releases: readonly GithubReleaseLike[] | null | undefined,
): DesktopReleaseNotice | null {
  const latest = pickLatestDesktopRelease(releases);
  if (!latest) return null;
  if (!isNewerVersion(latest.version, currentVersion)) return null;
  return latest;
}

/**
 * Where the "Update available" button sends people.
 *
 * NOT the GitHub release page, which is a developer artifact: a wall of `.dmg`,
 * `.zip`, `.exe`, `.blockmap` and a `.vsix`, with no indication which one you
 * want. This page detects the platform and offers one button.
 *
 * The URL is deliberately generic and carries only the running version, because
 * it is compiled into every installed copy and can never be changed for builds
 * already in the wild. Everything else the page shows is derived server-side,
 * so its content can be rewritten forever without another release.
 */
export function desktopUpdatePageUrl(currentVersion: string | null | undefined): string {
  const v = String(currentVersion || "").trim();
  const base = "https://afkpilot.com/desktop-update";
  return v ? `${base}?from=${encodeURIComponent(v)}` : base;
}

/** GitHub API URL used by the main process (per_page=100 covers recent history). */
export const DESKTOP_RELEASES_API_URL =
  "https://api.github.com/repos/phuryn/grok-build-vscode/releases?per_page=100";

/** How often a long-running desk re-checks (12 hours). */
export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Relay origin for generic-provider channel files. Trailing path is per-platform. */
export const DESKTOP_UPDATE_FEED_ORIGIN = "https://afkpilot.com/update";

/**
 * Generic-provider directory for this platform (trailing slash).
 * electron-updater appends `latest.yml` (win32), `latest-mac.yml` (darwin) or
 * `latest-linux.yml` (linux). Null everywhere else.
 *
 * Linux was null until the AppImage became an offered download. It is safe to
 * return a feed for the SAME artifact the cloud machines run, because
 * `AppImageUpdater.isUpdaterActive()` returns false unless `process.env.APPIMAGE`
 * is set — and a cloud machine execs the extracted `squashfs-root`, never the
 * AppImage. `checkForUpdates()` then resolves null with a log line, no error
 * event and no notice, so a sprite cannot self-update out from under the
 * relay's refresh tooling. Do not add a cloud check here: the property is
 * structural, and a check would be one more thing to keep true.
 */
export function desktopUpdateFeedBase(
  platform: NodeJS.Platform | string | null | undefined,
): string | null {
  if (platform === "win32") return `${DESKTOP_UPDATE_FEED_ORIGIN}/win/`;
  if (platform === "darwin") return `${DESKTOP_UPDATE_FEED_ORIGIN}/mac/`;
  if (platform === "linux") return `${DESKTOP_UPDATE_FEED_ORIGIN}/linux/`;
  return null;
}

/** `setFeedURL` payload, or null when this platform has no in-app updater. */
export function desktopUpdateFeedConfig(
  platform: NodeJS.Platform | string | null | undefined,
): { provider: "generic"; url: string } | null {
  const url = desktopUpdateFeedBase(platform);
  if (!url) return null;
  return { provider: "generic", url };
}

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "failed";

export type AppUpdateEvent =
  | { type: "check-started" }
  | { type: "update-available"; version: string }
  | { type: "update-not-available" }
  | { type: "download-started" }
  | { type: "update-downloaded"; version: string }
  | { type: "error" };

export interface AppUpdateState {
  phase: AppUpdatePhase;
  version: string | null;
}

export function initialAppUpdateState(): AppUpdateState {
  return { phase: "idle", version: null };
}

/** Event → next phase. `ready` is sticky: a later check/error must not hide a downloaded update. */
export function reduceAppUpdate(state: AppUpdateState, event: AppUpdateEvent): AppUpdateState {
  if (state.phase === "ready" && event.type !== "update-downloaded") {
    return state;
  }
  switch (event.type) {
    case "check-started":
      return { phase: "checking", version: state.version };
    case "update-available":
      return { phase: "available", version: event.version || state.version };
    case "update-not-available":
      return { phase: "idle", version: null };
    case "download-started":
      return { phase: "downloading", version: state.version };
    case "update-downloaded":
      return { phase: "ready", version: event.version || state.version };
    case "error":
      return { phase: "failed", version: state.version };
  }
}

export type RailUpdateKind = "hidden" | "notice" | "restart";

/** What the rail should show for this updater state. Notice still needs a GitHub hit. */
export function railUpdateKind(state: AppUpdateState): RailUpdateKind {
  if (state.phase === "ready") return "restart";
  if (state.phase === "failed") return "notice";
  return "hidden";
}

export function shouldRunNoticeFallback(state: AppUpdateState): boolean {
  return state.phase === "failed";
}

/** Skip a scheduled check while a download is in flight or already staged. */
export function shouldSkipUpdateCheck(state: AppUpdateState): boolean {
  return state.phase === "ready" || state.phase === "downloading";
}

/** True when this host should talk to electron-updater (not the notice-only path). */
export function desktopAutoUpdateEnabled(opts: {
  platform: NodeJS.Platform | string | null | undefined;
  packaged: boolean;
  forceDev?: boolean;
}): boolean {
  if (!desktopUpdateFeedConfig(opts.platform)) return false;
  return !!opts.packaged || !!opts.forceDev;
}

/** latest-mac.yml from one dual-arch `electron-builder --mac` must list both zips. */
export function latestMacYmlHasBothArches(yml: string | null | undefined): boolean {
  // Same line-end anchor as the Windows check: a bare `/mac-arm64\.zip/`
  // also matches `mac-arm64.zip.blockmap`.
  const s = String(yml || "");
  return /mac-arm64\.zip\s*$/m.test(s) && /mac-x64\.zip\s*$/m.test(s);
}

export function latestWinYmlHasInstaller(yml: string | null | undefined): boolean {
  // Line-end anchor: `url:` / `path:` lines end with the name. A bare
  // `/win-x64\.exe/` also matches `win-x64.exe.blockmap`.
  return /win-x64\.exe\s*$/m.test(String(yml || ""));
}

/** latest-linux.yml from `electron-builder --linux` must list the AppImage. */
export function latestLinuxYmlHasAppImage(yml: string | null | undefined): boolean {
  // Same line-end anchor as the other two. An AppImage embeds its own block
  // map, so unlike the Windows case there is no sibling file to exclude —
  // the anchor is kept for consistency and against a future `.AppImage.zsync`.
  return /linux-x86_64\.AppImage\s*$/m.test(String(yml || ""));
}

/**
 * Injectable updater. Shape is the subset of electron-updater's AppUpdater this
 * host uses — tests supply a fake; main.ts passes the real singleton.
 */
export interface DesktopAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  forceDevUpdateConfig?: boolean;
  logger: unknown;
  setFeedURL(opts: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface DesktopUpdateUi {
  postNotice(version: string, url: string): void;
  postReady(version: string): void;
  log(line: string): void;
  fetchNotice(): Promise<DesktopReleaseNotice | null>;
}

export interface DesktopUpdateSession {
  check(): Promise<void>;
  install(): void;
  getState(): AppUpdateState;
}

function versionFromUpdaterInfo(info: unknown): string {
  if (info && typeof info === "object" && "version" in info) {
    const v = (info as { version?: unknown }).version;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function updaterLogLine(message: unknown): string {
  if (message == null) return "";
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.stack || message.message;
  try {
    return String(message);
  } catch {
    return "unknown";
  }
}

/**
 * Wire an injected updater (or the notice-only path) to the rail.
 *
 * `updater` may be a THUNK, and on Linux it has to be. `electron-updater`
 * exports `autoUpdater` as a getter that builds the platform's updater the
 * first time it is read, and on Linux that is `AppImageUpdater`, whose
 * constructor rejects an app version that is not valid semver. An unpackaged
 * run reports `"0.0"`, so merely NAMING `autoUpdater` at the call site threw
 * before this function could decide it did not want one —
 * `App version is not a valid semver version: "0.0"`, at startup, fatal.
 *
 * Nothing caught it for months because it is Linux-only and unpackaged-only,
 * and this app is developed on Windows and macOS and shipped packaged. It
 * surfaced the first time the desktop host was run in a container.
 *
 * So the decision comes first and the construction second, which is the order
 * this module already claimed: "the updater itself is injected; this module
 * never imports it."
 */
export function attachDesktopAutoUpdate(opts: {
  updater: DesktopAutoUpdater | (() => DesktopAutoUpdater);
  platform: NodeJS.Platform | string;
  currentVersion: string;
  packaged: boolean;
  forceDev?: boolean;
  ui: DesktopUpdateUi;
}): DesktopUpdateSession {
  let state = initialAppUpdateState();
  let configured = false;
  const enabled = desktopAutoUpdateEnabled(opts);
  let resolvedUpdater: DesktopAutoUpdater | undefined;
  /** Resolve the injected updater at most once, and only when it is wanted. */
  const updater = (): DesktopAutoUpdater => {
    if (!resolvedUpdater) {
      resolvedUpdater = typeof opts.updater === "function"
        ? (opts.updater as () => DesktopAutoUpdater)()
        : opts.updater;
    }
    return resolvedUpdater;
  };

  const apply = (event: AppUpdateEvent): AppUpdateState => {
    state = reduceAppUpdate(state, event);
    return state;
  };

  const fallbackNotice = async (): Promise<void> => {
    const isReady = () => state.phase === "ready";
    if (isReady()) return;
    try {
      const notice = await opts.ui.fetchNotice();
      if (isReady()) return;
      if (notice) opts.ui.postNotice(notice.version, desktopUpdatePageUrl(opts.currentVersion));
    } catch (e) {
      opts.ui.log(`[update] notice fallback failed: ${updaterLogLine(e)}`);
    }
  };

  const configure = (): boolean => {
    if (configured) return true;
    const feed = desktopUpdateFeedConfig(opts.platform);
    if (!feed) return false;
    updater().autoDownload = true;
    updater().autoInstallOnAppQuit = true;
    updater().allowPrerelease = false;
    // Unpackaged forceDev: leave the production URL unset so electron-updater
    // reads dev-app-update.yml from the app path. setFeedURL always wins over
    // that file, including when forceDevUpdateConfig is set. Packaged builds
    // never read the yml — they always take the relay feed.
    const forceDevUnpackaged = !!opts.forceDev && !opts.packaged;
    if (forceDevUnpackaged) updater().forceDevUpdateConfig = true;
    updater().logger = {
      info: (m: unknown) => opts.ui.log(`[update] ${updaterLogLine(m)}`),
      warn: (m: unknown) => opts.ui.log(`[update] ${updaterLogLine(m)}`),
      error: (m: unknown) => opts.ui.log(`[update] ${updaterLogLine(m)}`),
      debug: (m: unknown) => opts.ui.log(`[update] ${updaterLogLine(m)}`),
    };
    if (!forceDevUnpackaged) updater().setFeedURL(feed);
    updater().on("checking-for-update", () => {
      apply({ type: "check-started" });
    });
    updater().on("update-available", (info: unknown) => {
      apply({ type: "update-available", version: versionFromUpdaterInfo(info) });
      apply({ type: "download-started" });
    });
    updater().on("update-not-available", () => {
      apply({ type: "update-not-available" });
    });
    updater().on("update-downloaded", (info: unknown) => {
      const next = apply({ type: "update-downloaded", version: versionFromUpdaterInfo(info) });
      if (next.phase === "ready" && next.version) opts.ui.postReady(next.version);
    });
    updater().on("error", (err: unknown) => {
      opts.ui.log(`[update] ${updaterLogLine(err)}`);
      apply({ type: "error" });
      void fallbackNotice();
    });
    configured = true;
    return true;
  };

  return {
    getState: () => state,
    install() {
      if (state.phase !== "ready") return;
      try {
        // Silent + force-run: a non-silent NSIS install (oneClick:false) runs
        // the full wizard and ignores isForceRunAfter. Squirrel.Mac ignores both.
        updater().quitAndInstall(true, true);
      } catch (e) {
        opts.ui.log(`[update] quitAndInstall failed: ${updaterLogLine(e)}`);
        void fallbackNotice();
      }
    },
    async check() {
      if (shouldSkipUpdateCheck(state)) return;
      if (!enabled) {
        await fallbackNotice();
        return;
      }
      if (!configure()) {
        await fallbackNotice();
        return;
      }
      try {
        // `null` means the updater declined to act, and electron-updater says
        // so without throwing -- so this is NOT covered by the catch below.
        // On Linux that is `AppImageUpdater.isUpdaterActive()` returning false
        // because `process.env.APPIMAGE` is unset, which happens whenever the
        // AppImage was EXTRACTED rather than run: a cloud machine always, and a
        // desk user who ran `--appimage-extract` because their distro has no
        // libfuse2 -- the usual workaround, and Ubuntu 22.04+ ships without it.
        //
        // That desk user got the phase-1 notice before this channel existed,
        // and silence would be a regression for exactly the people least able
        // to run the file normally. So a declining updater falls back like a
        // failing one.
        //
        // This needs no cloud check and must not grow one. `updateAvailable` is
        // host-local outbound, and every client of a cloud host is a remote, so
        // the notice this posts there reaches nobody.
        const result = await updater().checkForUpdates();
        if (!result) await fallbackNotice();
      } catch (e) {
        opts.ui.log(`[update] check failed: ${updaterLogLine(e)}`);
        apply({ type: "error" });
        await fallbackNotice();
      }
    },
  };
}
