/**
 * Multi-provider user journeys through the real Electron renderer and host.
 * Both agents are protocol fixtures; no real CLI or network is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const fixtureDir = path.join(root, "test", "fixtures");
const grokCli = process.platform === "win32"
  ? path.join(fixtureDir, "fake-grok-acp.cmd")
  : path.join(fixtureDir, "fake-grok-acp.sh");
const codexCli = path.join(fixtureDir, "fake-codex-acp.cjs");

interface FlowApp {
  app: ElectronApplication;
  page: Page;
  workspace: string;
  userData: string;
  grokHome: string;
  codexSink: string;
  cleanup(): Promise<void>;
}

async function eventually<T>(
  page: Page,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  description: string,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) {
    await page.waitForTimeout(100);
    value = await read();
  }
  if (!accepts(value)) throw new Error(`Timed out waiting for ${description}; last value: ${String(value)}`);
  return value;
}

async function waitCount(page: Page, locator: Locator, count: number, timeout = 30_000): Promise<void> {
  await eventually(page, () => locator.count(), (value) => value === count, `count ${count}`, timeout);
}

async function waitAtLeast(page: Page, locator: Locator, count: number, timeout = 30_000): Promise<void> {
  await eventually(page, () => locator.count(), (value) => value >= count, `count at least ${count}`, timeout);
}

async function waitText(page: Page, locator: Locator, text: string | RegExp, timeout = 30_000): Promise<string> {
  return eventually(
    page,
    () => locator.innerText().catch(() => ""),
    (value) => typeof text === "string" ? value.includes(text) : text.test(value),
    `text ${String(text)}`,
    timeout,
  );
}

async function waitBodyClass(page: Page, name: string, present: boolean, timeout = 30_000): Promise<void> {
  await eventually(
    page,
    () => page.locator("body").getAttribute("class").then((value) => value ?? ""),
    (value) => value.split(/\s+/).includes(name) === present,
    `${present ? "presence" : "absence"} of body class ${name}`,
    timeout,
  );
}

function stripElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function writeGrokHistory(grokHome: string, cwd: string, id: string, title: string): void {
  const dir = path.join(grokHome, "sessions", encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({
    info: { id, cwd },
    session_summary: title,
    updated_at: new Date().toISOString(),
    num_messages: 4,
  }));
}

async function launchFlowApp(options: {
  config?: Record<string, unknown>;
  connections?: Record<string, boolean>;
  omitConnections?: boolean;
  authEvidence?: boolean;
  history?: { id: string; title: string }[];
} = {}): Promise<FlowApp> {
  if (!fs.existsSync(mainJs)) throw new Error(`Missing ${mainJs}; run npm run compile first`);
  if (!fs.existsSync(electronExe)) throw new Error(`Missing Electron binary at ${electronExe}`);
  if (process.platform !== "win32") fs.chmodSync(grokCli, 0o755);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-provider-flow-ws-"));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-provider-flow-ud-"));
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-provider-flow-home-"));
  const configJson = path.join(userData, "flow-config.json");
  const codexSink = path.join(userData, "codex-events.jsonl");
  const codexHome = path.join(userData, "codex-home");
  fs.writeFileSync(path.join(workspace, "readme.md"), "# Provider flow fixture\n");
  fs.writeFileSync(configJson, JSON.stringify(options.config ?? {}));
  if (!options.omitConnections) {
    fs.writeFileSync(path.join(userData, "globalState.json"), JSON.stringify({
      "grok.providerConnections.v2": options.connections ?? {},
    }));
  }
  if (options.authEvidence) {
    fs.writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify({ access_token: "fake" }));
  }
  for (const entry of options.history ?? []) {
    writeGrokHistory(grokHome, workspace, entry.id, entry.title);
  }

  const app = await electron.launch({
    executablePath: electronExe,
    args: [
      mainJs,
      `--workspace=${workspace}`,
      `--user-data-dir=${userData}`,
      `--config-json=${configJson}`,
    ],
    env: {
      ...stripElectronRunAsNode(process.env),
      NODE_ENV: "test",
      GROK_DESKTOP_TEST_ALLOW_MULTIPLE: "1",
      GROK_HOME: grokHome,
      CODEX_HOME: codexHome,
      GROK_TEST_CODEX_ACP_ADAPTER_PATH: codexCli,
      FAKE_CODEX_SPAWN_SINK: codexSink,
      FAKE_SESSION_ID_FROM_PID: "1",
      FAKE_WORKSPACE_ROOT: workspace,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForSelector("#input", { timeout: 45_000 });

  return {
    app,
    page,
    workspace,
    userData,
    grokHome,
    codexSink,
    async cleanup() {
      const process = app.process();
      try {
        await Promise.race([
          app.close(),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } catch { /* already closed */ }
      if (process.exitCode === null) process.kill();
      for (const target of [workspace, userData, grokHome]) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },
  };
}

