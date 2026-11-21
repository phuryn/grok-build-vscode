# Voice control — setup & advanced configuration

The microphone button dictates speech using OpenAI Realtime transcription or xAI Speech-to-Text. Click it, wait for the listening waves, and speak — words appear live. Say **"grok send"** to submit once the phrase is finalized and keep listening for the next message. Click the mic again to finalize the recording and keep the text.

In Settings → Voice, **Transcription backend** defaults to Auto:

| Agent | Preferred backend | When its credential is absent |
|---|---|---|
| Codex | OpenAI | xAI |
| Grok | xAI | OpenAI |
| Claude | xAI | OpenAI |
| Muse Code, Antigravity, DeepSeek | xAI | OpenAI |

Existing xAI-only Codex users keep working dictation. An explicit backend choice requires that backend's credential. The backend is pinned until recording ends, including hands-free restarts; a service error never switches vendors.

## 1. Authentication

If you are signed in with **`grok login`**, voice **just works** — read the rest of
this section only if you need it.

### xAI — usually automatic

The extension reuses your `grok login` token (`~/.grok/auth.json`) for
Speech-to-Text automatically. No separate key, nothing to paste.

**Optional dedicated key.** If you'd rather use a distinct [console.x.ai](https://console.x.ai) developer key — to bill it separately, keep it account-scoped, or if your login token doesn't cover STT — set any one of these (they take precedence over the login token, in this order):

| Where | Setting / var |
|---|---|
| VS Code setting | `grok.voiceApiKey` |
| Workspace `.env` | `GROK_VOICE_API_KEY` (preferred) |
| Workspace `.env` | `XAI_API_KEY` (shared with other tools) |

A known-**expired** login token is skipped (so the mic doesn't look ready and then fail mid-recording); if that happens, run `grok logout` then `grok login`, or set a dedicated key above.

### OpenAI — always a key

There is no automatic fallback here: **a Codex / ChatGPT sign-in does not include
transcription API access**, so this backend needs a key from an OpenAI
API-platform account and is otherwise unavailable. Use **Set API key** in
Settings → Voice, set `grok.voiceOpenAiApiKey`, or set `OPENAI_API_KEY` in the
project's `.env` or the host environment — the setting wins, and a project `.env`
overrides the environment. For Codex- and Claude-only users this removes the need
for an xAI key at all; the usage is billed to that OpenAI account either way.

## 2. ffmpeg — required for the VS Code microphone

Recording the microphone uses [`ffmpeg`](https://ffmpeg.org). Most dev machines already have it; if voice reports it missing, install it:

AFK Pilot records in the remote browser with the Web Audio API and sends
ephemeral raw PCM to the extension host, so its microphone does not require
ffmpeg on the browser device. It still uses the host-side credential and the
selected STT adapter. The browser always sends PCM16/16 kHz/mono; the OpenAI adapter converts to 24 kHz on the host.

- **Windows:** `winget install ffmpeg` (or `choco install ffmpeg`), or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add it to `PATH`.
- **macOS:** `brew install ffmpeg`.
- **Linux:** `sudo apt install ffmpeg` (or your distro's equivalent).

If it's installed somewhere off `PATH`, point `grok.ffmpegPath` at the binary.

## 3. Cost

Both backends are metered by audio duration, and the surprise worth avoiding is
discovering that *after* wiring up a key — so the numbers are here rather than
behind a link.

**xAI**, measured end-to-end: **$0.10/hr** batch, **$0.20/hr** streaming. In
practice ~500 words ≈ ½–1¢; a heavy 10,000-word day ≈ 10¢. Whether it draws on
your subscription or is billed pay-as-you-go depends on the credential used. How
it was measured: [research/voice-input.md](../research/voice-input.md).

**OpenAI** is billed to your API-platform account and **not** covered by a
ChatGPT subscription, whatever plan you are on. Current per-minute rates are on
the [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-live-transcribe);
they are not repeated here because they move.

## 4. Other settings

| Setting | Default | What it does |
|---|---|---|
| `grok.voiceBackend` | `auto` | Credential-based routing above; `xai` or `openai` pins an explicit choice. |
| `grok.voiceOpenAiApiKey` | `""` | OpenAI API key override; empty uses `OPENAI_API_KEY`. |
| `grok.voiceOpenAiModel` | `gpt-live-transcribe` | Realtime model; also supports `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and final-only `whisper-1`. |
| `grok.voiceStreaming` | `true` | Live transcription. Disable for local one-shot batch mode after Stop; OpenAI batch uses `gpt-4o-transcribe`. Browser capture always streams. On xAI, batch costs $0.10/hr against streaming's $0.20/hr. |
| `grok.voiceSendPhrase` | `grok send` | Spoken phrase that auto-submits when it ends a transcription. Empty disables hands-free sending. |
| `grok.voiceKeyterms` | `[]` | Words or phrases that help streaming recognition spell code and project vocabulary. The send phrase and `Grok` come first, up to 100 hints of 50 characters each. Each backend translates this list into its model's vocabulary format. |
| `grok.voiceLanguage` | `""` | Recognition language hint; xAI also enables written formatting for numbers, currencies and units. Empty uses the backend default. |
| `grok.voiceInputDevice` | `""` | Microphone device. Empty = system default (Windows auto-detects the first DirectShow device). Set a device name (Windows/dshow) or index (macOS/avfoundation) to override. |

## Privacy

Voice is opt-in per use. Audio, the selected backend's credential, and streaming language/vocabulary hints go to that backend. Keys stay on the host. AFK Pilot microphone audio crosses the linked relay; the host performs transcription and sample-rate conversion. Streaming audio is never persisted or content-logged. Explicit local batch mode records a temporary WAV and deletes it afterward. See [privacy](privacy.md#voice-input-speech-to-text) and [adapter evidence](../research/openai-voice.md).
