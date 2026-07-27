# Voice control — setup & advanced configuration

The microphone button in the composer dictates speech, transcribed by [xAI's Speech-to-Text API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text). Click it, wait for the blue listening waves, and speak — words appear live as you talk. Say **"grok send"** to submit hands-free and keep listening for the next message. Click the mic again to stop and keep any in-progress text. When you restart dictation, speech is inserted at the current cursor or replaces the selected text instead of always being appended.

For most people it **just works** once you're signed in — the two things below are only if you need them.

## 1. Authentication — usually automatic

If you're signed in with **`grok login`**, the extension reuses that stored token (`~/.grok/auth.json`) for Speech-to-Text automatically. No separate key, nothing to paste.

**Optional dedicated key.** If you'd rather use a distinct [console.x.ai](https://console.x.ai) developer key — to bill it separately, keep it account-scoped, or if your login token doesn't cover STT — set any one of these (they take precedence over the login token, in this order):

| Where | Setting / var |
|---|---|
| VS Code setting | `grok.voiceApiKey` |
| Workspace `.env` | `GROK_VOICE_API_KEY` (preferred) |
| Workspace `.env` | `XAI_API_KEY` (shared with other tools) |

A known-**expired** login token is skipped (so the mic doesn't look ready and then fail mid-recording); if that happens, run `grok logout` then `grok login`, or set a dedicated key above.

## 2. ffmpeg — required to record

Recording the microphone uses [`ffmpeg`](https://ffmpeg.org). Most dev machines already have it; if voice reports it missing, install it:

- **Windows:** `winget install ffmpeg` (or `choco install ffmpeg`), or download from [ffmpeg.org](https://ffmpeg.org/download.html) and add it to `PATH`.
- **macOS:** `brew install ffmpeg`.
- **Linux:** `sudo apt install ffmpeg` (or your distro's equivalent).

If it's installed somewhere off `PATH`, point `grok.ffmpegPath` at the binary.

## 3. Cost

Speech-to-Text is a **metered** xAI service billed by audio duration — **$0.10/hr** batch, **$0.20/hr** streaming. In practice ~500 words ≈ ½–1¢; a heavy 10,000-word day ≈ 10¢. Whether it draws on your subscription or is billed pay-as-you-go depends on the credential/account used. How the cost was measured end-to-end: [research/voice-input.md](../research/voice-input.md).

## 4. Other settings

| Setting | Default | What it does |
|---|---|---|
| `grok.voiceStreaming` | `true` | Live streaming transcription (words appear as you speak). Disable for one-shot batch mode (click-start → click-stop → transcribe). Streaming costs $0.20/hr vs $0.10/hr batch. |
| `grok.voiceSendPhrase` | `grok send` | Spoken phrase that auto-submits when it ends a transcription. Empty disables hands-free sending. |
| `grok.voiceInputDevice` | `""` | Microphone device. Empty = system default (Windows auto-detects the first DirectShow device). Set a device name (Windows/dshow) or index (macOS/avfoundation) to override. |

## Privacy

Voice is opt-in per use — nothing is captured until you click the mic. While recording, your **audio** and your **STT credential** (the dedicated key you set, or your `grok login` token if you rely on the automatic fallback) are sent to xAI's Speech-to-Text endpoint (`api.x.ai/v1/stt`) to produce the transcript. That transmission is core functionality, separate from the extension's anonymous telemetry — see [docs/privacy.md](privacy.md).
