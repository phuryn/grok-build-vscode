import { describe, expect, it, vi } from "vitest";
import { permissionOptions } from "../adapters/muse/approvals.mts";
import { GrokSidebar } from "../src/sidebar";
import { createPendingPermission, Session } from "../src/session";
import { sessionModes } from "../src/mode-prefs";
import {
  INBOUND_DISPOSITION,
  OUTBOUND_DISPOSITION,
  OUTBOUND_PROJECT_AUTH,
  transformHostMsgForRemote,
} from "../src/remote-policy";

const once = { choiceId: "minted_once", label: "Allow", scope: "once", decision: "approved" };
const sessionChoice = { choiceId: "minted_session", label: "Allow this session", scope: "session", decision: "approvedForSession" };
const persistent = { choiceId: "minted_save", label: "Save rule", scope: "localPersistent", decision: "approvedPolicyAmendment" };
const deny = { choiceId: "minted_deny", label: "Deny", scope: "once", decision: "denied" };

function museOptions(...choices: Array<typeof once>) {
  return permissionOptions(choices);
}

function harness(remembered = "") {
  const session = new Session();
  session.provider = "muse";
  session.cwd = "/repo";
  session.priming = false;
  session.planModeAvailable = false;
  session.planModeVersionVerified = true;
  const answered: Array<{ id: number | string; optionId: string }> = [];
  const setMode = vi.fn(async (mode: string) => { session.client!.currentModeId = mode; });
  session.client = {
    sessionId: "s1",
    planActive: false,
    usesClientPlanGate: false,
    setMode,
    dispose: vi.fn(async () => {}),
    setHumanWaitActive: vi.fn(),
    respondPermission: (id: number | string, optionId: string) => {
      answered.push({ id, optionId });
      return true;
    },
  } as any;
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.pendingConfirms = new Map();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.stopVoiceInput = vi.fn();
  sidebar.setStatus = vi.fn();
  sidebar.touch = vi.fn();
  sidebar.refreshKeepAwake = vi.fn();
  sidebar.openDiffsByRequest = { take: () => undefined };
  const stored: Record<string, unknown> = {};
  sidebar.state = {
    get: (key: string, fallback: unknown) => Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : fallback,
    update: vi.fn(async (key: string, value: unknown) => { stored[key] = value; }),
  };
  sidebar.confirmRepoForcedAutoApprove = vi.fn(async () => true);
  sidebar.configForcesAutoApprove = vi.fn(() => false);
  sidebar.connectedProviders = () => ["grok", "muse"];
  sidebar.usableProviders = () => ["grok", "muse"];
  sidebar.locateProvider = () => undefined;
  sidebar.workspaceRoot = () => "/repo";
  const configUpdate = vi.fn(async () => {});
  sidebar.host = {
    canSwitchWorkspaceFolder: false,
    appendLine: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => key === "defaultMode" ? remembered : fallback,
      inspect: () => undefined,
      update: configUpdate,
    }),
  };
  const modeMessages = () => sidebar.sendRemoteSession.mock.calls
    .map((call: any[]) => call[1])
    .filter((message: any) => message?.type === "modeChanged");
  return { session, sidebar, answered, setMode, configUpdate, modeMessages };
}

