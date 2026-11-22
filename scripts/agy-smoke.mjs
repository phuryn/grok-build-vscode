// Live smoke for Google's Antigravity ACP server and CLI, through the shipped host
// code: the compiled AcpClient with AgyBackend, exactly as a session spawns it.
// Reached from `npm run smoke:acp -- --provider=agy`; opt-in, never part of a
// default run, `npm test` or CI.
//
// The server smoke needs a signed-in server (Settings -> Providers -> Antigravity -> Connect).
// It NEVER calls `logout`: that would sign the machine's account out.
// Server path: AGY_SERVER_PATH, else the copy the app installed
// (AGY_STORAGE_ROOT, the extension's global storage, to find it).
// AGY_SMOKE_PROGRAM=cli exercises a signed-in agy CLI (AGY_CLI_PATH or discovery).
// AGY_SMOKE_SCENARIO=auto-accept runs only the CLI Auto accept check (a shell command).
// Model: gemini-3.8-flash at the `low` thinking level (= gemini-3.8-flash-low).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function runAgySmoke({ root, output, record, say, rpcMs, turnMs }) {
  const { AcpClient } = require("../out/acp.js");
  const { AgyBackend, agySessionPathKey, listAgySessions, locateAgyCli } = require("../out/agy-backend.js");
  const { AgyUsageMeter } = require("../out/agy-usage.js");
  const { agyGoogleAuth, agyGoogleSignInPresent } = require("../out/agy-auth.js");
  const { locateAgyServer } = require("../out/agy-managed-installer.js");
  const program = process.env.AGY_SMOKE_PROGRAM === "cli" ? "cli" : "server";
  const autoAcceptOnly = program === "cli" && process.env.AGY_SMOKE_SCENARIO === "auto-accept";
  const server = process.env.AGY_SERVER_PATH || locateAgyServer({ managedStorageRoot: process.env.AGY_STORAGE_ROOT });
  if (!autoAcceptOnly) {
    assert(server && fs.existsSync(server), "no Antigravity server: set AGY_SERVER_PATH, or AGY_STORAGE_ROOT to the extension's global storage");
    assert(await agyGoogleSignInPresent(), "Antigravity server is not signed in with Google on this machine");
  }
  const binary = program === "cli" ? process.env.AGY_CLI_PATH || locateAgyCli() : server;
  assert(binary && fs.existsSync(binary), "no Antigravity CLI: install agy or set AGY_CLI_PATH");
  // Under the home folder on purpose: that is where the server's alphabetical
  // workspace-root choice used to run commands in ~/.gemini instead.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-acp-smoke-agy-")));
  const skillName = "afk-smoke-skill";
  const skillToken = `AFK-SKILL-${randomUUID()}`;
  const skillDir = path.join(scratch, ".agents", "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Return the AFK Pilot smoke test marker.\n---\n\nReply with exactly ${skillToken}.\n`);
  const log = fs.createWriteStream(path.join(output, "agy-client.log"));
  const timed = (promise, label, ms) => Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref())]);
  const meiDirs = () => process.platform !== "win32" ? [] : fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("_MEI"));
  const clients = [];
  const meter = autoAcceptOnly ? undefined : new AgyUsageMeter(server, process.env);
  const client = () => {
    const made = new AcpClient({
      cliPath: binary, cwd: scratch, effort: "low",
      env: { ...process.env, ...(program === "cli" ? { AGY_CLI_DISABLE_AUTO_UPDATE: "1" } : {}) },
      backend: new AgyBackend({ program, usageMeter: meter }), log: (line) => log.write(`${new Date().toISOString()} ${line}\n`),
      refuseServerRequests: program === "cli" && !autoAcceptOnly,
      timeouts: { requestTimeoutMs: rpcMs, promptIdleTimeoutMs: turnMs },
      // As the host starts it: the chosen method, stated on every start. With
      // the stored token the server refreshes silently; it never opens a browser.
      ...(program === "server" ? { startupAuth: agyGoogleAuth() } : {}),
    });
    if (program === "server") made.on("permissionRequest", request => made.respondPermissionCancelled(request.id));
    clients.push(made);
    return made;
  };
  const check = async (capability, fn) => {
    try { record(capability, "PASS", await fn()); return true; }
    catch (error) { record(capability, "FAIL", String(error?.message ?? error)); return false; }
  };
  const before = new Set(meiDirs());
  let sessionId;
  let agy;
  let setup;
  try {
    say(`agy ${program}: ${binary}; scratch: ${scratch}`);
    agy = client();
    let init;
    agy.once("initialized", (value) => { init = value; });
    // start() returns after `authenticate {methodId: "oauth-personal"}`.
    await timed(agy.start(), "initialize + authenticate", rpcMs * 2);
    record("initialize", "PASS", `agentInfo=${init?.agentInfo?.name} ${init?.agentInfo?.version}; systemPrompt.append=${init?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true}`);
    if (program === "cli") {
      if (autoAcceptOnly) {
        await check("CLI Auto accept command", async () => {
          await timed(agy.newSession(), "CLI session/new", rpcMs);
          return exerciseAutoAccept({ agy, timed, rpcMs, turnMs, scratch });
        });
        return;
      }
      await exerciseCli({ agy, client, check, timed, rpcMs, turnMs, scratch });
      return;
    }
    await check("session/new", async () => {
      agy.once("session", (result) => { setup = result; });
      ({ sessionId } = await timed(agy.newSession("gemini-3.8-flash"), "session/new", rpcMs));
      const offered = agy.availableModels.map((model) => model.modelId);
      assert.ok(offered.includes("gemini-3.8-flash"), `gemini-3.8-flash not offered: ${offered.join(", ")}`);
      assert.equal(agy.currentModelId, "gemini-3.8-flash");
      assert.equal(agy.currentReasoningEffort, "low", "effort did not reach thinking_level=low");
      return `sessionId=${sessionId}; model=${agy.currentModelId} at thinking_level=${agy.currentReasoningEffort}`;
    });
    await check("model catalog", async () => {
      const options = setup?.configOptions?.find(option => option.id === "model")?.options;
      assert(options?.length, "server reported no model choices");
      assert.deepEqual(agy.availableModels.map(({ modelId, name }) => [modelId, name]), options.map(({ value, name }) => [value, name]));
      return agy.availableModels.map(({ name, reasoningEfforts }) => `${name} (${reasoningEfforts?.join("/") || "default effort"})`).join(", ");
    });
    const modesReady = await check("approval modes", async () => {
      assert.equal(agy.nativeApprovalModes, true, "server did not advertise the three approval modes");
      assert.equal(agy.supportsInterject(), false);
      for (const mode of ["acceptEdits", "yolo", "agent"]) {
        await timed(agy.setMode(mode), `mode ${mode}`, rpcMs);
        assert.equal(agy.currentModeId, mode);
      }
      return "switched to Accept edits, Auto accept and back to Agent mode";
    });
    if (!modesReady) return;
    await check("subscription usage", async () => {
      const windows = await timed(agy.getSubscriptionUsage(), "Google quota summary", rpcMs * 2);
      assert(windows.length, "no readable Google quota windows");
      return windows.map(window => `${window.label} ${window.usedPercent.toFixed(1)}% used`).join(", ");
    });
    await check("slash skills", async () => {
      await timed(agy.refreshCommands(), "skills discovery", rpcMs);
      const { availableCommands } = agy;
      assert(availableCommands.some(command => command.name === "usage"), "native /usage command is missing");
      assert(!availableCommands.some(command => ["plan", "logout"].includes(command.name)), "a hidden native command was advertised");
      assert(availableCommands.some(command => command.name === skillName && command._meta?.scope === "project"), "project skill is missing");
      return `/${skillName} and native /usage advertised`;
    });
    await check("skill invocation", async () => {
      const chunks = [];
      const onChunk = (text) => chunks.push(text);
      agy.on("messageChunk", onChunk);
      try { await timed(agy.prompt(`/${skillName}`), "project skill turn", turnMs); }
      finally { agy.off("messageChunk", onChunk); }
      assert(chunks.join("").includes(skillToken), "reply did not include the marker from the skill instructions");
      return "selected project skill produced the marker from SKILL.md";
    });
    await check("streaming", async () => {
      const chunks = [];
      const onChunk = (text) => chunks.push(text);
      agy.on("messageChunk", onChunk);
      await timed(agy.prompt("Reply with exactly: AGY-SMOKE-OK"), "plain reply", turnMs);
      agy.off("messageChunk", onChunk);
      assert(chunks.join("").includes("AGY-SMOKE-OK"), `reply was ${JSON.stringify(chunks.join(""))}`);
      return `reply=${JSON.stringify(chunks.join("").trim())}`;
    });
    await check("permission", async () => {
      const seen = [];
      const answer = (request) => {
        seen.push({ kind: request.toolCall?.kind, cwd: request.toolCall?.rawInput?.Cwd, options: request.options.map((o) => o.kind) });
      };
      agy.on("permissionRequest", answer);
      const calls = [];
      const updates = [];
      const onCall = (call) => calls.push(call);
      const onUpdate = (update) => updates.push(update);
      agy.on("toolCall", onCall);
      agy.on("toolCallUpdate", onUpdate);
      await timed(agy.prompt("Run the shell command `echo agy-smoke` with your command tool, then reply DONE."), "permission turn", turnMs);
      agy.off("permissionRequest", answer);
      agy.off("toolCall", onCall);
      agy.off("toolCallUpdate", onUpdate);
      const command = seen.find((entry) => entry.kind === "execute");
      assert(command, `no execute permission request; saw ${JSON.stringify(seen)}`);
      // The working-folder fix is prompt-level, so a server update could undo it.
      assert.equal(agySessionPathKey(command.cwd, process.platform), agySessionPathKey(scratch, process.platform),
        `command Cwd ${command.cwd} is not the project folder ${scratch}`);
      assert(!updates.some((update) => update.status === "completed"), "the refused command completed");
      // The renderer reads the refused command from rawInput.command.
      const card = calls.find((call) => call.kind === "execute");
      assert(card && /echo agy-smoke/.test(card.rawInput?.command ?? ""), `the command card carries no command: ${JSON.stringify(card?.rawInput)}`);
      assert.equal(card.title, "Run command", `the command card is titled ${JSON.stringify(card.title)}`);
      return `execute asked with ${command.options.join("/")}; refused; Cwd=${command.cwd} (project folder); card command=${JSON.stringify(card.rawInput.command)}`;
    });
    await check("tool call", async () => {
      const calls = [];
      const updates = [];
      const onCall = (call) => calls.push(call);
      const onUpdate = (update) => updates.push(update);
      agy.on("toolCall", onCall);
      agy.on("toolCallUpdate", onUpdate);
      await timed(agy.prompt("Create a file named smoke.txt containing the word hi using your file tool, then reply DONE."), "edit turn", turnMs);
      agy.off("toolCall", onCall);
      agy.off("toolCallUpdate", onUpdate);
      assert(!fs.existsSync(path.join(scratch, "smoke.txt")), "the refused edit wrote smoke.txt");
      const edits = calls.filter((call) => call.kind === "edit");
      assert.equal(edits.length, 1, `expected one edit card, saw ${edits.length}`);
      const final = updates.filter((update) => update.toolCallId === edits[0].toolCallId).at(-1);
      assert(!updates.some((update) => update.status === "completed"), `the refused edit card ended ${final?.status}`);
      return "one refused edit card; scratch file absent";
    });
    await check("tool shapes", async () => {
      fs.writeFileSync(path.join(scratch, "notes.txt"), "smoke notes\n");
      const calls = [];
      const onCall = (call) => calls.push(call);
      agy.on("toolCall", onCall);
      await timed(agy.prompt("Read the file notes.txt with your view_file tool, not the shell, then reply with its first word."), "read turn", turnMs);
      agy.off("toolCall", onCall);
      const read = calls.find((call) => call.tool === "view_file");
      assert(read, `no view_file card; saw ${JSON.stringify(calls.map((call) => [call.title, call.tool]))}`);
      assert(/notes\.txt$/i.test(String(read.rawInput?.file_path ?? "")), `the read card carries no file_path: ${JSON.stringify(read.rawInput)}`);
      // grep_search, find_by_name and list_dir are not registered for a Google
      // sign-in on 1.4.0 (the model says so and uses the shell), so there is
      // nothing live to check for them.
      return `view_file card file_path=${path.basename(read.rawInput.file_path)}`;
    });
    await check("cancellation", async () => {
      let first;
      const firstChunk = new Promise((resolve) => { first = resolve; });
      const onChunk = () => first();
      agy.on("messageChunk", onChunk);
      const turn = agy.prompt("Write the numbers 1 to 300, each on its own line with a one-sentence fact.");
      await timed(firstChunk, "first chunk", turnMs);
      agy.off("messageChunk", onChunk);
      const cancelledAt = Date.now();
      await agy.cancel("smoke");
      await timed(turn, "cancelled turn", rpcMs);
      const settled = Date.now() - cancelledAt;
      const chunks = [];
      const onAfter = (text) => chunks.push(text);
      agy.on("messageChunk", onAfter);
      await timed(agy.prompt("Reply with exactly: AFTER-CANCEL"), "prompt after cancel", turnMs);
      agy.off("messageChunk", onAfter);
      assert(chunks.join("").includes("AFTER-CANCEL"), "the prompt after cancel did not answer");
      return `turn settled ${settled}ms after session/cancel; next prompt answered`;
    });
    await check("resume", async () => {
      const disposed = Date.now();
      await agy.dispose();
      say(`agy: first server stopped in ${Date.now() - disposed}ms`);
      const resumed = client();
      const replay = [];
      resumed.on("userMessageChunk", (text) => replay.push(text));
      resumed.on("messageChunk", (text) => replay.push(text));
      await timed(resumed.start(), "initialize (resume)", rpcMs * 2);
      await timed(resumed.loadSession(sessionId), "session/load", rpcMs);
      assert(replay.join(" ").includes("AGY-SMOKE-OK"), "replay did not carry the first exchange");
      const listed = listAgySessions(scratch, process.platform);
      assert(listed.some((entry) => entry.sessionId === sessionId), "history listing from disk did not find the session");
      await resumed.dispose();
      return `session/load replayed the transcript; listed from disk with updatedAt=${new Date(listed.find((e) => e.sessionId === sessionId).updatedAt).toISOString()}`;
    });
  } finally {
    await meter?.dispose();
    await Promise.all(clients.map((made) => made.dispose().catch(() => undefined)));
    log.end();
    if (process.platform === "win32") {
      // Each Windows start unpacks ~300 MB into %TEMP%; a clean stop removes it.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const leaked = meiDirs().filter((name) => !before.has(name));
      record("cleanup", leaked.length ? "FAIL" : "PASS", leaked.length ? `left ${leaked.join(", ")} in %TEMP%` : "no server unpack directory left in %TEMP%");
    }
    try {
      assert(path.basename(scratch).startsWith("grok-acp-smoke-agy-"));
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) { record("cleanup", "FAIL", `scratch: ${error?.message ?? error}`); }
  }
  void root;
}