async function waitComposerReady(page: Page): Promise<void> {
  await page.locator("body:not(.busy-locked) #input:not([disabled])").waitFor({ timeout: 45_000 });
}

async function connectFromOnboarding(page: Page, provider: "grok" | "codex"): Promise<void> {
  const tile = page.locator(`[data-act="connectProvider"][data-provider="${provider}"]`);
  await tile.waitFor({ state: "visible", timeout: 20_000 });
  await tile.click();
  const recheck = page.locator(`[data-act="recheckProvider"][data-provider="${provider}"]`);
  await recheck.waitFor({ state: "visible", timeout: 20_000 });
  await recheck.click();
  await waitComposerReady(page);
  await page.locator("#welcome-onboarding").waitFor({ state: "hidden", timeout: 45_000 });
}

async function openRailGear(page: Page): Promise<void> {
  const gear = page.locator("#rail-gear-btn");
  await gear.waitFor({ state: "visible", timeout: 20_000 });
  if (await page.locator("#gear-popover").isVisible()) {
    await gear.click();
    await page.locator("#gear-popover").waitFor({ state: "hidden" });
  }
  await gear.click();
  await page.locator("#gear-popover").waitFor({ state: "visible", timeout: 10_000 });
}

async function accountAction(page: Page, provider: "Grok" | "Codex", action: "Connect" | "Sign out"): Promise<void> {
  await openRailGear(page);
  const sections = page.locator("#gear-popover .popover-section");
  expect((await sections.last().innerText()).trim()).toMatch(/^Accounts$/i);
  const item = page.locator("#gear-popover .toolbar-popover-item").filter({
    hasText: new RegExp(`${provider}.*${action}`, "i"),
  });
  await item.click();
}

async function finishAccountConnect(page: Page, provider: "grok" | "codex"): Promise<void> {
  const recheck = page.locator(`[data-act="recheckProvider"][data-provider="${provider}"]`);
  await recheck.waitFor({ state: "visible", timeout: 20_000 });
  await recheck.click();
  await waitComposerReady(page);
  await page.locator("#welcome-onboarding").waitFor({ state: "hidden", timeout: 45_000 });
}

async function openModelPicker(page: Page): Promise<void> {
  const gear = page.locator("#gear-btn");
  if (await page.locator("#gear-popover").isVisible()) {
    await gear.click();
    await page.locator("#gear-popover").waitFor({ state: "hidden" });
  }
  await gear.click();
  await page.locator(".model-name-btn").waitFor({ state: "visible" });
  await page.locator(".model-name-btn").click();
  await page.locator("#gear-popover .toolbar-popover-item").first().waitFor({ state: "visible" });
}

async function chooseModel(page: Page, label: RegExp): Promise<void> {
  await openModelPicker(page);
  await page.locator("#gear-popover .toolbar-popover-item").filter({ hasText: label }).click();
  await waitComposerReady(page);
}

async function currentModelLabel(page: Page): Promise<string> {
  const gear = page.locator("#gear-btn");
  if (await page.locator("#gear-popover").isVisible()) {
    await gear.click();
    await page.locator("#gear-popover").waitFor({ state: "hidden" });
  }
  await gear.click();
  await page.locator(".model-name-btn").waitFor({ state: "visible" });
  const text = await page.locator(".model-name-btn").innerText();
  await gear.click();
  await page.locator("#gear-popover").waitFor({ state: "hidden" });
  return text;
}

async function newSession(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press("Escape");
    try {
      await page.locator("#new-btn").click({ timeout: 3_000 });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(200);
    }
  }
  await waitComposerReady(page);
}

