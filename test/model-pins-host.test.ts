import { describe, expect, it, vi } from "vitest";
import { MODEL_PINS_KEY } from "../src/model-pins";
import type { AcpProvider } from "../src/acp-backend";
import type { HostMsg } from "../src/protocol";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { GrokSidebar } from "../src/sidebar";

function host(usable: AcpProvider[] = []) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const values = new Map<string, unknown>();
  sidebar.state = {
    get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
  };
  sidebar.modelPinWrites = Promise.resolve();
  sidebar.focused = new Session();
  sidebar.remoteClients = new RemoteClientState<Session>("");
  sidebar.usableProviders = () => usable;
  sidebar.connectedProviders = () => usable;
  sidebar.host = {
    workspaceRoot: () => "",
    getConfiguration: () => ({ get: (_: string, fallback: unknown) => fallback }),
  };
  sidebar.view = { webview: { postMessage: vi.fn() } };
  sidebar.deliverRemote = vi.fn();
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.captureRemoteRequester = vi.fn();
  return { sidebar, values };
}

describe("model pins at the host", () => {
  it("sends the real initial burst and joining remote the same device-global snapshot", () => {
    const { sidebar, values } = host();
    const pin = { provider: "grok", modelId: "grok-4.7", pinnedAt: 1 };
    values.set(MODEL_PINS_KEY, { "grok:grok-4.7": pin });
    const frame = { type: "modelPins", pins: [pin] };
    for (const name of ["initializeProjects", "forgetPostedVoiceConfigured", "postProviderState", "refreshGithubState", "postMcpConnectors",
      "postProjectSetup", "refreshImplicitChip", "postVoiceConfigured", "postRemoteStatus", "postSessionsList"]) {
      sidebar[name] = vi.fn();
    }
    sidebar.buildInitialStateMsg = () => ({ type: "initialState", capabilities: {} });
    sidebar.remoteClients.ready("other-phone");
    sidebar.postInitialState();
    expect(sidebar.view.webview.postMessage).toHaveBeenCalledWith(frame);
    expect(sidebar.deliverRemote).toHaveBeenCalledWith(["other-phone"], frame, undefined);
    expect(sidebar.sendRemoteSession).not.toHaveBeenCalledWith(sidebar.focused, frame);

    sidebar.authorizedSessionCwds = () => [];
    sidebar.localRepoCatalogEntries = () => [];
    sidebar.providerStateMessage = () => ({ type: "providerState", providers: [] });
    sidebar.githubStateMessage = () => ({ type: "githubState" });
    sidebar.mcpConnectorsMessage = () => ({ type: "mcpConnectors", connectors: [] });
    sidebar.mcpServersMessage = () => ({ type: "mcpServers", servers: [] });
    sidebar.welcomeTipsMessage = () => ({ type: "welcomeTips" });
    sidebar.projectSetupMessage = () => ({ type: "projectSetup" });
    sidebar.githubProjectSetupExtra = () => ({});
    sidebar.defaultProviderForProject = () => "grok";
    sidebar.voiceBackendState = () => ({});
    sidebar.rememberVoiceConfigured = vi.fn();
    sidebar.voiceConfiguredMsg = () => ({ type: "voiceConfigured", configured: false });
    sidebar.seedPostedVoiceConfigured = vi.fn();
    sidebar.remoteVoice = new Map();
    sidebar.buildRemoteReposMsg = () => ({ type: "repos", entries: [] });
    sidebar.buildSessionsList = () => ({ type: "sessions", sessions: [] });
    sidebar.buildPinnedSessions = () => ({ pins: [] });
    sidebar.buildRecentSessions = () => ({ entries: [] });
    const modelPins = () => sidebar.buildRemoteSnapshot("joining-phone").filter((message: HostMsg) => message.type === "modelPins");
    expect(modelPins()).toEqual([frame]);
    values.delete(MODEL_PINS_KEY);
    expect(modelPins()).toEqual([{ type: "modelPins", pins: [] }]);
  });

  it("uses the offered catalogs, echoes a refused pin, and removes pins even after sign-out", async () => {
    const usable: AcpProvider[] = ["grok", "codex"];
    const { sidebar, values } = host(usable);
    const modelCache = {
      codex: { models: [{ modelId: "codex-known", name: "Codex model" }] },
      grok: { models: [{ modelId: "stale", name: "Stale model" }] },
      claude: { models: [{ modelId: "claude-known", name: "Claude model" }] },
    };
    values.set("grok.providerModelCache", modelCache);
    sidebar.focused.client = { availableModels: [{ modelId: "live", name: "Live model" }] };
    sidebar.remoteClients.ready("phone");
    const toggle = (provider: AcpProvider, modelId: string, pinned = true, origin = "remote") =>
      sidebar.onMessage({ type: "toggleModelPin", provider, modelId, pinned }, origin, origin === "remote" ? "phone" : undefined);
    for (const [provider, id] of [["codex", "unknown"], ["claude", "claude-known"], ["codex", ""]] as const) {
      await toggle(provider, id);
    }
    await toggle("grok", "stale", true, "local");
    expect(sidebar.state.update).not.toHaveBeenCalled();
    expect(sidebar.view.webview.postMessage).toHaveBeenLastCalledWith({ type: "modelPins", pins: [] });

    sidebar.remoteClients.ready("other-phone");
    await Promise.all([toggle("codex", "codex-known"), toggle("grok", "live", true, "local")]);
    const frame = sidebar.view.webview.postMessage.mock.lastCall[0];
    expect(frame).toMatchObject({ type: "modelPins", pins: [{ modelId: "codex-known" }, { modelId: "live" }] });
    expect(frame.pins[1].pinnedAt).toBeGreaterThan(frame.pins[0].pinnedAt);
    expect(sidebar.deliverRemote).toHaveBeenLastCalledWith(["phone", "other-phone"], frame, undefined);
    usable.splice(0);
    await toggle("codex", "codex-known", false);
    expect(sidebar.view.webview.postMessage).toHaveBeenLastCalledWith({ type: "modelPins", pins: [frame.pins[1]] });
  });
});
