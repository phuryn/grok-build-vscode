import * as os from "node:os";
import * as path from "node:path";

export const WORKSPACE_GROK_HOME_SETTING = "grok.homeDirectory";
let activeHome: string | undefined;

/** Latched at VS Code activation; desktop hosts never configure this. */
export function workspaceGrokHome(): string | undefined { return activeHome; }

export function resolveWorkspaceGrokHome(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): { path?: string; warning?: string } {
  if (value === undefined || value === "" || typeof value === "string" && !value.trim()) return {};
  const invalid = { warning: `${WORKSPACE_GROK_HOME_SETTING} was ignored: use an absolute folder path (or ~/ followed by a path).` };
  if (typeof value !== "string" || value.includes("\0")) return invalid;
  let expanded = value.trim();
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (expanded === "~") expanded = home;
  else if (/^~[/\\]/.test(expanded)) expanded = paths.join(home, expanded.slice(2));
  if (!paths.isAbsolute(expanded)) return invalid;
  // win32.isAbsolute also accepts \folder and /folder, which depend on the
  // current drive and therefore cannot select an account unambiguously.
  if (platform === "win32" && !/^(?:[a-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/i.test(expanded)) return invalid;
  return { path: paths.normalize(expanded) };
}

interface WorkspaceHomeHost {
  read(): unknown;
  onChange(listener: (event: { affectsConfiguration(key: string): boolean }) => void): { dispose(): void };
  warn(message: string): unknown;
  prompt(message: string, action: string): PromiseLike<string | undefined>;
  reload(): unknown;
}

/** Apply before constructing the sidebar, so all existing GROK_HOME readers agree. */
export function configureWorkspaceGrokHome(
  host: WorkspaceHomeHost,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): { dispose(): void } {
  let lastValue = host.read();
  const resolved = resolveWorkspaceGrokHome(lastValue, platform, home);
  activeHome = resolved.path;
  if (activeHome) env.GROK_HOME = activeHome;
  if (resolved.warning) host.warn(resolved.warning);
  return host.onChange(async (event) => {
    if (!event.affectsConfiguration(WORKSPACE_GROK_HOME_SETTING)) return;
    const nextValue = host.read();
    if (nextValue === lastValue) return;
    lastValue = nextValue;
    const next = resolveWorkspaceGrokHome(nextValue, platform, home);
    if (next.warning) host.warn(next.warning);
    const choice = await host.prompt(
      "Reload this window to apply grok.homeDirectory. Grok keeps its current home until then.", "Reload Window",
    );
    if (choice === "Reload Window") host.reload();
  });
}
