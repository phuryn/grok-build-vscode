import { on, once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GooglePcmVoiceStreamer, pcmFromGoogleVoiceWav } from "../src/google-voice";
import { createPcmVoiceStreamer, type PartialEvent } from "../src/voice-streamer";
import { parseFinalVoiceCommand } from "../src/voice";

const key = "fake+gemini/key";
let server: WebSocketServer | undefined;
let stream: GooglePcmVoiceStreamer | undefined;

async function listen(authStatus?: number) {
  server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    ...(authStatus && { verifyClient: (_info, done) => done(false, authStatus) }),
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server needs a TCP port");
  const fixture = server;
  const connected = new Promise<{ peer: WebSocket; target: string; keyHeader: unknown; next: () => Promise<any> }>(resolve => {
    fixture.once("connection", (peer, request) => {
      const messages = on(peer, "message");
      resolve({ peer, target: request.url!, keyHeader: request.headers["x-goog-api-key"],
        next: async () => JSON.parse((await messages.next()).value[0].toString()) });
    });
  });
  const log = vi.fn();
  stream = new GooglePcmVoiceStreamer((url, headers) => {
    const target = new URL(url);
    return new WebSocket(`ws://127.0.0.1:${address.port}${target.pathname}${target.search}`, { headers });
  });
  return { stream, connected, log };
}

function content(peer: WebSocket, serverContent: object) {
  peer.send(Buffer.from(JSON.stringify({ serverContent })));
}

async function ready() {
  const fixture = await listen();
  const starting = fixture.stream.start({ apiKey: key, log: fixture.log });
  const connection = await fixture.connected;
  expect(await connection.next()).toMatchObject({ setup: { inputAudioTranscription: { languageCodes: [] } } });
  connection.peer.send(Buffer.from('{"setupComplete":{}}'));
  await starting;
  return { ...fixture, ...connection };
}

afterEach(async () => {
  stream?.cancel();
  vi.useRealTimers();
  for (const peer of server?.clients ?? []) peer.terminate();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  stream = server = undefined;
});

