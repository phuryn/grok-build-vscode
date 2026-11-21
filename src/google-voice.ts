import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { redactVoiceStreamUrl } from "./voice";
import type { PartialEvent, PcmStreamStartOpts, PcmSttStream } from "./voice-streamer";

export const GOOGLE_STT_MODEL = "gemini-3.5-transcribe-live";
const ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const GOOGLE_PCM_CHUNK_BYTES = 3200; // 100 ms of mono, 16 kHz PCM16
const CONNECT_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 8000;
// The Live API can deliver input transcription after a completion marker.
const FINAL_DRAIN_MS = 500;

const KEY_REJECTED = "Google voice transcription was rejected. Check the Gemini API key and project access, or set grok.voiceGoogleApiKey on the host.";

// Google closes with these reasons (measured 22 Nov 2026): 1007 "API key not valid. Please pass a valid API key.",
// 1011 "Your prepayment credits are depleted. ..." and 1011 "Your project has exceeded its monthly spending cap. ...".
// The reason is matched, never shown, so nothing the server echoes reaches a log or a phone.
function classifyGoogleError(code?: number, status?: string, reason = ""): string {
  if (code === 1007 || /api key not valid/i.test(reason)) return "Google did not accept this Gemini API key. Check the key in Settings → Voice, or set grok.voiceGoogleApiKey on the host.";
  if (/credits are depleted|spending cap/i.test(reason)) return "Google refused the request: the Gemini API project is out of credits or over its spending cap. Check its billing in Google AI Studio.";
  if (code === 401 || code === 403 || status === "UNAUTHENTICATED" || status === "PERMISSION_DENIED") return KEY_REJECTED;
  if (code === 400 || status === "INVALID_ARGUMENT") return "Google voice transcription request was rejected (400). Check the Gemini API key and transcription settings on the host.";
  if (code === 429 || status === "RESOURCE_EXHAUSTED") return "Google voice transcription is rate-limited or out of API quota. Check your Gemini API limits.";
  if (code === 1008) return "Google voice transcription was rejected by the server (1008). Check the Gemini API key, project access, and transcription settings.";
  return "Google voice transcription connection failed. Check your network and try again.";
}

interface GoogleMessage {
  setupComplete?: object;
  error?: { code?: number; status?: string };
  serverContent?: {
    inputTranscription?: { text?: string };
    interimInputTranscription?: { text?: string };
    generationComplete?: boolean;
    turnComplete?: boolean;
  };
}

export class GooglePcmVoiceStreamer extends EventEmitter implements PcmSttStream {
  private ws?: WebSocket;
  private ready = false;
  private stopping = false;
  private receivedAudio = false;
  private completedTurn = false;
  private finals: string[] = [];
  private interim = "";
  private tail = Buffer.alloc(0);
  private starting?: { resolve: () => void; reject: (e: Error) => void };
  private closing?: { resolve: (text: string) => void; reject: (e: Error) => void };
  private stopPromise?: Promise<string>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;

  // The key travels in the x-goog-api-key header (measured working 22 Nov 2026), so no URL carries it.
  constructor(private readonly connect: (url: string, headers: Record<string, string>) => WebSocket
    = (url, headers) => new WebSocket(url, { headers })) { super(); }

  get active(): boolean { return !!this.ws; }
  get transcript(): string { return [...this.finals, this.interim].filter(Boolean).join(" "); }
  get finalizedTranscript(): string { return this.interim ? "" : this.finals.join(" "); }

