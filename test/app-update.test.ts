/**
 * Desktop update-notice pure helpers + remote policy classification.
 * No network — the main process fetch is silence-on-failure and is not
 * exercised here.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachDesktopAutoUpdate,
  compareSemver,
  desktopAutoUpdateEnabled,
  desktopUpdateFeedBase,
  desktopUpdateFeedConfig,
  desktopUpdatePageUrl,
  initialAppUpdateState,
  isDesktopInstallerAsset,
  isNewerVersion,
  latestLinuxYmlHasAppImage,
  latestMacYmlHasBothArches,
  latestWinYmlHasInstaller,
  noticeIfUpdateAvailable,
  parseSemver,
  pickLatestDesktopRelease,
  railUpdateKind,
  reduceAppUpdate,
  shouldRunNoticeFallback,
  shouldSkipUpdateCheck,
  type DesktopAutoUpdater,
  type GithubReleaseLike,
} from "../src/desktop/app-update";
import {
  INBOUND_DISPOSITION,
  OUTBOUND_DISPOSITION,
} from "../src/remote-policy";

describe("parseSemver / compareSemver", () => {
  it("parses plain and v-prefixed versions", () => {
    expect(parseSemver("3.2.0")).toEqual({ major: 3, minor: 2, patch: 0 });
    expect(parseSemver("v3.10.1")).toEqual({ major: 3, minor: 10, patch: 1 });
    expect(parseSemver("3.9.0-beta.1")).toEqual({ major: 3, minor: 9, patch: 0 });
  });

  it("returns null for unparseable input", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
    expect(parseSemver("latest")).toBeNull();
    expect(parseSemver("abc")).toBeNull();
    expect(parseSemver("3")).toBeNull();
  });

  it("compares numerically so 3.10.0 > 3.9.0 (string compare would reverse)", () => {
    const a = parseSemver("3.10.0")!;
    const b = parseSemver("3.9.0")!;
    expect(compareSemver(a, b)).toBeGreaterThan(0);
    expect(compareSemver(b, a)).toBeLessThan(0);
    // String compare would claim the opposite:
    expect("3.10.0" < "3.9.0").toBe(true);
    expect(isNewerVersion("3.10.0", "3.9.0")).toBe(true);
    expect(isNewerVersion("3.9.0", "3.10.0")).toBe(false);
    expect(isNewerVersion("3.9.0", "3.9.0")).toBe(false);
  });

  it("ignores unparseable candidates and currents", () => {
    expect(isNewerVersion("nope", "3.2.0")).toBe(false);
    expect(isNewerVersion("3.2.0", "nope")).toBe(false);
    expect(isNewerVersion(null, "3.2.0")).toBe(false);
  });
});

describe("isDesktopInstallerAsset", () => {
  it("matches anchored installer suffixes", () => {
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-arm64.dmg")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-x64.dmg")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-arm64.zip")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-x64.zip")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-win-x64.exe")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-4.11.0-linux-x86_64.AppImage")).toBe(true);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-4.11.0-linux-amd64.deb")).toBe(true);
  });

  it("excludes .blockmap and other companions", () => {
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-win-x64.exe.blockmap")).toBe(false);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-arm64.dmg.blockmap")).toBe(false);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-arm64.zip.blockmap")).toBe(false);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-3.2.0-mac-x64.zip.blockmap")).toBe(false);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-4.11.0-linux-amd64.deb.blockmap")).toBe(false);
    expect(isDesktopInstallerAsset("Grok-Build-Desktop-4.11.0-linux-x64.deb")).toBe(false);
    expect(isDesktopInstallerAsset("grok-vscode-phuryn-3.2.0.vsix")).toBe(false);
    expect(isDesktopInstallerAsset("Source code (zip)")).toBe(false);
    expect(isDesktopInstallerAsset("")).toBe(false);
  });
});

describe("pickLatestDesktopRelease / noticeIfUpdateAvailable", () => {
  const releases: GithubReleaseLike[] = [
    {
      tag_name: "v3.1.0",
      html_url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.1.0",
      assets: [{ name: "Grok-Build-Desktop-3.1.0-win-x64.exe" }],
    },
    {
      tag_name: "v3.2.0",
      html_url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.2.0",
      assets: [
        { name: "Grok-Build-Desktop-3.2.0-win-x64.exe" },
        { name: "Grok-Build-Desktop-3.2.0-win-x64.exe.blockmap" },
      ],
    },
    {
      // Extension-only release: no desktop installers → skip.
      tag_name: "v3.3.0",
      html_url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.3.0",
      assets: [{ name: "grok-vscode-phuryn-3.3.0.vsix" }],
    },
    {
      tag_name: "not-a-version",
      assets: [{ name: "Grok-Build-Desktop-x-win-x64.exe" }],
    },
    {
      tag_name: "v9.9.9",
      draft: true,
      assets: [{ name: "Grok-Build-Desktop-9.9.9-win-x64.exe" }],
    },
    {
      // Not a pre-release any more: this app SHIPS pre-release, so excluding
      // them would have meant never notifying the users it exists for. The
      // fixture keeps a non-installer release instead, which is the real reason
      // a release gets skipped.
      tag_name: "v9.8.8",
      assets: [{ name: "grok-vscode-phuryn-9.8.8.vsix" }],
    },
  ];

  it("picks the newest release that actually carries desktop installers", () => {
    const latest = pickLatestDesktopRelease(releases);
    expect(latest).toEqual({
      version: "3.2.0",
      url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.2.0",
    });
  });

  it("treats a zip-only mac release as a desktop release", () => {
    expect(
      pickLatestDesktopRelease([
        {
          tag_name: "v3.4.0",
          html_url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.4.0",
          assets: [{ name: "Grok-Build-Desktop-3.4.0-mac-arm64.zip" }],
        },
      ]),
    ).toEqual({
      version: "3.4.0",
      url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.4.0",
    });
  });

  it("notifies only when the release is newer than the running app", () => {
    expect(noticeIfUpdateAvailable("3.1.0", releases)).toEqual({
      version: "3.2.0",
      url: "https://github.com/phuryn/grok-build-vscode/releases/tag/v3.2.0",
    });
    expect(noticeIfUpdateAvailable("3.2.0", releases)).toBeNull();
    expect(noticeIfUpdateAvailable("3.10.0", releases)).toBeNull();
  });

  it("produces no notice on empty / null / failed-shaped input", () => {
    expect(noticeIfUpdateAvailable("3.0.0", null)).toBeNull();
    expect(noticeIfUpdateAvailable("3.0.0", undefined)).toBeNull();
    expect(noticeIfUpdateAvailable("3.0.0", [])).toBeNull();
    expect(noticeIfUpdateAvailable("3.0.0", [{ tag_name: "v1.0.0", assets: [] }])).toBeNull();
  });
});

describe("updateAvailable remote policy (host-local both ways)", () => {
  it("keeps updateAvailable outbound host-local so remotes never see the button", () => {
    expect(OUTBOUND_DISPOSITION.updateAvailable).toBe("host-local");
  });

  it("keeps updateReady outbound host-local so remotes never see Restart", () => {
    expect(OUTBOUND_DISPOSITION.updateReady).toBe("host-local");
  });

  it("keeps openUpdateRelease inbound host-local so a phone cannot open desk updates", () => {
    expect(INBOUND_DISPOSITION.openUpdateRelease).toBe("host-local");
  });

  it("keeps restartToUpdate inbound host-local so a phone cannot quit the desk", () => {
    expect(INBOUND_DISPOSITION.restartToUpdate).toBe("host-local");
  });
});

describe("pre-releases count", () => {
  // The desktop app ships pre-release while it is unsigned. A stable-only check
  // is the usual default and was exactly wrong here: it would never fire for
  // anyone on the first builds — the very users the notice exists to reach.
  const asset = { name: "Grok-Build-Desktop-3.3.0-win-x64.exe", browser_download_url: "https://x/y" };

  it("notifies about a newer pre-release", () => {
    const notice = pickLatestDesktopRelease([
      { tag_name: "v3.3.0", draft: false, prerelease: true, assets: [asset] },
    ]);
    expect(notice).not.toBeNull();
    expect(notice!.version).toContain("3.3.0");
  });

  it("still ignores drafts, whose assets 404 for anonymous downloads", () => {
    expect(
      pickLatestDesktopRelease([
        { tag_name: "v3.3.0", draft: true, prerelease: true, assets: [asset] },
      ]),
    ).toBeNull();
  });
});

describe("where the update button sends people", () => {
  it("goes to our own update page, never the GitHub release page", () => {
    // The release page is a developer artifact — .dmg, .zip, .exe, .blockmap and
    // a .vsix with nothing saying which is yours.
    const url = desktopUpdatePageUrl("3.2.4");
    expect(url.startsWith("https://afkpilot.com/desktop-update")).toBe(true);
    expect(url).not.toContain("github.com");
  });

  it("carries the running version and nothing else", () => {
    // This URL is compiled into every installed copy and can never be changed
    // for builds already out there, so it stays generic: the app says where it
    // is, the page decides what to show. Anything more specific baked in here
    // would be a decision we could not take back.
    expect(desktopUpdatePageUrl("3.2.4")).toBe("https://afkpilot.com/desktop-update?from=3.2.4");
    expect(desktopUpdatePageUrl("")).toBe("https://afkpilot.com/desktop-update");
    expect(desktopUpdatePageUrl(null)).toBe("https://afkpilot.com/desktop-update");
    expect(desktopUpdatePageUrl("3.2.4 &x=1")).toContain("from=3.2.4%20%26x%3D1");
  });
});

describe("generic feed URL selection", () => {
  it("points Windows at /update/win/ so electron-updater fetches latest.yml", () => {
    expect(desktopUpdateFeedBase("win32")).toBe("https://afkpilot.com/update/win/");
    expect(desktopUpdateFeedConfig("win32")).toEqual({
      provider: "generic",
      url: "https://afkpilot.com/update/win/",
    });
  });

  it("points macOS at /update/mac/ so electron-updater fetches latest-mac.yml", () => {
    expect(desktopUpdateFeedBase("darwin")).toBe("https://afkpilot.com/update/mac/");
    expect(desktopUpdateFeedConfig("darwin")).toEqual({
      provider: "generic",
      url: "https://afkpilot.com/update/mac/",
    });
  });

  it("feeds Linux from the AppImage channel", () => {
    // The same AppImage the cloud machines install. Safe because
    // AppImageUpdater refuses to run without process.env.APPIMAGE, which an
    // extracted `squashfs-root` run never has — so a sprite asks this endpoint
    // nothing while a desk user who ran the file gets a real update.
    expect(desktopUpdateFeedBase("linux")).toBe("https://afkpilot.com/update/linux/");
    expect(desktopUpdateFeedConfig("linux")).toEqual({
      provider: "generic",
      url: "https://afkpilot.com/update/linux/",
    });
    expect(desktopAutoUpdateEnabled({ platform: "linux", packaged: true })).toBe(true);
  });

  it("has no in-app feed on a platform we do not ship", () => {
    expect(desktopUpdateFeedBase("freebsd")).toBeNull();
    expect(desktopUpdateFeedConfig("freebsd")).toBeNull();
    expect(desktopAutoUpdateEnabled({ platform: "freebsd", packaged: true })).toBe(false);
  });

  it("enables the updater only when packaged or forceDev", () => {
    expect(desktopAutoUpdateEnabled({ platform: "win32", packaged: true })).toBe(true);
    expect(desktopAutoUpdateEnabled({ platform: "darwin", packaged: false })).toBe(false);
    expect(desktopAutoUpdateEnabled({ platform: "darwin", packaged: false, forceDev: true })).toBe(true);
  });
});

describe("latest.yml dual-arch / installer checks", () => {
  it("requires both mac zip arches", () => {
    expect(
      latestMacYmlHasBothArches(
        "files:\n  - url: Grok-Build-Desktop-3.7.0-mac-arm64.zip\n  - url: Grok-Build-Desktop-3.7.0-mac-x64.zip\n",
      ),
    ).toBe(true);
    expect(latestMacYmlHasBothArches("files:\n  - url: Grok-Build-Desktop-3.7.0-mac-arm64.zip\n")).toBe(false);
    expect(latestMacYmlHasBothArches("")).toBe(false);
    // Blockmap-only lines must not satisfy either arch — same class as the
    // Windows check below.
    expect(
      latestMacYmlHasBothArches(
        "files:\n  - url: Grok-Build-Desktop-3.7.0-mac-arm64.zip.blockmap\n  - url: Grok-Build-Desktop-3.7.0-mac-x64.zip.blockmap\n",
      ),
    ).toBe(false);
    expect(
      latestMacYmlHasBothArches(
        "files:\r\n  - url: Grok-Build-Desktop-3.7.0-mac-arm64.zip\r\n  - url: Grok-Build-Desktop-3.7.0-mac-x64.zip\r\n",
      ),
    ).toBe(true);
  });

  it("requires the Windows NSIS installer name", () => {
    expect(latestWinYmlHasInstaller("path: Grok-Build-Desktop-3.7.0-win-x64.exe")).toBe(true);
    expect(latestWinYmlHasInstaller("url: Grok-Build-Desktop-3.7.0-win-x64.exe\r")).toBe(true);
    expect(latestWinYmlHasInstaller("path: Grok-Build-Desktop-3.7.0-win-x64.exe.blockmap")).toBe(false);
    expect(latestWinYmlHasInstaller("url: Grok-Build-Desktop-3.7.0-win-x64.exe.blockmap\n")).toBe(false);
    expect(latestWinYmlHasInstaller("path: something.vsix")).toBe(false);
  });

  it("requires the Linux AppImage name, with the long arch spelling", () => {
    expect(latestLinuxYmlHasAppImage("path: Grok-Build-Desktop-4.6.1-linux-x86_64.AppImage")).toBe(true);
    expect(latestLinuxYmlHasAppImage("url: Grok-Build-Desktop-4.6.1-linux-x86_64.AppImage\r")).toBe(true);
    expect(
      latestLinuxYmlHasAppImage(
        [
          "path: Grok-Build-Desktop-4.11.0-linux-x86_64.AppImage",
          "files:",
          "  - url: Grok-Build-Desktop-4.11.0-linux-x86_64.AppImage",
          "  - url: Grok-Build-Desktop-4.11.0-linux-amd64.deb",
        ].join("\n"),
      ),
    ).toBe(true);
    // `x64` is what every other target uses and what a reasonable person
    // writes. electron-builder does not, and a pattern built on the guess
    // matches nothing while looking correct.
    expect(latestLinuxYmlHasAppImage("path: Grok-Build-Desktop-4.6.1-linux-x64.AppImage")).toBe(false);
    expect(latestLinuxYmlHasAppImage("path: Grok-Build-Desktop-4.6.1-linux-x86_64.AppImage.zsync")).toBe(false);
    expect(latestLinuxYmlHasAppImage("path: something.vsix")).toBe(false);
    expect(latestLinuxYmlHasAppImage("")).toBe(false);
  });
});

describe("update state machine", () => {
  it("walks check → available → downloading → ready", () => {
    let s = initialAppUpdateState();
    expect(railUpdateKind(s)).toBe("hidden");
    s = reduceAppUpdate(s, { type: "check-started" });
    expect(s.phase).toBe("checking");
    s = reduceAppUpdate(s, { type: "update-available", version: "3.8.0" });
    expect(s).toEqual({ phase: "available", version: "3.8.0" });
    s = reduceAppUpdate(s, { type: "download-started" });
    expect(s.phase).toBe("downloading");
    expect(shouldSkipUpdateCheck(s)).toBe(true);
    s = reduceAppUpdate(s, { type: "update-downloaded", version: "3.8.0" });
    expect(s.phase).toBe("ready");
    expect(railUpdateKind(s)).toBe("restart");
    expect(shouldSkipUpdateCheck(s)).toBe(true);
  });

  it("falls back to notice on check or download error", () => {
    let s = reduceAppUpdate(initialAppUpdateState(), { type: "check-started" });
    s = reduceAppUpdate(s, { type: "error" });
    expect(s.phase).toBe("failed");
    expect(shouldRunNoticeFallback(s)).toBe(true);
    expect(railUpdateKind(s)).toBe("notice");

    s = reduceAppUpdate(initialAppUpdateState(), { type: "update-available", version: "3.8.0" });
    s = reduceAppUpdate(s, { type: "download-started" });
    s = reduceAppUpdate(s, { type: "error" });
    expect(s.phase).toBe("failed");
    expect(shouldRunNoticeFallback(s)).toBe(true);
  });

  it("does not leave ready after a later check or error", () => {
    let s = reduceAppUpdate(initialAppUpdateState(), {
      type: "update-downloaded",
      version: "3.8.0",
    });
    s = reduceAppUpdate(s, { type: "check-started" });
    s = reduceAppUpdate(s, { type: "error" });
    s = reduceAppUpdate(s, { type: "update-not-available" });
    expect(s).toEqual({ phase: "ready", version: "3.8.0" });
  });

  it("returns to idle when already current", () => {
    let s = reduceAppUpdate(initialAppUpdateState(), { type: "check-started" });
    s = reduceAppUpdate(s, { type: "update-not-available" });
    expect(s).toEqual({ phase: "idle", version: null });
    expect(railUpdateKind(s)).toBe("hidden");
  });
});

function fakeUpdater(script?: {
  check?: () => Promise<unknown>;
  /**
   * Model `checkForUpdates()` resolving null -- electron-updater's documented
   * "the updater is disabled" answer, returned WITHOUT throwing. On Linux that
   * is an unset `process.env.APPIMAGE`: a cloud machine, or a desk user who
   * extracted the AppImage because their distro has no libfuse2. The fake
   * returned undefined for every call before this, which modelled that state
   * by accident and so could never assert anything about it.
   */
  declines?: boolean;
  quit?: () => void;
}): DesktopAutoUpdater & {
  feed: { provider: "generic"; url: string } | null;
  setFeedCalls: number;
  quitCalls: { isSilent?: boolean; isForceRunAfter?: boolean }[];
  listeners: Record<string, ((...args: unknown[]) => void)[]>;
  emit(event: string, ...args: unknown[]): void;
} {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    logger: null,
    feed: null,
    setFeedCalls: 0,
    quitCalls: [],
    listeners,
    setFeedURL(opts) {
      this.setFeedCalls += 1;
      this.feed = opts;
    },
    on(event, listener) {
      (listeners[event] ||= []).push(listener);
    },
    emit(event, ...args) {
      for (const l of listeners[event] || []) l(...args);
    },
    async checkForUpdates() {
      if (script?.check) return script.check();
      // An ACTIVE updater answers with a result object. Returning undefined
      // here would be the "disabled" answer, which is a different branch.
      return script?.declines ? null : { updateInfo: { version: "9.9.9" } };
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      this.quitCalls.push({ isSilent, isForceRunAfter });
      script?.quit?.();
    },
  };
}

