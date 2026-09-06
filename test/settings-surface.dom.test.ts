// Shared settings surface: overlay in chat.js + the catalog in media/settings.js.
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIER1_CONNECTORS } from "../src/mcp-connectors";
import { bootWebview, click, dispatch } from "./webview-harness";

const settingsSrc = readFileSync(
  fileURLToPath(new URL("../media/settings.js", import.meta.url)),
  "utf8",
);

function loadSettings() {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  return (window as unknown as { GrokSettings: {
    ROWS: Array<{ id: string; category: string; href?: string; enabled?: (s: unknown) => boolean }>;
    CATEGORIES: Array<{ id: string; title: string }>;
    NAV_ICONS: Record<string, string>;
    TELEMETRY_COPY: string;
    THUMBS_COPY: string;
    ABOUT_DISCLAIMER: string;
    GROK_CONNECTORS_URL: string;
    ICON_SETTINGS: string;
    CONNECTOR_LOGO_IDS: Record<string, boolean>;
    keyDocsLabel: (url: string) => string;
    sortConnectorsForDisplay: (connectors: Array<{ name?: string; connected?: boolean }>) => Array<{ name?: string; connected?: boolean }>;
    CONNECTOR_SECTION_HERE: string;
    CONNECTOR_SECTION_GROK: string;
    CONNECTOR_SECTION_LOCAL: string;
    CONNECTOR_BLURB_HERE: string;
    CONNECTOR_BLURB_GROK: string;
    CONNECTOR_BLURB_LOCAL: string;
    CONNECTOR_BLURB_LOCAL_REMOTE: string;
    GITHUB_ISSUE_BUG_URL: string;
    GITHUB_ISSUE_FEATURE_URL: string;
    SUPPORT_MAILTO: string;
    defaultSnapshot: (p?: Record<string, unknown>) => Record<string, unknown>;
    defaultEnv: (p?: Record<string, unknown>) => Record<string, unknown>;
    githubTokenAvailable: (s: unknown, e: unknown) => boolean;
    visibleRows: (s: unknown, e: unknown) => Array<{ id: string; category: string; hostLocal?: boolean }>;
    visibleCategories: (s: unknown, e: unknown) => Array<{ id: string }>;
    filterRows: (q: string, s: unknown, e: unknown) => Array<{ id: string; category: string }>;
    restoreTargets: (id: string, s: unknown, e: unknown) => Array<{ id: string; kind?: string }>;
    restoreChanges: (id: string, s: unknown, e: unknown) => Array<{ id: string; title?: string }>;
    restoreValueLabel: (row: { kind?: string; options?: Array<{ value: string; label: string }> }, value: unknown) => string;
    isRestorableKind: (row: { kind?: string }) => boolean;
    rowEnabled: (row: { enabled?: (s: unknown) => boolean }, s: unknown) => boolean;
    mount: (el: Element, opts: Record<string, unknown>) => { dispose: () => void; snapshot: unknown };
  } }).GrokSettings;
}

function fullEnv(overrides: Record<string, unknown> = {}) {
  return {
    isRemote: false,
    isDesktop: true,
    clientOwnsFontScale: true,
    ttsAvailable: true,
    steerSupported: true,
    providersKnown: true,
    remoteLinked: true,
    hostCaps: { relocateView: false, showOutput: false, toggleDevTools: true },
    ...overrides,
  };
}

function withMcpSettings(overrides: Record<string, unknown> = {}) {
  const base = fullEnv(overrides);
  const hostCaps = { ...(base.hostCaps as object), mcpSettings: true };
  return { ...base, hostCaps };
}

function seedChat(h: ReturnType<typeof bootWebview>, extra: Record<string, unknown> = {}) {
  dispatch(h.window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    readRepliesAloud: false,
    appPurpose: "coding",
    capabilities: { uploadFile: true, remoteVoice: true, ...(extra.capabilities as object || {}) },
    ...extra,
  });
  dispatch(h.window, {
    type: "providerState",
    providers: [
      { id: "grok", connected: true },
      { id: "codex", connected: false },
    ],
  });
  dispatch(h.window, { type: "remoteStatus", linked: true });
}

function openSettings(h: ReturnType<typeof bootWebview>) {
  const gear = h.doc.getElementById("rail-gear-btn") || h.doc.getElementById("gear-btn");
  click(h.window, gear!);
  const item = [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
    .find((el) => /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()));
  expect(item).toBeTruthy();
  click(h.window, item!);
}

function settingsNav(h: ReturnType<typeof bootWebview>) {
  return [...h.doc.querySelectorAll("#settings-overlay .settings-nav-item")];
}

function clickSettingsNav(h: ReturnType<typeof bootWebview>, title: string) {
  const item = settingsNav(h).find((el) => (el.textContent || "").trim() === title);
  expect(item).toBeTruthy();
  click(h.window, item!);
  return item!;
}

function gearLabels(h: ReturnType<typeof bootWebview>) {
  return [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")]
    .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
}

describe("settings catalog", () => {
  it("exposes every category and hides host-local rows on remote", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({
      appPurpose: "coding",
      providers: [{ id: "grok", connected: true }, { id: "codex", connected: false }],
    });
    const local = api.visibleCategories(snapshot, api.defaultEnv(withMcpSettings()));
    expect(local.map((c) => c.id)).toEqual([
      "general", "voice", "notifications", "providers", "routines", "connectors", "account", "advanced", "about",
    ]);
    const remoteRows = api.visibleRows(snapshot, api.defaultEnv(withMcpSettings({ isRemote: true })));
    expect(remoteRows.some((row) => row.hostLocal)).toBe(false);
    expect(remoteRows.some((row) => row.id === "openGlobalConfig")).toBe(false);
    expect(remoteRows.some((row) => row.id === "providerGrok")).toBe(false);
    expect(remoteRows.some((row) => row.id === "providerGrokStatus")).toBe(true);
    expect(remoteRows.some((row) => row.id === "remoteAccountStatus")).toBe(true);
    expect(remoteRows.some((row) => row.id === "remoteDeviceManager")).toBe(true);
    expect(remoteRows.some((row) => row.id === "showThinking")).toBe(true);
    expect(remoteRows.some((row) => row.id === "soundNotifications")).toBe(true);
    expect(remoteRows.some((row) => row.id === "voiceSendPhrase")).toBe(true);
    expect(remoteRows.some((row) => row.id === "telemetryRemote")).toBe(true);
    expect(remoteRows.some((row) => row.id === "telemetryDesktop")).toBe(false);
    expect(remoteRows.some((row) => row.id === "connectorsCatalog")).toBe(true);
    expect(remoteRows.some((row) => row.id === "grokConnectorsSite")).toBe(false);
    expect(remoteRows.some((row) => row.id === "mcpCatalog")).toBe(true);
  });

  it("hides Connectors when mcpSettings is absent", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({ appPurpose: "coding" });
    const env = api.defaultEnv(fullEnv());
    expect(api.visibleCategories(snapshot, env).map((c) => c.id)).toEqual([
      // Routines stays — it is not gated on mcpSettings, and a host without
      // connectors still schedules perfectly well.
      "general", "voice", "notifications", "providers", "routines", "account", "advanced", "about",
    ]);
    const rows = api.visibleRows(snapshot, env);
    expect(rows.some((row) => row.id === "routinesList")).toBe(true);
    expect(rows.some((row) => row.id === "connectorsCatalog")).toBe(false);
    expect(rows.some((row) => row.id === "mcpCatalog")).toBe(false);
  });

  it("shows Connectors as one category with both sections when mcpSettings is present", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({ appPurpose: "coding" });
    const env = api.defaultEnv(withMcpSettings());
    expect(api.visibleCategories(snapshot, env).map((c) => c.id)).toEqual([
      "general", "voice", "notifications", "providers", "routines", "connectors", "account", "advanced", "about",
    ]);
    expect(api.CATEGORIES.some((c: { id: string }) => c.id === "mcp")).toBe(false);
    expect(api.NAV_ICONS.mcp).toBeUndefined();
    const rows = api.visibleRows(snapshot, env);
    expect(rows.some((row) => row.id === "connectorsCatalog")).toBe(true);
    expect(rows.some((row) => row.id === "mcpCatalog")).toBe(true);
    expect(rows.some((row) => row.id === "grokConnectorsSite")).toBe(false);
    expect(rows.find((row) => row.id === "mcpCatalog")?.category).toBe("connectors");
    expect(api.GROK_CONNECTORS_URL).toBe("https://grok.com/connectors");
    expect(api.CONNECTOR_SECTION_HERE).toBe("On this computer");
    expect(api.CONNECTOR_SECTION_GROK).toBe("Grok.com connectors");
    expect(api.CONNECTOR_SECTION_LOCAL).toBe("Local Grok connectors");
    expect(api.CONNECTOR_BLURB_HERE).toMatch(/Grok, Codex, and Claude/);
    expect(api.CONNECTOR_BLURB_GROK).toMatch(/follow your Grok account/);
    expect(api.CONNECTOR_BLURB_LOCAL).toMatch(/Grok config files/);
    expect(api.CONNECTOR_BLURB_GROK).not.toMatch(/Grok, Codex, and Claude/);
    const mcpCopy = api.ROWS.find((row) => row.id === "mcpCatalog") as { description?: string };
    expect(mcpCopy.description).toBe(api.CONNECTOR_BLURB_GROK);
  });

  it("gives every category a nav icon and folds Chat into General", () => {
    const api = loadSettings();
    expect(api.CATEGORIES.some((c: { id: string }) => c.id === "chat")).toBe(false);
    expect(api.ROWS.filter((r: { category: string }) => r.category === "chat")).toEqual([]);
    expect(api.ROWS.find((r: { id: string }) => r.id === "showThinking")?.category).toBe("general");
    expect(api.NAV_ICONS.providers).toContain("M12 8V4H8");
    expect(api.NAV_ICONS.connectors).toContain("M12 22v-5");
    for (const cat of api.CATEGORIES) {
      expect(api.NAV_ICONS[cat.id]).toMatch(/<svg /);
    }
  });

  it("search matches titles across categories", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({ appPurpose: "coding" });
    const env = api.defaultEnv(fullEnv());
    const hits = api.filterRows("thinking", snapshot, env);
    expect(hits.map((row) => row.id)).toContain("showThinking");
    expect(hits.every((row) => row.category === "general")).toBe(true);
    const sound = api.filterRows("sound", snapshot, env);
    expect(sound.map((row) => row.id)).toEqual(expect.arrayContaining([
      "soundNotifications",
      "processingSound",
    ]));
  });

  it("search finds connectors, grok.com, and Grok inventory names", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({
      appPurpose: "coding",
      mcpConnectors: [{ id: "linear", name: "Linear", description: "Issues." }],
      mcpServers: [{ name: "managed_gateway:canva", displayName: "Canva" }],
    });
    const env = api.defaultEnv(withMcpSettings());
    expect(api.filterRows("linear", snapshot, env).map((row) => row.id)).toContain("connectorsCatalog");
    expect(api.filterRows("grok.com", snapshot, env).map((row) => row.id)).toContain("mcpCatalog");
    expect(api.filterRows("canva", snapshot, env).map((row) => row.id)).toContain("mcpCatalog");
    expect(api.filterRows("grok connectors", snapshot, env).map((row) => row.id))
      .toEqual(expect.arrayContaining(["mcpCatalog"]));
  });

  it("sorts On this computer connected-first, then by name case-insensitively", () => {
    const api = loadSettings();
    const ordered = api.sortConnectorsForDisplay([
      { name: "stripe", connected: false },
      { name: "Linear", connected: true },
      { name: "canva", connected: true },
      { name: "Atlassian", connected: false },
      { name: "Notion", connected: true },
      { name: "Calendly", connected: false },
      { name: "Airtable", connected: false },
    ]);
    expect(ordered.map((c) => c.name)).toEqual([
      "canva", "Linear", "Notion", "Airtable", "Atlassian", "Calendly", "stripe",
    ]);
  });

  it("reuses the lucide settings gear, not a new SVG path", () => {
    const api = loadSettings();
    expect(api.ICON_SETTINGS).toContain("M12.22 2h-.44");
    expect(api.ICON_SETTINGS).toContain('circle cx="12" cy="12" r="3"');
    const chatSrc = readFileSync(fileURLToPath(new URL("../media/chat.js", import.meta.url)), "utf8");
    expect(chatSrc).toContain("M12.22 2h-.44");
  });

  it("ships a webp mark only for catalog ids that have one", () => {
    const api = loadSettings();
    const dir = fileURLToPath(new URL("../media/connector-logos", import.meta.url));
    const logoIds = Object.keys(api.CONNECTOR_LOGO_IDS).sort();
    const catalog = new Set(TIER1_CONNECTORS.map((c) => c.id));
    expect(logoIds.every((id) => catalog.has(id))).toBe(true);
    // The registry and the directory must agree in BOTH directions. A
    // registered id with no file renders a broken image; a file with no
    // registered id is dead weight vendored to the relay forever, and the
    // vendor manifest hashes that directory so it would ship regardless.
    for (const id of logoIds) {
      expect(existsSync(path.join(dir, `${id}.webp`)), id).toBe(true);
    }
    const onDisk = readdirSync(dir).filter((f) => f.endsWith(".webp")).map((f) => f.replace(/\.webp$/, "")).sort();
    expect(onDisk).toEqual(logoIds);
  });
});

