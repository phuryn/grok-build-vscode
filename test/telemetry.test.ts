import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as telemetry from "../src/telemetry";
import {
  aptabaseHost,
  osNameFromPlatform,
  shouldSendTelemetry,
  buildSessionStartEvent,
  buildRemotePortalOpenedEvent,
  buildSessionRemoteStartedEvent,
  nextTelemetrySession,
  TELEMETRY_SESSION_INACTIVITY_MS,
  REMOTE_PORTAL_OPENED_ALLOWED_KEYS,
  SESSION_REMOTE_STARTED_ALLOWED_KEYS,
  sanitizeSessionStartProps,
  sessionStartHostKind,
  sessionStartSurface,
  telemetryStringLooksSensitive,
  SESSION_START_ALLOWED_KEYS,
  postEvent,
  APTABASE_APP_KEY_PROD,
  APTABASE_APP_KEY_DEV,
  OFFICIAL_EXTENSION_ID,
  type SessionStartPropKey,
  type SessionStartProps,
} from "../src/telemetry";
import { DESKTOP_APP_SHORT_NAME } from "../src/desktop/host-dialogs";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { normalizeRepoPath } from "../src/sessions";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";

beforeEach(() => {
  // Existing builder spies call through: keep deferred posts off the network.
  vi.useFakeTimers({ toFake: ["Date", "setImmediate"] });
  vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const REQUIRED: SessionStartProps = {
  installId: "i",
  mode: "agent",
  model: "m",
  effort: "",
  showThinking: false,
  expandToolDetails: false,
  steerByDefault: false,
  chatFontScale: 100,
  readRepliesAloud: false,
  soundNotifications: false,
  sessionOrigin: "local",
  clientDevice: "desktop",
  hostKind: "vscode",
  appPurpose: "knowledge",
  voiceConfigured: false,
  voiceStreaming: true,
  voiceLanguageSet: false,
  grokConnected: true,
  codexConnected: false,
  claudeConnected: false,
};

describe("aptabaseHost — region from app key", () => {
  it("resolves EU and US keys to their ingest hosts", () => {
    expect(aptabaseHost("A-EU-5074036690")).toBe("https://eu.aptabase.com");
    expect(aptabaseHost("A-US-1234567890")).toBe("https://us.aptabase.com");
  });
  it("returns undefined (sending disabled) for self-hosted or malformed keys", () => {
    expect(aptabaseHost("A-DEV-0000000000")).toBeUndefined();
    expect(aptabaseHost("nonsense")).toBeUndefined();
  });
});

describe("postEvent never throws (telemetry can't impact the user)", () => {
  it("swallows a build/serialize failure instead of throwing", () => {
    // A circular event fails JSON.stringify *before* any network call, so this
    // exercises the try/catch with zero network — proving a malformed event can
    // never bubble into the caller's turn.
    const circular: any = { eventName: "session_start" };
    circular.self = circular;
    expect(() => postEvent(APTABASE_APP_KEY_PROD, circular)).not.toThrow();
  });
  it("is a no-op for an app key with no resolvable region (no network, no throw)", () => {
    const ev = buildSessionStartEvent(
      REQUIRED,
      { appVersion: "1", osName: "macOS", osVersion: "1", locale: "en", isDebug: true },
      "s",
      "2026-06-29T00:00:00.000Z",
    );
    expect(() => postEvent("A-DEV-0000000000", ev)).not.toThrow();
  });
});

describe("prod vs dev app keys", () => {
  it("are distinct EU projects (so probe traffic can't land in prod)", () => {
    expect(APTABASE_APP_KEY_PROD).not.toBe(APTABASE_APP_KEY_DEV);
    expect(aptabaseHost(APTABASE_APP_KEY_PROD)).toBe("https://eu.aptabase.com");
    expect(aptabaseHost(APTABASE_APP_KEY_DEV)).toBe("https://eu.aptabase.com");
  });
});

describe("osNameFromPlatform", () => {
  it("maps Node platforms to human OS names, passing through the unknown", () => {
    expect(osNameFromPlatform("darwin")).toBe("macOS");
    expect(osNameFromPlatform("win32")).toBe("Windows");
    expect(osNameFromPlatform("linux")).toBe("Linux");
    expect(osNameFromPlatform("freebsd")).toBe("freebsd");
  });
});

describe("shouldSendTelemetry — all gates must allow", () => {
  it("only sends when global setting AND our opt-in AND official build are all on", () => {
    expect(shouldSendTelemetry(true, true, true)).toBe(true);
    expect(shouldSendTelemetry(false, true, true)).toBe(false); // VS Code global off wins
    expect(shouldSendTelemetry(true, false, true)).toBe(false); // our opt-out
    expect(shouldSendTelemetry(true, true, false)).toBe(false); // a fork build never reports
    expect(shouldSendTelemetry(false, false, false)).toBe(false);
  });
});

describe("sessionStartSurface", () => {
  it("classifies local as desktop and splits remote touch from desktop browsers", () => {
    expect(sessionStartSurface("local", true)).toEqual({
      sessionOrigin: "local",
      clientDevice: "desktop",
    });
    expect(sessionStartSurface("remote", false)).toEqual({
      sessionOrigin: "remote",
      clientDevice: "desktop",
    });
    expect(sessionStartSurface("remote", true)).toEqual({
      sessionOrigin: "remote",
      clientDevice: "mobile",
    });
  });
});

describe("sessionStartHostKind", () => {
  it("is desktop only for the standalone app; every editor host is vscode", () => {
    expect(sessionStartHostKind(true)).toBe("desktop");
    expect(sessionStartHostKind(false)).toBe("vscode");
  });
  it.each([true, false])("cloud wins for desktop=%s; off-cloud classification is unchanged", (desktop) => {
    expect(sessionStartHostKind(desktop, true)).toBe("sprite");
    expect(sessionStartHostKind(desktop, false)).toBe(desktop ? "desktop" : "vscode");
  });
});

describe("buildSessionStartEvent", () => {
  const sys = {
    appVersion: "1.4.24",
    osName: "macOS",
    osVersion: "23.6.0",
    locale: "en",
    isDebug: false,
  };
  const props: SessionStartProps = {
    ...REQUIRED,
    installId: "abc-123",
    mode: "yolo",
    model: "grok-build",
    effort: "high",
  };
  const ev = buildSessionStartEvent(props, sys, "sess-1", "2026-06-29T00:00:00.000Z");

  it("emits a single session_start with the supplied id + timestamp", () => {
    expect(ev.eventName).toBe("session_start");
    expect(ev.sessionId).toBe("sess-1");
    expect(ev.timestamp).toBe("2026-06-29T00:00:00.000Z");
  });

  it("carries the install id + mode/model/effort as props (no content)", () => {
    expect(ev.props).toEqual({
      installId: "abc-123",
      mode: "yolo",
      model: "grok-build",
      effort: "high",
      showThinking: false,
      expandToolDetails: false,
      steerByDefault: false,
      chatFontScale: 100,
      readRepliesAloud: false,
      soundNotifications: false,
      sessionOrigin: "local",
      clientDevice: "desktop",
      hostKind: "vscode",
      appPurpose: "knowledge",
      voiceConfigured: false,
      voiceStreaming: true,
      voiceLanguageSet: false,
      grokConnected: true,
      codexConnected: false,
      claudeConnected: false,
    });
  });

  it("reports system props incl. a versioned sdk label", () => {
    expect(ev.systemProps.osName).toBe("macOS");
    expect(ev.systemProps.appVersion).toBe("1.4.24");
    expect(ev.systemProps.sdkVersion).toBe("grok-vscode-phuryn@1.4.24");
    expect(ev.systemProps.isDebug).toBe(false);
  });
});

// Webview configuration + the host app ride session_start so we can see
// which defaults people keep and which VS Code fork they're on (the extension
// behaves differently across Cursor / Antigravity). Config values and an app
// name — the same class of anonymous property as mode/model/effort, never content.
describe("session_start — feature flags + host (analytics)", () => {
  const sys = { appVersion: "1", osName: "Windows", osVersion: "10", locale: "en", isDebug: false };
  const base: SessionStartProps = {
    ...REQUIRED,
    model: "grok-4.5",
    effort: "high",
    chatFontScale: 125,
    readRepliesAloud: true,
    soundNotifications: true,
  };

  it("carries the three flags and the host name", () => {
    const ev = buildSessionStartEvent(
      { ...base, showThinking: true, expandToolDetails: false, steerByDefault: true, host: "Cursor" },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(ev.props).toMatchObject({
      showThinking: true,
      expandToolDetails: false,
      steerByDefault: true,
      chatFontScale: 125,
      readRepliesAloud: true,
      soundNotifications: true,
      sessionOrigin: "local",
      clientDevice: "desktop",
      host: "Cursor",
      hostKind: "vscode",
    });
  });

  it("includes reported AFK Pilot preferences without replacing the local values", () => {
    const ev = buildSessionStartEvent(
      {
        ...base,
        showThinking: false,
        expandToolDetails: true,
        steerByDefault: false,
        remoteFontScale: 140,
        remoteReadRepliesAloud: false,
        sessionOrigin: "remote",
        clientDevice: "mobile",
      },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(ev.props).toMatchObject({
      chatFontScale: 125,
      readRepliesAloud: true,
      remoteFontScale: 140,
      remoteReadRepliesAloud: false,
      sessionOrigin: "remote",
      clientDevice: "mobile",
      expandToolDetails: true,
    });
  });

  it("omits host entirely when the app doesn't report one — never sends a blank", () => {
    const ev = buildSessionStartEvent(
      { ...base, showThinking: false, expandToolDetails: false, steerByDefault: false },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect("host" in ev.props).toBe(false);
  });

  it("sends false as false — a flag left at its default is a real data point", () => {
    const ev = buildSessionStartEvent(
      {
        ...base,
        showThinking: false,
        expandToolDetails: false,
        steerByDefault: false,
        remoteFontScale: 140,
        remoteReadRepliesAloud: false,
        host: "Visual Studio Code",
      },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(ev.props.showThinking).toBe(false);
    expect(ev.props.steerByDefault).toBe(false);
    expect(ev.props.remoteFontScale).toBe(140);
    expect(ev.props.remoteReadRepliesAloud).toBe(false);
    // Still no content, ever — only the anonymous install id and config values.
    // Optional fields ride the same closed set when they are present.
    const withAll: SessionStartProps = {
      ...base,
      showThinking: false,
      expandToolDetails: false,
      steerByDefault: false,
      remoteFontScale: 140,
      remoteReadRepliesAloud: false,
      host: "Visual Studio Code",
      provider: "grok",
      connectorCount: 0,
      worktree: false,
      returningInstall: true,
    };
    const full = buildSessionStartEvent(
      withAll, sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(Object.keys(full.props).sort()).toEqual([...SESSION_START_ALLOWED_KEYS].sort());
  });

  it("pins the closed property set the builder is allowed to emit", () => {
    expect([...SESSION_START_ALLOWED_KEYS]).toEqual([
      "installId",
      "mode",
      "model",
      "effort",
      "showThinking",
      "expandToolDetails",
      "steerByDefault",
      "chatFontScale",
      "readRepliesAloud",
      "soundNotifications",
      "sessionOrigin",
      "clientDevice",
      "remoteFontScale",
      "remoteReadRepliesAloud",
      "host",
      "hostKind",
      "appPurpose",
      "voiceConfigured",
      "voiceStreaming",
      "voiceLanguageSet",
      "grokConnected",
      "codexConnected",
      "claudeConnected",
      "provider",
      "connectorCount",
      "worktree",
      "returningInstall",
    ]);
  });
});

describe("the three hosts are distinguishable in analytics", () => {
  // Grok Build Desktop reports through the SAME shared send path as the
  // extension (sidebar.ts → host.appName → `host`), and its extensionId
  // resolves to the official publisher.name, so the fork gate lets it through.
  // What identifies it is this property — without it, desktop sessions would be
  // indistinguishable from VS Code ones in the same project.
  const props = (host?: string, hostKind: SessionStartProps["hostKind"] = "vscode"): SessionStartProps => ({
    ...REQUIRED,
    installId: "i-1",
    model: "grok-build",
    effort: "high",
    hostKind,
    ...(host ? { host } : {}),
  });
  const sys = {
    appVersion: "3.1.0",
    osName: "Windows",
    osVersion: "10.0.26200",
    locale: "en",
    isDebug: false,
  };

  it("tags desktop sessions with Grok Build Desktop and hostKind desktop", () => {
    const ev = buildSessionStartEvent(
      props(DESKTOP_APP_SHORT_NAME, "desktop"), sys, "s-1", "2026-08-07T00:00:00.000Z",
    );
    expect(ev.props.host).toBe("Grok Build Desktop");
    expect(ev.props.hostKind).toBe("desktop");
  });

  it("keeps the editor's own name for the extension, and omits it when unknown", () => {
    const code = buildSessionStartEvent(
      props("Visual Studio Code"), sys, "s-2", "2026-08-07T00:00:00.000Z",
    );
    expect(code.props.host).toBe("Visual Studio Code");
    expect(code.props.hostKind).toBe("vscode");
    // Absent host is unknown, not blank — an empty string would look like a
    // fourth product in the dashboard.
    const unknown = buildSessionStartEvent(
      props(), sys, "s-3", "2026-08-07T00:00:00.000Z",
    );
    expect("host" in unknown.props).toBe(false);
  });
});

describe("sanitizeSessionStartProps — allowlist, no paths, no free text", () => {
  it("drops unknown keys instead of copying the input through", () => {
    const out = sanitizeSessionStartProps({
      ...REQUIRED,
      prompt: "fix the login in src/app.ts",
      workspace: "C:\\Users\\me\\project",
      grokCliPath: "/usr/local/bin/grok",
      extra: true,
    });
    expect(out.prompt).toBeUndefined();
    expect(out.workspace).toBeUndefined();
    expect(out.grokCliPath).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(Object.keys(out).every((k) => (SESSION_START_ALLOWED_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it("rejects path-like and free-text values on every string field", () => {
    const dirty = {
      installId: "C:\\Users\\me\\AppData\\grok",
      mode: "please delete /tmp/secret",
      model: "C:\\Program Files\\grok\\grok.exe",
      effort: "/home/user/.grok",
      host: "/Users/me/projects/grok-build-vscode",
      hostKind: "desktop/../etc",
      appPurpose: "coding for /var/data",
      sessionOrigin: "remote\\share",
      clientDevice: "desktop browser at C:",
      showThinking: false,
      expandToolDetails: false,
      steerByDefault: false,
      chatFontScale: 100,
      readRepliesAloud: false,
      soundNotifications: false,
      voiceConfigured: true,
      voiceStreaming: true,
      voiceLanguageSet: true,
      grokConnected: true,
      codexConnected: false,
      claudeConnected: false,
    };
    const out = sanitizeSessionStartProps(dirty);
    expect(out).toEqual({
      showThinking: false,
      expandToolDetails: false,
      steerByDefault: false,
      chatFontScale: 100,
      readRepliesAloud: false,
      soundNotifications: false,
      voiceConfigured: true,
      voiceStreaming: true,
      voiceLanguageSet: true,
      grokConnected: true,
      codexConnected: false,
      claudeConnected: false,
    });
    for (const value of Object.values(out)) {
      if (typeof value === "string") {
        expect(telemetryStringLooksSensitive(value)).toBe(false);
      }
    }
  });

  it("never lets a path-like value survive buildSessionStartEvent", () => {
    const ev = buildSessionStartEvent(
      {
        ...REQUIRED,
        model: "../../../../etc/passwd",
        installId: "\\\\server\\share\\id",
        host: "D:\\workspace\\my-app",
        mode: "agent",
      } as SessionStartProps,
      { appVersion: "1", osName: "Windows", osVersion: "10", locale: "en", isDebug: true },
      "s",
      "2026-08-13T00:00:00.000Z",
    );
    expect(ev.props.model).toBeUndefined();
    expect(ev.props.installId).toBeUndefined();
    expect(ev.props.host).toBeUndefined();
    expect(ev.props.mode).toBe("agent");
    for (const value of Object.values(ev.props)) {
      if (typeof value === "string") {
        expect(telemetryStringLooksSensitive(value)).toBe(false);
      }
    }
  });

  it("accepts picker model ids and drops sentences / custom paths", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "grok-4.5" }).model).toBe("grok-4.5");
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "gpt-5.6-sol" }).model).toBe("gpt-5.6-sol");
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "" }).model).toBe("");
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "please rewrite README.md" }).model).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "openai/gpt-5" }).model).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, effort: "max" }).effort).toBe("max");
    expect(sanitizeSessionStartProps({ ...REQUIRED, effort: "ultra" }).effort).toBe("ultra");
    expect(sanitizeSessionStartProps({ ...REQUIRED, effort: "ludicrous" }).effort).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, mode: "auto-accept" }).mode).toBeUndefined();
  });

  it("forwards previously-dropped host product names and still drops sensitive ones", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, host: "Antigravity IDE" }).host).toBe("Antigravity IDE");
    expect(sanitizeSessionStartProps({ ...REQUIRED, host: "code-server" }).host).toBe("code-server");
    expect(sanitizeSessionStartProps({ ...REQUIRED, host: "Kiro" }).host).toBe("Kiro");
    expect(sanitizeSessionStartProps({ ...REQUIRED, host: "VS Code Web" }).host).toBe("VS Code Web");
    expect(sanitizeSessionStartProps({ ...REQUIRED, host: "My Custom Fork 9000" }).host).toBe("My Custom Fork 9000");
    expect(sanitizeSessionStartProps({ ...REQUIRED, host: "Visual Studio Code - Insiders" }).host)
      .toBe("Visual Studio Code - Insiders");
    expect("host" in sanitizeSessionStartProps({ ...REQUIRED, host: "C:\\Users\\me\\AppData" })).toBe(false);
    expect("host" in sanitizeSessionStartProps({ ...REQUIRED, host: "/home/user/.ssh/id_rsa" })).toBe(false);
    expect("host" in sanitizeSessionStartProps({ ...REQUIRED, host: "please rewrite README.md" })).toBe(false);
    expect("host" in sanitizeSessionStartProps({ ...REQUIRED, host: "https://evil.example" })).toBe(false);
  });

  it("accepts the selected-CLI enum and drops a free-text stand-in", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, provider: "grok" }).provider).toBe("grok");
    expect(sanitizeSessionStartProps({ ...REQUIRED, provider: "codex" }).provider).toBe("codex");
    expect(sanitizeSessionStartProps({ ...REQUIRED, provider: "claude" }).provider).toBe("claude");
    expect("provider" in sanitizeSessionStartProps({ ...REQUIRED, provider: "openai" as SessionStartProps["provider"] })).toBe(false);
    expect("provider" in sanitizeSessionStartProps({
      ...REQUIRED,
      provider: "grok-4.5" as SessionStartProps["provider"],
    })).toBe(false);
    expect("provider" in sanitizeSessionStartProps({ ...REQUIRED })).toBe(false);
  });

  it("keeps connectorCount in 0–10 and omits it when missing or out of range", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, connectorCount: 0 }).connectorCount).toBe(0);
    expect(sanitizeSessionStartProps({ ...REQUIRED, connectorCount: 10 }).connectorCount).toBe(10);
    expect(sanitizeSessionStartProps({ ...REQUIRED, connectorCount: 3 }).connectorCount).toBe(3);
    expect("connectorCount" in sanitizeSessionStartProps({ ...REQUIRED, connectorCount: 11 })).toBe(false);
    expect("connectorCount" in sanitizeSessionStartProps({ ...REQUIRED, connectorCount: -1 })).toBe(false);
    expect("connectorCount" in sanitizeSessionStartProps({ ...REQUIRED })).toBe(false);
  });

  it("emits worktree/returningInstall as booleans and omits them when unavailable or malformed", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, worktree: true }).worktree).toBe(true);
    expect(sanitizeSessionStartProps({ ...REQUIRED, worktree: false }).worktree).toBe(false);
    expect(sanitizeSessionStartProps({ ...REQUIRED, returningInstall: false }).returningInstall).toBe(false);
    expect("worktree" in sanitizeSessionStartProps({ ...REQUIRED })).toBe(false);
    expect("returningInstall" in sanitizeSessionStartProps({ ...REQUIRED })).toBe(false);
    expect("worktree" in sanitizeSessionStartProps({
      ...REQUIRED,
      worktree: "yes" as unknown as boolean,
    })).toBe(false);
    expect("returningInstall" in sanitizeSessionStartProps({
      ...REQUIRED,
      returningInstall: 1 as unknown as boolean,
    })).toBe(false);
  });

  it("keeps only finite numbers inside the documented zoom ranges", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, chatFontScale: 125 }).chatFontScale).toBe(125);
    expect(sanitizeSessionStartProps({ ...REQUIRED, chatFontScale: 10 }).chatFontScale).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, remoteFontScale: 140 }).remoteFontScale).toBe(140);
    expect(sanitizeSessionStartProps({ ...REQUIRED, remoteFontScale: 400 }).remoteFontScale).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, chatFontScale: Number.NaN }).chatFontScale).toBeUndefined();
  });

  it("does not coerce strings into booleans or enums", () => {
    const out = sanitizeSessionStartProps({
      ...REQUIRED,
      showThinking: "true",
      grokConnected: "yes",
      hostKind: "extension",
      appPurpose: "Knowledge work",
    } as unknown as SessionStartProps);
    expect(out.showThinking).toBeUndefined();
    expect(out.grokConnected).toBeUndefined();
    expect(out.hostKind).toBeUndefined();
    expect(out.appPurpose).toBeUndefined();
  });

  it("emits every SESSION_START_ALLOWED_KEYS entry when a valid value is provided", () => {
    const valid: Record<SessionStartPropKey, string | number | boolean> = {
      installId: "install-1",
      mode: "agent",
      model: "grok-4.5",
      effort: "max",
      showThinking: false,
      expandToolDetails: true,
      steerByDefault: false,
      chatFontScale: 110,
      readRepliesAloud: true,
      soundNotifications: false,
      sessionOrigin: "remote",
      clientDevice: "mobile",
      remoteFontScale: 140,
      remoteReadRepliesAloud: false,
      host: "Cursor",
      hostKind: "desktop",
      appPurpose: "coding",
      voiceConfigured: true,
      voiceStreaming: false,
      voiceLanguageSet: true,
      grokConnected: false,
      codexConnected: true,
      claudeConnected: false,
      provider: "codex",
      connectorCount: 2,
      worktree: true,
      returningInstall: false,
    };
    const extra = { ...valid, unlistedPicker: true, prompt: "do not send" };
    const out = sanitizeSessionStartProps(extra);
    expect(Object.keys(out).sort()).toEqual([...SESSION_START_ALLOWED_KEYS].sort());
    for (const key of SESSION_START_ALLOWED_KEYS) {
      expect(out[key]).toBe(valid[key]);
    }
    expect(out.unlistedPicker).toBeUndefined();
  });
});

