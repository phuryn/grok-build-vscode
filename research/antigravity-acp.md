# Antigravity over ACP

Google's Antigravity is the fifth provider (`agy` internally; "Antigravity" on
screen). Offered on desktops and cloud machines, starting disconnected.
Every renderer surface keys off `agy` in `providerState`; `remoteSetup: true`
enables remote managed installation and API-key setup. An older host without
that capability keeps the computer-only instructions. There is no experimental
setting.

The managed pin is `agy_acp_server` **1.5.2**. The November 20, 2026 Windows
captures cover initialize, Google authentication, session setup, `/usage`, and
a concurrent prompt. The Windows bundle includes the server's Python source.
Earlier 1.4.0 observations include Windows on October 14–15 and a Linux cloud
Google sign-in on November 11. Recheck triggers are collected under
[Decisions to revisit](#decisions-to-revisit).

## What runs

`AgyBackend` spawns either `agy acp` or Google's ACP registry server
(`agy_acp_server`) directly. New Google sessions prefer the installed CLI.
The host checks the installer location and PATH using filesystem lookups,
then permits the managed fallback if the CLI fails before opening a new
conversation and the managed server has a Google sign-in. Gemini API keys
saved in AFK use the managed gateway. Reopening stays with the originating
program, recorded with the conversation in host state. A CLI conversation
requires the CLI again if the binary is removed. See [Google's CLI install
locations](https://antigravity.google/docs/getting-started?tab=cli).

- Archives: `https://dl.google.com/agy-extensions/releases/{macos|linux|windows}/agy-acp-server-1.5.2-<target>.zip`.
  The registry publishes no checksums; `agy-managed-installer.ts` pins the
  SHA-256 and size computed for each archive. Windows x64 is 105 MB and Linux
  x64 is 274 MB. Extraction streams each entry.
- Each zip holds `agy_acp_server(.exe|.par)` and `localharness_external(.exe)`,
  which the server spawns; they stay side by side. Linux takes `--uid=`. The
  zips carry no Unix modes, so the installer sets 0755 off Windows.
- Install path: `<global storage>/agy-managed/1.5.2/`. The first use of a
  superseded managed install attempts the pinned download once per host process.
  The old installation stays available if the download or verification fails.
  Successful installation prunes superseded versions best-effort.
  `grok.agyServerPath` overrides the managed server path.
- Cold start: 13-25 s on Windows before `initialize` answers (PyInstaller
  unpacks itself every start), about 50 s with three starting at once; 2.8 s on
  Linux. The startup strip waits 60 s before calling an Antigravity start slow.
  The 1.5.2 concurrent-prompt capture took about 14.7 s to initialize on Windows.

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
  "http://127.0.0.1:<port>/<prefix>/<lease>"}}}`; no key reaches it. Why gateway mode
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
- A remote desk may paste a key or adopt an existing Google sign-in
  (`agyGoogleSignInPresent`), without starting `authenticate`. A local desk
  still offers browser sign-in (`googleSignIn`). Cloud hosts additionally
  advertise `googleSignInPaste`: `authenticate` prints the Google OAuth URL
  with a random loopback redirect port, state and PKCE challenge, then waits
  300 seconds. After signing in on the phone, its loopback page cannot load;
  the person copies the whole address into the existing paste-code card.
  `agySignInCallback` validates HTTP loopback, the printed port, code and state
  before requesting the path/query at fixed 127.0.0.1. The server retains its
  PKCE verifier and exchanges the code; Linux stores `acp_token.json`. Invalid
  addresses keep waiting with a static message, expiry offers a fresh run.
  Pasted addresses are never echoed or persisted; cloud sign-in ACP logs and
  error output are suppressed because the server can print callback codes.
  Absent `googleSignInPaste`, older cloud hosts keep their existing routes.
- Installation and cancellation are `full` remote actions. Setup replies and
  `agyInstallProgress` go to the requesting tab, including after reconnect.
  Desk Disconnect preserves both credentials. Cloud Sign out removes the
  saved API key and any stored Google sign-in through ACP `logout`, regardless
  of the method last used. It never starts a browser or asks a host modal.
- Key fields clear on submission and have no draft or retry storage. Known
  offline submissions are refused before reaching the transport. The relay
  client's outbox is outside this checkout: its exclusion of key messages,
  including a socket-drop race, still requires verification.

## Managed server sessions

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
  thinking config. `AgyBackend` therefore offers Low / Medium / High only for
  models whose API listing carries `thinking: true`; `agyThinkingLevel` maps
  the person's default or live choice onto those three levels. Each server's
  relay lease holds its own level, and the relay pins
  `generationConfig.thinkingConfig.thinkingLevel` on generate calls without
  an ACP `thinking_level` RPC or a restart. The picker keeps the Gemini chat models (see the
  model filter below), newest first, and a conversation with no remembered
  model starts on `gemini-4-argon`, else on the newest model offered
  (`AgyBackend.defaultModelId`).
- The `mode` option advertises `default`, `auto_edit`, and `yolo`. The existing
  picker shows Agent mode, Accept edits, and Auto accept and sends
  `session/set_config_option`. The server persists the selected mode with the
  conversation and enforces approvals. Agent mode and Auto accept fall back to
  the host's previous approval handling when the selector is missing.
- AFK omits `clientInfo`. The server's `model_selection.py` allows non-Gemini
  models only for specific recognized clients. The Google capture listed
  Gemini 4 Neon, Carbon, Argon, Hydrogen, and Gemini 3.8 Flash. Neon and Hydrogen
  also listed an `xhigh` variant. The quota groups describe the account's
  entitlement and are independent of the model picker.
- `/plan` is the SDK's built-in planning command. The bundled server describes
  an implementation-plan artifact awaiting approval, and the earlier capture
  showed a Proceed action AFK cannot send. `/plan` and `/logout` stay out of the
  menu. `/usage` stays available as an explicit chat command. The capture
  returned quota Markdown in about 0.3 s and ended the turn. There is no
  steering, compaction or client MCP setup on this route (`mcpServers: []`).
- A concurrent `session/prompt` reported a `Concurrent receive_steps()` error
  on 1.5.2 even though the second prompt answered `end_turn`. The host queues
  sends for this server until the existing turn settles.
- `usage_update {used, size: 1048576}` after every step feeds the context meter.
  The catalog names no window, so until the first one the meter shows that
  same 1,048,576 (`AGY_DEFAULT_CONTEXT_WINDOW`, read "1.05M").
- `session/cancel` resolves the prompt `cancelled` within about 10 ms; the next
  prompt works. `session/load` replays user and agent text; context survives.

### Subscription usage

`AgyUsageMeter` runs `/usage` in a dedicated managed-server process, with its
own conversation under `antigravity-acp/afk-pilot-meter`. The same process is
reused while active and expires after five minutes without a read. The meter
checks for a saved managed Google file credential, uses its fingerprint as
the existing one-minute cache key, and authenticates the auxiliary server
as `oauth-personal`. All server requests on this connection are refused.
CLI chats use that managed Google sign-in for quota when available. Key and
keychain-only sessions and hosts without the managed sign-in keep the meter
hidden, as do replies with no recognized quota windows.

The November 20 Windows capture opened one meter conversation, then resumed
it three times, including after a server restart. The store stayed at 50
databases after its initial increase from 49. The meter database stayed at
393,216 bytes. `/usage` returned in 456–570 ms, with output collected for
another 1.5 seconds. Cold initialization took 16–20 seconds. AFK keeps the
same collection interval and runs the refresh in the background. The
parser shows Gemini and Claude & GPT, each with Weekly and 5-hour windows,
when their remaining percentages and UTC resets can be read. Only the parsed
windows go to the account meter.

`session.json` remembers the meter ID. `listAgyCatalog` excludes that ID and
the dedicated folder, including before the ID is saved. A create claim is
written before `session/new`, once for the initial meter and once per
confirmed deletion. If the response is lost, AFK finds the conversation by
its folder in the store. If the outcome is still unknown and there is no
identifiable disk row, the meter stays hidden. A resume error alone leaves
the original ID in place. `/usage` remains available for a manual check in a
managed conversation.

## CLI sessions

The November 20 Windows 1.5.8 capture used the CLI's existing sign-in with
`initialize` and `session/new`. Its model list included Gemini 4, Gemini 3.8
Flash, three Orchestrators, Claude Opus 5.5, Claude Sonnet 5.5, and GPT-OSS
120B. Effort uses `thought_level`. The CLI's `default`, `accept-edits`,
`auto`, and `plan` map to the shared mode picker. The CLI enforces its own
permissions. The host follows native mode updates as they arrive.

A Plan turn on 1.5.8 (Windows, November 20) sent no permission request and
no plan update. The model wrote the plan into the CLI's own
`brain/<conversation>/` folder with a `write_file` call: Gemini 4 Neon named it
`implementation_plan.md` and Gemini 3.8 Flash `plan.md`. The completed update
carries the plan as a diff, so it renders as an ordinary edit card. The reply
then asked for review in text; Flash's reply mentions a **Proceed** button,
which belongs to Google's own client, and also accepts a reply. A "proceed" reply while
still in Plan implemented through the ordinary edit approval, and the CLI
stayed in Plan. There is no native review request, so AFK adds no approval
step of its own. A refused shell permission during Plan research ends the
turn, as it does in other modes.

The slash menu follows the advertised CLI commands, including `/goal`,
`/plan`, and `/compact`. The native `/compact` reply goes through chat.
The CLI has no advertised `/usage` or fork. The CLI's installed sign-in
remains independent of the managed server's Google and key setup.

The CLI accepts a second `session/prompt` to steer the running turn. The
earlier request returns `end_turn` while work continues. `AcpClient` waits
for the final steering response before ending the turn. The live
`user_message_chunk` echo is suppressed, and ordinary held sends still wait
for turn settlement. Attachments use the regular send queue.

### Skills in the slash menu

The 1.5.2 server resolves `GEMINI_HOME/config/skills`, the project's
`.gemini/skills`, `GEMINI_HOME/antigravity-cli/skills`, and the project's
`.agents/skills`, in that order. It passes them as harness skill paths. The
host scans those same folders once in the background on open or reopen. The
scan reads at most 128 entries per root and 16 KiB of each frontmatter, and lists
at most 100 skills. Malformed entries are skipped and native commands own their
names. The server's ACP prompt parser only tokenizes SDK built-ins. The picker
uses the same slash syntax as other agents, and AFK expands selected names in
the outbound text into a request to load the skill via `lookup_skill`. The
smoke checks a unique reply marker stored only in the scratch skill body.

### The working folder

In the 1.4.0 capture the harness sorted the project and skill roots together
and used the first as its command directory. The 1.5.2 server puts the project
in `workspaces` and supplies skills separately through `skills_paths`. AFK
still sets the server's system-prompt append on
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

The managed server's `session/list` is a directory listing with placeholder titles
("Session 453a5a5a"), no recency, and an exact-string `cwd` filter.
`listAgySessions` reads the same store directly -- `<id>.db` transcripts with
`<id>.meta` sidecars naming the folder -- so listing starts no server, recency
is the transcript's mtime, and Windows case does not split a project. Titles
come from the host's first-prompt name. The store is read once for every
project (`listAgyCatalog`, split by folder with `agySessionsFor`), and a transcript older than the
30-day history horizon is skipped before its `.meta` is read, pinned ids
excepted.

CLI 1.5.8 stores databases in `antigravity-cli/conversations` without the
managed server's `.meta` sidecars. AFK pages the advertised ACP `session/list`
and matches returned working directories to authorized projects. CLI history
reopens through `session/load`. The owner smoke checks the actual listing and
replay returned by the CLI. AFK can identify its previously seen CLI sessions
from host metadata and the remaining databases if the CLI is uninstalled.

## Other surfaces

AFK's own setup excludes client MCP connectors, Vertex AI and Enterprise
sign-in. Subagent cards show their child's tool calls
as described in [Subagents](#subagents).

## Decisions to revisit

These choices have explicit recheck triggers.

### The pinned server version

- **Decision:** a pinned `agy_acp_server` 1.5.2, downloaded into extension
  storage (`agy-managed-installer.ts`, `AGY_MANAGED_VERSION`), never the latest.
- **Why:** the working-folder append, tool mapping, gateway flag and approval
  handling depend on the shipped server's behavior.
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
- **Revisit when:** Google publishes a newer ACP server archive.

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
  plus the applied thinking level on generate calls, never the key, the prefix,
  a query or a body, and the server's own output is
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
- **Key effort:** each lease adds its own path segment beneath the prefix;
  its mutable level isolates concurrent conversations. Only generate bodies
  with an explicit choice for a thinking model are buffered and rewritten;
  other requests and generate responses stream. An existing thinking config
  is replaced only by an explicit choice. A 400 whose JSON error message says
  the thinking level is not supported retries once without `thinkingConfig`;
  that model/level is skipped for later requests during this relay's life.
  Other errors pass through. The owner's Gemini API benchmark accepted
  low/medium/high for Carbon (2026-11-10) and Argon (2026-10-13), omitted ==
  medium; Carbon refused minimal and silently mapped xhigh/max to its default.
  The relay therefore never invents those extra tiers. Malformed JSON passes
  through unchanged so the relay cannot discard a conversation's contents.
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

### Desktop and cloud setup

- **Decision:** offer Antigravity to everyone. Install and key entry work
  locally or remotely. Cloud Google sign-in uses a pasted loopback address
  (`googleSignInPaste`); remote desks may adopt only an existing sign-in.
  `remoteSetup` gates install/key controls; each capability is additive so
  older hosts keep their existing routes.
- **Why:** a phone can supply a key or return Google's callback to the host,
  removing the need for a person at its screen. The measured Linux OAuth flow
  retains its PKCE verifier in the ACP process, so forwarding the validated
  callback completes that same sign-in. Every remote already has full host
  access; no key or callback is read back to any client.
- **Verification limit:** the Linux server's Google OAuth URL, five-minute wait
  and token path were measured on a cloud host. The complete phone paste flow
  still needs a live run; unit tests cover validation, local HTTP, adoption,
  routing, expiry and client persistence.
- **Managed server:** `mcpServers: []`. Advertising client fs swaps
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
  `-latest` alias; newest first; keep the model in use. In key mode, exclude
  Gemini 2 (`gemini-2.0-*`, `gemini-2.5-*` and their variants,
  `isAgyGemini2`), not even as the model in use; a key with no remembered
  model and no Argon starts on the newest model offered instead. Otherwise a
  Google sign-in's catalog is shown as the server sends it.
- **Why:** the 40 models measured for one key include speech, image, music
  (Lyria), robotics, computer-use and deep-research models, Gemma, and aliases
  of models already listed; none of those is a chat model this agent can work
  with, and a picker of 40 hides the 14 that are. The gateway can start a session on the first
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
