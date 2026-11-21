import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { makeExplicitChip } from "../src/chips";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";
import { MuseBackend } from "../src/muse-backend";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { beginTurn, Session } from "../src/session";
import { INTERNAL_PROVIDERS, supportsFork } from "../src/acp-backend";
import { ForkPoints } from "../src/fork-points";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { allowFromRemote, remoteRequiresBoundSession } from "../src/remote-policy";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

function hostWith(session: Session) {
  const host: any = Object.create(GrokSidebar.prototype);
  host.pool = new Set([session]);
  host.focused = session;
  host.reportRequester = vi.fn();
  host.sessionCwd = () => "/work/repo";
  host.sessionDisplayName = () => "Parent";
  host.workspaceRoot = host.sessionCwd;
  host.host = { appendLine: vi.fn() };
  host.postLocal = vi.fn();
  host.sessionMetaWrites = Promise.resolve();
  host.sessionCache = new Map();
  host.remoteClients = new RemoteClientState<Session>("/work/repo");
  host.remoteClients.ready("phone");
  host.remoteClients.setActive("phone", session);
  host.pendingConfirms = new Map();
  return host;
}

function startedSession(provider: Session["provider"]) {
  const session = new Session();
  session.provider = provider;
  session.activeSessionId = `${provider}-1`;
  session.hasHistory = true;
  session.client = { sessionId: session.activeSessionId, forkSession: vi.fn(async () => "unsupported" as const) } as any;
  return session;
}

it("implements forks on the four supported providers", () => {
  expect(INTERNAL_PROVIDERS.filter((provider) => supportsFork(provider))).toEqual(["grok", "codex", "claude", "muse"]);
});

it.each(INTERNAL_PROVIDERS.filter((provider) => provider !== "grok"))(
  "refuses a fork on %s without asking the agent",
  async (provider) => {
    const session = startedSession(provider);
    const host = hostWith(session);
    const requester = { clientId: "phone" };
    await host.forkFocusedSession(session, requester);
    expect((session.client as any).forkSession).not.toHaveBeenCalled();
    expect(host.reportRequester).toHaveBeenCalledWith(
      requester,
      "info",
      expect.stringMatching(/^(Codex|Claude|Muse Code|Antigravity|DeepSeek) can't continue a conversation in a new chat yet\.$/),
    );
  },
);

it("still asks Grok's CLI, and names a Grok update only there", async () => {
  const session = startedSession("grok");
  const host = hostWith(session);
  await host.forkFocusedSession(session, undefined);
  expect((session.client as any).forkSession).toHaveBeenCalledWith("/work/repo");
  expect(host.reportRequester).toHaveBeenCalledWith(undefined, "warning", expect.stringContaining("newer Grok Build CLI"));
});

function fakeAdapter(fork: unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const write = (frame: object) => stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  const requests: { method: string; params: any }[] = [];
  stdin.on("data", (bytes) => {
    const { id, method, params } = JSON.parse(String(bytes));
    requests.push({ method, params });
    if (method === "initialize") write({ id, result: { agentCapabilities: { sessionCapabilities: { fork } } } });
    else if (params._meta?.jetbrains.air.fork.messageId === "gone") {
      write({ id, error: { code: -32602, message: "Fork point was not found" } });
    } else if (method === "_x.ai/session/fork") write({ id, result: { newSessionId: "child" } });
    else write({ id, result: { sessionId: "child" } });
  });
  stdin.on("finish", () => { process.emit("exit", 0); process.emit("close", 0); });
  vi.mocked(spawn).mockReturnValueOnce(process as any);
  const reply = (messageId: string) => write({
    method: "session/update",
    params: { sessionId: "parent", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: "Answer" } } },
  });
  return { requests, reply };
}

it.each([ClaudeBackend, CodexBackend, MuseBackend])("%p negotiates, preserves reply IDs and forks on the ACP wire", async (Backend) => {
  const adapter = fakeAdapter({});
  const client = new AcpClient({ cliPath: "unused", cwd: "/work/repo", backend: new Backend({ adapterPath: "fake.cjs" }), log() {} });
  try {
    expect(client.supportsTurnFork()).toBe(false);
    await client.start();
    client.sessionId = "parent";
    expect(client.supportsTurnFork()).toBe(true);
    const chunk = vi.fn();
    client.on("messageChunk", chunk);
    adapter.reply("last");
    expect(chunk).toHaveBeenCalledWith("Answer", undefined, "last");

    await expect(client.forkSession("/work/repo")).resolves.toEqual({ newSessionId: "child" });
    await expect(client.forkSession("/work/repo", "last")).resolves.toEqual({ newSessionId: "child" });
    await expect(client.forkSession("/work/repo", "gone")).rejects.toMatchObject({ code: -32602 });
    const base = { sessionId: "parent", cwd: "/work/repo", mcpServers: [] };
    expect(adapter.requests.slice(1)).toEqual([
      { method: "session/fork", params: base },
      { method: "session/fork", params: { ...base, _meta: { jetbrains: { air: { fork: { version: 1, messageId: "last" } } } } } },
      { method: "session/fork", params: { ...base, _meta: { jetbrains: { air: { fork: { version: 1, messageId: "gone" } } } } } },
    ]);
  } finally { await client.dispose(); }
});