const SIDEBAR_SRC = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function sidebarMethodBody(signature: string): string {
  const start = SIDEBAR_SRC.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const next = SIDEBAR_SRC.indexOf("\n  private ", start + signature.length);
  return SIDEBAR_SRC.slice(start, next < 0 ? SIDEBAR_SRC.length : next);
}

function makeTelemetrySidebar(cwd = "/repo"): any {
  const instance = Object.create(GrokSidebar.prototype) as any;
  instance.lastProviderConnected = { grok: true, codex: false, claude: false };
  instance.lastVoiceConfiguredByCwd = new Map([[normalizeRepoPath(cwd), true]]);
  instance.locatedProviders = vi.fn(() => {
    throw new Error("reportSessionStart must not rediscover providers");
  });
  instance.locateProvider = vi.fn(() => {
    throw new Error("reportSessionStart must not locate a CLI");
  });
  instance.resolveVoiceApiKey = vi.fn(() => {
    throw new Error("reportSessionStart must not resolve a voice key");
  });
  instance.providerConnections = vi.fn(() => {
    throw new Error("reportSessionStart must not re-read provider connections");
  });
  instance.repoCatalog = vi.fn(() => {
    throw new Error("reportSessionStart must not scan the repo catalog");
  });
  instance.connectedConnectorStore = vi.fn(() => ({}));
  instance.state = {
    get: vi.fn((key: string) => (key === "grok.installId" ? "already-installed" : undefined)),
  };
  instance.remoteClients = new RemoteClientState<Session>(cwd);
  instance.focused = new Session();
  instance.focused.provider = "grok";
  instance.focused.cwd = cwd;
  instance.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  instance.installId = vi.fn(() => "install-wired");
  instance.displayMode = vi.fn(() => "agent");
  instance.appPurpose = vi.fn(() => "coding");
  instance.chatFontScale = vi.fn(() => 1.25);
  instance.voiceSetting = vi.fn((_cwd: string, key: string, fallback: unknown) =>
    key === "voiceLanguage" ? "en" : fallback);
  instance.host = {
    isTelemetryEnabled: true,
    appName: "Visual Studio Code",
    language: "en",
    canSwitchWorkspaceFolder: false,
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback: unknown) => fallback,
    })),
  };
  instance.context = {
    extensionId: OFFICIAL_EXTENSION_ID,
    extensionVersion: "9.9.9",
    isProduction: true,
  };
  return instance;
}

