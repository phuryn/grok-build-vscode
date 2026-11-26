import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import type { GithubAuthIo } from "../src/github-auth";
import type { HostMsg, WebviewMsg } from "../src/protocol";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";
import { allowFromRemote, mayDeliverRemoteHostMsg, transformHostMsgForRemote } from "../src/remote-policy";
import { Session } from "../src/session";
import { GrokSidebar } from "../src/sidebar";
import { STAR_PROMPT_REPEAT_MS, StarPromptRecord } from "../src/star-prompt";

const gh = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("../src/github-auth", async importOriginal => {
  const real = await importOriginal<typeof import("../src/github-auth")>();
  const io = gh as unknown as GithubAuthIo;
  return {
    ...real,
    readGithubAuthState: (_io: unknown, env?: NodeJS.ProcessEnv) => real.readGithubAuthState(io, env),
    starAfkPilotRepo: () => real.starAfkPilotRepo(io),
  };
});

const READ_ARGS = ["api", "user", "--jq", ".login"];
const STAR_ARGS = ["api", "-X", "PUT", "user/starred/phuryn/grok-build-vscode"];
const REPO = "https://github.com/phuryn/grok-build-vscode";
type Action = Extract<WebviewMsg, { type: "starPromptAction" }>["action"];
type Frame = Extract<HostMsg, { type: "starPrompt" }>;

function harness() {
  const sidebar = Object.create(GrokSidebar.prototype);
  const session = new Session();
  session.hasHistory = true;
  const client = {
    sessionId: "current",
    availableCommands: [],
    lastPromptStopReason: "end_turn",
    prompt: vi.fn(async () => ({})),
    setHumanWaitActive: vi.fn(),
  };
  Object.assign(session, { client, activeSessionId: client.sessionId });
  const posted: HostMsg[] = [];
  const frames = () => posted.filter((msg): msg is Frame => msg.type === "starPrompt");
  let asked = false;
  const readMeta = vi.fn(() => Object.fromEntries(
    [1, 2, 3, 4, 5].map(id => [`sent-${id}`, { sentAt: id }]),
  ));
  const record = {
    state: vi.fn(() => asked ? "asked" : "due"),
    finish: vi.fn(),
    claim: vi.fn((_now?: number) => {
      if (asked) return false;
      asked = true;
      return true;
    }),
  };
  const away = vi.fn(() => false);
  const openExternal = vi.fn(async () => true);
  const host = {
    deskAlerts: { isAway: away },
    getConfiguration: () => ({ get: () => false }),
    appendLine: vi.fn(),
    openExternal,
    setContext: vi.fn(),
  };
  Object.assign(sidebar, {
    focused: session,
    state: { get: readMeta },
    starPromptRecord: record,
    host,
    view: { visible: true, webview: { postMessage: (msg: HostMsg) => posted.push(msg) } },
    pendingAttach: new Set(),
    retainUploadedFilesForSession: vi.fn(),
    refreshImplicitChip: vi.fn(),
    noteSessionActivity: vi.fn(),
    maybeAskToAddProject: vi.fn(),
    reportRemoteMessage: vi.fn(),
    startTurnDiffBaseline: vi.fn(),
    setStatus: (target: Session, status: Session["status"]) => { target.status = status; },
    setProviderNeedsLogin: vi.fn(),
    maybeGenerateTitle: vi.fn(),
    postSessionName: vi.fn(),
    emit: (_target: Session, msg: HostMsg) => posted.push(msg),
    maybeFlushQueuedSends: vi.fn(),
    recoverAuthAndResend: vi.fn(async () => false),
    cancelAllDeviceLogins: vi.fn(),
    providerRuns: new Map(),
    turnOrderTimers: new Set(),
    disposePool: vi.fn(),
    adapterHistoryClients: new Map(),
    terminalManager: { disposeAll: vi.fn() },
    stopVoiceInput: vi.fn(),
    remoteClients: { clear: vi.fn() },
  });
  const send = (origin: "local" | "remote" = "local") => sidebar.handleSend("hello", false, session, origin);
  const action = (action: Action, id = frames()[0].id, origin: "local" | "remote" = "local") =>
    sidebar.onMessage({ type: "starPromptAction", id, action }, origin);
  const reachOffer = async () => {
    await send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(frames().map(msg => msg.phase)).toEqual(["check"]);
    await action("ready");
    expect(frames().map(msg => msg.phase)).toEqual(["check", "offer"]);
    await action("shown");
  };
  return { sidebar, session, client, posted, frames, record, readMeta, away, openExternal, host, send, action, reachOffer };
}

