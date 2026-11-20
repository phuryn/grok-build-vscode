// Live smoke for Google's Antigravity ACP server, through the SHIPPED host
// code: the compiled AcpClient with AgyBackend, exactly as a session spawns it.
// Reached from `npm run smoke:acp -- --provider=agy`; opt-in, never part of a
// default run, `npm test` or CI.
//
// Needs a signed-in server (Settings -> Providers -> Antigravity -> Connect).
// It NEVER calls `logout`: that would sign the machine's account out.
// Server path: AGY_SERVER_PATH, else the copy the app installed
// (AGY_STORAGE_ROOT, the extension's global storage, to find it).
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
  const { AgyBackend, agySessionPathKey, listAgySessions } = require("../out/agy-backend.js");
  const { agyGoogleAuth, agyGoogleSignInPresent } = require("../out/agy-auth.js");
  const { locateAgyServer } = require("../out/agy-managed-installer.js");
  const server = process.env.AGY_SERVER_PATH || locateAgyServer({ managedStorageRoot: process.env.AGY_STORAGE_ROOT });
  assert(server && fs.existsSync(server), "no Antigravity server: set AGY_SERVER_PATH, or AGY_STORAGE_ROOT to the extension's global storage");
  assert(await agyGoogleSignInPresent(), "Antigravity is not signed in with Google on this machine; connect it in the app first (this smoke never signs in or out)");
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
  const client = () => {
    const made = new AcpClient({
      cliPath: server, cwd: scratch, effort: "low", env: { ...process.env },
      backend: new AgyBackend(), log: (line) => log.write(`${new Date().toISOString()} ${line}\n`),
      timeouts: { requestTimeoutMs: rpcMs, promptIdleTimeoutMs: turnMs },
      // As the host starts it: the chosen method, stated on every start. With
      // the stored token the server refreshes silently; it never opens a browser.
      startupAuth: agyGoogleAuth(),
    });
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
    say(`agy server: ${server}; scratch: ${scratch}`);
    agy = client();
    let init;
    agy.once("initialized", (value) => { init = value; });
    // start() returns after `authenticate {methodId: "oauth-personal"}`.
    await timed(agy.start(), "initialize + authenticate", rpcMs * 2);
    record("initialize", "PASS", `agentInfo=${init?.agentInfo?.name} ${init?.agentInfo?.version}; systemPrompt.append=${init?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true}; authenticated with oauth-personal`);
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
    await check("approval modes", async () => {
      assert.equal(agy.nativeApprovalModes, true, "server did not advertise the three approval modes");
      assert.equal(agy.supportsInterject(), false);
      for (const mode of ["acceptEdits", "yolo", "agent"]) {
        await timed(agy.setMode(mode), `mode ${mode}`, rpcMs);
        assert.equal(agy.currentModeId, mode);
      }
      return "switched to Accept edits, Auto accept and back to Agent mode";
    });
    await check("subscription usage", async () => {
      const windows = await timed(agy.getSubscriptionUsage(), "Google quota summary", rpcMs);
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
        agy.respondPermission(request.id, request.options.find((o) => o.kind === "allow_once").optionId);
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
      assert(updates.some((update) => update.status === "completed"), "the approved command never completed");
      // The card shows what ran and what came back: the renderer reads
      // rawInput.command and rawOutput.output, which AgyBackend fills in.
      const card = calls.find((call) => call.kind === "execute");
      assert(card && /echo agy-smoke/.test(card.rawInput?.command ?? ""), `the command card carries no command: ${JSON.stringify(card?.rawInput)}`);
      assert.equal(card.title, "Run command", `the command card is titled ${JSON.stringify(card.title)}`);
      const output = updates.filter((update) => update.toolCallId === card.toolCallId).map((update) => update.rawOutput?.output).find((value) => typeof value === "string");
      assert(output && output.includes("agy-smoke"), `the command card carries no output: ${JSON.stringify(output)}`);
      return `execute asked with ${command.options.join("/")}; answered allow_once; Cwd=${command.cwd} (project folder); card command=${JSON.stringify(card.rawInput.command)} output=${JSON.stringify(output.trim())}`;
    });
    await check("tool call", async () => {
      const calls = [];
      const updates = [];
      const onCall = (call) => calls.push(call);
      const onUpdate = (update) => updates.push(update);
      const answer = (request) => agy.respondPermission(request.id, request.options.find((o) => o.kind === "allow_once").optionId);
      agy.on("toolCall", onCall);
      agy.on("toolCallUpdate", onUpdate);
      agy.on("permissionRequest", answer);
      await timed(agy.prompt("Create a file named smoke.txt containing the word hi using your file tool, then reply DONE."), "edit turn", turnMs);
      agy.off("toolCall", onCall);
      agy.off("toolCallUpdate", onUpdate);
      agy.off("permissionRequest", answer);
      assert(fs.existsSync(path.join(scratch, "smoke.txt")), "smoke.txt was not written in the project folder");
      const edits = calls.filter((call) => call.kind === "edit");
      assert.equal(edits.length, 1, `expected one edit card, saw ${edits.length}`);
      const final = updates.filter((update) => update.toolCallId === edits[0].toolCallId).at(-1);
      assert.equal(final?.status, "completed", `the approved edit card ended ${final?.status}: ${JSON.stringify(final?.rawOutput)}`);
      assert(!updates.some((update) => update.status === "failed"), "a failed tool card reached the client");
      return "one edit card, approved and completed; no red duplicate; file written in the project folder";
    });
    await check("tool shapes", async () => {
      fs.writeFileSync(path.join(scratch, "notes.txt"), "smoke notes\n");
      const calls = [];
      const onCall = (call) => calls.push(call);
      const answer = (request) => agy.respondPermission(request.id, request.options.find((o) => o.kind === "allow_once").optionId);
      agy.on("toolCall", onCall);
      agy.on("permissionRequest", answer);
      await timed(agy.prompt("Read the file notes.txt with your view_file tool, not the shell, then reply with its first word."), "read turn", turnMs);
      agy.off("toolCall", onCall);
      agy.off("permissionRequest", answer);
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
