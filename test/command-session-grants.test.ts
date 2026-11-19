import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { GrokSidebar } from "../src/sidebar";
import { Session, pendingPermissionOptions, sessionUiSnapshot } from "../src/session";
import { commandProgramsForGrant, permissionAnswerAllowed, type ShellDialect } from "../src/plan-gate";
import { resolvedTerminalShellDialect } from "../src/terminal-manager";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { defaultPermissionIndex, orderPermissionOptions } from "../media/webview-helpers.js";
import { bootWebview, dispatch } from "./webview-harness";

vi.mock("../src/terminal-manager", async (original) => ({
  ...await original<typeof import("../src/terminal-manager")>(),
  resolvedTerminalShellDialect: vi.fn(() => "posix"),
}));

const CLI_OPTIONS = [
  { optionId: "cli-always", kind: "allow_always", name: "Yes, don't ask again" },
  { optionId: "cli-once", kind: "allow_once", name: "Yes" },
  { optionId: "cli-no", kind: "reject_once", name: "No" },
  { optionId: "cli-never", kind: "reject_always", name: "No, never ask again" },
];

function harness() {
  const session = new Session();
  const client = new AcpClient({ cliPath: "unused", cwd: "/workspace", log: () => {} });
  const written: any[] = [];
  (client as any).proc = { killed: false, stdin: { writable: true, write: (line: string) => written.push(JSON.parse(line)) } };
  (client as any).sessionId = "s1";
  vi.spyOn(client, "setHumanWaitActive");
  session.client = client;
  session.status = "working";
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = session;
  sidebar.emit = vi.fn((owner: Session, msg: any) => owner.buffer.push(msg));
  sidebar.setStatus = vi.fn((owner: Session, status: any) => { owner.status = status; });
  const data: Record<string, any> = {};
  sidebar.state = { get: (key: string, fallback: any) => data[key] ?? fallback, update: vi.fn(async (key: string, value: any) => { data[key] = value; }) };
  sidebar.openDiffsByRequest = { take: () => undefined };
  sidebar.host = { workspaceRoot: () => "/workspace" };
  sidebar.sendRemoteSession = vi.fn();
  const request = (command: unknown = "npm test", id = 1, kind = "execute", options = CLI_OPTIONS, rawExtra = {}) => {
    const req = { id, toolCall: { kind, toolCallId: `tool-${id}`, title: "Shell", rawInput: { command, ...rawExtra } }, options };
    sidebar.handlePermissionRequest(session, client, req, "/workspace");
    return req;
  };
  const answer = (optionId: string, requestId = 1) => sidebar.onMessage({ type: "permissionAnswer", requestId, optionId }, "local");
  const grantOption = (id = 1) => session.pendingPermissions.get(id)?.options.find((o) => o.kind === "allow_always");
  const reply = (id: number) => written.find((m) => m.id === id)?.result?.outcome;
  const clearSignals = () => { session.buffer = []; sidebar.setStatus.mockClear(); vi.mocked(client.setHumanWaitActive).mockClear(); };
  return { session, client, sidebar, request, answer, grantOption, reply, clearSignals, data };
}

it("asks again in Ask for approval even for a command granted in Agent mode", () => {
  const h = harness();
  h.session.provider = "codex";
  h.session.allowedCommandPrograms.add("npm");
  h.client.currentModeId = "askApproval";
  h.request();
  expect(h.reply(1)).toBeUndefined();
  expect(h.session.pendingPermissions.get(1)?.options.map(option => option.optionId)).toEqual(["cli-once", "cli-no"]);
});

