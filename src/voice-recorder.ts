// Impure side of voice control: spawn ffmpeg to capture the mic in the extension
// host (webviews can't reach the microphone), and POST the clip to xAI's
// Speech-to-Text API. The deterministic bits (arg building, device parsing,
// response/error handling) live in voice.ts and are unit-tested; this file is
// the thin spawn/fetch shell, smoke-tested manually via research/voice-stt-probe.cjs.
import { spawn, ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { Blob } from "node:buffer";
import {
  buildFfmpegArgs,
  buildListDevicesArgs,
  buildSttRequest,
  classifySttError,
  cleanTranscript,
  parseDshowAudioDevices,
  parseSttResponse,
} from "./voice";

export interface StartOpts {
  ffmpegPath: string;
  outputPath: string;
  device?: string;
  log?: (msg: string) => void;
}

/**
 * Resolve a DirectShow audio device name on Windows (dshow has no "default", so
 * a real device must be named). Returns the first audio device, or undefined.
 * Shared by the batch recorder and the streamer.
 */
export function resolveWindowsAudioDevice(ffmpegPath: string, log?: (m: string) => void): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stderr = "";
    let proc: ChildProcess;
    try {
      proc = spawn(ffmpegPath, buildListDevicesArgs(), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", () => resolve(undefined));
    proc.on("exit", () => {
      const devices = parseDshowAudioDevices(stderr);
      log?.(`[voice] dshow audio devices: ${devices.join(" | ") || "(none)"}`);
      resolve(devices[0]);
    });
  });
}

/**
 * Records the microphone via an ffmpeg child process. Stop is graceful — we send
 * `q` on ffmpeg's stdin so it finalizes the WAV header (a hard kill would leave
 * a truncated, unreadable file) — with a SIGKILL fallback if it doesn't exit.
 */
export class VoiceRecorder {
  private proc?: ChildProcess;
  private outputPath?: string;

  get active(): boolean {
    return !!this.proc;
  }

  async start(opts: StartOpts): Promise<void> {
    if (this.proc) throw new Error("Already recording.");
    let device = opts.device;
    // dshow has no "default" pseudo-device, so on Windows we must name a real
    // capture device. Enumerate and pick the first audio device when unset.
    if (process.platform === "win32" && !device) {
      device = await resolveWindowsAudioDevice(opts.ffmpegPath, opts.log);
      if (!device) {
        throw new Error(
          "No microphone (DirectShow audio device) was found. Plug one in, or set grok.voiceInputDevice to its name.",
        );
      }
    }

    const args = buildFfmpegArgs(process.platform, { device, outputPath: opts.outputPath });
    opts.log?.(`[voice] record: ${opts.ffmpegPath} ${args.join(" ")}`);
    const proc = spawn(opts.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    this.proc = proc;
    this.outputPath = opts.outputPath;

    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      proc.on("error", (err: NodeJS.ErrnoException) => {
        this.proc = undefined;
        if (settled) return;
        settled = true;
        reject(
          err.code === "ENOENT"
            ? new Error("ffmpeg was not found. Install ffmpeg (https://ffmpeg.org) or set grok.ffmpegPath.")
            : err,
        );
      });
      proc.on("exit", (code) => {
        // A quick non-zero exit before we've stopped means capture failed to
        // start (bad device, permission, busy mic) — surface ffmpeg's reason.
        if (settled) return;
        settled = true;
        this.proc = undefined;
        reject(new Error(`ffmpeg exited (code ${code}) before recording started. ${stderr.slice(-300).trim()}`));
      });
      // No early failure within the grace window → treat as recording.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 500);
    });
  }

  /** Stop recording and resolve with the finalized WAV path. */
  async stop(): Promise<string> {
    const proc = this.proc;
    const out = this.outputPath;
    this.proc = undefined;
    if (!proc || !out) throw new Error("Not recording.");
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.on("exit", finish);
      try {
        proc.stdin?.write("q");
        proc.stdin?.end();
      } catch {
        /* fall through to the kill fallback */
      }
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        finish();
      }, 5000);
    });
    return out;
  }

  /** Abandon an in-flight recording without transcribing (e.g. on dispose). */
  cancel(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.outputPath = undefined;
    if (!proc) return;
    try { proc.stdin?.write("q"); proc.stdin?.end(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
  }

}

/**
 * POST a recorded WAV to the xAI Speech-to-Text API and return the transcript.
 * Throws a user-facing message on any failure (bad key, empty clip, HTTP error).
 */
export async function transcribeAudio(
  wavPath: string,
  apiKey: string,
  log?: (msg: string) => void,
): Promise<string> {
  const bytes = readFileSync(wavPath);
  // A valid WAV header alone is 44 bytes; anything this small captured no audio.
  if (bytes.length < 2048) {
    throw new Error("The recording was empty — no audio was captured. Check your microphone and try again.");
  }
  const { url, headers } = buildSttRequest({ key: apiKey });
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "recording.wav");
  log?.(`[voice] POST ${url} (${bytes.length} bytes)`);
  const res = await fetch(url, { method: "POST", headers, body: form });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(classifySttError(res.status, bodyText));
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("Voice transcription returned a non-JSON response.");
  }
  return cleanTranscript(parseSttResponse(json).text);
}