describe("settings overlay (chat.js)", () => {
  it("renders every category from the gear Settings entry", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay");
    expect(overlay).toBeTruthy();
    const nav = settingsNav(h).map((el) => (el.textContent || "").trim());
    expect(nav).toEqual([
      "General", "Voice", "Notifications", "Providers", "Routines", "Remote control", "Advanced", "About",
    ]);
    expect(nav).not.toContain("Connectors");
    expect(nav).not.toContain("MCP servers");
    expect(overlay!.querySelector(".settings-nav-icon svg")).toBeTruthy();
    expect(overlay!.querySelector(".settings-close")).toBeNull();
    const categorySelect = overlay!.querySelector(".settings-nav-select") as HTMLSelectElement;
    expect(categorySelect).toBeTruthy();
    expect(categorySelect.hidden).toBe(true);
    expect([...categorySelect.options].map((opt) => opt.textContent)).toEqual(nav);
    categorySelect.value = "voice";
    categorySelect.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    expect(overlay!.querySelector('[data-id="voiceSendPhrase"]')).toBeTruthy();
  });

  it("does not rebuild the overlay when a live host message repeats the same snapshot", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay")!;
    dispatch(h.window, { type: "voiceConfigured", value: true });
    const shell = overlay.querySelector(".settings-shell");
    expect(shell).toBeTruthy();
    dispatch(h.window, { type: "voiceConfigured", value: true });
    dispatch(h.window, { type: "voiceConfigured", value: true });
    expect(overlay.querySelector(".settings-shell")).toBe(shell);
  });

  it("hides the Connectors nav row when mcpSettings is absent", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const nav = settingsNav(h).map((el) => (el.textContent || "").trim());
    expect(nav).not.toContain("Connectors");
    expect(nav).not.toContain("MCP servers");
    expect(h.doc.querySelector('[data-id="connectorsCatalog"]')).toBeNull();
    expect(h.doc.querySelector('[data-id="mcpCatalog"]')).toBeNull();
  });

  it("shows a single Connectors nav row when mcpSettings is present", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    openSettings(h);
    const nav = settingsNav(h).map((el) => (el.textContent || "").trim());
    expect(nav).toEqual([
      "General", "Voice", "Notifications", "Providers", "Routines", "Connectors", "Remote control", "Advanced", "About",
    ]);
    expect(nav.filter((label) => label === "Connectors")).toHaveLength(1);
    expect(nav).not.toContain("MCP servers");
  });

  it("filters rows across categories from the search box", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const search = h.doc.getElementById("settings-search") as HTMLInputElement;
    search.value = "sound";
    search.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    const overlay = h.doc.getElementById("settings-overlay")!;
    const ids = [...overlay.querySelectorAll(".settings-row")].map((el) => (el as HTMLElement).dataset.id);
    expect(ids).toEqual(expect.arrayContaining(["soundNotifications", "processingSound"]));
    expect(ids).not.toContain("appPurpose");
    expect(overlay.textContent).toMatch(/Notifications/);
  });

  it("posts the same toggle message the gear switch posts", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay")!;
    clickSettingsNav(h, "General");
    h.posted.length = 0;
    const thinking = overlay.querySelector('[data-id="showThinking"] .settings-switch') as HTMLElement;
    expect(thinking).toBeTruthy();
    click(h.window, thinking);
    expect(h.posted).toContainEqual({ type: "setShowThinking", value: true });
  });

  it("omits host-local rows under the remote capability profile", () => {
    const h = bootWebview({ remote: true });
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay")!;
    const ids = [...overlay.querySelectorAll(".settings-row")].map((el) => (el as HTMLElement).dataset.id);
    expect(ids).not.toContain("openGlobalConfig");
    expect(ids).not.toContain("runMcpList");
    expect(ids).not.toContain("showLogs");
    expect(ids).not.toContain("providerGrok");
    expect(ids).not.toContain("continueRemotely");
    const nav = settingsNav(h).map((el) => (el.textContent || "").trim());
    expect(nav).toContain("Providers");
    expect(nav).not.toContain("Connectors");
    expect(nav).not.toContain("MCP servers");
    expect(nav).toContain("Remote control");
    clickSettingsNav(h, "Providers");
    expect(overlay.textContent).toMatch(/This account is connected on this machine/);
    clickSettingsNav(h, "Remote control");
    expect(overlay.textContent).toMatch(/Device manager/);
    clickSettingsNav(h, "Advanced");
    expect(overlay.textContent).toMatch(/Host config is managed on the machine running this workspace/);
  });

  it("posts openSettingsSurface when the host advertises the editor tab", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { settingsEditor: true } });
    openSettings(h);
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(h.posted).toContainEqual({ type: "openSettingsSurface" });
  });

  it("replaces the legacy gear panels with a single Settings entry", () => {
    const h = bootWebview();
    seedChat(h);
    click(h.window, h.doc.getElementById("gear-btn")!);
    const labels = gearLabels(h);
    expect(labels.some((l) => l === "Settings" || l.endsWith("Settings"))).toBe(true);
    expect(labels.some((l) => l === "All settings")).toBe(false);
    expect(labels.some((l) => /Config & debug/.test(l))).toBe(false);
    expect(labels.some((l) => /Basic settings/.test(l))).toBe(false);
    expect(labels.some((l) => /Advanced settings/.test(l))).toBe(false);
  });

  it("reaches every former Config & debug action from the settings surface", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({
      appPurpose: "coding",
      providers: [{ id: "grok", connected: true }, { id: "codex", connected: false }],
    });
    const vscodeEnv = api.defaultEnv({
      isRemote: false,
      isDesktop: false,
      clientOwnsFontScale: false,
      ttsAvailable: true,
      steerSupported: true,
      providersKnown: true,
      remoteLinked: true,
      hostCaps: { relocateView: true, secondarySideBar: false, showOutput: true },
    });
    const ids = api.visibleRows(snapshot, vscodeEnv).map((row: { id: string }) => row.id);
    expect(ids).toEqual(expect.arrayContaining([
      "showThinking", "expandCommandOutputs", "steerByDefault",
      "soundNotifications", "processingSound",
      "readRepliesAloud", "summarizeRepliesAloud",
      "openGlobalConfig", "openProjectConfig", "showLogs",
      "openVsCodeSettings", "moveView",
    ]));
  });

  it("carries the routines frame through chat.js into the Routines page", () => {
    // The whole point of going through chat.js: settings.js is a VIEW over a
    // snapshot that chat.js builds, and `settingsSnapshot()` is a hand-written
    // field list. A message can be handled, stored on `state`, and still never
    // reach the page — which is exactly what happened. Mounting settings.js
    // directly with a hand-built snapshot cannot see that gap, so this test
    // takes the same route the product does.
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    clickSettingsNav(h, "Routines");
    expect(h.posted).toContainEqual({ type: "listRoutines" });

    dispatch(h.window, {
      type: "routines",
      entries: [],
      projects: [{ cwd: "/w", label: "workspace" }],
      models: [
        { provider: "grok", model: "", label: "Grok default" },
        { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
    });

    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("No routines yet");
    click(h.window, overlay.querySelector(".settings-routine-new")!);

    const projects = [...overlay.querySelectorAll('[data-field="cwd"] option')].map((o) => o.textContent);
    expect(projects).toEqual(["workspace"]);
    const models = [...overlay.querySelectorAll('[data-field="model"] option')].map((o) => o.textContent);
    expect(models).toEqual(["Grok default", "Claude Opus 5"]);
    // A provider with no cached model list still offers its default, so an
    // empty picker can only mean no provider at all — never "no model".
    expect(overlay.textContent).not.toContain("No model is connected");
  });

  it("keeps the scroll position when a host frame repaints the page", () => {
    // Every repaint rebuilds the whole surface. Clicking Connect makes the host
    // answer with a fresh mcpConnectors frame, and without this the row the
    // user just clicked jumps off the top of the screen.
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const body = h.doc.querySelector("#settings-overlay .settings-body") as HTMLElement;
    expect(body).toBeTruthy();
    Object.defineProperty(body, "scrollTop", { value: 420, writable: true, configurable: true });

    dispatch(h.window, { type: "mcpConnectors", connectors: [] });
    const after = h.doc.querySelector("#settings-overlay .settings-body") as HTMLElement;
    expect(after.scrollTop).toBe(420);
  });

  it("shows a quota refusal on the Routines page, not only in the transcript", () => {
    // A quota-refused save never reaches the host, so the host never answers.
    // The relay bounces a plain `error`, which renders in the transcript —
    // behind the settings overlay. At the paywall that made Create look like it
    // did nothing, which is the worst possible moment to be silent.
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    clickSettingsNav(h, "Routines");
    dispatch(h.window, { type: "routines", entries: [], projects: [{ cwd: "/w", label: "w" }], models: [{ provider: "grok", model: "", label: "Grok default" }] });

    const overlay = h.doc.getElementById("settings-overlay")!;
    click(h.window, overlay.querySelector(".settings-routine-new")!);
    click(h.window, overlay.querySelector(".settings-routine-save")!);

    dispatch(h.window, { type: "error", text: "Free plan limit reached (100 messages this week). Resets in 3d." });

    expect(overlay.textContent).toContain("Free plan limit reached");
    // And the form stays put, so the typed prompt is not lost.
    expect(overlay.querySelector(".settings-routine.is-new")).toBeTruthy();
  });

  it("labels a key connector's docs link from its own URL", () => {
    // This line was hardcoded to "github.com/settings/personal-access-tokens"
    // under EVERY key connector, so Zapier told its users to go to GitHub.
    const api = loadSettings();
    expect(api.keyDocsLabel("https://mcp.zapier.com/")).toBe("mcp.zapier.com");
    expect(api.keyDocsLabel("https://github.com/settings/personal-access-tokens"))
      .toBe("github.com/settings/personal-access-tokens");
    expect(api.keyDocsLabel("http://example.test/a/b/")).toBe("example.test/a/b");
    expect(api.keyDocsLabel("")).toBe("");
  });

  it("says no PROVIDER is connected when the model list is empty", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    clickSettingsNav(h, "Routines");
    dispatch(h.window, { type: "routines", entries: [], projects: [], models: [] });
    const overlay = h.doc.getElementById("settings-overlay")!;
    click(h.window, overlay.querySelector(".settings-routine-new")!);
    expect(overlay.textContent).toContain("No provider connected");
  });

  it("loads a read-only Grok inventory on the Connectors page and marks managed servers", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    expect(h.posted).toContainEqual({ type: "listMcpServers" });
    dispatch(h.window, {
      type: "mcpServers",
      servers: [
        { name: "managed_gateway:canva", displayName: "Canva", managed: true, enabled: true, status: "ready", toolCount: 32, scopeName: "Grok CLI" },
        { name: "linear", enabled: false, status: "ready", toolCount: 0, source: "local", configFile: "config.toml" },
      ],
      warning: "This list is read-only. Connector enable/disable is machine-global and is not controlled here.",
    });
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("On this computer");
    expect(overlay.textContent).toContain("Grok.com connectors");
    expect(overlay.textContent).toContain("Local Grok connectors");
    expect(overlay.textContent).toContain("Canva");
    expect(overlay.textContent).toContain("Grok CLI");
    expect(overlay.textContent).not.toContain("grok.com managed");
    expect(overlay.textContent).toContain("32 tools");
    expect(overlay.textContent).toContain("Disabled · ready · 0 tools");
    const lists = overlay.querySelectorAll('[data-id="mcpCatalog"] .settings-mcp-list');
    const localStatus = lists[1]?.querySelector(".settings-mcp-status");
    expect(localStatus?.classList.contains("is-ready")).toBe(false);
    expect(overlay.textContent).toMatch(/follow your Grok account/);
    expect(overlay.textContent).toMatch(/Grok config files/);
    expect(overlay.querySelector(".settings-switch")).toBeNull();
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "setMcpServerEnabled" }));
    const grokLink = overlay.querySelector(".settings-mcp-web") as HTMLButtonElement;
    expect(grokLink).toBeTruthy();
    expect(grokLink.textContent).toContain("Open");
    expect(grokLink.innerHTML).toContain("M15 3h6v6");
    h.posted.length = 0;
    click(h.window, grokLink);
    expect(h.posted).toContainEqual({ type: "openUrl", url: "https://grok.com/connectors" });
    const fileOpen = overlay.querySelector(".settings-mcp-open") as HTMLButtonElement;
    expect(fileOpen).toBeTruthy();
    expect(fileOpen.textContent).toContain("Open");
    expect(fileOpen.querySelector("img")).toBeNull();
    expect(fileOpen.querySelector("svg")).toBeTruthy();
    expect(fileOpen.innerHTML).toContain("M12.22 2h-.44");
    expect(fileOpen.closest(".settings-group-row")).toBeTruthy();
    expect(overlay.querySelectorAll(".settings-mcp-list .settings-mcp-open")).toHaveLength(0);
    click(h.window, fileOpen);
    expect(h.posted).toContainEqual({ type: "openGlobalConfig" });
  });

  it("marks an enabled local server ready when its inventory omits health status", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    dispatch(h.window, {
      type: "mcpServers",
      servers: [{
        name: "chrome-devtools",
        source: "local",
        enabled: true,
        command: "npx",
        args: ["chrome-devtools-mcp@latest"],
      }],
      warning: "This list is read-only.",
    });
    const row = h.doc.querySelector('[data-id="mcpCatalog"] .settings-mcp-list .settings-mcp-server')!;
    expect(row.querySelector(".settings-mcp-status")?.classList.contains("is-ready")).toBe(true);
    expect(row.textContent).not.toContain("Disabled");
    expect(row.textContent).toContain("npx chrome-devtools-mcp@latest");
  });

  it("shows Local Open in the section header even when the section is empty", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    dispatch(h.window, {
      type: "mcpServers",
      servers: [],
      warning: "This list is read-only.",
    });
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("Local Grok connectors");
    expect(overlay.textContent).toContain("No local Grok connectors reported.");
    const localHeads = [...overlay.querySelectorAll(".settings-group-row")]
      .filter((row) => (row.textContent || "").includes("Local Grok connectors"));
    expect(localHeads).toHaveLength(1);
    const fileOpen = localHeads[0]!.querySelector(".settings-mcp-open") as HTMLButtonElement;
    expect(fileOpen).toBeTruthy();
    expect(fileOpen.textContent).toContain("Open");
    h.posted.length = 0;
    click(h.window, fileOpen);
    expect(h.posted).toContainEqual({ type: "openGlobalConfig" });
  });

  it("puts a managed row in grok.com with scopeName and a user-level row in local, never a project row", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    dispatch(h.window, {
      type: "mcpServers",
      servers: [
        { name: "notes", displayName: "Notes", source: "local", configFile: "config.toml", enabled: true, status: "ready" },
        { name: "managed_gateway:linear", displayName: "Linear", source: "managed", scopeName: "Grok CLI", enabled: true, status: "ready" },
      ],
      warning: "This list is read-only.",
    });
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).not.toContain("User on: Mac (macOS)");
    expect(overlay.textContent).not.toMatch(/\btag\b/i);
    expect(overlay.querySelector(".settings-mcp-badge")).toBeNull();
    expect(overlay.textContent).toContain("Grok CLI");
    expect(overlay.textContent).toContain("Notes");
    expect(overlay.textContent).toContain("Linear");
    expect(overlay.textContent).not.toMatch(/Project:/);
    expect(overlay.textContent).not.toContain("Docs");
    const lists = [...overlay.querySelectorAll(".settings-mcp-list")];
    expect(lists).toHaveLength(2);
    expect(lists[0]!.textContent).toContain("Linear");
    expect(lists[0]!.textContent).toContain("Grok CLI");
    expect(lists[0]!.textContent).not.toContain("Notes");
    expect(lists[1]!.textContent).toContain("Notes");
    expect(lists[1]!.textContent).not.toContain("Linear");
  });

  it("connects and disconnects host-owned connectors from Settings", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        { id: "linear", name: "Linear", description: "Issues.", endpoint: "https://mcp.linear.app/mcp", connected: false, status: "idle" },
        { id: "canva", name: "Canva", description: "Designs.", endpoint: "https://mcp.canva.com/mcp", connected: true, status: "idle" },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("Linear");
    expect(overlay.textContent).toContain("Canva");
    h.posted.length = 0;
    const connect = [...overlay.querySelectorAll(".settings-connector-action")]
      .find((btn) => (btn as HTMLElement).dataset.id === "linear") as HTMLButtonElement;
    expect(connect.textContent).toBe("Connect");
    click(h.window, connect);
    expect(h.posted).toContainEqual({ type: "connectMcpConnector", id: "linear" });
    const disconnect = [...overlay.querySelectorAll(".settings-connector-action")]
      .find((btn) => (btn as HTMLElement).dataset.id === "canva") as HTMLButtonElement;
    expect(disconnect.textContent).toBe("Disconnect");
    click(h.window, disconnect);
    expect(h.posted).toContainEqual({ type: "disconnectMcpConnector", id: "canva" });
  });

  it("GitHub Connect opens a paste field instead of posting immediately", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    const planted = "ghp_TESTSECRET_do_not_store";
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        {
          id: "github",
          name: "GitHub",
          description: "Repos.",
          endpoint: "https://api.githubcopilot.com/mcp/",
          connected: false,
          status: "idle",
          auth: "key",
          keySet: false,
          keyHint: "Paste a GitHub personal access token. Fine-grained tokens are recommended; classic tokens also work.",
          keyDocsUrl: "https://github.com/settings/personal-access-tokens",
        },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toMatch(/fine-grained/i);
    expect(overlay.querySelector(".settings-connector-key-input")).toBeNull();
    h.posted.length = 0;
    const connect = [...overlay.querySelectorAll(".settings-connector-action")]
      .find((btn) => (btn as HTMLElement).dataset.id === "github") as HTMLButtonElement;
    expect(connect.textContent).toBe("Connect");
    click(h.window, connect);
    expect(h.posted).toEqual([]);
    const input = overlay.querySelector(".settings-connector-key-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe("password");
    input.value = planted;
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    const box = overlay.querySelector(".settings-connector-readonly-input") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    click(h.window, overlay.querySelector(".settings-connector-key-submit") as HTMLButtonElement);
    expect(h.posted).toContainEqual({
      type: "connectMcpConnector",
      id: "github",
      key: planted,
      readOnly: true,
    });
    expect((overlay.querySelector(".settings-connector-key-input") as HTMLInputElement | null)?.value || "").toBe("");
    expect(overlay.textContent).not.toContain(planted);
  });

  it("a connected GitHub row without a key on this host stays connected and offers a paste", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    const planted = "ghp_TESTSECRET_do_not_store";
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        {
          id: "github",
          name: "GitHub",
          description: "Repos.",
          endpoint: "https://api.githubcopilot.com/mcp/",
          connected: true,
          status: "idle",
          auth: "key",
          keySet: false,
          keyHint: "Paste a GitHub personal access token.",
          keyDocsUrl: "https://github.com/settings/personal-access-tokens",
        },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.querySelector('[data-id="connector-github"]')!.classList.contains("is-connected")).toBe(true);
    expect(overlay.textContent).toMatch(/no key on this machine/i);
    expect(overlay.textContent).not.toContain("Key is set");
    expect(overlay.textContent).not.toContain(planted);
    expect(overlay.querySelector(".settings-connector-key-input")).toBeNull();
    expect(overlay.querySelector(".settings-connector-readonly-live")).toBeNull();
    const disconnect = [...overlay.querySelectorAll(".settings-connector-action")]
      .find((btn) => (btn as HTMLElement).dataset.id === "github") as HTMLButtonElement;
    expect(disconnect.textContent).toBe("Disconnect");
    const paste = overlay.querySelector(".settings-connector-key-open") as HTMLButtonElement;
    expect(paste.textContent).toBe("Paste token");
    h.posted.length = 0;
    click(h.window, disconnect);
    expect(h.posted).toContainEqual({ type: "disconnectMcpConnector", id: "github" });
    click(h.window, paste);
    expect(h.posted).toEqual([{ type: "disconnectMcpConnector", id: "github" }]);
    const input = overlay.querySelector(".settings-connector-key-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("");
    input.value = planted;
    input.dispatchEvent(new h.window.Event("input", { bubbles: true }));
    click(h.window, overlay.querySelector(".settings-connector-key-submit") as HTMLButtonElement);
    expect(h.posted).toContainEqual({
      type: "connectMcpConnector",
      id: "github",
      key: planted,
      readOnly: false,
    });
    expect((overlay.querySelector(".settings-connector-key-input") as HTMLInputElement | null)?.value || "").toBe("");
    expect(overlay.textContent).not.toContain(planted);
  });

  it("a connected GitHub row shows that a key is set and never renders it", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    const planted = "ghp_TESTSECRET_do_not_store";
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        {
          id: "github",
          name: "GitHub",
          description: "Repos.",
          endpoint: "https://api.githubcopilot.com/mcp/",
          connected: true,
          status: "idle",
          auth: "key",
          keySet: true,
          keyHint: "Paste a GitHub personal access token.",
          readOnly: false,
        },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("Key is set");
    expect(overlay.textContent).not.toContain(planted);
    expect(overlay.querySelector(".settings-connector-key-input")).toBeNull();
    const disconnect = [...overlay.querySelectorAll(".settings-connector-action")]
      .find((btn) => (btn as HTMLElement).dataset.id === "github") as HTMLButtonElement;
    expect(disconnect.textContent).toBe("Disconnect");
    h.posted.length = 0;
    click(h.window, disconnect);
    expect(h.posted).toContainEqual({ type: "disconnectMcpConnector", id: "github" });
    const replace = overlay.querySelector(".settings-connector-key-open") as HTMLButtonElement;
    expect(replace.textContent).toBe("Replace");
    click(h.window, replace);
    expect(overlay.querySelector(".settings-connector-key-input")).toBeTruthy();
    expect((overlay.querySelector(".settings-connector-key-input") as HTMLInputElement).value).toBe("");
  });

  it("an older host without the capability offers no remote key controls", () => {
    const h = bootWebview({ remote: true });
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        {
          id: "github",
          name: "GitHub",
          description: "Repos.",
          endpoint: "https://api.githubcopilot.com/mcp/",
          connected: true,
          status: "idle",
          auth: "key",
          keySet: true,
        },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.querySelector(".settings-connector-action")).toBeNull();
    expect(overlay.querySelector(".settings-connector-key-input")).toBeNull();
    expect(overlay.querySelector(".settings-connector-key-open")).toBeNull();
    expect(overlay.querySelector(".settings-connector-readonly-input")).toBeNull();
    expect(overlay.textContent).toContain("Connected");
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "connectMcpConnector" }));
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "disconnectMcpConnector" }));
  });

  it("a capable remote writes and replaces a key without ever reading one back", () => {
    const h = bootWebview({ remote: true });
    seedChat(h, { capabilities: { mcpSettings: true } });
    const row = { id: "github", name: "GitHub", description: "Repos.", auth: "key", status: "idle", connected: false };
    dispatch(h.window, { type: "mcpConnectors", remoteConnect: true, connectors: [row] });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    click(h.window, overlay.querySelector(".settings-connector-action")!);
    const input = overlay.querySelector(".settings-connector-key-input") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    input.value = "ghp_remote_write_only";
    click(h.window, overlay.querySelector(".settings-connector-key-submit")!);
    expect(h.posted).toContainEqual({ type: "connectMcpConnector", id: "github", key: "ghp_remote_write_only", readOnly: false });
    expect(input.value).toBe("");
    dispatch(h.window, { type: "mcpConnectors", remoteConnect: true, connectors: [{ ...row, connected: true, keySet: true }] });
    expect(overlay.textContent).toContain("Tools in already running sessions remain available");
    click(h.window, overlay.querySelector(".settings-connector-key-open")!);
    expect((overlay.querySelector(".settings-connector-key-input") as HTMLInputElement).value).toBe("");
    click(h.window, overlay.querySelector(".settings-connector-key-cancel")!);
    click(h.window, overlay.querySelector(".settings-connector-action")!);
    expect(h.posted).toContainEqual({ type: "disconnectMcpConnector", id: "github" });
    expect(overlay.innerHTML).not.toContain("ghp_remote_write_only");
  });

  it("a capable remote opens its consent link and posts the failed address for manual completion", () => {
    const h = bootWebview({ remote: true });
    seedChat(h, { capabilities: { mcpSettings: true } });
    const row = { id: "notion", name: "Notion", description: "Pages.", auth: "oauth", status: "idle", connected: false };
    dispatch(h.window, { type: "mcpConnectors", remoteConnect: true, connectors: [row] });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    click(h.window, overlay.querySelector(".settings-connector-action")!);
    expect(h.posted).toContainEqual({ type: "connectMcpConnector", id: "notion" });
    const consent = { type: "mcpConnectorAuthorization", id: "notion", attemptId: "attempt-1", status: "waiting", url: "https://vendor.example/authorize?state=test" };
    dispatch(h.window, consent);
    const link = overlay.querySelector(".settings-connector-oauth-link") as HTMLAnchorElement;
    expect(link.href).toBe(consent.url);
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(overlay.textContent).toMatch(/probably fail to load/);
    // The consent link is the FIRST thing to act on, and it did not read that
    // way when it was link-coloured prose sitting beside a paste box — the box
    // looked like the control and the link went unclicked. Pin both halves of
    // the remedy: it is a primary button, and the steps are numbered in order.
    expect(link.className).toContain("is-primary");
    const steps = [...overlay.querySelectorAll(".settings-connector-oauth-step")]
      .map((el) => el.textContent);
    expect(steps).toEqual(["Step 1", "Step 2"]);
    const form = link.closest(".settings-connector-oauth")!;
    const order = [...form.querySelectorAll(".settings-connector-oauth-step, .settings-connector-oauth-link, .settings-connector-oauth-input")]
      .map((el) => el.className.split(" ").pop());
    expect(order).toEqual([
      "settings-connector-oauth-step",
      "settings-connector-oauth-link",
      "settings-connector-oauth-step",
      "settings-connector-oauth-input",
    ]);
    const input = overlay.querySelector(".settings-connector-oauth-input") as HTMLInputElement;
    input.value = "http://localhost:22227/oauth/callback?code=abc&state=test";
    click(h.window, overlay.querySelector(".settings-connector-oauth-submit")!);
    expect(h.posted).toContainEqual({ type: "completeMcpConnectorOAuth", id: "notion", attemptId: "attempt-1", redirectUrl: "http://localhost:22227/oauth/callback?code=abc&state=test" });
    expect(input.value).toBe("");
    expect(overlay.textContent).toMatch(/Completing sign-in/);
    dispatch(h.window, { ...consent, error: "Use the current sign-in link (state does not match)." });
    expect(overlay.textContent).toMatch(/state does not match/);
    expect(overlay.querySelector(".settings-connector-oauth-input")).toBeTruthy();
    dispatch(h.window, { ...consent, status: "finished", url: undefined });
    expect(overlay.querySelector(".settings-connector-oauth")).toBeNull();
    // Switching back to a host that lacks the field must drop the capability.
    dispatch(h.window, { type: "mcpConnectors", connectors: [row] });
    expect(overlay.querySelector(".settings-connector-action")).toBeNull();
  });

  it("a remote sees a connected GitHub row without a desk key as connected, with no paste", () => {
    const h = bootWebview({ remote: true });
    seedChat(h, { capabilities: { mcpSettings: true } });
    const planted = "ghp_TESTSECRET_do_not_store";
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        {
          id: "github",
          name: "GitHub",
          description: "Repos.",
          endpoint: "https://api.githubcopilot.com/mcp/",
          connected: true,
          status: "idle",
          auth: "key",
          keySet: false,
        },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.querySelector('[data-id="connector-github"]')!.classList.contains("is-connected")).toBe(true);
    expect(overlay.textContent).toContain("Connected");
    expect(overlay.textContent).toMatch(/no key on the desk/i);
    expect(overlay.textContent).not.toContain(planted);
    expect(overlay.querySelector(".settings-connector-action")).toBeNull();
    expect(overlay.querySelector(".settings-connector-key-input")).toBeNull();
    expect(overlay.querySelector(".settings-connector-key-open")).toBeNull();
    expect(overlay.querySelector(".settings-connector-readonly-input")).toBeNull();
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "connectMcpConnector" }));
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "disconnectMcpConnector" }));
  });

  it("shows connectors read-only on a remote and never posts connect", () => {
    const h = bootWebview({ remote: true });
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        { id: "linear", name: "Linear", description: "Issues.", endpoint: "https://mcp.linear.app/mcp", connected: true, status: "idle" },
      ],
    });
    openSettings(h);
    const nav = settingsNav(h).map((el) => (el.textContent || "").trim());
    expect(nav).toContain("Connectors");
    expect(nav).not.toContain("MCP servers");
    clickSettingsNav(h, "Connectors");
    dispatch(h.window, {
      type: "mcpServers",
      servers: [
        { name: "notes", displayName: "Notes", source: "local", configFile: "config.toml", enabled: true, status: "ready" },
      ],
      warning: "This list is read-only.",
    });
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("Linear");
    expect(overlay.textContent).toContain("Notes");
    expect(overlay.textContent).toMatch(/machine running this workspace/);
    expect(overlay.querySelector(".settings-connector-action")).toBeNull();
    expect(overlay.textContent).toContain("Connected");
    expect(overlay.textContent).toContain("On this computer");
    expect(overlay.textContent).toContain("Grok.com connectors");
    expect(overlay.textContent).toContain("Local Grok connectors");
    expect(overlay.textContent).toMatch(/managed on the host machine only/);
    expect(overlay.querySelector(".settings-mcp-open")).toBeNull();
    expect(overlay.querySelector('[data-id="mcpCatalog"]')).toBeTruthy();
    expect(overlay.querySelector(".settings-mcp-web")).toBeTruthy();
    expect(overlay.querySelector(".settings-refresh")).toBeTruthy();
    expect(h.posted).toContainEqual({ type: "listMcpServers" });
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "connectMcpConnector" }));
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "disconnectMcpConnector" }));
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: "openGlobalConfig" }));
  });

  it("renders On this computer connected first, each group alphabetical", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        { id: "stripe", name: "Stripe", description: "Pay.", endpoint: "https://mcp.stripe.com", connected: false, status: "idle" },
        { id: "linear", name: "Linear", description: "Issues.", endpoint: "https://mcp.linear.app/mcp", connected: true, status: "idle" },
        { id: "canva", name: "Canva", description: "Designs.", endpoint: "https://mcp.canva.com/mcp", connected: true, status: "idle" },
        { id: "atlassian", name: "Atlassian", description: "Jira.", endpoint: "https://mcp.atlassian.com/v1/mcp/authv2", connected: false, status: "idle" },
        { id: "calendly", name: "Calendly", description: "Meetings.", endpoint: "https://mcp.calendly.com", connected: false, status: "idle" },
        { id: "airtable", name: "Airtable", description: "Bases.", endpoint: "https://mcp.airtable.com/mcp", connected: false, status: "idle" },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    const ids = [...overlay.querySelectorAll(".settings-connector")].map((row) => (row as HTMLElement).dataset.id);
    expect(ids).toEqual([
      "connector-canva",
      "connector-linear",
      "connector-airtable",
      "connector-atlassian",
      "connector-calendly",
      "connector-stripe",
    ]);
  });

  it("uses the lucide settings gear on Local Open and leaves Grok.com as an external link", () => {
    const h = bootWebview();
    seedChat(h, { capabilities: { mcpSettings: true } });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    const localHeads = [...overlay.querySelectorAll(".settings-group-row")]
      .filter((row) => (row.textContent || "").includes("Local Grok connectors"));
    const localOpen = localHeads[0]!.querySelector(".settings-mcp-open") as HTMLButtonElement;
    expect(localOpen.querySelector("img")).toBeNull();
    expect(localOpen.innerHTML).toContain("M12.22 2h-.44");
    const grokOpen = overlay.querySelector(".settings-mcp-web") as HTMLButtonElement;
    expect(grokOpen.innerHTML).toContain("M15 3h6v6");
    expect(grokOpen.innerHTML).not.toContain("M12.22 2h-.44");
  });

  it("leaves a connector row with no logo looking like a normal row", () => {
    const h = bootWebview({
      beforeScripts(window) {
        const script = window.document.createElement("script");
        script.src = "https://localhost/media/settings.js";
        window.document.head.appendChild(script);
      },
    });
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        { id: "custom-tool", name: "Custom tool", description: "Not a vendor.", endpoint: "https://example.test/mcp", connected: false, status: "idle" },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    const row = overlay.querySelector('[data-id="connector-custom-tool"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Custom tool");
    expect(row.querySelector(".settings-connector-logo")).toBeNull();
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".settings-row-title")!.classList.contains("has-logo")).toBe(false);
  });

  it("renders a connector with no vendor mark without a blank logo slot", () => {
    const h = bootWebview({
      beforeScripts(window) {
        const script = window.document.createElement("script");
        script.src = "https://localhost/media/settings.js";
        window.document.head.appendChild(script);
      },
    });
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        // Every shipped catalog id now has a mark, so the no-mark path needs a
        // synthetic row. It is the fallback that matters, not the vendor.
        { id: "nomark", name: "No Mark", description: "Has no vendor logo.", endpoint: "https://example.invalid/mcp", connected: false, status: "idle" },
        { id: "linear", name: "Linear", description: "Issues.", endpoint: "https://mcp.linear.app/mcp", connected: true, status: "idle" },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    for (const id of ["nomark"]) {
      const row = overlay.querySelector(`[data-id="connector-${id}"]`) as HTMLElement;
      expect(row).toBeTruthy();
      expect(row.querySelector(".settings-connector-logo")).toBeNull();
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector(".settings-row-title")!.classList.contains("has-logo")).toBe(false);
    }
    expect(overlay.querySelector('[data-id="connector-linear"] .settings-connector-logo')).toBeTruthy();
  });

  it("drops a failed vendor mark instead of leaving an empty chip", () => {
    const h = bootWebview({
      beforeScripts(window) {
        const script = window.document.createElement("script");
        script.src = "https://localhost/media/settings.js";
        window.document.head.appendChild(script);
      },
    });
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        { id: "linear", name: "Linear", description: "Issues.", endpoint: "https://mcp.linear.app/mcp", connected: true, status: "idle" },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    const overlay = h.doc.getElementById("settings-overlay")!;
    const row = overlay.querySelector('[data-id="connector-linear"]') as HTMLElement;
    const chip = row.querySelector(".settings-connector-logo") as HTMLElement;
    const img = chip.querySelector("img") as HTMLImageElement;
    expect(chip.classList.contains("is-ready")).toBe(false);
    expect(img.src).toContain("connector-logos/linear.webp");
    expect(img.alt).toBe("");
    img.dispatchEvent(new h.window.Event("load"));
    expect(chip.classList.contains("is-ready")).toBe(true);
    img.dispatchEvent(new h.window.Event("error"));
    expect(row.querySelector(".settings-connector-logo")).toBeNull();
    expect(row.querySelector("img")).toBeNull();
    expect(row.textContent).toContain("Linear");
    expect(row.querySelector(".settings-row-title")!.classList.contains("has-logo")).toBe(false);
  });

  it("does not put vendor marks on Grok.com or Local rows", () => {
    const h = bootWebview({
      beforeScripts(window) {
        const script = window.document.createElement("script");
        script.src = "https://localhost/media/settings.js";
        window.document.head.appendChild(script);
      },
    });
    seedChat(h, { capabilities: { mcpSettings: true } });
    dispatch(h.window, {
      type: "mcpConnectors",
      connectors: [
        { id: "linear", name: "Linear", description: "Issues.", endpoint: "https://mcp.linear.app/mcp", connected: true, status: "idle" },
      ],
    });
    openSettings(h);
    clickSettingsNav(h, "Connectors");
    dispatch(h.window, {
      type: "mcpServers",
      servers: [
        { name: "notes", displayName: "Notes", source: "local", configFile: "config.toml", enabled: true, status: "ready" },
        { name: "managed_gateway:linear", displayName: "Linear", source: "managed", scopeName: "Grok CLI", enabled: true, status: "ready" },
      ],
    });
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.querySelector('[data-id="connector-linear"] .settings-connector-logo')).toBeTruthy();
    const lists = [...overlay.querySelectorAll(".settings-mcp-list")];
    const grokList = lists.find((list) => list.textContent?.includes("Grok CLI"));
    const localList = lists.find((list) => list.textContent?.includes("Notes"));
    expect(grokList!.querySelector(".settings-connector-logo")).toBeNull();
    expect(localList!.querySelector(".settings-connector-logo")).toBeNull();
  });

  it("hides healthy provider rows in the gear and shows them when attention is needed", () => {
    const h = bootWebview();
    seedChat(h);
    click(h.window, h.doc.getElementById("gear-btn")!);
    expect(gearLabels(h).some((l) => /Grok/.test(l) && /Sign out/.test(l))).toBe(false);

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: false },
        { id: "codex", connected: false },
      ],
    });
    click(h.window, h.doc.getElementById("gear-btn")!);
    click(h.window, h.doc.getElementById("gear-btn")!);
    expect(gearLabels(h).join(" ")).toMatch(/Grok/);
    expect(gearLabels(h).join(" ")).toMatch(/Connect/);

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true, needsLogin: true },
        { id: "codex", connected: true },
      ],
    });
    click(h.window, h.doc.getElementById("gear-btn")!);
    click(h.window, h.doc.getElementById("gear-btn")!);
    // Codex is healthy here, so SOMETHING can answer and the gear stops
    // carrying accounts entirely — Settings → Providers owns them (owner,
    // 2026-08-17). Previously a single lapsed account kept a half-broken
    // Accounts list in the quick menu even on a working setup.
    expect(gearLabels(h).join(" ")).not.toMatch(/Sign in again/);
    expect(gearLabels(h).some((l) => /^(Connect|Sign out)$/.test(l.trim()))).toBe(false);

    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true },
      ],
    });
    click(h.window, h.doc.getElementById("gear-btn")!);
    click(h.window, h.doc.getElementById("gear-btn")!);
    expect(gearLabels(h).some((l) => /Sign out/.test(l))).toBe(false);
  });

  it("edits the send phrase and dictionary terms from Voice", () => {
    const h = bootWebview();
    seedChat(h);
    dispatch(h.window, { type: "voiceConfigured", value: true, sendPhrase: "grok send", keyterms: ["useEffect"] });
    openSettings(h);
    clickSettingsNav(h, "Voice");
    h.posted.length = 0;
    const phrase = h.doc.querySelector('[data-id="voiceSendPhrase"] .settings-text') as HTMLInputElement;
    expect(phrase.value).toBe("grok send");
    phrase.value = "ok send";
    phrase.dispatchEvent(new h.window.Event("change", { bubbles: true }));
    expect(h.posted).toContainEqual({ type: "setVoiceSendPhrase", value: "ok send" });

    h.posted.length = 0;
    const tags = h.doc.querySelector('[data-id="voiceKeyterms"] .settings-tags-input') as HTMLInputElement;
    expect(h.doc.querySelector('[data-id="voiceKeyterms"]')!.textContent).toContain("useEffect");
    tags.value = "Get-ChildItem";
    tags.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(h.posted).toContainEqual({
      type: "setVoiceKeyterms",
      value: ["useEffect", "Get-ChildItem"],
    });
  });

  it("shows a desktop telemetry toggle and a remote read-only row with the privacy copy", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({ telemetryEnabled: true });
    const desk = api.visibleRows(snapshot, api.defaultEnv(fullEnv({ isDesktop: true }))).map((r) => r.id);
    expect(desk).toContain("telemetryDesktop");
    expect(desk).not.toContain("telemetryVsCode");
    expect(desk).not.toContain("telemetryRemote");
    const vscode = api.visibleRows(snapshot, api.defaultEnv(fullEnv({ isDesktop: false }))).map((r) => r.id);
    expect(vscode).toContain("telemetryVsCode");
    const remote = api.visibleRows(snapshot, api.defaultEnv(fullEnv({ isRemote: true }))).map((r) => r.id);
    expect(remote).toContain("telemetryRemote");
    expect(api.TELEMETRY_COPY).toContain("never prompts, code, file paths or names");
    expect(api.TELEMETRY_COPY).toContain("The IP address is discarded, never stored.");
  });

  it("orders General rows as purpose, text size, coding display, steer, stats, thumbs on every surface", () => {
    const api = loadSettings();
    const coding = api.defaultSnapshot({ appPurpose: "coding" });
    const generalIds = (env: Record<string, unknown>) =>
      api.visibleRows(coding, api.defaultEnv(env))
        .filter((row) => row.category === "general")
        .map((row) => row.id);
    expect(generalIds(fullEnv({ isDesktop: true, isRemote: false }))).toEqual([
      "appPurpose", "chatFontScale", "showThinking", "expandCommandOutputs", "steerByDefault",
      "telemetryDesktop", "thumbsFeedback",
    ]);
    expect(generalIds(fullEnv({ isDesktop: false, isRemote: false, clientOwnsFontScale: false }))).toEqual([
      "appPurpose", "openChatFontScale", "showThinking", "expandCommandOutputs", "steerByDefault",
      "telemetryVsCode", "thumbsFeedback",
    ]);
    expect(generalIds(fullEnv({ isDesktop: true, isRemote: true }))).toEqual([
      "appPurpose", "chatFontScale", "showThinking", "expandCommandOutputs", "steerByDefault",
      "telemetryRemote", "thumbsFeedbackRemote",
    ]);
  });

  it("offers Thumbs feedback to SpaceXAI on the desk, default off, next to usage stats", () => {
    const api = loadSettings();
    const row = api.ROWS.find((r: { id: string }) => r.id === "thumbsFeedback") as {
      id: string;
      category: string;
      title: string;
      defaultValue: boolean;
      kind: string;
    };
    expect(row).toMatchObject({
      category: "general",
      title: "Thumbs feedback to SpaceXAI",
      defaultValue: false,
      kind: "toggle",
    });
    const ids = api.ROWS.filter((r: { category: string }) => r.category === "general").map((r: { id: string }) => r.id);
    expect(ids.indexOf("thumbsFeedback")).toBeGreaterThan(ids.indexOf("telemetryRemote"));
    const snapshot = api.defaultSnapshot();
    expect(snapshot.thumbsFeedback).toBe(false);
    expect(api.THUMBS_COPY).toContain("send a rating to SpaceXAI");
    for (const env of [
      api.defaultEnv(fullEnv({ isDesktop: true, isRemote: false })),
      api.defaultEnv(fullEnv({ isDesktop: false, isRemote: false })),
    ]) {
      const visible = api.visibleRows(snapshot, env).map((r) => r.id);
      expect(visible).toContain("thumbsFeedback");
      expect(visible).not.toContain("thumbsFeedbackRemote");
    }
  });

  it("shows thumbs as a read-only status on remote so a tap cannot lie about the host setting", () => {
    const api = loadSettings();
    const remoteRow = api.ROWS.find((r: { id: string }) => r.id === "thumbsFeedbackRemote") as {
      id: string;
      kind: string;
      message?: unknown;
      describe: (s: unknown) => string;
    };
    expect(remoteRow).toMatchObject({ kind: "status" });
    expect(remoteRow.message).toBeUndefined();
    const snapshot = api.defaultSnapshot({ thumbsFeedback: true });
    const env = api.defaultEnv(fullEnv({ isRemote: true }));
    const visible = api.visibleRows(snapshot, env).map((r) => r.id);
    expect(visible).toContain("thumbsFeedbackRemote");
    expect(visible).not.toContain("thumbsFeedback");
    expect(remoteRow.describe(snapshot)).toMatch(/^On\. /);
    expect(remoteRow.describe(snapshot)).toContain(api.THUMBS_COPY);
    expect(remoteRow.describe(api.defaultSnapshot({ thumbsFeedback: false }))).toMatch(/^Off\. /);

    const posted: unknown[] = [];
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const grok = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    grok.mount(root, {
      snapshot,
      env,
      post: (msg: unknown) => posted.push(msg),
    });
    expect(root.querySelector('[data-id="thumbsFeedback"]')).toBeNull();
    const status = root.querySelector('[data-id="thumbsFeedbackRemote"]') as HTMLElement;
    expect(status).toBeTruthy();
    expect(status.querySelector(".settings-switch")).toBeNull();
    status.click();
    expect(posted).not.toContainEqual(expect.objectContaining({ type: "setThumbsFeedback" }));
  });
});

