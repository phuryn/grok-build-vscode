import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  shouldHideWindowOnClose,
  trayEnabled,
  trayIconSize,
  trayIsSupported,
  trayMenuTemplate,
  trayNoticeContent,
  trayTooltip,
  TRAY_CONFIG_FULL_KEY,
  TRAY_MENU_QUIT_LABEL,
  TRAY_MENU_SHOW_LABEL,
  TRAY_NOTICE_CONFIG_FULL_KEY,
} from "../src/desktop/tray";
import { CONFIG_DEFAULTS } from "../src/desktop/config-store";
import { INBOUND_DISPOSITION, allowFromRemote } from "../src/remote-policy";

/**
 * #174 — closing the desktop window quit the process.
 *
 * That made "get this off my screen" and "stop being reachable from my phone"
 * the same gesture, with only the destructive reading available. The tray
 * separates them. Everything here is about the ways that separation can go
 * wrong, because each one strands the person rather than merely annoying them.
 */
describe("tray support is a platform decision (#174)", () => {
  it.each<[NodeJS.Platform, boolean]>([
    ["win32", true],
    ["linux", true],
    // macOS is a gap, not a platform that needs nothing: main.ts quits on
    // `window-all-closed` with no darwin exception. Its answer is the dock
    // convention, which destroys the window instead of hiding it -- a
    // different mechanism, not a longer list here. See src/tray-support.ts.
    ["darwin", false],
  ])("%s → %s", (platform, supported) => {
    expect(trayIsSupported(platform)).toBe(supported);
  });

  it("is on unless explicitly turned off", () => {
    // Including for a config file written by a build that predates the key: an
    // absent value must read as on, or the feature ships off for everyone who
    // has ever launched the app before.
    for (const configured of [undefined, null, true, "yes", 1]) {
      expect(trayEnabled({ platform: "win32", configured })).toBe(true);
    }
    expect(trayEnabled({ platform: "win32", configured: false })).toBe(false);
  });

  it("stays off on a platform that has no tray, whatever the setting says", () => {
    expect(trayEnabled({ platform: "darwin", configured: true })).toBe(false);
  });
});

describe("closing the window (#174)", () => {
  const base = { platform: "win32" as NodeJS.Platform, quitting: false, trayPresent: true };

  it("hides instead of closing, which is the whole feature", () => {
    expect(shouldHideWindowOnClose(base)).toBe(true);
  });

  /**
   * The failure this guard prevents is the worst one available here: the app
   * cancels every close, so Quit does nothing and the only way out is Task
   * Manager. Every real exit — the tray's own Quit, the app menu, a Windows
   * session end, the updater's relaunch — arrives as `before-quit` and then a
   * window close.
   */
  it("lets a real quit through", () => {
    expect(shouldHideWindowOnClose({ ...base, quitting: true })).toBe(false);
  });

  /**
   * And the second-worst: the window vanishes and nothing can bring it back.
   * `new Tray()` throws on a Linux session with no StatusNotifier host, and the
   * notification area can be absent on Windows too. "Enabled" and "actually
   * there" are different questions and only the second one may hide a window.
   */
  it("does not hide when the icon failed to appear", () => {
    expect(shouldHideWindowOnClose({ ...base, trayPresent: false })).toBe(false);
  });

  it("closes normally when the person turned the tray off", () => {
    expect(shouldHideWindowOnClose({ ...base, configured: false })).toBe(false);
  });

  it("closes normally on macOS", () => {
    expect(shouldHideWindowOnClose({ ...base, platform: "darwin" })).toBe(false);
  });
});

describe("the tray's own surface (#174)", () => {
  it("offers a way back and a way out, and nothing else", () => {
    const clicks: string[] = [];
    const template = trayMenuTemplate({
      onShow: () => clicks.push("show"),
      onQuit: () => clicks.push("quit"),
    });
    const labels = template.map((item) => item.label).filter(Boolean);
    expect(labels).toEqual([TRAY_MENU_SHOW_LABEL, TRAY_MENU_QUIT_LABEL]);
    // Quit is the only exit once closing no longer quits, so it is not optional.
    for (const item of template) (item.click as (() => void) | undefined)?.();
    expect(clicks).toEqual(["show", "quit"]);
  });

  it("names the app on hover, because 'what is this icon' is the other half", () => {
    expect(trayTooltip()).toMatch(/\S/);
  });

  it("says both what happened and how to undo it", () => {
    const { title, body } = trayNoticeContent();
    expect(title).toMatch(/still running/i);
    // Where to go is the part that makes it an explanation rather than a nag.
    expect(body).toMatch(/tray/i);
    expect(body).toMatch(/quit/i);
    expect(body).toMatch(/settings/i);
  });

  it("asks for a status-bar sized icon, not the 512px app icon", () => {
    expect(trayIconSize("win32")).toEqual({ width: 16, height: 16 });
    expect(trayIconSize("linux")).toEqual({ width: 22, height: 22 });
  });
});

