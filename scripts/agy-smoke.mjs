// Live agy smoke. Default is a credential-free handshake. --key adds a real turn.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export async function runAgySmoke({ record, rpcMs = 15_000, turnMs = 60_000, keyMode = false }) {
  const { AcpClient } = require("../out/acp.js");
  const { AgyBackend, locateAgyCli } = require("../out/agy-backend.js");
  const { AGY_KEY_METHOD, agyCredentialEnv } = require("../out/agy-auth.js");
  const binary = process.env.AGY_CLI_PATH || locateAgyCli();
  assert(binary && fs.existsSync(binary), "Install agy or set AGY_CLI_PATH.");
  const key = keyMode ? process.env.GEMINI_API_KEY?.trim() : undefined;
  assert(!keyMode || key, "Set GEMINI_API_KEY in the smoke process environment for --key.");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "afk-agy-smoke-")));
  const geminiDir = path.join(scratch, ".gemini");
  const env = agyCredentialEnv(process.env, key);
  const isolated = {
    HOME: scratch, USERPROFILE: scratch, LOCALAPPDATA: path.join(scratch, "local"), APPDATA: path.join(scratch, "roaming"),
    XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_CACHE_HOME: path.join(scratch, "cache"),
    XDG_DATA_HOME: path.join(scratch, "data"), GEMINI_HOME: geminiDir, AGY_CLI_DISABLE_AUTO_UPDATE: "1",
  };
  for (const name of Object.keys(env)) {
    if (Object.hasOwn(isolated, name.toUpperCase()) || /^(GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(name)) delete env[name];
  }
  const profile = keyMode ? "server" : "cli";
  const client = new AcpClient({
    cliPath: path.resolve(binary), cwd: scratch, env: { ...env, ...isolated },
    backend: new AgyBackend({ profile, geminiDir }),
    initializeTimeoutMs: rpcMs, timeouts: { requestTimeoutMs: rpcMs, promptAbsoluteTimeoutMs: turnMs },
    refuseServerRequests: true, log: () => {},
    ...(keyMode ? { startupAuth: { methodId: AGY_KEY_METHOD } } : {}),
  });
  try {
    let handshake;
    client.once("initialized", init => { handshake = init; });
    await client.start();
    assert(handshake?.authMethods?.some(method => method.id === AGY_KEY_METHOD), "agy did not advertise key authentication.");
    record("initialize", "PASS", "agy ACP answered in a throwaway Gemini profile.");
    if (!keyMode) return;
    const { sessionId } = await client.newSession();
    assert(client.availableModels.some(model => model.modelId === "gemini-4-argon" || model.modelId === "gemini-4-argon-high"),
      "The key catalog did not offer Gemini 4 Argon.");
    await client.setModel(client.availableModels.some(model => model.modelId === "gemini-4-argon")
      ? "gemini-4-argon" : "gemini-4-argon-high");
    if (client.currentModelId === "gemini-4-argon") assert(await client.setReasoningEffort("high"));
    let response = "";
    client.on("messageChunk", chunk => { response += chunk; });
    await client.prompt("Reply with just the word ok.");
    assert(/^ok[.!]?$/i.test(response.trim()), "agy did not return the requested reply.");
    assert((await client.listSessions(scratch)).sessions.some(row => row.sessionId === sessionId), "Conversation is missing from its profile.");
    await client.loadSession(sessionId);
    record("key chat", "PASS", "Key authentication, Argon prompt, history listing and reopen worked.");
  } catch {
    // Vendor diagnostics can include credentials or a copy of the prompt.
    record(keyMode ? "key chat" : "initialize", "FAIL", "agy did not complete the smoke check.");
  } finally {
    await client.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runAgySmoke({
    keyMode: process.argv.includes("--key"),
    record: (capability, result, detail) => {
      console.log(`[agy-smoke] ${capability} ${result}. ${detail}`);
      if (result === "FAIL") process.exitCode = 1;
    },
  }).catch(() => {
    console.error("The smoke needs a compiled host and an installed agy CLI. For --key, set GEMINI_API_KEY in the environment.");
    process.exitCode = 1;
  });
}
