#!/usr/bin/env node
/**
 * The adapter against the REAL Antigravity CLI.
 *
 *   npm run compile && node research/agy-live-probe.cjs
 *
 * Spends real quota — a handful of tiny turns — so it is a manual probe, never
 * part of `npm test`. It exists because the stub in
 * `test/fixtures/fake-agy.cjs` can only confirm what we already believe about
 * the wire; this one confirms what `agy` actually does.
 *
 * Measured against agy 1.1.26 (2026-09-05). What it checks:
 *
 *   1. a turn completes and reports usage      — the wire shape we parse
 *   2. a follow-up in the same session         — context survives turn to turn
 *   3. reopening after the adapter restarts    — `--conversation` from the store
 *   4. Stop during a long turn                 — the CLI process actually dies
 *
 * Set AGY_PATH to override the binary location.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const ROOT = path.resolve(__dirname, "..");
const AGY = process.env.AGY_PATH || path.join(os.homedir(), ".gemini", "bin", "agy.exe");
const { AgyAcpAdapterServer } = require(path.join(ROOT, "out", "agy-acp-adapter.js"));

if (!fs.existsSync(AGY)) {
  console.error(`agy not found at ${AGY} — set AGY_PATH`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-live-"));
const store = path.join(workdir, "conversations.json");

let passed = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const children = [];
  const messages = [];

  const server = new AgyAcpAdapterServer({
    agyPath: AGY,
    cwd: workdir,
    printTimeout: "120s",
    conversationStorePath: store,
    inputStream: input,
    outputStream: output,
    spawnFn: (cmd, args, opts) => {
      console.log(`  spawn: ${args.join(" ")}`);
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

  return {
    server,
    children,
    messages,
    send: (msg) => input.write(JSON.stringify(msg) + "\n"),
    text() {
      return messages
        .filter((m) => m.method === "session/update" && m.params?.update?.content?.text)
        .map((m) => m.params.update.content.text)
        .join("");
    },
    async waitFor(id, ms = 120000) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const hit = messages.find((m) => m.id === id && (m.result || m.error));
        if (hit) return hit;
        await sleep(100);
      }
      return undefined;
    },
    stop() {
      server.dispose();
      for (const c of children) {
        try {
          c.kill();
        } catch {}
      }
    },
  };
}

async function main() {
  console.log(`agy: ${AGY}`);
  console.log(`cwd: ${workdir}\n`);

  // ---------------------------------------------------------------- 1 & 2
  console.log("1/2  Ein Turn, dann eine Nachfrage in derselben Session");
  const a = harness();
  a.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  a.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "probe-session", cwd: workdir } });
  await sleep(200);

  a.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "Remember the word BANANE. Reply with exactly: OK" }] },
  });
  const first = await a.waitFor(3);
  check(first?.result?.stopReason === "end_turn", "Turn wird als end_turn beantwortet", JSON.stringify(first?.error ?? first?.result));
  check((first?.result?.usage?.totalTokens ?? 0) > 0, "Usage wird gemeldet", JSON.stringify(first?.result?.usage));
  console.log(`        usage: ${JSON.stringify(first?.result?.usage)}`);

  const beforeFollowUp = a.text().length;
  a.send({
    jsonrpc: "2.0",
    id: 4,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "Which word did I ask you to remember? Answer with the single word." }] },
  });
  const second = await a.waitFor(4);
  const followUpText = a.text().slice(beforeFollowUp);
  check(second?.result?.stopReason === "end_turn", "Folge-Turn läuft durch");
  check(/BANANE/i.test(followUpText), "Kontext überlebt den Turn-Wechsel", followUpText.trim().slice(0, 120));
  const conversationId = a.server.activeConversationId;
  check(Boolean(conversationId), "conversation_id wurde erfasst", String(conversationId));
  a.stop();
  await sleep(500);

  // -------------------------------------------------------------------- 3
  console.log("\n3    Adapter neu gestartet, Chat wieder geöffnet");
  const b = harness();
  b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  b.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "probe-session", cwd: workdir } });
  await sleep(200);
  check(
    b.server.activeConversationId === conversationId,
    "Gespeicherte conversation_id wird wiedergefunden",
    `${b.server.activeConversationId} != ${conversationId}`,
  );

  b.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "Which word did I ask you to remember? Answer with the single word." }] },
  });
  const resumed = await b.waitFor(3);
  const resumedText = b.text();
  check(resumed?.result?.stopReason === "end_turn", "Turn nach dem Wiederöffnen läuft durch", JSON.stringify(resumed?.error));
  check(/BANANE/i.test(resumedText), "Das Modell kennt die Historie noch", resumedText.trim().slice(0, 120));
  b.stop();
  await sleep(500);

  // -------------------------------------------------------------------- 4
  console.log("\n4    Stop während eines langen Turns");
  const c = harness();
  c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: workdir } });
  await sleep(200);
  c.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      prompt: [{
        type: "text",
        text: "Count from 1 to 300, one number per line, nothing else.",
      }],
    },
  });
  await sleep(4000);
  const child = c.children[c.children.length - 1];
  const textAtStop = c.text().length;
  c.send({ jsonrpc: "2.0", method: "session/cancel", params: {} });

  const cancelled = await c.waitFor(3, 15000);
  check(cancelled?.result?.stopReason === "cancelled", "Stop beantwortet den Turn mit cancelled", JSON.stringify(cancelled));
  await sleep(3000);
  check(child.exitCode !== null || child.killed, "Der agy-Prozess ist beendet", `exitCode=${child.exitCode} killed=${child.killed}`);
  const grew = c.text().length - textAtStop;
  check(grew < 200, "Nach dem Stop kommt (fast) nichts mehr", `${grew} weitere Zeichen`);
  c.stop();

  console.log(`\n${passed} bestanden, ${failures.length} fehlgeschlagen`);
  if (failures.length) {
    console.log("Fehlgeschlagen:\n - " + failures.join("\n - "));
    process.exitCode = 1;
  }
  try {
    fs.rmSync(workdir, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
