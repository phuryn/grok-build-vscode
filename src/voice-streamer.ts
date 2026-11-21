// Real-time STT. PcmVoiceStreamer owns the xAI WebSocket and accepts raw
// PCM16/16 kHz/mono bytes from any producer. VoiceStreamer composes it with
// ffmpeg for the local microphone; AFK Pilot feeds the selected PCM adapter.
import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  buildSttStreamUrl,
  buildFfmpegStreamArgs,
  applySegment,
  joinSegments,
  classifySttError,
  redactVoiceStreamUrl,
  TranscriptSegment,
  SttBackend,
} from "./voice";
import { resolveWindowsAudioDevice } from "./voice-recorder";
import { OpenAiPcmVoiceStreamer } from "./openai-voice";
import { GooglePcmVoiceStreamer } from "./google-voice";

export interface PcmStreamStartOpts {
  apiKey: string;
  language?: string;
  keyterms?: string[];
  model?: string;
  log?: (msg: string) => void;
}

export interface StreamStartOpts extends PcmStreamStartOpts {
  backend?: SttBackend;
  ffmpegPath: string;
  device?: string;
}

export { redactVoiceStreamUrl } from "./voice";

export interface PartialEvent {
  text: string;
  /** True only if ALL text in this cumulative partial is finalized. */
  speechFinal: boolean;
}

export interface PcmSttStream extends EventEmitter {
  readonly active: boolean;
  readonly transcript: string;
  readonly finalizedTranscript: string;
  start(opts: PcmStreamStartOpts): Promise<void>;
  writePcm(bytes: Uint8Array): boolean;
  stop(): Promise<string>;
  cancel(): void;
}

export function createPcmVoiceStreamer(backend: SttBackend): PcmSttStream {
  if (backend === "google") return new GooglePcmVoiceStreamer();
  return backend === "openai" ? new OpenAiPcmVoiceStreamer() : new PcmVoiceStreamer();
}

export class PcmVoiceStreamer extends EventEmitter {
  private static readonly FINAL_RESULT_TIMEOUT_MS = 5000;
  private ws?: WebSocket;
  private segments: TranscriptSegment[] = [];
  private finalized = new Set<number>();
  private rejectStart?: (err: Error) => void;
  private stopPromise?: Promise<string>;
  private stopping = false;
  private cancelled = false;
  private terminal?: { promise: Promise<void>; resolve: () => void };

  get active(): boolean {
    return !!this.ws;
  }

  get transcript(): string {
    return joinSegments(this.segments);
  }

  get finalizedTranscript(): string {
    return this.segments.every(s => this.finalized.has(s.start)) ? this.transcript : "";
  }

