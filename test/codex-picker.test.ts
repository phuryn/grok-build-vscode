import { describe, expect, it, vi } from "vitest";
import { AcpClient, type PermissionRequest } from "../src/acp";
import { CodexBackend } from "../src/codex-backend";
import { CODEX_ASK_APPROVAL_PREF_KEY } from "../src/mode-prefs";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function adapter(rejectPlan = false) {
  const client = new AcpClient({ cliPath: "unused", cwd: "/workspace", backend: new CodexBackend(), log: () => {} });
  const config: Record<string, string> = { mode: "agent", collaboration_mode: "default" };
  const configOptions = () => Object.entries(config).map(([id, currentValue]) => ({ id, currentValue }));
  const incoming = (message: object) => (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const written = vi.fn((line: string) => {
    const { id, method, params } = JSON.parse(line);
    const reply = (result: object) => incoming({ id, result });
    queueMicrotask(() => {
      switch (method) {
        case "session/new":
        case "session/load":
          reply({ sessionId: "session", configOptions: configOptions() });
          break;
        case "session/set_config_option":
          if (rejectPlan && params.configId === "collaboration_mode" && params.value === "plan") {
            incoming({ id, error: { code: -32602, message: "Plan unavailable" } });
            break;
          }
          config[params.configId] = params.value;
          reply({ configOptions: configOptions() });
          break;
        case "session/prompt": {
          const text = params.prompt[0].text;
          if (text === "/plan") {
            config.collaboration_mode = "plan";
            incoming({ method: "session/update", params: {
              sessionId: "session", update: { sessionUpdate: "config_option_update", configOptions: configOptions() },
            } });
          } else if (config.collaboration_mode === "plan") {
            incoming({ id: "review", method: "session/request_permission", params: {
              sessionId: "session",
              toolCall: { toolCallId: "plan", kind: "switch_mode", title: "Review plan", rawInput: { plan: "Check the inputs." } },
              options: [{ optionId: "revise_plan", kind: "reject_once", name: "Revise" }],
            } });
          }
          reply({ stopReason: "end_turn" });
          break;
        }
      }
    });
  });
  (client as any).proc = { killed: false, stdin: { writable: true, write: written } };
  return { client, config, written };
}

function pickerHost(client: AcpClient) {
  const session = new Session();
  session.provider = "codex";
  session.client = client;
  const state = new Map<string, any>();
  const host = Object.assign(Object.create(GrokSidebar.prototype), {
    focused: session,
    state: {
      get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { state.set(key, value); },
    },
    host: { getConfiguration: () => ({ get: () => "" }) },
    rememberGrokConfig: vi.fn(),
    autoApprovePendingPermissions: vi.fn(),
    reportRequester: vi.fn(),
    emit: vi.fn(),
    sessionMetaWrites: Promise.resolve(),
  });
  return { host, session, state };
}

describe("Codex picker through its ACP config and prompt routes", () => {
  it.each([["agent", "agent"], ["yolo", "agent-full-access"], ["askApproval", "read-only"]] as const)(
    "gets the same review from the picker and /plan, then exits to %s", async (mode, approvalPreset) => {
    const { client, config } = adapter();
    await client.newSession();
    const { host, session, state } = pickerHost(client);
    const reviews: PermissionRequest[] = [];
    client.on("permissionRequest", (request: PermissionRequest) => {
      reviews.push(request);
      client.respondPermission(request.id, "revise_plan");
    });

    await host.setMode("plan", session);
    expect(config.collaboration_mode).toBe("plan");
    await client.prompt("Check how this will work");
    expect(reviews).toHaveLength(1);
    expect(state.has(CODEX_ASK_APPROVAL_PREF_KEY)).toBe(false);
    expect(host.rememberGrokConfig).not.toHaveBeenCalled();

    await host.setMode(mode, session);
    expect(config.collaboration_mode).toBe("default");
    expect(config.mode).toBe(approvalPreset);
    expect(client.currentModeId).toBe(mode === "yolo" ? "agent-full-access" : mode);
    await client.prompt("Proceed normally");
    expect(reviews).toHaveLength(1);
    await client.prompt("/plan");
    expect(client.currentModeId).toBe("plan");
    await client.prompt("Check how this will work");
    expect(reviews).toHaveLength(2);
    expect(reviews[0].toolCall).toEqual(reviews[1].toolCall);
  });

  it("restores the approval preset after reopening and applies it to new Codex conversations", async () => {
    const { client } = adapter();
    await client.newSession();
    const { host, session, state } = pickerHost(client);
    await host.setMode("askApproval", session);
    const id = client.sessionId!;
    expect(state.get("grok.sessionMeta")[id].codexAskApproval).toBe(true);
    expect(host.newSessionMode("codex")).toBe("askApproval");
    expect(host.newSessionMode("grok")).toBe("agent");

    const { client: reopened } = adapter();
    await reopened.loadSession(id);
    expect(reopened.currentModeId).toBe("agent");
    session.client = reopened;
    await host.restoreCodexApproval(session, reopened, id);
    expect(host.displayMode(session)).toBe("askApproval");
    await host.setMode("agent", session);
    expect(host.displayMode(session)).toBe("agent");
    expect(host.newSessionMode("codex")).toBe("agent");
    expect(state.get("grok.sessionMeta")[id]?.codexAskApproval).toBeUndefined();
    expect(host.rememberGrokConfig).toHaveBeenCalledWith("defaultMode", "agent");
  });

  it("holds a following send when the picker cannot enter Plan", async () => {
    const { client, written, config } = adapter(true);
    await client.newSession();
    const { host, session } = pickerHost(client);
    const change = host.setMode("plan", session);
    const restore = vi.fn();
    await host.handleSend("Review this", false, session, "local", undefined, undefined, undefined, undefined, restore);
    await change;
    expect(config.collaboration_mode).toBe("default");
    expect(written.mock.calls.some(([line]) => JSON.parse(line).method === "session/prompt")).toBe(false);
    expect(host.emit).toHaveBeenCalledWith(session, { type: "agentError", text: "Mode change failed. Choose a mode and send again." });
    expect(restore).toHaveBeenCalledOnce();
  });
});
