# Google Live transcription

AFK Pilot uses `gemini-3.5-transcribe-live` through the Gemini Live API. The model
page gives the ID without a release-stage label. The Live API reference itself
labels the API preview. The Google Cloud model ID uses a different suffix.
[Model](https://aistudio.google.com/docs/models/gemini-3.5-transcribe) ·
[WebSocket reference](https://aistudio.google.com/api-reference/live)

## Wire contract

- The host opens
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
  with the key in the `x-goog-api-key` header, so no URL or log line carries it.
  The guide shows a `?key=` query parameter; the header was checked against the
  live endpoint on 22 Nov 2026 and is accepted the same way. Errors use fixed
  wording and never include the vendor's response body, network error, or
  WebSocket close reason; known close reasons are matched to choose the wording.
- The first JSON frame is `setup`. It sets
  `model: "models/gemini-3.5-transcribe-live"`,
  `generationConfig.responseModalities: ["TEXT"]`, and
  `inputAudioTranscription: { languageCodes, customVocabulary }`. Empty
  language codes mean auto-detect. A configured hint is one BCP-47 code.
  AFK Pilot sends at most 100 vocabulary terms. Google accepts up to 1,000.
  Transcription uses the default VERBATIM mode.
- The general WebSocket reference says to wait for `setupComplete` before
  sending further frames. The transcription quickstart omits that step. The
  adapter follows the reference and times out after 8 seconds, including setup.
- `realtimeInput.audio` contains base64 PCM16, 16 kHz, mono, little-endian, with
  `mimeType: "audio/pcm;rate=16000"`. The adapter sends 100 ms chunks and
  flushes the shorter tail on Stop.
- `serverContent.interimInputTranscription.text` replaces the current guess.
  `serverContent.inputTranscription.text` appends the next final VERBATIM
  segment and clears the guess. An omitted `text` is empty. The shared
  hands-free path only sends from finalized text.
- Stop flushes audio, then sends `realtimeInput.audioStreamEnd: true`. Input
  transcription can arrive after `generationComplete` or `turnComplete`. The
  adapter waits for a completion marker and 500 ms of quiet with no outstanding
  interim, bounded by 8 seconds total. A timeout leaves the latest text
  available to the host as a draft. Cancel closes immediately. Google
  documents a 10-minute session limit. AFK Pilot caps recordings at 120 seconds.
- Measured on 22 Nov 2026 with two spoken phrases: Google ends each voice
  segment with its final `inputTranscription`, then `generationComplete`, then
  `voiceActivity` `ACTIVITY_END`, and opens the next segment with
  `ACTIVITY_START`. It never sent `turnComplete`. A segment's final arrived
  about 1 second after its speech ended, so an earlier phrase is already final
  when the user stops after a later one; a 300 ms pause merged two phrases
  into one segment. With Stop called the instant the audio ended, the last
  final arrived about 0.3 seconds later and Stop resolved 0.5 seconds after
  that. Every phrase was kept in 5 of 5 runs, with pauses of 300 to 1,500 ms.

[Live transcription guide](https://aistudio.google.com/docs/live-api/live-transcribe) ·
[WebSocket reference](https://aistudio.google.com/api-reference/live)

## Credentials, errors, and mixed versions

The host checks `grok.voiceGoogleApiKey`, the existing Antigravity secret, then
`GEMINI_API_KEY` and `GOOGLE_API_KEY`. Only availability goes to the renderer.
Google sign-in supplies no Gemini API key. The published paid price is
$0.005/minute audio input plus $0.004/minute text output. Google may use audio
to improve its products on the free tier. Its pricing table marks paid usage
as excluded from product improvement. [Gemini API pricing](https://aistudio.google.com/docs/pricing)

HTTP 401/403 and structured `UNAUTHENTICATED` or `PERMISSION_DENIED` errors show
key and project-access guidance. HTTP 400 or `INVALID_ARGUMENT` gives key
and request guidance. HTTP 429 or `RESOURCE_EXHAUSTED` gives quota guidance.
WebSocket close 1008 is a general policy rejection, so the message also points
to project access and transcription settings. Observed live on 22 Nov 2026, as
close frames right after the socket opened: a bad key closes 1007 "API key not
valid. Please pass a valid API key."; a project without credits closes 1011
"Your prepayment credits are depleted. ..."; a project over its spending cap
closes 1011 "Your project has exceeded its monthly spending cap. ...". Google
checks billing before the model id. Each gets its own plain message. [Gemini troubleshooting](https://aistudio.google.com/docs/troubleshooting) ·
[Google API error codes](https://google.aip.dev/193) ·
[WebSocket close codes](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1)

`voiceConfigured.backendState.hasGoogle` advertises support even when false.
New renderers require it before offering Google. With an explicit Google
choice, the legacy `preference` stays `auto` and `googlePreference` carries
the choice. The previous renderer assigns `preference` to a select with three
known values and uses the per-provider `backends` values only for truthiness.
Its picker shows Auto and the mic reflects actual readiness. The previous
host refuses `google` in both the Electron validator and the host handler.

## Owner probe

Build with `npm run compile`, then use a short mono 16 kHz PCM16 little-endian
WAV or raw PCM file containing speech. The probe streams at microphone pace
through `createPcmVoiceStreamer("google")`, printing interim and final text.

```sh
GEMINI_API_KEY=... node research/voice-google-probe.cjs ./sample.wav
```

Listen for a pause and a last word immediately before EOF. The run checks
that setup is acknowledged and that the last segment reaches the final
output after Stop. Automated tests use a fake WebSocket server.