describe("how the tray setting is stored and reached (#174)", () => {
  it("defaults to on in the desktop config", () => {
    expect(CONFIG_DEFAULTS[TRAY_CONFIG_FULL_KEY]).toBe(true);
    expect(CONFIG_DEFAULTS[TRAY_NOTICE_CONFIG_FULL_KEY]).toBe(false);
  });

  /**
   * The tray belongs to the machine the window is on. A phone has no window
   * there to keep, and unlike the other General preferences this one is not
   * merely desk-owned — it is desk-only, so it is not promoted on a cloud
   * machine either (asserted in remote-policy.test.ts).
   */
  it("never travels from a remote", () => {
    expect(INBOUND_DISPOSITION.setDesktopTray).toBe("host-local");
    for (const tier of ["read-only", "propose", "full"] as const) {
      expect(allowFromRemote("setDesktopTray", tier)).toBe(false);
    }
  });

  /**
   * The near-miss this guards against, caught by `check:vsix` at packaging
   * time: `sidebar.ts` needs the platform rule to decide whether to offer the
   * row, and importing it from `src/desktop/` made `out/sidebar.js` require a
   * module `.vscodeignore` keeps out of the vsix. That installs fine and dies
   * on activation — the #101 class. The rule therefore lives one level up and
   * `src/desktop/tray.ts` re-exports it, which is easy to "tidy" back.
   */
  it("keeps the platform rule out of the desktop tree, with one definition", () => {
    const sidebarSrc = readFileSync(
      fileURLToPath(new URL("../src/sidebar.ts", import.meta.url)),
      "utf8",
    );
    expect(sidebarSrc).toContain('from "./tray-support"');
    expect(sidebarSrc).not.toContain('from "./desktop/tray"');
    // Re-exported, not restated: two copies is how a row appears on macOS.
    const traySrc = readFileSync(
      fileURLToPath(new URL("../src/desktop/tray.ts", import.meta.url)),
      "utf8",
    );
    expect(traySrc).toContain('from "../tray-support"');
    expect(traySrc).not.toMatch(/function trayIsSupported/);
  });

  /**
   * VS Code has no tray, so the key is deliberately absent from
   * `contributes.configuration` — a setting that does nothing is worse than no
   * setting. That absence is easy to "fix" by someone tidying the two lists
   * into agreement, so it is written down here.
   */
  it("is absent from package.json on purpose", () => {
    const pkg = readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    );
    expect(pkg).not.toContain(TRAY_CONFIG_FULL_KEY);
  });
});

/**
 * The wiring in main.ts cannot be unit-tested without spawning Electron, and
 * the decisions above are exactly the parts that were extracted so they could
 * be. What remains untestable is whether main.ts calls them — and the specific
 * way that goes wrong is a guard that is computed and then not consulted. So
 * the call sites are asserted against the source, in the same spirit as
 * `confirm-stacking.test.ts`.
 */
describe("main.ts actually consults the guards (#174)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/desktop/main.ts", import.meta.url)),
    "utf8",
  );

  it("decides the close with shouldHideWindowOnClose and nothing else", () => {
    const at = src.indexOf('mainWindow.on("close"');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, src.indexOf('mainWindow.on("closed"', at));
    expect(handler).toContain("shouldHideWindowOnClose(");
    expect(handler).toContain("quitting: appIsQuitting");
    expect(handler).toContain("trayPresent:");
    // preventDefault is what makes it a hide; without it the guard is decoration.
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain("hide()");
  });

  it("freezes the split layout on close only after the Files check approved it", () => {
    const at = src.indexOf('mainWindow.on("close"');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, at + 900);
    const guard = handler.indexOf("if (!desktopFilesCloseConfirmed()) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf("preserveSplit();"));
  });

  it("sets the quitting flag before anything else in before-quit", () => {
    const at = src.indexOf('app.on("before-quit"');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, at + 1200);
    expect(handler).toContain("appIsQuitting = true");
    // Ahead of the disposal work: a quit that arrives while the flag still says
    // false is a quit the close handler cancels.
    expect(handler.indexOf("appIsQuitting = true"))
      .toBeLessThan(handler.indexOf("sidebar?.dispose()"));
    expect(handler).toContain("destroyTray()");
  });

  /**
   * The gap `before-quit` does not cover, and the reason it is worth a test of
   * its own: Electron documents that event as NOT emitted on Windows for a
   * shutdown, restart or logout — which is the one platform where the tray is
   * on by default. Without a second setter, a person who closed the window to
   * the tray and then shut their machine down would find the shutdown held up
   * by an app they thought they had closed.
   *
   * It is invisible in review because the close handler reads correct: the bug
   * is in an event that never arrives.
   */
  it("also sets the quitting flag on the Windows session-end", () => {
    const at = src.indexOf('mainWindow.on("session-end"');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, src.indexOf('mainWindow.on("closed"', at));
    expect(handler).toContain("appIsQuitting = true");
    expect(handler).toContain("destroyTray()");
    // And it has to run before the close it precedes can be cancelled — which
    // is only true if the handler is registered at all, hence the assertion
    // above rather than a behavioural one. Nothing here may preventDefault:
    // refusing the session end is the bug, not the fix.
    expect(handler).not.toContain("preventDefault");
  });

  it("rebuilds the tray when the setting changes, rather than on next launch", () => {
    expect(src).toContain("affectsConfiguration(TRAY_CONFIG_FULL_KEY)");
    expect(src).toContain("syncTray()");
  });
});