it.each([undefined, null, false, []])("refuses an unadvertised or malformed capability (%j)", async (advertised) => {
  const adapter = fakeAdapter(advertised);
  const backend = new ClaudeBackend({ adapterPath: "fake.cjs" });
  const client = new AcpClient({ cliPath: "unused", cwd: "/work/repo", backend, log() {} });
  try {
    await client.start();
    client.sessionId = "parent";
    expect(client.supportsTurnFork()).toBe(false);
    await expect(client.forkSession("/work/repo")).resolves.toBe("unsupported");
    expect(adapter.requests.map((r) => r.method)).toEqual(["initialize"]);
  } finally { await client.dispose(); }
});

it("keeps Grok on its whole-session RPC without an advertisement", async () => {
  const adapter = fakeAdapter({});
  const client = new AcpClient({ cliPath: "fake", cwd: "/work/repo", log() {} });
  try {
    await client.start();
    client.sessionId = "parent";
    expect(client.supportsTurnFork()).toBe(false);
    await expect(client.forkSession("/work/repo")).resolves.toEqual({ newSessionId: "child" });
    expect(adapter.requests.slice(1)).toEqual([{
      method: "_x.ai/session/fork",
      params: { sourceSessionId: "parent", sourceCwd: "/work/repo", newCwd: "/work/repo" },
    }]);
  } finally { await client.dispose(0); }
});

it("tracks only settled last replies across replay, a steer, missing IDs and compaction", () => {
  const points = new ForkPoints();
  expect(points.startPrompt()).toBeUndefined();
  points.reply("opening", false);
  points.interrupt(); // tools run
  points.reply("first-end", false);
  expect(points.settle(true)).toBe("first-end");
  expect(points.startPrompt()).toBe("first-end");
  points.reply("before-steer", false);
  points.reply("second-end", false); // same host turn
  expect(points.settle(true)).toBe("second-end");
  expect([...points.observed]).toEqual(["first-end", "second-end"]);

  points.load([...points.observed]);
  expect(points.replayUser("first-prompt")).toEqual({ startsMessage: true });
  expect(points.reply("opening", true)).toBeUndefined();
  expect(points.reply("first-end", true)).toBe("first-end");
  expect(points.replayUser("second-prompt")).toEqual({ startsMessage: true, forkBefore: "first-end" });
  expect(points.replayUser("second-prompt")).toEqual({});
  expect(points.reply("before-steer", true)).toBeUndefined();
  expect(points.replayUser("steer")).toEqual({ startsMessage: true });
  expect(points.reply("second-end", true)).toBe("second-end");
  expect(points.startPrompt()).toBe("second-end");
  points.reply("cancelled", false);
  expect(points.settle(false)).toBeUndefined();
  points.reply(undefined, false);
  expect(points.settle(true)).toBeUndefined();
  expect(points.compact()).toBe(true);
  expect([...points.observed]).toEqual([]);
});

it("cannot infer a point from a reopened transcript with no recorded ends", () => {
  const points = new ForkPoints();
  points.load([]);
  expect(points.reply("older-reply", true)).toBeUndefined();
  expect(points.replayUser("next-prompt")).toEqual({ startsMessage: true });
  expect(points.startPrompt()).toBeUndefined();
});

