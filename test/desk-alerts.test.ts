import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpClient, type PermissionOption, type PermissionRequest } from "../src/acp";
import { createElectronHost } from "../src/desktop/electron-host";
import type { Host } from "../src/host";
import { providerDisplayName } from "../src/provider-ui";
import { RemoteClientState } from "../src/remote-client-state";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";
import { beginTurn, endTurn, Session } from "../src/session";
import { GrokSidebar } from "../src/sidebar";
import { createVsCodeHost } from "../src/vscode-host";
import { bootWebview, dispatch, type Posted } from "./webview-harness";

const vscode = vi.hoisted(() => ({
  state: { focused: true },
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}));
const native = vi.hoisted(() => ({ show: vi.fn(), supported: vi.fn(() => true) }));
vi.mock("vscode", () => ({
  window: vscode,
  commands: { getCommands: () => Promise.resolve([]) },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Notification: class extends EventEmitter {
      static isSupported = native.supported;
      constructor(readonly options: unknown) { super(); }
      show() { native.show(this); }
    },
  };
});
vi.mock("../src/terminal-manager", async (original) => ({
  ...await original<typeof import("../src/terminal-manager")>(),
  resolvedTerminalShellDialect: () => "posix",
}));

const options: PermissionOption[] = [
  { optionId: "always", kind: "allow_always", name: "Always" },
  { optionId: "once", kind: "allow_once", name: "Yes" },
  { optionId: "reject", kind: "reject_once", name: "No" },
];
const stale = "This request can no longer be approved from the alert.";