function keydown(window: Window, init: Record<string, unknown>) {
  const ev = new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
    "keydown",
    { bubbles: true, cancelable: true, ...init },
  );
  (window as unknown as { document: Document }).document.dispatchEvent(ev);
  return ev;
}

describe("settings overlay keyboard containment", () => {
  it("traps Shift+Tab from the first control inside the overlay and marks covered chat inert", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay")!;
    const back = overlay.querySelector(".settings-back") as HTMLElement;
    expect(back).toBeTruthy();
    back.focus();
    expect(h.doc.activeElement).toBe(back);

    const ev = keydown(h.window, { key: "Tab", shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(overlay.contains(h.doc.activeElement)).toBe(true);
    expect(h.doc.activeElement).not.toBe(back);
    expect(h.doc.activeElement).not.toBe(h.doc.getElementById("gear-btn"));
    expect(h.doc.activeElement).not.toBe(h.doc.getElementById("input"));

    const header = h.doc.querySelector("header");
    const main = h.doc.getElementById("messages");
    const footer = h.doc.querySelector("footer");
    expect(header?.hasAttribute("inert") || header?.getAttribute("aria-hidden") === "true").toBe(true);
    expect(main?.hasAttribute("inert") || main?.getAttribute("aria-hidden") === "true").toBe(true);
    expect(footer?.hasAttribute("inert") || footer?.getAttribute("aria-hidden") === "true").toBe(true);
    expect(overlay.hasAttribute("inert")).toBe(false);
  });

  it("keeps focus on the replacement control after paint()", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay")!;
    click(h.window, [...overlay.querySelectorAll(".settings-nav-item")].find((el) => (el.textContent || "").trim() === "General")!);
    const sw = overlay.querySelector('[data-id="showThinking"] .settings-switch') as HTMLElement;
    expect(sw).toBeTruthy();
    sw.focus();
    click(h.window, sw);
    const next = overlay.querySelector('[data-id="showThinking"] .settings-switch');
    expect(h.doc.activeElement).toBe(next);
    expect(h.doc.activeElement?.tagName).not.toBe("BODY");
  });

  it("Escape closes the overlay and returns focus to the gear button", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    expect(h.doc.getElementById("settings-overlay")).toBeTruthy();
    keydown(h.window, { key: "Escape" });
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(h.doc.activeElement).toBe(h.doc.getElementById("gear-btn"));
    expect(h.doc.querySelector("header")?.hasAttribute("inert")).toBe(false);
    expect(h.doc.querySelector("footer")?.getAttribute("data-settings-cover")).toBeNull();
  });

  it("puts a Back to app link above search on the overlay and closes like Escape", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay")!;
    const back = overlay.querySelector(".settings-back") as HTMLElement;
    const search = h.doc.getElementById("settings-search");
    expect(back).toBeTruthy();
    expect(back.textContent).toMatch(/←/);
    expect(back.textContent).toMatch(/Back to app/);
    expect(search).toBeTruthy();
    expect(
      !!(back.compareDocumentPosition(search!) & h.window.Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    const header = h.doc.querySelector("header");
    expect(header?.hasAttribute("inert") || header?.getAttribute("aria-hidden") === "true").toBe(true);
    click(h.window, back);
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(h.doc.activeElement).toBe(h.doc.getElementById("gear-btn"));
    expect(h.doc.querySelector("header")?.hasAttribute("inert")).toBe(false);
  });

  it("includes Back to app in the overlay focus trap", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    const overlay = h.doc.getElementById("settings-overlay")!;
    const focusable = [...overlay.querySelectorAll(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
    )].filter((el) => (el as HTMLElement).getAttribute("tabindex") !== "-1");
    const back = overlay.querySelector(".settings-back");
    expect(overlay.querySelector(".settings-close")).toBeNull();
    expect(focusable[0]).toBe(back);
    expect(focusable.some((el) => (el as HTMLElement).classList.contains("settings-close"))).toBe(false);
    (focusable[focusable.length - 1] as HTMLElement).focus();
    const ev = keydown(h.window, { key: "Tab" });
    expect(ev.defaultPrevented).toBe(true);
    expect(h.doc.activeElement).toBe(back);
  });
});

