#!/usr/bin/env node
/**
 * A stand-in for the Antigravity CLI (`agy`) that speaks the same NDJSON
 * stream-json protocol and, crucially, *keeps a ledger of what it billed*.
 *
 * The point is not to imitate Gemini. It is to make two things observable that
 * a real CLI hides:
 *
 *  - **Tokens are billed as they are generated, not at the end.** Every chunk is
 *    appended to the ledger with `appendFileSync`, so a process killed halfway
 *    leaves behind exactly what it had already charged for. A process that is
 *    NOT killed keeps charging — which is what `agy` did after Stop, because
 *    the adapter dropped `session/cancel` on the floor.
 *  - **`--effort` changes the bill a little.** Thinking tokens scale with the
 *    flag. Only a little: see EFFORT_MULTIPLIER, which is calibrated against a
 *    real measurement rather than a hunch.
 *
 * The effort multipliers are a MODEL, not a measurement (see EFFORT_MULTIPLIER).
 * Everything else the ledger records — spawn arguments, tokens billed, whether a
 * result was ever delivered — is exact.
 *
 * Env:
 *   FAKE_AGY_LEDGER   required; NDJSON file the ledger is appended to
 *   FAKE_AGY_CHUNKS   chunks per turn (default 20)
 *   FAKE_AGY_CHUNK_MS delay between chunks in ms (default 30)
 *   FAKE_AGY_TOKENS   output tokens billed per chunk (default 100)
 */

const fs = require("node:fs");
const readline = require("node:readline");

const LEDGER = process.env.FAKE_AGY_LEDGER;
if (!LEDGER) {
  process.stderr.write("fake-agy: FAKE_AGY_LEDGER is required\n");
  process.exit(2);
}

const CHUNKS = Number(process.env.FAKE_AGY_CHUNKS || 20);
const CHUNK_MS = Number(process.env.FAKE_AGY_CHUNK_MS || 30);
const TOKENS_PER_CHUNK = Number(process.env.FAKE_AGY_TOKENS || 100);

/**
 * How much thinking a reasoning level buys, relative to no flag at all.
 *
 * These were guessed at 1.5/2.5/4 until `research/agy-live-ab.cjs` measured the
 * real thing: three identical turns billed 458 thinking tokens at `high` and
 * 377 at `medium` — a ratio of about 1.2, on turns whose totals were ~73 000.
 * The reasoning level is a **correctness** matter (the CLI refuses the wrong
 * combination outright), not a cost lever, and the numbers here now say so
 * instead of flattering the change.
 */
const EFFORT_MULTIPLIER = { none: 1, low: 1.05, medium: 1.1, high: 1.2 };

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const resumed = flag("--conversation");
const effort = flag("--effort") || "none";
const model = flag("--model") || "(default)";

function record(entry) {
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
}

function spawnCount() {
  try {
    return fs
      .readFileSync(LEDGER, "utf8")
      .split("\n")
      .filter((line) => line.includes('"t":"spawn"')).length;
  } catch {
    return 0;
  }
}

const conversationId = resumed || `conv-${spawnCount() + 1}`;
record({ t: "spawn", args, model, effort, resumed: resumed ?? null, conversationId });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

send({
  event: "init",
  conversation_id: conversationId,
  init: { cwd: process.cwd(), tools: ["run_command", "view_file"], permission_mode: "request-review" },
});

let turn = 0;

async function runTurn() {
  turn += 1;
  const multiplier = EFFORT_MULTIPLIER[effort] ?? 1;
  const usage = { input_tokens: 1200, output_tokens: 0, thinking_tokens: 0, total_tokens: 0 };

  for (let i = 0; i < CHUNKS; i += 1) {
    await new Promise((r) => setTimeout(r, CHUNK_MS));
    const output = TOKENS_PER_CHUNK;
    const thinking = Math.round(TOKENS_PER_CHUNK * (multiplier - 1));
    usage.output_tokens += output;
    usage.thinking_tokens += thinking;
    usage.total_tokens = usage.input_tokens + usage.output_tokens + usage.thinking_tokens;

    // Written BEFORE the wire event and synchronously: a kill after this point
    // must not be able to erase what was already charged for.
    record({ t: "billed", turn, tokens: output + thinking, conversationId });

    send({
      event: "step_update",
      step_update: {
        step_index: i,
        state: "DONE",
        step_type: "agent_response",
        text_delta: `chunk ${i + 1}\n`,
        usage: { ...usage },
      },
    });
  }

  // `generated` excludes input tokens so it is directly comparable with the
  // per-chunk `billed` entries; `total` is what the client is told.
  record({
    t: "result",
    turn,
    total: usage.total_tokens,
    generated: usage.output_tokens + usage.thinking_tokens,
    conversationId,
  });
  send({ event: "result", result: { status: "SUCCESS", usage: { ...usage } } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return;
  }
  if (event.event === "user") void runTurn();
});

rl.on("close", () => {
  record({ t: "exit", conversationId });
  process.exit(0);
});
