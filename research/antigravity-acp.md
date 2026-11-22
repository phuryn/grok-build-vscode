# Antigravity over ACP

AFK uses Google's `agy acp` for Antigravity. `AgyBackend` uses stdio with `mcpServers: []` and advertises no host filesystem or terminal tools. The CLI owns those tools and its conversations. Version 1.5.8 still identifies itself as `Antigravity ACP Server` in `agentInfo`. Capabilities come from the protocol.

## Installation and history

`ensureAgyCli` shares a cancellable install of up to three minutes. Desktop and phone can start one explicitly. A key setup or a connected chat can also start one at first use. `locateAgyCli` searches the vendor's install location before PATH. Installation verifies `agy --version`. The existing after-upgrade check allows 20 seconds for `agy update` before the first CLI launch. `providerState.agyCli` carries version and status. `agyInstallProgress` retains its wire format, including byte-based frames that older hosts and the DeepSeek installer send.

New Google sessions use agy's default `antigravity-cli` profile. New key sessions use `agy acp --gemini-dir <agyGeminiHome(env)> --app-data-dir antigravity-acp`. Reopen uses the session's recorded profile, or looks for its database in the two folders. The legacy `agyProgram: "server"` value still selects `antigravity-acp` and `"cli"` selects the default profile. The selected sign-in method is independent of this choice.

On 2026-11-22, agy 1.5.8 listed and loaded a copy of an older conversation directly in `antigravity-acp` with both key auth and the older Google token file. Replay included the user turn, tool calls and reply. Databases, sidecars, credentials, brain files and the old meter directory stay in place. History listing merges paged ACP catalogs from both profiles with older sidecar entries and known metadata. Historical meter records stay out of AFK history. The CLI advertises load, resume, close, list and additional directories. Forking is unavailable.

At host startup, `removeRetiredAgyInstall` removes recognized version directories under AFK's `agy-managed` storage. Configured paths, symlinks and junctions, ambiguous layouts and Gemini homes are excluded. The previous managed bundles occupied 105 to 274 MB. AFK no longer contributes the binary override setting.

## Authentication

Google uses explicit `authenticate oauth-personal` in the chat's profile. If the CLI starts an OAuth redirect or refuses the stored credential, AFK starts its visible sign-in flow for that profile when the host supports it. Phones on desk hosts can adopt stored credentials and see instructions when desktop sign-in is required. The CLI keeps its Google token in the OS credential store under service `gemini`, account `antigravity` (Windows Credential Manager shows the target `gemini:antigravity`), or in the profile's `antigravity-oauth-token` file when the store is unavailable, as on a Mac signed in over SSH (both measured on 1.5.8). The older server wrote `acp_token.json`. AFK reads the files, then the store's attributes for the default profile (`cmdkey /list` on Windows, `security` on macOS), never the secret. A presence check is a hint and successful authentication is the verification.

Cloud hosts show Google's link and accept the failed loopback address, validated against the printed OAuth state and port before a fixed loopback request. Callback values have no draft or retry storage, frame echo, or ACP log. Desk Disconnect keeps sign-ins. Log Out clears the selected method through CLI `logout` or HostSecrets. Cloud Sign out clears both methods.

A Gemini API key is stored in HostSecrets and supplied to the chat's CLI as `GEMINI_API_KEY`. The ACP message names `gemini-api-key`. The measured CLI has no key flag and accepts the explicit method even when `settings.json` selects OAuth. AFK never writes either profile's settings. Key entry is write-only from the renderer. The host redacts the saved key from CLI diagnostics. **Commands agy launches inherit `GEMINI_API_KEY`.** Google dictation can also use the same HostSecrets key.

## Models, modes and commands

The picker follows the CLI's native model catalog and `thought_level` option. In the 1.5.8 key probe, agy exposed 21 variants across Gemini 4 Carbon, Hydrogen and Argon, Gemini 3.8, 3.7 and 3.6 Flash, and Gemini 3.1 Pro. Hydrogen also offered `xhigh`. The default was `gemini-3.1-pro-low`, and setting `gemini-4-argon-high` yielded a successful prompt. The key probe advertised `default`, `accept-edits` and `plan`. The picker exposes native modes by advertisement and Auto accept uses the CLI's default mode with eligible `allow_once` approvals. The CLI owns the steering queue, and AFK waits for the last steering response before releasing the next send.

