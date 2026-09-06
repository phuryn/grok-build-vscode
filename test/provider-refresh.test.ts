/**
 * Settings → Providers must be able to tell the truth on demand.
 *
 * The page is derived from a persisted connection flag, a cached CLI path and
 * the last credential probe — none of which re-check themselves. `refreshProviders`
 * re-observes all three. What these guard is the difference between observing
 * and asserting: unlike `recheckConnection` it must never mark an account
 * connected, must not spawn a CLI for an account that was never connected, and
 * must never leave the button's spinner running after the probes are done.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { INBOUND_DISPOSITION, allowFromRemote } from "../src/remote-policy";

type AnySidebar = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function makeSidebar(connections: Record<string, boolean>): AnySidebar {
  const sidebar = Object.create(GrokSidebar.prototype) as AnySidebar;
  sidebar.providerConnectionState = { grok: false, codex: false, claude: false, ...connections };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.providerRefreshInFlight = false;
  sidebar.cliPath = "/cached/grok";
  sidebar.codexCliPath = "/cached/codex";
  sidebar.claudeCliPath = "/cached/claude";
  sidebar.testForceMissingGrokCli = false;
  sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: true, claude: true }));
  sidebar.connectedProviders = vi.fn(() =>
    (["grok", "codex", "claude"] as const).filter((id) => sidebar.providerConnectionState[id]));
  sidebar.reprobeProviderCredentials = vi.fn(async () => true);
  sidebar.setProviderConnected = vi.fn(async (id: string, on: boolean) => {
    sidebar.providerConnectionState = { ...sidebar.providerConnectionState, [id]: on };
  });
  sidebar.host = { appendLine: vi.fn() };
  sidebar.settingsEditor = undefined;
  sidebar.post = vi.fn();
  sidebar.postedChecking = [] as boolean[];
  sidebar.postProviderState = vi.fn(function (this: AnySidebar) {
    sidebar.postedChecking.push(sidebar.providerRefreshInFlight === true);
  });
  return sidebar;
}

const refresh = (sidebar: AnySidebar): Promise<void> =>
  (GrokSidebar.prototype as AnySidebar).refreshProviderStates.call(sidebar);

describe("Settings → Providers refresh", () => {
  it("probes every INSTALLED agent, not just the ones marked connected", async () => {
    // The reported bug: approve Grok in a browser, press Refresh, nothing
    // happens — because the stale flag said "not connected" so it was skipped.
    const sidebar = makeSidebar({ grok: false, codex: false, claude: false });
    await refresh(sidebar);
    const probed = sidebar.reprobeProviderCredentials.mock.calls.map(([id]: [string]) => id);
    expect(probed.sort()).toEqual(["claude", "codex", "grok"]);
  });

  it("skips an agent whose CLI is not installed — nothing to run", async () => {
    const sidebar = makeSidebar({ grok: true });
    sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: false }));
    await refresh(sidebar);
    const probed = sidebar.reprobeProviderCredentials.mock.calls.map(([id]: [string]) => id);
    expect(probed).toEqual(["grok"]);
  });

  it("promotes an agent that signed in elsewhere, once the probe proves it", async () => {
    const sidebar = makeSidebar({ grok: false, codex: false, claude: false });
    sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: false }));
    sidebar.reprobeProviderCredentials = vi.fn(async () => true);
    await refresh(sidebar);
    expect(sidebar.setProviderConnected).toHaveBeenCalledWith("grok", true);
  });

  it("a failed probe never invents a connection", async () => {
    const sidebar = makeSidebar({ grok: false, codex: false, claude: false });
    sidebar.reprobeProviderCredentials = vi.fn(async () => false);
    await refresh(sidebar);
    expect(sidebar.setProviderConnected).not.toHaveBeenCalled();
    expect(sidebar.providerConnectionState).toEqual({ grok: false, codex: false, claude: false });
  });

  it("does not re-persist an agent that was already connected", async () => {
    const sidebar = makeSidebar({ grok: true, codex: true, claude: true });
    sidebar.reprobeProviderCredentials = vi.fn(async () => true);
    await refresh(sidebar);
    expect(sidebar.setProviderConnected).not.toHaveBeenCalled();
  });

  it("drops the cached CLI paths so a newly installed CLI is found", async () => {
    const sidebar = makeSidebar({ grok: true });
    let pathsAtProbe: unknown[] = [];
    sidebar.reprobeProviderCredentials = vi.fn(async () => {
      pathsAtProbe = [sidebar.cliPath, sidebar.codexCliPath, sidebar.claudeCliPath];
      return true;
    });
    await refresh(sidebar);
    expect(pathsAtProbe).toEqual([undefined, undefined, undefined]);
  });

  it("leaves a test-forced missing Grok CLI alone", async () => {
    const sidebar = makeSidebar({ grok: true });
    sidebar.testForceMissingGrokCli = true;
    sidebar.cliPath = "/cached/grok";
    await refresh(sidebar);
    expect(sidebar.cliPath).toBe("/cached/grok");
  });

  it("reports checking while it works and idle once it is done", async () => {
    const sidebar = makeSidebar({ grok: true });
    // One installed CLI, so one probe to hold open and release deterministically.
    sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: false }));
    let release: (() => void) | undefined;
    sidebar.reprobeProviderCredentials = vi.fn(() => new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    }));
    const done = refresh(sidebar);
    expect(sidebar.providerRefreshInFlight).toBe(true);
    expect(sidebar.postedChecking).toEqual([true]);
    release!();
    await done;
    expect(sidebar.providerRefreshInFlight).toBe(false);
    // First frame says checking, last frame says it stopped.
    expect(sidebar.postedChecking[0]).toBe(true);
    expect(sidebar.postedChecking.at(-1)).toBe(false);
  });

  it("stops checking even when a probe rejects", async () => {
    const sidebar = makeSidebar({ grok: true, codex: true });
    sidebar.reprobeProviderCredentials = vi.fn(async () => { throw new Error("CLI exploded"); });
    await expect(refresh(sidebar)).resolves.toBeUndefined();
    expect(sidebar.providerRefreshInFlight).toBe(false);
    expect(sidebar.postedChecking.at(-1)).toBe(false);
  });

  it("ignores a second request while one is in flight", async () => {
    const sidebar = makeSidebar({ grok: true });
    sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: false }));
    let release: (() => void) | undefined;
    sidebar.reprobeProviderCredentials = vi.fn(() => new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    }));
    const first = refresh(sidebar);
    await refresh(sidebar);
    expect(sidebar.reprobeProviderCredentials).toHaveBeenCalledTimes(1);
    release!();
    await first;
  });

  it("carries checking on providerState, and omits it when idle", () => {
    const sidebar = makeSidebar({ grok: true });
    const idle = (GrokSidebar.prototype as AnySidebar).providerStateMessage.call(sidebar);
    expect(idle.checking).toBeUndefined();
    sidebar.providerRefreshInFlight = true;
    const busy = (GrokSidebar.prototype as AnySidebar).providerStateMessage.call(sidebar);
    expect(busy.checking).toBe(true);
  });

  it("reaches the VS Code settings tab, which sits outside post()", () => {
    const sidebar = makeSidebar({ grok: true });
    delete sidebar.postProviderState;
    const tabPosts: unknown[] = [];
    sidebar.settingsEditor = { webview: { postMessage: (msg: unknown) => { tabPosts.push(msg); } } };
    (GrokSidebar.prototype as AnySidebar).postProviderState.call(sidebar);
    expect(sidebar.post).toHaveBeenCalledTimes(1);
    expect(tabPosts).toHaveLength(1);
    expect((tabPosts[0] as { type: string }).type).toBe("providerState");
  });

  it("is host-local: a remote must not spawn the desk's CLIs", () => {
    expect(INBOUND_DISPOSITION.refreshProviders).toBe("host-local");
    for (const tier of ["read-only", "propose", "full"] as const) {
      expect(allowFromRemote("refreshProviders", tier)).toBe(false);
    }
  });
});

/**
 * Grok has no ACP session/delete — AcpClient.deleteSession throws for that
 * provider — so a credential probe that calls newSession() in the workspace
 * and then "best-effort" ACP-deletes leaves a summary-only shell in the
 * project catalog. Cleanup is a scratch cwd plus a filesystem delete after
 * the process exits.
 */
