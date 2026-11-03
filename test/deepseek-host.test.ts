import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session, beginTurn, sessionModeMessage } from "../src/session";
import { deepseekKey, DEEPSEEK_API_KEY_SECRET, isDeepSeekCredentialError } from "../src/deepseek-auth";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";
import { INBOUND_DISPOSITION, allowFromRemote } from "../src/remote-policy";
import { parseWebviewMsg } from "../src/desktop/webview-msg-validate";
import { AcpClient } from "../src/acp";
import type { SessionMetaOverrides } from "../src/sessions";
import { isRecentConversation } from "../src/sessions";

function host(enabled = true): any {
  const s = Object.create(GrokSidebar.prototype);
  s.focused = new Session(); s.focused.provider = "deepseek";
  s.workspaceRoot = () => "/workspace";
  s.pool = new Set([s.focused]); s.providerConnectionState = {}; s.providerNeedsLogin = {};
  s.host = { appendLine: vi.fn(), getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "experimentalDeepSeek" ? enabled : fallback }) };
  const secrets = new Map();
  s.context = { globalStorageUri: { fsPath: "/storage" }, secrets: {
    get: vi.fn(async (key: string) => secrets.get(key)), store: vi.fn(async (key: string, value: string) => secrets.set(key, value)), delete: vi.fn(async (key: string) => secrets.delete(key)),
  } };
  s.state = { get: (_key: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) };
  s.remoteClients = { detachedActiveValues: () => [], clients: () => [], active: () => s.focused, cwd: () => "/workspace" };
  s.captureRemoteRequester = () => undefined;
  s.locateProvider = vi.fn(() => "/managed"); s.locatedProviders = () => ({ deepseek: true });
  s.postLocal = vi.fn(); s.postProviderState = vi.fn(); s.setProviderNeedsLogin = vi.fn();
  s.setProviderConnected = vi.fn(async () => {}); s.adoptSessionsForConnectedProvider = vi.fn(async () => {});
  s.startSession = vi.fn(); s.installManagedAgyServer = vi.fn();
  s.emit = vi.fn(); s.displayMode = () => "agent"; s.sessionCwd = () => "/workspace";
  return s;
}
beforeEach(() => { vi.stubEnv(CLOUD_ENVIRONMENT_ENV, ""); vi.stubEnv("DEEPSEEK_API_KEY", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("DeepSeek catalog before a first message", () => {
  function catalogHost() {
    const s = host();
    s.hasProviderConsent = () => true;
    s.cacheProviderModels = vi.fn(async () => {});
    vi.spyOn(AcpClient.prototype, "start").mockResolvedValue(undefined);
    const dispose = vi.spyOn(AcpClient.prototype, "dispose").mockResolvedValue(undefined);
    const prompt = vi.spyOn(AcpClient.prototype, "prompt");
    const create = vi.spyOn(AcpClient.prototype, "newSession").mockImplementation(async function (this: AcpClient) {
      this.availableModels = [{ modelId: '["deepseek-official","deepseek-v4-flash"]', name: "DeepSeek V4 Flash" }];
      this.currentModelId = this.availableModels[0].modelId;
      return { sessionId: "catalog" };
    });
    return { s, create, dispose, prompt };
  }
  it("reads the catalog on Connect even while another provider owns the conversation", async () => {
    const { s, create, dispose, prompt } = catalogHost();
    s.focused.provider = "grok";
    await s.onMessage({ type: "deepseekConnect", key: "fake-key" }, "local");
    expect(create).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    expect(s.cacheProviderModels).toHaveBeenCalledWith("deepseek", [{ modelId: '["deepseek-official","deepseek-v4-flash"]', name: "DeepSeek V4 Flash" }], '["deepseek-official","deepseek-v4-flash"]');
    expect(prompt).not.toHaveBeenCalled();
    expect(s.focused.provider).toBe("grok");
  });
  it("deduplicates a pending read and discards it when the key is replaced", async () => {
    const { s, create, dispose, prompt } = catalogHost();
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    create.mockImplementationOnce(async function (this: AcpClient) {
      await pending;
      this.availableModels = [{ modelId: "old-keyless", name: "old catalog" }];
      return { sessionId: "old" };
    });
    const old = s.warmConnectedDeepSeekModels();
    expect(s.warmConnectedDeepSeekModels()).toBe(old);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await s.onMessage({ type: "deepseekConnect", key: "new-key" }, "local");
    release(); await old;
    expect(s.cacheProviderModels).toHaveBeenCalledOnce();
    expect(s.cacheProviderModels.mock.calls[0][1][0].modelId).not.toBe("old-keyless");
    expect(create).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledTimes(2);
    expect(prompt).not.toHaveBeenCalled();
  });
  it("does not launch without consent and never treats a catalog failure as a rejected key", async () => {
    const { s, create, dispose } = catalogHost();
    s.hasProviderConsent = () => false;
    await s.warmConnectedDeepSeekModels(); expect(create).not.toHaveBeenCalled();
    s.hasProviderConsent = () => true;
    create.mockRejectedValueOnce(new Error("offline"));
    await s.warmConnectedDeepSeekModels();
    expect(dispose).toHaveBeenCalledOnce();
    expect(s.cacheProviderModels).not.toHaveBeenCalled();
    expect(s.setProviderNeedsLogin).not.toHaveBeenCalled();
  });
});

describe("DeepSeek history", () => {
  function historyHost(initial: SessionMetaOverrides) {
    const s = host();
    let metadata = initial;
    const cache = new Map();
    s.state.get = () => metadata;
    s.state.update = async (_key: string, value: SessionMetaOverrides) => { metadata = value; };
    s.updateSessionMeta = async (update: (current: SessionMetaOverrides) => SessionMetaOverrides | null) => { metadata = update(metadata) ?? metadata; };
    s.adapterHistory = () => ({ cache });
    s.connectedProviders = () => ["deepseek"];
    s.providerRunSignal = () => new AbortController().signal;
    s.adapterHistoryFolderMap = () => new Map([["workspace", "/workspace"]]);
    s.authorizedSessionCwds = () => ["/workspace"];
    s.projectHomeDir = () => "/workspace";
    s.postSessionsList = vi.fn(); s.sendLocalRepoSessionsPreview = vi.fn();
    s.allAdapterCatalogs = () => cache.values();
    s.scheduleAdapterHistoryRefresh = vi.fn(); s.dotForId = () => "idle";
    vi.spyOn(AcpClient.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(AcpClient.prototype, "dispose").mockResolvedValue(undefined);
    return { s, cache, metadata: () => metadata };
  }

  it("keeps a prompted routine listed and pinned after it leaves the pool, without making it Recent", async () => {
    const h = historyHost({ run: { provider: "deepseek", customName: "[Routine] nightly", pinnedAt: 1, pinnedCwd: "/workspace" } });
    const session = h.s.focused;
    session.activeSessionId = "run";
    h.s.noteSessionActivity(session); // Creation/turn completion alone is not a prompt.
    expect(h.metadata().run.deepseekPrompted).toBeUndefined();
    h.s.noteSessionActivity(session, true); // The shared send-commit path, including routines.
    expect(h.metadata().run.deepseekPrompted).toBe(true);
    expect(h.metadata().run.sentAt).toBeUndefined();
    expect(h.metadata().run.autoName).toBeUndefined();
    expect(h.metadata().run.usageLog).toBeUndefined();
    expect(isRecentConversation(h.metadata().run, Date.now())).toBe(false);
    h.s.pool.clear();
    vi.spyOn(AcpClient.prototype, "listSessions")
      .mockResolvedValueOnce({ sessions: [{ sessionId: "run", cwd: "/workspace" }] })
      .mockResolvedValueOnce({ sessions: [] });
    await h.s.listAdapterHistory("deepseek");
    expect(h.cache.get("workspace").map((row: any) => row.id)).toEqual(["run"]);
    expect(h.s.buildPinnedSessions().entries.map((row: any) => row.id)).toEqual(["run"]);
  });

  it("omits unprompted harness sessions without deleting them, but keeps failed sends", async () => {
    const h = historyHost({
      abandoned: { provider: "deepseek", deepseekHarness: "default", activeAt: 123, customName: "Renamed but empty" },
      prompted: { provider: "deepseek", deepseekHarness: "minimal", deepseekPrompted: true, sentAt: 456, activeAt: 789 },
      failed: { provider: "deepseek", deepseekPrompted: true, sentAt: 457 },
      unknownTime: { provider: "deepseek", deepseekPrompted: true, autoName: "A completed turn without a known time" },
      // Written before deepseekPrompted existed: sentAt alone still means a person sent.
      unmarked: { provider: "deepseek", sentAt: 458 },
      autoNamedOnly: { provider: "deepseek", autoName: "Other metadata is not the prompt marker" },
    });
    const { s, cache } = h;
    const list = vi.spyOn(AcpClient.prototype, "listSessions").mockResolvedValueOnce({
      sessions: ["abandoned", "failed", "unknownTime", "unmarked", "autoNamedOnly"].map(sessionId => ({ sessionId, cwd: "/workspace" })),
    }).mockResolvedValueOnce({ sessions: [{ sessionId: "prompted", cwd: "/workspace" }] });
    await s.listAdapterHistory("deepseek");
    const metadata = h.metadata();
    expect(list).toHaveBeenCalledTimes(2);
    expect(cache.get("workspace").map((row: any) => row.id).sort()).toEqual(["failed", "prompted", "unknownTime", "unmarked"]);
    expect(metadata.abandoned).toEqual({ provider: "deepseek", deepseekHarness: "default", activeAt: 123, customName: "Renamed but empty" });
    expect(metadata.unknownTime.activeAt).toBeUndefined();
    expect(metadata.failed.activeAt).toBeUndefined();
    s.focused.lastActiveAt = Date.now(); // Reopening must not promote a live row either.
    expect(s.liveSessionEntry(s.focused, "prompted", "/workspace", metadata).updatedAt).toBe(789);
    expect(s.liveSessionEntry(s.focused, "unknownTime", "/workspace", metadata).updatedAt).toBe(0);
    expect(s.deepseekSessionHasPrompt("abandoned", metadata)).toBe(false);
    s.focused.activeSessionId = "sending"; s.focused.userMessageCount = 1;
    expect(s.deepseekSessionHasPrompt("sending", metadata)).toBe(true);
  });
});

describe("DeepSeek desk boundary and credentials", () => {
  it.each(["local", "remote"])("returns text to its sender and ends busy when an older %s renderer sends an image", async origin => {
    const s = host(), session = s.focused;
    session.activeSessionId = "s";
    session.client = { sessionId: "s", prompt: vi.fn() };
    session.chips = [{ id: "image", path: "/image.png", relPath: "Image #1", imageIndex: 1, mimeType: "image/png" }];
    s.pendingAttach = new Set();
    s.restoreComposerFor = vi.fn();
    const requester = { tabId: "phone-tab" };
    s.captureRemoteRequester = () => requester;
    await s.onMessage({ type: "send", text: "Keep my image question" }, origin, origin === "remote" ? "phone" : undefined);
    expect(s.restoreComposerFor).toHaveBeenCalledWith(session, origin === "remote" ? requester : undefined, "Keep my image question");
    expect(s.emit).toHaveBeenCalledWith(session, { type: "agentError", text: expect.stringContaining("Remove the image") });
    expect(session.chips).toHaveLength(1);
    expect(session.client.prompt).not.toHaveBeenCalled();
  });
  it("advertises only at an opted-in desk", () => {
    expect(host().providerStateMessage().providers.some((p: any) => p.id === "deepseek")).toBe(true);
    expect(host(false).providerStateMessage().providers.some((p: any) => p.id === "deepseek")).toBe(false);
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    expect(host().providerStateMessage().providers.some((p: any) => p.id === "deepseek")).toBe(false);
  });
  it("refuses remote install, connect and key writes before consent", async () => {
    const s = host();
    for (const msg of [{ type: "runGrokLogin", provider: "deepseek" }, { type: "installDeepSeek" }, { type: "deepseekConnect", key: "secret" }]) await s.onMessage(msg, "remote");
    expect(s.context.secrets.store).not.toHaveBeenCalled(); expect(s.setProviderConnected).not.toHaveBeenCalled();
    expect(s.installManagedAgyServer).not.toHaveBeenCalled();
    for (const type of ["installDeepSeek", "cancelDeepSeekInstall", "deepseekConnect", "setExperimentalDeepSeek"] as const) {
      expect(INBOUND_DISPOSITION[type]).toBe("host-local"); expect(allowFromRemote(type, "full", { isCloud: true })).toBe(false);
    }
  });
  it("adopts the environment first, saves locally and never publishes a key", async () => {
    const s = host(); vi.stubEnv("DEEPSEEK_API_KEY", "environment-secret");
    await s.onMessage({ type: "deepseekConnect", key: "saved-secret" }, "local");
    expect(s.context.secrets.store).toHaveBeenCalledWith(DEEPSEEK_API_KEY_SECRET, "saved-secret");
    expect(await s.deepseekCredential()).toEqual({ key: "environment-secret", source: "environment" });
    expect(s.setProviderConnected).toHaveBeenCalledWith("deepseek", true);
    expect(JSON.stringify(s.providerStateMessage())).not.toContain("secret");
    expect(deepseekKey({}, "saved-secret")).toEqual({ key: "saved-secret", source: "saved" });
  });
  it("neither probes nor reads credentials before consent", async () => {
    const s = host(); expect(await s.deviceLoginCredentialReady("deepseek", true)).toBe(false);
    expect(s.context.secrets.get).not.toHaveBeenCalled();
  });
  it("never recovers a rejected DeepSeek key by restarting/resending", async () => {
    const s = host(); const error = { message: "Internal error", data: "turn failed: 401 Invalid API key" };
    expect(isDeepSeekCredentialError(error)).toBe(true);
    expect(await s.recoverAuthAndResend(s.focused, error, "text", [])).toBe(false);
    expect(s.startSession).not.toHaveBeenCalled(); expect(s.setProviderNeedsLogin).toHaveBeenCalledWith("deepseek", true);
    expect(isDeepSeekCredentialError(new Error("429 rate limit"))).toBe(false);
  });
  it("locks harness after a turn and suppresses Minimal approvals in snapshots and commands", async () => {
    const s = host(); const session = s.focused;
    session.deepseekHarness = "minimal"; session.hasHistory = true;
    session.client = { sessionId: "s", currentModelId: "opaque-model", setMode: vi.fn() };
    expect(sessionModeMessage(session, "agent")).toMatchObject({ modes: [], deepseekHarness: "minimal", deepseekHarnessLocked: true });
    await s.onMessage({ type: "setDeepSeekHarness", harness: "default", sessionId: "s", modelId: "opaque-model", generation: session.gen }, "local");
    await s.onMessage({ type: "setMode", modeId: "yolo" }, "local");
    expect(session.deepseekHarness).toBe("minimal"); expect(session.autoApprove).toBe(false);
    expect(s.startSession).not.toHaveBeenCalled(); expect(session.client.setMode).not.toHaveBeenCalled();
  });
  it("validates keys and harness names at the desktop boundary", () => {
    for (const key of ["", "a\nb", "x".repeat(513), {}]) expect(parseWebviewMsg({ type: "deepseekConnect", key })).toBeNull();
    expect(parseWebviewMsg({ type: "deepseekConnect", key: "valid" })).not.toBeNull();
    expect(parseWebviewMsg({ type: "setDeepSeekHarness", harness: "other" })).toBeNull();
  });
  it("replaces only an untouched conversation with matching model/session/generation", async () => {
    const s = host(), session = s.focused;
    session.client = { sessionId: "s", currentModelId: "opaque-model" };
    const msg = { type: "setDeepSeekHarness", harness: "minimal", sessionId: "s", modelId: "opaque-model", generation: session.gen };
    expect(parseWebviewMsg(msg)).not.toBeNull();
    for (const changed of [{ sessionId: "old" }, { modelId: "old" }, { generation: session.gen + 1 }]) {
      await s.onMessage({ ...msg, ...changed }, "local");
    }
    expect(s.startSession).not.toHaveBeenCalled();
    await s.onMessage(msg, "local");
    const options = s.startSession.mock.calls[0][4];
    expect(options).toMatchObject({ deepseekHarness: "minimal", modelId: "opaque-model" });
    expect(options.canReplace()).toBe(true);
    session.userMessageCount = 1;
    expect(options.canReplace()).toBe(false); // First send wins while startup awaits the lock.
  });
  it.each(["local", "remote"])("refuses the removed new-conversation action on a locked harness (%s)", async origin => {
    const s = host(), session = s.focused;
    session.hasHistory = true;
    session.client = { sessionId: "s", currentModelId: "opaque-model" };
    s.newFocusedSession = vi.fn(); s.newRemoteSession = vi.fn();
    const msg = { type: "setDeepSeekHarness", harness: "minimal", sessionId: "s", modelId: "opaque-model", generation: session.gen, newConversation: true };
    expect(parseWebviewMsg(msg)).toBeNull();
    await s.onMessage(msg, origin, "phone"); // An older renderer cannot bypass the lock.
    expect(s.newFocusedSession).not.toHaveBeenCalled(); expect(s.newRemoteSession).not.toHaveBeenCalled();
    expect(s.startSession).not.toHaveBeenCalled();
    expect(s.emit).toHaveBeenCalledWith(session, { type: "error", text: "Start a new session to use a different DeepSeek harness." });
  });
  it("correlates an untouched conversation's draft with its replacement id, or its old id on refusal", async () => {
    const s = host(), session = s.focused;
    session.client = { sessionId: "s", currentModelId: "opaque-model" };
    const msg = { type: "setDeepSeekHarness", harness: "minimal", sessionId: "s", modelId: "opaque-model", generation: session.gen, draftId: "draft" };
    s.startSession.mockImplementation(async () => { session.client = { sessionId: "new", currentModelId: "opaque-model" }; });
    await s.onMessage(msg, "local");
    expect(s.postLocal).toHaveBeenCalledWith({ type: "composerDraftSession", draftId: "draft", sessionId: "new" });
    s.postLocal.mockClear();
    await s.onMessage(msg, "local"); // stale old id
    expect(s.postLocal).toHaveBeenCalledWith({ type: "composerDraftSession", draftId: "draft", sessionId: "s" });
  });
});