function makeSendingTelemetrySidebar(): any {
  const sidebar = makeTelemetrySidebar();
  sidebar.pendingAttach = new Set();
  sidebar.waitForSessionStart = vi.fn(async () => {});
  sidebar.retainUploadedFilesForSession = vi.fn(async () => {});
  sidebar.rememberProjectProvider = vi.fn(async () => {});
  sidebar.maybeFlushQueuedSends = vi.fn(async () => {});
  sidebar.modelsForSession = vi.fn(() => []);
  for (const method of [
    "refreshImplicitChip", "postChips", "emit", "noteSessionActivity",
    "noteLiveTurnEnded", "maybeGenerateTitle", "postSessionName", "settleUnavailablePlanTurn",
  ]) sidebar[method] = vi.fn();
  sidebar.setStatus = (session: Session, status: Session["status"]) => { session.status = status; };
  sidebar.focused.priming = false;
  sidebar.focused.activeSessionId = "private-conversation-id";
  sidebar.focused.client = {
    sessionId: "private-conversation-id",
    availableCommands: [],
    availableModels: [],
    prompt: vi.fn(async () => ({})),
  };
  sidebar.remoteClients.ready("phone");
  sidebar.remoteClients.setActive("phone", sidebar.focused);
  sidebar.remoteClients.setMetadata("phone", { usesTouch: true });
  sidebar.workspaceRoot = vi.fn(() => "/repo");
  sidebar.host.openExternal = vi.fn(async () => true);
  sidebar.relayUrl = vi.fn(() => "wss://example.invalid");
  return sidebar;
}

