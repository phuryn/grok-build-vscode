import type { AcpProvider } from "./acp-backend";
// Pure helpers for the voice-input feature. No I/O, no process spawning — every
// function here is deterministic so it can be unit-tested without a microphone,
// ffmpeg, or a network call. The impure orchestration (spawning ffmpeg, the STT
// HTTP POST) lives in voice-recorder.ts; the live round-trip is exercised
// manually via research/voice-stt-probe.cjs (grok-free CI never hits the API).
//
// Why voice lives OUTSIDE the ACP/CLI path: the grok CLI advertises
// promptCapabilities.audio:false and rejects audio content blocks, and VS Code
// webviews cannot access the microphone. So capture happens in the extension
// host (ffmpeg child process) and transcription goes straight to xAI's separate
// Speech-to-Text product (api.x.ai/v1/stt). See research/voice-input.md.

export const STT_ENDPOINT = "https://api.x.ai/v1/stt";

export function redactVoiceStreamUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const names = [...parsed.searchParams.keys()];
    const query = names.map(name => `${encodeURIComponent(name)}=<redacted>`).join("&");
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return String(url).split("?")[0];
  }
}

type LegacySttBackend = "xai" | "openai";
export type SttBackend = LegacySttBackend | "google";
export type SttPreference = "auto" | SttBackend;

export function sttPreference(value: unknown): SttPreference {
  return value === "xai" || value === "openai" || value === "google" ? value : "auto";
}

/** An explicit choice is strict. Automatic fallback is credential-based only. */
export function pickSttBackend(opts: {
  provider: AcpProvider;
  hasXai: boolean;
  hasOpenAi: boolean;
  hasGoogle?: boolean;
  preference?: SttPreference;
}): SttBackend | undefined {
  const available = { xai: opts.hasXai, openai: opts.hasOpenAi, google: opts.hasGoogle };
  if (opts.preference && opts.preference !== "auto") {
    return available[opts.preference] ? opts.preference : undefined;
  }
  const preferred = opts.provider === "codex" ? "openai" : opts.provider === "agy" ? "google" : "xai";
  return ([preferred, "xai", "openai", "google"] as const).find(backend => available[backend]);
}

export function resolveOpenAiVoiceKey(opts: {
  setting?: string;
  env?: Record<string, string | undefined>;
}): string | undefined {
  return opts.setting?.trim() || opts.env?.OPENAI_API_KEY?.trim() || undefined;
}

export function resolveGoogleVoiceKey(opts: {
  setting?: string;
  savedKey?: string;
  env?: Record<string, string | undefined>;
}): string | undefined {
  return opts.setting?.trim() || opts.savedKey?.trim()
    || opts.env?.GEMINI_API_KEY?.trim() || opts.env?.GOOGLE_API_KEY?.trim() || undefined;
}

export function sttKeySetting(backend: SttBackend): string {
  return backend === "google" ? "grok.voiceGoogleApiKey"
    : backend === "openai" ? "grok.voiceOpenAiApiKey" : "grok.voiceApiKey";
}

export interface VoiceBackendState {
  provider: AcpProvider;
  /** Legacy select values. An explicit Google choice projects to Auto here. */
  preference: "auto" | LegacySttBackend;
  googlePreference?: "google";
  backend?: SttBackend;
  hasXai: boolean;
  hasOpenAi: boolean;
  /** Presence advertises Google support, even when no key is available. */
  hasGoogle?: boolean;
  backends: Record<AcpProvider, SttBackend | null>;
}

/** Hard cap on a single recording (seconds). ffmpeg self-terminates at this, so
 *  a forgotten "listening" session can't record forever or balloon the upload. */
export const MAX_RECORDING_SECONDS = 120;

export interface SttWord {
  text: string;
  start: number;
  end: number;
}

export interface SttResult {
  text: string;
  language?: string;
  duration?: number;
  words?: SttWord[];
}

const AUTH_EXPIRY_SKEW_MS = 60_000; // refuse a token within a minute of expiry

/** Parse an `expires_at` (number, numeric-string, or ISO/date string) to epoch
 *  ms, tolerating seconds- vs ms-epoch. Null when absent or unparseable. */
