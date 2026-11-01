import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ streams: [] as any[], startGate: undefined as Promise<void> | undefined, stopGate: undefined as Promise<string> | undefined }));
vi.mock("../src/voice-streamer", async () => {
  const { EventEmitter } = await import("node:events");
  class Stream extends EventEmitter {
    transcript = "";
    finalizedTranscript = "";
    active = true;
    constructor(public backend?: string) { super(); mock.streams.push(this); }
    start = vi.fn(async (_opts: any) => { await mock.startGate; });
    writePcm = vi.fn(() => true);
    stop = vi.fn(async () => mock.stopGate ?? this.transcript);
    cancel = vi.fn(() => { this.active = false; });
  }
  return { PcmVoiceStreamer: Stream, VoiceStreamer: Stream, createPcmVoiceStreamer: (backend: string) => new Stream(backend) };
});
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { DEFAULT_SEND_PHRASE } from "../src/voice";

function host(provider: "grok" | "codex" | "claude" = "codex") {
  const s = Object.create(GrokSidebar.prototype) as any;
  s.focused = new Session(); s.focused.cwd = "/repo"; s.focused.provider = provider;
  s.sessionCwd = (session: Session) => session.cwd;
  s.workspaceRoot = () => "/repo";
  s.defaultProviderForProject = () => "grok";
  s.remoteClients = new RemoteClientState<Session>("/repo");
  s.remoteClients.ready("phone"); s.remoteClients.setActive("phone", s.focused);
  s.remoteVoice = new Map(); s.lastVoiceConfiguredByCwd = new Map(); s.lastPostedVoiceConfigured = new Map();
  s.postLocal = vi.fn(); s.sendRemoteClient = vi.fn();
  s.voiceSetting = vi.fn((_cwd: string, _key: string, fallback: any) => fallback);
  s.resolveSttApiKey = vi.fn((_cwd: string, backend: string) => backend + "-key");
  s.host = { appendLine: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn() };
  s.voiceGeneration = 1; s.voiceRecorder = { cancel: vi.fn(), active: false };
  return s;
}

beforeEach(() => { mock.streams.length = 0; mock.startGate = mock.stopGate = undefined; });
afterEach(() => { vi.restoreAllMocks(); });

describe("backend-aware host readiness", () => {
  it.each(["grok", "codex", "claude"] as const)("OpenAI-only %s is configured, including its remote destination", provider => {
    const s = host(provider); s.resolveSttApiKey = (_cwd: string, backend: string) => backend === "openai" ? "key" : undefined;
    s.postVoiceConfigured();
    const message = s.postLocal.mock.calls[0][0];
    expect(message).toMatchObject({ type: "voiceConfigured", value: true, backendState: { provider, backend: "openai", hasXai: false, hasOpenAi: true } });
    expect(message.backendState.backends).toEqual({ grok: "openai", codex: "openai", claude: "openai", muse: "openai", agy: "openai", deepseek: "openai" });
    expect(s.sendRemoteClient).toHaveBeenCalledWith("phone", message, "/repo");
    expect(JSON.stringify(message)).not.toContain("openai-key");
  });

  it("resolves each destination's provider and project instead of the desk provider", () => {
    const s = host("codex");
    const remote = new Session(); remote.provider = "claude"; remote.cwd = "/other";
    s.remoteClients.setActive("phone", remote);
    s.postVoiceConfigured();
    expect(s.postLocal.mock.calls[0][0].backendState.backend).toBe("openai");
    expect(s.sendRemoteClient.mock.calls[0]).toEqual(["phone", expect.objectContaining({ backendState: expect.objectContaining({ provider: "claude", backend: "xai" }) }), "/other"]);
    expect(s.resolveSttApiKey).toHaveBeenCalledWith("/other", "openai");
  });

  it("refreshes a provider change even when the boolean and project are unchanged", () => {
    const s = host("codex"); s.postVoiceConfigured(); s.focused.provider = "grok"; s.postVoiceConfigured();
    expect(s.postLocal).toHaveBeenCalledTimes(2);
    expect(s.postLocal.mock.calls[1][0].backendState.backend).toBe("xai");
  });

  it("honors a strict explicit selection, including missing-key setup", () => {
    const s = host(); s.voiceSetting = (_cwd: string, key: string, fallback: any) => key === "voiceBackend" ? "xai" : fallback;
    s.resolveSttApiKey = (_cwd: string, backend: string) => backend === "openai" ? "key" : undefined;
    s.postVoiceConfigured(); expect(s.postLocal.mock.calls[0][0].value).toBe(false);
  });
});

