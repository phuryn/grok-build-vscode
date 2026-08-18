// Shared settings surface: overlay in chat.js + the catalog in media/settings.js.
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    ABOUT_DISCLAIMER: string;
    GITHUB_ISSUE_BUG_URL: string;
    GITHUB_ISSUE_FEATURE_URL: string;
    SUPPORT_MAILTO: string;
    defaultSnapshot: (p?: Record<string, unknown>) => Record<string, unknown>;
    defaultEnv: (p?: Record<string, unknown>) => Record<string, unknown>;
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
    const local = api.visibleCategories(snapshot, api.defaultEnv(fullEnv()));
    expect(local.map((c) => c.id)).toEqual([
      "general", "voice", "notifications", "providers", "mcp", "account", "advanced", "about",
    ]);
    const remoteRows = api.visibleRows(snapshot, api.defaultEnv(fullEnv({ isRemote: true })));
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
  });

  it("gives every category a nav icon and folds Chat into General", () => {
    const api = loadSettings();
    expect(api.CATEGORIES.some((c: { id: string }) => c.id === "chat")).toBe(false);
    expect(api.ROWS.filter((r: { category: string }) => r.category === "chat")).toEqual([]);
    expect(api.ROWS.find((r: { id: string }) => r.id === "showThinking")?.category).toBe("general");
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
      "General", "Voice", "Notifications", "Providers", "MCP servers", "Account", "Advanced", "About",
    ]);
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
    const nav = settingsNav(h).map((el) => (el.textContent || "").trim());
    expect(ids).not.toContain("openGlobalConfig");
    expect(ids).not.toContain("mcpCatalog");
    expect(nav).not.toContain("MCP servers");
    expect(ids).not.toContain("showLogs");
    expect(ids).not.toContain("providerGrok");
    expect(ids).not.toContain("continueRemotely");
    expect(nav).toContain("Providers");
    expect(nav).toContain("Account");
    clickSettingsNav(h, "Providers");
    expect(overlay.textContent).toMatch(/This account is connected on this machine/);
    clickSettingsNav(h, "Account");
    expect(overlay.textContent).toMatch(/Device manager/);
    clickSettingsNav(h, "Advanced");
    expect(overlay.textContent).toMatch(/Host config is managed on the desk/);
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
      "openGlobalConfig", "openProjectConfig", "mcpCatalog", "showLogs",
      "openVsCodeSettings", "moveView",
    ]));
  });

  it("loads and toggles MCP servers inside the settings surface", () => {
    const h = bootWebview();
    seedChat(h);
    openSettings(h);
    clickSettingsNav(h, "MCP servers");
    expect(h.posted).toContainEqual({ type: "listMcpServers" });

    dispatch(h.window, {
      type: "mcpServers",
      servers: [{ name: "docs", enabled: true, scope: "user", command: "npx", args: ["docs-mcp"] }],
      warning: "Global setting.",
    });
    const overlay = h.doc.getElementById("settings-overlay")!;
    expect(overlay.textContent).toContain("docs");
    expect(overlay.textContent).toContain("npx docs-mcp");
    const toggle = overlay.querySelector('[aria-label="Disable docs"]');
    expect(toggle).toBeTruthy();
    click(h.window, toggle!);
    expect(h.posted).toContainEqual({ type: "setMcpServerEnabled", name: "docs", enabled: false });
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
    clickSettingsNav(h, "Account");
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
    const start = src.indexOf("DEVICE_GLOBAL_REMOTE_TYPES");
    const end = src.indexOf("];", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toContain("telemetryEnabled");
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

describe("Providers refresh", () => {
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
    // cannot make the desk go looking.
    expect(root.querySelector('[data-id="providerGrokStatus"]')).toBeTruthy();
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