describe("remote telemetry at the host send seam", () => {
  it.each(["grok", "codex", "claude"] as const)(
    "LOCAL first message then REMOTE second message emits remote usage once (%s)",
    async (provider) => {
      const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
      const sidebar = makeSendingTelemetrySidebar();
      const session = sidebar.focused as Session;
      session.provider = provider;

      await sidebar.handleSend("local prompt must stay private", false, session, "local");
      expect(session.userMessageCount).toBe(1);
      expect(post).not.toHaveBeenCalled(); // the POST is deferred
      vi.runAllTimers();
      expect(post.mock.calls.map(([, event]) => event.eventName)).toEqual(["session_start"]);

      await sidebar.handleSend("remote follow-up must stay private", false, session, "remote");
      vi.runAllTimers();
      expect(session.userMessageCount).toBe(2);
      expect(post.mock.calls.map(([, event]) => event.eventName)).toEqual([
        "session_start", "session_remote_started",
      ]);
      const event = post.mock.calls[1][1];
      expect(event.props).toEqual({
        installId: "install-wired", hostKind: "vscode", clientDevice: "mobile",
        sessionOrigin: "local", provider,
      });
      expect(event.sessionId).toBe(post.mock.calls[0][1].sessionId);
      expect(JSON.stringify(event)).not.toMatch(/private|\/repo|phone/);

      for (let message = 3; message <= 5; message++) {
        await sidebar.handleSend("another remote follow-up", false, session, "remote");
        vi.runAllTimers();
        expect(post).toHaveBeenCalledTimes(2);
      }
      expect(session.client!.prompt).toHaveBeenCalledTimes(5);
    },
  );

  it("a REMOTE first message deliberately emits both events in the same Aptabase session", async () => {
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
    const sidebar = makeSendingTelemetrySidebar();
    await sidebar.handleSend("private", false, sidebar.focused, "remote");
    vi.runAllTimers();
    const events = post.mock.calls.map(([, event]) => event);
    expect(events.map((event) => event.eventName)).toEqual(["session_start", "session_remote_started"]);
    expect(events[0].props.sessionOrigin).toBe("remote");
    expect(events[1].props.sessionOrigin).toBe("remote");
    expect(events[1].sessionId).toBe(events[0].sessionId);
  });

  it.each(["send", "queueSend", "steerSend"] as const)("a phone takeover via %s counts even during a running local turn", async (type) => {
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
    const sidebar = makeSendingTelemetrySidebar();
    await sidebar.handleSend("private", false, sidebar.focused, "local");
    vi.runAllTimers();
    sidebar.focused.status = "working";
    sidebar.captureRemoteRequester = vi.fn(() => ({}));
    sidebar.steerSend = vi.fn(async () => {});
    for (let message = 0; message < 3; message++) {
      await sidebar.onMessage({ type, text: "remote follow-up" }, "remote", "phone");
      vi.runAllTimers();
      expect(post).toHaveBeenCalledTimes(2);
    }
    expect(post.mock.calls[1][1]).toMatchObject({
      eventName: "session_remote_started", props: { sessionOrigin: "local", clientDevice: "mobile" },
    });
  });

  it.each([true, false])("openRemotePortal records only intent props (withHint=%s)", async (withHint) => {
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
    const sidebar = makeSendingTelemetrySidebar();
    await sidebar.onMessage({ type: "openRemotePortal", withHint }, "local");
    expect(sidebar.host.openExternal).toHaveBeenCalledWith(
      "https://example.invalid" + (withHint ? "/?remoteHint=1" : ""),
    );
    expect(post).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({
      eventName: "remote_portal_opened",
      props: { installId: "install-wired", hostKind: "vscode", withHint },
    });
    expect(Object.keys(post.mock.calls[0][1].props).sort()).toEqual([...REMOTE_PORTAL_OPENED_ALLOWED_KEYS].sort());
  });

  it.each(["global opt-out", "product opt-out", "fork"])("both new events stay silent: %s", async (gate) => {
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
    const sidebar = makeSendingTelemetrySidebar();
    if (gate === "global opt-out") sidebar.host.isTelemetryEnabled = false;
    if (gate === "product opt-out") sidebar.host.getConfiguration = () => ({
      get: (key: string, fallback: unknown) => key === "telemetry.enabled" ? false : fallback,
    });
    if (gate === "fork") sidebar.context.extensionId = "someone-else.grok-vscode-phuryn";
    await sidebar.onMessage({ type: "openRemotePortal", withHint: true }, "local");
    await sidebar.handleSend("private", false, sidebar.focused, "remote");
    vi.runAllTimers();
    expect(post).not.toHaveBeenCalled();
    expect(sidebar.installId).not.toHaveBeenCalled();
    expect(sidebar.focused.client.prompt).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("all events use the existing cloud detector (desktop=%s)", async (desktop) => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
    const sidebar = makeSendingTelemetrySidebar();
    sidebar.host.canSwitchWorkspaceFolder = desktop;
    sidebar.reportRemotePortalOpened(false);
    await sidebar.handleSend("private", false, sidebar.focused, "remote");
    vi.runAllTimers();
    expect(post).toHaveBeenCalledTimes(3);
    for (const [, event] of post.mock.calls) expect(event.props.hostKind).toBe("sprite");
  });

  it("does not guess the original origin of a cold-resumed conversation", async () => {
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
    const sidebar = makeSendingTelemetrySidebar();
    sidebar.focused.hasHistory = true;
    sidebar.remoteClients.setMetadata("phone", { usesTouch: false });
    await sidebar.handleSend("private", false, sidebar.focused, "remote");
    vi.runAllTimers();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1].props).not.toHaveProperty("sessionOrigin");
    expect(post.mock.calls[0][1].props.clientDevice).toBe("desktop");
  });

  it("swallows construction and deferred POST failures without retrying or breaking the turn", async () => {
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => { throw new Error("offline"); });
    const sidebar = makeSendingTelemetrySidebar();
    sidebar.installId.mockImplementation(() => { throw new Error("store unavailable"); });
    expect(() => sidebar.reportRemotePortalOpened(false)).not.toThrow();
    await expect(sidebar.handleSend("private", false, sidebar.focused, "remote")).resolves.toBeUndefined();
    expect(() => vi.runAllTimers()).not.toThrow(); // session_start's cached install id still permits its POST
    expect(post).toHaveBeenCalledTimes(1);
    sidebar.installId.mockReturnValue("install-wired");
    await sidebar.handleSend("private", false, sidebar.focused, "remote");
    vi.runAllTimers();
    expect(post).toHaveBeenCalledTimes(1);
    sidebar.reportRemotePortalOpened(false);
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("shares the activity id across sidebar instances and rotates after an hour without emitted events", () => {
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    const post = vi.spyOn(telemetry, "postEvent").mockImplementation(() => {});
    const first = makeSendingTelemetrySidebar();
    const second = makeSendingTelemetrySidebar();
    first.reportRemotePortalOpened(true);
    vi.runAllTimers();
    vi.setSystemTime(Date.now() + 1000);
    second.reportSessionStart(second.focused, "local");
    vi.runAllTimers();
    expect(post.mock.calls[1][1].sessionId).toBe(post.mock.calls[0][1].sessionId);
    vi.setSystemTime(Date.now() + TELEMETRY_SESSION_INACTIVITY_MS);
    second.host.isTelemetryEnabled = false;
    second.reportRemotePortalOpened(false); // opted-out activity cannot prolong the session
    second.host.isTelemetryEnabled = true;
    vi.setSystemTime(Date.now() + 1);
    second.reportRemoteMessage(second.focused, "remote");
    vi.runAllTimers();
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[2][1].sessionId).not.toBe(post.mock.calls[0][1].sessionId);
  });
});

