// Real desktop/host/renderer lane. Importing helpers never launches Electron or a CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { bounded, timeoutMs, selectSmokeModel, selectSmokeEffort, desktopSmokeCatalog, smokeScenario, SUBAGENT_PROMPT, WORKFLOW_PROMPT, delegationAttempted } from "./acp-smoke.mjs";
import { knownBoundaries, classifyBoundaries, readRenderedChat, assertRenderedScenario, renderReportMarkdown, completeRenderScenarios, cardResultEvidence, smokeOutcome } from "./smoke-render-report.mjs";
import { desktopLaunch, parseTrace, desktopFacts, promptCompletion, modelRowIndex, deliveryChunk } from "./smoke-page-driver.mjs";
import { cleanupBudget, closeDesktop } from "./smoke-cleanup.mjs";
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
export async function runRenderSmoke(provider, evidenceParent, cliOverride, selectedScenario) {
  assert(["grok", "codex", "claude", "muse"].includes(provider), "unknown render provider");
  for (const key of Object.keys(process.env)) assert(!/^GROK_TEST_.*(?:ADAPTER|CLI).*PATH$/.test(key) || !process.env[key], `refusing fixture override ${key}`);
  const { _electron: electron } = await import("playwright");
  const output = path.join(evidenceParent, `${provider}-render`);
  fs.mkdirSync(output, { recursive: true });
  const known = knownBoundaries(root, provider);
  const report = { provider, route: "real Electron desktop → AcpClient → GrokSidebar → ElectronWebview → media/chat.js (Playwright)",
    limitations: [known.limitation, "Temporary desktop profile/workspace; provider homes, logins and shared client-state remain real. Extension-upgrade update stamp is seeded; normal desktop behavior is otherwise unchanged. Additional live prompts are sent through the page."],
    scenarios: [], boundaries: { seen: [], unhandled: [], ignored: [] }, known };
  const rpcMs = timeoutMs(process.env.ACP_SMOKE_RPC_TIMEOUT_MS, 90_000);
  const turnMs = timeoutMs(process.env.ACP_SMOKE_TURN_TIMEOUT_MS, 180_000);
  const workflowMs = timeoutMs(process.env.ACP_SMOKE_WORKFLOW_TIMEOUT_MS, 300_000);
  const deliveryMs = timeoutMs(process.env.ACP_SMOKE_DELIVERY_TIMEOUT_MS, 60_000);
  const cleanupMs = timeoutMs(process.env.ACP_SMOKE_CLEANUP_TIMEOUT_MS, cleanupBudget(provider));
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-render-smoke-")));
  const workspace = path.join(scratch, "workspace"), profile = path.join(scratch, "profile");
  let app, page, proc;
  const pageErrors = [];
  let failure;
  const readEvents = () => {
    const wire = path.join(output, "desktop-wire.jsonl");
    // The writer appends synchronously; a concurrently-read partial final line
    // is not yet an event. Retain every complete line, including unknown kinds.
    const text = fs.existsSync(wire) ? fs.readFileSync(wire, "utf8") : "";
    return parseTrace(text);
  };
  const save = () => {
    const events = readEvents();
    report.pageErrors = [...new Set([...pageErrors, ...events.filter(e => e.direction === "page-error").map(e => e.message.text)])];
    report.boundaries = classifyBoundaries(events, known);
    Object.assign(report, smokeOutcome(report.scenarios, report.boundaries.unhandled.length > 0 || report.pageErrors.length > 0));
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
      "grok.readRepliesAloud": false, "grok.soundNotifications": false, "grok.desktop.tray": false };
    fs.writeFileSync(path.join(profile, "config.json"), JSON.stringify(config));
    fs.writeFileSync(path.join(profile, "globalState.json"), JSON.stringify({ "grok.providerConnections.v2": { [provider]: true },
      "grok.cliUpdateExtVersion": require("../package.json").version }));
    app = await electron.launch({ ...desktopLaunch(root, require("electron"), workspace, profile, output, env), timeout: rpcMs });
    // app.process() resolves through a dispatcher that is gone after app.close.
    // Capture the process now so cleanup cannot replace the original failure
    // with Playwright's "undefined (reading '_object')".
    proc = app.process();
    const watched = new WeakSet();
    const watch = p => { if (watched.has(p)) return; watched.add(p); p.on("pageerror", error => pageErrors.push(String(error))); p.on("crash", () => pageErrors.push("renderer crashed")); };
    app.on("window", watch);
    page = await app.firstWindow({ timeout: rpcMs }); watch(page);
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.waitForSelector("#input", { timeout: rpcMs });
    await waitFor(() => readEvents().some(e => e.direction === "trace-ready"), "passive desktop trace preload", rpcMs);
    const status = () => desktopFacts(readEvents());
    const settled = () => page.evaluate(() => !document.body.classList.contains("turn-busy")
      && document.querySelector("#send-btn")?.title === "Send" && !document.querySelector("#send-btn")?.disabled);
    const picker = async () => { await page.locator("#gear-btn").click(); await page.locator("#gear-popover .model-picker-row").first().waitFor({ state: "visible", timeout: rpcMs }); };
    const closePicker = () => page.keyboard.press("Escape");
    const chooseModel = async model => {
      await picker();
      const rows = await page.locator("#gear-popover .model-picker-row").evaluateAll(elements => elements.map(el => ({
        title: el.title, name: el.querySelector(".model-picker-name")?.textContent,
        provider: [...(el.querySelector(".provider-glyph")?.classList || [])].find(c => c.startsWith("provider-") && c !== "provider-glyph")?.slice(9),
      })));
      const row = page.locator("#gear-popover .model-picker-row").nth(modelRowIndex(rows, model, provider));
      if (await row.getAttribute("aria-checked") !== "true") await row.click();
      await closePicker();
    };
    // Real permission controls, using the exact option advertised by the host.
    const approve = async () => {
      const cards = page.locator(".card.permission:not(.resolved)");
      for (let i = 0; i < await cards.count(); i++) {
        const card = cards.nth(i), id = await card.getAttribute("data-perm-req-id");
        const request = readEvents().findLast(e => e.direction === "host-to-webview" && e.message.type === "permissionRequest" && String(e.message.req?.id) === id)?.message.req;
        const option = request?.options?.find(o => o.kind === "allow_once");
        assert(option, `permission ${id} has no allow_once option; inspect desktop-wire.jsonl`);
        await card.locator(".card-actions").getByRole("button", { name: option.name, exact: true }).click({ timeout: rpcMs });
      }
    };
    let deliveryProbe;
    const pump = async () => {
      await approve();
      if (deliveryProbe && !deliveryProbe.observed && !deliveryProbe.expired) {
        const events = readEvents();
        const chunk = deliveryChunk(events, deliveryProbe.from, deliveryProbe.clientId, deliveryProbe.sessionId);
        if (chunk && await settled()) {
          // Pre-fill while awaiting delivery; the only action here is the real Send.
          deliveryProbe.fromDelivery = events.length;
          await page.locator("#send-btn:not(.stop):not([disabled])").click({ timeout: rpcMs });
          deliveryProbe.observed = { chunkAt: chunk.at, clickedAt: new Date().toISOString() };
        }
      }
    };
    const waitPage = (read, label, ms) => waitFor(async () => { await pump(); return read(); }, label, ms);
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
      scenario.resultEvidence = cardResultEvidence(scenario.opened.cards, readEvents().slice(scenario.trace?.from ?? 0), { provider });
      scenario.pageErrors = [...pageErrors, ...readEvents().filter(e => e.direction === "page-error").map(e => e.message.text)];
      await page.screenshot({ path: path.join(output, `${scenario.name.replaceAll(" ", "-")}.png`), fullPage: true });
    };
    const setup = async (name, fresh) => {
      const previous = fresh ? status()?.sessionId : undefined;
      if (fresh) await page.locator("#new-btn").click();
      // Select the provider through the same real picker used by the working
      // screenshot driver. No prompt is sent until its catalog is acknowledged.
      await picker();
      const providerRow = page.locator(`#gear-popover .model-picker-row:has(.provider-glyph.provider-${provider})`).first();
      await providerRow.waitFor({ state: "visible", timeout: rpcMs });
      if (status()?.provider !== provider) await providerRow.click();
      await closePicker();
      const live = await waitPage(async () => { const s = status(); return s?.provider === provider && s.sessionId !== previous && s.models?.length && await settled() && s; }, `${provider} desktop session/model catalog`, rpcMs);
      const selection = selectSmokeModel(desktopSmokeCatalog(live), process.env[`ACP_SMOKE_${provider.toUpperCase()}_MODEL`]);
      await chooseModel(live.models.find(m => m.modelId === selection.modelId));
      const switched = await waitPage(async () => { const s = status(); return s?.modelId === selection.modelId && await settled() && s; }, `${provider} desktop model acknowledgement`, rpcMs);
      const model = switched.models.find(m => m.modelId === selection.modelId);
      selection.effort = selectSmokeEffort(switched, { _meta: { reasoningEfforts: model.reasoningEfforts } }).effort;
      if (selection.effort && switched.effort !== selection.effort) {
        await picker();
        const effort = page.locator("#gear-popover .effort-strip-stop");
        const values = await effort.evaluateAll(elements => elements.map(el => el.getAttribute("data-effort")));
        const index = values.indexOf(selection.effort);
        assert(index >= 0, `picker does not offer ${selection.effort}`);
        await effort.nth(index).click();
        await closePicker();
      }
      await waitPage(async () => { const s = status(); return s?.modelId === selection.modelId && (!selection.effort || s.effort === selection.effort) && await settled(); }, `${provider} desktop model/effort acknowledgement`, rpcMs);
      console.log(`[render] ${provider} ${name}: model=${selection.modelId}; effort=${selection.effort || "N/A"}; ${selection.basis}`);
      return selection;
    };
    const send = async text => { await page.locator("#input").fill(text); await page.locator("#send-btn:not(.stop):not([disabled])").click({ timeout: rpcMs }); };
    const endTurn = (name, from, client) => waitPage(() => promptCompletion(readEvents(), from, client.clientId, client.sessionId), `${provider} ${name} prompt completion`, turnMs);

    for (const name of ["plain reply", "subagent", "workflow"]) {
      const scenario = { name, result: "PASS", pageErrors: [] };
      report.scenarios.push(scenario);
      if (selectedScenario && name !== selectedScenario) {
        Object.assign(scenario, { result: "NOT RUN", reason: "excluded by --scenario; not release validation" });
        continue;
      }
      if ((name === "workflow" && provider === "codex") || (name === "subagent" && provider === "muse")) {
        Object.assign(scenario, { result: "N/A", reason: provider === "codex" ? "Codex has no workflows" : "Muse delegation is a workflow" });
        continue;
      }
      try {
        scenario.model = await setup(name, !selectedScenario && name !== "plain reply");
        const client = status(), from = readEvents().length;
        scenario.trace = { from, clientId: client.clientId, sessionId: client.sessionId };
        await send(name === "plain reply" ? "Do not use tools. Reply with the single word ready." : name === "subagent" ? SUBAGENT_PROMPT : WORKFLOW_PROMPT);
        if (provider === "muse" && name === "workflow") {
          deliveryProbe = { from, clientId: client.clientId, sessionId: client.sessionId };
          await page.locator("#input").fill("Do not use tools. Reply with the single word ok for this new prompt.");
        }
        await endTurn(name, from, client);
        if (name !== "plain reply") {
          const frames = readEvents().slice(from).filter(e => e.direction === "receive" && e.clientId === client.clientId && e.message.params?.update).map(e => ({ raw: e.message.params.update }));
          // A card OR launch evidence proves an attempt. Missing rendered output
          // after that is a failure, never relabeled a model refusal.
          const current = await snapshot();
          if (!delegationAttempted(frames, name) && !current.cards.some(c => c.kind === name)) {
            Object.assign(scenario, { result: "INCONCLUSIVE", reason: "model did not delegate (no retry); inspect wire and reply" });
          } else await waitPage(async () => { const s = await snapshot(); const cards = s.cards.filter(c => c.kind === name); return cards.length && cards.every(c => c.terminal); }, `${name} rendered terminal card`, workflowMs);
        }
        // Flush actual renderer frame coalescing before reading the answer.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await capture(scenario);
        assertRenderedScenario(scenario);
      } catch (error) {
        Object.assign(scenario, { result: "FAIL", reason: String(error.message), stack: error.stack });
        failure ??= error;
        await capture(scenario).catch(e => scenario.pageErrors.push(String(e)));
      } finally { save(); }

      if (provider === "muse" && name === "workflow") {
        const delivery = { name: "delivery prompt", result: "PASS", pageErrors: [], trace: scenario.trace };
        report.scenarios.push(delivery);
        try {
          const observed = await waitPage(() => deliveryProbe?.observed, "Muse unprompted desktop delivery", deliveryMs).catch(error => { if (error.code === "ACP_SMOKE_TIMEOUT") return false; throw error; });
          if (!observed) Object.assign(delivery, { result: "INCONCLUSIVE", reason: "not observed: no unsolicited live delivery chunk in the bounded window" });
          else { delivery.observation = observed; await endTurn("delivery prompt", deliveryProbe.fromDelivery, deliveryProbe); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
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
        } finally { if (deliveryProbe) deliveryProbe.expired = true; save(); }
      }
    }
    if (provider !== "muse") report.scenarios.push({ name: "delivery prompt", result: "N/A", reason: "Muse-specific admission regression", pageErrors: [] });
  } catch (error) {
    failure ??= error;
    report.scenarios.push({ name: "desktop setup", result: "FAIL", reason: String(error.message), pageErrors: [...pageErrors] });
  } finally {
    if (app) {
      try {
        const cleanup = await closeDesktop(app, proc, { budgetMs: cleanupMs,
          record: (direction, message) => fs.appendFileSync(path.join(output, "desktop-wire.jsonl"), JSON.stringify({ at: new Date().toISOString(), direction, message }) + "\n") });
        report.cleanup = cleanup;
        report.scenarios.push(cleanup);
        if (cleanup.result === "FAIL") throw new Error(cleanup.reason);
      } catch (error) {
        failure ??= error;
        if (!report.cleanup) report.scenarios.push({ name: "cleanup", result: "FAIL", reason: String(error.message), pageErrors: [] });
        try { if (proc && proc.exitCode === null && proc.signalCode === null) {
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
    report.scenarios = completeRenderScenarios(report.scenarios, provider, undefined, selectedScenario);
    save();
    console.log(renderReportMarkdown(report));
    console.log(`[render] Evidence: ${output}`);
  }
  if (report.boundaries.unhandled.length) failure ??= new Error("UNHANDLED boundary kinds observed; see render-report.md");
  if (report.pageErrors.length) failure ??= new Error(`renderer threw: ${report.pageErrors.join("; ")}`);
  if (report.scenarios.some(s => s.result === "INCONCLUSIVE")) failure ??= Object.assign(new Error("render scenarios inconclusive; inspect report"), { code: "NOT_OBSERVED" });
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const provider = process.argv.slice(2).find(arg => arg.startsWith("--provider="))?.slice(11);
  assert(provider, "usage: npm run smoke:render -- --provider=grok|codex|claude|muse");
  const parent = path.join(root, ".verification/acp-smoke"); fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, "render-"));
  const scenario = smokeScenario(process.argv.slice(2), ["plain reply", "subagent", "workflow"]);
  runRenderSmoke(provider, output, undefined, scenario).catch(error => {
    console.error(error);
    process.exitCode = smokeOutcome([{ result: error.code === "NOT_OBSERVED" ? "INCONCLUSIVE" : "FAIL" }]).exitCode;
  });
}
