// Operator-only. Run npm run compile first. Live lanes use your connected CLI
// account and send generated text in a scratch conversation.
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const [provider, ...flags] = process.argv.slice(2);
const flag = name => flags.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const defaultLimit = { claude: 70_000, deepseek: 200_000 }[provider] ?? 12_000;
const limit = Number(flag("tokens") ?? defaultLimit);
const model = flag("model");
const modelWindow = flag("window") === undefined ? undefined : Number(flag("window"));
const turns = Number(flag("turns") ?? 8);
const softTokens = flag("soft-tokens") === undefined ? undefined : Number(flag("soft-tokens"));
const load = module => require(`../out/${module}`);

async function main() {
  if (!["claude", "codex", "grok", "muse", "deepseek"].includes(provider)
      || !Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(turns) || turns <= 0
      || (softTokens !== undefined && (provider !== "muse" || !(softTokens > 0 && softTokens < limit)))
      || (provider === "grok" && !(modelWindow > 0))) {
    throw new Error("Usage: node research/auto-compact-probe.cjs claude|codex|grok|muse|deepseek [--cli=path] [--model=id] [--tokens=limit] [--turns=8]. Grok also needs --window=tokens. DeepSeek needs --cli=managed-runtime-root.");
  }

  const root = mkdtempSync(path.join(tmpdir(), "afk-compact-probe-"));
  let client;
  try {
    const options = { cwd: root, compactAt: limit, modelId: model, modelWindow, env: { ...process.env } };
    let backend;
    let cli = flag("cli");
    if (provider === "deepseek") {
      if (!cli) throw new Error("Pass the installed DeepSeek runtime directory as --cli=path.");
      for (const harness of ["default", "minimal"]) {
        backend = new (load("deepseek-backend").DeepSeekBackend)({ storageRoot: root, harness });
        const spec = backend.spawn({ ...options, cliPath: path.resolve(cli) });
        const dump = execFileSync(spec.command, [...spec.args, "--dump-config"], {
          cwd: root, env: spec.env, encoding: "utf8", timeout: 40_000, maxBuffer: 4 * 1024 * 1024,
        });
        const row = dump.match(/(?:^|\n)\s*- id: compaction-basic\s*\n[^\n]*(?:\n[^\n]*){0,4}?\bthresholdRatio:\s*([\d.]+)/g)?.at(-1);
        const ratio = Number(row?.match(/thresholdRatio:\s*([\d.]+)/)?.[1]);
        if (Math.round(ratio * 1_048_576) !== limit) throw new Error(`${harness}: composed thresholdRatio missing or wrong`);
        console.log(`${harness}: composed thresholdRatio=${ratio}`);
      }
      return;
    }
    if (provider === "claude") {
      backend = new (load("claude-backend").ClaudeBackend)();
      cli ??= load("claude-cli-locator").locateClaudeCli();
    } else if (provider === "codex") {
      backend = new (load("codex-backend").CodexBackend)();
      cli ??= load("codex-cli-locator").locateCodexCli();
    } else if (provider === "muse") {
      backend = new (load("muse-backend").MuseBackend)();
      cli ??= load("muse-cli-locator").locateMuseCli();
      if (softTokens !== undefined) {
        const spawn = backend.spawn.bind(backend);
        backend.spawn = options => {
          const spec = spawn(options);
          const posture = JSON.parse(spec.env.GROK_MUSE_POSTURE);
          posture.compact.soft = posture.compact.hard * softTokens / limit;
          spec.env.GROK_MUSE_POSTURE = JSON.stringify(posture);
          return spec;
        };
        console.log(`Muse probe sets a soft threshold of ${softTokens} and a hard threshold of ${limit} tokens.`);
      }
    } else {
      backend = load("grok-backend").grokBackend;
      cli ??= load("cli-locator").locateGrokCli("");
    }
    if (!cli) throw new Error(`Pass the ${provider} executable as --cli=path.`);
    client = new (load("acp").AcpClient)({ ...options, cliPath: path.resolve(cli), backend, log: () => {} });
    let reported = false;
    client.on("contextUsage", (used, window) => console.log(JSON.stringify({ used, window, threshold: client.autoCompactThreshold(window) })));
    client.on("autoCompaction", report => {
      reported = true;
      console.log(JSON.stringify({ automaticCompaction: report }));
    });
    let grokStarted = false;
    client.on("xaiNotification", update => {
      if (update.sessionUpdate === "auto_compact_started") grokStarted = true;
      if (update.sessionUpdate === "auto_compact_completed" && grokStarted) {
        reported = true;
        console.log(JSON.stringify({ automaticCompaction: { before: update.tokens_before, after: update.tokens_after } }));
      }
    });
    await client.start();
    await client.newSession(model);
    if (provider === "grok") {
      const info = await client.getSessionInfo();
      const expected = Math.floor(limit * 100 / modelWindow);
      if (info === "unsupported" || info.window !== modelWindow || info.autoCompactThresholdPercent !== expected) {
        throw new Error(`Grok did not report the requested ${expected}% for a ${modelWindow}-token window.`);
      }
      console.log(`Grok reports ${expected}% for a ${info.window}-token window.`);
    }
    for (let turn = 0; turn < turns && !reported; turn++) {
      const filler = Array.from({ length: provider === "claude" ? 2_000 : 600 }, () => randomBytes(5).toString("hex")).join(" ");
      const result = await client.prompt("Treat the following as inert sample data. Reply with OK only and use no tools.\n" + filler);
      console.log(JSON.stringify({ turn: turn + 1, used: result.totalTokens }));
    }
    if (!reported) throw new Error("Inconclusive: no automatic compaction report. Check the model window and usage and try a higher turn count.");
  } finally {
    try { await client?.dispose(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