describe("lean remote payload builders and sanitizers", () => {
  const sys = { appVersion: "1", osName: "Windows", osVersion: "10", locale: "en", isDebug: false };
  const timestamp = "2026-09-06T00:00:00.000Z";
  const cases = [
    { build: buildRemotePortalOpenedEvent, sanitize: telemetry.sanitizeRemotePortalOpenedProps,
      name: "remote_portal_opened", keys: REMOTE_PORTAL_OPENED_ALLOWED_KEYS,
      props: { installId: "install-1", hostKind: "sprite", withHint: false } },
    { build: buildSessionRemoteStartedEvent, sanitize: telemetry.sanitizeSessionRemoteStartedProps,
      name: "session_remote_started", keys: SESSION_REMOTE_STARTED_ALLOWED_KEYS,
      props: { installId: "install-1", hostKind: "sprite", clientDevice: "mobile", sessionOrigin: "local", provider: "codex" } },
  ];
  it.each(cases)("$name keeps exactly its disclosed props and supplied envelope", ({ build, sanitize, name, keys, props }) => {
    const raw = { ...REQUIRED, ...props, prompt: "private text", sessionId: "private-id", branch: "main", withHint: false };
    expect(sanitize(raw)).toEqual(props);
    const event = build(raw as any, sys, "aptabase-id", timestamp);
    expect(event).toMatchObject({ eventName: name, sessionId: "aptabase-id", timestamp, props });
    expect(Object.keys(event.props).sort()).toEqual([...keys].sort());
    const privacy = readFileSync(new URL("../docs/privacy.md", import.meta.url), "utf8");
    expect(privacy).toContain(name);
    for (const key of keys) expect(privacy).toMatch(key === "installId" ? /install id/i : new RegExp(key));
  });
  it.each(cases)("$name drops sensitive strings and wrong types", ({ build, sanitize }) => {
    const dirty = {
      installId: "C:\\Users\\private", hostKind: "sprite/../private", withHint: "secret text",
      clientDevice: "phone in the office", sessionOrigin: "https://private.invalid", provider: "../secret",
      prompt: "private", cwd: "/private", repo: "private", sessionId: "private-id",
    };
    expect(sanitize(dirty)).toEqual({});
    expect(build(dirty as any, sys, "aptabase-id", timestamp).props).toEqual({});
    for (const value of ["/home/private", "\\\\server\\share", "../private", "https://private.invalid", "x".repeat(81)]) {
      expect(sanitize({ installId: value })).toEqual({});
    }
  });
  it("does not add remote-only keys to the existing session_start baseline", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, withHint: true })).not.toHaveProperty("withHint");
  });
});

