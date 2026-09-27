import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../src/acp";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import type { HostMsg } from "../src/protocol";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const windows: Harness["window"][] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.happyDOM.abort();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function view(turns: number): Harness {
  const h = bootWebview({ beforeScripts: window => { (window as any).__grokHistoryWindow = turns; } });
  windows.push(h.window);
  return h;
}

// Synthetic conversation and run; the replay revisions follow the probe in
// research/workflow-completion-review.md, not the owner's unavailable session.
const RUN = "wf_replay_middle";
const active = { sessionUpdate: "workflow_updated", run_id: RUN, name: "middle-research",
  status: "active", current_phase: "Research", revision: 1 };
const complete = { ...active, status: "complete", current_phase: "Report", revision: 28,
  result_summary: "Research finished", elapsed_ms: 279000 };
const wire = (client: AcpClient, method: string, update: unknown) => (client as any).onLine(JSON.stringify({
  jsonrpc: "2.0", method, params: { sessionId: client.sessionId, update },
}));
const user = (client: AcpClient, text: string) => wire(client, "session/update", {
  sessionUpdate: "user_message_chunk", content: { type: "text", text },
});
const answer = (client: AcpClient, text: string) => wire(client, "session/update", {
  sessionUpdate: "agent_message_chunk", content: { type: "text", text },
});
const order = (h: Harness) => [...h.doc.querySelectorAll(".msg.user .body, .workflow-card")]
  .map(el => el.getAttribute("data-run-id") ?? el.textContent);

// Keep the real ACP dispatcher, sidebar listeners, emit/buffer, replay boundary
// and renderer. Only process startup and unrelated host services are stubbed.
async function coldReplay(h: Harness, history: (client: AcpClient) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-replay-"));
  dirs.push(cwd);
  vi.stubEnv("GROK_HOME", cwd);
  vi.spyOn(AcpClient.prototype, "start").mockResolvedValue();
  vi.spyOn(AcpClient.prototype, "newSession").mockImplementation(async function () {
    this.sessionId = "new-session";
    this.emit("session", { sessionId: this.sessionId });
    return { sessionId: this.sessionId };
  });
  vi.spyOn(AcpClient.prototype, "loadSession").mockImplementation(async function (sessionId) {
    this.sessionId = sessionId;
    this.emit("session", { sessionId });
    history(this);
    this.emit("sessionLoaded", { sessionId });
    return { sessionId };
  });
  vi.spyOn(AcpClient.prototype, "setMode").mockResolvedValue();
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = "grok";
  session.cwd = cwd;
  Object.assign(sidebar, {
    focused: session, pool: new Set<Session>(), remoteClients: new RemoteClientState<Session>(cwd),
    providerNeedsLogin: {}, providerCliVersions: {}, sessionCache: new Map(),
    // Starting the adapter runs the vendor binary, so the saved consent has to
    // agree with connectedProviders below (#171).
    providerConnectionState: { grok: true },
    turnOrderTimers: new Set(), pendingConfirms: new Map(),
    fullImagePaths: new Map(), pendingAttach: new Set(),
    state: { get: (_key: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) },
    host: { canSwitchWorkspaceFolder: false, append: vi.fn(), appendLine: vi.fn(),
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined }),
      fs: { readFile: vi.fn(async () => Buffer.from("")), writeFile: vi.fn(), createDirectory: vi.fn() } },
    context: { globalStorageUri: { fsPath: cwd }, subscriptions: [] },
    terminalManager: { disposeAll: vi.fn(), releaseOwnedBy: vi.fn(), ownedBy: () => ({ create: vi.fn() }) },
    connectedProviders: () => ["grok"], workspaceRoot: () => cwd, sessionCwd: () => cwd,
    locateProvider: () => "unused-fake-cli", providerDefaultForProject: () => "",
    configForcesAutoApprove: () => false, confirmRepoForcedAutoApprove: async () => true,
    modelsForSession: () => [], buildEnv: () => ({}),
    planModeCompatibility: async () => ({ planModeAvailable: true, planModeVersionVerified: true }),
    localizeHistoryMessage: (message: HostMsg) => message,
    view: { webview: { postMessage: (message: HostMsg) => dispatch(h.window, structuredClone(message)) } },
  });
  for (const method of ["stopVoiceInput", "queueInFlightPlanCommentsOnExit", "warnOAuthShadowOnce",
    "cacheProviderModels", "updateSessionMeta", "postSessionName", "postProviderState", "postSessionsList",
    "postRepoCatalog", "touch", "reapPool", "maybeFlushQueuedSends", "emitContextUsage", "restoreUsage",
    "restorePersistedDraft", "sendRemoteSession", "sendRemoteClient", "sendRemoteHistorySnapshot",
    "mirrorToProjectsRail", "maybeUpdateCliOnUpgrade", "maybePinBrokenCli", "applyPlanModeCompatibility",
    "bindSubscriptionUsage", "refreshSubscriptionUsage"]) sidebar[method] = vi.fn();
  const client: AcpClient = await sidebar.startSession("01a0c8e9-649c-7130-9515-915e62291d30", session);
  expect(client, JSON.stringify(sidebar.host.appendLine.mock.calls)).toBeDefined();
  expect(session.replaying).toBe(false);
  expect(sidebar.host.appendLine.mock.calls.flat().join("\n")).not.toContain("handler error");
  return { sidebar, session, client };
}

