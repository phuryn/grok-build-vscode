// Real-time STT. PcmVoiceStreamer owns the xAI WebSocket and accepts raw
// PCM16/16 kHz/mono bytes from any producer. VoiceStreamer composes it with
// ffmpeg for the local microphone; AFK Pilot feeds PcmVoiceStreamer directly.
import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  buildSttStreamUrl,
  buildFfmpegStreamArgs,
  applySegment,
  joinSegments,
  classifySttError,
  TranscriptSegment,
} from "./voice";
import { resolveWindowsAudioDevice } from "./voice-recorder";

export interface PcmStreamStartOpts {
  apiKey: string;
  language?: string;
  keyterms?: string[];
  log?: (msg: string) => void;
}

export interface StreamStartOpts extends PcmStreamStartOpts {
  ffmpegPath: string;
  device?: string;
}

export function redactVoiceStreamUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const names = [...parsed.searchParams.keys()];
    const query = names.map((name) => `${encodeURIComponent(name)}=<redacted>`).join("&");
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return String(url).split("?")[0];
  }
}

export interface PartialEvent {
  text: string;
  speechFinal: boolean;
}

export class PcmVoiceStreamer extends EventEmitter {
  private static readonly FINAL_RESULT_TIMEOUT_MS = 5000;
  private ws?: WebSocket;
  private segments: TranscriptSegment[] = [];
  private stopping = false;
  private terminal?: { promise: Promise<void>; resolve: () => void };

  get active(): boolean {
    return !!this.ws;
  }

  get transcript(): string {
    return joinSegments(this.segments);
  }

  start(opts: PcmStreamStartOpts): Promise<void> {
    if (this.ws) return Promise.reject(new Error("Speech-to-Text stream is already active."));
    this.stopping = false;
    this.segments = [];
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

      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        let ev: any;
        try { ev = JSON.parse(data.toString()); } catch { return; }
        if (ev.type === "transcript.created") {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (ev.type === "transcript.partial") {
          this.segments = applySegment(this.segments, ev);
          this.emit("partial", { text: joinSegments(this.segments), speechFinal: !!ev.speech_final } as PartialEvent);
        } else if (ev.type === "transcript.done") {
          if (this.segments.length === 0 && typeof ev.text === "string" && ev.text.trim()) {
            this.segments = applySegment(this.segments, { start: 0, text: ev.text });
            this.emit("partial", { text: joinSegments(this.segments), speechFinal: true } as PartialEvent);
          }
          this.finishTerminal();
        } else if (ev.type === "error") {
          fail(new Error(ev.message || ev.error || "Speech-to-Text streaming error."));
        }
      });
      ws.on("unexpected-response", (_req, res: { statusCode?: number }) => {
        const status = res && res.statusCode;
        fail(new Error(status ? classifySttError(status) : "Speech-to-Text streaming failed to connect."));
      });
      ws.on("error", (e: Error) => {
        const m = /\b(401|403)\b/.exec(e.message || "");
        fail(m ? new Error(classifySttError(Number(m[1]))) : e);
      });
      ws.on("close", () => {
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

  async stop(): Promise<string> {
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
    const text = this.transcript;
    this.dispose();
    return text;
  }

  cancel(): void {
    this.stopping = true;
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
  private pcm?: PcmVoiceStreamer;
  private proc?: ChildProcess;
  private stopping = false;

  get active(): boolean {
    return !!this.pcm || !!this.proc;
  }

  get transcript(): string {
    return this.pcm?.transcript ?? "";
  }

  async start(opts: StreamStartOpts): Promise<void> {
    if (this.active) throw new Error("Voice stream is already active.");
    this.stopping = false;
    const pcm = new PcmVoiceStreamer();
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
      await this.beginCapture(opts, pcm);
    } catch (e) {
      this.cancel();
      throw e;
    }
  }

  private async beginCapture(opts: StreamStartOpts, pcm: PcmVoiceStreamer): Promise<void> {
    let device = opts.device;
    if (process.platform === "win32" && !device) {
      device = await resolveWindowsAudioDevice(opts.ffmpegPath, opts.log);
      if (!device) {
        throw new Error("No microphone (DirectShow audio device) was found. Set grok.voiceInputDevice to its name.");
      }
    }
    const args = buildFfmpegStreamArgs(process.platform, { device });
    opts.log?.(`[voice-stream] capture: ${opts.ffmpegPath} ${args.join(" ")}`);
    const proc = spawn(opts.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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

  async stop(): Promise<string> {
    this.stopping = true;
    await this.drainCapture();
    const pcm = this.pcm;
    this.pcm = undefined;
    const text = pcm ? await pcm.stop() : "";
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
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.on("close", finish);
      try { proc.stdin?.write("q"); proc.stdin?.end(); } catch { /* fall through */ }
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } finish(); }, 2500);
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