describe("Aptabase inactivity sessions", () => {
  it("uses time since the last event, reuses at exactly one hour, and rotates only beyond it", () => {
    const createId = vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second");
    const first = nextTelemetrySession(undefined, 0, createId);
    const nearby = nextTelemetrySession(first, 1000, createId);
    expect(nearby.id).toBe(first.id);
    const boundary = nextTelemetrySession(nearby, 1000 + TELEMETRY_SESSION_INACTIVITY_MS, createId);
    expect(boundary.id).toBe(first.id);
    expect(createId).toHaveBeenCalledTimes(1);
    const expired = nextTelemetrySession(boundary, boundary.lastEventAt + TELEMETRY_SESSION_INACTIVITY_MS + 1, createId);
    expect(expired.id).toBe("second");
    expect(createId).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ id: "first", lastEventAt: 0 }); // pure: input unchanged
  });
});

describe("docs/privacy.md discloses every session_start prop", () => {
  const privacy = readFileSync(new URL("../docs/privacy.md", import.meta.url), "utf8");
  it("names each allowed key so a shipped prop cannot miss the disclosure surface", () => {
    for (const key of SESSION_START_ALLOWED_KEYS) {
      expect(privacy, `docs/privacy.md must name ${key}`).toMatch(
        key === "installId" ? /install id/i : new RegExp(key),
      );
    }
  });
});

