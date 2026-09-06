#!/usr/bin/env node
/**
 * Add up what a real session cost.
 *
 *   node research/usage-report.cjs before.log after.log
 *   code --status ... | node research/usage-report.cjs -
 *
 * Reads the extension's Output panel log (VS Code: Output → "Grok Build" →
 * the copy/save button) and sums the `[usage] <agent> turn …` lines the host
 * writes once per billed turn, plus the `[agy] turn complete …` lines the
 * Antigravity adapter writes on its own side.
 *
 * Given two files it prints both and the delta, which is how you answer "did
 * the change help" for an actual piece of work: run the same task twice, once
 * per build, and compare. Model output is not deterministic, so treat a single
 * pair as an indication and repeat it before believing a small difference —
 * the mechanical wins are measured deterministically in
 * `research/agy-quota-bench.cjs` instead.
 */

const fs = require("node:fs");

const USAGE = /\[usage\] (\S+) turn in=(\d+) out=(\d+) reasoning=(\d+) cacheRead=(\d+) cacheWrite=(\d+) total=(\d+)/;
const AGY = /\[agy\] turn complete in=(\d+) out=(\d+) thinking=(\d+) total=(\d+)/;

function parse(text) {
  const byProvider = new Map();
  let agyTurns = 0;
  let agyThinking = 0;
  let agyTotal = 0;

  for (const line of text.split("\n")) {
    const usage = USAGE.exec(line);
    if (usage) {
      const [, provider, input, output, reasoning, cacheRead, cacheWrite, total] = usage;
      const acc = byProvider.get(provider) ?? {
        turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0,
      };
      acc.turns += 1;
      acc.input += Number(input);
      acc.output += Number(output);
      acc.reasoning += Number(reasoning);
      acc.cacheRead += Number(cacheRead);
      acc.cacheWrite += Number(cacheWrite);
      acc.total += Number(total);
      byProvider.set(provider, acc);
      continue;
    }
    const agy = AGY.exec(line);
    if (agy) {
      agyTurns += 1;
      agyThinking += Number(agy[3]);
      agyTotal += Number(agy[4]);
    }
  }

  return { byProvider, agy: { turns: agyTurns, thinking: agyThinking, total: agyTotal } };
}

function readInput(name) {
  if (name === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(name, "utf8");
}

function report(label, parsed) {
  console.log(`\n== ${label} ==`);
  if (!parsed.byProvider.size && !parsed.agy.turns) {
    console.log("  keine [usage]- oder [agy]-Zeilen gefunden");
    return;
  }
  for (const [provider, a] of [...parsed.byProvider].sort()) {
    const perTurn = Math.round(a.total / Math.max(a.turns, 1));
    const thinkShare = a.total ? Math.round((a.reasoning / a.total) * 100) : 0;
    console.log(
      `  ${provider}: ${a.turns} Turns, ${a.total} Tokens (Ø ${perTurn}/Turn), `
      + `davon ${a.reasoning} Reasoning (${thinkShare}%), Cache gelesen ${a.cacheRead}`,
    );
  }
  if (parsed.agy.turns) {
    const perTurn = Math.round(parsed.agy.total / parsed.agy.turns);
    console.log(
      `  agy-Adapter: ${parsed.agy.turns} Turns, ${parsed.agy.total} Tokens `
      + `(Ø ${perTurn}/Turn), davon ${parsed.agy.thinking} Thinking`,
    );
  }
}

function totalOf(parsed) {
  let sum = 0;
  for (const a of parsed.byProvider.values()) sum += a.total;
  return sum || parsed.agy.total;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Aufruf: node research/usage-report.cjs <log> [<log2>]   ('-' liest stdin)");
  process.exit(2);
}

const parsed = files.map((file) => ({ file, data: parse(readInput(file)) }));
for (const { file, data } of parsed) report(file, data);

if (parsed.length === 2) {
  const before = totalOf(parsed[0].data);
  const after = totalOf(parsed[1].data);
  const delta = before ? Math.round(((after - before) / before) * 100) : 0;
  console.log(`\n== Vergleich ==`);
  console.log(`  ${before} → ${after} Tokens (${delta > 0 ? "+" : ""}${delta}%)`);
  console.log("  Modellausgaben schwanken; für eine belastbare Aussage die gleiche Aufgabe mehrfach fahren.");
}
console.log("");