describe.each<ShellDialect>(["posix", "powershell", "cmd"])("session program grammar: %s", (dialect) => {
  it("extracts every stage and ignores arguments", () => {
    expect(commandProgramsForGrant("npm test", dialect)).toEqual(["npm"]);
    expect(commandProgramsForGrant("npm run build --silent", dialect)).toEqual(["npm"]);
    expect(commandProgramsForGrant("cd a && npm t", dialect)).toEqual(["cd", "npm"]);
    expect(commandProgramsForGrant("npm test && rm -rf /", dialect)).toEqual(["npm", "rm"]);
    expect(commandProgramsForGrant("dotnet test | pwsh -c exit", dialect)).toEqual(["dotnet", "pwsh"]);
    expect(commandProgramsForGrant("Get-ChildItem .", dialect)).toEqual(["Get-ChildItem"]);
    expect(commandProgramsForGrant('"npm" test', dialect)).toEqual(["npm"]);
  });

  it.each(["npm $(evil)", "npm test > out.txt", 'npm "unterminated', "npm test\nrm x", "npm 'line\nbreak'", "", "  ", '"" x', "n* test", "npm test &&", "npm < in.txt"])("fails closed: %j", (command) => {
    expect(commandProgramsForGrant(command, dialect)).toBeUndefined();
  });

  it("normalizes dialect escapes without guessing executable aliases or basenames", () => {
    const escaped = dialect === "posix" ? "n\\pm" : dialect === "powershell" ? "n`pm" : "n^pm";
    expect(commandProgramsForGrant(`${escaped} test`, dialect)).toEqual(["npm"]);
    expect(commandProgramsForGrant("./npm test", dialect)).toEqual(["./npm"]);
  });
});

