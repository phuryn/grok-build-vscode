# Antigravity over ACP

Google's Antigravity is the fifth provider (`agy` internally; "Antigravity" on
screen). Offered on desktops and cloud machines, starting disconnected.
Every renderer surface keys off `agy` in `providerState`; `remoteSetup: true`
enables remote managed installation and API-key setup. An older host without
that capability keeps the computer-only instructions. There is no experimental
setting.

Measured against `agy_acp_server` **1.4.0** on Windows 11, 2026-10-14 and -15.
The server's Python source (unpacked from the Linux bundle) was read rather than
guessed at; handler names below are its own. The choices that rest on 1.4.0's
behaviour, and what should make us look again, are collected at the end under
[Decisions to revisit](#decisions-to-revisit).

## What runs

Google's official ACP server from the ACP registry entry `antigravity-acp`
(publisher Google LLC), spawned directly by `AgyBackend` -- it speaks ACP
itself, so there is no adapter. Not the `agy` CLI: headless `agy -p` cannot ask
permission (commands are auto-denied) and cannot be interrupted.

- Archives: `https://dl.google.com/agy-extensions/releases/{macos|linux|windows}/agy-acp-server-1.4.0-<target>.zip`.
  The registry publishes no checksums; `agy-managed-installer.ts` pins the
  SHA-256 and size we computed. Windows x64 is 125 MB (228 MB unpacked); Linux
  x64 is 336 MB (about 1 GB unpacked), so extraction streams each entry.
- Each zip holds `agy_acp_server(.exe|.par)` and `localharness_external(.exe)`,
  which the server spawns; they stay side by side. Linux takes `--uid=`. The
  zips carry no Unix modes, so the installer sets 0755 off Windows.
- Install path: `<global storage>/agy-managed/1.4.0/`. `grok.agyServerPath`
  overrides it. No PATH lookup.
- Cold start: 13-25 s on Windows before `initialize` answers (PyInstaller
  unpacks itself every start), about 50 s with three starting at once; 2.8 s on
  Linux. The startup strip waits 60 s before calling an Antigravity start slow.

### Windows: stop the server so it cleans up

The Windows build is a PyInstaller one-file program: a bootloader unpacks
**about 314 MB into `%TEMP%\_MEI*`** on every start and deletes it when its
Python child exits. Measured:

- Closing stdin does not stop the server (still alive 95 s later).
- Killing the bootloader, or its whole tree, skips the delete -- every start
  leaked 314 MB, and killing only the bootloader also orphaned the Python
  child and its harness, still running hours later.
- Killing the bootloader's **child** tree (`taskkill /PID <python> /T /F`)
  takes the harness with it, and the bootloader then deletes `_MEI*` and exits
  (code 1) by itself.

`AgyBackend.stopProcess` does the third, and `AcpClient.dispose` gives a
backend with `stopProcess` a 10 s budget before its usual tree kill. A crash of
the extension host itself can still leave a directory behind.

## Sign-in

Connect offers a choice, in one card in the connect dialog: **Sign in with
Google**, or **Use a Gemini API key** (a password field, with a link to
aistudio.google.com/apikey). Vertex AI and Enterprise sign-in are not offered.

- `session/new` on a server with no usable credential fails with JSON-RPC
  **`-32000` "Authentication required"** and no side effects
  (`isAgyCredentialError`; the server uses -32000 for nothing else).
- **The method is stated on every start.** The server persists the chosen
  method as `auth.type` in `<GEMINI_HOME or ~/.gemini>/antigravity-acp/settings.json`,
  which every ACP client on the machine shares, so that file says nothing about
  what *this* app chose. The choice is a non-secret preference
  (`grok.agySignInMethod`), and `AcpClient` sends
  `authenticate {methodId}` right after `initialize` (`startupAuth`). A start
  for which the chosen method holds nothing is not made at all: the card comes
  back instead.
- **Google** (`oauth-personal`): with a stored token, `authenticate` refreshes
  silently (`_ensure_oauth_logged_in` -> `get_access_token`; measured on every
  live smoke). With none it opens the person's browser (Python `webbrowser`),
  prints `Open the following link to authenticate the ACP server: <url>` to
  stderr and waits up to 300 s on a 127.0.0.1 redirect. So **never
  `authenticate` as a probe**: "signed in with Google?" is answered without a
  process (`agyGoogleSignInPresent`: `acp_token.json`, or on macOS -- where the
  token is in the keychain unless `AGY_ACP_FORCE_FILE_STORAGE` -- a
  `security find-generic-password -s gemini -a antigravity-acp` attribute read).
  Choosing Google with a token adopts the account with nothing started; without
  one, `runAgySignIn` runs `authenticate` in a short-lived server shaped as a
  device login: the dialog shows the stderr link, Cancel stops the server.
- **Gemini API key**: the server runs in its **custom-gateway mode**, pointed at
  a relay the host runs on 127.0.0.1 (`agy-key-relay.ts`), and the relay alone
  holds the key. The server is spawned with `AGY_ACP_ENABLE_GATEWAY_AUTH=1` and
  authenticates `{methodId: "gateway", _meta: {gateway: {baseUrl:
  "http://127.0.0.1:<port>/<prefix>"}}}`; no key reaches it. Why gateway mode
  and why a relay are under [Decisions to revisit](#decisions-to-revisit).
  The host keeps the key in HostSecrets (`grok.agy.geminiApiKey`: VS Code
  SecretStorage, or the desktop's safe storage) and in the relay's memory while
  a key's server runs -- not settings, state, logs, telemetry or
  `providerState`, which carries only which ways are saved. `agySignIn` accepts
  write-only key submission from local and remote clients. Gateway auth is per connection and,
  unlike the other methods, never written to the shared `settings.json`.
- **Never put the key in the server's environment.** The server's environment
  reaches the agent's shell commands: a marker variable set on the spawn was
  echoed back by a command the agent ran (measured, 1.4.0, Windows). A key in
  `GEMINI_API_KEY` would be readable by any command in any project. With the
  relay, a command that counted environment values containing part of the key
  found none.
- **A rejected key is only visible on the first turn.** Model discovery sends
  no credential the API checks, so `authenticate` and `session/new` succeed
  with any key. Google's refusal arrives as ordinary agent text and the turn
  ends normally: a 400 API_KEY_INVALID from the API becomes exactly "API key
  not valid. Please pass a valid API key." as one chunk (measured: the real
  server in gateway mode against a local stand-in for the API). That chunk is
  the whole message (`format_execution_error`), so `isAgyRejectedCredentialText`
  matches the API's refusals only at the start of a chunk -- an agent quoting
  the same error from someone's code mid-reply is not a refusal of ours -- and
  the client emits `credentialRejected`; the host marks the account as needing
  sign-in and opens the choice again with "Google rejected this API key."
- **Disconnect at a desk** keeps both the Google sign-in and the saved key; Connect then
  offers the choice again, marking which way was last used and which are
  saved. **Sign out** (`AFK Pilot: Log Out`) clears only the current method's
  credential: for Google, ACP **`logout`** (the method name, measured against a
  server with an empty `GEMINI_HOME`; `auth/logout` and `session/logout` are
  -32601), which clears the token and the saved method; for a key, the saved
  key is deleted. Settings' button only disconnects, as for every desk provider
  (#203).
- Remotes and cloud hosts may paste a key or adopt an existing Google sign-in
  (`agyGoogleSignInPresent`), without starting `authenticate`. They never start
  Google's browser/loopback flow. A local desktop still offers that flow;
  `googleSignIn` in the provider row tells the client whether it may offer it.
- Installation and cancellation are `full` remote actions. Setup replies and
  `agyInstallProgress` go to the requesting tab, including after reconnect.
  Desk Disconnect preserves both credentials. Cloud Sign out removes the
  saved API key and any stored Google sign-in through ACP `logout`, regardless
  of the method last used. It never starts a browser or asks a host modal.
- Key fields clear on submission and have no draft or retry storage. Known
  offline submissions are refused before reaching the transport. The relay
  client's outbox is outside this checkout: its exclusion of key messages,
  including a socket-drop race, still requires verification.

## Sessions

- `initialize`: `loadSession`, `sessionCapabilities {list, resume}`,
  `auth {logout}`, `_meta.antigravity.systemPrompt.append`. The host advertises
  **no client fs or terminal**: with fs the server swaps its own file tools for
  callbacks into ours, which is not the server measured here.
- Google sign-in: `configOptions` carry the model families and
  `thinking_level` -- but only the *current* family's levels -- while
  `models.availableModels` lists every family-level pair as its own model.
  `normalizeAgySessionResponse` shows one row per family, each with its own
  levels (from the listed `<family>-<level>` ids) as its effort ladder, and
  effort is `set_config_option thinking_level` (none/minimal -> low, xhigh ->
  high). On this account: one family, Gemini 3.8 Flash (low/medium/high).
- Key (gateway mode): the server lists what `<baseUrl>/v1beta/models` offers
  the key -- 40 models for the key measured, Gemini 4 Argon among them -- with
  **no `thinking_level`** (a gateway's models are listed exactly as declared,
  `server.py` `_thinking_variants`), and a turn's generate call carries no
  thinking config. So key mode has no effort control: `AgyBackend` sends none
  and the picker shows none. The picker keeps the Gemini chat models (see the
  model filter below), newest first, and a conversation with no remembered
  model starts on `gemini-4-argon`, else on the newest model offered
  (`AgyBackend.defaultModelId`).
- Modes: Agent and Auto accept (client-side, always `allow_once` --
  `allow_always` is saved with the conversation). No Plan: `/plan` waits for a
  "Proceed" click ACP cannot deliver. `/plan` and `/logout` are hidden from the
  command list. No `/compact`, no MCP connectors (`mcpServers: []`), no
  subscription meter (`/usage` is markdown only).
- `usage_update {used, size: 1048576}` after every step feeds the context meter.
  The catalog names no window, so until the first one the meter shows that
  same 1,048,576 (`AGY_DEFAULT_CONTEXT_WINDOW`, read "1.05M").
- `session/cancel` resolves the prompt `cancelled` within about 10 ms; the next
  prompt works. `session/load` replays user and agent text; context survives.

### The working folder

The harness sorts its workspace roots alphabetically and runs commands in the
first. It is handed the project plus skill folders under `~/.gemini`, so for any
project under the home folder `~/.gemini/...` sorted first and commands ran and
files landed there. The server's own system-prompt append fixes it, on
`session/new` and `session/load` (`agySessionParams`):

> The project folder for this session is `<cwd>`. It is your working directory:
> run every command with its working directory set to this folder, and create
> or edit files inside it unless the user names another location. The other
> workspace folders listed in your context hold skills only.

It is prompt-level, so `npm run smoke:acp -- --provider=agy` asserts a
command's `Cwd` and an edit's file live, in a scratch folder under the home
folder where the bug reproduces.

### An approved edit is reported twice

The approved call (`Run create_file?`, with the diff) is followed by a second
call under a new id (`<sessionId>:N`, `Running edit_file`) that actually runs.
At the end of the turn the server sweeps the first as `failed`, "Tool call was
approved but never executed." `AgyToolCallMerger` folds the executing call into
the approved card (matched by file, else the only waiting edit) and drops that
sweep for a card whose execution it saw. Commands update in place and need
nothing.

### Tool calls: the server's field names, the renderer's

The server names a tool only in a call's title -- `Run edit_file?` awaiting
approval, `Running edit_file` as it runs and in replayed history -- and titles a
command with its command line. Its arguments use the harness's own names, which
the renderer (shared with the phone) does not read: a command row showed "Run"
with no command and no output, and a PowerShell line containing backticks and
quotes turned into a row like `Run ''"]([^`, because the renderer reads a path
out of a title. `AgyToolCallShapes` maps each call onto the fields every other
provider already sends, keeping the server's own beside them:

| Tool (live shape) | Added |
|---|---|
| `run_command`: `CommandLine`/`Cwd` pending, `command_line`/`working_dir` running; output in `rawOutput.combinedOutput`/`formatted_output`, `exitCode`/`exit_code` | `command`, `cwd`, `rawOutput.output`, `exit_code`; title "Run command" |
| `view_file`: `absolute_path`, or `AbsolutePath` with `StartLine`/`EndLine` | `file_path`, `start_line`, `end_line` |
| `edit_file`/`replace_file_content`/`multi_replace_file_content`, `create_file`/`write_to_file`: `TargetFile` (pending), `file_path` (running) | `file_path` |
| `read_url_content`: `Url`, then `url` | `url` (renders as "Fetch", not the renderer's "Generate" for kind `fetch`) |
| `search_web`: `query` | `query` |
| `list_dir`/`grep_search`/`find_by_name`: `DirectoryPath`, `Query`+`SearchPath`, `Pattern`+`SearchDirectory` | `target_directory`, `pattern`, `path` |

Each call also gets the renderer's tool name (`tool`). Replayed history sends
`rawInput` as the JSON text the model wrote, which is parsed first. An approval
card keeps the server's title (the command line is the useful thing there) and
gains the same fields. `list_dir`, `grep_search` and `find_by_name` are not
registered for a Google sign-in on 1.4.0 -- asked to call them, the model said
so and used the shell -- so their row is built from the field names the
server's own location helper reads (`tools.py`) and is not observed live.

### Subagents

`invoke_subagent` arrives as `Run invoke_subagent?` with `rawInput.Subagents:
[{Role, Prompt, TypeName, Model, Workspace}]`, needs approval, then completes at
once -- its `rawOutput` ("Invoke subagent", "Start subagent") is the model's own
summary of the call, like an edit's ("Update const a in app.js"), not a
result. After that the server reports nothing about the child: no child session
id, no `_meta`, no progress, no completion. It suppresses the child's text
(only the root trajectory streams), and the child's tool calls arrive on the
parent session looking exactly like the parent's -- the same session id, the
same id formats (hex for commands, `call_N` for reads), the same kinds, the same
permission requests, no `_meta` (measured, waited and "background" launches
alike). Left as ordinary rows they landed between the parent's text chunks,
once splitting a markdown link in two.

So the child's work goes where every other provider's does: inside its card.
The launch carries `child_session_id: agy-subagent:<launch id>`, and every
call first seen after a launch, until the turn ends, is routed as that
child's stream (`BackendUpdate.childSessionId` -> `AcpClient` `childStream`,
the path Codex's child sessions take), to the newest card still open; its
later updates follow it. The parent's text stays whole. When the turn ends
(`AcpBackend.turnEnded`), every card it opened settles: done, or stopped for
a cancelled turn, with no result text -- the server suppresses the child's
words and the parent's reply carries what it found. A replay settles a card
at the next user message and at the end of the load, so history renders the
same grouping. The server streams calls only inside a turn
(`receive_steps()` in `session/prompt`), so nothing can arrive for a card
between turns; a child still busy when its parent's turn ended would surface
in the next turn, indistinguishable from the parent's own calls. Measured
live: one launch, nine child calls (five commands, four reads) in its card,
the parent's text unbroken, the card done at the turn's end.

### History

`session/list` is a directory listing with placeholder titles
("Session 453a5a5a"), no recency, and an exact-string `cwd` filter.
`listAgySessions` reads the same store directly -- `<id>.db` transcripts with
`<id>.meta` sidecars naming the folder -- so listing starts no server, recency
is the transcript's mtime, and Windows case does not split a project. Titles
come from the host's first-prompt name. The store is read once for every
project (`listAgyCatalog`, split by folder with `agySessionsFor`), and a transcript older than the
30-day history horizon is skipped before its `.meta` is read, pinned ids
excepted.

## Not in v1

MCP connectors, Plan mode, Vertex AI and Enterprise sign-in,
a usage meter, effort control on a key, and a
subagent card that shows its child's own words or result (its tool calls do
show, see [Subagents](#subagents)).

## Decisions to revisit

Each choice below rests on how server 1.4.0 behaves. The trigger is the
observable change that should make us look again.

### The pinned server version

- **Decision:** a pinned `agy_acp_server` 1.4.0, downloaded into extension
  storage (`agy-managed-installer.ts`, `AGY_MANAGED_VERSION`), never the latest.
- **Why:** everything in this document -- the working-folder append, the edit
  merge, the field names, gateway mode's flag -- was measured against 1.4.0,
  and several of them are workarounds a newer server could make wrong.
- **Evidence:** the ACP registry publishes no checksums, so the SHA-256 and
  size of every target's zip are our own, computed on download; a mismatch
  refuses the install. Observed cadence: 1.2.1 on 23 Sep, 1.3.0 on 2 Oct,
  1.4.0 on 14 Oct 2026 -- roughly every 10 to 12 days.
- **Risk:** the pin falls behind fixes and models Google ships; an old pin can
  stop working if Google retires what it talks to.
- **Upgrade procedure:** download every target's zip from
  `https://dl.google.com/agy-extensions/releases/{macos|linux|windows}/agy-acp-server-<version>-<target>.zip`,
  record each SHA-256 and size into `RELEASES` and bump `AGY_MANAGED_VERSION`;
  read the new server's source for the behaviours below; run
  `npm run smoke:acp -- --provider=agy` (Google) and a key session by hand.
- **Revisit when:** the registry lists a version above 1.4.0.

### Key sign-in through gateway mode, behind its rollout flag

- **Decision:** a key's server runs in custom-gateway mode with
  `AGY_ACP_ENABLE_GATEWAY_AUTH=1`, instead of the server's own
  `gemini-api-key` method.
- **Why:** `gemini-api-key` offers a hardcoded catalog without Gemini 4 Argon
  (`model_selection.py`: Argon is `agent_platform_only`). Gateway mode lists
  what the API offers the key, Argon included, and Argon answered in a live
  session with the owner's key.
- **Evidence:** `gateway/gateway.py` `auth_enabled`: "Disabled by default while
  the gateway contract is not yet ratified ... a temporary rollout gate intended
  to be removed once the contract is confirmed." Without the flag,
  `authenticate {methodId: "gateway"}` is -32602 "Unsupported auth method".
- **Risk:** an unratified contract can change shape, or the flag can be
  removed with the method still gated, in any release.
- **Revisit when:** Google ratifies gateway auth or removes the flag; or
  `gemini-api-key` mode lists Argon (then the relay can go).

### The key relay

- **Decision:** the host runs one relay per window on 127.0.0.1, on a random
  port with a random 24-byte path prefix, started when a key's server is
  spawned and closed when none remains. It replaces whatever credential arrives
  with the key and forwards only to `generativelanguage.googleapis.com`;
  anything without the prefix is 403. Its log names status, method and path,
  never the key, the prefix, a query or a body, and the server's own output is
  redacted for the prefix (it logs its gateway address).
- **Why:** gateway mode cannot carry the key itself. The harness sends its own
  `x-goog-api-key: dummy_api_key` on every generate call (`server.py`
  `_create_agent_config`, the gateway branch), so a key given as a gateway
  header is overridden and Google answers 400 API_KEY_INVALID (measured). Model
  discovery sends no credential at all. The relay also keeps the key out of
  the server, its harness and the agent's commands.
- **Evidence:** the server keeps a baseUrl's path for discovery
  (`gateway/model_discovery.py` `_discovery_endpoints`) and for generate calls
  (measured against a local stand-in, with and without a trailing slash); the
  generate call is `POST <baseUrl>/v1beta/models/<model>:streamGenerateContent?alt=sse`.
- **Risk, including quota:** any process of the same user that learns the port
  and prefix can spend the key's quota while a key's server runs; the prefix
  is never written to our logs, and the agent's commands can already spend it
  by asking the agent. Every request and its usage count against the person's
  own Gemini API quota and billing, exactly as a direct call would, and the
  relay adds no rate limiting of its own.
- **Revisit when:** the harness stops overriding `x-goog-api-key` (then the key
  could go in `_meta.gateway.headers` and the relay could go), or gateway mode
  gains a credential field of its own.

### The remembered model listing

- **Decision:** the relay keeps the last `GET /v1beta/models` listing Google
  served a key (host state `grok.agyModelListing`: model names and a one-way
  key fingerprint, never the key). Later starts get that listing at once, and
  the relay asks Google again behind it; a model Google adds appears from the
  start after. A listing still in flight when the server gives up is kept.
- **Why:** the server gives discovery 15 s in total
  (`gateway/model_discovery.py` `DISCOVERY_TIMEOUT_SECONDS`) and on a miss uses
  a built-in three-model catalog without Argon for that process, caching the
  miss for five minutes. A slow cold start hit exactly that (2026-10-16:
  "Gateway model discovery failed: timed out", then Argon refused for the
  session), and the picker then remembered the three models.
- **Revisit when:** the server's discovery budget or its fallback changes, or
  key mode starts listing Argon itself (then the relay and this go together).

### The working-folder system-prompt append

- **Decision:** every `session/new` and `session/load` carries the server's
  `systemPrompt.append` naming the project folder as the working directory.
- **Why:** the harness sorts its workspace roots alphabetically and runs
  commands in the first, so for a project under the home folder the skills
  folder under `~/.gemini` won and commands ran and files landed there.
- **Evidence:** reproduced live; the smoke asserts a command's `Cwd` and an
  edit's file in a scratch folder under the home folder.
- **Risk:** it is prompt-level, so a model can still ignore it.
- **Revisit when:** Google fixes the workspace ordering (the smoke passes
  without the append), or the server lets a client name its working root.

### Desktop and cloud setup; no MCP connectors or Plan

- **Decision:** offer Antigravity to everyone. Install and key entry work
  locally or remotely; a remote/cloud machine can also adopt an existing
  Google sign-in, but cannot start Google's browser flow. Gate new remote
  controls on the host's `remoteSetup` advertisement for older-host compatibility.
- **Why:** a phone can supply a key to host secret storage, removing the need
  for a person at the host's screen. Every remote already has full host access;
  no key is read back to any client.
- **Verification limit:** Linux's existing `--uid=` launch and the real managed
  server still need a cloud-machine run; unit tests cover routing and policy.
- **Unchanged:** `mcpServers: []`, no Plan mode. Advertising client fs swaps
  the server's file tools for ours; MCP through it is unmeasured; `/plan` waits
  for a "Proceed" click ACP cannot deliver.
- **Revisit when:** the server's MCP path is measured; ACP can deliver a plan
  approval.

### How subagents are shown

- **Decision:** a window. Every call first seen after an `invoke_subagent`
  launch, until the turn ends, is that subagent's and renders inside its card
  (the newest card still open, when there are several); every card the turn
  opened settles as done when it ends.
- **Why:** the server tells child calls apart by nothing (see Subagents
  above), and the owner prefers a call in the wrong card to a parent reply
  split by the child's rows -- "it can't work differently" from the other
  providers.
- **Known cost:** a call the parent itself makes while a child runs lands in
  the card. A child still running when its parent's turn ends cannot be
  followed: the server forwards nothing between turns, so its later calls
  would appear in the next turn as the parent's, and its card has already
  settled. Two parent replies around a child's work run together in one
  message, because the server marks no boundary between them and the same
  place can be mid-sentence.
- **Revisit when:** a child's updates carry a child session id, a parent
  trajectory id or a `_meta` naming the subagent, or `invoke_subagent`
  completes with the child's result.

### The model filter

- **Decision:** in key mode, keep ids starting `gemini-` that carry none of
  `tts`, `image`, `live`, `omni`, `embedding`, `transcribe`, `robotics`,
  `computer-use`, `audio`, `nano-banana`, `deep-research`, and are not a
  `-latest` alias; newest first; never drop the model in use. In BOTH modes,
  never show Gemini 2 (`gemini-2.0-*`, `gemini-2.5-*` and their variants,
  `isAgyGemini2`), not even as the model in use; a key with no remembered
  model and no Argon starts on the newest model offered instead. Otherwise a
  Google sign-in's catalog is shown as the server sends it.
- **Why:** the 40 models measured for one key include speech, image, music
  (Lyria), robotics, computer-use and deep-research models, Gemma, and aliases
  of models already listed; none of those is a chat model this agent can work
  with, and a picker of 40 hides the 14 that are. Gemini 2 is the owner's call
  (2026-10-15): never offer it. The gateway can start a session on the first
  model it lists (`gemini-2.5-flash` for the key measured), so keeping the
  model in use kept that row in the picker after the move to Argon.
- **Evidence:** the MODELS line of the live gateway session is a fixture in
  `test/agy-tool-shapes.test.ts`.
- **Risk:** a new chat family outside `gemini-` (the `antigravity-preview-*`
  ids are unknown) is hidden; a new non-chat marker shows up until added. A
  model remembered for a project from before this rule (a Gemini 2 pick) is
  still applied to that project's new conversations, with no row in the
  picker, until another model is picked.
- **Revisit when:** a key's catalog shows a model this filter gets wrong, or
  the server starts filtering its gateway catalog itself.
