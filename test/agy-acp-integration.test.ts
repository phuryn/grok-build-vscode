import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpClient, type PermissionRequest } from "../src/acp";
import { AgyBackend, agyWorkingFolderPrompt } from "../src/agy-backend";
import { AGY_KEY_METHOD, agyCredentialEnv, agyGoogleSignInPresent, runAgySignIn, startAgyGoogleChat } from "../src/agy-auth";

const FAKE = path.join(__dirname, "fixtures", "fake-agy-acp.cjs");

function signIn(home: string): void {
  const acp = path.join(home, "antigravity-acp");
  fs.mkdirSync(acp, { recursive: true });
  fs.writeFileSync(path.join(acp, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
  fs.writeFileSync(path.join(acp, "acp_token.json"), "{}");
}

describe("Antigravity over ACP (real subprocess, fake CLI)", () => {
  let home: string;
  let cwd: string;
  let sink: string;
  const clients: AcpClient[] = [];

  function client(extraEnv: NodeJS.ProcessEnv = {}, startupAuth?: { methodId: string; meta?: Record<string, unknown> }): AcpClient {
    const made = new AcpClient({
      cliPath: FAKE,
      cwd,
      backend: new AgyBackend({ profile: "server" }),
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

  it("opens a session with the working-folder append, one model, and effort as thought_level", async () => {
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
      backend: new AgyBackend({ profile: "server" }),
      env: { ...process.env, GEMINI_HOME: home, FAKE_AGY_SINK: sink },
      log: () => {},
    });
    clients.push(agy);
    await agy.start();
    await agy.newSession();
    expect(agy.currentReasoningEffort).toBe("medium");
  });

  it("uses advertised models, exact extra-high effort, and native approval modes across reopen", async () => {
    signIn(home);
    const agy = client({ FAKE_AGY_EXTENDED_CATALOG: "1" }, { methodId: "oauth-personal" });
    await agy.start();
    const { sessionId } = await agy.newSession();
    expect(received().find(entry => entry.method === "initialize").params).not.toHaveProperty("clientInfo");
    expect(agy.nativeApprovalModes).toBe(true);
    expect(agy.supportsInterject()).toBe(true);
    expect(agy.currentModeId).toBe("agent");
    expect(agy.availableModels.map(model => [model.modelId, model.reasoningEfforts])).toEqual([
      ["gemini-4-neon", ["low", "medium", "high", "xhigh"]],
      ["gemini-4-carbon", ["low", "medium", "high"]],
      ["gemini-4-argon", ["low", "medium", "high"]],
      ["gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]],
      ["gemini-3.8-flash", ["low", "medium", "high"]],
    ]);
    await agy.setModel("gemini-4-neon");
    await expect(agy.setReasoningEffort("xhigh")).resolves.toBe(true);
    expect(agy.currentReasoningEffort).toBe("xhigh");
    for (const mode of ["plan", "agent", "acceptEdits"]) {
      await agy.setMode(mode);
      expect(agy.currentModeId).toBe(mode);
    }
    expect(received().filter(entry => entry.method === "session/set_config_option")
      .map(entry => [entry.params.configId, entry.params.value])).toEqual([
      ["model", "gemini-4-neon"], ["thought_level", "xhigh"], ["mode", "plan"], ["mode", "default"], ["mode", "accept-edits"],
    ]);
    await agy.dispose();
    const reopened = client({ FAKE_AGY_EXTENDED_CATALOG: "1" }, { methodId: "oauth-personal" });
    await reopened.start();
    await reopened.loadSession(sessionId);
    expect(reopened.currentModeId).toBe("acceptEdits");
  });

  it("merges skills with native commands and rewrites only authored skill picks on the wire", async () => {
    signIn(home);
    for (const name of ["review", "compact", "native-check", "plan", "logout"]) {
      const folder = path.join(cwd, ".agents", "skills", name);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: A project skill\n---\n`);
    }
    const agy = client({ FAKE_AGY_EXTENDED_CATALOG: "1" }, { methodId: "oauth-personal" });
    await agy.start();
    await agy.newSession();
    await vi.waitFor(() => expect(agy.availableCommands.map(command => command.name)).toEqual(["plan", "compact", "native-check", "review"]));
    expect(agy.availableCommands[2]).toEqual({ name: "native-check", description: "Native command for the collision test" });
    const blocks = [{ type: "text", text: "Attached context /review \n\nPlease /review these notes" }] as const;
    await agy.prompt([...blocks], ["Please /review these notes"]);
    expect(received().find(entry => entry.method === "session/prompt").params.prompt).toEqual([
      { type: "text", text: "Attached context /review \n\nPlease [Use the review skill with lookup_skill and follow its instructions] these notes" },
    ]);
    expect(blocks[0].text).toBe("Attached context /review \n\nPlease /review these notes");
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

  it("hides /logout and keeps /plan in the command list", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    await agy.prompt("hello");
    expect(agy.availableCommands.map((command) => command.name)).toEqual(["plan", "compact"]);
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

  it.each(["oauth-personal", AGY_KEY_METHOD])("replays legacy history with %s and sends the working-folder append", async methodId => {
    signIn(home);
    const agy = methodId === AGY_KEY_METHOD
      ? client(agyCredentialEnv({}, "replay-fixture-key"), { methodId }) : client();
    if (methodId === AGY_KEY_METHOD) await agy.start();
    else await startAgyGoogleChat(agy);
    const chunks: string[] = [];
    agy.on("messageChunk", (text) => chunks.push(text));
    const legacy = "5e550000-0000-4000-8000-000000000001";
    const conversations = path.join(home, "antigravity-acp", "conversations");
    fs.mkdirSync(conversations);
    fs.writeFileSync(path.join(conversations, legacy + ".db"), "");
    await agy.loadSession(legacy);
    expect(received().find(entry => entry.method === "authenticate").params).toEqual({ methodId });
    const load = received().find((entry) => entry.method === "session/load");
    expect(load.params._meta.antigravity.systemPrompt.append).toBe(agyWorkingFolderPrompt(cwd));
    expect(chunks.join("")).toContain("OK");
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-3.8-flash"]);
  });

  it("signs in through authenticate and out through logout, in the selected profile", async () => {
    const onPrompt = (url: string) => urls.push(url);
    const urls: string[] = [];
    const done = await new Promise<any>((resolve) => {
      runAgySignIn(client(), { onPrompt: (prompt) => onPrompt(prompt.url), onDone: resolve });
    });
    expect(done).toEqual({ ok: true, output: "" });
    expect(urls).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?client_id=fake"]);
    expect(await agyGoogleSignInPresent("server", { env: { GEMINI_HOME: home }, platform: "linux" })).toBe(true);
    const agy = client();
    await agy.start();
    await agy.logout();
    expect(await agyGoogleSignInPresent("server", { env: { GEMINI_HOME: home }, platform: "linux" })).toBe(false);
  });

  it("reports a refused Google sign-in as failed", async () => {
    const done = await new Promise<any>((resolve) => {
      runAgySignIn(client({ FAKE_AGY_SIGN_IN: "deny" }), { onPrompt: () => {}, onDone: resolve });
    });
    expect(done).toMatchObject({ ok: false, failure: "failed" });
    expect(done.output).toContain("Onboarding failed");
  });

  it("gives the CLI a key only in the child environment and authenticates explicitly", async () => {
    signIn(home);
    const settings = path.join(home, "antigravity-acp", "settings.json");
    const original = fs.readFileSync(settings, "utf8");
    const key = "test-fixture-key";
    const childEnv = agyCredentialEnv({ GEMINI_API_KEY: "inherited" }, key);
    const agy = client(childEnv, { methodId: AGY_KEY_METHOD });
    await agy.start();
    await agy.newSession();
    expect(received().find(entry => entry.method === "authenticate").params).toEqual({ methodId: "gemini-api-key" });
    expect(received()).toContainEqual({ method: "keyPresent", params: { present: true, onlyInEnv: true } });
    expect(JSON.stringify(received())).not.toContain(key);
    expect(fs.readFileSync(settings, "utf8")).toBe(original);
  });

  it("classifies a key rejection delivered in live agent text", async () => {
    const agy = client({ ...agyCredentialEnv({}, "invalid-fixture-key"), FAKE_AGY_REFUSE_KEY: "1" }, { methodId: AGY_KEY_METHOD });
    await agy.start();
    await agy.newSession();
    const reject = vi.fn();
    agy.on("credentialRejected", reject);
    await agy.prompt("hello");
    expect(reject).toHaveBeenCalledOnce();
  });

  it("signals that interactive Google sign-in is needed without waiting for the redirect", async () => {
    const agy = client({ FAKE_AGY_SIGN_IN: "hang" });
    await expect(startAgyGoogleChat(agy)).rejects.toThrow("Antigravity authentication required.");
    expect(received().find(entry => entry.method === "authenticate").params).toEqual({ methodId: "oauth-personal" });
    expect(fs.existsSync(path.join(home, "antigravity-acp", "acp_token.json"))).toBe(false);
  });

  it("states the Google method on every start, whatever settings.json was left saying", async () => {
    signIn(home);
    fs.writeFileSync(path.join(home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "gemini-api-key" } }));
    const agy = client();
    await startAgyGoogleChat(agy);
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

  it("lists the project's conversations with the CLI", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    const { sessionId } = await agy.newSession();
    const listed = await agy.listSessions(cwd);
    expect(listed.sessions.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(listed.sessions[0].agyProgram).toBe("server");
  });
});
