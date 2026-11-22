import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpClient, type PermissionRequest } from "../src/acp";
import { AgyBackend, agyProfile, agySessionsFor, locateAgyCli } from "../src/agy-backend";
import { matchProviderSlashCommand } from "../src/slash-filter";
import { planTextFromPermissionToolCall } from "../src/plan-gate";

const CLI = path.join(__dirname, "fixtures", "fake-agy-cli.cjs");

describe("Antigravity CLI (real ACP transport)", () => {
  const clients: AcpClient[] = [];
  let home: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let sink: string;
  const received = () => fs.readFileSync(sink, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

  const client = (profile: "cli" | "server") => {
    const made = new AcpClient({ cliPath: CLI, cwd, backend: new AgyBackend({ profile }), log: () => {},
      env, timeouts: { requestTimeoutMs: 2000 } });
    clients.push(made);
    return made;
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpdir(), "agy-cli-test-"));
    cwd = path.join(home, "project");
    sink = path.join(home, "cli.jsonl");
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(home, "antigravity-acp"));
    fs.writeFileSync(path.join(home, "antigravity-acp", "acp_token.json"), "{}");
    fs.writeFileSync(sink, "");
    env = { ...process.env, GEMINI_HOME: home, FAKE_AGY_CLI_SINK: sink };
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(made => made.dispose()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("finds the Windows installer without using a shell", () => {
    const installed = "C:\\Local\\agy\\bin\\agy.exe";
    expect(locateAgyCli({ LOCALAPPDATA: "C:\\Local", PATH: "C:\\Tools" }, "win32", "C:\\Home", file => file === installed)).toBe(installed);
    expect(locateAgyCli({ PATH: "/tools" }, "linux", "/home/test", () => false)).toBeUndefined();
  });

  it("publishes CLI modes and commands and applies thought_level using the vendor IDs", async () => {
    const cli = client("cli");
    await cli.start();
    await cli.newSession();
    expect(cli.supportsInterject()).toBe(true);
    expect(cli.pickerModes).toEqual(["agent", "acceptEdits", "auto", "plan", "yolo"]);
    expect(cli.availableModels.map(model => model.modelId)).toEqual(["claude-sonnet-5-5", "gpt-oss-120b-medium"]);
    for (const mode of ["acceptEdits", "auto", "plan"]) {
      await cli.setMode(mode);
      expect(cli.currentModeId).toBe(mode);
    }
    const plan = vi.fn();
    const review = vi.fn((request: PermissionRequest) => cli.respondPermission(request.id, "deny"));
    cli.on("plan", plan);
    cli.on("permissionRequest", review);
    await cli.prompt("finish plan");
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ entries: [expect.objectContaining({ content: "Outline the work" })] }));
    expect(review).toHaveBeenCalledTimes(1);
    expect(planTextFromPermissionToolCall(review.mock.calls[0][0].toolCall)).toBe("Outline the work");
    expect(cli.currentModeId).toBe("plan");

    await expect(cli.setReasoningEffort("medium")).resolves.toBe(true);
    const calls = received().filter(r => r.method === "session/set_config_option").map(r => [r.params.configId, r.params.value]);
    expect(calls).toEqual([["mode", "accept-edits"], ["mode", "auto"], ["mode", "plan"], ["thought_level", "medium"]]);
    const commands = cli.availableCommands.map(command => command.name);
    expect(commands).toEqual(["goal", "compact", "plan"]);
    expect(matchProviderSlashCommand("agy", "/compact", commands, !!cli.pickerModes)).toBe("compact");
    const chunks = vi.fn();
    cli.on("messageChunk", chunks);
    await cli.prompt("/compact");
    expect(chunks).toHaveBeenCalledWith("CLI compact reply", undefined, undefined);
  });

  it("waits for the last steering response, suppresses live echoes and preserves the original turn on a refusal", async () => {
    const cli = client("cli");
    await cli.start();
    await cli.newSession();
    const complete = vi.fn();
    const echo = vi.fn();
    const chunks = vi.fn();
    cli.on("promptComplete", complete);
    cli.on("userMessageChunk", echo);
    cli.on("messageChunk", chunks);
    const first = cli.prompt("first");
    await vi.waitFor(() => expect(chunks).toHaveBeenCalledWith("started", undefined, undefined));
    await expect(cli.interject("reject steer")).resolves.toBe("failed");
    const steer = cli.interject("steer A");
    await vi.waitFor(() => expect(chunks).toHaveBeenCalledWith("steering pending", undefined, undefined));
    expect(complete).not.toHaveBeenCalled();
    const last = cli.interject("steer B");
    await expect(steer).resolves.toBe("ok");
    expect(complete).not.toHaveBeenCalled();
    await cli.cancel();
    await expect(last).resolves.toBe("ok");
    await first;
    expect(echo).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveBeenLastCalledWith("final output", undefined, undefined);
  });

  it("chooses the profile for key, Google, saved legacy metadata and both histories", async () => {
    const native = client("cli");
    const managed = client("server");
    await Promise.all([native.start(), managed.start()]);
    const [n, m] = await Promise.all([native.newSession(), managed.newSession()]);
    await native.setMode("acceptEdits");
    await native.dispose();
    const reopened = client("cli");
    await reopened.start();
    const legacy = client("server");
    await legacy.start();
    const rows = [...(await legacy.listSessions("")).sessions, ...(await reopened.listSessions("")).sessions];
    expect(agySessionsFor(rows, cwd).map(row => row.sessionId)).toEqual([m.sessionId, n.sessionId]);
    expect(agyProfile(undefined, undefined, false, env)).toBe("cli");
    expect(agyProfile(undefined, undefined, true, env)).toBe("server");
    expect(agyProfile("old-no-disk", "server", false, env)).toBe("server");
    expect(agyProfile(n.sessionId, undefined, true, env)).toBe("cli");
    expect(agyProfile(m.sessionId, undefined, false, env)).toBe("server");
    const replay = vi.fn();
    legacy.on("messageChunk", replay);
    await legacy.loadSession(m.sessionId);
    expect(replay).toHaveBeenCalledWith("previous conversation", undefined, undefined);
    await reopened.loadSession(n.sessionId);
    expect(reopened.currentModeId).toBe("acceptEdits");
    expect(received().filter(r => r.method === "session/list").map(r => r.params)).toEqual([{}, { cursor: "next" }, {}, { cursor: "next" }]);
  });
});
