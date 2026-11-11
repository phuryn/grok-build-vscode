import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpClient, type PermissionRequest } from "../src/acp";
import { AgyBackend, agyWorkingFolderPrompt } from "../src/agy-backend";
import { agyGatewayAuth, agyGatewayEnv, agyGoogleAuth, agyGoogleSignInPresent, runAgySignIn } from "../src/agy-auth";
import { AgyKeyRelay, type AgyRelayLease } from "../src/agy-key-relay";

const FAKE = path.join(__dirname, "fixtures", "fake-agy-acp.cjs");

function signIn(home: string): void {
  const acp = path.join(home, "antigravity-acp");
  fs.mkdirSync(acp, { recursive: true });
  fs.writeFileSync(path.join(acp, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
  fs.writeFileSync(path.join(acp, "acp_token.json"), "{}");
}

describe("Antigravity over ACP (real subprocess, fake server)", () => {
  let home: string;
  let cwd: string;
  let sink: string;
  const clients: AcpClient[] = [];

  function client(extraEnv: NodeJS.ProcessEnv = {}, startupAuth?: { methodId: string; meta?: Record<string, unknown> }, keyMode = false, keyRelay?: AgyRelayLease, effort?: "low" | "high" | "xhigh"): AcpClient {
    const made = new AcpClient({
      cliPath: FAKE,
      cwd,
      backend: new AgyBackend({ env: { GEMINI_HOME: home }, keyMode, keyRelay }),
      effort,
      env: { ...process.env, GEMINI_HOME: home, FAKE_AGY_SINK: sink, ...extraEnv },
      log: () => {},
      ...(startupAuth ? { startupAuth } : {}),
    });
    clients.push(made);
    return made;
  }

  const received = () => fs.readFileSync(sink, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-test-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-project-test-"));
    sink = path.join(home, "requests.jsonl");
    fs.writeFileSync(sink, "");
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((made) => { made.removeAllListeners(); return made.dispose(); }));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("opens a session with the working-folder append, one model, and effort as thinking_level", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    const initialize = received().find((entry) => entry.method === "initialize");
    expect(initialize.params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    await agy.newSession();
    const sessionNew = received().find((entry) => entry.method === "session/new");
    expect(sessionNew.params).toMatchObject({ cwd, mcpServers: [], _meta: { antigravity: { systemPrompt: { append: agyWorkingFolderPrompt(cwd) } } } });
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-3.8-flash"]);
    expect(agy.availableModels[0].reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(agy.currentReasoningEffort).toBe("high");
    await expect(agy.setReasoningEffort("xhigh")).resolves.toBe(true);
    await expect(agy.setReasoningEffort("minimal")).resolves.toBe(true);
    expect(agy.currentReasoningEffort).toBe("low");
    expect(received().filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params.value)).toEqual(["high", "low"]);
  });

  it("starts at the remembered effort", async () => {
    signIn(home);
    const agy = new AcpClient({
      cliPath: FAKE, cwd, effort: "medium",
      backend: new AgyBackend({ env: { GEMINI_HOME: home } }),
      env: { ...process.env, GEMINI_HOME: home, FAKE_AGY_SINK: sink },
      log: () => {},
    });
    clients.push(agy);
    await agy.start();
    await agy.newSession();
    expect(agy.currentReasoningEffort).toBe("medium");
  });

  it("classifies a signed-out session/new as a credential error", async () => {
    const agy = client();
    await agy.start();
    const failure = await agy.newSession().catch((error) => error);
    expect(failure).toMatchObject({ code: -32000 });
    expect(agy.isCredentialError(failure)).toBe(true);
  });

  it("renders one completed card for an approved edit, not a red one beside it", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    const updates: any[] = [];
    const calls: any[] = [];
    agy.on("toolCall", (call) => calls.push(call));
    agy.on("toolCallUpdate", (update) => updates.push(update));
    agy.on("permissionRequest", (request: PermissionRequest) => agy.respondPermission(request.id, "allow"));
    await agy.prompt("please edit hello.txt");
    expect(calls.map((call) => call.toolCallId)).toEqual(["b6f93483bd0942fa8b4b4751ca211cc3"]);
    expect(updates.map((update) => [update.toolCallId, update.status])).toEqual([
      ["b6f93483bd0942fa8b4b4751ca211cc3", "in_progress"],
      ["b6f93483bd0942fa8b4b4751ca211cc3", "completed"],
    ]);
  });

  it("hides /logout and /plan from the command list", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    await agy.prompt("hello");
    expect(agy.availableCommands.map((command) => command.name)).toEqual(["usage"]);
  });

  it("cancels a running turn and takes the next prompt", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    const chunks: string[] = [];
    agy.on("messageChunk", (text) => chunks.push(text));
    const turn = agy.prompt("a slow answer please");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await agy.cancel("test");
    await expect(turn).resolves.toBeDefined();
    expect(received().some((entry) => entry.method === "session/cancel")).toBe(true);
    expect(chunks.join("")).toContain("The request was cancelled by the client.");
    chunks.length = 0;
    await agy.prompt("hello");
    expect(chunks).toEqual(["OK"]);
  });

  it("resumes with the working-folder append and replays the transcript", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    const chunks: string[] = [];
    agy.on("messageChunk", (text) => chunks.push(text));
    await agy.loadSession("5e550000-0000-4000-8000-000000000001");
    const load = received().find((entry) => entry.method === "session/load");
    expect(load.params._meta.antigravity.systemPrompt.append).toBe(agyWorkingFolderPrompt(cwd));
    expect(chunks.join("")).toContain("OK");
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-3.8-flash"]);
  });

  it("signs in through authenticate and out through logout, on the server's own files", async () => {
    const onPrompt = (url: string) => urls.push(url);
    const urls: string[] = [];
    const done = await new Promise<any>((resolve) => {
      runAgySignIn(client(), { onPrompt: (prompt) => onPrompt(prompt.url), onDone: resolve });
    });
    expect(done).toEqual({ ok: true, output: "" });
    expect(urls).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?client_id=fake"]);
    expect(await agyGoogleSignInPresent({ env: { GEMINI_HOME: home }, platform: "linux" })).toBe(true);
    const agy = client();
    await agy.start();
    await agy.logout();
    expect(await agyGoogleSignInPresent({ env: { GEMINI_HOME: home }, platform: "linux" })).toBe(false);
  });

  it("reports a refused Google sign-in as failed", async () => {
    const done = await new Promise<any>((resolve) => {
      runAgySignIn(client({ FAKE_AGY_SIGN_IN: "deny" }), { onPrompt: () => {}, onDone: resolve });
    });
    expect(done).toMatchObject({ ok: false, failure: "failed" });
    expect(done.output).toContain("Onboarding failed");
  });

  // Key sign-in end to end: the real relay between the server and a local
  // stand-in for Google, which records what reached it.
  async function fakeGoogle() {
    const seen: { method: string; path: string; key: unknown; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", path: (req.url ?? "").split("?")[0], key: req.headers["x-goog-api-key"], body });
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ models: [
            "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-preview-tts", "gemma-4-31b-it", "gemini-flash-latest",
            "nano-banana-pro-preview", "gemini-3.8-flash", "gemini-4-argon",
          ].map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"], thinking: id === "gemini-4-argon" }))
            .concat([{ name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"], thinking: false }]) }));
        }
        if (req.headers["x-goog-api-key"] !== "AIza-good") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }));
        }
        const model = /models\/([^:]+):/.exec(req.url ?? "")?.[1];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `Hello from ${model}` }] } }] })}\r\n\r\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const relay = new AgyKeyRelay({
      upstream: (url, options) => http.request({ host: "127.0.0.1", port, path: url.pathname + url.search, method: options.method, headers: options.headers }),
    });
    cleanups.push(async () => { await relay.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    return { seen, relay };
  }
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it("signs a key in as a gateway at the relay, which alone presents the key, and starts on Gemini 4 Argon", async () => {
    const { seen, relay } = await fakeGoogle();
    const lease = await relay.acquire("AIza-good", "low");
    const agy = client(agyGatewayEnv({}), agyGatewayAuth(lease.baseUrl), true, lease, "low");
    await agy.start();
    await agy.newSession();
    const methods = received().map((entry) => entry.method);
    expect(methods.indexOf("authenticate")).toBeLessThan(methods.indexOf("session/new"));
    expect(received().find((entry) => entry.method === "authenticate").params).toEqual({ methodId: "gateway", _meta: { gateway: { baseUrl: lease.baseUrl } } });
    // Chat models only, newest first and never Gemini 2 (the gateway can start on
    // gemini-2.5-flash, the first it lists); the start moved to Argon by itself.
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-4-argon", "gemini-3.8-flash"]);
    expect(agy.currentModelId).toBe("gemini-4-argon");
    expect(agy.availableModels[0]).toMatchObject({ supportsReasoningEffort: true, reasoningEfforts: ["low", "medium", "high"], reasoningEffort: "low" });
    expect(agy.availableModels[1]).toMatchObject({ supportsReasoningEffort: false, reasoningEfforts: [] });
    expect(agy.currentReasoningEffort).toBe("low");
    await agy.prompt("first, at the person's default");
    expect(JSON.parse(seen.at(-1)!.body).generationConfig.thinkingConfig.thinkingLevel).toBe("low");
    // Key effort is local: no unsupported ACP config option is sent, and the
    // host's broader effort ladder is mapped onto the three real API levels.
    await expect(agy.setReasoningEffort("xhigh")).resolves.toBe(true);
    expect(agy.currentReasoningEffort).toBe("high");
    expect(received().filter((entry) => entry.params?.configId === "thinking_level")).toEqual([]);
    const chunks: string[] = [];
    agy.on("messageChunk", (text) => chunks.push(text));
    await agy.prompt("hello");
    expect(chunks.join("")).toBe("Hello from gemini-4-argon");
    expect(JSON.parse(seen.at(-1)!.body).generationConfig.thinkingConfig.thinkingLevel).toBe("high");
    expect(seen.map(({ method, path: route }) => `${method} ${route}`)).toEqual([
      "GET /v1beta/models", "POST /v1beta/models/gemini-4-argon:streamGenerateContent",
      "POST /v1beta/models/gemini-4-argon:streamGenerateContent",
    ]);
    await agy.setModel("gemini-3.8-flash");
    expect(agy.currentModelSupportsEffort()).toBe(false);
    await expect(agy.setReasoningEffort("medium")).resolves.toBe(false);
    await agy.prompt("a model without thinking");
    expect(JSON.parse(seen.at(-1)!.body).generationConfig?.thinkingConfig).toBeUndefined();
    await agy.setModel("gemini-4-argon");
    expect(agy.currentReasoningEffort).toBe("high");
    // The harness's own credential never reached Google; the key went only there.
    expect(seen.every((request) => request.key === "AIza-good")).toBe(true);
    expect(fs.readFileSync(sink, "utf8")).not.toContain("AIza-good");
  });

  it("is refused as a gateway without the rollout flag", async () => {
    const { relay } = await fakeGoogle();
    const lease = await relay.acquire("AIza-good");
    const agy = client({}, agyGatewayAuth(lease.baseUrl), true);
    await expect(agy.start()).rejects.toMatchObject({ code: -32602 });
  });

  it("reports a key Google refuses as a rejected credential", async () => {
    const { relay } = await fakeGoogle();
    const lease = await relay.acquire("AIza-bad");
    const agy = client(agyGatewayEnv({}), agyGatewayAuth(lease.baseUrl), true);
    await agy.start();
    await agy.newSession();
    let rejected = 0;
    agy.on("credentialRejected", () => { rejected += 1; });
    await agy.prompt("hello");
    expect(rejected).toBe(1);
  });

  it("states the Google method on every start, whatever settings.json was left saying", async () => {
    signIn(home);
    fs.writeFileSync(path.join(home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "gemini-api-key" } }));
    const agy = client({}, agyGoogleAuth());
    await agy.start();
    await agy.newSession();
    expect(received().find((entry) => entry.method === "authenticate").params).toEqual({ methodId: "oauth-personal" });
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-3.8-flash"]);
  });

  // The child's calls arrive on this session; AcpClient routes them to the
  // card's stream, exactly as a child session's, and settles the card when the
  // turn ends.
  it("routes a subagent's calls into its card's stream and settles the card at the turn's end", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    agy.on("permissionRequest", (request: PermissionRequest) => agy.respondPermission(request.id, "allow"));
    const parent: any[] = [];
    const children: any[] = [];
    const chunks: string[] = [];
    agy.on("toolCall", (call) => parent.push(["call", call.toolCallId, call.status]));
    agy.on("toolCallUpdate", (update) => parent.push(["update", update.toolCallId, update.status]));
    agy.on("childStream", (event) => children.push([event.childSessionId, event.route.event, event.route.payload?.toolCallId]));
    agy.on("messageChunk", (text) => chunks.push(text));
    await agy.prompt("run a subagent");
    const launch = "24ac72049c3b49ecac09e055152210cf";
    expect(children).toEqual([
      [`agy-subagent:${launch}`, "toolCall", "call_636537"],
      [`agy-subagent:${launch}`, "toolCallUpdate", "call_636537"],
    ]);
    expect(parent).toEqual([
      ["call", launch, "pending"],
      ["update", launch, "in_progress"],
      ["update", launch, "in_progress"],
      ["update", launch, "completed"],
    ]);
    expect(chunks.join("")).toBe("The subagent found the notes.");
  });

  it("lists the project's conversations from disk", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    const { sessionId } = await agy.newSession();
    const listed = await new AgyBackend({ env: { GEMINI_HOME: home } }).listSessions(async () => ({}), cwd, process.platform);
    expect(listed.sessions.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(typeof listed.sessions[0].updatedAt).toBe("number");
  });
});
