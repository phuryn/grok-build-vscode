import { expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { FIRST_PROMPT_EDIT } from "../src/fork-points";

// A conversation's first prompt has no reply before it to branch from, so the
// adapters that edit a later prompt in a new chat showed no Edit on the first.
// Editing it now opens a new chat on the same agent, model and folder, with the
// prompt in the composer.

function hostWith(session: Session) {
  const host: any = Object.create(GrokSidebar.prototype);
  host.pool = new Set([session]);
  host.focused = session;
  host.reportRequester = vi.fn();
  host.sessionCwd = (s: Session = host.focused) => s.cwd || "/work/repo";
  host.sessionDisplayName = () => "Parent";
  host.workspaceRoot = () => "/work/repo";
  host.host = { appendLine: vi.fn() };
  host.postLocal = vi.fn();
  host.post = vi.fn();
  host.sessionMetaWrites = Promise.resolve();
  host.sessionCache = new Map();
  host.remoteClients = new RemoteClientState<Session>("/work/repo");
  host.remoteClients.ready("phone");
  host.remoteClients.setActive("phone", session);
  host.pendingConfirms = new Map();
  let overrides: Record<string, any> = {};
  host.state = { get: () => overrides, update: async (_key: string, value: typeof overrides) => { overrides = value; } };
  return host;
}

function session(provider: Session["provider"], turnFork = true) {
  const s = new Session();
  s.provider = provider;
  s.activeSessionId = `${provider}-1`;
  s.cwd = "/work/repo/topic";
  s.client = {
    sessionId: s.activeSessionId,
    currentModelId: "model-b",
    supportsTurnFork: () => turnFork,
    forkSession: vi.fn(),
    prompt: vi.fn(async () => ({})),
    dispose: vi.fn(async () => {}),
    setHumanWaitActive: vi.fn(),
    availableCommands: [],
    availableModels: [],
  } as any;
  return s;
}

function sendable(s: Session) {
  const host = hostWith(s);
  host.emit = vi.fn();
  for (const method of [
    "refreshImplicitChip", "reportRemoteMessage", "rememberProjectProvider", "reportSessionStart",
    "startTurnDiffBaseline", "setStatus", "noteSessionActivity", "maybeAskToAddProject", "noteLiveTurnEnded",
    "setProviderNeedsLogin", "maybeGenerateTitle", "postSessionName", "maybeFlushQueuedSends",
  ]) host[method] = vi.fn();
  host.pendingAttach = new Set();
  host.dotForId = () => undefined;
  host.modelsForSession = () => [];
  return host;
}

const bubbles = (host: any) => host.emit.mock.calls.map((call: any[]) => call[1]).filter((m: any) => m.type === "userMessage");

it.each(["claude", "codex", "muse", "agy"] as const)("%s: only the first prompt carries the new-chat Edit point", async (provider) => {
  const s = session(provider);
  const host = sendable(s);
  await host.onMessage({ type: "send", text: "First prompt" }, "local");
  await host.onMessage({ type: "send", text: "Second prompt" }, "local");
  const [first, second] = bubbles(host);
  expect(first).toMatchObject({ text: "First prompt", forkBefore: FIRST_PROMPT_EDIT });
  // No settled reply came back in this harness, so the second has no point.
  expect(second.text).toBe("Second prompt");
  expect(second.forkBefore).toBeUndefined();
});

it.each([
  ["grok", true],
  ["codex", false],
] as const)("%s (turn fork %s) offers no first-prompt Edit", async (provider, turnFork) => {
  const s = session(provider, turnFork);
  const host = sendable(s);
  await host.onMessage({ type: "send", text: "First prompt" }, "local");
  expect(bubbles(host)[0].forkBefore).toBeUndefined();
});

function offered(s: Session, type: "userMessage" | "userMessageChunk" = "userMessage", text = "First prompt") {
  s.hasHistory = true;
  s.buffer.push({ type, text, forkBefore: FIRST_PROMPT_EDIT } as any);
}

it.each(["local", "remote"] as const)("opens a new %s chat on the same agent, model and folder with the prompt in it", async (origin) => {
  const s = session("codex");
  offered(s);
  const host = hostWith(s);
  host.newFocusedSession = vi.fn(async () => {});
  host.newRemoteSession = vi.fn(async () => {});
  const clientId = origin === "remote" ? "phone" : undefined;
  await host.onMessage({ type: "forkAtReply", sessionId: "codex-1", messageId: FIRST_PROMPT_EDIT, draft: "Edited first prompt" },
    origin, clientId);
  const spawn = { provider: "codex", modelId: "model-b", cwd: "/work/repo/topic", draft: "Edited first prompt" };
  if (origin === "remote") {
    expect(host.newRemoteSession).toHaveBeenCalledWith("phone", true, undefined, spawn);
    expect(host.newFocusedSession).not.toHaveBeenCalled();
  } else {
    expect(host.newFocusedSession).toHaveBeenCalledWith("local", undefined, undefined, spawn);
    expect(host.newRemoteSession).not.toHaveBeenCalled();
  }
  expect((s.client as any).forkSession).not.toHaveBeenCalled();
  expect(host.reportRequester).toHaveBeenLastCalledWith(
    origin === "remote" ? expect.objectContaining({ clientId: "phone" }) : undefined, "info",
    expect.stringContaining("Your prompt is in a new chat, ready to edit and send. The original conversation is unchanged and is in your session history as \"Parent\"."),
  );
});

it("refuses the point where this host never offered it, and opens nothing", async () => {
  const s = session("claude");
  s.hasHistory = true;
  const host = hostWith(s);
  host.newFocusedSession = vi.fn();
  await host.onMessage({ type: "forkAtReply", sessionId: "claude-1", messageId: FIRST_PROMPT_EDIT, draft: "x" }, "local");
  expect(host.newFocusedSession).not.toHaveBeenCalled();
  expect(host.reportRequester).toHaveBeenLastCalledWith(undefined, "info", "This prompt can't be edited in a new chat.");
});

it("opens a parked conversation's first prompt on the project's model", async () => {
  const s = session("muse");
  offered(s);
  s.client = undefined;
  const host = hostWith(s);
  host.newFocusedSession = vi.fn(async () => {});
  await host.onMessage({ type: "forkAtReply", sessionId: "muse-1", messageId: FIRST_PROMPT_EDIT, draft: "Again" }, "local");
  expect(host.newFocusedSession).toHaveBeenCalledWith("local", undefined, undefined,
    { provider: "muse", modelId: undefined, cwd: "/work/repo/topic", draft: "Again" });
});

it("gives Antigravity's skill shortcuts back on a replayed first prompt", async () => {
  const s = session("agy");
  offered(s, "userMessageChunk");
  const host = hostWith(s);
  host.newFocusedSession = vi.fn(async () => {});
  const expanded = "[Use the review skill with lookup_skill and follow its instructions] the diff";
  await host.onMessage({ type: "forkAtReply", sessionId: "agy-1", messageId: FIRST_PROMPT_EDIT, draft: expanded }, "local");
  expect(host.newFocusedSession.mock.calls[0][3].draft).toBe("/review the diff");
});

function spawnHost(parent: Session) {
  const host = hostWith(parent);
  const emitted: Array<[Session, any]> = [];
  host.emit = vi.fn((target: Session, message: any) => emitted.push([target, message]));
  for (const method of [
    "clearSettledCliUpdates", "parkFocused", "parkRemoteSession", "dropRemoteVoice", "persistWorktreeBinding",
    "sweepEmptySessions", "postRepoCatalog", "postSessionsList", "sendRemoteSessionList",
  ]) host[method] = vi.fn();
  host.worktreeCache = [];
  host.view = { webview: {} };
  host.sendRemoteClient = vi.fn();
  host.findUnusedEmptySession = vi.fn(() => ({ id: "empty-grok", cwd: "/work/repo" }));
  host.defaultProviderForProject = () => "grok";
  host.historyCwdFor = () => "/work/repo";
  host.newLocalSession = () => { const s = new Session(); host.pool.add(s); return s; };
  host.startSession = vi.fn(async (_id: unknown, target: Session) => {
    target.activeSessionId = "new-chat";
    target.client = {} as any;
    return target.client;
  });
  return { host, emitted };
}

it.each(["local", "remote"] as const)("a %s spawn skips another agent's empty chat and starts on its own agent and model", async (origin) => {
  const parent = session("claude");
  const { host, emitted } = spawnHost(parent);
  const spawn = { provider: "claude", modelId: "opus", cwd: "/work/repo/topic", draft: "Edited first prompt" };
  if (origin === "remote") await host.newRemoteSession("phone", true, undefined, spawn);
  else await host.newFocusedSession("local", undefined, undefined, spawn);
  const created: Session = origin === "remote" ? host.remoteClients.active("phone") : host.focused;
  expect(created).not.toBe(parent);
  expect(host.findUnusedEmptySession).not.toHaveBeenCalled();
  expect(created.provider).toBe("claude");
  expect(created.cwd).toBe("/work/repo/topic");
  expect(host.startSession).toHaveBeenCalledWith(undefined, created, "replace", undefined,
    expect.objectContaining({ modelId: "opus" }));
  await host.sessionMetaWrites;
  // Named by the new chat's id, so a composer still bound to the chat being
  // left files it under the new one instead of keeping it.
  const restored = { type: "restoreComposer", text: "Edited first prompt", sessionId: "new-chat", draft: true };
  const sent = origin === "remote"
    ? host.sendRemoteClient.mock.calls.filter(([to]: [string]) => to === "phone").map((call: any[]) => call[1])
    : host.postLocal.mock.calls.map((call: any[]) => call[0]);
  expect(sent.filter((m: any) => m.type === "restoreComposer")).toEqual([restored]);
  expect(emitted.some(([, m]) => m.type === "restoreComposer")).toBe(false);
  expect(host.state.get()["new-chat"]?.queuedDraft).toBeUndefined();
});

it("an ordinary New still reuses the empty chat and its project's agent", async () => {
  const parent = session("claude");
  const { host } = spawnHost(parent);
  host.openSession = vi.fn(async () => {});
  await host.newFocusedSession("local");
  expect(host.findUnusedEmptySession).toHaveBeenCalled();
  expect(host.openSession).toHaveBeenCalledWith("empty-grok", "/work/repo");
});