describe("remote PCM ownership and pinned backend", () => {
  it.each([["codex", "openai"], ["grok", "xai"], ["claude", "xai"]] as const)("selects %s -> %s once and retains it over hands-free restart", async (provider, backend) => {
    const s = host(provider); await s.handleRemoteVoiceStart("phone", s.focused);
    const first = mock.streams.at(-1); expect(first.backend).toBe(backend);
    s.handleRemoteVoiceChunk("other-tab", "AQACAA==");
    expect(first.writePcm).not.toHaveBeenCalled();
    s.handleRemoteVoiceChunk("phone", "AQACAA==");
    expect(first.writePcm).toHaveBeenCalledWith(Buffer.from([1, 0, 2, 0]));
    first.emit("partial", { text: "fix it grok send", speechFinal: false });
    expect(s.sendRemoteClient.mock.calls.some((c: any[]) => c[1].type === "voiceSubmit")).toBe(false);
    s.focused.provider = provider === "codex" ? "grok" : "codex";
    s.resolveSttApiKey = vi.fn(() => undefined);
    await s.commitRemoteVoice("phone", "fix it");
    expect(mock.streams.at(-1).backend).toBe(backend);
    expect(mock.streams.at(-1).start.mock.calls[0][0].apiKey).toBe(backend + "-key");
    expect(s.resolveSttApiKey).toHaveBeenCalledWith("/repo", backend);
    expect(s.resolveSttApiKey.mock.calls.every((c: any[]) => c[1] === backend)).toBe(true);
    s.dropRemoteVoice("phone");
  });

  it("preserves the xAI-only Codex user's existing remote dictation", async () => {
    const s = host(); s.resolveSttApiKey = (_cwd: string, backend: string) => backend === "xai" ? "key" : undefined;
    await s.handleRemoteVoiceStart("phone", s.focused);
    expect(mock.streams.at(-1).backend).toBe("xai"); s.dropRemoteVoice("phone");
  });

  it("flushes buffered 16 kHz PCM when Stop arrives during connection setup", async () => {
    let ready!: () => void; mock.startGate = new Promise(resolve => { ready = resolve; });
    const s = host(); const started = s.handleRemoteVoiceStart("phone", s.focused);
    s.handleRemoteVoiceChunk("phone", "AQACAA==");
    const stream = mock.streams.at(-1); stream.transcript = stream.finalizedTranscript = "final only";
    const stopped = s.handleRemoteVoiceStop("phone", false);
    expect(stream.stop).not.toHaveBeenCalled(); ready(); await started; await stopped;
    expect(stream.writePcm).toHaveBeenCalledWith(Buffer.from([1, 0, 2, 0]));
    expect(s.sendRemoteClient).toHaveBeenCalledWith("phone", { type: "voiceTranscript", text: "final only", send: false }, "/repo");
    expect(s.remoteVoice.size).toBe(0);
  });

  it("cancel while finalizing removes ownership and suppresses the late transcript", async () => {
    let finish!: (s: string) => void; mock.stopGate = new Promise(resolve => { finish = resolve; });
    const s = host(); await s.handleRemoteVoiceStart("phone", s.focused);
    const stream = mock.streams.at(-1); stream.finalizedTranscript = "late grok send";
    const stopped = s.handleRemoteVoiceStop("phone", false); await Promise.resolve();
    await s.handleRemoteVoiceStop("phone", true); finish("late grok send"); await stopped;
    expect(stream.cancel).toHaveBeenCalled(); expect(s.remoteVoice.size).toBe(0);
    expect(s.sendRemoteClient.mock.calls.some((c: any[]) => ["voiceTranscript", "voiceSubmit"].includes(c[1].type))).toBe(false);
  });

  it("never submits a best-effort partial on Stop", async () => {
    const s = host(); await s.handleRemoteVoiceStart("phone", s.focused);
    mock.streams.at(-1).transcript = "draft grok send";
    await s.handleRemoteVoiceStop("phone", false);
    expect(s.sendRemoteClient).toHaveBeenCalledWith("phone", { type: "voiceTranscript", text: "draft grok send", send: false }, "/repo");
  });

  it("a stream error releases ownership without vendor fallback", async () => {
    const s = host(); await s.handleRemoteVoiceStart("phone", s.focused);
    const before = mock.streams.length;
    mock.streams.at(-1).emit("error", new Error("quota"));
    expect(mock.streams).toHaveLength(before); expect(s.remoteVoice.size).toBe(0);
  });
});

describe("local recording backend", () => {
  it("keeps the backend across finalized send-phrase restarts and ignores partial commands", async () => {
    const s = host(); s.localVoiceCredentialCwd = "/repo";
    s.voiceStreamCtx = { backend: "openai", key: "openai-key", model: "gpt-live-transcribe", ffmpegPath: "ffmpeg", phrase: DEFAULT_SEND_PHRASE, keyterms: [], generation: 1 };
    await s.openVoiceStream(); const first = mock.streams.at(-1);
    first.emit("partial", { text: "fix it grok send", speechFinal: false });
    expect(mock.streams).toHaveLength(1);
    s.focused.provider = "grok";
    first.emit("partial", { text: "fix it grok send", speechFinal: true });
    await Promise.resolve();
    expect(s.postLocal).toHaveBeenCalledWith({ type: "voiceSubmit", text: "fix it" });
    expect(mock.streams.at(-1).start.mock.calls[0][0].backend).toBe("openai");
    s.stopVoiceInput();
  });
});
