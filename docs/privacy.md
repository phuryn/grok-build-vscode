# Privacy

**Privacy by design.** The extension sends **no** background data about you or your code — the only thing it reports on its own is an anonymous usage count, with no content and no identity, and you can turn even that off. Data leaves your machine only at your request: **voice input** (you send audio to SpaceXAI to transcribe it), optional **spoken-reply summarization** (you send one reply to SpaceXAI to shorten what is spoken), optional **thumbs on a Grok turn** (you send a rating to SpaceXAI), and **Remote Control** (you link this machine to [AFK Pilot](https://afkpilot.com) so your own devices can reach it) — all disclosed in full below, separate from telemetry.

## Telemetry — what is sent

A single, anonymous **`session_start`** event ([Aptabase](https://aptabase.com)), fired on the **first real message** of a session — never for empty or abandoned sessions. Legacy primer turns replayed from sessions created by older extension builds do not count as real messages. Its only purpose is to gauge how many people use the extension, which models/modes are popular, and whether our default settings are the right ones.

The event carries:

| Field | Example | Why |
|---|---|---|
| Anonymous **install id** | a random GUID generated once on your machine | count distinct installs — **not** your account, email, or grok login |
| **mode / model / effort** | `agent` / `grok-build` / `high` | which features are used (`yolo` is Auto accept; model ids are picker tokens, never paths) |
| **Local UI preferences** | `showThinking: false`, `expandToolDetails: false`, `steerByDefault: true`, `chatFontScale: 100`, `readRepliesAloud: false`, `soundNotifications: false` | whether the webview defaults we picked are the ones people keep |
| **App purpose** | `appPurpose: knowledge` / `coding` | which surface people use |
| **Voice input available** | `voiceConfigured: false`, `voiceStreaming: true`, `voiceLanguageSet: false` | whether voice input is available and streaming; never the API key, send phrase, device name, or language code. `voiceConfigured` is true when STT would work (a dedicated key **or** a `grok login` token), not that the user set a voice-specific option |
| **Provider connections** | `grokConnected: true`, `codexConnected: false`, `claudeConnected: false`, `geminiConnected: false` | which agents are signed in on this machine. These four flags (and `voiceConfigured`) come from the last cached refresh and are **omitted entirely when no snapshot exists** — an unknown is never reported as `false` |
| **Selected CLI** | `provider: grok` / `codex` / `claude` / `gemini` | which CLI this session is running on, as of the first user message. Independent of the connection flags (those are what is *available*; this is what was *chosen*) |
| **Connector count** | `connectorCount: 0` … `10` | how many Tier-1 MCP connectors are connected on this machine (a count, never the id list) |
| **Worktree session** | `worktree: false` | whether this session was started in an isolated git worktree |
| **Returning install** | `returningInstall: true` / `false` | `true` when this machine already had its anonymous install id stored; `false` on the first `session_start` that also creates that id |
| **AFK Pilot UI preferences** (when reported by a connected browser) | `remoteFontScale: 140`, `remoteReadRepliesAloud: true` | whether remote users adjust text size or enable spoken replies; omitted when no browser reports them |
| **Session origin / client device** | `sessionOrigin: remote`, `clientDevice: mobile` | whether the first message came from the desk host or AFK Pilot, and whether that client was a desktop browser or looked touch/mobile; local desk sessions are always desktop |
| **Host kind** | `hostKind: vscode` / `desktop` | whether the session ran in a VS Code-compatible editor or the standalone desktop client |
| **Host app** | `host: Visual Studio Code`, `Cursor`, `Antigravity IDE`, `Grok Build Desktop` | `vscode.env.appName` after a length / character / path check; omitted when missing or malformed. Product names we have not seen yet are forwarded — vocabulary is not allowlisted |
| **OS name** | `Windows`, `macOS`, `Linux` | coarse platform label (`systemProps.osName`) |
| **Kernel version** | `10.0.26200`, `23.6.0` | `systemProps.osVersion` is Node's `os.release()` string — a kernel/build id, not a marketing OS version such as "Windows 11" |
| **Extension version** | `1.6.1` | `systemProps.appVersion` of this install |
| **Locale** | `en` | host UI language (`vscode.env.language` / desktop `en`); not a geographic location |
| **Debug vs Release** | `isDebug: false` | development host vs a published/installed build — this is what splits Aptabase's Debug/Release streams |
| **SDK label** | `grok-vscode-phuryn@1.6.1` | Aptabase `systemProps.sdkVersion`; names this client, not a third-party SDK |
| **Event session id** | a random UUID, new on every event | Aptabase envelope `sessionId` — not the grok conversation id and not the install id |
| **Country** | derived by Aptabase from your IP | rough geography |

Country is the only thing derived from your IP, and the **IP itself is discarded — never stored**.

## What telemetry never contains

- **No message content** — nothing you type, and nothing grok replies.
- **No code** — not a single line, ever.
- **No file names or paths**, no workspace name, no repo/branch, no CLI binary paths (`grok.cliPath`, `grok.codexCliPath`, `grok.ffmpegPath`).
- **No free-text settings** — voice send phrase, keyterms, language codes, microphone device names, and path-like or malformed host-app strings are not sent. A host product name that passes the shape check is sent as the IDE reports it. A custom path is recorded at most as a boolean, and today those path settings are not sent at all.
- **No personal identity** — no account, email, grok login, machine name, or any way to tie the install id back to you.

There is no SDK and no third-party tracker — just one small, dependency-free HTTPS POST that is fire-and-forget (it can never slow down, surface to, or break a turn).

## How telemetry is gated

Telemetry sends **only when all** of these allow it:

1. The host telemetry gate — `Host.isTelemetryEnabled`. In VS Code this is the global `telemetry.telemetryLevel` setting (anything other than `off`). In **Grok Build Desktop** there is no VS Code global setting: `isTelemetryEnabled` is mapped to the same `grok.telemetry.enabled` switch as (2).
2. The product opt-out — `grok.telemetry.enabled` (default `true`).
3. This is the official published build (`PawelHuryn.grok-vscode-phuryn` / `OFFICIAL_EXTENSION_ID`). A fork rebuilt under another publisher never reports into the official project.

Any one of these refusing stops **all** sending.

> **Note on Aptabase build modes.** Events from a published/installed build report as **Release**; events from a development host (running the extension from source) report as **Debug**. In the Aptabase dashboard these are two separate streams toggled by the Bug/Rocket icon — Release data won't appear while the dashboard is in Debug view, and vice-versa.

## How to opt out

Do **any** of the following:

- Set `grok.telemetry.enabled` to `false` in VS Code settings or the desktop config. On desktop this is the only switch — it is also the host telemetry gate.
- In VS Code, disable global telemetry: set `telemetry.telemetryLevel` to `off`.

Either change takes effect immediately — no reload needed. A non-official build never sends, regardless of these settings.

## Thumbs feedback

Separate from telemetry: when **Thumbs feedback to SpaceXAI** is on (`grok.thumbsFeedback`, default **off**) and a Grok session advertises feedback, the turn footer offers thumbs. Clicking one sends a rating (`-1` / `0` / `1`) to the Grok Build CLI over `_x.ai/feedback`. No comment, no message content, and nothing is stored or read back. Codex and Claude never show thumbs. Off, the buttons are not offered and a click is ignored.

## Voice input (Speech-to-Text)

Separate from telemetry: **voice input** sends data to SpaceXAI (formerly xAI), but only when you use it. It is **opt-in per use** — nothing is captured until you click the microphone button. In VS Code, ffmpeg captures locally in the extension host. In AFK Pilot, the browser sends ephemeral raw PCM through the linked relay connection to that same host; it is never persisted or content-logged. The host then sends the following to **SpaceXAI's Speech-to-Text endpoint** (`api.x.ai/v1/stt`) to produce the transcript:

- your **audio** (the recording, streamed live or as a clip);
- an **STT credential** — the dedicated key you configured (`grok.voiceApiKey` / `GROK_VOICE_API_KEY` / `XAI_API_KEY`) if set, otherwise the token from your `grok login` (`~/.grok/auth.json`), reused so voice works without a separate key;
- for streaming voice, the configured **language code** (`grok.voiceLanguage`), when set; and
- for streaming voice, the **recognition keyterms**: the send phrase, `Grok`, and entries from `grok.voiceKeyterms`. These can include project vocabulary, so treat the setting as data sent to SpaceXAI.

The STT credential stays in the extension host and is never sent to AFK Pilot or the browser. Remote microphone audio necessarily crosses AFK Pilot on its way back to your linked host; the host-to-SpaceXAI STT request is otherwise the same as local voice. Voice connection diagnostics log the endpoint and query-parameter names, but redact all query values. If you never use voice, none of this happens. To avoid sending your login token to SpaceXAI specifically, set a dedicated `grok.voiceApiKey`. Setup + details: [docs/voice-setup.md](voice-setup.md).

## Read simplified summaries

Separate from both telemetry and Voice input: **Read simplified summaries** is on by default. VS Code and each AFK Pilot browser keep independent preferences; AFK Pilot stores its choice in that browser's local storage. The switch is disabled and forced off whenever that device's **Read replies aloud** switch is off. When both are enabled, the extension sends only the already-cleaned spoken text (after thinking and fenced code have been removed) to SpaceXAI's Responses API. Each spoken reply costs an extra SpaceXAI call and adds network delay; SpaceXAI returns a short, speech-friendly version, and the visible chat reply is never changed.

Each spoken reply costs an extra billed SpaceXAI API call and adds network delay. The request uses `grok-4.3` with reasoning disabled and server-side response storage disabled (`store: false`). It reuses the Voice credential order (`grok.voiceApiKey` → `GROK_VOICE_API_KEY` → `XAI_API_KEY` → the token from `grok login`); the key remains in the extension host and is never sent to the webview or AFK Pilot. For AFK Pilot, the browser sends the cleaned reply through the linked relay to the host, and only the shortened text returns to that requesting browser. Its preference follows the browser tab across conversation switches. With no usable key, or on timeout, refusal, unsupported-host, network, rate-limit, or response failure, the browser speaks the retained original cleaned text instead and ignores any summary that arrives after that fallback.

## MCP connector credentials

Settings → Connectors on this computer. OAuth apps open a browser; those tokens stay in `~/.mcp-auth` (`mcp-remote`), never in this extension's store. GitHub uses a personal access token you paste here. That token is stored in the platform secret store (VS Code Secret Storage; on the desktop app, OS-encrypted `HostSecrets`) and is passed to `mcp-remote` through an environment variable, not the process command line. It is not written to `~/.grok/client-state/`, not shadowed into VS Code `globalState`, and never sent to AFK Pilot or a phone. A remote client can see that GitHub is connected and cannot set, read, or clear the token.

## Remote Control (AFK Pilot)

Also separate from telemetry, and **entirely opt-in**: nothing runs until you explicitly link this machine (gear → *Remote Control* → **Sign in**). Once linked, the extension keeps an outbound connection to the [AFK Pilot](https://afkpilot.com) service so *your own* paired devices (your phone, another browser) can see and drive this workspace's chat. Live messages, replies, tool activity, and generated images flow through the service while a device is linked; a reconnect snapshot contains only the last 10 user messages and the events within that retained window, while the desk webview keeps its full buffer. The machine introduces itself by **hostname + OS** (e.g. "Dell (Windows 11)") — your workspace path is deliberately not part of it.

**Unlink this device** (`AFK Pilot: Unlink this device` in the Command Palette) removes the device token locally and revokes it on your account — after that, nothing connects. If you never link a device, none of this exists. AFK Pilot's own data handling is covered by its policies at [afkpilot.com](https://afkpilot.com).