  start(opts: PcmStreamStartOpts): Promise<void> {
    if (this.ws) return Promise.reject(new Error("Speech-to-Text stream is already active."));
    this.stopping = false;
    this.segments = [];
    this.finalized.clear();
    this.cancelled = false;
    this.stopPromise = undefined;
    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    this.terminal = { promise: terminalPromise, resolve: resolveTerminal };
    const url = buildSttStreamUrl({ language: opts.language, keyterms: opts.keyterms });
    opts.log?.(`[voice-stream] connect ${redactVoiceStreamUrl(url)}`);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) {
          if (!this.stopping) {
            this.stopping = true;
            this.dispose();
            this.emit("error", err);
          }
          return;
        }
        settled = true;
        this.stopping = true;
        clearTimeout(timer);
        this.dispose();
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error("Speech-to-Text streaming did not start (timeout). Check your network and API key.")),
        8000,
      );
      this.rejectStart = (err) => { clearTimeout(timer); if (!settled) { settled = true; reject(err); } };

      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (this.ws !== ws || isBinary) return;
        let ev: any;
        try { ev = JSON.parse(data.toString()); } catch { return; }
        if (ev.type === "transcript.created") {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.rejectStart = undefined;
            resolve();
          }
        } else if (ev.type === "transcript.partial") {
          this.segments = applySegment(this.segments, ev);
          if (ev.is_final || ev.speech_final) this.finalized.add(ev.start);
          else this.finalized.delete(ev.start);
          this.emit("partial", { text: this.transcript, speechFinal: !!ev.speech_final && this.finalizedTranscript === this.transcript } as PartialEvent);
        } else if (ev.type === "transcript.done") {
          if (this.segments.length === 0 && typeof ev.text === "string" && ev.text.trim()) {
            this.segments = applySegment(this.segments, { start: 0, text: ev.text });
            this.finalized.add(0);
            this.emit("partial", { text: joinSegments(this.segments), speechFinal: true } as PartialEvent);
          }
          this.finishTerminal();
        } else if (ev.type === "error") {
          fail(new Error(ev.message || ev.error || "Speech-to-Text streaming error."));
        }
      });
      ws.on("unexpected-response", (_req, res: { statusCode?: number }) => {
        if (this.ws !== ws) return;
        const status = res && res.statusCode;
        fail(new Error(status ? classifySttError(status) : "Speech-to-Text streaming failed to connect."));
      });
      ws.on("error", (e: Error) => {
        if (this.ws !== ws) return;
        const m = /\b(401|403)\b/.exec(e.message || "");
        fail(m ? new Error(classifySttError(Number(m[1]))) : e);
      });
      ws.on("close", () => {
        if (this.ws !== ws) return;
        clearTimeout(timer);
        this.ws = undefined;
        this.finishTerminal();
        if (!settled) {
          fail(new Error("Speech-to-Text connection closed before streaming started."));
          return;
        }
        if (!this.stopping) this.emit("ended");
      });
    });
  }

  writePcm(bytes: Uint8Array): boolean {
    const ws = this.ws;
    if (!bytes.byteLength || !ws || ws.readyState !== WebSocket.OPEN || this.stopping) return false;
    try {
      ws.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  stop(): Promise<string> {
    return this.stopPromise ??= this.finish();
  }

  private async finish(): Promise<string> {
    if (this.rejectStart) { this.cancel(); return ""; }
    this.stopping = true;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      let resolveTerminal!: () => void;
      const terminalPromise = new Promise<void>((resolve) => { resolveTerminal = resolve; });
      const terminal = { promise: terminalPromise, resolve: resolveTerminal };
      this.terminal = terminal;
      try { ws.send(JSON.stringify({ type: "audio.done" })); } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PcmVoiceStreamer.FINAL_RESULT_TIMEOUT_MS);
        void terminal.promise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const text = this.cancelled ? "" : this.transcript;
    this.dispose();
    return text;
  }

  cancel(): void {
    this.stopping = true;
    this.rejectStart?.(new Error("Voice recording cancelled."));
    this.cancelled = true;
    this.rejectStart = undefined;
    this.dispose();
  }

  private dispose(): void {
    this.finishTerminal();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  private finishTerminal(): void {
    this.terminal?.resolve();
  }
}

export class VoiceStreamer extends EventEmitter {
  private pcm?: PcmSttStream;
  private proc?: ChildProcess;
  private stopping = false;
  private stopPromise?: Promise<string>;

  get active(): boolean {
    return !!this.pcm || !!this.proc;
  }

  get transcript(): string {
    return this.pcm?.transcript ?? "";
  }

  get finalizedTranscript(): string { return this.pcm?.finalizedTranscript ?? this.finalText; }
  private finalText = "";

  async start(opts: StreamStartOpts): Promise<void> {
    if (this.active) throw new Error("Voice stream is already active.");
    this.stopping = false;
    this.stopPromise = undefined;
    this.finalText = "";
    const pcm = createPcmVoiceStreamer(opts.backend ?? "xai");
    this.pcm = pcm;
    pcm.on("partial", (ev: PartialEvent) => this.emit("partial", ev));
    pcm.on("ended", () => {
      this.stopCapture();
      if (!this.stopping) this.emit("ended");
    });
    pcm.on("error", (e: Error) => {
      if (this.stopping) return;
      this.cancel();
      this.emit("error", e);
    });
    try {
      await pcm.start(opts);
      if (this.stopping || this.pcm !== pcm) return;
      await this.beginCapture(opts, pcm);
    } catch (e) {
      this.cancel();
      throw e;
    }
  }

  private async beginCapture(opts: StreamStartOpts, pcm: PcmSttStream): Promise<void> {
    let device = opts.device;
    if (process.platform === "win32" && !device) {
      device = await resolveWindowsAudioDevice(opts.ffmpegPath, opts.log);
      if (!device) {
        throw new Error("No microphone (DirectShow audio device) was found. Set grok.voiceInputDevice to its name.");
      }
    }
    if (this.stopping || this.pcm !== pcm) return;
    const args = buildFfmpegStreamArgs(process.platform, { device });
    opts.log?.(`[voice-stream] capture: ${opts.ffmpegPath} ${args.join(" ")}`);
    const proc = spawn(opts.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout?.on("data", (chunk: Buffer) => { pcm.writePcm(chunk); });
    proc.stderr?.on("data", (d) => opts.log?.(`[voice-stream ffmpeg] ${d.toString().trim()}`));
    proc.on("exit", () => { if (!this.stopping) this.emit("ended"); });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      proc.on("error", (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        reject(e.code === "ENOENT"
          ? new Error("ffmpeg was not found. Install ffmpeg (https://ffmpeg.org) or set grok.ffmpegPath.")
          : e);
      });
      setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 200);
    });
  }

  stop(): Promise<string> {
    return this.stopPromise ??= this.finish();
  }

  private async finish(): Promise<string> {
    this.stopping = true;
    await this.drainCapture();
    const pcm = this.pcm;
    const text = pcm ? await pcm.stop() : "";
    this.finalText = pcm?.finalizedTranscript ?? "";
    if (this.pcm === pcm) this.pcm = undefined;
    return text;
  }

  cancel(): void {
    this.stopping = true;
    this.stopCapture();
    this.pcm?.cancel();
    this.pcm = undefined;
  }

  private drainCapture(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      proc.on("close", finish);
      try { proc.stdin?.write("q"); proc.stdin?.end(); } catch { /* fall through */ }
      timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } finish(); }, 2500);
    });
  }

  private stopCapture(): void {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    try { proc.stdin?.write("q"); proc.stdin?.end(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
  }
}