The 1.5.8 command list included `goal`, `compact`, `schedule`, `browser`, `plan`, `grill-me`, `teamwork`, `learn`, `boost`, `agy-customizations`, `antigravity-guide`, `run-workflow` and `swarm`. ACP treats `/usage` as prompt text.

## Usage meter

`AgyUsageMeter` runs the default profile's `agy -p /usage` as a bounded subprocess, starting at the measured CLI version 1.5.8. The meter disables CLI self-update for this invocation. It reads the CLI's own Google sign-in and displays only for Google chats in that same profile. Key and older-profile chats omit quota windows. The measured output was four tab-separated percentage and UTC reset rows, for the Gemini and Claude/GPT weekly and five-hour windows. The CLI exited zero and created no conversation. Key usage is tracked in AI Studio and print mode exits 2 for that sign-in. Failed, empty or malformed output produces no quota windows. In-flight reads are shared and the normal usage cache is per session and memory-only. It does not read or hash credential files. AFK sign-in changes invalidate the cached readings.

## Skills in the slash menu

The 1.5.2 server resolves `GEMINI_HOME/config/skills`, the project's
`.gemini/skills`, `GEMINI_HOME/antigravity-cli/skills`, and the project's
`.agents/skills`, in that order. It passes them as harness skill paths. The
host scans those same folders once in the background on open or reopen. The
scan reads at most 128 entries per root and 16 KiB of each frontmatter, and lists
at most 100 skills. Malformed entries are skipped and native commands own their
names. The CLI's ACP prompt parser only tokenizes SDK built-ins. The picker
uses the same slash syntax as other agents, and AFK expands selected names in
the outbound text into a request to load the skill via `lookup_skill`. The subprocess fixture checks the resulting ACP prompt.

### The working folder

In the 1.4.0 capture the harness sorted the project and skill roots together
and used the first as its command directory. The 1.5.2 server puts the project
in `workspaces` and supplies skills separately through `skills_paths`. AFK
still sets the harness's system-prompt append on
`session/new` and `session/load` (`agySessionParams`):

> The project folder for this session is `<cwd>`. It is your working directory:
> run every command with its working directory set to this folder, and create
> or edit files inside it unless the user names another location. The other
> workspace folders listed in your context hold skills only.

It is a prompt-level instruction. The transport tests assert that the adapter sends it.

### An approved edit is reported twice

The approved call (`Run create_file?`, with the diff) is followed by a second
call under a new id (`<sessionId>:N`, `Running edit_file`) that actually runs.
At the end of the turn the harness sweeps the first as `failed`, "Tool call was
approved but never executed." `AgyToolCallMerger` folds the executing call into
the approved card (matched by file, else the only waiting edit) and drops that
sweep for a card whose execution it saw. Commands update in place and need
nothing.

### Tool calls: the harness's field names, the renderer's

Older transcripts can name a tool only in a call's title -- `Run edit_file?` awaiting
approval, `Running edit_file` as it runs and in replayed history -- and titles a
command with its command line. Its arguments use the harness's own names, which
the renderer (shared with the phone) does not read: a command row showed "Run"
with no command and no output, and a PowerShell line containing backticks and
quotes turned into a row like `Run ''"]([^`, because the renderer reads a path
out of a title. `AgyToolCallShapes` maps each call onto the fields every other
provider already sends, keeping the harness's own beside them:

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
card keeps the harness's title (the command line is the useful thing there) and
gains the same fields. `list_dir`, `grep_search` and `find_by_name` are not
registered for a Google sign-in on 1.4.0 -- asked to call them, the model said
so and used the shell -- so their row is built from the field names the
server's own location helper reads (`tools.py`) and is not observed live.

### Subagents

`invoke_subagent` arrives as `Run invoke_subagent?` with `rawInput.Subagents:
[{Role, Prompt, TypeName, Model, Workspace}]`, needs approval, then completes at
once -- its `rawOutput` ("Invoke subagent", "Start subagent") is the model's own
summary of the call, like an edit's ("Update const a in app.js"), not a
result. After that the harness reports nothing about the child: no child session
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
a cancelled turn, with no result text -- the harness suppresses the child's
words and the parent's reply carries what it found. A replay settles a card
at the next user message and at the end of the load, so history renders the
same grouping. The server streams calls only inside a turn
(`receive_steps()` in `session/prompt`), so nothing can arrive for a card
between turns; a child still busy when its parent's turn ended would surface
in the next turn, indistinguishable from the parent's own calls. Measured
live: one launch, nine child calls (five commands, four reads) in its card,
the parent's text unbroken, the card done at the turn's end.
