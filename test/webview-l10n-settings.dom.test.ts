import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Window } from "happy-dom";
import { afterEach, expect, it } from "vitest";
import { click, dispatch, type Posted } from "./webview-harness";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const helperSource = read("../media/webview-helpers.js");
const settingsSource = read("../media/settings.js");
const hostSource = read("../src/sidebar.ts");
const start = hostSource.indexOf("      var vscode = acquireVsCodeApi();", hostSource.indexOf("private getSettingsHtml"));
const end = hostSource.indexOf("    })();", start);
const { keys } = createRequire(import.meta.url)("../scripts/l10n-extract.cjs").collect() as { keys: string[] };
const pseudo = Object.fromEntries(keys.map(key => [key, `⟦${key}⟧`]));

const providers = [
  { id: "grok", connected: true, keepsCliSignIn: true, cliVersion: "1.2.3" },
  { id: "codex", connected: true, needsLogin: true, cliVersion: "2.3.4", updateAvailable: true, latestCliVersion: "2.3.5",
    cliUpdate: { status: "idle", message: "Host CLI status" } },
  { id: "claude", connected: false, cliVersion: "3.4.5" },
  { id: "muse", connected: true, cliVersion: "4.5.6" },
  { id: "agy", connected: true, signInMethod: "api-key", keepsCliSignIn: true, agyCli: { version: "5.6.7" } },
  { id: "deepseek", connected: true, keySource: "environment", cliVersion: "6.7.8" },
];
const connectors = [
  { id: "github", name: "GitHub", description: "Host GitHub description.", auth: "key", connected: true, keySet: true,
    readOnly: true, keyDocsUrl: "https://github.com/settings/personal-access-tokens" },
  { id: "zapier", name: "Zapier", description: "Host Zapier description.", auth: "key", connected: false,
    keyHint: "Host Zapier token hint.", keyDocsUrl: "https://zapier.com/app/settings" },
  { id: "notion", name: "Notion", description: "Host Notion description.", auth: "oauth", connected: false },
  { id: "stripe", name: "Stripe", description: "Host Stripe description.", auth: "oauth", connected: false,
    status: "error", error: "Host connector error." },
];
const mcpServers = [
  { name: "grok-managed", displayName: "Workspace tools", scopeName: "Desk scope", managed: true, status: "ready", toolCount: 1 },
  { name: "Local tools", enabled: false, status: "unavailable", toolCount: 2, command: "node", args: ["mcp.cjs"], error: "Host MCP error." },
];
const projects = [
  { cwd: "/project", label: "Example project", defaultProvider: "grok" },
  { cwd: "/archived", label: "Old project", archived: true },
];
const models = [
  { provider: "grok", model: "grok-4", label: "Grok 4" },
  { provider: "claude", model: "opus", label: "Claude Opus" },
];
const now = Date.now();
const routine = {
  id: "daily", title: "User routine", prompt: "User-authored prompt.", cwd: "/project", provider: "grok", model: "grok-4",
  cadence: { every: 1, unit: "days", at: "09:00" }, cadenceLabel: "Every day at 09:00", projectLabel: "Example project",
  nextRunAt: now + 42 * 60_000,
  runs: [
    { outcome: "ran", startedAt: now, sessionId: "previous-run" },
    { outcome: "skipped", startedAt: now - 60_000, detail: "Host run detail." },
    { outcome: "running", startedAt: now - 120_000 },
    { outcome: "interrupted", startedAt: now - 180_000 },
    { outcome: "failed", startedAt: now - 240_000 },
  ],
  health: { ran: 1, total: 5 },
};
const voice = { hasOpenAi: true, hasXai: true, hasGoogle: false, preference: "openai", googlePreference: "google" };
const windows: Window[] = [];
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