function parseAuthExpiryMs(raw: unknown): number | null {
  if (raw == null) return null;
  let n: number;
  if (typeof raw === "number") n = raw;
  else {
    const str = String(raw).trim();
    // A bare numeric string ("1700000000") is an epoch, NOT a date — Date.parse
    // returns NaN for it in Node, which would read as "never expires" (#51/Codex).
    n = /^\d+(\.\d+)?$/.test(str) ? Number(str) : Date.parse(str);
  }
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n; // < ~2001 in ms ⇒ it was seconds-epoch
}

/** True when the top-level auth.json entry key (`<issuer-url>::<uuid>`) is an
 *  xAI issuer — so we never forward some unrelated `.key` to xAI's STT endpoint. */
function isXaiIssuerKey(topKey: string): boolean {
  const issuer = String(topKey).split("::")[0];
  try {
    const host = new URL(issuer).host.toLowerCase();
    return host === "x.ai" || host.endsWith(".x.ai");
  } catch { return false; }
}

/**
 * Pull the reusable API token the grok CLI stores after `grok login`, from the
 * text of `~/.grok/auth.json` — the same value a user can paste into the Voice
 * key field (confirmed working for STT, #51). The file is an object keyed by an
 * `<issuer-url>::<uuid>`; each entry carries a `key` (the token) and an optional
 * `expires_at`. Only xAI-issued entries are considered, and a KNOWN-expired
 * token is refused (returns undefined) so the mic doesn't look configured then
 * 401 mid-recording — a token with an absent/unparseable expiry is still used.
 * Pure; `now` is injectable for tests. Undefined on parse failure or when no
 * usable, non-expired xAI entry exists.
 */
export function extractGrokAuthKey(authJsonText: string, now: number = Date.now()): string | undefined {
  let obj: any;
  try { obj = JSON.parse(authJsonText); } catch { return undefined; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const keyOf = (e: any): string => (e && typeof e.key === "string" ? e.key.trim() : "");
  const notExpired = (e: any): boolean => {
    const ms = parseAuthExpiryMs(e?.expires_at);
    return ms == null || ms - AUTH_EXPIRY_SKEW_MS > now; // absent/unparseable ⇒ try it
  };
  const chosen = Object.entries(obj)
    .filter(([topKey, e]) => isXaiIssuerKey(topKey) && keyOf(e) && notExpired(e))
    .map(([, e]) => e)[0];
  return chosen ? keyOf(chosen) : undefined;
}

/**
 * Resolve the xAI key used for Speech-to-Text. Order: the explicit
 * `grok.voiceApiKey` setting wins; then env vars (the caller passes a map that
 * layers workspace .env over process.env — a dedicated `GROK_VOICE_API_KEY` is
 * preferred over the generic `XAI_API_KEY`); finally `authKey`, the token the
 * CLI stored at `grok login` (`~/.grok/auth.json`, via `extractGrokAuthKey`), so
 * Voice works without a separate paid key (#51).
 */
export function resolveVoiceKey(opts: {
  setting?: string;
  env?: Record<string, string | undefined>;
  authKey?: string;
}): string | undefined {
  const setting = (opts.setting || "").trim();
  if (setting) return setting;
  const env = opts.env || {};
  for (const name of ["GROK_VOICE_API_KEY", "XAI_API_KEY"]) {
    const v = (env[name] || "").trim();
    if (v) return v;
  }
  const authKey = (opts.authKey || "").trim();
  if (authKey) return authKey;
  return undefined;
}

export interface FfmpegCaptureOpts {
  /** Platform-specific input device. On Windows this MUST be a real DirectShow
   *  audio device name (dshow has no "default"); the recorder resolves it via
   *  parseDshowAudioDevices when the user hasn't configured one. */
  device?: string;
  outputPath: string;
  maxSeconds?: number;
}

/** The per-OS capture input flags, shared by the batch (file) and streaming
 *  (pipe) arg builders. dshow (Windows), avfoundation (macOS), pulse (Linux). */
function ffmpegInputArgs(platform: NodeJS.Platform, device?: string): string[] {
  if (platform === "win32") {
    return ["-f", "dshow", "-i", `audio=${device || "default"}`];
  }
  if (platform === "darwin") {
    // avfoundation input is "[[video]:[audio]]"; ":0" = default audio, no video.
    const d = device || "0";
    return ["-f", "avfoundation", "-i", d.startsWith(":") ? d : `:${d}`];
  }
  return ["-f", "pulse", "-i", device || "default"];
}

/**
 * Build the ffmpeg argument vector to capture the default (or named) microphone
 * to a mono 16 kHz WAV — small to upload, plenty for speech. Each OS uses its
 * native capture backend: dshow (Windows), avfoundation (macOS), pulse (Linux).
 */
export function buildFfmpegArgs(platform: NodeJS.Platform, opts: FfmpegCaptureOpts): string[] {
  const maxSeconds = opts.maxSeconds ?? MAX_RECORDING_SECONDS;
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...ffmpegInputArgs(platform, opts.device),
    "-ac", "1", "-ar", "16000",
    "-t", String(maxSeconds),
    opts.outputPath,
  ];
}