async function sendGrok(page: Page, prompt: string): Promise<void> {
  await page.locator("#input").fill(prompt);
  await page.locator("#send-btn").click();
  await page.locator(".msg.user").filter({ hasText: prompt }).last().waitFor({ timeout: 30_000 });
  await waitText(page, page.locator("#messages"), /\bok\b/);
  await page.locator("body:not(.turn-busy)").waitFor({ timeout: 30_000 });
}

async function sendCodexAndAnswer(page: Page, prompt: string): Promise<void> {
  await page.locator("#input").fill(prompt);
  await page.locator("#send-btn").click();
  await page.locator(".msg.user").filter({ hasText: prompt }).last().waitFor({ timeout: 30_000 });
  let card = page.locator(".card.permission:not(.resolved)").last();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.locator("button").filter({ hasText: /Allow once/i }).click();
  card = page.locator(".card.permission:not(.resolved)").last();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.locator("button").filter({ hasText: /Revise/i }).click();
  await waitText(page, page.locator("#messages"), /codex ok/i);
  await page.locator("body:not(.turn-busy)").waitFor({ timeout: 30_000 });
}

async function openHistory(page: Page): Promise<void> {
  if (await page.locator("#history-popover").isVisible()) return;
  await page.locator("#history-btn").click();
  await page.locator("#history-popover").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#history-popover .history-list .history-row").first().waitFor({ state: "visible", timeout: 30_000 });
}

async function resumeHistory(page: Page, name: RegExp): Promise<void> {
  await openHistory(page);
  await page.locator("#history-popover .history-row").filter({ hasText: name }).first().click();
  await waitComposerReady(page);
}

async function renameHistoryById(page: Page, id: string, name: string): Promise<void> {
  await openHistory(page);
  const row = page.locator(`#history-popover .history-row[data-session-id="${id}"]`);
  await waitCount(page, row, 1);
  await row.locator('button[title="Rename"]').click();
  const input = page.locator(`#history-popover .history-row[data-session-id="${id}"] input.history-rename`);
  await input.fill(name);
  await input.press("Enter");
  await waitText(page, page.locator(`#history-popover .history-row[data-session-id="${id}"]`), name);
}

async function deleteHistory(page: Page, name: RegExp): Promise<void> {
  await openHistory(page);
  const row = page.locator("#history-popover .history-row").filter({ hasText: name }).first();
  await row.locator('button[title="Delete"]').click();
  await page.locator(".confirm-panel button").filter({ hasText: /^Delete$/ }).click();
}

async function expandedRailText(page: Page): Promise<string> {
  for (let pass = 0; pass < 4; pass += 1) {
    const more = page.locator("#projects-rail .rail-more").filter({ hasText: /^Show more$/ });
    const count = await more.count();
    if (!count) break;
    await more.first().click();
  }
  return page.locator("#projects-rail").innerText();
}

async function autoAcceptNativeDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
}