it("rejects unknown points, a running turn, pending review and the wrong session before calling the adapter", async () => {
  const session = startedSession("codex");
  const host = hostWith(session);
  const client = Object.assign(session.client!, { supportsTurnFork: () => true });
  const point = { type: "forkAtReply", sessionId: session.activeSessionId!, messageId: "other" };
  await host.onMessage(point, "local");
  expect(host.reportRequester).toHaveBeenLastCalledWith(undefined, "warning", "This reply is no longer available as a fork point.");
  session.pendingPermissions.set(1, { toolKind: "plan_review" } as any);
  await host.onMessage(point, "local");
  expect(host.reportRequester).toHaveBeenLastCalledWith(undefined, "warning", "Wait for the current turn to finish before continuing in a new chat.");
  session.pendingPermissions.clear();
  session.suppressContent = true;
  await host.onMessage({ type: "forkSession" }, "local");
  expect(host.reportRequester).toHaveBeenLastCalledWith(undefined, "warning", "Wait for the current turn to finish before continuing in a new chat.");
  session.suppressContent = false;
  beginTurn(session);
  await host.onMessage({ type: "forkSession" }, "local");
  expect(host.reportRequester).toHaveBeenLastCalledWith(undefined, "warning", "Wait for the current turn to finish before continuing in a new chat.");
  await host.onMessage({ ...point, sessionId: "another" }, "local");
  expect(host.postLocal).toHaveBeenCalledWith(expect.objectContaining({ type: "hostNotice" }));
  expect(client.forkSession).not.toHaveBeenCalled();
});

it.each(["local", "remote"])("opens the adapter fork and stores only the edit text for %s", async (origin) => {
  const provider = origin === "local" ? "claude" : "codex";
  const session = startedSession(provider);
  session.worktree = { path: "/work/repo", label: "isolated", sourceGitRoot: "/work/root" };
  const host = hostWith(session);
  const client = Object.assign(session.client!, {
    supportsTurnFork: () => true,
    forkSession: vi.fn(async () => ({ newSessionId: "child" })),
    dispose: vi.fn(async () => {}),
    setHumanWaitActive: vi.fn(),
  });
  host.post = vi.fn();
  host.dotForId = () => undefined;
  host.openSession = vi.fn();
  host.openRemoteSession = vi.fn();
  const parentId = session.activeSessionId!;
  let overrides: Record<string, any> = { [parentId]: {
    uploadedFiles: ["file"], contextUsed: 200, contextWindow: 1000,
    ...(provider === "codex" ? { codexAskApproval: true } : {}),
  } };
  host.state = {
    get: () => overrides,
    update: async (_key: string, value: typeof overrides) => { overrides = value; },
  };
  const parent = overrides[parentId];
  session.forkPoints.reply("first", false);
  session.forkPoints.settle(true);
  session.forkPoints.startPrompt();
  session.forkPoints.reply("second", false);
  session.forkPoints.settle(true);
  const draft = "The prompt to revise";
  await host.onMessage({ type: "forkAtReply", sessionId: parentId, messageId: "first", draft }, origin,
    origin === "remote" ? "phone" : undefined);
  expect(client.forkSession).toHaveBeenCalledTimes(1);
  expect(client.forkSession).toHaveBeenCalledWith("/work/repo", "first");
  if (origin === "remote") expect(host.openRemoteSession).toHaveBeenCalledWith("phone", "child", "/work/repo");
  else expect(host.openSession).toHaveBeenCalledWith("child", "/work/repo");
  expect(overrides[parentId]).toBe(parent);
  expect(overrides.child).toMatchObject({
    provider, providerCwd: "/work/repo", customName: "(Fork) Parent",
    forkReplyIds: ["first"], queuedDraft: draft, worktreePath: "/work/repo", uploadedFiles: ["file"], contextWindow: 1000,
  });
  expect(overrides.child.contextUsed).toBeUndefined();
  expect(overrides.child.codexAskApproval).toBe(parent.codexAskApproval);
  expect(overrides.child.queuedDraftChips).toBeUndefined();
  expect(host.reportRequester).toHaveBeenLastCalledWith(
    origin === "remote" ? expect.objectContaining({ clientId: "phone" }) : undefined, "info",
    expect.stringContaining("Files on disk were not touched. Attachments stay with the original message."),
  );
});

it("leaves a refused Muse edit on the original conversation", async () => {
  const session = startedSession("muse");
  const host = hostWith(session);
  const draft = "keep this prompt";
  const parent = session.activeSessionId;
  const client = Object.assign(session.client!, {
    supportsTurnFork: () => true,
    forkSession: vi.fn(async () => { throw { code: -32602 }; }),
  });
  host.openSession = vi.fn();
  host.updateSessionMeta = vi.fn();
  session.forkPoints.reply("first", false);
  session.forkPoints.settle(true);
  await host.onMessage({ type: "forkAtReply", sessionId: parent, messageId: "first", draft }, "local");
  expect(client.forkSession).toHaveBeenCalledWith("/work/repo", "first");
  expect(host.focused).toBe(session);
  expect(session.activeSessionId).toBe(parent);
  expect(host.openSession).not.toHaveBeenCalled();
  expect(host.updateSessionMeta).not.toHaveBeenCalled();
  expect(host.reportRequester).toHaveBeenLastCalledWith(undefined, "warning", "This reply is no longer available as a fork point.");
});

