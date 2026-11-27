# Voice control — setup & advanced configuration

The microphone button dictates speech using xAI, OpenAI, or Google. Click it, wait for the listening waves, and speak. Words appear live. Say **"grok send"** to submit once the phrase is finalized and keep listening for the next message. Click the mic again to finalize the recording and keep the text.

In VS Code, you can dictate in the sidebar or a conversation tab. The chat
where you started keeps the recording and receives the text. The other local
mics show that dictation is busy until the recording and transcription finish.
Closing the recording tab stops capture and discards any pending result.
Spoken replies in VS Code play from the sidebar.

In Settings → Voice, **Transcription backend** defaults to Auto:

| Agent | Preferred backend |
|---|---|
| Codex | OpenAI |
| Antigravity | Google |
| Other agents | xAI |

If the preferred credential is unavailable, Auto checks xAI, OpenAI, then Google and uses the first available credential. An explicit backend choice requires that backend's credential. The recording keeps its backend through hands-free restarts and service errors.

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

### Google — Gemini API key

Use **Set API key** next to **Google voice API key** in Settings → Voice to set
`grok.voiceGoogleApiKey` on the host. If empty, the host reuses the Gemini API
key already saved for Antigravity, then checks `GEMINI_API_KEY` and
`GOOGLE_API_KEY` in that order. A project's `.env` overrides the host environment
for each variable. Create a key in [Google AI Studio](https://aistudio.google.com/api-keys).

**Which key?**

- **A Google sign-in or a Google AI subscription is not a key.** Signing in to
  Antigravity with Google, or a Google AI Pro or Ultra plan, gives voice
  nothing on its own. Voice needs a Gemini API key from AI Studio.
- **A free key works.** A key from a project without billing uses Google's free
  tier, which costs nothing, but there Google may use your audio to improve its
  products, and its limits are lower.
- **A paid key keeps your audio out of that.** Link a billing account to the
  key's project in AI Studio. Google may ask for a prepayment first. Live
  transcription is billed per minute; see Cost below.
- **Subscription credits can pay for it.** Google AI Pro and Ultra may include
  monthly Google Cloud credits through the Google Developer Program. Once you
  claim them in your Developer Program profile, they can pay for a paid key's
  usage. Check your plan's benefits for the amount.
- If Google refuses the key, the mic says why: a key Google does not accept,
  or a project that is out of credits or over its spending cap (raise it in
  AI Studio under Spend).

## 2. ffmpeg — required for the desk microphone

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

**xAI**, measured end-to-end: **$0.10/hr** batch, **$0.20/hr** streaming. In
practice ~500 words ≈ ½–1¢; a heavy 10,000-word day ≈ 10¢. Whether it draws on
your subscription or is billed pay-as-you-go depends on the credential used. How
it was measured: [research/voice-input.md](../research/voice-input.md).

**OpenAI** is billed to your API-platform account and **not** covered by a
ChatGPT subscription, whatever plan you are on. Current per-minute rates are on
the [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-live-transcribe);
they are not repeated here because they move.

**Google** offers free and paid Gemini API tiers. On the free tier, Google may
use your audio to improve its products. See [Gemini API pricing](https://aistudio.google.com/docs/pricing#gemini-3.5-transcribe).

## 4. Other settings

| Setting | Default | What it does |
|---|---|---|
| `grok.voiceBackend` | `auto` | Credential-based routing above. Choose `xai`, `openai`, or `google` to require that backend. |
| `grok.voiceOpenAiApiKey` | `""` | OpenAI API key override; empty uses `OPENAI_API_KEY`. |
| `grok.voiceOpenAiModel` | `gpt-live-transcribe` | Realtime model; also supports `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and final-only `whisper-1`. |
| `grok.voiceGoogleApiKey` | `""` | Gemini API key override. Empty uses the saved Antigravity Gemini API key, then `GEMINI_API_KEY` or `GOOGLE_API_KEY`. |
| `grok.voiceStreaming` | `true` | Live transcription. Disable for local transcription after Stop. OpenAI batch uses `gpt-4o-transcribe`. Google sends the recorded clip through its Live API. Browser capture always streams. On xAI, batch costs $0.10/hr against streaming's $0.20/hr. |
| `grok.voiceSendPhrase` | `grok send` | Spoken phrase that auto-submits when it ends a transcription. Empty disables hands-free sending. |
| `grok.voiceKeyterms` | `[]` | Words or phrases that help streaming recognition spell code and project vocabulary. The send phrase and `Grok` come first, up to 100 hints of 50 characters each. Each backend translates this list into its model's vocabulary format. |
| `grok.voiceLanguage` | `""` | Recognition language hint; xAI also enables written formatting for numbers, currencies and units. Empty uses the backend default. |
| `grok.voiceInputDevice` | `""` | Microphone device. Empty = system default (Windows auto-detects the first DirectShow device). Set a device name (Windows/dshow) or index (macOS/avfoundation) to override. |

## Privacy

Voice is opt-in per use. Audio, the selected backend's credential, and streaming language and vocabulary hints go to that backend. Keys stay on the host. AFK Pilot microphone audio crosses the linked relay. The host performs transcription and any sample-rate conversion. Streaming audio is never persisted or content-logged. Explicit local batch mode records a temporary WAV and deletes it afterward. See [privacy](privacy.md#voice-input-speech-to-text), [OpenAI adapter notes](../research/openai-voice.md), and [Google adapter notes](../research/google-voice.md).