  start(opts: PcmStreamStartOpts): Promise<void> {
    if (this.ws || this.ready || this.stopping) return Promise.reject(new Error("Speech-to-Text stream is already used."));
    opts.log?.(`[voice-stream] connect ${redactVoiceStreamUrl(ENDPOINT)}`);
    let ws: WebSocket;
    try { ws = this.connect(ENDPOINT, { "x-goog-api-key": opts.apiKey }); }
    catch { return Promise.reject(new Error(classifyGoogleError())); }
    this.ws = ws;
    return new Promise((resolve, reject) => {
      this.starting = { resolve, reject };
      this.connectTimer = setTimeout(() => this.fail("Google Speech-to-Text streaming did not start (timeout). Check your network and API key."), CONNECT_TIMEOUT_MS);
      ws.on("open", () => {
        if (this.ws !== ws) return;
        const language = opts.language?.trim();
        this.send({ setup: {
          model: `models/${GOOGLE_STT_MODEL}`,
          generationConfig: { responseModalities: ["TEXT"] },
          inputAudioTranscription: { languageCodes: language ? [language] : [], customVocabulary: opts.keyterms ?? [] },
        } });
      });
      // Google can send JSON in a binary WebSocket frame.
      ws.on("message", data => {
        if (this.ws !== ws) return;
        let message: GoogleMessage;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message?.error) this.fail(classifyGoogleError(message.error.code, message.error.status));
        else if (message?.setupComplete && this.starting) {
          this.ready = true;
          clearTimeout(this.connectTimer);
          this.starting.resolve();
          this.starting = undefined;
        } else if (this.ready && message?.serverContent) this.receive(message.serverContent);
      });
      ws.on("unexpected-response", (_req, res) => {
        if (this.ws === ws) this.fail(classifyGoogleError(res.statusCode));
      });
      ws.on("error", () => { if (this.ws === ws) this.fail(classifyGoogleError()); });
      ws.on("close", (code, reasonBytes) => {
        if (this.ws !== ws) return;
        if (code === 1000 && this.closing && this.completedTurn && !this.interim) this.finish();
        else if (code === 1000 && this.ready && !this.stopping) {
          this.dispose();
          this.emit("ended");
        } else this.fail(classifyGoogleError(code, undefined, reasonBytes?.toString() ?? ""));
      });
    });
  }

  private receive(content: NonNullable<GoogleMessage["serverContent"]>): void {
    if (content.inputTranscription) {
      const text = content.inputTranscription.text?.trim();
      if (text) this.finals.push(text);
      this.interim = "";
    }
    if (content.interimInputTranscription) this.interim = content.interimInputTranscription.text?.trim() ?? "";
    if (content.inputTranscription || content.interimInputTranscription) {
      this.emit("partial", { text: this.transcript, speechFinal: !!content.inputTranscription && !this.interim } satisfies PartialEvent);
    }
    if (!this.closing) return;
    this.completedTurn ||= !!(content.generationComplete || content.turnComplete);
    if (this.completedTurn) {
      clearTimeout(this.drainTimer);
      if (!this.interim) this.drainTimer = setTimeout(() => this.finish(), FINAL_DRAIN_MS);
    }
  }

  private send(message: unknown): boolean {
    try {
      const ws = this.ws!;
      ws.send(JSON.stringify(message), err => {
        if (err && this.ws === ws) this.fail(classifyGoogleError());
      });
      return true;
    } catch {
      this.fail(classifyGoogleError());
      return false;
    }
  }

  private sendAudio(bytes: Uint8Array): boolean {
    return this.send({ realtimeInput: { audio: {
      data: Buffer.from(bytes).toString("base64"), mimeType: "audio/pcm;rate=16000",
    } } });
  }

  writePcm(bytes: Uint8Array): boolean {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN || this.stopping || !bytes.byteLength) return false;
    this.receivedAudio = true;
    const audio = Buffer.concat([this.tail, bytes]);
    const end = audio.length - audio.length % GOOGLE_PCM_CHUNK_BYTES;
    for (let offset = 0; offset < end; offset += GOOGLE_PCM_CHUNK_BYTES) {
      if (!this.sendAudio(audio.subarray(offset, offset + GOOGLE_PCM_CHUNK_BYTES))) return false;
    }
    this.tail = audio.subarray(end);
    return true;
  }

  stop(): Promise<string> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (!this.ready || !this.receivedAudio) {
      this.cancel();
      return this.stopPromise = Promise.resolve("");
    }
    if (!this.ws) return Promise.reject(new Error("Google Speech-to-Text connection closed before transcription finished."));
    this.stopPromise = new Promise((resolve, reject) => { this.closing = { resolve, reject }; });
    this.stopTimer = setTimeout(() => this.fail("Google voice transcription timed out while finalizing the recording."), STOP_TIMEOUT_MS);
    if (this.tail.length % 2) this.fail("Microphone audio ended in an incomplete PCM16 sample.");
    else if (!this.tail.length || this.sendAudio(this.tail)) this.send({ realtimeInput: { audioStreamEnd: true } });
    this.tail = Buffer.alloc(0);
    return this.stopPromise;
  }

  cancel(): void {
    this.stopping = true;
    this.starting?.reject(new Error("Voice recording cancelled."));
    this.closing?.resolve("");
    this.dispose();
  }

  private finish(): void {
    this.closing?.resolve(this.finalizedTranscript);
    this.dispose(true);
  }

  private fail(message: string): void {
    const { starting, closing } = this;
    this.dispose();
    const error = new Error(message);
    if (starting) starting.reject(error);
    else if (closing) closing.reject(error);
    else this.emit("error", error);
  }

  private dispose(graceful = false): void {
    clearTimeout(this.connectTimer);
    clearTimeout(this.stopTimer);
    clearTimeout(this.drainTimer);
    this.starting = this.closing = undefined;
    this.tail = Buffer.alloc(0);
    const ws = this.ws;
    this.ws = undefined;
    try {
      if (graceful) ws?.close();
      else ws?.terminate();
    } catch { /* already closed */ }
  }
}

/** The recorder's WAV can contain metadata chunks before the PCM data. */
export function pcmFromGoogleVoiceWav(wav: Buffer): Buffer {
  if (wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE") {
    let pcm16 = false;
    for (let offset = 12; offset + 8 <= wav.length;) {
      const id = wav.toString("ascii", offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + size > wav.length) break;
      if (id === "fmt " && size >= 16) {
        pcm16 = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1
          && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
      }
      if (id === "data" && pcm16 && size > 0 && size % 2 === 0) return wav.subarray(start, start + size);
      offset = start + size + size % 2;
    }
  }
  throw new Error("Google voice needs a mono 16 kHz PCM16 WAV recording.");
}

export async function transcribeGoogleVoiceWav(wav: Buffer, opts: PcmStreamStartOpts): Promise<string> {
  const pcm = pcmFromGoogleVoiceWav(wav);
  const stream = new GooglePcmVoiceStreamer();
  let failure: Error | undefined;
  stream.on("error", err => { failure = err; });
  try {
    await stream.start(opts);
    if (!stream.writePcm(pcm)) throw failure ?? new Error("Google voice transcription could not send the recording.");
    return await stream.stop();
  } finally {
    stream.cancel();
  }
}