// Codex keeps a conversation its process opened locked to that process, a
// fork's copy included ("already has an active writer"), and only the process
// exiting lifts it at once. The new chat opens the copy in a fresh process.
it.each(["codex", "claude", "muse"] as const)("lets go of the original's process before opening a %s copy only where the adapter locks it", async (provider) => {
  const session = startedSession(provider);
  const host = hostWith(session);
  host.post = vi.fn();
  host.dotForId = () => undefined;
  let exited = false;
  const dispose = vi.fn(async () => { await Promise.resolve(); exited = true; });
  const client = Object.assign(session.client!, {
    supportsTurnFork: () => true,
    forkSession: vi.fn(async () => ({ newSessionId: "child" })),
    dispose,
    setHumanWaitActive: vi.fn(),
  });
  let overrides: Record<string, any> = {};
  host.state = { get: () => overrides, update: async (_key: string, value: typeof overrides) => { overrides = value; } };
  let atOpen: { client: unknown; live: boolean; exited: boolean } | undefined;
  host.openSession = vi.fn(async () => { atOpen = { client: session.client, live: host.pool.has(session), exited }; });
  session.forkPoints.reply("first", false);
  session.forkPoints.settle(true);
  await host.onMessage({ type: "forkSession" }, "local");
  expect(host.openSession).toHaveBeenCalledWith("child", "/work/repo");
  if (provider === "codex") {
    expect(atOpen).toEqual({ client: undefined, live: false, exited: true });
    expect(host.post).toHaveBeenCalledWith({ type: "sessionDot", id: "codex-1", dot: undefined });
    expect(host.remoteClients.active("phone")).toBe(session);
  } else {
    expect(atOpen).toEqual({ client, live: true, exited: false });
    expect(dispose).not.toHaveBeenCalled();
  }
  expect(host.reportRequester).toHaveBeenLastCalledWith(undefined, "info", expect.stringContaining('Forked into "(Fork) Parent"'));
});

function prepareRacingSend(session: Session) {
  const host = hostWith(session);
  let overrides: Record<string, any> = {};
  host.state = { get: () => overrides, update: async (_key: string, value: typeof overrides) => { overrides = value; } };
  host.post = vi.fn();
  host.emit = vi.fn();
  host.refreshImplicitChip = vi.fn();
  host.reportRemoteMessage = vi.fn();
  host.dotForId = () => undefined;
  const client = Object.assign(session.client!, {
    supportsTurnFork: () => true,
    dispose: vi.fn(async () => {}),
    prompt: vi.fn(async () => ({})),
    setHumanWaitActive: vi.fn(),
    availableCommands: [],
  });
  session.forkPoints.reply("first", false);
  session.forkPoints.settle(true);
  return { host, client, meta: () => overrides.child };
}