describe("settings tab has no overlay Back to app", () => {
  it("omits the Back to app link on the standalone VS Code tab", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    api.mount(root, {
      snapshot: api.defaultSnapshot(),
      env: api.defaultEnv(fullEnv({ isDesktop: false })),
      standalone: true,
      onClose: () => { /* tab close is host-owned */ },
    });
    expect(root.querySelector(".settings-back")).toBeNull();
    expect(root.querySelector(".settings-close")).toBeNull();
    expect(root.querySelector("#settings-search")).toBeTruthy();
  });
});

describe("settings surface layout pins", () => {
  const css = readFileSync(fileURLToPath(new URL("../media/settings.css", import.meta.url)), "utf8");

  it("uses the flexible row template and scrolls the content region", () => {
    expect(css).toMatch(/\.settings-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.settings-body\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/@media \(max-width: 799px\)/);
    expect(css).toMatch(/@media \(max-width: 520px\)/);
    expect(css).not.toMatch(/@media \(max-width: 640px\)/);
    expect(css).not.toMatch(/\.settings-close\b/);
  });
});

describe("settings restore skips disabled rows", () => {
  it("restoreTargets omits summarize while read-aloud is off", () => {
    const api = loadSettings();
    const snapshot = api.defaultSnapshot({
      readRepliesAloud: false,
      summarizeRepliesAloud: false,
    });
    const env = api.defaultEnv(fullEnv());
    const ids = api.restoreTargets("voice", snapshot, env).map((row) => row.id);
    expect(ids).toContain("readRepliesAloud");
    expect(ids).not.toContain("summarizeRepliesAloud");
    const summarize = api.ROWS.find((row: { id: string }) => row.id === "summarizeRepliesAloud");
    expect(api.rowEnabled(summarize, snapshot)).toBe(false);
  });

  it("never treats free-text or list inputs as restorable", () => {
    const api = loadSettings();
    expect(api.isRestorableKind({ kind: "toggle" })).toBe(true);
    expect(api.isRestorableKind({ kind: "select" })).toBe(true);
    expect(api.isRestorableKind({ kind: "range" })).toBe(true);
    expect(api.isRestorableKind({ kind: "text" })).toBe(false);
    expect(api.isRestorableKind({ kind: "tags" })).toBe(false);
    expect(api.isRestorableKind({ kind: "action" })).toBe(false);
    const snapshot = api.defaultSnapshot({
      voiceSendPhrase: "ok send",
      voiceKeyterms: ["useEffect"],
      readRepliesAloud: true,
    });
    const env = api.defaultEnv(fullEnv());
    const ids = api.restoreTargets("voice", snapshot, env).map((row) => row.id);
    expect(ids).not.toContain("voiceSendPhrase");
    expect(ids).not.toContain("voiceKeyterms");
    expect(ids).toContain("readRepliesAloud");
    expect(api.restoreChanges("voice", snapshot, env).map((row) => row.id)).toEqual(["readRepliesAloud"]);
  });

  it("hides Restore defaults when the page has nothing restorable to change", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    api.mount(root, {
      snapshot: api.defaultSnapshot({
        voiceSendPhrase: "custom send",
        voiceKeyterms: ["Get-ChildItem"],
        readRepliesAloud: false,
        summarizeRepliesAloud: false,
      }),
      env: api.defaultEnv(fullEnv({ ttsAvailable: true })),
      category: "voice",
      standalone: true,
    });
    expect(root.querySelector('[data-id="voiceSendPhrase"]')).toBeTruthy();
    expect(root.querySelector(".settings-restore")).toBeNull();
    expect(root.querySelector(".settings-restore-confirm")).toBeNull();
  });

  it("confirms Restore defaults in-surface, lists concrete targets, and cancel posts nothing", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const posted: Array<{ type: string; value?: unknown }> = [];
    api.mount(root, {
      snapshot: api.defaultSnapshot({
        readRepliesAloud: true,
        summarizeRepliesAloud: true,
        voiceSendPhrase: "ok send",
        voiceKeyterms: ["useEffect"],
      }),
      env: api.defaultEnv(fullEnv({ ttsAvailable: true })),
      category: "voice",
      post: (msg: { type: string; value?: unknown }) => posted.push(msg),
      standalone: true,
    });
    const restore = root.querySelector(".settings-restore") as HTMLElement;
    expect(restore).toBeTruthy();
    restore.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toEqual([]);
    const confirm = root.querySelector(".settings-restore-confirm") as HTMLElement;
    expect(confirm).toBeTruthy();
    expect(confirm.textContent).toContain("Read replies aloud → Off");
    expect(confirm.textContent).not.toMatch(/Send phrase/);
    expect(confirm.textContent).not.toMatch(/Dictionary/);
    expect(root.querySelector(".settings-restore")).toBeNull();

    const cancel = root.querySelector(".settings-restore-confirm-cancel") as HTMLElement;
    expect(cancel).toBeTruthy();
    cancel.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toEqual([]);
    expect(root.querySelector(".settings-restore-confirm")).toBeNull();
    expect(root.querySelector(".settings-restore")).toBeTruthy();
    expect((root.querySelector('[data-id="voiceSendPhrase"] .settings-text') as HTMLInputElement).value).toBe("ok send");
    expect(root.querySelector('[data-id="voiceKeyterms"]')!.textContent).toContain("useEffect");
  });

  it("Restore confirm applies only restorable rows and never posts voice text setters", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const posted: Array<{ type: string; value?: unknown }> = [];
    api.mount(root, {
      snapshot: api.defaultSnapshot({
        readRepliesAloud: true,
        summarizeRepliesAloud: false,
        voiceSendPhrase: "ok send",
        voiceKeyterms: ["useEffect"],
      }),
      env: api.defaultEnv(fullEnv({ ttsAvailable: true })),
      category: "voice",
      post: (msg: { type: string; value?: unknown }) => posted.push(msg),
      standalone: true,
    });
    const restore = root.querySelector(".settings-restore") as HTMLElement;
    restore.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const confirmText = root.querySelector(".settings-restore-confirm")!.textContent || "";
    expect(confirmText).toContain("Read replies aloud → Off");
    expect(confirmText).not.toContain("Read simplified summaries → On");
    (root.querySelector(".settings-restore-confirm-go") as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toContainEqual({ type: "setReadRepliesAloud", value: false });
    expect(posted.some((p) => p.type === "setVoiceSendPhrase")).toBe(false);
    expect(posted.some((p) => p.type === "setVoiceKeyterms")).toBe(false);
    expect((root.querySelector('[data-id="voiceSendPhrase"] .settings-text') as HTMLInputElement).value).toBe("ok send");
    expect(root.querySelector('[data-id="voiceKeyterms"]')!.textContent).toContain("useEffect");
    expect(root.querySelector(".settings-restore")).toBeNull();
    expect(root.querySelector(".settings-restore-confirm")).toBeNull();
  });

  it("Voice Restore defaults does not post setSummarizeRepliesAloud while the switch is disabled", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const posted: Array<{ type: string }> = [];
    api.mount(root, {
      snapshot: api.defaultSnapshot({
        soundNotifications: true,
        readRepliesAloud: false,
        summarizeRepliesAloud: false,
      }),
      env: api.defaultEnv(fullEnv({ ttsAvailable: true })),
      category: "notifications",
      post: (msg: { type: string }) => posted.push(msg),
      standalone: true,
    });
    const restore = root.querySelector(".settings-restore") as HTMLElement;
    expect(restore).toBeTruthy();
    restore.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    (root.querySelector(".settings-restore-confirm-go") as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(posted).toContainEqual({ type: "setSoundNotifications", value: false });
    expect(posted.some((p) => p.type === "setSummarizeRepliesAloud")).toBe(false);
  });
});