/**
 * Build the ffmpeg args for *streaming* capture: raw signed-16-bit-LE PCM at
 * 16 kHz mono to stdout (`pipe:1`), which is exactly what the STT WebSocket
 * expects as binary frames (`encoding=pcm`).
 */
export function buildFfmpegStreamArgs(platform: NodeJS.Platform, opts: { device?: string; maxSeconds?: number } = {}): string[] {
  const maxSeconds = opts.maxSeconds ?? MAX_RECORDING_SECONDS;
  return [
    "-hide_banner", "-loglevel", "error",
    ...ffmpegInputArgs(platform, opts.device),
    "-ac", "1", "-ar", "16000",
    "-t", String(maxSeconds),
    "-f", "s16le", "pipe:1",
  ];
}

/** Args to enumerate DirectShow devices (Windows). ffmpeg prints them to stderr
 *  and exits non-zero — that's expected, the output is the payload. */
export function buildListDevicesArgs(): string[] {
  return ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
}

/**
 * Parse the audio device names out of `ffmpeg -list_devices` stderr. Handles
 * both ffmpeg output styles: the newer `"Name" (audio)` suffix form and the
 * older section-header form ("DirectShow audio devices" then quoted names).
 * "Alternative name" lines and video devices are skipped.
 */
export function parseDshowAudioDevices(stderr: string): string[] {
  const out: string[] = [];
  let section: "audio" | "video" | null = null;
  for (const line of (stderr || "").split(/\r?\n/)) {
    if (/DirectShow video devices/i.test(line)) { section = "video"; continue; }
    if (/DirectShow audio devices/i.test(line)) { section = "audio"; continue; }
    if (/Alternative name/i.test(line)) continue;
    const m = line.match(/"([^"]+)"/);
    if (!m) continue;
    if (/\(video\)/i.test(line)) continue;
    if (/\(audio\)/i.test(line) || section === "audio") out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Build the STT POST target + headers. The multipart body (the file part) is
 *  assembled by the caller, which owns the FormData/Blob globals. */
export function buildSttRequest(opts: { key: string }): { url: string; headers: Record<string, string> } {
  return { url: STT_ENDPOINT, headers: { Authorization: `Bearer ${opts.key}` } };
}

export const STT_STREAM_ENDPOINT = "wss://api.x.ai/v1/stt";

export interface SttStreamParams {
  sampleRate?: number;
  encoding?: string;
  interimResults?: boolean;
  /** Optional language code. The streaming endpoint uses this to enable
   *  Inverse Text Normalization; omitting it preserves spoken-form text. */
  language?: string;
  /** Bias terms (e.g. the "grok send" send-phrase) so the model spells them
   *  right — directly fixes mishearings. Repeatable; ≤100 terms, ≤50 chars each. */
  keyterms?: string[];
}

/** The documented keyterm ceiling ("≤100 terms, ≤50 chars each"). */
export const MAX_STT_KEYTERMS = 100;
/** Per-term character cap, matching the SpaceXAI streaming keyterm limit. */
export const MAX_VOICE_KEYTERM_CHARS = 50;

/** Trim a send-phrase edit. Empty disables hands-free send. */
export function sanitizeVoiceSendPhrase(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalize a user-edited dictionary: strings only, trimmed, 50-char, unique, capped. */
export function sanitizeVoiceKeyterms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const term = item.trim().slice(0, MAX_VOICE_KEYTERM_CHARS);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_STT_KEYTERMS) break;
  }
  return out;
}