function boot(strings: Readonly<Record<string, string>> = pseudo, width?: number) {
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const window = new Window({ url: "https://localhost/" });
  windows.push(window);
  if (width) window.happyDOM.setViewport({ width });
  const root = window.document.createElement("div") as unknown as HTMLElement;
  root.id = "settings-root";
  window.document.body.className = "settings-page";
  (window.document.body as unknown as HTMLElement).appendChild(root);
  const posted: Posted[] = [];
  Object.assign(window, {
    acquireVsCodeApi: () => ({ postMessage: (msg: Posted) => posted.push(msg) }),
    __grokL10n: strings,
    __grokSettingsBoot: {
      category: "general",
      env: {
        isRemote: false, isDesktop: false, providersKnown: true, remoteLinked: false, remoteHandoffSupported: true,
        ttsAvailable: true,
        hostCaps: { mcpSettings: true, editProviderConfigFiles: true, editProjectFiles: true,
          settingsEditor: true, toggleDevTools: true, relocateView: true, secondarySideBar: false },
      },
      snapshot: {
        providers, githubState: { cliPresent: false, connected: false }, mcpServers, mcpConnectors: connectors,
        mcpConnectorAuthorization: { id: "notion", status: "waiting", url: "https://example.com/signin" },
        routines: [routine], routineProjects: projects, routineModels: models,
        hostKind: "extension", extVersion: "7.8.9", appPurpose: "coding", showThinking: true,
        autoCompactSettings: { enabled: true, tokens: 500000 }, deskAlerts: false, soundNotifications: true,
        voiceConfigured: true, voiceBackendState: voice, voiceKeyterms: ["User term"], readRepliesAloud: true,
        museSettings: { shellSandbox: true, sandboxNetwork: "restricted", trustWorkspaces: false },
      },
    },
  });
  window.eval(helperSource);
  window.eval(settingsSource);
  window.eval("(function () {\n" + hostSource.slice(start, end) + "\n})();");
  expect(posted).toContainEqual({ type: "ready" });
  const find = <T extends Element = HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    expect(element, selector).not.toBeNull();
    return element!;
  };
  const press = (selector: string) => click(window, find(selector));
  const send = (message: Posted) => dispatch(window, message);
  const category = (id: string) => {
    const selector = `.settings-nav-item[data-category="${id}"]`;
    press(selector);
    find(selector + ".active");
  };
  const input = (element: HTMLInputElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  };
  return { window, root, find, press, send, category, posted, input };
}

const literalEnglish = new Set([
  // Product and model names, connector brands, file names, repository and contact.
  "Grok", "Grok Build", "Codex", "Claude", "Claude Code", "Muse Code", "Antigravity", "DeepSeek", "GitHub",
  "Grok Build CLI", "Codex CLI", "Claude Code CLI", "Muse Code CLI",
  "Grok 4", "Claude Opus", "xAI", "OpenAI", "Google", "Notion", "Zapier", "Stripe",
  "~/.grok/config.toml", "~/.codex/config.toml", "~/.claude/settings.json", "config.toml",
  "phuryn/grok-build-vscode", "contact@afkpilot.com",
  "github.com/settings/personal-access-tokens", "zapier.com/app/settings",
  // The actual voice send phrase and the dictionary entry typed by the user.
  "grok send", "User term",
  // Host and user content. The routine cadence label comes from the host too.
  "User routine", "Example project", "Example project · Every day at 09:00 · Grok 4",
  "Workspace tools", "Desk scope", "Local tools", "Host CLI status",
  "Host Zapier token hint.", "Host Notion description.", "Host connector error.", "Host MCP error.",
  "Host GitHub status", "Host GitHub error", "Host Antigravity error.", "Host routine error.", "TEST-CODE",
  // Progress and failure notices excluded from this localization pass.
  "Loading routines…", "Loading Grok connectors…", "Loading…", "Checking for updates",
  "Couldn’t check — try updating anyway", "Failed",
]);

function outsideMarkers(text: string): string {
  // A formatted key can contain another translated label as an argument.
  while (/⟦[^⟦⟧]*⟧/.test(text)) text = text.replace(/⟦[^⟦⟧]*⟧/g, "");
  return text.trim();
}

function audit(root: HTMLElement, state: string, missing: string[]) {
  function check(el: Element, slot: string, raw: string) {
    const rest = outsideMarkers(raw);
    if (!/[A-Za-z]/.test(rest) || literalEnglish.has(rest) || /^v\d+\.\d+\.\d+$/.test(rest)) return;
    // MCP detail joins host status codes, commands, and error text with local labels.
    if (el.matches(".settings-mcp-server .settings-row-desc") &&
        rest.split("·").filter(part => /[A-Za-z]/.test(part)).every(part =>
          ["ready", "unavailable", "node mcp.cjs", "Host MCP error."].includes(part.trim()))) return;
    // Dates use the platform's formatter. A tick combines its run label with that date.
    if (el.matches(".settings-routine-runs time")) return;
    if (el.matches(".settings-routine-tick")) {
      const label = outsideMarkers(raw.split(" · ")[0]);
      if (!/[A-Za-z]/.test(label) || ["Host run detail.", "Failed"].includes(label)) return;
    }
    if (el.matches(".settings-routine-run-what") && rest === "Host run detail.") return;
    if (el.matches(".settings-row-desc") && /^⟦.*⟧ Host Antigravity error\.$/.test(raw)) return;
    // Connector progress remains English. The Providers page has its own localized states.
    if (el.closest(".settings-connector") &&
        ["Connecting…", "Checking the token…", "Waiting for the browser sign-in to finish…"].includes(rest)) return;
    missing.push(`${state} | ${el.closest("[data-id]")?.getAttribute("data-id") ?? el.className} | ${slot} | ${rest}`);
  }

  function walk(el: Element) {
    if (el.matches("[hidden]")) return;
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value) check(el, attr, value);
    }
    const linkedHint = el.matches(".settings-connector-key-hint, .settings-github-token-hint");
    if (linkedHint) check(el, "text", el.textContent ?? "");
    for (const child of el.childNodes) {
      if (child.nodeType === 3 && !linkedHint) check(el, "text", child.textContent ?? "");
      if (child.nodeType === 1 && (!el.matches("details:not([open])") || (child as Element).matches("summary"))) {
        walk(child as Element);
      }
    }
  }
  walk(root);
}

