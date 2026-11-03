import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpClient, type PermissionRequest } from "../src/acp";
import { DeepSeekBackend, deepseekModelName, normalizeDeepSeekSession } from "../src/deepseek-backend";
import { deepseekRuntimePaths } from "../src/deepseek-managed-installer";
import { supportsCompaction } from "../src/acp-backend";
import { DEEPSEEK_GOAL_COMMANDS } from "../src/deepseek-commands";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

describe("DeepSeek official ACP contract (fake subprocess only)", () => {
  it("cleans catalog labels and preserves supplied release tags, descriptions and opaque values", () => {
    const value = '["deepseek-official","model-id-must-stay-opaque"]';
    const normalized = normalizeDeepSeekSession({ configOptions: [{ id: "model", currentValue: value,
      options: [{ name: "DeepSeek", options: [{ value, name: "DeepSeek-V4.1-Flash-1017", description: "Catalog description" }] }] }] });
    expect(normalized.models.availableModels[0]).toMatchObject({ modelId: value, name: "DeepSeek V4.1 Flash 1017", description: "Catalog description" });
    expect(normalized.models.currentModelId).toBe(value);
  });
  it("adds dsh's own 1017 badge only under dsh's condition", () => {
    const flash = JSON.stringify(["deepseek-official", "deepseek-flash"]);
    expect(deepseekModelName("DeepSeek-V4.1-Flash", flash)).toBe("DeepSeek V4.1 Flash 1017");
    expect(deepseekModelName("DeepSeek-V4.1-Flash", JSON.stringify(["deepseek-account", "deepseek-flash"]))).toBe("DeepSeek V4.1 Flash 1017");
    expect(deepseekModelName("DeepSeek-V4.1-Flash", JSON.stringify(["someone-else", "deepseek-flash"]))).toBe("DeepSeek V4.1 Flash");
    expect(deepseekModelName("DeepSeek-V4.2-Flash", flash)).toBe("DeepSeek V4.2 Flash");
    expect(deepseekModelName("deepseek-v4-flash", JSON.stringify(["deepseek-official", "deepseek-v4-flash"]))).toBe("DeepSeek V4 Flash");
    expect(deepseekModelName("DeepSeek-V4.1-Flash", "not json")).toBe("DeepSeek V4.1 Flash");
  });
  let root: string;
  const clients: AcpClient[] = [];
  const sink = () => path.join(root, "requests.jsonl");
  const received = () => fs.readFileSync(sink(), "utf8").trim().split(/\r?\n/).map(v => JSON.parse(v));
  function make(harness: "default" | "minimal" = "default", key = "") {
    const client = new AcpClient({ cliPath: root, cwd: root,
      backend: new DeepSeekBackend({ storageRoot: root, harness, nodePath: process.execPath }),
      env: { ...process.env, DSH_AGENTS_HOME: path.join(root, "agents"), FAKE_DSH_SINK: sink(), DEEPSEEK_API_KEY: key }, log: () => {},
      timeouts: { requestTimeoutMs: 5000, promptIdleTimeoutMs: 5000 },
    });
    clients.push(client); return client;
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-fake-"));
    const cli = deepseekRuntimePaths(root).cli;
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "fixtures/fake-deepseek-acp.cjs"), cli);
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.dispose()));
    fs.rmSync(root, { force: true, recursive: true });
  });
  it.each(["default", "minimal"] as const)("keyless %s handshake/new, opaque model and live effort", async harness => {
    const client = make(harness); await client.start(); await client.newSession();
    expect(received()[0].params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(received().find(v => v.method === "session/new").params.mcpServers).toEqual([]);
    expect(client.availableModels).toHaveLength(1);
    expect(client.availableModels[0]).toMatchObject({ name: "DeepSeek V4 Flash", totalContextTokens: 1000000 });
    expect(client.currentModelId).toBe('["deepseek-official","deepseek-v4-flash"]');
    await expect(client.setModel('["deepseek-official","deepseek-v4-pro"]')).rejects.toThrow();
    await client.setReasoningEffort("max");
    expect(client.currentModelId).toContain("flash"); expect(client.currentReasoningEffort).toBe("max");
    expect(received().some(v => v.method === "authenticate")).toBe(false);
  });
  it("lists id/cwd only and resumes with no transcript or session/load", async () => {
    const first = make(); await first.start(); const { sessionId } = await first.newSession();
    // The host already knows the live conversation; dsh excludes it from list.
    const liveList = await (first as any).request("session/list", { cwd: root });
    expect(liveList.sessions).toEqual([]);
    expect((await first.listSessions()).sessions[0].sessionId).toBe(sessionId);
    await first.dispose();
    const next = make(); const messages: string[] = []; next.on("messageChunk", v => messages.push(v));
    await next.start();
    expect((await next.listSessions(root, process.platform)).sessions).toEqual([{ sessionId, cwd: root, deepseekHarness: "default" }]);
    await next.loadSession(sessionId);
    expect(messages).toEqual([]);
    expect(received().some(v => v.method === "session/load")).toBe(false);
    expect((await make("minimal").start())).toBeUndefined();
  });
  it("keeps keyed model names and opaque values, four efforts, shell frames and the 1M window", async () => {
    const client = make("minimal", "fake-key");
    const init: any[] = [], calls: any[] = [], usage: any[] = [];
    client.on("initialized", v => init.push(v));
    client.on("toolCall", v => calls.push(v));
    client.on("contextUsage", (used, window) => usage.push({ used, window }));
    await client.start(); await client.newSession();
    expect(init[0]).toMatchObject({ authMethods: [], agentCapabilities: { promptCapabilities: { image: false } } });
    expect(client.availableModels.map(m => m.name)).toEqual(["DeepSeek V4 Flash", "DeepSeek V4.1 Flash 1017", "DeepSeek V4 Pro"]);
    const value = '["deepseek-official","deepseek-flash"]';
    await client.setModel(value);
    expect(client.currentModelId).toBe(value);
    expect(received().find(v => v.method === "session/set_config_option").params.value).toBe(value);
    for (const effort of ["off", "low", "high", "max"]) await client.setReasoningEffort(effort);
    await client.prompt("shell");
    expect(calls[0]).toMatchObject({ title: "pwsh", kind: "other", rawInput: { command: "echo 42" } });
    expect(usage.at(-1)).toMatchObject({ used: 123, window: 1000000 });
    const before = received().filter(v => v.method === "session/prompt").length;
    await expect(client.prompt([{ type: "image", mimeType: "image/png", data: "AA==" }])).rejects.toThrow("image attachments");
    expect(received().filter(v => v.method === "session/prompt")).toHaveLength(before);
  });
  it("Stop settles the turn, then another prompt works; permissions are one-shot", async () => {
    const client = make(); await client.start(); await client.newSession();
    let permission: PermissionRequest | undefined;
    client.on("permissionRequest", p => { permission = p; client.respondPermission(p.id, "allow-once"); });
    await client.prompt("permission");
    expect(permission!.options.map(o => o.kind)).toEqual(["allow_once", "reject_once"]);
    const turn = client.prompt("long");
    // Wait for admission at the fake, avoiding a race between writes.
    while (!received().some(v => v.method === "session/prompt" && v.params.prompt[0].text === "long")) await new Promise(r => setTimeout(r, 10));
    await client.cancel(); await turn;
    expect(received().some(v => v.method === "session/cancel")).toBe(true);
    const chunks: string[] = []; client.on("messageChunk", v => chunks.push(v));
    await client.prompt("next"); expect(chunks).toEqual(["done"]);
  });
  it("authenticate is no proof and a rejected key is scoped to DeepSeek", async () => {
    const client = make("default", "rejected"); await client.start(); await client.newSession();
    await expect((client as any).request("authenticate", { methodId: "anything" })).resolves.toEqual({});
    const error = await client.prompt("hello").catch(e => e);
    expect(client.isCredentialError(error)).toBe(true);
    expect(error.message).toContain("Internal error");
  });
  it.each(["default", "minimal"] as const)("offers only supported instruction shortcuts, without claiming native compaction in %s", async harness => {
    const client = make(harness);
    await client.start(); await client.newSession();
    expect(client.availableCommands).toEqual(harness === "default" ? DEEPSEEK_GOAL_COMMANDS : []);
    expect(supportsCompaction(client.provider)).toBe(false);
    const chunks: string[] = [], occupancy: number[] = [];
    client.on("messageChunk", text => chunks.push(text));
    client.on("contextUsage", used => occupancy.push(used));
    await client.prompt("hello");
    const before = occupancy.at(-1);
    chunks.length = 0;
    await client.prompt("/compact");
    expect(received().at(-1).params.prompt).toEqual([{ type: "text", text: "/compact" }]);
    expect(chunks).toEqual(["done"]); // Ordinary prompt; no command execution in the fake bridge.
    expect(occupancy.at(-1)).toBe(before);
  });
  it("advertises and refreshes skills through commandsUpdate on new, send and resume", async () => {
    const client = make(), updates: any[] = [];
    client.on("commandsUpdate", commands => updates.push(commands));
    await client.start(); const { sessionId } = await client.newSession();
    expect(updates.at(-1)).toEqual(DEEPSEEK_GOAL_COMMANDS);
    const file = path.join(root, ".agents/skills/review.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nname: review\ndescription: Review this code\n---\nInstructions");
    const blocks = [{ type: "text" as const, text: "Please /review this patch" }];
    await client.prompt(blocks);
    expect(blocks[0].text).toBe("Please /review this patch");
    expect(updates.at(-1).at(-1)).toMatchObject({ name: "review", description: "Review this code", _meta: { path: fs.realpathSync(file), scope: "project-agents" } });
    expect(received().at(-1).params.prompt[0].text).toBe("Please Use the `review` skill: load it with the skill tool and follow it. this patch");
    fs.unlinkSync(file);
    await client.refreshCommands(); // Warm conversation reopen uses this same method.
    expect(client.availableCommands).toEqual(DEEPSEEK_GOAL_COMMANDS);
    await client.dispose();
    fs.writeFileSync(file, "---\nname: replacement\ndescription: New skill\n---\nInstructions");
    const next = make(); await next.start(); await next.loadSession(sessionId);
    expect(next.availableCommands.at(-1)?.name).toBe("replacement");
  });
  it("rewrites goals at the transport boundary, preserving blocks and excluding attached context from the objective", async () => {
    const client = make(); await client.start(); await client.newSession();
    const typed = "/goal fix the build";
    const text = typed + "\n\n<attached_context>\nAttached file: build.ts\n</attached_context>";
    const blocks = [{ type: "text" as const, text }];
    await client.prompt(blocks, [typed]);
    expect(blocks).toEqual([{ type: "text", text }]);
    expect(received().at(-1).params.prompt[0].text).toBe("Set a session goal with create_goal. Objective: fix the build. Then start working on it.\n\n<attached_context>\nAttached file: build.ts\n</attached_context>");
    await client.prompt("/goal \n");
    expect(received().at(-1).params.prompt[0].text).toContain("Ask me what its objective should be");
    for (const [command, action] of [["goal-pause", "pause"], ["goal-resume", "resume"], ["goal-done", "complete"]]) {
      await client.prompt("/" + command);
      expect(received().at(-1).params.prompt[0].text).toContain(`update_goal using those values and action "${action}"`);
    }
  });
  it("rewrites authored skills but leaves file snippets and queued goal-like prose intact", async () => {
    const file = path.join(root, ".agents/skills/review.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nname: review\ndescription: Review\n---\nInstructions");
    const client = make(); await client.start(); await client.newSession();
    const snippet = "```md\n/review file example\n```\n\n";
    await client.prompt([{ type: "text", text: snippet + "Please /review patch\n\n/goal later" }], ["Please /review patch", "/goal later"]);
    expect(received().at(-1).params.prompt[0].text).toBe(snippet + "Please Use the `review` skill: load it with the skill tool and follow it. patch\n\n/goal later");
  });
  it("retains the typed host userMessage and title while only the expanded instruction reaches dsh", async () => {
    const client = make(); await client.start(); await client.newSession();
    const sidebar: any = Object.create(GrokSidebar.prototype);
    const session = new Session();
    session.provider = "deepseek"; session.client = client; session.activeSessionId = client.sessionId;
    sidebar.focused = session; sidebar.pendingAttach = new Set();
    sidebar.sessionCwd = () => root;
    sidebar.modelsForSession = () => [];
    sidebar.setStatus = (_session: Session, status: Session["status"]) => { session.status = status; };
    for (const method of ["waitForSessionStart", "retainUploadedFilesForSession", "rememberProjectProvider",
      "refreshImplicitChip", "postChips", "reportSessionStart", "reportRemoteMessage", "startTurnDiffBaseline",
      "noteSessionActivity", "maybeAskToAddProject", "noteLiveTurnEnded", "setProviderNeedsLogin",
      "maybeGenerateTitle", "postSessionName", "mirrorToProjectsRail", "sendRemoteSession"]) sidebar[method] = vi.fn();
    const typed = "/goal fix the build";
    await sidebar.handleSend(typed, false, session, "remote");
    expect(received().at(-1).params.prompt[0].text).toBe("Set a session goal with create_goal. Objective: fix the build. Then start working on it.");
    const bubbles = session.buffer.filter(message => message.type === "userMessage");
    expect(bubbles).toEqual([expect.objectContaining({ text: typed })]);
    expect(session.firstUserMessageForTitle).toBe(typed);
    expect(sidebar.sendRemoteSession).toHaveBeenCalledWith(session, expect.objectContaining({ type: "userMessage", text: typed }));
    // Warm replay and reconnect snapshots use this same buffer, not the ACP payload.
    expect(JSON.stringify(session.buffer)).not.toContain("Set a session goal with create_goal");
  });
});