describe("Muse mode switch", () => {
  it("writes Muse Settings to host config without modifying a live conversation", async () => {
    const { sidebar, session, configUpdate, setMode } = harness();
    for (const [key, value] of [["museShellSandbox", false], ["museSandboxNetwork", "restricted"], ["museTrustWorkspaces", true]]) {
      await sidebar.onSettingsPanelMessage({ type: "setMuseSetting", key, value });
      expect(configUpdate).toHaveBeenLastCalledWith(key, value, "global");
    }
    expect(session.autoApprove).toBe(false);
    expect(setMode).not.toHaveBeenCalled();
  });
  it("switches Agent and Auto accept natively without restarting", async () => {
    const { session, sidebar, setMode, configUpdate, modeMessages } = harness();

    await sidebar.setMode("yolo", session);
    expect(session.autoApprove).toBe(true);
    expect(sidebar.displayMode(session)).toBe("yolo");
    expect(setMode).toHaveBeenLastCalledWith("yolo");
    expect(session.client!.dispose).not.toHaveBeenCalled();
    expect(sidebar.host.showErrorMessage).not.toHaveBeenCalled();
    expect(configUpdate).toHaveBeenCalledWith("defaultMode", "yolo", "global");
    expect(modeMessages()).toEqual([
      { type: "modeChanged", modeId: "yolo", modes: ["agent", "yolo"] },
    ]);

    await sidebar.setMode("agent", session);
    expect(session.autoApprove).toBe(false);
    expect(sidebar.displayMode(session)).toBe("agent");
    expect(setMode).toHaveBeenLastCalledWith("agent");
    expect(sidebar.host.showErrorMessage).not.toHaveBeenCalled();
    expect(modeMessages().at(-1)).toEqual({
      type: "modeChanged", modeId: "agent", modes: ["agent", "yolo"],
    });
  });

  it("refuses Plan and leaves the mode unchanged", async () => {
    const { session, sidebar, setMode, configUpdate, modeMessages } = harness();
    session.autoApprove = true;

    await sidebar.setMode("plan", session);

    expect(session.autoApprove).toBe(true);
    expect(session.planActive).toBe(false);
    expect(sidebar.displayMode(session)).toBe("yolo");
    expect(setMode).not.toHaveBeenCalled();
    expect(configUpdate).not.toHaveBeenCalled();
    expect(modeMessages()).toEqual([]);
    expect(sidebar.host.showErrorMessage).not.toHaveBeenCalled();
    expect(sidebar.host.showWarningMessage).toHaveBeenCalledWith("Muse Code does not offer Plan mode.");
  });

  it("falls back to once-only approvals only when Muse did not accept native mode", async () => {
    const { session, sidebar, answered } = harness();
    vi.mocked(session.client!.setMode).mockRejectedValue(new Error("unsupported"));
    await sidebar.setMode("yolo", session);
    const widestFirst = museOptions(persistent, sessionChoice, once, deny);
    const noOnce = museOptions(persistent, sessionChoice, deny);
    session.autoApprove = true;
    session.pendingPermissions.set(4, createPendingPermission({
      title: "bash",
      toolKind: "execute",
      options: widestFirst,
    }));
    session.pendingPermissions.set(5, createPendingPermission({
      title: "bash",
      toolKind: "execute",
      options: noOnce,
    }));

    sidebar.autoApprovePendingPermissions(session);
    sidebar.handlePermissionRequest(session, session.client, {
      id: 6,
      sessionId: "s1",
      toolCall: { toolCallId: "live", kind: "execute", title: "echo hi" },
      options: widestFirst,
    }, "/repo");
    sidebar.handlePermissionRequest(session, session.client, {
      id: 7,
      sessionId: "s1",
      toolCall: { toolCallId: "live-wide", kind: "execute", title: "echo hi" },
      options: noOnce,
    }, "/repo");

    const forbidden = new Set([persistent.choiceId, sessionChoice.choiceId]);
    expect(answered.map((answer) => answer.optionId)).toEqual([once.choiceId, once.choiceId]);
    expect(answered.every((answer) => !forbidden.has(answer.optionId))).toBe(true);
    expect(session.pendingPermissions.has(5)).toBe(true);
    expect(session.pendingPermissions.has(7)).toBe(true);
    expect(answered).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 5 }),
      expect.objectContaining({ id: 7 }),
    ]));
  });

  it("leaves approvals raised in native full access to Muse, including pending cards", async () => {
    const { session, sidebar, answered } = harness();
    session.pendingPermissions.set(4, createPendingPermission({ title: "bash", toolKind: "execute", options: museOptions(once, deny) }));
    await sidebar.setMode("yolo", session);
    sidebar.handlePermissionRequest(session, session.client, {
      id: 6, sessionId: "s1", toolCall: { toolCallId: "live", kind: "execute", title: "echo hi" }, options: museOptions(once, deny),
    }, "/repo");
    expect(answered).toEqual([]);
    expect(session.pendingPermissions.size).toBe(2);
  });

  it("keeps native Auto accept visible when Muse refuses Agent", async () => {
    const { session, sidebar, setMode } = harness();
    await sidebar.setMode("yolo", session);
    setMode.mockRejectedValueOnce(new Error("refused"));
    await sidebar.setMode("agent", session);
    expect(session.autoApprove).toBe(true);
    expect(sidebar.host.showErrorMessage).toHaveBeenCalled();
  });

  it("still prefers allow_always for Grok", () => {
    const { session, sidebar, answered } = harness();
    session.provider = "grok";
    session.autoApprove = true;
    sidebar.handlePermissionRequest(session, session.client, {
      id: 1,
      sessionId: "s1",
      toolCall: { toolCallId: "edit", kind: "edit", title: "Edit" },
      options: [
        { optionId: "once", kind: "allow_once", name: "Once" },
        { optionId: "always", kind: "allow_always", name: "Always" },
      ],
    }, "/repo");
    expect(answered).toEqual([{ id: 1, optionId: "always" }]);
  });
});

describe("remembered Auto accept on session start", () => {
  it.each([
    ["muse", "yolo", undefined, true, "yolo"],
    ["muse", "yolo", "resume-1", false, "agent"],
    ["muse", "", undefined, false, "agent"],
    ["grok", "yolo", undefined, true, "yolo"],
    ["grok", "yolo", "resume-1", false, "agent"],
  ] as const)("%s remembered %j resume %s starts autoApprove=%s (%s)", async (provider, remembered, resumeId, autoApprove, modeId) => {
    const { session, sidebar, modeMessages } = harness(remembered);
    session.provider = provider;

    await sidebar.startSession(resumeId, session);

    expect(session.autoApprove).toBe(autoApprove);
    expect(modeMessages()[0]).toEqual({
      type: "modeChanged",
      modeId,
      modes: sessionModes(provider),
    });
  });
});

describe("modeChanged.modes on the relay", () => {
  it("needs no remote-policy change: setMode stays propose and the frame is mirrored whole", () => {
    expect(INBOUND_DISPOSITION.setMode).toBe("propose");
    expect(OUTBOUND_DISPOSITION.modeChanged).toBe("mirror");
    expect(OUTBOUND_PROJECT_AUTH.modeChanged).toBe("scope");
    const message = { type: "modeChanged" as const, modeId: "yolo", modes: ["agent", "yolo"] as Array<"agent" | "yolo"> };
    expect(transformHostMsgForRemote(message, {} as never)).toEqual(message);
  });
});