function harness(host: Host = createVsCodeHost({ appendLine: vi.fn() } as any)) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.activeSessionId = "conversation-id";
  session.agentTitle = "Investigate the build";
  session.cwd = "/workspace";
  const written: any[] = [];
  const connect = () => {
    const client = new AcpClient({ cliPath: "unused", cwd: "/workspace", log() {} });
    Object.assign(client, { sessionId: session.activeSessionId, proc: { killed: false, stdin: {
      writable: true, write: (line: string) => written.push(JSON.parse(line)),
    } } });
    session.client = client;
    return client;
  };
  connect();
  const config = { enabled: true };
  const data: Record<string, unknown> = {};
  const configUpdate = vi.fn();
  sidebar.host = {
    deskAlerts: host.deskAlerts,
    workspaceRoot: () => "/workspace",
    getConfiguration: () => ({ get: () => config.enabled, update: configUpdate }),
    revealChatView: vi.fn(),
  };
  sidebar.state = {
    get: (key: string, fallback: any) => data[key] ?? fallback,
    update: (key: string, value: unknown) => { data[key] = value; },
  };
  sidebar.resolveLocalRepoTarget = () => ({ label: "Test Project" });
  sidebar.focused = session;
  sidebar.view = { visible: false };
  sidebar.remoteClients = new RemoteClientState<Session>("/workspace");
  sidebar.remoteClients.ready("phone");
  sidebar.remoteClients.setActive("phone", session);
  sidebar.captureRemoteRequester = vi.fn();
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.pendingTurnDiffCaptures = new Map();
  sidebar.setStatus = vi.fn((s: Session, status: Session["status"]) => { s.status = status; });
  sidebar.touch = vi.fn();
  sidebar.refreshKeepAwake = vi.fn();
  sidebar.closeDiffForRequest = vi.fn();
  sidebar.armCancelRecovery = vi.fn();
  sidebar.openSession = vi.fn();
  sidebar.markRead = vi.fn();
  const request = (tool: Partial<PermissionRequest["toolCall"]> = {}, requestOptions = options, id = 1) => {
    sidebar.handlePermissionRequest(session, session.client, {
      id,
      toolCall: { title: "Shell", kind: "execute", toolCallId: `tool-${id}`, rawInput: { command: "npm test" }, ...tool },
      options: requestOptions,
    }, session.cwd);
  };
  const answer = (optionId = "once", origin: "local" | "remote" = "local") =>
    sidebar.onMessage({ type: "permissionAnswer", requestId: 1, optionId }, origin, origin === "remote" ? "phone" : undefined);
  return { sidebar, session, request, answer, written, config, data, connect, configUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
  vscode.state.focused = true;
  vscode.showInformationMessage.mockReset();
  vscode.showErrorMessage.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("when to show a live desk alert", () => {
  it("skips a focused editor showing this conversation", () => {
    const h = harness();
    h.sidebar.view.visible = true;
    h.request();
    expect(vscode.showInformationMessage).not.toHaveBeenCalled();
    expect(h.session.pendingPermissions.has(1)).toBe(true);
  });

  it("shows the complete command when the chat is hidden", () => {
    const h = harness();
    const command = `npm ${"x".repeat(116)}`;
    h.request({ rawInput: { command } });
    expect(vscode.showInformationMessage).toHaveBeenCalledOnce();
    expect(vscode.showInformationMessage).toHaveBeenCalledWith(
      `Permission needed · ${providerDisplayName(h.session.provider)} shell command: “${command}” · Test Project · Investigate the build`,
      "Open", "Approve once",
    );
  });

  it("opens the session named in the alert while another conversation is visible", async () => {
    const h = harness();
    h.sidebar.view.visible = true;
    h.sidebar.focused = new Session();
    vscode.showInformationMessage.mockResolvedValueOnce("Open");
    h.request();
    await vi.waitFor(() => expect(h.sidebar.host.revealChatView).toHaveBeenCalledOnce());
    expect(h.sidebar.openSession).toHaveBeenCalledWith("conversation-id", "/workspace");
    expect(h.written).toEqual([]);
  });

  it("alerts when the editor window loses focus even if the chat is visible", () => {
    const h = harness();
    h.sidebar.view.visible = true;
    vscode.state.focused = false;
    h.request();
    expect(vscode.showInformationMessage).toHaveBeenCalledOnce();
  });

  it.each(["replay", "setting off", "cloud host", "startup"])("stays silent during %s", (reason) => {
    const h = harness();
    if (reason === "replay") h.session.replaying = true;
    if (reason === "setting off") h.config.enabled = false;
    if (reason === "cloud host") vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    if (reason === "startup") h.session.priming = true;
    h.request();
    h.sidebar.noteLiveTurnEnded(h.session, {}, "done");
    h.sidebar.noteLiveTurnEnded(h.session, {}, "error");
    expect(vscode.showInformationMessage).not.toHaveBeenCalled();
    expect(vscode.showErrorMessage).not.toHaveBeenCalled();
  });

  it("shows the two live turn outcomes with Open", () => {
    const h = harness();
    h.sidebar.noteLiveTurnEnded(h.session, {}, "done");
    h.sidebar.noteLiveTurnEnded(h.session, {}, "error");
    expect(vscode.showInformationMessage).toHaveBeenCalledWith("Turn finished · Test Project · Investigate the build", "Open");
    expect(vscode.showErrorMessage).toHaveBeenCalledWith("Turn failed · Test Project · Investigate the build", "Open");
  });

  it("ignores the outcome that comes back after Stop", async () => {
    const { sidebar, session } = harness();
    const turn = beginTurn(session);
    await sidebar.onMessage({ type: "cancel" }, "local");
    endTurn(session, turn);
    sidebar.noteLiveTurnEnded(session, turn, "done");
    expect(vscode.showInformationMessage).not.toHaveBeenCalled();
  });

  it("stores the settings toggle globally", async () => {
    const h = harness();
    await h.sidebar.onMessage({ type: "setDeskAlerts", value: false }, "local");
    expect(h.configUpdate.mock.calls).toEqual([["deskAlerts", false, "global"]]);
  });
});

describe("Approve once eligibility", () => {
  it.each([
    ["multiple lines", "npm test\nnpm run build"],
    ["over the length limit", `npm ${"x".repeat(117)}`],
    ["AND", "npm test && npm run build"],
    ["semicolon", "npm test; pwd"],
    ["trailing semicolon", "npm test;"],
    ["pipe", "npm test | cat"],
    ["subshell", "(npm test)"],
    ["shell wrapper", "bash -c 'npm test'"],
    ["redirection accepted by the grant parser", "npm test >/dev/null"],
    ["unparseable", 'npm "test'],
    ["collapsed whitespace", "npm  test"],
    ["nonprinting Unicode", "npm \u202Etest"],
  ])("offers Open only for %s", (_reason, command) => {
    const h = harness();
    h.request({ rawInput: { command } });
    expect(vscode.showInformationMessage.mock.calls).toEqual([["Permission needed · Test Project · Investigate the build", "Open"]]);
  });

  it.each([
    ["network access", { command: "npm install", url: "https://registry.npmjs.org" }],
    ["a wider sandbox", { command: "npm test", additionalPermissions: { fileSystem: { write: ["/"] } } }],
    ["no sandbox", { command: "npm test", dangerouslyDisableSandbox: true }],
  ])("offers Open only when the request also asks for %s", (_reason, rawInput) => {
    const h = harness();
    h.request({ rawInput });
    expect(vscode.showInformationMessage.mock.calls).toEqual([["Permission needed · Test Project · Investigate the build", "Open"]]);
  });

  it.each([
    ["Claude", { command: "npm test", description: "Run the tests" }],
    ["Grok", { variant: "Bash", command: "npm test", is_background: false }],
    ["Codex", { command: "npm test", cwd: "/workspace" }],
  ])("offers Approve once for a plain %s command", (_agent, rawInput) => {
    const h = harness();
    h.request({ rawInput });
    expect(vscode.showInformationMessage.mock.calls[0]).toContain("Approve once");
  });

  it.each([
    { kind: "edit", title: "Edit file" },
    { kind: "other", title: "mcp__server__tool" },
    { kind: "execute", title: "mcp__server__tool" },
    { kind: "fetch", title: "Fetch page" },
    { kind: "execute", title: "WebFetch" },
    { kind: "read", title: "Read file" },
    { kind: "switch_mode", title: "Implement plan" },
  ])("offers Open only for $title ($kind)", (tool) => {
    const h = harness();
    h.request(tool);
    const title = tool.kind === "switch_mode" ? "Plan ready for review" : "Permission needed";
    expect(vscode.showInformationMessage.mock.calls).toEqual([[`${title} · Test Project · Investigate the build`, "Open"]]);
  });

  it("offers Open only in Plan mode, even for a command the card can allow", () => {
    const h = harness();
    Object.assign(h.session.client!, { planActive: true });
    h.request({ rawInput: { command: "pwd" } });
    expect(vscode.showInformationMessage.mock.calls).toEqual([["Permission needed · Test Project · Investigate the build", "Open"]]);
    expect(h.session.pendingPermissions.has(1)).toBe(true);
  });

  it("offers Open for question and native plan review cards", async () => {
    const h = harness();
    h.sidebar.createPlanReviewSnapshot = vi.fn();
    h.sidebar.postQuestionRequest(h.session, { id: 2, questions: [{ question: "What next?" }] });
    await h.sidebar.postExitPlanRequest({ id: 3, plan: "Steps" }, h.session, h.session.gen);
    expect(vscode.showInformationMessage.mock.calls).toEqual([
      ["Question needs an answer · Test Project · Investigate the build", "Open"],
      ["Plan ready for review · Test Project · Investigate the build", "Open"],
    ]);
  });

  it.each([
    [],
    [{ ...options[1], _meta: { scope: "session" } }],
    [options[1], { ...options[1], optionId: "another" }],
    [options[1], { ...options[2], optionId: "once" }],
  ].map((entries) => [entries]))("requires one unambiguous once option (%j)", (requestOptions) => {
    const h = harness();
    h.request({}, requestOptions);
    expect(vscode.showInformationMessage.mock.calls).toEqual([["Permission needed · Test Project · Investigate the build", "Open"]]);
  });
});

describe("settling the request", () => {
  function holdApproval() {
    let choose!: (action: string) => void;
    vscode.showInformationMessage.mockImplementationOnce(() => new Promise((resolve) => { choose = resolve; }));
    return () => choose("Approve once");
  }

  it("writes once, collapses both surfaces, persists, closes the diff and waits for the other card", async () => {
    const h = harness();
    const chat = bootWebview();
    const phone = bootWebview({ remote: true });
    h.sidebar.view.webview = { postMessage: (msg: Posted) => dispatch(chat.window, msg) };
    h.sidebar.sendRemoteSession.mockImplementation((_session: Session, msg: Posted) => dispatch(phone.window, msg));
    const approve = holdApproval();
    h.request();
    h.sidebar.postQuestionRequest(h.session, { id: 2, questions: [{ question: "What next?" }] });
    expect(h.session.pendingPermissions.get(1)?.commandGrant).toBeDefined();
    for (const surface of [chat, phone]) expect(surface.doc.querySelector(".card.permission button")).toBeTruthy();
    approve();
    await vi.waitFor(() => expect(h.written).toEqual([{ jsonrpc: "2.0", id: 1, result: { outcome: { outcome: "selected", optionId: "once" } } }]));
    expect(h.session.allowedCommandPrograms.size).toBe(0);
    expect(h.session.pendingPermissions.size).toBe(0);
    expect(h.session.buffer).toContainEqual({ type: "permissionResolved", requestId: 1, optionId: "once" });
    expect(JSON.stringify(h.data)).toContain('"outcome":"allowed"');
    expect(h.sidebar.closeDiffForRequest.mock.calls).toEqual([[h.session, 1]]);
    expect(h.session.status).toBe("needs-you");
    for (const surface of [chat, phone]) expect(surface.doc.querySelector(".card.permission button")).toBeNull();
  });

  it.each(["desk answer", "phone answer", "cancelled request", "Stop", "turn ended", "connection replacement", "request replacement", "entered Plan"])(
    "refuses a stale click after %s", async (reason) => {
      const h = harness();
      const approve = holdApproval();
      const turn = beginTurn(h.session);
      h.request();
      if (reason === "desk answer") await h.answer();
      if (reason === "phone answer") await h.answer("once", "remote");
      if (reason === "cancelled request") h.sidebar.clearPendingHumanRequests(h.session);
      if (reason === "Stop") await h.sidebar.onMessage({ type: "cancel" }, "local");
      if (reason === "turn ended") {
        endTurn(h.session, turn);
        h.sidebar.noteLiveTurnEnded(h.session, turn, "done");
      }
      if (reason === "entered Plan") Object.assign(h.session.client!, { planActive: true });
      if (reason === "connection replacement") {
        h.sidebar.clearPendingHumanRequests(h.session);
        h.session.gen++;
        h.connect();
        h.request();
      }
      if (reason === "request replacement") h.request();
      const before = [...h.written];
      approve();
      await vi.waitFor(() => expect(vscode.showInformationMessage).toHaveBeenLastCalledWith(stale));
      expect(h.written).toEqual(before);
      expect(h.session.allowedCommandPrograms.size).toBe(0);
    },
  );

  it("preserves the card's session grant and keeps auto-granted requests quiet", async () => {
    const h = harness();
    h.request();
    await h.answer(h.session.pendingPermissions.get(1)!.commandGrant!.optionId);
    expect(h.session.allowedCommandPrograms.has("npm")).toBe(true);
    expect(h.session.status).toBe("working");
    expect(h.written[0].result.outcome.optionId).toBe("once");
    h.request({ rawInput: { command: "npm run check" } }, options, 2);
    expect(h.written[1].result.outcome.optionId).toBe("once");
    expect(vscode.showInformationMessage).toHaveBeenCalledOnce();
    expect(h.session.pendingPermissions.size).toBe(0);
  });

  it("keeps Auto accept quiet", () => {
    const h = harness();
    h.session.autoApprove = true;
    h.request();
    expect(h.written[0].result.outcome.optionId).toBe("always");
    expect(h.session.pendingPermissions.size).toBe(0);
    expect(vscode.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe("native desktop delivery", () => {
  it.each(["win32", "darwin"])("shows silent clickable alerts on %s even if hidden or minimized", async (platform) => {
    const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true };
    const showWindow = vi.fn();
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let host: Host;
    try {
      Object.defineProperty(process, "platform", { value: platform });
      host = createElectronHost({ config: {} as any, getWindow: () => window as any, showWindow, log() {} });
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    const h = harness(host);
    h.request();
    expect(native.show).not.toHaveBeenCalled();
    window.isVisible = () => false;
    h.request();
    window.isVisible = () => true;
    window.isMinimized = () => true;
    h.sidebar.noteLiveTurnEnded(h.session, {}, "done");
    window.isMinimized = () => false;
    window.isFocused = () => false;
    h.sidebar.noteLiveTurnEnded(h.session, {}, "error");
    expect(native.show.mock.calls.map(([notice]) => notice.options)).toEqual([
      { title: "Permission needed", body: "Test Project · Investigate the build", silent: true },
      { title: "Turn finished", body: "Test Project · Investigate the build", silent: true },
      { title: "Turn failed", body: "Test Project · Investigate the build", silent: true },
    ]);
    h.sidebar.focused = new Session();
    native.show.mock.calls[0][0].emit("click");
    await vi.waitFor(() => expect(h.sidebar.host.revealChatView).toHaveBeenCalledOnce());
    expect(showWindow).toHaveBeenCalledOnce();
    expect(h.sidebar.openSession).toHaveBeenCalledWith("conversation-id", "/workspace");
    expect(h.written).toEqual([]);

    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    h.request();
    expect(native.show).toHaveBeenCalledTimes(3);
  });
});
