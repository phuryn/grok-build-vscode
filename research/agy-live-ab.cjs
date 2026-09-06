#!/usr/bin/env node
/**
 * Same conversation, both adapters, real `agy` — what did it actually cost?
 *
 *   npm run compile && node research/agy-live-ab.cjs
 *
 * The deterministic bench (`agy-quota-bench.cjs`) proves the mechanism changed.
 * This one answers the question that mechanism is a proxy for: does a real
 * conversation bill fewer tokens now? It runs the identical three-turn script
 * against the CLI twice — once through the adapter at `HEAD`, once through the
 * current one — and sums the usage `agy` itself reports.
 *
 * Spends real quota. Model output is not deterministic and input grows with the
 * conversation, so a single pair is an indication, not a proof; pass a repeat
 * count to average (`node research/agy-live-ab.cjs 3`).
 *
 * Only the like-for-like path is measured here: one session, no Stop, no
 * reopen. Those two are where the current adapter wins outright rather than
 * incrementally, and they are covered by the bench and the live probe — a
 * cancelled turn reports no usage at all, so it cannot be summed fairly.
 */

const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const AGY = process.env.AGY_PATH || path.join(os.homedir(), ".gemini", "bin", "agy.exe");
const BASELINE_REF = process.env.BENCH_BASELINE_REF || "HEAD";
const TEMP_TS = path.join(ROOT, "src", "agy-acp-adapter.__baseline.ts");
const REPEATS = Number(process.argv[2] || 1);

const SCRIPT = [
  "A farmer has 17 sheep. All but nine die. How many are left? Answer with just the number.",
  "Now double that number and subtract three. Answer with just the number.",
  "Was your first answer a common trick question? Answer yes or no.",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  for (const f of [
    TEMP_TS,
    path.join(ROOT, "out", "agy-acp-adapter.__baseline.js"),
    path.join(ROOT, "out", "agy-acp-adapter.__baseline.js.map"),
  ]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
}

function buildBaseline() {
  const src = execFileSync("git", ["show", `${BASELINE_REF}:src/agy-acp-adapter.ts`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(TEMP_TS, src, "utf8");
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "."], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

async function runArm(adapterModule, label) {
  const { AgyAcpAdapterServer } = require(adapterModule);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ab-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const children = [];
  let spawnArgs = [];

  const server = new AgyAcpAdapterServer({
    agyPath: AGY,
    cwd: workdir,
    printTimeout: "120s",
    conversationStorePath: path.join(workdir, "conversations.json"),
    inputStream: input,
    outputStream: output,
    spawnFn: (cmd, args, opts) => {
      spawnArgs = args;
      const child = spawn(cmd, args, opts);
      children.push(child);
      return child;
    },
  });
  server.start();
  output.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {}
    }
  });

  const send = (msg) => input.write(JSON.stringify(msg) + "\n");
  const waitFor = async (id, ms = 150000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = messages.find((m) => m.id === id && (m.result || m.error));
      if (hit) return hit;
      await sleep(100);
    }
    return undefined;
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workdir } });
  await sleep(200);

  const turns = [];
  for (let i = 0; i < SCRIPT.length; i += 1) {
    const id = 100 + i;
    send({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: SCRIPT[i] }] },
    });
    const answer = await waitFor(id);
    if (answer?.error) {
      console.log(`  ${label} Turn ${i + 1}: FEHLER ${answer.error.message}`);
      turns.push({ input: 0, output: 0, thinking: 0, total: 0, failed: true });
      continue;
    }
    const u = answer?.result?.usage ?? {};
    turns.push({
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      thinking: u.thoughtTokens ?? 0,
      total: u.totalTokens ?? 0,
    });
  }

  server.dispose();
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
  await sleep(400);
  try {
    fs.rmSync(workdir, { recursive: true, force: true });
  } catch {}

  const sum = turns.reduce(
    (acc, t) => ({
      input: acc.input + t.input,
      output: acc.output + t.output,
      thinking: acc.thinking + t.thinking,
      total: acc.total + t.total,
    }),
    { input: 0, output: 0, thinking: 0, total: 0 },
  );
  return { turns, sum, spawnArgs, failed: turns.some((t) => t.failed) };
}

async function main() {
  if (!fs.existsSync(AGY)) {
    console.error(`agy nicht gefunden: ${AGY}`);
    process.exit(2);
  }
  cleanup();
  buildBaseline();

  const OLD = path.join(ROOT, "out", "agy-acp-adapter.__baseline.js");
  const NOW = path.join(ROOT, "out", "agy-acp-adapter.js");

  const results = { old: [], now: [] };
  try {
    for (let run = 1; run <= REPEATS; run += 1) {
      console.log(`\n--- Durchlauf ${run}/${REPEATS} ---`);
      const a = await runArm(OLD, "HEAD");
      console.log(`  HEAD  effort=${a.spawnArgs[a.spawnArgs.indexOf("--effort") + 1] ?? "(keins)"}  `
        + `in=${a.sum.input} out=${a.sum.output} thinking=${a.sum.thinking} total=${a.sum.total}`);
      const b = await runArm(NOW, "jetzt");
      console.log(`  jetzt effort=${b.spawnArgs[b.spawnArgs.indexOf("--effort") + 1] ?? "(keins)"}  `
        + `in=${b.sum.input} out=${b.sum.output} thinking=${b.sum.thinking} total=${b.sum.total}`);
      results.old.push(a.sum);
      results.now.push(b.sum);
    }
  } finally {
    cleanup();
  }

  const avg = (rows, key) => Math.round(rows.reduce((n, r) => n + r[key], 0) / rows.length);
  const oldTotal = avg(results.old, "total");
  const nowTotal = avg(results.now, "total");
  const delta = oldTotal ? Math.round(((nowTotal - oldTotal) / oldTotal) * 100) : 0;

  console.log("\n=== Drei Turns, identisches Skript, echte CLI ===");
  console.log(`  HEAD   ${oldTotal} Tokens (thinking ${avg(results.old, "thinking")})`);
  console.log(`  jetzt  ${nowTotal} Tokens (thinking ${avg(results.now, "thinking")})`);
  console.log(`  Delta  ${delta > 0 ? "+" : ""}${delta}%  über ${REPEATS} Durchlauf/Durchläufe`);
  console.log("\n  Nicht enthalten: Stop und Wiederöffnen — dort gewinnt der aktuelle Stand");
  console.log("  nicht graduell, sondern grundsätzlich (siehe agy-quota-bench.cjs, agy-live-probe.cjs).");
}

main().catch((e) => {
  cleanup();
  console.error(e);
  process.exitCode = 1;
});