describe("Google Live transcription against a fake WebSocket server", () => {
  it("routes Google through the shared PCM factory", () => {
    expect(createPcmVoiceStreamer("google")).toBeInstanceOf(GooglePcmVoiceStreamer);
  });

  it("sends only setup until setupComplete, keeps the key in a header, and sends the PCM bytes unchanged", async () => {
    const { stream, connected, log } = await listen();
    const starting = stream.start({ apiKey: key, language: " pt-BR ", keyterms: ["useEffect", "grok send"], log });
    // An assertion before acknowledgement can still cancel startup in cleanup.
    void starting.catch(() => {});
    const { peer, target, keyHeader, next } = await connected;
    expect(target).toBe("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
    expect(keyHeader).toBe(key);
    const setup = await next();
    expect(setup).toEqual({ setup: {
      model: "models/gemini-3.5-transcribe-live",
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: { languageCodes: ["pt-BR"], customVocabulary: ["useEffect", "grok send"] },
    } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[voice-stream] connect wss://generativelanguage.googleapis.com/ws/"));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/fake(?:\+|%2B)gemini/);
    const pcm = Buffer.alloc(3200, 0x92);
    expect(stream.writePcm(pcm)).toBe(false);
    peer.send(Buffer.from('{"setupComplete":{}}'));
    await starting;
    expect(stream.writePcm(pcm.subarray(0, 13))).toBe(true);
    expect(stream.writePcm(pcm.subarray(13))).toBe(true);
    expect(await next()).toEqual({ realtimeInput: { audio: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
  });

  it("replaces guesses, appends final segments and only submits a finalized send phrase", async () => {
    const { stream, peer } = await ready();
    async function partial(message: object): Promise<PartialEvent> {
      const emitted = once(stream, "partial");
      content(peer, message);
      return (await emitted)[0];
    }
    const sendPhrase = "grok send";
    expect(await partial({ inputTranscription: { text: "first sentence" } })).toEqual({ text: "first sentence", speechFinal: true });
    expect(await partial({ interimInputTranscription: { text: "wrong guess" } })).toEqual({ text: "first sentence wrong guess", speechFinal: false });
    expect(await partial({ interimInputTranscription: { text: sendPhrase } })).toEqual({ text: "first sentence grok send", speechFinal: false });
    expect(stream.finalizedTranscript).toBe("");
    expect(parseFinalVoiceCommand(stream.transcript, stream.finalizedTranscript, sendPhrase).send).toBe(false);
    expect(await partial({ inputTranscription: {} })).toEqual({ text: "first sentence", speechFinal: true });
    expect(await partial({ inputTranscription: { text: sendPhrase } })).toEqual({ text: "first sentence grok send", speechFinal: true });
    expect(parseFinalVoiceCommand(stream.transcript, stream.finalizedTranscript, sendPhrase)).toEqual({ text: "first sentence", send: true });
  });

  it("flushes the PCM tail and keeps listening for a final after the completion marker", async () => {
    const { stream, peer, next } = await ready();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stream.writePcm(Buffer.from([1, 0, 2, 0]));
    const stopped = stream.stop();
    expect(stream.stop()).toBe(stopped);
    expect(await next()).toEqual({ realtimeInput: { audio: { data: "AQACAA==", mimeType: "audio/pcm;rate=16000" } } });
    expect(await next()).toEqual({ realtimeInput: { audioStreamEnd: true } });
    content(peer, { turnComplete: true });
    const partial = once(stream, "partial");
    content(peer, { inputTranscription: { text: "final after Stop" } });
    await partial;
    expect(stream.active).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await stopped).toBe("final after Stop");
    expect(stream.finalizedTranscript).toBe("final after Stop");
    expect(stream.active).toBe(false);
  });

  it("bounds setup and finalization at eight seconds, retaining unfinalized text as a draft", async () => {
    const f = await listen();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const startFailed = expect(f.stream.start({ apiKey: key })).rejects.toThrow(/did not start \(timeout\)/);
    const { next } = await f.connected;
    await next();
    await vi.advanceTimersByTimeAsync(7999);
    expect(f.stream.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await startFailed;
    vi.useRealTimers();
    await new Promise<void>(resolve => server!.close(() => resolve()));

    const { stream, peer } = await ready();
    const partial = once(stream, "partial");
    content(peer, { interimInputTranscription: { text: "draft grok send" } });
    await partial;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stream.writePcm(Buffer.from([1, 0]));
    const stopFailed = expect(stream.stop()).rejects.toThrow(/timed out while finalizing/);
    await vi.advanceTimersByTimeAsync(7999);
    expect(stream.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await stopFailed;
    expect(stream.transcript).toBe("draft grok send");
    expect(stream.finalizedTranscript).toBe("");
  });

  it("cancels in-flight Stop without treating late transcript messages as a send", async () => {
    const { stream, peer, next } = await ready();
    const partial = vi.fn();
    stream.on("partial", partial);
    stream.writePcm(Buffer.from([1, 0]));
    const stopped = stream.stop();
    await next();
    await next();
    stream.cancel();
    content(peer, { inputTranscription: { text: "grok send" }, turnComplete: true });
    await expect(stopped).resolves.toBe("");
    await once(peer, "close");
    expect(stream.active).toBe(false);
    expect(partial).not.toHaveBeenCalled();
  });

  it("classifies an HTTP 403 handshake with Gemini key guidance", async () => {
    const { stream, log } = await listen(403);
    await expect(stream.start({ apiKey: key, log })).rejects.toThrow(/rejected.*Gemini API key.*grok.voiceGoogleApiKey/);
    expect(stream.active).toBe(false);
  });

  it("classifies WebSocket policy rejection without exposing the server reason", async () => {
    const { stream, connected } = await listen();
    const failed = expect(stream.start({ apiKey: key })).rejects.toEqual(new Error(
      "Google voice transcription was rejected by the server (1008). Check the Gemini API key, project access, and transcription settings.",
    ));
    const { peer, next } = await connected;
    await next();
    peer.close(1008, `API key invalid: ${key}`);
    await failed;
  });

  // Close reasons as Google sent them on 22 Nov 2026 to a bad key and to a project without credits or over its cap.
  it.each([
    [1007, "API key not valid. Please pass a valid API key.", /did not accept this Gemini API key/],
    [1011, "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.", /out of credits or over its spending cap/],
    [1011, "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.", /out of credits or over its spending cap/],
  ])("explains Google's close %i in plain words", async (code, reason, expected) => {
    const { stream, connected } = await listen();
    const failed = expect(stream.start({ apiKey: key })).rejects.toThrow(expected);
    const { peer, next } = await connected;
    await next();
    // A close reason holds at most 123 bytes, and Google's arrive cut at that length.
    peer.close(code, reason.slice(0, 123));
    await failed;
  });

  it("extracts recorder PCM from a WAV with an odd-sized metadata chunk", () => {
    const wav = Buffer.from("524946463000000057415645666d74201000000001000100803e0000007d0000020010004a554e4b01000000010064617461020000003412", "hex");
    expect(pcmFromGoogleVoiceWav(wav)).toEqual(Buffer.from([0x34, 0x12]));
    wav.writeUInt32LE(24000, 24);
    expect(() => pcmFromGoogleVoiceWav(wav)).toThrow(/mono 16 kHz PCM16 WAV/);
  });
});
