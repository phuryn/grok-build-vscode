# OpenAI dictation (#124)

The host implements `pickSttBackend` in `src/voice.ts`. Auto prefers OpenAI for
Codex, Google for Antigravity, and xAI for other agents. When the preferred
credential is absent, Auto tries xAI, OpenAI, then Google. Explicit settings
require the chosen backend's credential.
Recording contexts retain the chosen backend and model across hands-free
restarts. Key refresh reads only that backend. Speech summarization still uses
the existing xAI-only `resolveVoiceApiKey`.

`PcmSttStream` is the shared event/PCM boundary. `OpenAiPcmVoiceStreamer` sends
`session.update` to a Realtime transcription WebSocket, waits for its ack, and
uses server VAD to finalize speech while recording. Producer audio stays signed
PCM16 LE / 16 kHz / mono. A stateful 3:2 interpolator converts it to 24 kHz,
carrying split samples and fractional position across chunks. There is no new
remote audio message or ownership path.

Transcript deltas accumulate by `item_id`; completions replace that item's
text. `previous_item_id` orders committed items, with speech-start times ordering
uncommitted partials. A full-text event is final only when every known item is
finalized and its predecessor is known. A pending later item prevents a
trailing send phrase from submitting incomplete text.

Stop disables VAD, waits for `session.updated`, flushes the resampler, adds
100 ms of silence to meet the minimum commit duration even for a short tail,
then commits. It waits for commit acknowledgement and every item's final.
Missing finals time out with an error; any retained partial remains a draft.
Cancel invalidates socket callbacks and settles pending operations without a
transcript. Host generation/entry identity also suppresses late results.

`voiceConfigured.backendState` is an additive availability frame, including
the host's result for each agent. Existing clients keep reading `value` for
their session provider. New clients gate backend Settings rows on this data and
can refresh the mic immediately on a provider change. The rows are registered
by `GrokVoiceSettings.install` in `media/webview-helpers.js`, used both by chat
and the separate VS Code Settings webview. `setVoiceBackend` is a new config
message; `configureOpenAiVoice` opens a host-only password input. Neither adds
a value to the existing login enum. Credentials never appear in these frames.

## Evidence and limits (2026-09-14)

The local Codex `auth.json` was inspected for presence only: it had OAuth access
and refresh tokens, and no nonempty `OPENAI_API_KEY`. No token values were
printed, and no OAuth-to-transcription request was attempted. The implementation
does not read Codex auth and claims no transcription entitlement from sign-in.

The binary-free tests cover the full routing matrix; item ordering, cumulative
partials and final-only events; stop, cancel, connection and service faults;
PCM boundary invariance and a 1 kHz signal's duration/pitch after conversion;
host ownership, pinned restart routing, setup state per provider, and Settings
on both mounts. These tests do not measure live service acceptance, latency,
word error rate, account access or billing.

Protocol reference: [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription).
The current live model uses `keywords` and plural `languages`; the older
transcription models exposed in Settings use `prompt` and singular `language`.
Vocabulary remains a provider-neutral list in config.
