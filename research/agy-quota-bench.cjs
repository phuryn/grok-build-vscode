#!/usr/bin/env node
/**
 * Did the quota work actually change anything? Measure it.
 *
 *   node research/agy-quota-bench.cjs
 *
 * Drives the REAL compiled adapter — the current one and the one at `HEAD`,
 * side by side — against `test/fixtures/fake-agy.cjs`, a stand-in CLI that
 * appends every token it bills to a ledger as it generates. Same scripted
 * scenario, same stub, two adapters; the difference is the answer.
 *
 * Nothing here talks to Google, and no quota is spent. What the ledger records
 * is exact (spawn arguments, tokens billed, whether a result was ever
 * delivered); the only modelled quantity is how much a reasoning level costs,
 * which lives in EFFORT_MULTIPLIER in the fixture and is stated in the output.
 *
 * Exit code is non-zero if the current adapter fails any expectation, so this
 * doubles as a regression gate you can run by hand after touching the adapter.
 */

const { execFileSync } = require("node:child_process");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const FAKE_AGY = path.join(ROOT, "test", "fixtures", "fake-agy.cjs");
const BASELINE_REF = process.env.BENCH_BASELINE_REF || "HEAD";

const BASELINES = [
  { src: "src/agy-acp-adapter.ts", temp: "src/agy-acp-adapter.__baseline.ts" },
  { src: "src/prompt-builder.ts", temp: "src/prompt-builder.__baseline.ts" },
];

// ---------------------------------------------------------------- scaffolding