describe("attachDesktopAutoUpdate", () => {
  // These two exist because of a Linux-only, unpackaged-only startup crash that
  // nothing here could see. `electron-updater` exports `autoUpdater` as a
  // GETTER that builds the platform updater on first read; on Linux that is
  // AppImageUpdater, whose constructor rejects the "0.0" version an unpackaged
  // app reports. So `updater: autoUpdater` at the call site threw during
  // startup — before this function could decide it did not want one. It took
  // running the desktop host in a container to find, because Windows and macOS
  // construct happily and ship packaged.
  //
  // Linux HAS a feed now, which moved the thing that saves us: it is the
  // unpackaged branch, not the missing-feed branch, that keeps the thunk
  // unresolved. The crash is Linux+unpackaged, so that is the case pinned here
  // — and it must stay pinned even though the feed no longer makes it moot.
  it("does not build the updater on unpackaged Linux — the constructor would throw", () => {
    let built = 0;
    const session = attachDesktopAutoUpdate({
      updater: () => { built += 1; return fakeUpdater({ async check() { return {}; } }); },
      platform: "linux",
      currentVersion: "0.0",
      packaged: false,
      ui: { postNotice: () => {}, postReady: () => {}, log: () => {}, fetchNotice: async () => null },
    });
    expect(built).toBe(0);
    expect(session.getState().phase).toBe("idle");
  });

  it("does not touch the injected updater on a platform that has no feed", () => {
    let built = 0;
    const session = attachDesktopAutoUpdate({
      updater: () => { built += 1; return fakeUpdater({ async check() { return {}; } }); },
      platform: "freebsd",
      currentVersion: "4.6.1",
      packaged: true,
      ui: { postNotice: () => {}, postReady: () => {}, log: () => {}, fetchNotice: async () => null },
    });
    expect(built).toBe(0);
    expect(session.getState().phase).toBe("idle");
  });

  it("points a packaged Linux build at the AppImage feed", async () => {
    const updater = fakeUpdater({
      async check() { updater.emit("update-not-available"); return {}; },
    });
    const session = attachDesktopAutoUpdate({
      updater: () => updater,
      platform: "linux",
      currentVersion: "4.6.1",
      packaged: true,
      ui: { postNotice: () => {}, postReady: () => {}, log: () => {}, fetchNotice: async () => null },
    });
    await session.check();
    expect(updater.setFeedCalls).toBe(1);
    expect(updater.feed).toEqual({ provider: "generic", url: "https://afkpilot.com/update/linux/" });
    expect(session.getState().phase).toBe("idle");
  });

  // The regression this exists to stop: the SAME structural property that keeps
  // a cloud machine off the feed also catches a desk user who extracted the
  // AppImage rather than running it -- the usual workaround on a distro with no
  // libfuse2. Before the Linux channel they got the phase-1 notice, because the
  // code went straight to the fallback when no feed existed. Once a feed exists
  // the check runs, resolves null WITHOUT throwing, and a catch-only fallback
  // would leave them silently on an old version for good.
  it("still notices an update when the updater declines to act", async () => {
    const notices: string[] = [];
    const updater = fakeUpdater({ declines: true });
    const session = attachDesktopAutoUpdate({
      updater: () => updater,
      platform: "linux",
      currentVersion: "4.6.1",
      packaged: true,
      ui: {
        postNotice: (version) => notices.push(version),
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => ({ version: "4.7.0", url: "https://afkpilot.com/desktop-update" }),
      },
    });
    await session.check();
    // It did configure the feed and did ask -- this is not the "no feed" path.
    expect(updater.setFeedCalls).toBe(1);
    // and it still told the user, exactly as 4.6.1 did.
    expect(notices).toEqual(["4.7.0"]);
  });

  it("builds the injected updater at most once, and only when it is used", async () => {
    let built = 0;
    const real = fakeUpdater({
      async check() { real.emit("update-not-available"); },
    });
    const session = attachDesktopAutoUpdate({
      updater: () => { built += 1; return real; },
      platform: "win32",
      currentVersion: "3.7.0",
      packaged: true,
      ui: { postNotice: () => {}, postReady: () => {}, log: () => {}, fetchNotice: async () => null },
    });
    expect(built).toBe(0);
    await session.check();
    await session.check();
    expect(built).toBe(1);
  });

  it("configures the Windows generic feed and posts ready after download", async () => {
    const updater = fakeUpdater({
      async check() {
        updater.emit("checking-for-update");
        updater.emit("update-available", { version: "3.8.0" });
        updater.emit("update-downloaded", { version: "3.8.0" });
      },
    });
    const notices: string[] = [];
    const ready: string[] = [];
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "win32",
      currentVersion: "3.7.0",
      packaged: true,
      ui: {
        postNotice: (v) => notices.push(v),
        postReady: (v) => ready.push(v),
        log: () => {},
        fetchNotice: async () => ({ version: "9.9.9", url: "https://x" }),
      },
    });
    await session.check();
    expect(updater.feed).toEqual({ provider: "generic", url: "https://afkpilot.com/update/win/" });
    expect(updater.setFeedCalls).toBe(1);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.forceDevUpdateConfig).toBeUndefined();
    expect(ready).toEqual(["3.8.0"]);
    expect(notices).toEqual([]);
    expect(session.getState().phase).toBe("ready");
  });

  it("falls back to the GitHub notice when check throws", async () => {
    const updater = fakeUpdater({
      async check() {
        throw new Error("offline");
      },
    });
    const notices: { version: string; url: string }[] = [];
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "darwin",
      currentVersion: "3.7.0",
      packaged: true,
      ui: {
        postNotice: (version, url) => notices.push({ version, url }),
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => ({ version: "3.8.0", url: "https://github.com/x" }),
      },
    });
    await session.check();
    expect(updater.feed).toEqual({ provider: "generic", url: "https://afkpilot.com/update/mac/" });
    expect(notices).toEqual([
      { version: "3.8.0", url: "https://afkpilot.com/desktop-update?from=3.7.0" },
    ]);
    expect(session.getState().phase).toBe("failed");
  });

  it("falls back to the notice when the updater emits error mid-download", async () => {
    const updater = fakeUpdater({
      async check() {
        updater.emit("update-available", { version: "3.8.0" });
        updater.emit("error", new Error("hash"));
        // An ACTIVE updater answers with a result even when the download it
        // started then failed; undefined here would mean "disabled" instead.
        return {};
      },
    });
    const notices: string[] = [];
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "win32",
      currentVersion: "3.7.0",
      packaged: true,
      ui: {
        postNotice: (v) => notices.push(v),
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => ({ version: "3.8.0", url: "https://x" }),
      },
    });
    await session.check();
    // error handler kicks fallbackNotice without awaiting it.
    await Promise.resolve();
    await Promise.resolve();
    expect(notices).toEqual(["3.8.0"]);
    expect(session.getState().phase).toBe("failed");
  });

  it("skips the updater when unpackaged and uses the notice path", async () => {
    const updater = fakeUpdater();
    const notices: string[] = [];
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "win32",
      currentVersion: "3.7.0",
      packaged: false,
      ui: {
        postNotice: (v) => notices.push(v),
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => ({ version: "3.8.0", url: "https://x" }),
      },
    });
    await session.check();
    expect(updater.setFeedCalls).toBe(0);
    expect(notices).toEqual(["3.8.0"]);
  });

  it("does not call setFeedURL in unpackaged forceDev so electron-updater reads dev-app-update.yml", async () => {
    const updater = fakeUpdater({
      async check() {
        updater.emit("update-not-available");
      },
    });
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "win32",
      currentVersion: "3.7.0",
      packaged: false,
      forceDev: true,
      ui: {
        postNotice: () => {},
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => null,
      },
    });
    await session.check();
    expect(updater.setFeedCalls).toBe(0);
    expect(updater.feed).toBeNull();
    expect(updater.forceDevUpdateConfig).toBe(true);
  });

  it("calls setFeedURL when packaged, even if forceDev is set", async () => {
    const updater = fakeUpdater({
      async check() {
        updater.emit("update-not-available");
      },
    });
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "darwin",
      currentVersion: "3.7.0",
      packaged: true,
      forceDev: true,
      ui: {
        postNotice: () => {},
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => null,
      },
    });
    await session.check();
    expect(updater.setFeedCalls).toBe(1);
    expect(updater.feed).toEqual({ provider: "generic", url: "https://afkpilot.com/update/mac/" });
    expect(updater.forceDevUpdateConfig).toBeUndefined();
  });

  it("install() calls quitAndInstall(true, true)", async () => {
    const updater = fakeUpdater({
      async check() {
        updater.emit("update-downloaded", { version: "3.8.0" });
      },
    });
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "win32",
      currentVersion: "3.7.0",
      packaged: true,
      ui: {
        postNotice: () => {},
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => null,
      },
    });
    await session.check();
    session.install();
    expect(updater.quitCalls).toEqual([{ isSilent: true, isForceRunAfter: true }]);
  });

  it("does not quitAndInstall until ready", () => {
    let quits = 0;
    const updater = fakeUpdater({ quit: () => { quits += 1; } });
    const session = attachDesktopAutoUpdate({
      updater,
      platform: "win32",
      currentVersion: "3.7.0",
      packaged: true,
      ui: {
        postNotice: () => {},
        postReady: () => {},
        log: () => {},
        fetchNotice: async () => null,
      },
    });
    session.install();
    expect(quits).toBe(0);
    expect(updater.quitCalls).toEqual([]);
  });
});