describe("review lows (settings / telemetry / voice write scope)", () => {
  it("closes Settings before opening How it works so the explainer owns focus", () => {
    const h = bootWebview();
    seedChat(h);
    dispatch(h.window, { type: "remoteStatus", linked: false });
    openSettings(h);
    clickSettingsNav(h, "Remote control");
    const btn = h.doc.querySelector('[data-id="remoteHowItWorks"] .settings-action') as HTMLElement;
    expect(btn).toBeTruthy();
    click(h.window, btn);
    expect(h.doc.getElementById("settings-overlay")).toBeNull();
    expect(h.doc.querySelector(".remote-explainer-panel")).toBeTruthy();
  });

  it("hides How it works on the VS Code settings tab", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    api.mount(root, {
      snapshot: api.defaultSnapshot(),
      env: api.defaultEnv(fullEnv({ isDesktop: false, remoteLinked: false })),
      standalone: true,
    });
    expect(root.querySelector('[data-id="remoteHowItWorks"]')).toBeNull();
  });

  it("broadcasts telemetryEnabled to every remote tab", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const start = src.indexOf("private static readonly DEVICE_GLOBAL_REMOTE_TYPES");
    const end = src.indexOf("]);", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("telemetryEnabled");
    expect(body).toContain("thumbsFeedback");
    expect(body).toContain("mcpConnectors");
    expect(body).toContain("mcpServers");
  });

  it("posts the stored global MCP view device-wide", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const start = src.indexOf("private postMcpServers");
    const end = src.indexOf("private connectedConnectorStore");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("this.post(view)");
    expect(body).toContain("this.mcpServersView");
    expect(body).not.toContain("this.sendRemoteRepo");
    expect(body).not.toContain("this.postLocal");
  });

  it("voice send-phrase and keyterms write the winning inspect scope", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const start = src.indexOf('case "setVoiceSendPhrase"');
    const end = src.indexOf('case "setTelemetryEnabled"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("voiceSettingWriteTarget");
    expect(body).not.toMatch(/update\(\s*"voiceSendPhrase"[\s\S]*"global"\s*\)/);
    expect(body).not.toMatch(/update\(\s*"voiceKeyterms"[\s\S]*"global"\s*\)/);
  });
});