export interface VoiceSettingInspect<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * Write the scope that produced the displayed voice value.
 *
 * Settings show the resource-effective config (`voiceSettingForRepo`). A
 * workspace / folder override is what the user is looking at, so an edit must
 * update that override — writing User/global would leave the displayed value
 * unchanged. Repos outside the window workspace already display User/default,
 * so they stay on global even if the open window has its own override.
 */
export function voiceSettingWriteTarget(
  inspect: VoiceSettingInspect<unknown> | undefined,
  repoIsInWorkspace: boolean,
): "global" | "workspace" | "workspaceFolder" {
  if (!repoIsInWorkspace) return "global";
  if (inspect?.workspaceFolderValue !== undefined) return "workspaceFolder";
  if (inspect?.workspaceValue !== undefined) return "workspace";
  return "global";
}

/**
 * Resolve a voice setting for a session cwd. VS Code includes window-workspace
 * values even when `getConfiguration` is scoped to a resource outside that
 * workspace, so an external AFK Pilot repo must fall back to User/default
 * values instead of inheriting another repo's project vocabulary.
 */
export function voiceSettingForRepo<T>(
  effectiveValue: T | undefined,
  inspected: VoiceSettingInspect<T> | undefined,
  repoIsInWorkspace: boolean,
  fallback: T,
): T {
  if (repoIsInWorkspace) return effectiveValue ?? fallback;
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}

/** Assemble recognition-bias terms in priority order. The send phrase is
 *  behavior-critical, and the built-in product term preserves existing bias;
 *  user vocabulary fills the remaining service-supported slots. */
export function buildSttKeyterms(sendPhrase: string, userTerms: readonly string[] = []): string[] {
  const terms = [sendPhrase, "Grok", ...userTerms]
    .map((term) => (term || "").trim())
    .filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_STT_KEYTERMS);
}

/** Build the streaming STT WebSocket URL. Config rides in query params (the
 *  endpoint takes no setup message); auth is a Bearer header set by the caller. */
export function buildSttStreamUrl(params: SttStreamParams = {}): string {
  const qs = new URLSearchParams();
  qs.set("sample_rate", String(params.sampleRate ?? 16000));
  qs.set("encoding", params.encoding ?? "pcm");
  qs.set("interim_results", params.interimResults === false ? "false" : "true");
  const language = params.language?.trim();
  if (language) qs.set("language", language);
  let appended = 0;
  for (const term of params.keyterms ?? []) {
    if (appended >= MAX_STT_KEYTERMS) break; // enforce the doc'd cap, not just state it
    const t = (term || "").trim();
    if (t) {
      qs.append("keyterm", t.slice(0, 50));
      appended++;
    }
  }
  return `${STT_STREAM_ENDPOINT}?${qs.toString()}`;
}

export interface TranscriptSegment {
  start: number;
  text: string;
}

/**
 * Fold a streaming `transcript.partial` event into the running segment list.
 * The endpoint keys segments by `start` and re-emits the same `start` as the
 * text grows and finalizes (and the trailing `transcript.done` can be empty),
 * so we keep the LATEST text per `start`. Pure + testable.
 */
export function applySegment(segments: TranscriptSegment[], ev: { start?: unknown; text?: unknown }): TranscriptSegment[] {
  if (typeof ev.start !== "number" || typeof ev.text !== "string") return segments;
  const next = segments.filter((s) => s.start !== ev.start);
  next.push({ start: ev.start, text: ev.text });
  next.sort((a, b) => a.start - b.start);
  return next;
}

/** Join accumulated segments (ordered by start) into the full transcript. */
export function joinSegments(segments: TranscriptSegment[]): string {
  return segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
}

/** Pull the transcript (and optional metadata) out of the STT JSON response. */
export function parseSttResponse(json: any): SttResult {
  if (!json || typeof json.text !== "string") {
    throw new Error("Speech-to-Text response had no 'text' field.");
  }
  return {
    text: json.text,
    language: typeof json.language === "string" ? json.language : undefined,
    duration: typeof json.duration === "number" ? json.duration : undefined,
    words: Array.isArray(json.words) ? json.words : undefined,
  };
}