async function exerciseAutoAccept({ agy, timed, rpcMs, turnMs, scratch }) {
  const { pickAutoAcceptOption } = require("../out/session.js");
  const { isPlanReviewPermission } = require("../out/plan-gate.js");
  assert(agy.pickerModes.includes("yolo"), "the CLI picker omitted Auto accept");
  await timed(agy.setMode("yolo"), "CLI Auto accept", rpcMs);
  assert.equal(agy.currentModeId, "agent", "the underlying CLI must stay in default mode");
  const answers = [];
  const answer = (request) => {
    const option = !isPlanReviewPermission(request.toolCall?.kind) && pickAutoAcceptOption(request.options, "agy");
    answers.push(option?.kind ?? "cancelled");
    if (option) agy.respondPermission(request.id, option.optionId);
    else agy.respondPermissionCancelled(request.id);
  };
  // A shell command, not a file edit: the CLI's default mode edits workspace files
  // without asking (measured on agy 1.5.8, 22 Nov 2026), so only a command proves
  // that a request arrived and Auto accept answered it. A folder, not a file:
  // PowerShell's `>` writes UTF-16, mkdir reads the same in every shell.
  const marker = "afk-auto-accept-ok";
  agy.on("permissionRequest", answer);
  try {
    await timed(agy.prompt(`Run exactly this shell command now with your terminal tool: \`mkdir ${marker}\`. Then reply DONE.`),
      "CLI Auto accept command", turnMs);
  } finally { agy.off("permissionRequest", answer); }
  assert(answers.length > 0, "no permission request arrived");
  assert(answers.every(kind => kind === "allow_once"), `unexpected permission answers: ${answers.join(", ")}`);
  assert(fs.statSync(path.join(scratch, marker), { throwIfNoEntry: false })?.isDirectory(), "the command did not run");
  return `${answers.length} permission requests answered with allow_once; the command ran`;
}