describe("settings About section", () => {
  it("is the last category, has an info-circle icon, and keeps tracker/contact rows", () => {
    const api = loadSettings();
    expect(api.CATEGORIES.map((c) => c.id).at(-1)).toBe("about");
    expect(api.NAV_ICONS.about).toMatch(/<circle /);
    expect(api.NAV_ICONS.about).toMatch(/M12 16v-4/);
    const ids = api.ROWS.filter((r: { category: string }) => r.category === "about").map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["reportBug", "requestFeature", "contactSupport"]));
    expect(api.GITHUB_ISSUE_BUG_URL).toBe("https://github.com/phuryn/grok-build-vscode/issues/new?labels=bug");
    expect(api.GITHUB_ISSUE_FEATURE_URL).toBe("https://github.com/phuryn/grok-build-vscode/issues/new?labels=enhancement");
    expect(api.ROWS.find((r: { id: string }) => r.id === "reportBug")?.href).toBe(api.GITHUB_ISSUE_BUG_URL);
    expect(api.ROWS.find((r: { id: string }) => r.id === "requestFeature")?.href).toBe(api.GITHUB_ISSUE_FEATURE_URL);
    expect(api.SUPPORT_MAILTO).toBe("mailto:support@productcompass.pm");
  });

  it("puts the non-affiliation disclaimer only at the bottom of the About page", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    api.mount(root, {
      snapshot: api.defaultSnapshot({ extVersion: "1.4.0" }),
      env: api.defaultEnv(fullEnv()),
      category: "about",
      standalone: true,
    });
    const body = root.querySelector(".settings-body")!;
    const disclaimer = root.querySelector(".settings-about-disclaimer");
    expect(disclaimer).toBeTruthy();
    expect(disclaimer!.textContent).toContain(api.ABOUT_DISCLAIMER);
    expect(body.lastElementChild).toBe(disclaimer);
    expect(root.textContent).toContain("Report a bug");
    expect(root.textContent).toContain("Request a feature");
    expect(root.textContent).toContain("support@productcompass.pm");

    const general = doc.createElement("div");
    doc.body.appendChild(general);
    api.mount(general, {
      snapshot: api.defaultSnapshot(),
      env: api.defaultEnv(fullEnv()),
      category: "general",
      standalone: true,
    });
    expect(general.querySelector(".settings-about-disclaimer")).toBeNull();
  });
});

