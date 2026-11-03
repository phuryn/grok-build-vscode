import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { configureWorkspaceGrokHome, resolveWorkspaceGrokHome, workspaceGrokHome } from "../src/workspace-grok-home";
import { buildGrokAgentArgs, grokBackend } from "../src/grok-backend";
import { resolveGrokHome } from "../src/sessions";
import { globalConfigPath } from "../src/grok-config";
import { GrokSidebar } from "../src/sidebar";

function fixture(initial: unknown = "", env: NodeJS.ProcessEnv = {}) {
  let value = initial;
  let listener: (event: { affectsConfiguration(key: string): boolean }) => unknown;
  const dispose = vi.fn();
  const host = {
    read: () => value,
    onChange: (callback: typeof listener) => { listener = callback; return { dispose }; },
    warn: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined), reload: vi.fn(),
  };
  const subscription = configureWorkspaceGrokHome(host, env, "linux", "/users/james");
  return { host, env, subscription, dispose, change: async (next: unknown, affected = "grok.homeDirectory") => {
    value = next;
    await listener!({ affectsConfiguration: (key) => key === affected });
  } };
}

afterEach(() => { fixture(); vi.unstubAllEnvs(); });

describe("workspace Grok home paths", () => {
  it.each([undefined, "", "  "])("leaves an unset value alone (%s)", (value) => {
    expect(resolveWorkspaceGrokHome(value)).toEqual({});
  });
  it.each([
    ["/accounts/james", "linux", "/users/james", "/accounts/james"],
    ["~/work-account", "darwin", "/Users/james", "/Users/james/work-account"],
    ["~", "linux", "/users/james", "/users/james"],
    ["C:\\accounts\\james", "win32", "C:\\Users\\james", "C:\\accounts\\james"],
    ["~\\work-account", "win32", "C:\\Users\\james", "C:\\Users\\james\\work-account"],
    ["~/work-account", "win32", "C:\\Users\\james", "C:\\Users\\james\\work-account"],
    ["\\\\server\\accounts\\james", "win32", "C:\\Users\\james", "\\\\server\\accounts\\james"],
    ["/accounts/../james account", "linux", "/users/james", "/james account"],
  ])("resolves %s on %s", (value, platform, home, expected) => {
    expect(resolveWorkspaceGrokHome(value, platform as NodeJS.Platform, home)).toEqual({ path: expected });
  });
  it.each([
    ["relative/account", "linux"], ["./account", "darwin"], ["~someone/account", "linux"],
    ["$HOME/account", "linux"], ["C:account", "win32"], ["\\account", "win32"],
    ["/account", "win32"], ["%USERPROFILE%\\account", "win32"], ["/bad\0path", "linux"],
    [42, "linux"], [null, "linux"],
  ])("rejects %s on %s", (value, platform) => {
    expect(resolveWorkspaceGrokHome(value, platform as NodeJS.Platform)).toEqual({ warning: expect.stringContaining("absolute") });
  });
});

describe("application and reload", () => {
  it.each(["/accounts/chosen", ""])("keeps workspace account selection authoritative over .env (%s)", (setting) => {
    fixture(setting);
    vi.stubEnv("GROK_SHELL", "powershell");
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.readDotEnv = () => ({ GROK_HOME: "/from-dotenv", OTHER: "retained" });
    sidebar.host = { appendLine: vi.fn() };
    const env = sidebar.buildEnv("/repo");
    expect(env.GROK_HOME).toBe(setting || "/from-dotenv");
    expect(env.OTHER).toBe("retained");
  });
  it("sets the shared environment before existing home and config readers run", () => {
    const { env } = fixture("~/account", { GROK_HOME: "/inherited" });
    expect(env.GROK_HOME).toBe("/users/james/account");
    expect(resolveGrokHome(env)).toBe(env.GROK_HOME);
    expect(globalConfigPath(env)).toMatch(/account[/\\]config.toml$/);
    expect(workspaceGrokHome()).toBe(env.GROK_HOME);
    const spawn = grokBackend.spawn({ cliPath: "grok", cwd: "/repo", env, effort: "low" });
    expect(spawn.env.GROK_HOME).toBe(env.GROK_HOME);
    expect(spawn.args).toEqual(["agent", "--no-leader", "--reasoning-effort", "low", "stdio"]);
  });
  it.each(["", "relative"])("preserves inherited GROK_HOME for ignored %s", (value) => {
    const { env, host } = fixture(value, { GROK_HOME: "/inherited" });
    expect(env.GROK_HOME).toBe("/inherited");
    expect(workspaceGrokHome()).toBeUndefined();
    expect(host.warn).toHaveBeenCalledTimes(value ? 1 : 0);
    expect(grokBackend.spawn({ cliPath: "grok", cwd: "/repo", env }).args).toEqual(["agent", "stdio"]);
  });
  it("leaves the default home and leader arguments alone when unset", () => {
    const { env } = fixture();
    expect(env).toEqual({});
    expect(buildGrokAgentArgs("high")).toEqual(["agent", "--reasoning-effort", "high", "stdio"]);
  });
  it("offers reload without switching either the environment or launch policy live", async () => {
    const f = fixture("/accounts/first");
    await f.change("/accounts/second");
    expect(f.host.prompt).toHaveBeenCalledWith(expect.stringContaining("Reload"), "Reload Window");
    expect(f.env.GROK_HOME).toBe("/accounts/first");
    expect(workspaceGrokHome()).toBe("/accounts/first");
    expect(f.host.reload).not.toHaveBeenCalled();
  });
  it("reloads only when the person selects Reload Window", async () => {
    const f = fixture("/accounts/first");
    f.host.prompt.mockResolvedValue("Reload Window");
    await f.change("/accounts/second");
    expect(f.host.reload).toHaveBeenCalledOnce();
    expect(f.env.GROK_HOME).toBe("/accounts/first");
  });
  it("prompts when the override is removed and retains it until reload", async () => {
    const f = fixture("/accounts/first");
    await f.change("");
    expect(f.host.prompt).toHaveBeenCalledOnce();
    expect(f.env.GROK_HOME).toBe("/accounts/first");
  });
  it("warns about an invalid change and leaves the active home intact", async () => {
    const f = fixture("/accounts/first");
    await f.change("relative");
    expect(f.host.warn).toHaveBeenCalledWith(expect.stringContaining("ignored"));
    expect(f.env.GROK_HOME).toBe("/accounts/first");
  });
  it("ignores unrelated and unchanged configuration events and disposes the listener", async () => {
    const f = fixture("/accounts/first");
    await f.change("/accounts/first", "grok.defaultModel");
    await f.change("/accounts/first");
    expect(f.host.prompt).not.toHaveBeenCalled();
    f.subscription.dispose();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("applies before sidebar construction and retains Restricted Mode defaults", () => {
    const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
    const activate = source.slice(source.indexOf("export function activate"));
    expect(activate.indexOf("configureWorkspaceGrokHome(")).toBeLessThan(activate.indexOf("new GrokSidebar("));
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.capabilities?.untrustedWorkspaces).toBeUndefined();
    const setting = manifest.contributes.configuration.properties["grok.homeDirectory"];
    expect(setting.scope).toBe("window");
    expect(setting.description).toContain("disabled in untrusted workspaces");
  });
});