it("localizes the standalone Settings categories, controls, and forms", () => {
  const h = boot();
  const missing: string[] = [];
  const scan = (state: string) => audit(h.root, state, missing);
  const row = (id: string, selector = "") => h.find(`[data-id="${id}"] ${selector}`.trim());
  const restore = (category: string) => {
    h.press(".settings-restore");
    expect(h.find(".settings-restore-confirm-list").children.length).toBeGreaterThan(0);
    scan(`${category} restore confirmation`);
    h.press(".settings-restore-confirm-cancel");
  };
  expect([...h.root.querySelectorAll(".settings-nav-item")].map(el => el.getAttribute("data-category")))
    .toEqual(["general", "voice", "notifications", "providers", "routines", "connectors", "account", "advanced", "about"]);
  scan("General");
  restore("General");
  const select = row("autoCompactAt", "select") as HTMLSelectElement;
  expect([...select.options].map(option => option.value)).toEqual(["200000", "300000", "400000", "500000", "750000"]);
  select.value = "750000";
  select.dispatchEvent(new h.window.Event("change") as unknown as Event);
  expect(h.posted).toContainEqual({ type: "setAutoCompact", key: "tokens", value: 750000 });
  h.send({ type: "autoCompactSettings", value: { enabled: false, tokens: 750000 } });
  scan("General, auto-compact off");

  h.category("voice");
  expect((row("voiceBackend", "select") as HTMLSelectElement).value).toBe("google");
  scan("Voice");
  restore("Voice");
  h.send({ type: "voiceConfigured", value: false, backendState: { preference: "auto", hasOpenAi: false, hasXai: false } });
  scan("Voice, legacy backend and unavailable mic");
  h.send({ type: "voiceConfigured", value: false, backendState: { ...voice, hasGoogle: true, hasXai: false } });
  scan("Voice, Gemini key available");

  h.category("notifications");
  scan("Notifications");
  restore("Notifications");

  h.category("providers");
  (h.find("details.settings-row-group") as HTMLDetailsElement).open = true;
  (row("providerConfigFiles") as HTMLDetailsElement).open = true;
  scan("Providers, config and Muse expanded");
  h.press('[data-id="providerConfigFiles"] [data-provider="claude"]');
  expect(h.posted).toContainEqual({ type: "openProviderConfig", provider: "claude" });
  h.press(".settings-github-advanced");
  scan("GitHub token form");
  h.press(".settings-github-token-cancel");
  h.press(".settings-github-connect");
  scan("GitHub terminal sign-in");
  h.send({ type: "githubState", github: { connected: false, cliPresent: true,
    loginFlow: { status: "waiting", code: "TEST-CODE", url: "https://github.com/login/device", message: "Host GitHub status" } } });
  scan("GitHub device code");
  h.send({ type: "githubState", github: { connected: false, loginFlow: { status: "starting" } } });
  scan("GitHub starting");
  h.send({ type: "githubState", github: { connected: false,
    loginFlow: { status: "failed", message: "Host GitHub error" } } });
  scan("GitHub failure");
  h.send({ type: "githubState", github: { connected: true, cliPresent: true, login: "sample-user" } });
  scan("GitHub signed in");
  h.press('[data-id="providerCodex"] .settings-action');
  scan("Provider terminal sign-in");
  h.press(".settings-provider-terminal-cancel");
  h.send({ type: "providerState", checking: true, providers: providers.map(p => p.id === "agy"
    ? { ...p, connected: false, agyCli: { installing: true } } : p) });
  scan("Providers refreshing, Antigravity installing");
  h.send({ type: "providerState", providers: providers.map(p => p.id === "agy"
    ? { ...p, agyCli: { reason: "Host Antigravity error." }, signInMethod: "google" } : p) });
  scan("Antigravity Google account and host diagnostic");

  h.category("routines");
  scan("Routine list");
  h.press('[data-routine="daily"] .settings-routine-toggle');
  scan("Routine editor and run history");
  const units = h.find<HTMLSelectElement>('[data-field="unit"]');
  expect([...units.options].map(option => option.value)).toEqual(["minutes", "hours", "days"]);
  expect(h.find<HTMLInputElement>('[data-field="at"]').value).toBe("09:00");
  units.value = "hours";
  units.dispatchEvent(new h.window.Event("change", { bubbles: true }) as unknown as Event);
  expect(h.root.querySelector('[data-field="at"]')).toBeNull();
  scan("Hourly routine editor");
  h.press(".settings-routine-save");
  expect(h.posted).toContainEqual({ type: "saveRoutine", id: "daily", draft: {
    title: routine.title, prompt: routine.prompt, cwd: routine.cwd, provider: routine.provider,
    model: routine.model, cadence: { every: 1, unit: "hours" },
  } });
  h.press(".settings-routine-remove");
  scan("Routine removal confirmation");
  h.send({ type: "routines", entries: [{ ...routine, paused: true, runs: [], health: { ran: 0, total: 0 } }],
    projects, models, error: "Host routine error.", errorId: "daily" });
  scan("Paused routine and save error");
  h.press(".settings-routine-new");
  scan("New routine editor");
  h.press(".settings-routine-cancel");
  h.send({ type: "routines", entries: [], projects, models });
  scan("No routines");

  h.category("connectors");
  scan("Connectors loading");
  h.send({ type: "mcpServers", servers: mcpServers });
  scan("Connector cards, browser authorization, and MCP servers");
  h.press('[data-id="connector-github"] .settings-connector-key-open');
  scan("Replace connector key");
  h.press(".settings-connector-key-cancel");
  h.press('[data-id="connector-zapier"] .settings-connector-action');
  scan("New connector key form");
  h.press(".settings-connector-key-cancel");
  h.send({ type: "mcpServers", servers: [] });
  h.send({ type: "mcpConnectors", connectors: [] });
  scan("Empty connector catalogs");

  h.category("account");
  scan("Remote control, unlinked");
  h.send({ type: "remoteStatus", linked: true, viewerCount: 1, handoffReady: true });
  scan("Remote control, linked");
  h.press('[data-id="continueOnPhone"] .settings-action');
  expect(h.posted).toContainEqual({ type: "showRemoteHandoff", source: "settings" });
  h.send({ type: "remoteStatus", linked: true, viewerCount: 0, handoffReady: true });
  scan("Remote control, no viewer");

  h.category("advanced");
  scan("Advanced");
  h.category("about");
  scan("About, checking");
  h.send({ type: "grokUpdateStatus", current: "1.2.3", latest: "1.2.4", updateAvailable: true });
  scan("About, update available");
  h.send({ type: "grokUpdateStatus", current: "1.2.3", policy: { allow: false } });
  scan("About, updates paused");
  h.send({ type: "grokUpdateStatus", current: "1.2.3", latest: "1.2.3" });
  scan("About, up to date");

  h.input(h.find("#settings-search"), "no-such-setting");
  scan("Search with no results");
  expect(h.root.textContent).toContain("⟦No settings match that search.⟧");
  expect([...new Set(missing)]).toEqual([]);
});