describe("sidebar session_start wiring", () => {
  it("passes every allowed key into the payload builder from the call site", () => {
    const body = sidebarMethodBody("private reportSessionStart(");
    for (const key of SESSION_START_ALLOWED_KEYS) {
      // Origin/device ride the sessionStartSurface spread, not a bare key.
      if (key === "sessionOrigin" || key === "clientDevice") continue;
      expect(body, `reportSessionStart must pass ${key}`).toContain(`${key}:`);
    }
    expect(body).toContain("sessionStartSurface(");
    expect(body).not.toContain("locatedProviders(");
    expect(body).not.toContain("resolveVoiceApiKey(");
    expect(body).toContain("this.lastProviderConnected?.grok");
    expect(body).toContain("this.lastProviderConnected?.codex");
    expect(body).toContain("this.lastProviderConnected?.claude");
    expect(body).toContain("this.lastVoiceConfiguredByCwd.get(");
    expect(body).toContain("session.provider");
    expect(body).toContain("this.connectedConnectorStore()");
    expect(body).toContain("session.worktree");
    expect(body).not.toContain("repoCatalog(");
    expect(body).not.toContain("discoverRepos(");
    expect(body).not.toContain("refreshMcpServers(");
    expect(body).not.toContain("connectors:");
    expect(body).not.toContain("mcpServerCount:");
    expect(body).not.toContain("projectCount:");
  });

  it("builds hostKind/appPurpose/flags from the last refresh snapshot, not a live probe", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      const session = sidebar.focused as Session;
      session.client = {
        currentModelId: "grok-4.5",
        currentReasoningEffort: "ultra",
      } as any;
      sidebar.reportSessionStart(session, "local");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        hostKind: "vscode",
        appPurpose: "coding",
        voiceConfigured: true,
        voiceStreaming: true,
        voiceLanguageSet: true,
        grokConnected: true,
        codexConnected: false,
        claudeConnected: false,
        provider: "grok",
        connectorCount: 0,
        worktree: false,
        returningInstall: true,
        chatFontScale: 125,
        readRepliesAloud: false,
        soundNotifications: false,
        showThinking: false,
        expandToolDetails: false,
        steerByDefault: false,
        model: "grok-4.5",
        effort: "ultra",
        sessionOrigin: "local",
        clientDevice: "desktop",
      });
      expect(sidebar.locatedProviders).not.toHaveBeenCalled();
      expect(sidebar.resolveVoiceApiKey).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("snapshots connected flags when providerState refreshes", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.providerConnections = vi.fn(() => ({ grok: true, codex: true, claude: true }));
    sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: true }));
    sidebar.providerCliVersions = {};
    sidebar.providerNeedsLogin = {};
    sidebar.providerStateMessage();
    expect(sidebar.lastProviderConnected).toEqual({ grok: true, codex: false, claude: true });
  });

  it("omits voice and provider flags when no snapshot exists (never a fake false)", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      sidebar.lastProviderConnected = null;
      sidebar.lastVoiceConfiguredByCwd = new Map();
      sidebar.reportSessionStart(sidebar.focused, "local");
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(input.voiceConfigured).toBeUndefined();
      expect(input.grokConnected).toBeUndefined();
      expect(input.codexConnected).toBeUndefined();
      expect(input.claudeConnected).toBeUndefined();
      const props = telemetry.sanitizeSessionStartProps(
        telemetry.buildSessionStartEvent(
          input as any,
          { appVersion: "1.0.0", osName: "Windows" },
        ).props,
      );
      expect(props).not.toHaveProperty("voiceConfigured");
      expect(props).not.toHaveProperty("grokConnected");
      expect(props).not.toHaveProperty("codexConnected");
      expect(props).not.toHaveProperty("claudeConnected");
    } finally {
      spy.mockRestore();
    }
  });

  it("reports the session CLI independently of the connected flags", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      sidebar.focused.provider = "codex";
      sidebar.lastProviderConnected = { grok: true, codex: false, claude: false };
      sidebar.reportSessionStart(sidebar.focused, "local");
      expect(spy.mock.calls[0][0]).toMatchObject({
        provider: "codex",
        grokConnected: true,
        codexConnected: false,
        claudeConnected: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("reads connectorCount, worktree, and returningInstall from sync fields already on the session/store", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      sidebar.connectedConnectorStore = vi.fn(() => ({ linear: { endpoint: "https://mcp.linear.app/mcp" }, github: { endpoint: "https://api.githubcopilot.com/mcp/" } }));
      sidebar.focused.worktree = { path: "/tmp/wt", label: "wt", sourceGitRoot: "/repo" };
      sidebar.reportSessionStart(sidebar.focused, "local");
      expect(spy.mock.calls[0][0]).toMatchObject({
        connectorCount: 2,
        worktree: true,
        returningInstall: true,
      });
      expect(sidebar.repoCatalog).not.toHaveBeenCalled();

      spy.mockClear();
      sidebar.state.get = vi.fn(() => undefined);
      sidebar.connectedConnectorStore = vi.fn(() => ({}));
      sidebar.focused.worktree = undefined;
      sidebar.reportSessionStart(sidebar.focused, "local");
      expect(spy.mock.calls[0][0]).toMatchObject({
        connectorCount: 0,
        worktree: false,
        returningInstall: false,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards a previously-dropped host product name from the emission site", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      sidebar.host.appName = "Antigravity IDE";
      sidebar.reportSessionStart(sidebar.focused, "local");
      const input = spy.mock.calls[0][0] as SessionStartProps;
      expect(input.host).toBe("Antigravity IDE");
      expect(telemetry.sanitizeSessionStartProps(input).host).toBe("Antigravity IDE");
    } finally {
      spy.mockRestore();
    }
  });

  it("a voice snapshot for a DIFFERENT cwd does not answer for this one", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      sidebar.lastVoiceConfiguredByCwd = new Map([[normalizeRepoPath("/other"), true]]);
      sidebar.reportSessionStart(sidebar.focused, "local");
      expect((spy.mock.calls[0][0] as Record<string, unknown>).voiceConfigured).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("postVoiceConfigured rebuilds the map: stale keys from removed configs drop out", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.focused = new Session();
    sidebar.focused.cwd = "/repo";
    sidebar.sessionCwd = vi.fn(() => "/repo");
    sidebar.resolveVoiceApiKey = vi.fn(() => "key");
    sidebar.voiceSetting = vi.fn((_c: string, _k: string, fb: unknown) => fb);
    sidebar.postLocal = vi.fn();
    sidebar.remoteClients = new RemoteClientState<Session>("/repo");
    sidebar.lastVoiceConfiguredByCwd = new Map([[normalizeRepoPath("/gone"), true]]);
    sidebar.lastPostedVoiceConfigured = new Map();
    sidebar.postVoiceConfigured();
    expect(sidebar.lastVoiceConfiguredByCwd.has(normalizeRepoPath("/gone"))).toBe(false);
    expect(sidebar.lastVoiceConfiguredByCwd.get(normalizeRepoPath("/repo"))).toBe(true);
  });

  it("postVoiceConfigured skips a connected client that has no project yet", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.focused = new Session();
    sidebar.focused.cwd = "/desk";
    sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || "/desk");
    sidebar.resolveVoiceApiKey = vi.fn(() => "key");
    sidebar.voiceSetting = vi.fn((_c: string, _k: string, fb: unknown) => fb);
    sidebar.postLocal = vi.fn();
    sidebar.sendRemoteClient = vi.fn();
    sidebar.remoteClients = new RemoteClientState<Session>("");
    sidebar.lastVoiceConfiguredByCwd = new Map();
    sidebar.lastPostedVoiceConfigured = new Map();
    sidebar.remoteClients.ready("c49");
    sidebar.remoteClients.ready("ok");
    sidebar.remoteClients.select("ok", "/repo");

    expect(() => sidebar.remoteClients.cwd("c49")).toThrow(/not ready/);
    expect(() => sidebar.remoteSessionFor("c49")).toThrow(/not ready/);
    expect(() => sidebar.postVoiceConfigured()).not.toThrow();

    expect(sidebar.sendRemoteClient).toHaveBeenCalledTimes(1);
    expect(sidebar.sendRemoteClient).toHaveBeenCalledWith(
      "ok",
      expect.objectContaining({ type: "voiceConfigured", value: true }),
      "/repo",
    );
    expect(sidebar.remoteClients.active("c49")).toBeUndefined();
    expect(sidebar.remoteClients.active("ok")).toBeUndefined();
    expect(sidebar.lastVoiceConfiguredByCwd.get(normalizeRepoPath("/repo"))).toBe(true);
  });

});