/** Map an STT HTTP failure to a message worth showing the user. */
export function classifySttError(status: number, body?: string): string {
  if (status === 401 || status === 403) {
    return "Voice transcription was rejected (401/403): the xAI key is missing, invalid, or expired. If you're relying on your `grok login`, try signing in again (`grok logout` then `grok login`); or set grok.voiceApiKey, or GROK_VOICE_API_KEY / XAI_API_KEY in your workspace .env (get a key at console.x.ai).";
  }
  if (status === 429) return "Voice transcription is rate-limited (429). Wait a moment and try again.";
  if (status === 413) return "The recording is too large to transcribe (413). Record a shorter message.";
  if (status === 400 || status === 422) {
    return "The xAI Speech-to-Text service rejected the audio (400). The recording may be empty or in an unsupported format.";
  }
  if (status >= 500) return `The xAI Speech-to-Text service errored (${status}). Try again shortly.`;
  const tail = body ? ` ${body.slice(0, 200)}` : "";
  return `Voice transcription failed (HTTP ${status}).${tail}`;
}

/** Normalize a transcript for dropping into the composer. */
export function cleanTranscript(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export const DEFAULT_SEND_PHRASE = "grok send";

/**
 * Identity of a `voiceConfigured` frame. Watcher noise under `~/.grok` posts
 * identical frames; destinations skip when this matches the last one they got.
 * Phrase and keyterms belong here — a prefs change must still go out.
 */
export function voiceConfiguredFingerprint(payload: {
  value: boolean;
  sendPhrase?: string;
  keyterms?: readonly string[];
  backendState?: VoiceBackendState;
}): string {
  return JSON.stringify({
    value: !!payload.value,
    sendPhrase: typeof payload.sendPhrase === "string" ? payload.sendPhrase : "",
    keyterms: Array.isArray(payload.keyterms) ? [...payload.keyterms] : [],
    backendState: payload.backendState,
  });
}

export interface VoiceCommandResult {
  /** The transcript with a trailing send-phrase stripped off. */
  text: string;
  /** True when the transcript ended with the send phrase. */
  send: boolean;
}

/** A timeout may leave useful draft text, but that draft must never submit. */
export function parseFinalVoiceCommand(text: string, finalizedText: string, phrase: string): VoiceCommandResult {
  return text === finalizedText ? parseVoiceCommand(text, phrase) : { text, send: false };
}

/**
 * Detect a trailing "send" voice command (default phrase "grok send") so a user
 * can dictate and submit hands-free. Only a *trailing* match counts, and the
 * default phrase is two words specifically so it doesn't fire on a message that
 * merely ends in "send". An empty phrase disables detection. Pure + testable.
 */
/** Regex fragment for one phrase word, tolerating common STT confusions —
 *  notably "send" ⇄ "sent" (xAI's STT often hears "grok send" as "grok sent"). */
export function phraseWordPattern(word: string): string {
  const lower = word.toLowerCase();
  if (lower === "send" || lower === "sent") return "sen[dt]";
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseVoiceCommand(transcript: string, sendPhrase: string = DEFAULT_SEND_PHRASE): VoiceCommandResult {
  const t = (transcript || "").trim();
  const phrase = (sendPhrase || "").trim();
  if (!phrase) return { text: t, send: false };
  // Build a tolerant trailing matcher from the phrase words: STT may insert a
  // comma between words ("…fix the bug, grok send") and may hear "send" as
  // "sent" (see phraseWordPattern). Trailing punctuation after the phrase is
  // captured separately and kept on the message — "…today grok send?" → "…today?".
  const words = phrase.split(/\s+/).map(phraseWordPattern);
  const re = new RegExp(`[\\s,]*\\b${words.join("[,\\s]+")}\\b([\\s.!?…]*)$`, "i");
  const m = re.exec(t);
  if (!m) return { text: t, send: false };
  const before = t.slice(0, m.index).replace(/[\s,]+$/, "");
  // Keep at most one trailing sentence mark. If the message ALREADY ends in
  // punctuation ("…today? grok send?"), keep that and drop the command's
  // trailing punctuation — otherwise we'd get "??", "..", "?.", "!?", etc.
  // Only when there was no punctuation before do we adopt the command's mark
  // ("…today grok send?" → "…today?").
  let text = before;
  if (before && !/[.!?…]$/.test(before)) {
    const punct = (m[1] || "").replace(/[^.!?…]/g, "");
    if (punct) text = before + punct[0];
  }
  return { text: text.trim(), send: true };
}