it("leaves the search field in place while an input method is composing", () => {
  const h = boot();
  const search = h.find<HTMLInputElement>("#settings-search");
  const type = (value: string, isComposing: boolean) => {
    search.value = value;
    const event = new h.window.Event("input", { bubbles: true });
    Object.defineProperty(event, "isComposing", { value: isComposing });
    search.dispatchEvent(event as unknown as Event);
  };
  for (const partial of ["q", "qi", "qi'y"]) type(partial, true);
  expect(h.find("#settings-search")).toBe(search);
  expect(h.root.textContent).not.toContain("⟦No settings match that search.⟧");
  search.value = "企业";
  search.dispatchEvent(new h.window.Event("compositionend", { bubbles: true }) as unknown as Event);
  expect(h.find<HTMLInputElement>("#settings-search").value).toBe("企业");
  expect(h.root.textContent).toContain("⟦No settings match that search.⟧");
});

it("finds a Settings row by both its English and translated description", () => {
  const description = "Send straight into the running turn instead of queueing until it finishes. Steering does not cancel work in progress.";
  const h = boot({ ...pseudo, [description]: "⟦Localized steering description⟧" }, 480);
  const category = h.find<HTMLSelectElement>("#settings-category");
  expect(category.hidden).toBe(false);
  expect(category.getAttribute("aria-label")).toBe("⟦Settings category⟧");
  expect(category.selectedOptions[0].textContent).toBe("⟦General⟧");
  for (const query of ["cancel work in progress", "Localized steering description"]) {
    h.input(h.find("#settings-search"), query);
    expect(h.find('[data-id="steerByDefault"] .settings-row-desc').textContent).toBe("⟦Localized steering description⟧");
  }
});
