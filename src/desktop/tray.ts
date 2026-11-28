/**
 * Desktop tray (pure).
 *
 * Built into a real Electron Tray in main.ts, in the same shape as
 * {@link ./app-menu} — the decisions live here so they can be unit-tested
 * without spawning Electron, and main.ts only does the Electron calls.
 *
 * WHY THERE IS A TRAY (#174). The desktop app is the thing that holds the
 * agent's sessions and, when the machine is linked, the remote uplink a phone
 * talks to. Closing the window quit the whole process, so "get this off my
 * screen" and "stop being reachable from my phone" were the same gesture, and
 * only the destructive reading was available. A tray separates them.
 *
 * WINDOWS AND LINUX ONLY, and macOS is a gap rather than a platform that
 * needs nothing — see `../tray-support`, which owns the rule and the reason.
 * In short: this app quits on `window-all-closed` everywhere, so a Mac window
 * close still ends it, and the macOS answer is the dock rather than a menu-bar
 * item.
 */
import type { MenuItemConstructorOptions } from "electron";
import { DESKTOP_APP_NAME } from "./host-dialogs";

/** Config key, relative to the `grok` section (full: `grok.desktop.tray`). */
export const TRAY_CONFIG_KEY = "desktop.tray";
export const TRAY_CONFIG_FULL_KEY = "grok." + TRAY_CONFIG_KEY;

/**
 * Whether the person has already been told that closing leaves the app
 * running. One-shot, and persisted rather than per-run: told every launch it
 * is nagging, told once it is an explanation.
 */
export const TRAY_NOTICE_CONFIG_KEY = "desktop.trayNoticeShown";
export const TRAY_NOTICE_CONFIG_FULL_KEY = "grok." + TRAY_NOTICE_CONFIG_KEY;

/**
 * Platforms where a tray icon is the right answer — see the file comment.
 *
 * Defined one level up and re-exported here: `sidebar.ts` needs the same rule
 * to decide whether to offer the settings row, and it cannot import out of
 * `out/desktop/` without that module being packed into the VS Code vsix. See
 * `../tray-support` for the whole story.
 */
export { trayIsSupported } from "../tray-support";
import { trayIsSupported } from "../tray-support";

/**
 * On by default, which is the point of the feature: a person who closes the
 * window expecting the phone to keep working should not have had to find a
 * setting first. Anything but an explicit `false` is on, so a config file
 * written by an older build (where the key does not exist) gets the new
 * behaviour rather than an accidental opt-out.
 */
export function trayEnabled(opts: {
  platform: NodeJS.Platform;
  configured?: unknown;
}): boolean {
  if (!trayIsSupported(opts.platform)) return false;
  return opts.configured !== false;
}

/**
 * Whether a window close should hide to the tray instead of closing.
 *
 * `quitting` is the one that matters and is easy to forget: Quit from the tray
 * menu, the app menu and the auto-updater's relaunch all arrive as
 * `before-quit` followed by a window close. Without this the close would be
 * cancelled and the app would refuse to exit — a process the person can only
 * kill from Task Manager, which is a far worse bug than the one the tray fixes.
 *
 * A Windows shutdown, restart or logout does NOT arrive that way: Electron
 * documents `before-quit` as not emitted for it. The caller must therefore set
 * `quitting` from the window's Windows-only `session-end` event as well — miss
 * that and closing to the tray leaves the app holding up the machine's
 * shutdown, on the one platform where the tray is on by default.
 *
 * `trayPresent` is the other one, and it is not the same question as
 * `trayEnabled`. Constructing a Tray throws on a Linux session with no
 * StatusNotifier host, and there are Windows configurations that hide the
 * notification area entirely. Hiding a window when nothing can bring it back
 * is the invisible-app trap: the app is running, reachable from the phone, and
 * unreachable from the desk it is running on. So the hide is conditional on the
 * icon actually existing, and a failed tray simply means closing quits, which
 * is what the app did before any of this.
 */
export function shouldHideWindowOnClose(opts: {
  platform: NodeJS.Platform;
  configured?: unknown;
  quitting: boolean;
  trayPresent: boolean;
}): boolean {
  if (opts.quitting) return false;
  if (!opts.trayPresent) return false;
  return trayEnabled(opts);
}

/** Shown once, the first time a close is turned into a hide. */
export function trayNoticeContent(): { title: string; body: string } {
  return {
    title: `${DESKTOP_APP_NAME} is still running`,
    body: "It stays in the tray so your agent and any linked phone keep working. "
      + "Quit from the tray icon to stop it, or turn this off in Settings → General.",
  };
}

/** Hover text on the icon itself — the other half of "where did it go?". */
export function trayTooltip(): string {
  return DESKTOP_APP_NAME;
}

export const TRAY_MENU_SHOW_LABEL = "Open";
export const TRAY_MENU_QUIT_LABEL = "Quit";

/**
 * Two items and no more. Everything else this app can do needs the window, so
 * a tray menu that offered it would just be a slower way to open the window.
 */
export function trayMenuTemplate(handlers: {
  onShow: () => void;
  onQuit: () => void;
}): MenuItemConstructorOptions[] {
  return [
    { label: TRAY_MENU_SHOW_LABEL, click: handlers.onShow },
    { type: "separator" },
    // The only way out of the app once closing no longer quits. It must stay
    // in this menu even if the menu ever grows.
    { label: TRAY_MENU_QUIT_LABEL, click: handlers.onQuit },
  ];
}

/**
 * Tray icons are drawn at status-bar size, not app-icon size. Handing Electron
 * the 512px app PNG gives Windows a smeared downscale and some Linux panels a
 * 512px-tall row. 16px is the Windows notification-area size; Linux panels
 * conventionally ask for 22.
 */
export function trayIconSize(platform: NodeJS.Platform): { width: number; height: number } {
  const px = platform === "linux" ? 22 : 16;
  return { width: px, height: px };
}