function codexEvents(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

describe("provider user flows: shared real Electron app", () => {
  let flow: FlowApp;
  const grokArchive = "Grok archived conversation";
  const grokPrompt = "flow-one-grok-round-trip";

  beforeAll(async () => {
    flow = await launchFlowApp({
      config: { "grok.cliPath": grokCli, "grok.codexCliPath": codexCli },
      connections: {},
      history: [{ id: "grok-archive-1", title: grokArchive }],
    });
  }, 90_000);

  afterAll(async () => { await flow.cleanup(); });

  it("1. fresh install connects Grok first and chats without provider glyphs", async () => {
    const { page } = flow;
    const tiles = page.locator(".onb-agent-tile");
    await waitCount(page, tiles, 2);
    expect(await tiles.first().innerText()).toContain("Grok");
    expect(await tiles.first().getAttribute("class")).toMatch(/primary/);

    await connectFromOnboarding(page, "grok");
    expect(await eventually(page, () => currentModelLabel(page), (value) => /Fake/i.test(value), "Fake model")).toMatch(/Fake/i);
    expect(await page.locator(".provider-glyph").count()).toBe(0);
    await sendGrok(page, grokPrompt);
    expect(await page.locator("#messages").innerText()).toContain(grokPrompt);
    expect(await page.locator(".provider-glyph").count()).toBe(0);
  });

  it("2. connects Codex at bottom without disturbing chat, then chooses a Codex model", async () => {
    const { page } = flow;
    const before = await page.locator("#messages").innerText();
    await accountAction(page, "Codex", "Connect");
    await finishAccountConnect(page, "codex");
    expect(await page.locator("#messages").innerText()).toContain(grokPrompt);
    expect(await page.locator("#messages").innerText()).toBe(before);

    await newSession(page);
    await openModelPicker(page);
    expect((await page.locator(".model-provider-heading").allInnerTexts()).map((text) => text.toLowerCase()))
      .toEqual(["grok", "codex"]);
    await page.locator("#gear-popover .toolbar-popover-item").filter({ hasText: /GPT 5\.6 Sol/i }).click();
    await waitComposerReady(page);
    await waitAtLeast(page, page.locator(".rail-session.active .provider-codex"), 1);
    await sendCodexAndAnswer(page, "flow-two-codex-round-trip");

    await openHistory(page);
    expect(await page.locator("#history-popover .provider-grok").count()).toBeGreaterThan(0);
    expect(await page.locator("#history-popover .provider-codex").count()).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    expect(await page.locator(".rail-session .provider-grok").count()).toBeGreaterThan(0);
    expect(await page.locator(".rail-session .provider-codex").count()).toBeGreaterThan(0);

    const spawns = codexEvents(flow.codexSink).filter((event) => event.type === "spawn");
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    expect(spawns.every((event) => event.electronRunAsNode === "1")).toBe(true);
    expect(spawns.every((event) => path.resolve(event.codexPath) === path.resolve(codexCli))).toBe(true);
  });

  it("4. remembers the last-used provider per project in both directions", async () => {
    const { page } = flow;
    await newSession(page);
    await chooseModel(page, /^Fake$/i);
    await newSession(page);
    expect(await eventually(page, () => currentModelLabel(page), (value) => /Fake/i.test(value), "Grok default")).toMatch(/Fake/i);
    await waitAtLeast(page, page.locator(".rail-session.active .provider-grok"), 1);

    await chooseModel(page, /GPT 5\.6 Sol/i);
    await sendCodexAndAnswer(page, "flow-four-codex-last-used");
    await newSession(page);
    expect(await eventually(page, () => currentModelLabel(page), (value) => /GPT 5\.6 Sol/i.test(value), "Codex default")).toMatch(/GPT 5\.6 Sol/i);
    await waitAtLeast(page, page.locator(".rail-session.active .provider-codex"), 1);
  });

  it("8. resumes both providers, deletes Codex, and keeps a refused row with visible failure", async () => {
    const { app, page } = flow;
    await autoAcceptNativeDialogs(app);
    await resumeHistory(page, /First/);
    await eventually(
      page,
      async () => codexEvents(flow.codexSink),
      (events) => events.some((event) => event.type === "session/load" && event.sessionId === "listed-1"),
      "Codex adapter load of the selected row",
    );
    expect(await eventually(page, () => currentModelLabel(page), (value) => /GPT 5\.6 Sol/i.test(value), "resumed Codex model"))
      .toMatch(/GPT 5\.6 Sol/i);
    await resumeHistory(page, new RegExp(grokPrompt));
    expect(await eventually(page, () => currentModelLabel(page), (value) => /Fake/i.test(value), "resumed Grok model"))
      .toMatch(/Fake/i);
    expect(await page.locator("#messages").innerText()).toContain(grokPrompt);

    await deleteHistory(page, /First/);
    await waitCount(page, page.locator("#history-popover .history-row").filter({ hasText: /First/ }), 0, 20_000);
    await deleteHistory(page, /Refused delete/i);
    await page.locator(".msg.error").filter({ hasText: /Codex refused to delete.*delete refused/i }).waitFor({ state: "visible", timeout: 20_000 });
    await openHistory(page);
    await waitCount(page, page.locator("#history-popover .history-row").filter({ hasText: /Refused delete/i }), 1);
    await page.keyboard.press("Escape");
  });

  it("7. signs providers out independently and restores their rows on reconnect", async () => {
    const { app, page } = flow;
    await autoAcceptNativeDialogs(app);
    await resumeHistory(page, new RegExp(grokPrompt));
    await accountAction(page, "Codex", "Sign out");
    expect(await eventually(page, async () => {
      await openRailGear(page);
      const text = await page.locator("#gear-popover").innerText();
      await page.keyboard.press("Escape");
      return text;
    }, (value) => /Codex\s*Connect/i.test(value), "Codex connect action")).toMatch(/Codex\s*Connect/i);
    await openHistory(page);
    expect(await page.locator("#history-popover .history-list").innerText()).not.toContain("Second");
    expect(await page.locator("#history-popover .history-list").innerText()).toContain(grokArchive);
    await page.keyboard.press("Escape");
    expect(await expandedRailText(page)).not.toContain("Second");
    expect(await expandedRailText(page)).toContain(grokArchive);

    await accountAction(page, "Codex", "Connect");
    await finishAccountConnect(page, "codex");
    await openHistory(page);
    await waitText(page, page.locator("#history-popover .history-list"), "Second");
    await page.keyboard.press("Escape");
    expect(await expandedRailText(page)).toContain("Second");

    await resumeHistory(page, /Second/);
    await accountAction(page, "Grok", "Sign out");
    await openHistory(page);
    expect(await page.locator("#history-popover .history-list").innerText()).not.toContain(grokArchive);
    expect(await page.locator("#history-popover .history-list").innerText()).toContain("Second");
    await page.keyboard.press("Escape");
    expect(await expandedRailText(page)).not.toContain(grokArchive);
    expect(await expandedRailText(page)).toContain("Second");

    await accountAction(page, "Grok", "Connect");
    await finishAccountConnect(page, "grok");
    await openHistory(page);
    await waitText(page, page.locator("#history-popover .history-list"), grokArchive);
    await page.keyboard.press("Escape");
    expect(await expandedRailText(page)).toContain(grokArchive);
  });
});

describe("3. Codex-only fresh install in real Electron", () => {
  let flow: FlowApp;
  beforeAll(async () => {
    flow = await launchFlowApp({ config: { "grok.codexCliPath": codexCli }, connections: {} });
  }, 90_000);
  afterAll(async () => { await flow.cleanup(); });

  it("warms models, hides the scratch session, answers permission, queues unsupported steer, and cancels", async () => {
    const { page, workspace, userData, codexSink } = flow;
    await connectFromOnboarding(page, "codex");

    const globalState = await eventually(
      page,
      async () => JSON.parse(fs.readFileSync(path.join(userData, "globalState.json"), "utf8")),
      (value) => Array.isArray(value?.["grok.providerModelCache"]?.codex?.models),
      "persisted Codex model cache",
    );
    expect(globalState["grok.providerModelCache"].codex.models.map((model: any) => model.modelId))
      .toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    await openModelPicker(page);
    expect((await page.locator(".model-provider-heading").allInnerTexts()).map((text) => text.toLowerCase()))
      .toEqual(["codex"]);
    expect(await page.locator("#gear-popover").innerText()).toContain("GPT 5.6 Sol");
    await page.keyboard.press("Escape");
    expect(await page.locator(".provider-glyph").count()).toBe(0);

    await page.locator("#mode-btn").click();
    expect(await page.locator("#mode-popover .mode-item-label").allInnerTexts()).not.toContain("Plan mode");
    await page.keyboard.press("Escape");

    const events = codexEvents(codexSink);
    const warmNew = events.find((event) => event.type === "session/new" && path.resolve(event.cwd) !== path.resolve(workspace));
    expect(warmNew).toBeTruthy();
    expect(events.some((event) => event.type === "session/delete" && event.sessionId === warmNew.sessionId)).toBe(true);
    await openHistory(page);
    await waitCount(page, page.locator(`[data-session-dot="${warmNew.sessionId}"]`), 0);
    await page.keyboard.press("Escape");

    await sendCodexAndAnswer(page, "flow-three-permission");
    await waitText(page, page.locator(".perm-resolved").first(), "Allowed");

    await page.locator("#input").fill("SCENARIO_CANCEL");
    await page.locator("#send-btn").click();
    await waitBodyClass(page, "turn-busy", true);
    await page.locator("#input").fill("queue after unsupported steer");
    await page.locator("#send-btn").click();
    const queued = page.locator(".msg.user.queued");
    await waitText(page, queued, "queue after unsupported steer");
    await queued.locator(".queued-steer").click();
    await queued.waitFor({ state: "visible" });
    await waitCount(page, queued.locator(".queued-steer"), 0, 20_000);
    await page.locator("#send-btn").click();
    await waitBodyClass(page, "turn-busy", false);
    await page.locator("#mode-btn").waitFor({ state: "visible" });

  });

  it("renders a captured Codex generated image through the desktop media pipeline", async () => {
    const { page } = flow;
    await page.locator("#input").fill("SCENARIO_IMAGE_GENERATION");
    await page.locator("#send-btn").click();
    const generated = page.locator(".generated-image").last();
    await generated.waitFor({ state: "visible", timeout: 30_000 });
    expect(await generated.locator("img").getAttribute("src")).toMatch(/^app-resource:/);
    expect(await generated.locator('[title="Copy path"]').count()).toBe(1);
    expect(await generated.locator('[title="Show in folder"]').count()).toBe(1);
  });

});

describe("Codex session row identity in real Electron", () => {
  let flow: FlowApp;
  beforeAll(async () => {
    flow = await launchFlowApp({ config: { "grok.codexCliPath": codexCli }, connections: {} });
  }, 90_000);
  afterAll(async () => { await flow.cleanup(); });

  it("shows each case-drifted Codex session id once and selects equal GPT names independently", async () => {
    const { page, workspace, userData, codexSink } = flow;
    await connectFromOnboarding(page, "codex");

    await newSession(page);
    const firstId = await eventually(
      page,
      async () => codexEvents(codexSink)
        .filter((event) => event.type === "session/new" && path.resolve(event.cwd) === path.resolve(workspace))
        .at(-1)?.sessionId,
      (value) => typeof value === "string" && !!value,
      "first Codex session id",
    ) as string;
    await sendCodexAndAnswer(page, "case-drift-one");

    // The listing cache is intentionally short-lived. Wait it out so this is
    // the adapter row (case-drifted cwd), not only the synthetic live row.
    await page.waitForTimeout(10_500);
    await openHistory(page);
    await waitText(page, page.locator(`#history-popover .history-row[data-session-id="${firstId}"]`), "GPT");
    await waitCount(page, page.locator(`#history-popover .history-row[data-session-id="${firstId}"]`), 1);
    await page.keyboard.press("Escape");
    await waitCount(page, page.locator(`#projects-rail .rail-session[data-session-id="${firstId}"]`), 1);

    const listedCwd = await eventually(
      page,
      async () => {
        const state = JSON.parse(fs.readFileSync(path.join(userData, "globalState.json"), "utf8"));
        return state["grok.sessionMeta"]?.[firstId]?.providerCwd;
      },
      (value) => typeof value === "string" && value !== workspace && value.toLowerCase() === workspace.toLowerCase(),
      "case-drifted Codex cwd persistence",
    ) as string;
    expect(listedCwd).not.toBe(workspace);
    expect(listedCwd.toLowerCase()).toBe(workspace.toLowerCase());

    await renameHistoryById(page, firstId, "Only this row changed");
    await waitCount(page, page.locator("#history-popover .history-row").filter({ hasText: "Only this row changed" }), 1);
    await page.keyboard.press("Escape");
    await openHistory(page);
    await waitCount(page, page.locator(`#history-popover .history-row[data-session-id="${firstId}"]`), 1);
    await waitText(page, page.locator(`#history-popover .history-row[data-session-id="${firstId}"]`), "Only this row changed");
    await renameHistoryById(page, firstId, "GPT");
    await page.keyboard.press("Escape");

    await newSession(page);
    const secondId = await eventually(
      page,
      async () => codexEvents(codexSink)
        .filter((event) => event.type === "session/new" && path.resolve(event.cwd) === path.resolve(workspace))
        .map((event) => event.sessionId)
        .filter((id) => id !== firstId)
        .at(-1),
      (value) => typeof value === "string" && !!value,
      "second Codex session id",
    ) as string;
    await sendCodexAndAnswer(page, "case-drift-two");
    await renameHistoryById(page, secondId, "GPT");
    await page.keyboard.press("Escape");

    const firstRail = page.locator(`#projects-rail .rail-session[data-session-id="${firstId}"]`);
    const secondRail = page.locator(`#projects-rail .rail-session[data-session-id="${secondId}"]`);
    await waitCount(page, firstRail, 1);
    await waitCount(page, secondRail, 1);
    expect(await firstRail.locator(".rail-session-name").innerText()).toBe("GPT");
    expect(await secondRail.locator(".rail-session-name").innerText()).toBe("GPT");

    await firstRail.click();
    await eventually(
      page,
      () => page.locator("#projects-rail .rail-session.active").getAttribute("data-session-id"),
      (value) => value === firstId,
      "first GPT session selection",
    );
    await waitCount(page, page.locator("#projects-rail .rail-session.active"), 1);

    await page.locator(`#projects-rail .rail-session[data-session-id="${secondId}"]`).click();
    await eventually(
      page,
      () => page.locator("#projects-rail .rail-session.active").getAttribute("data-session-id"),
      (value) => value === secondId,
      "second GPT session selection",
    );
    await waitCount(page, page.locator("#projects-rail .rail-session.active"), 1);
  });
});

describe("5. Grok migration in real Electron", () => {
  let flow: FlowApp;
  beforeAll(async () => {
    flow = await launchFlowApp({
      config: { "grok.cliPath": grokCli },
      omitConnections: true,
      authEvidence: true,
      history: [{ id: "migration-history-1", title: "Migration history intact" }],
    });
  }, 90_000);
  afterAll(async () => { await flow.cleanup(); });

  it("silently connects Grok and preserves history", async () => {
    await waitComposerReady(flow.page);
    await flow.page.locator("#welcome-onboarding").waitFor({ state: "hidden" });
    await openHistory(flow.page);
    await waitText(flow.page, flow.page.locator("#history-popover .history-list"), "Migration history intact");
    expect(await flow.page.locator(".provider-glyph").count()).toBe(0);
  });
});

describe("6. missing Codex recovery loop in real Electron", () => {
  let flow: FlowApp;
  let missingCodex: string;
  beforeAll(async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), "grok-missing-codex-"));
    missingCodex = path.join(holder, "codex-fixture.cjs");
    flow = await launchFlowApp({ config: { "grok.codexCliPath": missingCodex }, connections: {} });
  }, 90_000);
  afterAll(async () => {
    await flow.cleanup();
    try { fs.rmSync(path.dirname(missingCodex), { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("shows install guidance, then connects when the configured binary appears", async () => {
    const { page } = flow;
    const tile = page.locator('[data-act="connectProvider"][data-provider="codex"]');
    await tile.click();
    await waitText(page, page.locator("#welcome-onboarding"), "npm i -g @openai/codex");
    await waitText(page, page.locator("#welcome-onboarding"), "ChatGPT extension");

    fs.copyFileSync(codexCli, missingCodex);
    const recheck = page.locator('[data-act="recheckProvider"][data-provider="codex"]');
    await recheck.click();
    await waitComposerReady(page);
    await page.locator("#welcome-onboarding").waitFor({ state: "hidden", timeout: 45_000 });
    expect(await eventually(page, () => currentModelLabel(page), (value) => /GPT 5\.6 Sol/i.test(value), "warmed Codex model")).toMatch(/GPT 5\.6 Sol/i);
  });
});


describe.each(["grok", "codex"] as const)("Desktop composer drafts (%s)", (provider) => {
  let flow: FlowApp;
  beforeAll(async () => {
    flow = await launchFlowApp({
      config: provider === "codex" ? { "grok.codexCliPath": codexCli } : { "grok.cliPath": grokCli },
      connections: {},
    });
  }, 90_000);
  afterAll(async () => { await flow?.cleanup(); });

  it("restores the draft belonging to each session selected in the rail", async () => {
    const { page } = flow;
    await connectFromOnboarding(page, provider);
    const send = provider === "codex" ? sendCodexAndAnswer : sendGrok;
    await send(page, "First conversation");
    const activeId = () => page.locator("#projects-rail .rail-session.active").getAttribute("data-session-id");
    const firstId = await eventually(page, activeId,
      (value) => !!value && !value.startsWith("pending-new:"), "first conversation identity");
    await page.locator("#input").fill("Draft A");
    await newSession(page);
    expect(await page.locator("#input").inputValue()).toBe("");
    await send(page, "Second conversation");
    const secondId = await eventually(page, activeId,
      (value) => !!value && value !== firstId && !value.startsWith("pending-new:"), "second conversation identity");
    await page.locator("#input").fill("Draft B");
    await page.locator('#projects-rail .rail-session[data-session-id="' + firstId + '"]').click();
    await eventually(page, () => page.locator("#input").inputValue(),
      (value) => value === "Draft A", "first conversation draft");
    await page.locator('#projects-rail .rail-session[data-session-id="' + secondId + '"]').click();
    await eventually(page, () => page.locator("#input").inputValue(),
      (value) => value === "Draft B", "second conversation draft");
  });
});