describe("Star on GitHub host flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    gh.execFile.mockReset();
    gh.execFile.mockImplementation((_bin, args, _opts, cb) => cb(null, args[1] === "user" ? "octocat\n" : "", ""));
    gh.spawn.mockReset();
    gh.spawn.mockImplementation(() => { throw new Error("Test cannot spawn gh"); });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(["local", "remote"] as const)("starts 30 seconds after a successful %s reply and does not ask again while the record waits", async origin => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.frames()).toEqual([]);
    await h.send(origin);
    expect(h.posted.some(msg => msg.type === "agentEnd")).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.frames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check"]);
    expect(gh.execFile).not.toHaveBeenCalled();
    await h.action("ready");
    expect(h.frames().at(-1)).toMatchObject({ phase: "offer", login: "octocat" });
    expect(h.record.claim.mock.calls).toEqual([[Date.now()]]);
    await h.action("shown");
    await h.action("dismiss");
    expect(h.frames().at(-1)).toMatchObject({ phase: "close" });
    expect(h.record.finish).not.toHaveBeenCalled();
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check", "offer", "close"]);
    expect(h.readMeta).toHaveBeenCalledOnce();
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS]);
  });

  it.each(["cancelled", "refusal", "max_tokens", "error", "routine"])("does not offer after %s", async kind => {
    const h = harness();
    if (kind === "error") h.client.prompt.mockRejectedValueOnce(new Error("failed"));
    else if (kind === "routine") h.session.fromRoutine = true;
    else h.client.lastPromptStopReason = kind;
    await h.send();
    expect(h.client.prompt).toHaveBeenCalledOnce();
    expect(h.posted.some(msg => msg.type === (kind === "error" ? "agentError" : "agentEnd"))).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames()).toEqual([]);
    expect(gh.execFile).not.toHaveBeenCalled();
  });

  it("treats a compaction as no reply: no duration and no offer", async () => {
    const h = harness();
    const refreshContextAfterCompact = vi.fn(async () => {});
    Object.assign(h.sidebar, { refreshContextAfterCompact });
    Object.assign(h.client, { availableCommands: [{ name: "compact" }] });
    await h.sidebar.handleSend("/compact", false, h.session, "local");
    expect(refreshContextAfterCompact).toHaveBeenCalledOnce();
    const end = h.posted.find(msg => msg.type === "agentEnd")!;
    expect(end).toEqual({ type: "agentEnd", meta: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames()).toEqual([]);
    await h.send();
    expect(h.posted.filter(msg => msg.type === "agentEnd").at(-1)).toHaveProperty("durationMs");
  });

  it("cancels the first timer when a new turn starts and uses the new reply's deadline", async () => {
    const h = harness();
    await h.send();
    await vi.advanceTimersByTimeAsync(20_000);
    await h.send();
    expect(h.client.prompt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.frames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check"]);
  });

  it("cancels a pending check on a question, even when the question clears before the deadline", async () => {
    const h = harness();
    await h.send();
    await vi.advanceTimersByTimeAsync(20_000);
    h.sidebar.postQuestionRequest(h.session, { id: 1, toolCallId: "tool", questions: [] });
    h.sidebar.clearPendingHumanRequests(h.session);
    expect(h.posted.some(msg => msg.type === "questionRequest")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.frames()).toEqual([]);
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check"]);
  });

  it.each([undefined, "end_turn"])("counts a reply that ended with stop reason %s", async reason => {
    const h = harness();
    Object.assign(h.client, { lastPromptStopReason: reason });
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check"]);
  });

  it("offers nothing for a reply that ended in a conversation nobody is looking at", async () => {
    const h = harness();
    h.client.prompt.mockImplementationOnce(async () => {
      Object.assign(h.sidebar, { focused: new Session() });
      return {};
    });
    await h.send();
    expect(h.posted.some(msg => msg.type === "agentEnd")).toBe(true);
    Object.assign(h.sidebar, { focused: h.session });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames()).toEqual([]);
  });

  it("keeps a pending offer when another conversation starts waiting on the person", async () => {
    const h = harness();
    await h.send();
    await vi.advanceTimersByTimeAsync(20_000);
    const other = new Session();
    h.sidebar.postQuestionRequest(other, { id: 2, toolCallId: "tool", questions: [] });
    expect(other.pendingQuestions.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check"]);
  });

  it("keeps a shown card through a new turn, a question and a change of conversation", async () => {
    const h = harness();
    await h.reachOffer();
    await h.send();
    h.sidebar.postQuestionRequest(h.session, { id: 1, toolCallId: "tool", questions: [] });
    h.sidebar.clearPendingHumanRequests(h.session);
    expect(h.client.prompt).toHaveBeenCalledTimes(2);
    Object.assign(h.sidebar, { focused: new Session() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check", "offer"]);
    await h.action("star");
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS, READ_ARGS, STAR_ARGS]);
    expect(h.frames().at(-1)).toMatchObject({ phase: "thanks", login: "octocat" });
  });

  it("checks focus at the deadline and retries only after the next successful reply", async () => {
    const h = harness();
    h.away.mockReturnValue(true);
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.away).toHaveBeenCalledWith(true);
    h.away.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.frames()).toEqual([]);
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check"]);
  });

  it("never schedules on a cloud host", async () => {
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const h = harness();
    await h.send();
    expect(h.posted.some(msg => msg.type === "agentEnd")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames()).toEqual([]);
    expect(h.record.state).not.toHaveBeenCalled();
  });

  it("uses desktop window focus where native alerts are unavailable", async () => {
    const h = harness();
    const desktopAway = vi.fn(() => true);
    Object.assign(h.host, { deskAlerts: undefined, isChatWindowAway: desktopAway });
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(desktopAway).toHaveBeenCalledOnce();
    expect(h.frames()).toEqual([]);
    desktopAway.mockReturnValue(false);
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames().map(msg => msg.phase)).toEqual(["check"]);
  });

  it("cancels on dispose", async () => {
    const h = harness();
    await h.send();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.sidebar.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.frames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to reveal if its record write fails", async () => {
    const h = harness();
    h.record.claim.mockReturnValue(false);
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    await h.action("ready");
    expect(h.record.claim).toHaveBeenCalledOnce();
    expect(h.frames().map(msg => msg.phase)).toEqual(["check", "close"]);
  });

  it("leaves the machine unasked if the draft cancels a pending auth read", async () => {
    const h = harness();
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    let finish = () => {};
    gh.execFile.mockImplementationOnce((_bin, _args, _opts, cb) => {
      finish = () => cb(null, "octocat", "");
    });
    const pending = h.action("ready");
    expect(gh.execFile).toHaveBeenCalledOnce();
    await h.action("dismiss");
    finish();
    await pending;
    expect(h.record.claim).not.toHaveBeenCalled();
    expect(h.frames().map(msg => msg.phase)).toEqual(["check", "close"]);
    await h.send();
    await vi.advanceTimersByTimeAsync(30_000);
    const next = h.frames().at(-1)!;
    expect(next.phase).toBe("check");
    expect(next.id).not.toBe(h.frames()[0].id);
    await h.action("ready", next.id);
    expect(h.frames().at(-1)).toMatchObject({ phase: "offer", login: "octocat" });
    expect(h.record.claim).toHaveBeenCalledOnce();
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN"])("uses browser mode without invoking gh with %s", async key => {
    vi.stubEnv(key, "test-token");
    const h = harness();
    await h.reachOffer();
    expect(h.frames().at(-1)).toMatchObject({ phase: "offer", login: undefined });
    await h.action("star");
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.record.finish).not.toHaveBeenCalled();
    await h.action("open");
    expect(h.openExternal.mock.calls).toEqual([[REPO]]);
    expect(h.record.finish.mock.calls).toEqual(h.record.claim.mock.calls);
    expect(h.frames().at(-1)).toMatchObject({ phase: "close" });
    expect(gh.execFile).not.toHaveBeenCalled();
  });

  it("uses the browser if an environment token becomes effective after the offer", async () => {
    const h = harness();
    await h.reachOffer();
    expect(h.frames().at(-1)).toMatchObject({ phase: "offer", login: "octocat" });
    vi.stubEnv("GH_TOKEN", "test-token");
    await h.action("star");
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS]);
    expect(h.openExternal.mock.calls).toEqual([[REPO]]);
    expect(h.frames().at(-1)).toMatchObject({ phase: "close" });
  });

  it.each(["403", "offline", "ENOENT", "throws", "success"])("uses fixed gh args once with outcome %s", async outcome => {
    const h = harness();
    await h.reachOffer();
    const id = h.frames()[0].id;
    gh.execFile.mockImplementation((_bin, args, _opts, cb) => {
      if (args[1] === "user") return cb(null, "octocat\n", "");
      if (outcome === "throws") throw new Error(outcome);
      cb(outcome === "success" ? null : new Error(outcome), "", outcome);
    });
    await h.action("star", "wrong-id");
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS]);
    await h.action("star", id);
    await h.action("star", id);
    expect(gh.execFile.mock.calls.map(([bin, args]) => [bin, args]))
      .toEqual([["gh", READ_ARGS], ["gh", READ_ARGS], ["gh", STAR_ARGS]]);
    expect(gh.execFile.mock.calls.map(call => call[2].env.GH_HOST)).toEqual(["github.com", "github.com", "github.com"]);
    expect(h.record.finish.mock.calls).toEqual(h.record.claim.mock.calls);
    if (outcome === "success") {
      expect(h.frames().at(-1)).toMatchObject({ phase: "thanks", login: "octocat" });
      expect(h.openExternal).not.toHaveBeenCalled();
    } else {
      expect(h.openExternal.mock.calls).toEqual([[REPO]]);
      expect(h.frames().at(-1)).toMatchObject({ phase: "close" });
    }
  });

  it.each(["hubot", ""])("stars nothing when the gh account became %j after the button named one", async login => {
    const h = harness();
    await h.reachOffer();
    gh.execFile.mockImplementation((_bin, args, _opts, cb) =>
      args[1] === "user" && login ? cb(null, login, "") : cb(new Error("not logged in"), "", "not logged in"));
    await h.action("star");
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS, READ_ARGS]);
    expect(h.openExternal.mock.calls).toEqual([[REPO]]);
    expect(h.frames().at(-1)).toMatchObject({ phase: "close" });
  });

  it("uses browser mode when gh is missing or signed out", async () => {
    for (const error of ["spawn gh ENOENT", "not logged in"]) {
      const h = harness();
      gh.execFile.mockImplementationOnce((_bin, _args, _opts, cb) => cb(new Error(error), "", error));
      await h.reachOffer();
      expect(h.frames().at(-1)).toMatchObject({ phase: "offer", login: undefined });
      await h.action("open");
      expect(h.openExternal.mock.calls).toEqual([[REPO]]);
    }
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS, READ_ARGS]);
  });

  it("asks again 30 days after Not now or no answer, and never after Star", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "star-host-")), "client-state");
    const h = harness();
    Object.assign(h.sidebar, { starPromptRecord: new StarPromptRecord(dir, fs) });
    const offered = async () => {
      await h.send();
      await vi.advanceTimersByTimeAsync(30_000);
      const check = h.frames().at(-1)!;
      if (check.phase !== "check") return undefined;
      await h.action("ready", check.id);
      const offer = h.frames().at(-1)!;
      if (offer.phase !== "offer") return undefined;
      await h.action("shown", offer.id);
      return offer.id;
    };
    const first = await offered();
    expect(first).toBeDefined();
    await h.action("dismiss", first);
    vi.setSystemTime(Date.now() + STAR_PROMPT_REPEAT_MS - 60_000);
    expect(await offered()).toBeUndefined();
    vi.setSystemTime(Date.now() + 60_000);
    // Shown and never answered: the window went away with the card up.
    expect(await offered()).toBeDefined();
    h.sidebar.cancelStarPrompt();
    vi.setSystemTime(Date.now() + STAR_PROMPT_REPEAT_MS);
    const third = await offered();
    expect(third).toBeDefined();
    await h.action("star", third);
    expect(h.frames().at(-1)).toMatchObject({ phase: "thanks", login: "octocat" });
    await h.action("dismiss", third);
    vi.setSystemTime(Date.now() + 10 * STAR_PROMPT_REPEAT_MS);
    expect(await offered()).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "star-prompt.json"), "utf8")))
      .toEqual({ askedAt: expect.any(Number), done: true });
  });

  it("refuses remote actions even with the current offer id and suppresses the outbound offer", async () => {
    const h = harness();
    await h.reachOffer();
    const offer = h.frames().at(-1)!;
    expect(allowFromRemote("starPromptAction", "full")).toBe(false);
    expect(allowFromRemote("starPromptAction", "full", { isCloud: true })).toBe(false);
    expect(allowFromRemote("send", "full")).toBe(true);
    expect(mayDeliverRemoteHostMsg(offer, [], undefined, (a, b) => a === b)).toBe(false);
    expect(transformHostMsgForRemote(offer, { readFile: () => null, toBase64: () => "" })).toBeNull();
    await h.action("star", offer.id, "remote");
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS]);
    expect(h.frames().at(-1)).toBe(offer);
    expect(h.record.finish).not.toHaveBeenCalled();
    await h.action("star", offer.id);
    expect(gh.execFile.mock.calls.map(call => call[1])).toEqual([READ_ARGS, READ_ARGS, STAR_ARGS]);
  });
});

it("accepts only the action and offer id on Electron IPC", () => {
  const message = { type: "starPromptAction", id: "offer", action: "star" };
  expect(parseWebviewMsg(message)).toEqual(message);
  expect(parseWebviewMsg({ ...message, repo: "another/repo" })).toBeNull();
  expect(parseWebviewMsg({ ...message, action: "repeat" })).toBeNull();
  expect(parseWebviewMsg({ ...message, id: "" })).toBeNull();
});