describe("settings editor tab dispose (sidebar.ts)", () => {
  it("installs the dispose listener before awaiting the device token", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    const start = src.indexOf("async openSettingsEditor(");
    const end = src.indexOf("private async onSettingsPanelMessage", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const disposeAt = body.indexOf("onDidDispose");
    const awaitAt = body.indexOf("await this.readDeviceToken()");
    expect(disposeAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(-1);
    expect(disposeAt).toBeLessThan(awaitAt);
    expect(body.indexOf("if (this.settingsEditor !== panel)", awaitAt)).toBeGreaterThan(awaitAt);
  });
});

/** Mount straight onto a page and record what the surface asks the host for. */
function mountAt(category: string, opts: {
  env?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
} = {}) {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const posted: Array<{ type: string }> = [];
  const surface = api.mount(root, {
    snapshot: api.defaultSnapshot(opts.snapshot),
    env: api.defaultEnv(fullEnv(opts.env)),
    category,
    post: (msg: { type: string }) => posted.push(msg),
    standalone: true,
  }) as unknown as { setCategory: (id: string) => void; update: (s: unknown) => void };
  const types = () => posted.map((msg) => msg.type);
  return { window, root, posted, types, surface };
}

describe("Providers refresh", () => {

  it("offers Refresh above the rows and asks the host on open", () => {
    const { root, types } = mountAt("providers");
    const button = root.querySelector(".settings-head-actions .settings-refresh") as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toBe("Refresh");
    expect(button.disabled).toBe(false);
    // Opening the page IS the request — that is the half the owner asked for
    // alongside the button.
    expect(types()).toEqual(["refreshProviders"]);
  });

  it("posts a refresh when the button is clicked", () => {
    const { window, root, posted, types } = mountAt("providers");
    posted.length = 0;
    const button = root.querySelector(".settings-refresh") as HTMLElement;
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(types()).toEqual(["refreshProviders"]);
  });

  it("says it is checking, driven only by what the host reports", () => {
    const { root, surface } = mountAt("providers");
    expect((root.querySelector(".settings-refresh") as HTMLButtonElement).disabled).toBe(false);
    surface.update({ providersChecking: true });
    const busy = root.querySelector(".settings-refresh") as HTMLButtonElement;
    expect(busy.textContent).toBe("Checking…");
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    surface.update({ providersChecking: false });
    const idle = root.querySelector(".settings-refresh") as HTMLButtonElement;
    expect(idle.textContent).toBe("Refresh");
    expect(idle.disabled).toBe(false);
    expect(idle.getAttribute("aria-busy")).toBeNull();
  });

  it("does not re-ask on every repaint, and asks again on a fresh visit", () => {
    const { posted, types, surface } = mountAt("providers");
    expect(types()).toEqual(["refreshProviders"]);
    // Host updates repaint the surface; a latch that leaked here would loop,
    // because the answer to a refresh is itself a providerState update.
    surface.update({ providers: [{ id: "grok", connected: true }] });
    surface.update({ providersChecking: true });
    surface.update({ providersChecking: false });
    expect(types()).toEqual(["refreshProviders"]);

    posted.length = 0;
    surface.setCategory("general");
    expect(types()).toEqual([]);
    surface.setCategory("providers");
    expect(types()).toEqual(["refreshProviders"]);
  });

  it("stays off the remote, where provider probing is the desk's business", () => {
    const { root, types } = mountAt("providers", { env: { isRemote: true } });
    expect(root.querySelector(".settings-refresh")).toBeNull();
    expect(types()).toEqual([]);
    // The rows themselves still render — a phone reads provider state, it just
    // cannot make the desk go looking. This host does not advertise
    // remoteAgentSignIn, so it is the read-only half of the pair.
    expect(root.querySelector('[data-id="providerGrokStatus"]')).toBeTruthy();
  });

  const signInCaps = { hostCaps: { relocateView: false, showOutput: false, toggleDevTools: true, remoteAgentSignIn: true } };

  it("offers Connect on a remote, and never Sign out", () => {
    // `runGrokLogin` from a remote is the headless device-code flow, so a phone
    // or a cloud environment can connect an agent from the page that lists them
    // — not only from the onboarding card. Signing OUT stays desk-only.
    const disconnected = mountAt("providers", {
      env: { isRemote: true, ...signInCaps },
      snapshot: { providers: [{ id: "grok", connected: false }] },
    });
    const action = disconnected.root.querySelector('[data-id="providerGrokRemote"] button');
    expect(action?.textContent).toBe("Connect");
    (action as HTMLButtonElement).click();
    expect(disconnected.types()).toContain("runGrokLogin");

    const connected = mountAt("providers", {
      env: { isRemote: true, ...signInCaps },
      snapshot: { providers: [{ id: "grok", connected: true }] },
    });
    expect(connected.root.querySelector('[data-id="providerGrokRemote"]')).toBeNull();
    expect(connected.root.querySelector('[data-id="providerGrokStatus"]')).toBeTruthy();
    expect(connected.root.querySelector('[data-id="providerGrokStatus"] button')).toBeNull();
  });

  it("offers Sign out on a cloud environment, where the remote is the only surface", () => {
    // `logout` is host-local everywhere else: it revokes a credential every
    // surface on that machine shares, and a phone must not do that to a desk.
    // A cloud box has no other surface, so a credential you can grant and never
    // revoke is the worse answer (owner, 2026-08-30).
    const cloudCaps = {
      hostCaps: {
        relocateView: false, showOutput: false, toggleDevTools: true,
        remoteAgentSignIn: true, remoteAgentSignOut: true,
      },
    };
    const h = mountAt("providers", {
      env: { isRemote: true, ...cloudCaps },
      snapshot: { providers: [{ id: "grok", connected: true }] },
    });
    const action = h.root.querySelector('[data-id="providerGrokRemote"] button');
    expect(action?.textContent).toBe("Sign out");
    (action as HTMLButtonElement).click();
    expect(h.types()).toContain("logout");
  });

  it("still refuses Sign out on a remote attached to a DESK", () => {
    // The desk keeps its read-only row: same page, same provider, no button.
    const h = mountAt("providers", {
      env: {
        isRemote: true,
        hostCaps: {
          relocateView: false, showOutput: false, toggleDevTools: true,
          remoteAgentSignIn: true,
        },
      },
      snapshot: { providers: [{ id: "grok", connected: true }] },
    });
    expect(h.root.querySelector('[data-id="providerGrokRemote"]')).toBeNull();
    expect(h.root.querySelector('[data-id="providerGrokStatus"] button')).toBeNull();
  });

  it("keeps the read-only row against a host that cannot sign in for a remote", () => {
    // The relay serves the client, so the client is always as new as the deploy
    // while the extension is whatever the user installed. A host from before
    // `remoteAgentSignIn` DROPS runGrokLogin silently — a Connect button there
    // would do nothing at all, which is worse than the row it replaced.
    const old = mountAt("providers", {
      env: { isRemote: true },
      snapshot: { providers: [{ id: "grok", connected: false }] },
    });
    expect(old.root.querySelector('[data-id="providerGrokRemote"]')).toBeNull();
    expect(old.root.querySelector('[data-id="providerGrokStatus"]')).toBeTruthy();
    expect(old.root.querySelector('[data-id="providerGrokStatus"] button')).toBeNull();
  });

  it("stays off a host that never reported its providers", () => {
    const { root, types } = mountAt("providers", { env: { providersKnown: false } });
    expect(root.querySelector(".settings-refresh")).toBeNull();
    expect(types()).toEqual([]);
  });

  it("belongs to the Providers page alone", () => {
    const { root, types } = mountAt("general");
    expect(root.querySelector(".settings-refresh")).toBeNull();
    expect(types()).toEqual([]);
  });
});

describe("GitHub connection row", () => {
  const githubCaps = {
    hostCaps: {
      relocateView: false, showOutput: false, toggleDevTools: true,
      remoteGithubSignIn: true, remoteGithubToken: true,
    },
  };

  it("stays hidden until the githubState frame arrives", () => {
    const { root } = mountAt("providers");
    expect(root.querySelector('[data-id="githubConnection"]')).toBeNull();
  });

  it("renders not connected, connected, and connected-but-broken", () => {
    const missing = mountAt("providers", {
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    const missingRow = missing.root.querySelector('[data-id="githubConnection"]') as HTMLElement;
    expect(missingRow).toBeTruthy();
    expect(missingRow.textContent).toMatch(/Connect GitHub/);
    expect(missingRow.querySelector(".settings-github-connect")?.textContent)
      .toBe("Connect with GitHub CLI");
    expect(missingRow.querySelector(".settings-github-advanced")?.textContent)
      .toBe("Use a token instead");
    expect(missingRow.querySelector(".settings-github-token")).toBeNull();
    expect(missingRow.querySelector(".settings-github-flow")).toBeNull();

    const ok = mountAt("providers", {
      snapshot: {
        githubState: { connected: true, login: "phuryn", cliPresent: true },
      },
    });
    const okRow = ok.root.querySelector('[data-id="githubConnection"]') as HTMLElement;
    expect(okRow.textContent).toMatch(/@phuryn/);
    expect(okRow.querySelector("button")?.textContent).toBe("Sign out");

    const broken = mountAt("providers", {
      snapshot: {
        githubState: { connected: false, envTokenInForce: true, error: true, cliPresent: true },
      },
    });
    const brokenRow = broken.root.querySelector('[data-id="githubConnection"]') as HTMLElement;
    expect(brokenRow.textContent).toMatch(/GH_TOKEN/);
    expect(brokenRow.textContent).toMatch(/not working/);
    expect(brokenRow.querySelector(".settings-github-connect")?.textContent)
      .toBe("Connect with GitHub CLI");
  });

  it("lets a remote connect when the host advertised remoteGithubSignIn, and signs out only on a cloud host", () => {
    const disconnected = mountAt("providers", {
      env: { isRemote: true, ...githubCaps },
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    const connect = disconnected.root.querySelector('[data-id="githubConnectionRemote"] .settings-github-connect');
    expect(connect?.textContent).toBe("Connect with GitHub CLI");
    (connect as HTMLButtonElement).click();
    expect(disconnected.posted).toContainEqual({
      type: "setupGithubCli", action: "auth", surface: "settings",
    });
    expect(disconnected.root.querySelector(".settings-github-flow")).toBeTruthy();
    expect(disconnected.root.querySelector(".settings-github-connect")).toBeNull();
    const open = disconnected.root.querySelector(".settings-github-flow-open");
    expect(open).toBeNull();

    const deskRemote = mountAt("providers", {
      env: { isRemote: true, ...githubCaps },
      snapshot: {
        githubState: { connected: true, login: "phuryn", cliPresent: true },
      },
    });
    expect(deskRemote.root.querySelector('[data-id="githubConnectionRemote"]')).toBeNull();
    expect(deskRemote.root.querySelector('[data-id="githubConnectionStatus"]')).toBeTruthy();

    const cloud = mountAt("providers", {
      env: {
        isRemote: true,
        hostCaps: { ...githubCaps.hostCaps, remoteAgentSignOut: true },
      },
      snapshot: {
        githubState: { connected: true, login: "phuryn", cliPresent: true },
      },
    });
    const signOut = cloud.root.querySelector('[data-id="githubConnectionRemote"] button');
    expect(signOut?.textContent).toBe("Sign out");
    (signOut as HTMLButtonElement).click();
    expect(cloud.posted).toContainEqual({ type: "githubSignOut" });
  });
});

describe("settings update() skips an unchanged snapshot", () => {
  it("does not rebuild the DOM when the displayed snapshot is identical", () => {
    const { root, surface } = mountAt("general", { snapshot: { appPurpose: "coding" } });
    const shell = root.querySelector(".settings-shell");
    expect(shell).toBeTruthy();
    surface.update({ showThinking: false, voiceConfigured: false });
    expect(root.querySelector(".settings-shell")).toBe(shell);
  });

  it("rebuilds when a displayed value actually changes", () => {
    const { root, surface } = mountAt("general", { snapshot: { appPurpose: "coding" } });
    const shell = root.querySelector(".settings-shell");
    surface.update({ showThinking: true });
    const next = root.querySelector(".settings-shell");
    expect(next).toBeTruthy();
    expect(next).not.toBe(shell);
    expect(root.querySelector('[data-id="showThinking"] .settings-switch')?.classList.contains("on")).toBe(true);
  });

  it("defers a real repaint while the phone category menu is focused", () => {
    const window = new Window({ url: "https://localhost/" });
    (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (query) => ({
      matches: String(query).includes("520px"),
      addEventListener() { /* */ },
      removeEventListener() { /* */ },
      addListener() { /* */ },
      removeListener() { /* */ },
    }) as unknown as { matches: boolean };
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: ReturnType<typeof loadSettings> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const surface = api.mount(root, {
      snapshot: api.defaultSnapshot({ appPurpose: "coding" }),
      env: api.defaultEnv(fullEnv()),
      category: "general",
      post: () => { /* */ },
      standalone: true,
    }) as unknown as { update: (s: unknown) => void };
    const select = root.querySelector(".settings-nav-select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.hidden).toBe(false);
    select.focus();
    expect(doc.activeElement).toBe(select);
    const shell = root.querySelector(".settings-shell");
    surface.update({ showThinking: true });
    expect(root.querySelector(".settings-shell")).toBe(shell);
    expect(root.querySelector('[data-id="showThinking"] .settings-switch')?.classList.contains("on")).toBe(false);
    select.blur();
    const next = root.querySelector(".settings-shell");
    expect(next).not.toBe(shell);
    expect(root.querySelector('[data-id="showThinking"] .settings-switch')?.classList.contains("on")).toBe(true);
  });
});

describe("settings switch knob theme", () => {
  it("derives the knob from theme tokens, not a raw #fff fallback", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../media/settings.css", import.meta.url)),
      "utf8",
    );
    const match = css.match(/\.settings-switch-knob\s*\{[^}]*\}/);
    expect(match).toBeTruthy();
    expect(match![0]).not.toMatch(/#(?:fff|ffffff)\b/i);
    expect(match![0]).toMatch(/color-mix\s*\(/);
    expect(match![0]).toMatch(/--vscode-/);
  });
});

/**
 * The GitHub token row follows the same gate as the Connect row beside it:
 * can this host sign in to GitHub for a remote at all?
 *
 * It was briefly cloud-only, to match a host policy that was itself briefly
 * cloud-only. Both came back out — a remote that could inject a token can
 * already drive the agent and approve its tool calls on that machine, so the
 * gate protected nothing while removing the narrowest credential we can offer
 * from a phone driving a desk.
 *
 * What these pin is that the CLIENT gate matches the HOST's. Whichever way that
 * decision goes, offering a row the host will refuse is the one shape that is
 * always wrong: it takes the paste and sends a credential across the relay for
 * nothing.
 */
describe("settings: the GitHub token path matches what the host will accept", () => {
  const S = loadSettings();
  const tokenOffered = (env: Record<string, unknown>, githubState: Record<string, unknown>) =>
    S.githubTokenAvailable(
      S.defaultSnapshot({ githubState }),
      S.defaultEnv(env),
    );

  it("offers it locally, where there is also a terminal", () => {
    expect(tokenOffered({ isRemote: false }, { connected: false, cliPresent: true })).toBe(true);
  });

  it("offers it to a remote on a cloud machine — its only way in", () => {
    expect(tokenOffered({
      isRemote: true,
      hostCaps: { remoteGithubSignIn: true, remoteGithubToken: true, remoteAgentSignOut: true },
    }, { connected: false, cliPresent: true })).toBe(true);
  });

  it("offers it to a phone driving a desk too — the host accepts it there", () => {
    expect(tokenOffered({
      isRemote: true,
      hostCaps: { remoteGithubSignIn: true, remoteGithubToken: true, remoteAgentSignOut: false },
    }, { connected: false, cliPresent: true })).toBe(true);
  });

  it("withholds it from a remote whose host cannot sign in to GitHub at all", () => {
    // The honest case: an older host drops `setupGithubCli` and would drop this
    // too, so the row would be a paste that goes nowhere.
    expect(tokenOffered({
      isRemote: true,
      hostCaps: { remoteGithubSignIn: false },
    }, { connected: false, cliPresent: true })).toBe(false);
  });

  it("withholds it from a host that can do the DEVICE flow but not a token", () => {
    // The gap `remoteGithubSignIn` cannot cover. Every host between 4.1.0 and
    // the release that added `githubLoginWithToken` advertises the first and
    // knows nothing of the second, and the relay always serves a client newer
    // than the extension — so this is the ordinary case for anyone who has not
    // updated, not an exotic one. Offering the row there sends a credential
    // across the relay to be dropped in silence.
    expect(tokenOffered({
      isRemote: true,
      hostCaps: { remoteGithubSignIn: true },
    }, { connected: false, cliPresent: true })).toBe(false);
  });

  it("withholds it once GitHub is connected, on every surface", () => {
    expect(tokenOffered({ isRemote: false }, { connected: true, login: "octocat", cliPresent: true }))
      .toBe(false);
    expect(tokenOffered({
      isRemote: true,
      hostCaps: { remoteGithubSignIn: true, remoteAgentSignOut: true },
    }, { connected: true, login: "octocat", cliPresent: true })).toBe(false);
  });

  it("is an advanced second step on the GitHub row, not a sibling row", () => {
    const { root, posted } = mountAt("providers", {
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    expect(root.querySelector('[data-id="githubToken"]')).toBeNull();
    const row = root.querySelector('[data-id="githubConnection"]') as HTMLElement;
    expect(row.querySelector(".settings-github-token")).toBeNull();
    const advanced = row.querySelector(".settings-github-advanced") as HTMLButtonElement;
    expect(advanced.textContent).toBe("Use a token instead");
    advanced.click();
    expect(posted.some((m) => m.type === "githubLoginWithToken")).toBe(false);
    expect(root.querySelector(".settings-github-connect")).toBeNull();
    expect(root.querySelector(".settings-github-token")).toBeTruthy();
    expect(root.querySelector(".settings-github-token-input")).toBeTruthy();
  });

  it("the CLI path is two steps: a choice, then a card with a real open link", () => {
    const { root, posted } = mountAt("providers", {
      env: {
        isRemote: true,
        hostCaps: {
          relocateView: false, showOutput: false, toggleDevTools: true,
          remoteGithubSignIn: true,
        },
      },
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    const row = root.querySelector('[data-id="githubConnectionRemote"]') as HTMLElement;
    expect(row.querySelector(".settings-github-flow")).toBeNull();
    (row.querySelector(".settings-github-connect") as HTMLButtonElement).click();
    expect(posted).toContainEqual({
      type: "setupGithubCli", action: "auth", surface: "settings",
    });
    expect(root.querySelector(".settings-github-flow")).toBeTruthy();
    expect(root.querySelector(".settings-github-connect")).toBeNull();

    const { root: waiting, surface } = mountAt("providers", {
      env: {
        isRemote: true,
        hostCaps: {
          relocateView: false, showOutput: false, toggleDevTools: true,
          remoteGithubSignIn: true,
        },
      },
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    surface.update({
      githubState: {
        connected: false,
        cliPresent: true,
        loginFlow: {
          status: "waiting",
          url: "https://github.com/login/device",
          code: "0D15-6BD9",
        },
      },
    });
    const open = waiting.querySelector(".settings-github-flow-open") as HTMLAnchorElement;
    expect(open).toBeTruthy();
    expect(open.tagName).toBe("A");
    expect(open.getAttribute("href")).toBe("https://github.com/login/device");
    expect(open.target).toBe("_blank");
    expect(waiting.textContent).toContain("0D15-6BD9");
    expect(waiting.querySelector(".settings-github-connect")).toBeNull();
  });

  it("makes 'fine-grained token' a new-tab link in the token step", () => {
    const { root } = mountAt("providers", {
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    const advanced = root.querySelector(".settings-github-advanced") as HTMLButtonElement;
    advanced.click();
    const link = root.querySelector(".settings-github-token-link") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe("fine-grained token");
    expect(link.getAttribute("href")).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("offers Re-check connection on a desk GitHub terminal sign-in", () => {
    const { root, posted } = mountAt("providers", {
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    posted.length = 0;
    (root.querySelector(".settings-github-connect") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "setupGithubCli", action: "auth", surface: "settings" });
    const recheck = root.querySelector(".settings-github-flow-recheck") as HTMLButtonElement;
    expect(recheck).toBeTruthy();
    expect(recheck.textContent).toBe("Re-check connection");
    expect(root.querySelector(".settings-github-flow-cancel")?.textContent).toBe("Cancel");
    posted.length = 0;
    recheck.click();
    expect(posted).toContainEqual({ type: "refreshProviders" });
    // And ONLY that. The row binder claims any `.settings-action` inside a row
    // as its primary control, so while this button carried that class it fired
    // Connect first and opened a second sign-in terminal behind the refresh.
    expect(posted.some((m) => m.type === "setupGithubCli")).toBe(false);
  });

  it("offers Re-check connection once a desk provider row starts a terminal sign-in", () => {
    const { root, posted } = mountAt("providers", {
      snapshot: {
        providers: [{ id: "grok", connected: false, needsLogin: false }],
      },
    });
    posted.length = 0;
    const connect = root.querySelector('[data-id="providerGrok"] .settings-action') as HTMLButtonElement;
    expect(connect.textContent).toBe("Connect");
    connect.click();
    expect(posted).toContainEqual({ type: "runGrokLogin", provider: "grok" });
    expect(root.querySelector('[data-id="providerGrok"] .settings-action')?.textContent)
      .toBe("Connecting…");
    const recheck = root.querySelector(".settings-provider-recheck") as HTMLButtonElement;
    expect(recheck).toBeTruthy();
    expect(recheck.textContent).toBe("Re-check connection");
    expect(root.querySelector(".settings-provider-terminal-cancel")?.textContent).toBe("Cancel");
    posted.length = 0;
    recheck.click();
    expect(posted).toContainEqual({ type: "recheckConnection", provider: "grok" });
  });

  it("does not offer Re-check on a remote GitHub device-code wait", () => {
    const { root } = mountAt("providers", {
      env: {
        isRemote: true,
        hostCaps: {
          relocateView: false, showOutput: false, toggleDevTools: true,
          remoteGithubSignIn: true,
        },
      },
      snapshot: { githubState: { connected: false, cliPresent: true } },
    });
    (root.querySelector(".settings-github-connect") as HTMLButtonElement).click();
    expect(root.querySelector(".settings-github-flow-recheck")).toBeNull();
    expect(root.querySelector(".settings-github-flow-cancel")).toBeTruthy();
  });
});
