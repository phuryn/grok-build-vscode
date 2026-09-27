// Real desktop/host/renderer lane. Importing helpers never launches Electron or a CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { bounded, timeoutMs, selectSmokeModel, SUBAGENT_PROMPT, WORKFLOW_PROMPT, delegationAttempted } from "./acp-smoke.mjs";
import { knownBoundaries, classifyBoundaries, readRenderedChat, assertRenderedScenario, renderReportMarkdown, completeRenderScenarios } from "./smoke-render-report.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function waitFor(read, label, ms) {
  const until = Date.now() + ms;
  do {
    const result = await bounded(Promise.resolve().then(read), label, Math.max(1, until - Date.now()));
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  throw Object.assign(new Error(`${label} never arrived within ${ms}ms`), { code: "ACP_SMOKE_TIMEOUT" });
}

/** Existing live commands call this after their protocol checks. It spends credits. */
export async function runRenderSmoke(provider, evidenceParent, cliOverride) {
  assert(["grok", "codex", "claude", "muse"].includes(provider), "unknown render provider");
  for (const key of Object.keys(process.env)) assert(!/^GROK_TEST_.*(?:ADAPTER|CLI).*PATH$/.test(key) || !process.env[key], `refusing fixture override ${key}`);
  const { _electron: electron } = await import("playwright");
  const output = path.join(evidenceParent, `${provider}-render`);
  fs.mkdirSync(output, { recursive: true });
  const known = knownBoundaries(root, provider);
  const report = { provider, route: "real Electron desktop → AcpClient → GrokSidebar → ElectronWebview → media/chat.js (Playwright)",
    limitations: [known.limitation, "Host preferences are isolated; automatic CLI updating is disabled. Provider homes/logins remain real. Additional trivial live prompts are used, not synthesized host messages."],
    scenarios: [], boundaries: { seen: [], unhandled: [], ignored: [] }, known };
  const rpcMs = timeoutMs(process.env.ACP_SMOKE_RPC_TIMEOUT_MS, 90_000);
  const turnMs = timeoutMs(process.env.ACP_SMOKE_TURN_TIMEOUT_MS, 180_000);
  const workflowMs = timeoutMs(process.env.ACP_SMOKE_WORKFLOW_TIMEOUT_MS, 300_000);
  const deliveryMs = timeoutMs(process.env.ACP_SMOKE_DELIVERY_TIMEOUT_MS, 60_000);
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-render-smoke-")));
  const workspace = path.join(scratch, "workspace"), profile = path.join(scratch, "profile");
  let app, page;
  const pageErrors = [];
  let failure;
  const save = () => {
    const wire = path.join(output, "desktop-wire.jsonl");
    const events = fs.existsSync(wire) ? fs.readFileSync(wire, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
    report.pageErrors = [...new Set([...pageErrors, ...events.filter(e => e.direction === "page-error").map(e => e.message.text)])];
    report.boundaries = classifyBoundaries(events, known);
    fs.writeFileSync(path.join(output, "render-report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, "render-report.md"), renderReportMarkdown(report));
  };
  try {
    fs.mkdirSync(workspace); fs.mkdirSync(profile);
    const locator = provider === "grok" ? require("../out/cli-locator.js").locateGrokCli
      : require(`../out/${provider}-cli-locator.js`)[`locate${provider[0].toUpperCase() + provider.slice(1)}Cli`];
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path") || "PATH";
    env[pathKey] = (env[pathKey] || "").split(path.delimiter).filter(p => !/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(p)).join(path.delimiter);
    const configuredPath = cliOverride || process.env[`${provider.toUpperCase()}_CLI_PATH`] || (provider === "grok" ? process.env.GROK_BIN : undefined);
    const cli = provider === "grok" ? locator(configuredPath || "", env) : locator({ env, configuredPath });
    assert(cli && !/fake-|[\\/]fixtures[\\/]/i.test(cli), `no real ${provider} CLI located`);
    const config = { [`grok.${provider === "grok" ? "cliPath" : `${provider}CliPath`}`]: cli,
      "grok.telemetry.enabled": false, "grok.includeActiveFileByDefault": false,
      "grok.readRepliesAloud": false, "grok.soundNotifications": false, "grok.desktop.tray.enabled": false };
    fs.writeFileSync(path.join(profile, "config.json"), JSON.stringify(config));
    fs.writeFileSync(path.join(profile, "globalState.json"), JSON.stringify({ "grok.providerConnections.v2": { [provider]: true },
      "grok.cliUpdateExtVersion": require("../package.json").version }));
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, { NODE_ENV: "test", GROK_DESKTOP_TEST_ALLOW_MULTIPLE: "1", ACP_SMOKE_RENDER_OUTPUT: output, ACP_SMOKE_RENDER_PROFILE: profile });
    const executablePath = process.platform === "darwin" ? path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
      : path.join(root, "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron");
    app = await electron.launch({ executablePath, args: [path.join(root, "scripts/smoke-desktop-bootstrap.cjs"),
      `--workspace=${workspace}`, `--user-data-dir=${profile}`, `--config-json=${path.join(profile, "config.json")}`], env, timeout: rpcMs });
    const watched = new WeakSet();
    const watch = p => { if (watched.has(p)) return; watched.add(p); p.on("pageerror", error => pageErrors.push(String(error))); p.on("crash", () => pageErrors.push("renderer crashed")); };
    app.on("window", watch);
    page = await app.firstWindow({ timeout: rpcMs }); watch(page);
    await page.waitForSelector("#input", { timeout: rpcMs });
    const status = () => app.evaluate(() => globalThis.__renderSmoke.status());
    const host = message => bounded(app.evaluate(async (_, m) => globalThis.__renderSmoke.sidebar.onMessage(m, "local"), message), "desktop host action", rpcMs);
    const snapshot = async () => page.evaluate(readRenderedChat);
    const capture = async scenario => {
      // Exercise each actual disclosure; do not synthesize result text from wire.
      const headers = page.locator("#messages .subagent-card .delegation-header, #messages .workflow-card .delegation-header");
      for (let i = 0; i < await headers.count(); i++) if (await headers.nth(i).getAttribute("aria-expanded") === "true") await headers.nth(i).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      scenario.closed = await snapshot();
      for (let i = 0; i < await headers.count(); i++) if (await headers.nth(i).getAttribute("aria-disabled") !== "true") await headers.nth(i).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      scenario.opened = await snapshot();
      scenario.pageErrors = [...pageErrors, ...(await status()).events.filter(e => e.direction === "page-error").map(e => e.message.text)];
      await page.screenshot({ path: path.join(output, `${scenario.name.replaceAll(" ", "-")}.png`), fullPage: true });
    };
    const setup = async (name, fresh) => {
      const previous = fresh ? (await status()).sessionId : undefined;
      if (fresh) await host({ type: "newSession" });
      const live = await waitFor(async () => { const s = await status(); return s.sessionId && s.sessionId !== previous && s.models?.length && s; }, `${provider} desktop session/model catalog`, rpcMs);
      assert.equal(live.provider, provider, "desktop selected a different provider");
      const selection = selectSmokeModel({ models: { availableModels: live.models.map(m => ({ ...m, _meta: {
        supportsReasoningEffort: m.supportsReasoningEffort, reasoningEfforts: m.reasoningEfforts?.map(value => ({ value })) } })) } }, process.env[`ACP_SMOKE_${provider.toUpperCase()}_MODEL`]);
      await host({ type: "setModel", provider, modelId: selection.modelId, effort: selection.effort });
      await waitFor(async () => { const s = await status(); return s.modelId === selection.modelId && (!selection.effort || s.effort === selection.effort); }, `${provider} desktop selected model/effort acknowledgement`, rpcMs);
      console.log(`[render] ${provider} ${name}: model=${selection.modelId}; effort=${selection.effort || "N/A"}; ${selection.basis}`);
      await app.evaluate((_, n) => { const s = globalThis.__renderSmoke; s.mark(n); s.workflowDone = false; s.delivery = "unarmed"; }, name);
      return selection;
    };
    const send = async text => { await page.locator("#input").fill(text); await page.locator("#send-btn:not(.stop):not([disabled])").click({ timeout: rpcMs }); };
    const endTurn = async name => waitFor(async () => {
      const events = (await status()).events.filter(e => e.scenario === name);
      const sent = events.find(e => e.direction === "send" && e.message.method === "session/prompt");
      const received = sent && events.slice(events.indexOf(sent) + 1).find(e => e.direction === "receive" && e.clientId === sent.clientId && !e.message.method && e.message.id === sent.message.id);
      if (!received) return false;
      assert(!received.message.error, `prompt refused/failed: ${JSON.stringify(received.message.error)}`);
      assert.equal(received.message.result?.stopReason, "end_turn", "desktop prompt did not complete normally");
      return true;
    }, `${provider} ${name} prompt completion`, turnMs);

    for (const name of ["plain reply", "subagent", "workflow"]) {
      const scenario = { name, result: "PASS", pageErrors: [] };
      report.scenarios.push(scenario);
      if ((name === "workflow" && provider === "codex") || (name === "subagent" && provider === "muse")) {
        Object.assign(scenario, { result: "N/A", reason: provider === "codex" ? "Codex has no workflows" : "Muse delegation is a workflow" });
        continue;
      }
      try {
        scenario.model = await setup(name, name !== "plain reply");
        if (provider === "muse" && name === "workflow") await app.evaluate(() => {
          const s = globalThis.__renderSmoke; s.delivery = "armed";
          s.deliveryText = "Do not use tools. Reply with the single word ok for this new prompt.";
        });
        await send(name === "plain reply" ? "Do not use tools. Reply with the single word ready." : name === "subagent" ? SUBAGENT_PROMPT : WORKFLOW_PROMPT);
        await endTurn(name);
        if (name !== "plain reply") {
          const frames = (await status()).events.filter(e => e.scenario === name && e.direction === "receive" && e.message.params?.update).map(e => ({ raw: e.message.params.update }));
          // A card OR launch evidence proves an attempt. Missing rendered output
          // after that is a failure, never relabeled a model refusal.
          const current = await snapshot();
          if (!delegationAttempted(frames, name) && !current.cards.some(c => c.kind === name)) {
            Object.assign(scenario, { result: "INCONCLUSIVE", reason: "model did not delegate (no retry); inspect wire and reply" });
          } else await waitFor(async () => { const s = await snapshot(); const cards = s.cards.filter(c => c.kind === name); return cards.length && cards.every(c => c.terminal); }, `${name} rendered terminal card`, workflowMs);
        }
        // Flush actual renderer frame coalescing before reading the answer.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await capture(scenario);
        assertRenderedScenario(scenario);
      } catch (error) {
        Object.assign(scenario, { result: "FAIL", reason: String(error.message) });
        failure ??= error;
        await capture(scenario).catch(e => scenario.pageErrors.push(String(e)));
      } finally { save(); }

      if (provider === "muse" && name === "workflow") {
        const delivery = { name: "delivery prompt", result: "PASS", pageErrors: [] };
        report.scenarios.push(delivery);
        try {
          const observed = await waitFor(async () => (await status()).delivery === "observed", "Muse unprompted desktop delivery", deliveryMs).catch(error => { if (error.code === "ACP_SMOKE_TIMEOUT") return false; throw error; });
          if (!observed) Object.assign(delivery, { result: "INCONCLUSIVE", reason: "not observed: no unsolicited live delivery chunk in the bounded window" });
          else { await endTurn("delivery prompt"); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
          await capture(delivery);
          // The background answer and admission probe overlap by design. Retain
          // the settled visible transcript too; do not call a partial launch
          // answer the workflow's final prose or guess how to split a bubble.
          scenario.postDeliveryTranscript = delivery.opened;
          scenario.captureNote = "closed/opened captured at workflow completion; postDeliveryTranscript is the settled real DOM after the overlapping admission probe";
          assertRenderedScenario(delivery);
        } catch (error) {
          Object.assign(delivery, { result: "FAIL", reason: String(error.message) }); failure ??= error;
          await capture(delivery).catch(e => delivery.pageErrors.push(String(e)));
        } finally { save(); }
      }
    }
    if (provider !== "muse") report.scenarios.push({ name: "delivery prompt", result: "N/A", reason: "Muse-specific admission regression", pageErrors: [] });
  } catch (error) {
    failure ??= error;
    report.scenarios.push({ name: "desktop setup", result: "FAIL", reason: String(error.message), pageErrors: [...pageErrors] });
  } finally {
    if (app) {
      try {
        await bounded(app.evaluate(async () => { for (const client of globalThis.__renderSmoke.clients) await client.dispose(); }), "desktop provider shutdown", 30_000);
        await bounded(app.close(), "desktop shutdown", 15_000);
      } catch (error) {
        failure ??= error;
        report.scenarios.push({ name: "cleanup", result: "FAIL", reason: String(error.message), pageErrors: [] });
        const proc = app.process();
        try { if (proc.exitCode === null && proc.signalCode === null) {
          if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
          else proc.kill("SIGKILL");
        } } catch (killError) { report.scenarios.push({ name: "process cleanup", result: "FAIL", reason: String(killError.message), pageErrors: [] }); }
      }
    }
    try {
      const relative = path.relative(fs.realpathSync(os.tmpdir()), scratch);
      assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(scratch).startsWith("grok-render-smoke-"), "refusing cleanup outside OS-temp render scratch");
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) { failure ??= error; report.scenarios.push({ name: "scratch cleanup", result: "FAIL", reason: String(error.message), pageErrors: [] }); }
    report.scenarios = completeRenderScenarios(report.scenarios, provider);
    save();
    console.log(renderReportMarkdown(report));
    console.log(`[render] Evidence: ${output}`);
  }
  if (report.boundaries.unhandled.length) failure ??= new Error("UNHANDLED boundary kinds observed; see render-report.md");
  if (report.pageErrors.length) failure ??= new Error(`renderer threw: ${report.pageErrors.join("; ")}`);
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const provider = process.argv.slice(2).find(arg => arg.startsWith("--provider="))?.slice(11);
  assert(provider, "usage: npm run smoke:render -- --provider=grok|codex|claude|muse");
  const parent = path.join(root, ".verification/acp-smoke"); fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, "render-"));
  runRenderSmoke(provider, output).catch(error => { console.error(error); process.exitCode = 1; });
}