async function exerciseCli({ agy, client, check, timed, rpcMs, turnMs, scratch }) {
  let sessionId;
  const replies = [];
  const permissionKinds = [];
  const modeUpdates = [];
  agy.on("messageChunk", text => replies.push(text));
  agy.on("modeChanged", mode => modeUpdates.push(mode));
  agy.on("refusedServerRequest", (method, params) => {
    if (method === "session/request_permission") {
      const { planTextFromPermissionToolCall } = require("../out/plan-gate.js");
      permissionKinds.push({
        kind: params?.toolCall?.kind,
        title: params?.toolCall?.title,
        planText: !!planTextFromPermissionToolCall(params?.toolCall),
        inputFields: Object.keys(params?.toolCall?.rawInput ?? {}),
        options: params?.options?.map(option => option.kind),
      });
    }
  });
  const opened = await check("CLI session and model catalog", async () => {
    ({ sessionId } = await timed(agy.newSession("gemini-3.8-flash"), "CLI session/new", rpcMs));
    assert.deepEqual(agy.pickerModes, ["agent", "acceptEdits", "auto", "plan", "yolo"]);
    assert.equal(agy.currentReasoningEffort, "low");
    assert(agy.supportsInterject());
    for (const mode of ["acceptEdits", "auto", "agent"]) {
      await timed(agy.setMode(mode), mode, rpcMs);
      assert.equal(agy.currentModeId, mode);
    }
    return agy.availableModels.map(model => model.name).join(", ");
  });
  if (!opened) return;

  await check("CLI plain reply", async () => {
    await timed(agy.prompt("Reply with exactly AGY-CLI-SMOKE-OK. Do not call tools."), "CLI reply", turnMs);
    assert(replies.join("").includes("AGY-CLI-SMOKE-OK"));
    return "the first reply streamed";
  });

  // Measured on 1.5.8 (2026-11-20): there is no native review request. On Gemini 4 Neon a
  // Plan turn wrote implementation_plan.md into the CLI's own brain folder (no permission)
  // and asked for review in text; a "proceed" reply implemented through the ordinary edit
  // approvals. Whether the plan comes as that file or as reply text is the model's choice,
  // so the check holds Plan's contract and reports which form arrived.
  await check("CLI Plan turn", async () => {
    modeUpdates.length = 0;
    const readme = path.join(scratch, "README.md");
    const original = "# Scratch\n\nA tiny scratch project.\n";
    fs.writeFileSync(readme, original);
    const calls = [];
    const updates = [];
    const onCall = (call) => calls.push(call);
    const onUpdate = (update) => updates.push(update);
    agy.on("toolCall", onCall);
    agy.on("toolCallUpdate", onUpdate);
    const refusedBefore = permissionKinds.length;
    const start = replies.length;
    try {
      await timed(agy.setMode("plan"), "CLI Plan", rpcMs);
      assert.equal(agy.currentModeId, "plan");
      await timed(agy.prompt('README.md in this folder contains exactly: "# Scratch" then a blank line then "A tiny scratch project.". Add a Usage section and a License section (MIT) to it. Do not run shell commands; you already have the file contents above.'), "CLI plan turn", turnMs);
    } finally { agy.off("toolCall", onCall); agy.off("toolCallUpdate", onUpdate); }
    const reply = replies.slice(start).join("");
    const planCard = [...calls, ...updates].some((update) => /antigravity-cli[\\/]+brain[\\/]/.test(JSON.stringify(update)));
    const detail = JSON.stringify({
      planCard,
      tools: [...calls, ...updates].map((update) => [update.tool ?? update.name, update.kind, update.status, String(update.title ?? "").slice(-40)]),
      refused: permissionKinds.length - refusedBefore, modeUpdates, reply: reply.slice(0, 400),
    });
    assert(planCard || reply.trim(), `no plan reached the person: ${detail}`);
    assert.equal(permissionKinds.length, refusedBefore, `the Plan turn asked for permission: ${detail}`);
    assert.equal(agy.currentModeId, "plan", detail);
    assert.equal(fs.readFileSync(readme, "utf8"), original, `the Plan turn changed README.md: ${detail}`);
    return detail;
  });

  await check("CLI steering", async () => {
    await timed(agy.setMode("agent"), "leave CLI Plan", rpcMs);
    const firstChunk = new Promise(resolve => agy.once("messageChunk", resolve));
    const start = replies.length;
    const first = agy.prompt("Write a forty-paragraph numbered explanation of a fictional garden. Write only text. Do not call tools.");
    void first.catch(() => {});
    await timed(firstChunk, "first CLI chunk", turnMs);
    const steered = agy.interject("At the next boundary, finish your reply with the exact marker AGY-STEER-SMOKE. Do not call tools.");
    const [verdict] = await timed(Promise.all([steered, first]), "steered CLI turn", turnMs);
    assert.equal(verdict, "ok");
    assert(replies.slice(start).join("").includes("AGY-STEER-SMOKE"), "the correction did not reach the generated reply");
    return "the correction reached the running CLI turn";
  });

  await check("CLI compact and goal commands", async () => {
    assert(agy.availableCommands.some(command => command.name === "goal"));
    assert(agy.availableCommands.some(command => command.name === "compact"));
    const start = replies.length;
    await timed(agy.prompt("/compact"), "CLI /compact", turnMs);
    assert.equal(agy.lastPromptStopReason, "end_turn");
    return `/goal advertised; /compact ended with ${replies.slice(start).join("").length} reply characters`;
  });

  await check("CLI uses the managed meter", async () => {
    const start = replies.length;
    const mode = agy.currentModeId;
    const model = agy.currentModelId;
    const windows = await timed(agy.getSubscriptionUsage(), "managed server /usage", rpcMs * 2);
    assert(windows.length, "the managed server returned no readable quota windows");
    assert.equal(agy.sessionId, sessionId);
    assert.equal(agy.currentModeId, mode);
    assert.equal(agy.currentModelId, model);
    assert.equal(replies.length, start);
    return windows.map(window => window.label).join(", ");
  });

  await check("CLI history and replay", async () => {
    await agy.dispose();
    const reopened = client();
    await timed(reopened.start(), "CLI catalog initialize", rpcMs);
    const { sessions } = await timed(reopened.listSessions(""), "CLI session/list", rpcMs);
    const row = sessions.find(row => row.sessionId === sessionId);
    assert(row, "CLI session/list did not include the scratch conversation");
    const replay = [];
    reopened.on("messageChunk", text => replay.push(text));
    await timed(reopened.loadSession(sessionId), "CLI session/load", rpcMs);
    assert(replay.join("").includes("AGY-CLI-SMOKE-OK"), "CLI did not replay the first exchange");
    return `CLI listed its scratch conversation (cwd and ${row.title ? "a title" : "no title"}) and replayed it`;
  });
}