describe("app-update source gates", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("does not assign the no-op runtime verifyUpdateCodeSignature", () => {
    const src = fs.readFileSync(path.join(root, "src", "desktop", "app-update.ts"), "utf8");
    expect(src).not.toMatch(/verifyUpdateCodeSignature/);
    expect(src).toMatch(/quitAndInstall\(true, true\)/);
  });

  it("documents the relay feed service and unpackaged-only dev yml", () => {
    const spec = fs.readFileSync(path.join(root, "docs", "desktop-update-spec.md"), "utf8");
    expect(spec).toMatch(/### Feed service/);
    expect(spec).toMatch(/selected independently/i);
    expect(spec).toMatch(/10–15 min TTL|10-15 min TTL/);
    expect(spec).toMatch(/installers but no yml/);
    expect(spec).toMatch(/last three installer-bearing/);
    expect(spec).toMatch(/objects\.githubusercontent\.com/);
    expect(spec).toMatch(/trust boundary/);
    expect(spec).toMatch(/unpackaged only/i);
    expect(spec).toMatch(/packaged build never reads `dev-app-update\.yml`/i);
    expect(spec).toMatch(/win\.verifyUpdateCodeSignature: false/);
    expect(spec).toMatch(/NsisUpdater's setter ignores falsy/);
    expect(spec).toMatch(/-mac-arm64\.zip/);
    expect(spec).toMatch(/-mac-x64\.zip/);
    const desktop = fs.readFileSync(path.join(root, "docs", "desktop.md"), "utf8");
    expect(desktop).toMatch(/node_modules\/electron-updater/);
    expect(desktop).toMatch(/hoisted tree/);
  });
});