describe("host-owned session command grants", () => {
  it("fails closed on POSIX assignment prefixes instead of granting a variable name", () => {
    expect(commandProgramsForGrant("FOO=1 npm test", "posix")).toBeUndefined();
    expect(commandProgramsForGrant("FOO=1 rm -rf /", "posix")).toBeUndefined();
  });

  it.each(["posix", "powershell", "cmd"] as const)("round trips the grant through allow_once and matches every segment (%s)", async (dialect) => {
    vi.mocked(resolvedTerminalShellDialect).mockReturnValue(dialect);
    const h = harness();
    h.request();
    expect(h.reply(1)).toBeUndefined();
    expect(h.session.allowedCommandPrograms.size).toBe(0);
    expect(h.grantOption()?.name).toBe('Yes, and allow "npm" this session');
    await h.answer(h.grantOption()!.optionId);
    expect(h.reply(1)).toEqual({ outcome: "selected", optionId: "cli-once" });
    h.clearSignals();
    h.request("npm run build --silent", 2);
    expect(h.reply(2)).toEqual({ outcome: "selected", optionId: "cli-once" });
    expect(h.session.pendingPermissions.size).toBe(0);
    expect(h.sidebar.setStatus).not.toHaveBeenCalled();
    expect(h.client.setHumanWaitActive).not.toHaveBeenCalledWith(true);
    h.request("npm test && rm -rf /", 3);
    expect(h.reply(3)).toBeUndefined();
    expect(h.grantOption(3)?.name).toBe('Yes, and allow "rm" this session');
    expect(h.session.pendingPermissions.has(3)).toBe(true);
    h.request("cd a && npm t", 4);
    expect(h.reply(4)).toBeUndefined();
    await h.answer(h.grantOption(4)!.optionId, 4);
    h.request("cd b && npm run build", 5);
    expect(h.reply(5)?.optionId).toBe("cli-once");
  });

  it.each(["cli-once", "cli-no"])("a plain %s answer never grants a program", async (id) => {
    const h = harness();
    h.request();
    await h.answer(id);
    h.request("npm test", 2);
    expect(h.reply(2)).toBeUndefined();
    expect(h.session.allowedCommandPrograms.size).toBe(0);
  });

  it("pool sessions and a fresh instance of the same saved conversation inherit nothing", async () => {
    const first = harness();
    first.request();
    await first.answer(first.grantOption()!.optionId);
    const second = harness();
    const loaded = harness();
    loaded.session.activeSessionId = first.client.sessionId;
    const pool = new Set([first.session, second.session, loaded.session]);
    expect(pool.size).toBe(3);
    for (const h of [second, loaded]) {
      h.request();
      expect(h.reply(1)).toBeUndefined();
      expect(h.session.allowedCommandPrograms.size).toBe(0);
    }
  });

  it.each(["execute", "edit", "read", "future-tool"])("simplifies %s by kind and preserves the CLI's one-time labels", (kind) => {
    const h = harness();
    h.request("npm test", 1, kind);
    const opts = h.session.pendingPermissions.get(1)!.options;
    expect(opts).toHaveLength(3);
    expect(opts).toContainEqual(CLI_OPTIONS[1]);
    expect(opts).toContainEqual(CLI_OPTIONS[2]);
    expect(opts.some((o) => o.kind === "reject_always")).toBe(false);
    expect(opts.some((o) => o.optionId === "cli-always")).toBe(kind !== "execute");
    if (kind === "execute") {
      const grant = opts.find((o) => o.name === 'Yes, and allow "npm" this session')!;
      expect(grant.kind).toBe("allow_always");
      expect(defaultPermissionIndex([grant])).toBe(-1);
    }
    const ordered = orderPermissionOptions(opts);
    expect(ordered[defaultPermissionIndex(ordered)].optionId).toBe("cli-once");
    expect(defaultPermissionIndex(opts.filter((o) => o.kind === "allow_always"))).toBe(-1);
  });

  it("passes through an unknown option kind and does not depend on CLI wording", () => {
    const h = harness();
    const future = { optionId: "future", kind: "future", name: "No, never ask again" };
    h.request("npm test", 1, "execute", [...CLI_OPTIONS.map((o) => ({ ...o, name: "drifted label" })), future]);
    expect(h.session.pendingPermissions.get(1)!.options).toContainEqual(future);
    h.request("npm test", 2, "execute", CLI_OPTIONS.filter((o) => o.kind !== "reject_always"));
    expect(h.session.pendingPermissions.get(2)!.options).toHaveLength(3);
  });

  it.each([undefined, "", " ", 12, "npm $(evil)", "npm t > out.txt", 'npm "oops', "npm t\nrm x", "a && b && c && d"])("does not offer or match an ungrantable command: %j", (command) => {
    const h = harness();
    h.session.allowedCommandPrograms.add("npm");
    h.request(command, 1, "execute", CLI_OPTIONS, { command });
    expect(h.grantOption()).toBeUndefined();
    expect(h.reply(1)).toBeUndefined();
  });

  it("leaves Muse's own persistent choice alone and adds no host grant", async () => {
    const h = harness();
    h.session.provider = "muse";
    h.request();
    // The CLI's own allow_always survives -- it is the card's Save rule, and
    // dropping it took away a choice that works. Ours is never offered,
    // because answering it would send a single allow under a session label.
    const options = h.session.pendingPermissions.get(1)!.options;
    expect(options.map((o) => o.optionId)).toEqual(["cli-always", "cli-once", "cli-no"]);
    // And the grant that is never read is never written either.
    await h.answer("cli-always");
    expect(h.session.allowedCommandPrograms.size).toBe(0);
    h.request("npm test", 2);
    expect(h.reply(2)).toBeUndefined();
  });

  it("offers at most three distinct new programs and names only the missing ones", () => {
    const h = harness();
    h.request("npm t && npm run build && cd a && dotnet test");
    expect(h.grantOption()?.name).toBe('Yes, and allow "npm", "cd", "dotnet" this session');
    h.session.allowedCommandPrograms.add("npm");
    h.request("npm t && cd a && dotnet test && pwsh -c exit", 2);
    expect(h.grantOption(2)?.name).toBe('Yes, and allow "cd", "dotnet", "pwsh" this session');
  });

  it("requires a real allow_once even for a granted program and ignores is_background", async () => {
    const h = harness();
    h.request();
    await h.answer(h.grantOption()!.optionId);
    h.request("npm test", 2, "execute", CLI_OPTIONS, { is_background: true });
    expect(h.reply(2)?.optionId).toBe("cli-once");
    h.request("npm test", 3, "execute", CLI_OPTIONS.filter((o) => o.kind !== "allow_once"));
    expect(h.reply(3)).toBeUndefined();
    expect(h.grantOption(3)).toBeUndefined();
  });

  it("rejects stale, forged and failed-write answers without granting anything", async () => {
    const h = harness();
    h.request();
    const grant = h.grantOption()!;
    await h.answer("cli-always");
    await h.answer(grant.optionId, 999);
    expect(h.reply(1)).toBeUndefined();
    (h.client as any).proc.killed = true;
    await h.answer(grant.optionId);
    expect(h.session.allowedCommandPrograms.size).toBe(0);
    expect(h.session.pendingPermissions.has(1)).toBe(true);
  });

  it("namespaces ids without collisions and crosses the unchanged desktop validator", async () => {
    const h = harness();
    h.request();
    const collidingId = h.grantOption()!.optionId;
    h.request("npm test", 2, "execute", [...CLI_OPTIONS, { optionId: collidingId, kind: "future", name: "Future" }]);
    const id = h.grantOption(2)!.optionId;
    expect(id).not.toBe(collidingId);
    const msg = { type: "permissionAnswer", requestId: 2, optionId: id };
    expect(parseWebviewMsg(msg)).toEqual(msg);
    await h.sidebar.onMessage(parseWebviewMsg(msg), "local");
    expect(h.reply(2)?.optionId).toBe("cli-once");
  });

  it("the existing Plan filters remove/refuse our option, including a stale Agent card", async () => {
    const h = harness();
    h.request("echo probe");
    const pending = h.session.pendingPermissions.get(1)!;
    const id = h.grantOption()!.optionId;
    expect(permissionAnswerAllowed(pending.options, id, true, "execute")).toBe(false);
    expect(pendingPermissionOptions(pending, true).some((o) => o.optionId === id)).toBe(false);
    h.session.planActive = h.client.planActive = true;
    await h.answer(id);
    expect(h.reply(1)).toBeUndefined();
    expect(h.session.allowedCommandPrograms.size).toBe(0);
    h.request("echo another", 2);
    const card = h.session.buffer.find((m) => m.type === "permissionRequest" && m.req.id === 2) as any;
    expect(card.req.options.map((o: any) => o.kind)).toEqual(["allow_once", "reject_once"]);
  });

  it("a grant cannot bypass Plan or its rejection, even with Auto accept on", () => {
    const h = harness();
    h.session.allowedCommandPrograms.add("echo");
    h.session.allowedCommandPrograms.add("npm");
    h.session.planActive = h.client.planActive = true;
    h.session.autoApprove = true;
    h.request("echo probe");
    expect(h.reply(1)).toBeUndefined();
    expect(h.session.pendingPermissions.has(1)).toBe(true);
    h.request("npm install", 2);
    expect(h.reply(2)?.optionId).toBe("cli-no");
    expect(h.session.pendingPermissions.has(2)).toBe(false);
  });

  it("Auto accept takes precedence and resolving its pending cards cannot send our id or create a grant", () => {
    const h = harness();
    h.request();
    h.sidebar.autoApprovePendingPermissions(h.session);
    expect(h.reply(1)?.optionId).toBe("cli-once");
    expect(h.session.allowedCommandPrograms.size).toBe(0);
    h.session.autoApprove = true;
    h.session.allowedCommandPrograms.add("npm");
    h.request("npm test", 2);
    expect(h.reply(2)?.optionId).toBe("cli-always");
  });

  it("re-focus uses existing permissionOptions with the same host-owned id", () => {
    const h = harness();
    h.request();
    const id = h.grantOption()!.optionId;
    const snapshot = sessionUiSnapshot(h.session, "agent");
    expect(snapshot).toContainEqual({ type: "permissionOptions", requestId: 1, options: pendingPermissionOptions(h.session.pendingPermissions.get(1)!, false) });
    expect((snapshot.find((m) => m.type === "permissionOptions") as any).options.some((o: any) => o.optionId === id)).toBe(true);
  });

  it.each([false, true])("the unchanged renderer draws three buttons and posts our id (remote=%s)", async (remote) => {
    const h = harness();
    const { window, doc, posted } = bootWebview({ remote });
    h.request();
    for (const msg of h.session.buffer) dispatch(window, msg);
    const buttons = [...doc.querySelectorAll(".card.permission .card-actions button")] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(["Yes", 'Yes, and allow "npm" this session', "No"]);
    expect(doc.activeElement).toBe(buttons[0]);
    expect(buttons[1].tabIndex).toBe(-1);
    buttons[1].click();
    const answer = posted.find((m: any) => m.type === "permissionAnswer")!;
    expect(answer).toEqual({ type: "permissionAnswer", requestId: 1, optionId: h.grantOption()!.optionId });
    await h.sidebar.onMessage(parseWebviewMsg(answer), "local");
    expect(h.reply(1)?.optionId).toBe("cli-once");
  });

  it.each([false, true])("auto-approval stays visible, collapsed and replayable without human wait (remote=%s)", async (remote) => {
    const h = harness();
    h.request();
    await h.answer(h.grantOption()!.optionId);
    h.clearSignals();
    h.request("npm run build --silent", 2);
    expect(h.session.buffer.map((m) => m.type)).toEqual(["historyBatch"]);
    const live = bootWebview({ remote });
    const input = live.doc.querySelector("#input") as HTMLTextAreaElement;
    input.focus();
    for (const msg of h.session.buffer) dispatch(live.window, msg);
    const card = live.doc.querySelector(".card.permission.perm-resolved")!;
    expect(card.textContent).toContain("npm run build --silent — auto-approved for this session");
    expect(card.querySelector("button")).toBeNull();
    expect(live.doc.querySelector(".card.permission:not(.perm-resolved)")).toBeNull();
    expect(live.doc.activeElement).toBe(input);
    expect(h.session.status).toBe("working");
    expect(h.sidebar.setStatus).not.toHaveBeenCalledWith(h.session, "needs-you");
    expect(h.client.setHumanWaitActive).not.toHaveBeenCalledWith(true);
    expect(h.session.pendingPermissions.size).toBe(0);

    // Warm replay is the exact buffered legacy request/resolution batch.
    const warm = bootWebview({ remote });
    dispatch(warm.window, { type: "historyReplay", active: true });
    for (const msg of h.session.buffer) dispatch(warm.window, msg);
    dispatch(warm.window, { type: "historyReplay", active: false });
    expect(warm.doc.querySelectorAll(".perm-resolved")).toHaveLength(1);

    // Cold replay uses the same persisted entries as a hand answer; its title
    // carries the audit distinction without a new protocol value or renderer.
    const saved = Object.values(h.data).flatMap((v: any) => v.s1?.permissions ?? []);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({ title: "npm run build --silent — auto-approved for this session", outcome: "allowed", toolCallId: "tool-2" });
    const cold = bootWebview({ remote });
    dispatch(cold.window, { type: "permissionHistoryQueue", permissions: saved });
    dispatch(cold.window, { type: "historyReplay", active: true });
    dispatch(cold.window, { type: "toolCall", call: { toolCallId: "tool-2", kind: "execute", title: "Shell" } });
    dispatch(cold.window, { type: "historyReplay", active: false });
    expect(cold.doc.querySelectorAll(".perm-resolved")).toHaveLength(2);
    expect(cold.doc.querySelector("#messages")!.textContent).toContain(saved[1].title);
    expect(cold.doc.querySelector(".card.permission button")).toBeNull();
  });
});