function materializeBaselines() {
  for (const { src, temp } of BASELINES) {
    const content = execFileSync("git", ["show", `${BASELINE_REF}:${src}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(ROOT, temp), content, "utf8");
  }
}

function cleanBaselines() {
  for (const { temp } of BASELINES) {
    const base = path.basename(temp, ".ts");
    for (const file of [
      path.join(ROOT, temp),
      path.join(ROOT, "out", `${base}.js`),
      path.join(ROOT, "out", `${base}.js.map`),
    ]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
  }
}

function compile() {
  // The package's own tsc, run through node: a `.cmd` shim cannot be spawned
  // with shell:false on Windows (EINVAL), and this needs no shell at all.
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "."], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLedger(file) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function summarize(file) {
  const entries = readLedger(file);
  const billed = entries.filter((e) => e.t === "billed").reduce((n, e) => n + e.tokens, 0);
  // Generated, not total: `total` includes input tokens the chunks never billed.
  const delivered = entries.filter((e) => e.t === "result").reduce((n, e) => n + e.generated, 0);
  const spawns = entries.filter((e) => e.t === "spawn");
  return { billed, delivered, spawns, entries };
}

/**
 * One adapter under test, wired to the stub. The adapter spawns whatever
 * `agyPath` names, so the stub is reached through node — the same shape the
 * real binary is spawned in, minus the platform trouble of an executable stub.
 */
function makeHarness(adapterModule, { ledger, store, effort }) {
  const { AgyAcpAdapterServer } = require(adapterModule);
  const input = new PassThrough();
  const output = new PassThrough();
  const children = [];

  const server = new AgyAcpAdapterServer({
    inputStream: input,
    outputStream: output,
    conversationStorePath: store, // ignored by the baseline, which has no such option
    defaultEffort: effort,
    cwd: ROOT,
    env: { ...process.env, FAKE_AGY_LEDGER: ledger },
    spawnFn: (_cmd, args, opts) => {
      const child = spawn(process.execPath, [FAKE_AGY, ...args], opts);
      children.push(child);
      return child;
    },
  });
  server.start();

  const responses = [];
  output.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line));
        } catch {}
      }
    }
  });

  return {
    server,
    responses,
    send: (msg) => input.write(JSON.stringify(msg) + "\n"),
    async stop() {
      server.dispose();
      for (const child of children) {
        try {
          child.kill();
        } catch {}
      }
      await sleep(60);
    },
  };
}

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bench-"));
  return {
    ledger: path.join(dir, `${name}.ndjson`),
    store: path.join(dir, `${name}-conversations.json`),
  };
}

// ----------------------------------------------------------------- scenarios

/** Stop is pressed 150 ms into a 600 ms turn. Both adapters run at the same
 *  effort, so the only variable is whether the CLI was told to stop. */
async function scenarioStop(adapterModule) {
  const { ledger, store } = scratch("stop");
  const h = makeHarness(adapterModule, { ledger, store, effort: "high" });
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: ROOT } });
  await sleep(30);
  h.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "do the long thing" }] },
  });
  await sleep(150);
  // What had already been charged for when the user hit Stop. Everything past
  // this line is what the click did or did not prevent.
  const atClick = summarize(ledger).billed;
  h.send({ jsonrpc: "2.0", method: "session/cancel", params: {} });
  // Long enough that an unstopped CLI finishes the whole turn.
  await sleep(900);

  const s = summarize(ledger);
  const answer = h.responses.find((m) => m.id === 3);
  await h.stop();
  return {
    billedAfterStop: s.billed - atClick,
    billedTotal: s.billed,
    stopReason: answer?.result?.stopReason ?? (answer?.error ? "error" : "(no answer)"),
  };
}

/** The user leaves reasoning effort on "Default" and sends one full turn. */
async function scenarioDefaultEffort(adapterModule) {
  const { ledger, store } = scratch("effort");
  const h = makeHarness(adapterModule, { ledger, store, effort: undefined });
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: ROOT } });
  await sleep(30);
  h.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "one turn" }] },
  });
  await sleep(950);

  const s = summarize(ledger);
  await h.stop();
  const args = s.spawns[0]?.args ?? [];
  const i = args.indexOf("--effort");
  return { billed: s.billed, effortFlag: i >= 0 ? args[i + 1] : "(none)" };
}

/**
 * A model that carries its own reasoning level. `agy` 1.1.26 refuses
 * `--model gpt-oss-120b-medium --effort high` outright ("conflicts with
 * --effort=high"), and the same for both Claude models — so an adapter that
 * always sends the flag cannot start a session on three of the seven models in
 * the picker at all. This is a correctness result, not a cost one.
 */
async function scenarioNoEffortModel(adapterModule) {
  const { ledger, store } = scratch("noeffort");
  const h = makeHarness(adapterModule, { ledger, store, effort: undefined });
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: ROOT } });
  await sleep(30);
  h.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/set_config_option",
    params: { configId: "model", value: "gpt-oss-120b-medium" },
  });
  await sleep(30);
  h.send({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "one turn" }] },
  });
  await sleep(950);

  const s = summarize(ledger);
  await h.stop();
  const args = s.spawns[0]?.args ?? [];
  const i = args.indexOf("--effort");
  const flag = i >= 0 ? args[i + 1] : "(none)";
  return { effortFlag: flag, wouldStart: flag === "(none)" };
}

/** The model picker is used 150 ms into a running turn. */
async function scenarioSwitchMidTurn(adapterModule) {
  const { ledger, store } = scratch("switch");
  const h = makeHarness(adapterModule, { ledger, store, effort: "high" });
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: ROOT } });
  await sleep(30);
  h.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "keep working" }] },
  });
  await sleep(150);
  h.send({
    jsonrpc: "2.0",
    id: 4,
    method: "session/set_config_option",
    params: { configId: "model", value: "gemini-3.1-pro" },
  });
  await sleep(900);

  const s = summarize(ledger);
  const answer = h.responses.find((m) => m.id === 3);
  await h.stop();
  return {
    billed: s.billed,
    delivered: s.delivered,
    wasted: s.billed - s.delivered,
    turnOutcome: answer?.result?.stopReason ?? (answer?.error ? `error: ${answer.error.message}` : "(no answer)"),
  };
}

/** A conversation is used, the window is reloaded, and the conversation is
 *  reopened. Does the agent still know what was said? */
async function scenarioReopen(adapterModule) {
  const { ledger, store } = scratch("reopen");

  const first = makeHarness(adapterModule, { ledger, store, effort: undefined });
  first.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  first.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "sess-A", cwd: ROOT } });
  await sleep(30);
  first.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "remember the plan" }] },
  });
  await sleep(950);
  await first.stop();

  // A fresh adapter process — what reopening the conversation later gets.
  const second = makeHarness(adapterModule, { ledger, store, effort: undefined });
  second.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  second.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "sess-A", cwd: ROOT } });
  await sleep(30);
  second.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "what was the plan again?" }] },
  });
  await sleep(400);
  const s = summarize(ledger);
  await second.stop();

  const [firstSpawn, secondSpawn] = s.spawns;
  return {
    firstConversation: firstSpawn?.conversationId ?? "(none)",
    reopenedWith: secondSpawn?.resumed ?? "(nothing — new conversation)",
    keptContext: Boolean(secondSpawn?.resumed && secondSpawn.resumed === firstSpawn?.conversationId),
  };
}

/** The editor selection that rides along on every message. Pure function, so
 *  this is an exact character count, not a model of one. */
function scenarioSelection(builderModule, chips) {
  const { buildPrompt } = require(builderModule);
  const bigFile = Array.from({ length: 3000 }, (_, i) => `  const value${i} = compute(${i});`).join("\n");
  const deps = { readFile: () => bigFile, extName: () => ".ts" };
  const chip = chips.makeImplicitChip(path.join(ROOT, "src", "big.ts"), "src/big.ts", 1, 3000);
  const prompt = buildPrompt("und jetzt?", [chip], deps);
  return { chars: prompt.length, approxTokens: Math.round(prompt.length / 4) };
}

// -------------------------------------------------------------------- report

function pct(before, after) {
  if (!before) return after ? "+∞" : "0%";
  return `${Math.round(((after - before) / before) * 100)}%`;
}

function row(label, before, after, note) {
  return { label, before, after, note: note ?? "" };
}

function table(rows) {
  const head = ["", `HEAD (${BASELINE_REF})`, "jetzt", ""];
  const body = rows.map((r) => [r.label, String(r.before), String(r.after), r.note]);
  const widths = head.map((_, i) => Math.max(head[i].length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const out = [line(head), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const b of body) out.push(line(b));
  return out.join("\n");
}

async function main() {
  cleanBaselines();
  materializeBaselines();
  let failures = [];
  try {
    console.log("Kompiliere beide Stände…\n");
    compile();

    const NOW = path.join(ROOT, "out", "agy-acp-adapter.js");
    const OLD = path.join(ROOT, "out", "agy-acp-adapter.__baseline.js");
    const chips = require(path.join(ROOT, "out", "chips.js"));

    const rows = [];

    const stopOld = await scenarioStop(OLD);
    const stopNew = await scenarioStop(NOW);
    rows.push(row(
      "Stop: Tokens NACH dem Klick",
      stopOld.billedAfterStop,
      stopNew.billedAfterStop,
      pct(stopOld.billedAfterStop, stopNew.billedAfterStop),
    ));
    rows.push(row(
      "Stop: Tokens für den ganzen Turn",
      stopOld.billedTotal,
      stopNew.billedTotal,
      pct(stopOld.billedTotal, stopNew.billedTotal),
    ));
    rows.push(row("Stop: Antwort auf den Turn", stopOld.stopReason, stopNew.stopReason, ""));

    const effOld = await scenarioDefaultEffort(OLD);
    const effNew = await scenarioDefaultEffort(NOW);
    rows.push(row('Effort "Default": Flag', effOld.effortFlag, effNew.effortFlag, ""));
    rows.push(row(
      'Effort "Default": Tokens/Turn',
      effOld.billed,
      effNew.billed,
      pct(effOld.billed, effNew.billed),
    ));

    const neOld = await scenarioNoEffortModel(OLD);
    const neNew = await scenarioNoEffortModel(NOW);
    rows.push(row("Modell ohne Effort-Stufe: Flag", neOld.effortFlag, neNew.effortFlag, ""));
    rows.push(row(
      "Modell ohne Effort-Stufe: startbar",
      neOld.wouldStart ? "ja" : "nein (CLI lehnt ab)",
      neNew.wouldStart ? "ja" : "nein (CLI lehnt ab)",
      "",
    ));

    const swOld = await scenarioSwitchMidTurn(OLD);
    const swNew = await scenarioSwitchMidTurn(NOW);
    rows.push(row(
      "Modellwechsel im Turn: verworfene Tokens",
      swOld.wasted,
      swNew.wasted,
      pct(swOld.wasted, swNew.wasted),
    ));
    rows.push(row("Modellwechsel im Turn: Ausgang", swOld.turnOutcome, swNew.turnOutcome, ""));

    const reOld = await scenarioReopen(OLD);
    const reNew = await scenarioReopen(NOW);
    rows.push(row(
      "Wiedergeöffneter Chat: Kontext",
      reOld.keptContext ? "erhalten" : "verloren",
      reNew.keptContext ? "erhalten" : "verloren",
      "",
    ));
    rows.push(row("Wiedergeöffneter Chat: --conversation", reOld.reopenedWith, reNew.reopenedWith, ""));

    const selOld = scenarioSelection(path.join(ROOT, "out", "prompt-builder.__baseline.js"), chips);
    const selNew = scenarioSelection(path.join(ROOT, "out", "prompt-builder.js"), chips);
    rows.push(row(
      "3000-Zeilen-Selektion: Zeichen/Nachricht",
      selOld.chars,
      selNew.chars,
      pct(selOld.chars, selNew.chars),
    ));
    rows.push(row(
      "… als Tokens, über 10 Nachrichten",
      selOld.approxTokens * 10,
      selNew.approxTokens * 10,
      pct(selOld.approxTokens, selNew.approxTokens),
    ));

    console.log("\n" + table(rows) + "\n");
    console.log("Stub: test/fixtures/fake-agy.cjs — 20 Chunks à 30 ms, 100 Output-Tokens je Chunk.");
    console.log("Exakt gemessen: Spawn-Argumente, abgerechnete Tokens, gelieferte Ergebnisse, Zeichenzahl.");
    console.log("Modelliert:     der Preis einer Reasoning-Stufe (EFFORT_MULTIPLIER, kalibriert an agy-live-ab.cjs).");
    console.log("");
    console.log("Wichtig: die Effort-Zeile ist eine KORREKTHEITS-Frage, keine Kostenfrage. Gegen die echte");
    console.log("CLI gemessen (research/agy-live-ab.cjs, 2x3 Turns) lag der Unterschied high vs. medium bei");
    console.log("~80 Thinking-Tokens auf ~73.000 Gesamt-Tokens — unter 0,2 %. Was den Verbrauch treibt, sind");
    console.log("die Input-Tokens: ~15.000 Sockel für Tool-Schemata plus die komplette Historie in JEDEM Turn.");
    console.log("Die echten Einsparungen liegen deshalb bei Stop, verworfenen Turns und der Selektion.\n");

    const expect = (ok, message) => {
      if (!ok) failures.push(message);
    };
    expect(stopNew.billedAfterStop < stopOld.billedAfterStop / 4, "Stop spart keine Tokens mehr");
    expect(stopNew.stopReason === "cancelled", "Stop beantwortet den Turn nicht mit cancelled");
    // "Default" must resolve to a level: `--model gemini-3.8-flash` alone is
    // refused by agy 1.1.26 with "requires --effort".
    expect(effNew.effortFlag === "medium", '"Default" sendet keine gültige Effort-Stufe');
    expect(neNew.wouldStart, "Ein Modell ohne Effort-Stufe bekommt weiterhin ein --effort");
    expect(swNew.wasted === 0, "Ein Modellwechsel verwirft weiterhin bezahlte Tokens");
    expect(reNew.keptContext, "Ein wiedergeöffneter Chat verliert weiterhin den Kontext");
    expect(selNew.chars < selOld.chars / 10, "Die Selektion wird weiterhin voll eingebettet");
  } finally {
    cleanBaselines();
  }

  if (failures.length) {
    console.error("FEHLGESCHLAGEN:\n - " + failures.join("\n - "));
    process.exitCode = 1;
  } else {
    console.log("Alle Erwartungen an den aktuellen Stand erfüllt.");
  }
}

main().catch((error) => {
  cleanBaselines();
  console.error(error);
  process.exitCode = 1;
});
