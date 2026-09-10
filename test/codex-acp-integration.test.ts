import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { AcpClient, type PermissionRequest, type PromptContentBlock } from "../src/acp";
import { CodexBackend } from "../src/codex-backend";
import { warmCodexModelCache } from "../src/codex-model-cache";

function waitFor<T>(client: AcpClient, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    client.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

function caseDriftedCwd(cwd: string): string {
  const driveAdjusted = cwd.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  const parts = driveAdjusted.split(/([\\/]+)/);
  for (let index = parts.length - 1; index >= 0; index -= 2) {
    if (!parts[index] || /^[A-Z]:$/.test(parts[index])) continue;
    parts[index] = parts[index].toUpperCase();
    break;
  }
  return parts.join("");
}

describe("Codex ACP integration (real subprocess, fake adapter)", () => {
  let client: AcpClient;
  let codexHome: string;

  beforeEach(async () => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-test-"));
    client = new AcpClient({
      cliPath: "C:\\Tools\\codex.exe",
      cwd: process.cwd(),
      backend: new CodexBackend({ adapterPath: path.join(__dirname, "fixtures", "fake-codex-acp.cjs") }),
      env: { ...process.env, CODEX_HOME: codexHome, FAKE_CODEX_STEERING: "true", FAKE_CODEX_STEERING_SINK: path.join(codexHome, "events.jsonl") },
      log: () => {},
    });
    await client.start();
  });

  afterEach(async () => {
    client.removeAllListeners();
    await client.dispose();
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("runs the lifecycle and normalizes models plus config-option responses", async () => {
    await client.newSession();
    expect(client.provider).toBe("codex");
    expect(client.usesClientPlanGate).toBe(false);
    expect(client.currentModelId).toBe("gpt-5.6-sol");
    expect(client.currentReasoningEffort).toBe("high");
    expect(client.availableModels).toHaveLength(2);
    expect(client.availableModels[0].reasoningEfforts).toEqual(["low", "high", "ultra"]);

    await client.setModel("gpt-5.6-terra");
    expect(client.currentModelId).toBe("gpt-5.6-terra");
    await expect(client.setReasoningEffort("max")).resolves.toBe(true);
    expect(client.currentReasoningEffort).toBe("max");
    const modes: string[] = [];
    client.on("modeChanged", (mode) => modes.push(mode));
    await client.setMode("plan");
    expect(client.currentModeId).toBe("plan");
    expect(modes).toContain("plan");
    await client.setMode("default");
    await client.setMode("agent-full-access");
    expect(client.currentModeId).toBe("agent-full-access");
    expect(modes).toContain("agent-full-access");
  });

  it("steers text and images while the prompt and its tool remain in flight", async () => {
    await client.newSession();
    const normalize = vi.spyOn((client as any).backend, "normalizePromptResult");
    expect(client.supportsInterject()).toBe(true);
    expect(client.honorsInterjectContent()).toBe(true);
    const permissionP = waitFor<PermissionRequest>(client, "permissionRequest");
    let completed = false;
    const promptP = client.prompt("SCENARIO_STEERING").then((meta) => { completed = true; return meta; });
    const permission = await permissionP;
    const content: PromptContentBlock[] = [
      { type: "text", text: "use [Image #1]" },
      { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
    ];
    let accepted = 0;
    await expect(client.interject("correct course", () => { accepted += 1; })).resolves.toBe("ok");
    await expect(client.interject("use this", () => { accepted += 1; }, content)).resolves.toBe("ok");
    expect(accepted).toBe(2);
    expect(completed).toBe(false);
    const events = fs.readFileSync(path.join(codexHome, "events.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "session/prompt")).toHaveLength(1);
    expect(events.filter((event) => event.type === "_session/steering").map((event) => event.prompt)).toEqual([
      [{ type: "text", text: "correct course" }], content,
    ]);
    const toolP = waitFor<any>(client, "toolCallUpdate");
    client.respondPermission(permission.id, "allow_once");
    expect(await toolP).toMatchObject({ toolCallId: "in-flight", status: "completed" });
    await promptP;
    expect(normalize).toHaveBeenCalledWith({ stopReason: "end_turn" });
  });

  it.each(["absent", "false"])("leaves steering unavailable when initialize reports %s", async (capability) => {
    await client.dispose();
    client = new AcpClient({
      cliPath: "codex", cwd: process.cwd(), log: () => {},
      backend: new CodexBackend({ adapterPath: path.join(__dirname, "fixtures", "fake-codex-acp.cjs") }),
      env: { ...process.env, CODEX_HOME: codexHome, FAKE_CODEX_STEERING: capability },
    });
    let supportedAtInitialize: boolean | undefined;
    client.once("initialized", () => { supportedAtInitialize = client.supportsInterject(); });
    await client.start();
    await client.newSession();
    expect(supportedAtInitialize).toBe(false);
    expect(client.honorsInterjectContent()).toBe(false);
    await expect(client.interject("keep this for the queue")).resolves.toBe("unsupported");
  });

  it("normalizes streamed tools, usage, title, permissions, plan review, and prompt usage", async () => {
    await client.newSession();
    const titles: string[] = [];
    const contexts: number[] = [];
    const tools: any[] = [];
    const updates: any[] = [];
    const permissions: any[] = [];
    client.on("sessionTitle", (title) => titles.push(title));
    client.on("contextUsage", (used) => contexts.push(used));
    client.on("toolCall", (tool) => tools.push(tool));
    client.on("toolCallUpdate", (update) => updates.push(update));
    client.on("permissionRequest", (request) => {
      permissions.push(request);
      client.respondPermission(request.id, request.toolCall.kind === "switch_mode" ? "revise_plan" : "allow_once");
    });

    const meta = await client.prompt("exercise codex wire shapes");
    expect(titles).toEqual(["Generated Codex title"]);
    expect(contexts).toEqual([undefined]);
    expect(client.availableModels.find((model) => model.modelId === client.currentModelId)?.totalContextTokens).toBe(258400);
    expect(tools.find((tool) => tool.toolCallId === "edit-1").content[0].oldText).toBe("");
    expect(tools.find((tool) => tool.toolCallId === "mcp-1")).toMatchObject({
      kind: "other",
      title: "mcp.canva.search-designs",
      rawInput: { server: "canva", tool: "search-designs" },
    });
    expect(updates.find((update) => update.toolCallId === "cmd-1").rawOutput).toMatchObject({ output: "ok\n", exit_code: 0 });
    expect(permissions[0].toolCall.title).toBe("npm test");
    expect(permissions[0].options.map((option: any) => option.optionId)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(permissions[0]._meta).toEqual({ codex: { kind: "approval" } });
    expect(permissions[1]).toMatchObject({
      toolCall: { kind: "switch_mode", title: "Implement this plan?", rawInput: { plan: "# Plan\n\n1. Change it" } },
      _meta: { codex: { kind: "plan_review" } },
    });
    expect(meta).toMatchObject({
      totalTokens: 80,
      reasoningTokens: 10,
      usage: { inputTokens: 60, outputTokens: 30, cachedReadTokens: 20, totalTokens: 100, reasoningTokens: 10 },
    });
    expect(meta.usage?.costUsdTicks).toBeUndefined();
  });

  it("lists all pages once when the adapter changes the drive and path-segment casing", async () => {
    await client.newSession();
    await expect(client.listSessions(process.cwd(), "win32")).resolves.toEqual({
      sessions: [
        { sessionId: "0198f0d1-2b3c-7d4e-8f50-123456789abc", cwd: process.cwd(), title: undefined },
        { sessionId: "listed-1", cwd: caseDriftedCwd(process.cwd()), title: "First", updatedAt: 10 },
        { sessionId: "refuse-delete", cwd: caseDriftedCwd(process.cwd()), title: "Refused delete", updatedAt: 9.5 },
        { sessionId: "listed-2", cwd: caseDriftedCwd(process.cwd()), title: "Second", updatedAt: 8 },
      ],
      nextCursor: null,
    });
  });

  it("deletes through the adapter and surfaces a refusal", async () => {
    await expect(client.deleteSession("listed-1")).resolves.toBeUndefined();
    await expect(client.deleteSession("refuse-delete")).rejects.toMatchObject({
      code: -32000,
      message: "delete refused",
    });
  });

  it("cancels with at most trailing updates and emits nothing after the cancelled prompt response", async () => {
    await client.newSession();
    const chunks: string[] = [];
    client.on("messageChunk", (text) => chunks.push(text));
    const prompt = client.prompt("SCENARIO_CANCEL");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.cancel("test");
    const meta = await prompt;
    const countAtResponse = chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(meta.totalTokens).toBe(1);
    expect(chunks).toEqual(["started", "trailing"]);
    expect(chunks).toHaveLength(countAtResponse);
  });

  it("classifies an auth-shaped adapter failure and emits the distinct credential event", async () => {
    await client.newSession();
    const event = waitFor<any>(client, "credentialError");
    await expect(client.prompt("SCENARIO_AUTH")).rejects.toMatchObject({ code: -32000 });
    await expect(event).resolves.toMatchObject({ message: expect.stringMatching(/Authentication required/) });
  });

  it("routes the captured Codex image-generation tool shape into generated media", async () => {
    await client.newSession();
    const media = waitFor<any>(client, "mediaContent");
    await client.prompt("SCENARIO_IMAGE_GENERATION");
    const artifact = path.join(
      codexHome,
      "generated_images",
      "0198f0d1-2b3c-7d4e-8f50-123456789abc",
      "exec-550e8400-e29b-41d4-a716-446655440000.png",
    );
    await expect(media).resolves.toEqual({
      media: "image",
      kind: "path",
      path: artifact,
      mimeType: "image/png",
    });
    expect(fs.existsSync(artifact)).toBe(true);
  });

  it("surfaces load replay updates before session/load resolves", async () => {
    const chunks: string[] = [];
    client.on("messageChunk", (text) => chunks.push(text));
    const loaded = waitFor(client, "sessionLoaded");
    await client.loadSession("saved-1");
    await loaded;
    expect(chunks).toEqual(["restored answer"]);
  });

  it("warms models in a scratch session, deletes it, and removes the scratch cwd", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-warm-test-"));
    const logs: string[] = [];
    let captured: { ids: string[]; current?: string } | undefined;
    try {
      await warmCodexModelCache({
        cliPath: "C:\\Tools\\codex.exe",
        tempRoot,
        backend: { adapterPath: path.join(__dirname, "fixtures", "fake-codex-acp.cjs") },
        log: (message) => logs.push(message),
        onModels: (models, current) => {
          captured = { ids: models.map((model) => model.modelId), current };
        },
      });
      expect(captured).toEqual({
        ids: ["gpt-5.6-sol", "gpt-5.6-terra"],
        current: "gpt-5.6-sol",
      });
    expect(logs.some((line) => line.includes("DELETE:0198f0d1-2b3c-7d4e-8f50-123456789abc"))).toBe(true);
      expect(fs.readdirSync(tempRoot)).toEqual([]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