function replayBuffer(h: Harness, session: Session) {
  dispatch(h.window, { type: "historyReplay", active: true });
  for (const message of session.buffer) dispatch(h.window, structuredClone(message));
  dispatch(h.window, { type: "historyReplay", active: false });
}

describe("workflow replay routing", () => {
  it.each([false, true])("anchors an early replay frame after its launch receipt (separate update=%s)", async separateUpdate => {
    const h = view(80);
    const { session } = await coldReplay(h, client => {
      user(client, "Start research"); answer(client, "Starting research");
      wire(client, "_x.ai/session/update", active);
      const call = { toolCallId: "launch", title: "Creating workflow 'middle-research'", kind: "other",
        status: "completed", rawOutput: { type: "Workflow", run_id: RUN, name: "middle-research" } };
      wire(client, "session/update", { sessionUpdate: "tool_call", ...call,
        ...(separateUpdate ? { status: "in_progress", rawOutput: undefined } : {}) });
      if (separateUpdate) wire(client, "session/update", { sessionUpdate: "tool_call_update", ...call });
      wire(client, "_x.ai/session/update", complete);
      user(client, "Later conversation");
    });
    const restored = view(80);
    replayBuffer(restored, session);
    for (const rendered of [h, restored]) {
      const launch = [...rendered.doc.querySelectorAll(".tool-flat, .tool-group")]
        .find(el => el.textContent?.includes("Creating workflow"))!;
      const card = rendered.doc.querySelector(".workflow-card")!;
      expect(launch).toBeDefined();
      expect(launch.nextElementSibling).toBe(card);
      expect(order(rendered)).toEqual(["Start research", RUN, "Later conversation"]);
      expect((card.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    }
  });

  it.each([80, 10])("cold replay places a workflow in the middle, including after reload (%i-turn window)", async turns => {
    const h = view(turns);
    const { session, client } = await coldReplay(h, client => {
      user(client, "Earlier conversation"); answer(client, "Earlier answer");
      user(client, "Start research"); answer(client, "Starting research");
      for (const revision of [1, 2, 7, 16, 23]) {
        wire(client, "_x.ai/session/update", { ...active, revision });
      }
      wire(client, "_x.ai/session/update", complete);
      user(client, "Later conversation"); answer(client, "Last assistant answer");
    });
    const expected = ["Earlier conversation", "Start research", RUN, "Later conversation"];
    expect(order(h)).toEqual(expected);
    expect(session.buffer.filter(m => m.type === "runProgress")).toHaveLength(6);
    expect(session.buffer.filter(m => m.type === "subagentUpdate")).toHaveLength(0);
    const card = h.doc.querySelector(".workflow-card");
    wire(client, "_x.ai/session_notification", complete);
    expect(h.doc.querySelector(".workflow-card")).toBe(card);
    expect(order(h)).toEqual(expected);
    const restored = view(turns);
    replayBuffer(restored, session);
    expect(order(restored)).toEqual(expected);
    for (const rendered of [h, restored]) {
      expect(rendered.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
      expect(rendered.doc.querySelector(".workflow-pin, .workflow-marker, .run-progress-btn")).toBeNull();
      expect((rendered.doc.querySelector(".workflow-report") as HTMLDetailsElement).open).toBe(false);
    }
  });

  it("replay then live updates the same card once per frame without moving or reviving it", async () => {
    const h = view(80);
    const { session, client, sidebar } = await coldReplay(h, client => {
      user(client, "Start research"); answer(client, "Starting research");
      wire(client, "_x.ai/session/update", active);
      user(client, "Later conversation"); answer(client, "Last assistant answer");
    });
    const expected = ["Start research", RUN, "Later conversation"];
    expect(order(h)).toEqual(expected);
    const card = h.doc.querySelector(".workflow-card") as HTMLElement & { _workflow: { update: { revision: number; done: boolean } } };
    const emit = vi.spyOn(sidebar, "emit");
    for (const update of [active, { ...active, revision: 7 }, complete, { ...active, revision: 2 }]) {
      for (const method of ["_x.ai/session/update", "_x.ai/session_notification"]) {
        emit.mockClear();
        wire(client, method, update);
        expect(emit.mock.calls.map(args => (args[1] as HostMsg).type)).toEqual(["runProgress"]);
        expect(order(h)).toEqual(expected);
        expect(h.doc.querySelector(".workflow-card")).toBe(card);
        expect(h.doc.querySelectorAll(".workflow-card")).toHaveLength(1);
        expect(card._workflow.update.revision).toBe(update.revision === 2 ? 28 : update.revision);
      }
    }
    expect(card._workflow.update.done).toBe(true);
    const restored = view(80);
    replayBuffer(restored, session);
    expect(order(restored)).toEqual(expected);
    expect(restored.doc.querySelector(".workflow-pin, .run-progress-btn")).toBeNull();
    expect((restored.doc.querySelector(".workflow-report") as HTMLDetailsElement).open).toBe(false);
    expect(sidebar.host.appendLine.mock.calls.flat().join("\n")).not.toContain("handler error");
  });
});