it.each(["local", "remote"] as const)("restores sends racing a fork as one draft on the %s composer", async (origin) => {
  const source = startedSession("codex");
  const { host, client, meta } = prepareRacingSend(source);
  const copy = startedSession("codex");
  copy.activeSessionId = copy.client!.sessionId = "child";
  const copyPrompt = vi.fn();
  copy.client!.prompt = copyPrompt;
  const chip = makeExplicitChip("/work/repo/notes.md", "notes.md");
  const lateChip = makeExplicitChip("/work/repo/tasks.md", "tasks.md");
  source.chips = [chip, lateChip];
  const clientId = origin === "remote" ? "phone" : undefined;
  const draft = clientId ? "Revise the earlier prompt" : undefined;
  const send = (text: string, chip: typeof lateChip) => host.onMessage({ type: "send", text, chips: [chip] }, origin, clientId);
  host.view = { webview: {} };
  host.localizeHistoryMessage = (message: unknown) => message;
  host.sendRemoteClient = vi.fn();
  host.ensureClient = vi.fn();
  client.forkSession = vi.fn(async () => {
    expect(source.forkInFlight).toBe(true);
    await send("Check the notes", chip);
    expect(source.queuedSends).toEqual([{ text: "Check the notes", chips: [chip] }]);
    return { newSessionId: "child" };
  });
  let finishPickerChange!: () => void;
  const pickerChange = new Promise<void>((resolve) => { finishPickerChange = resolve; });
  let lateSend: Promise<void> | undefined;
  const openCopy = vi.fn(async () => {
    expect(source.client).toBeUndefined();
    expect(host.pool.has(source)).toBe(false);
    expect(source.forkInFlight).toBe(true);
    // Send reaches the host before the binding changes, while preflight could wait past it.
    host.pickerChange = pickerChange;
    lateSend = send("Check the tasks", lateChip);
    host.pool.add(copy);
    if (clientId) host.remoteClients.setActive(clientId, copy);
    else host.focused = copy;
    // The normal open path tries to restore the edit draft during startup.
    host.restorePersistedDraft(copy);
    await host.sessionMetaWrites;
  });
  host.openSession = clientId ? vi.fn() : openCopy;
  host.openRemoteSession = clientId ? openCopy : vi.fn();
  await host.onMessage({
    type: "forkAtReply", sessionId: source.activeSessionId, messageId: "first",
    draft,
  }, origin, clientId);
  finishPickerChange();
  await lateSend;
  await host.sessionMetaWrites;
  expect(openCopy.mock.calls).toEqual([clientId ? [clientId, "child", "/work/repo"] : ["child", "/work/repo"]]);
  const frames = clientId
    ? host.sendRemoteClient.mock.calls.filter(([recipient]: [string]) => recipient === clientId).map((call: any[]) => call[1])
    : host.postLocal.mock.calls.map((call: any[]) => call[0]);
  expect(frames.filter((message: { type: string }) => message.type === "restoreComposer")).toEqual([{
    type: "restoreComposer", sessionId: "child", draft: true,
    text: [draft, "Check the notes", "Check the tasks"].filter(Boolean).join("\n\n"), chips: [chip, lateChip],
  }]);
  expect(meta().queuedDraft).toBeUndefined();
  expect(copy.restoredChips).toEqual([chip, lateChip]);
  expect(source.queuedSends).toEqual([]);
  expect(source.forkInFlight).toBe(false);
  expect(host.ensureClient).not.toHaveBeenCalled();
  expect(client.prompt).not.toHaveBeenCalled();
  expect(copyPrompt).not.toHaveBeenCalled();
});

it.each([
  { provider: "claude", refused: false },
  { provider: "muse", refused: false },
  { provider: "codex", refused: true },
] as const)("flushes a racing send when the original stays live ($provider, refused: $refused)", async ({ provider, refused }) => {
  const source = startedSession(provider);
  const { host, client, meta } = prepareRacingSend(source);
  host.openSession = vi.fn();
  host.pendingAttach = new Set();
  host.startTurnDiffBaseline = vi.fn();
  host.setStatus = vi.fn();
  host.noteSessionActivity = vi.fn();
  host.maybeAskToAddProject = vi.fn();
  host.noteLiveTurnEnded = vi.fn();
  host.setProviderNeedsLogin = vi.fn();
  host.maybeGenerateTitle = vi.fn();
  host.postSessionName = vi.fn();
  client.forkSession = vi.fn(async () => {
    await host.onMessage({ type: "send", text: "Keep this on the original" }, "local");
    expect(source.queuedSends).toEqual([{ text: "Keep this on the original", chips: [] }]);
    expect(client.prompt).not.toHaveBeenCalled();
    if (refused) return "unsupported";
    return { newSessionId: "child" };
  });
  const flush = vi.spyOn(host, "maybeFlushQueuedSends");
  await host.onMessage({ type: "forkAtReply", sessionId: source.activeSessionId, messageId: "first" }, "local");
  await flush.mock.results[1].value;
  expect(client.prompt.mock.calls).toEqual([[[{ type: "text", text: "Keep this on the original" }]]]);
  expect(source.queuedSends).toEqual([]);
  expect(source.client).toBe(client);
  expect(host.pool.has(source)).toBe(true);
  expect(client.dispose).not.toHaveBeenCalled();
  expect(host.openSession).toHaveBeenCalledTimes(refused ? 0 : 1);
  expect(meta()?.queuedDraft).toBeUndefined();
});

it("requires the bound session and propose permission for a typed fork point", () => {
  const msg = { type: "forkAtReply", sessionId: "parent", messageId: "reply", draft: "draft" };
  expect(parseWebviewMsg(msg)).toEqual(msg);
  expect(parseWebviewMsg({ ...msg, messageId: undefined })).toBeNull();
  expect(parseWebviewMsg({ ...msg, sessionId: "" })).toBeNull();
  expect(parseWebviewMsg({ ...msg, draft: ["draft"] })).toBeNull();
  expect(remoteRequiresBoundSession("forkAtReply")).toBe(true);
  expect(allowFromRemote("forkAtReply", "view")).toBe(false);
  expect(allowFromRemote("forkAtReply", "propose")).toBe(true);
});