describe("Grok credential probe does not leave a project-catalog shell", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
    "utf8",
  );

  const reprobe = (() => {
    const start = src.indexOf("private async reprobeProviderCredentials(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  private ", start + 1);
    return src.slice(start, end);
  })();

  it("still opens a session — that is the credential observation", () => {
    expect(reprobe).toContain("await client.newSession()");
    expect(reprobe).toContain("this.setProviderNeedsLogin(\"grok\", false)");
  });

  it("does not call Grok ACP deleteSession, which always throws", () => {
    expect(reprobe).not.toContain("client.deleteSession");
  });

  it("probes in a scratch cwd so a leftover cannot land in the user's project", () => {
    expect(reprobe).toContain("mkdtempSync");
    expect(reprobe).toContain("grok-cred-probe-");
    expect(reprobe).toContain("cwd: scratch");
    expect(reprobe).not.toContain("cwd: this.workspaceRoot()");
  });

  it("deletes the session directory after the process exits", () => {
    const dispose = reprobe.indexOf("await client.dispose()");
    const remove = reprobe.indexOf("this.removeSessionFromDisk(probeId, scratch)");
    expect(dispose).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(dispose);
  });
});

describe("Refresh re-reads the CLI version", () => {
  // It used not to, and the comment saying so gave the reason: versions "do not
  // appear on this page". True when it was written; untrue since the CLI update
  // feature made the version the thing that decides whether an update is
  // offered. `probeCodexVersion` memoizes for the life of the host process, so
  // upgrading Codex in a terminal left the offer stuck on the number read at
  // boot — and on a cloud machine there is no window to reload, which made
  // Refresh the only door and it was the one documented not to open.
  const withVersionSpy = (sidebar: AnySidebar) => {
    const seen: { provider: string; memo: unknown }[] = [];
    sidebar.codexVersionProbe = Promise.resolve("0.152.1");
    sidebar.claudeVersionProbe = Promise.resolve("2.1.0");
    sidebar.probeProviderVersion = vi.fn(async (provider: string) => {
      seen.push({ provider, memo: sidebar[provider + "VersionProbe"] });
      return "9.9.9";
    });
    return seen;
  };

  it("re-probes Codex and Claude, with the stale memo already cleared", async () => {
    const sidebar = makeSidebar({ codex: true, claude: true });
    const seen = withVersionSpy(sidebar);
    await refresh(sidebar);
    expect(seen.map((s) => s.provider).sort()).toEqual(["claude", "codex"]);
    // Cleared BEFORE the fresh read, or the fresh read would return the memo.
    for (const s of seen) expect(s.memo, s.provider).toBeUndefined();
  });

  it("leaves Grok's version alone — it has its own update check", async () => {
    // And re-probing it would re-run the locator that refresh deliberately
    // does not touch when a test forces the CLI missing.
    const sidebar = makeSidebar({ grok: true });
    const seen = withVersionSpy(sidebar);
    sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: false }));
    await refresh(sidebar);
    expect(seen).toEqual([]);
  });
});
