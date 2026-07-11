# Test Design

Three layers:

1. **Grok-free automated tests** (Vitest) — pure-logic unit tests plus happy-dom DOM tests that drive the real `media/chat.js`, plus a fast TerminalManager suite that spawns real `/bin/sh` children. **787 tests, all passing in a few seconds.** The per-file list below is **non-exhaustive** and its counts predate several feature releases (voice, ask-question, plan-mode, v1.4.0 media/subagent/logout, v1.4.19 card-collapse/background-task, the Agent Dashboard/session-pool, telemetry, vision input, and the typed host↔webview message contract) — it's indicative, not exact. `npm test` is the source of truth. **None of them spawn the `grok` binary**, so the whole suite runs in CI on a clean Ubuntu box (`.github/workflows/ci.yml`'s `test` job runs `npm ci && npm run compile && npm test && npm run package` and never installs grok). **CI's `test` job runs this exact suite — `npm test` locally ≡ that job, verbatim.**
2. **Real-grok pre-release suite** (`npm run test:live`, `scripts/live-tests.cjs`) — an **on-demand, run-on-request** gate that spawns the real `grok` binary and drives it over ACP end-to-end: handshake, a **capability-drift probe** (`capabilities` — snapshots advertised `promptCapabilities` and asserts the documented `image:false` baseline; with `vision-prompt` pinning that vision *actually* works, the pair is an advertised-vs-actual drift detector), prompt round-trip, a **mid-turn cancel** (`cancel-mid-turn` — the Stop-button contract: an id-less `session/cancel` settles the in-flight prompt with a cancelled stopReason and the session stays usable, #37), **concurrent sessions** (`parallel-sessions` — two CLI processes on one workspace answer overlapping prompts independently, no cross-talk), **two workspaces at once** (`parallel-workspaces` — the Workspaces-panel contract: two CLI processes on two cwds, each session lands in its per-cwd store (`sessionsDirFor`) and the real compiled `workspaces.js` discovery + `sessions.js` indexing see exactly what grok wrote), session restore, the **plan-mode gate modeled as the two real flows** (primer → plan → `[Plan rejected]` (gate up, 0 workspace mutations + a byte-identical-seed-file containment canary) → `[Plan approved]` (gate down, implementation can land)), image gen, video gen (subagent delegation is exercised opportunistically and **SKIP**s when grok doesn't delegate). It **reuses the real compiled modules** (`out/acp-dispatch.js`, `out/plan-gate.js`, `out/grok-primer.js`, `media/webview-helpers.js`) so it tests shipped logic, not re-implementations. Non-deterministic / entitlement-gated outcomes **SKIP** (don't fail the gate); only a real regression **FAILS**. It is **never run by `npm test` or CI** — it needs an authenticated `grok` + network + subscription. The **`release.*` scripts now run it by default** (`-SkipLive`/`--skip-live` opts out). Flags: `--smoke` (handshake + capability-drift only), `--quick` (skip slow tests incl. the 4-turn plan-mode), `--only=<name>`, `--skip=<name>`, `GROK_BIN=<path>`. See [CLAUDE.md § Test taxonomy](CLAUDE.md).
3. **VS Code integration smoke** (`npm run test:integration`, `@vscode/test-electron`) — boots a real VS Code, activates the extension, asserts the contributed commands are registered, and resolves the webview via the **missing-CLI onboarding path** (needs no grok binary), covering host glue the unit suite can't (activation, `getHtml`/CSP, `localResourceRoots`, command registration). Compiles in isolation (`integration/tsconfig.json` → `out-integration/`); `.vscode-test.mjs` drives it. Runs in CI as a **required** job under `xvfb` (validated passing against a real VS Code Extension Host). Still grok-free. Not part of `npm test` (needs a headed/`xvfb` VS Code + an Electron download).

Separately, **grok-dependent probes** live as standalone scripts under `research/*.cjs`. They exercise the real CLI's ACP behavior (e.g. confirming `exit_plan_mode` treats any client reply as approval, or capturing the native-Windows media/subagent wire shapes) and are run **manually** — Vitest's `include` glob is `test/**/*.test.ts`, so it never collects them. They're non-destructive (ACK writes without touching disk and run in a temp cwd) and require a `grok` binary on PATH; CI doesn't run them. The probes are the **discovery** tool (capture an undocumented shape once); layer 2 is the **regression** tool (re-verify the shapes still hold before each release).

The goal of layers (1)+(2) is to make the protocol surface and UI logic regression-proof. Layer 1 catches logic regressions on every commit; layer 2 catches CLI-contract drift (a new grok version changing a wire shape) before each release.

---

## What we test

### `test/acp-dispatch.test.ts` — protocol primitives (56 tests)

Includes v1.4.0 generated-media extraction: `isMediaGenToolCall` / `extractGeneratedMediaPaths` covering **both** wire forms — the Linux/macOS JSON-in-text (`image_gen`, `image_to_video`) and the **native-Windows prose-in-text** (`Image/Video generated and saved to \\?\C:\…`, tool names `image_gen` / `video_gen`, variants `ImageGen` / `VideoGen`) — with image-vs-video classification, `\\?\` extended-path stripping, the trailing-period-not-swallowed guard, and the collapsed-resume shape. Plus the ACP-standard `extractImageContent`/`collectToolImages` fallback.


The wire format is the highest-value test surface: ACP changes break everything else if we miss them.

- **`parseAcpLine`**
  - Returns `null` for empty / whitespace-only input
  - Flags non-JSON lines as `{kind:"non-json"}` so the host can log them
  - Recognizes responses by `id` + missing `method`
  - Carries `error` through on error responses
  - Recognizes `session/update` notifications by method name
  - Recognizes server→client requests with both `method` and `id`
- **`routeSessionUpdate`** — every documented update tag has an explicit route
  - `agent_message_chunk` → `{event:"messageChunk", text}`
  - `agent_thought_chunk` → `{event:"thoughtChunk", text}`
  - `tool_call` and `tool_call_update`
  - `current_mode_update` → carries `modeId` (drives the bottom-toolbar mode button)
  - `available_commands_update` → carries `commands`
  - Unknown tags fall through to `{event:"update"}` (forward-compat)
  - Missing `content.text` defaults to empty string (defensive)
- **`extractPromptMeta`** — pulls token counts out of `_meta` for the donut and handles missing `_meta` gracefully
- **Response builders** — `makePermissionResponse`, `makeExitPlanResponse`, `makeAckResponse`, `makeRequest`. These encode the exact shapes the agent expects. Bugs here are silent.

### `test/chips.test.ts` — file-chip CRUD (6 tests)

- Implicit chips have stable ids (so the active-editor watcher can replace them)
- Explicit chips have unique ids even when created in the same millisecond (regression: original `Date.now()` impl collided)
- `removeChip` / `toggleChip` are pure (don't mutate inputs)
- `clearImplicitChips` leaves explicit chips intact

### `test/prompt-builder.test.ts` — final prompt assembly (7 tests)

- Bare text passes through
- File-only chip → `@relPath` reference
- Selection chip → fenced code block with the right language tag and line range
- Hidden chips are skipped
- Falls back to `@ref` when the file can't be read
- Multiple chips concatenate cleanly
- Files without extensions get an empty fence language

### `test/slash-filter.test.ts` — slash autocomplete + dispatch gate (21 tests)

- `getSlashQuery` only activates after `/` at line-start or newline (no false positives on `path/foo/bar`)
- Empty query returns the full command list
- Prefix filter is case-insensitive
- `applySlashPick` replaces only the slash token, preserves trailing text, returns the new caret position
- `matchSlashCommand` recognizes an advertised command only at position 0 (rejects Unix paths / mid-line slashes)
- `filterAdvertisedCommands` drops the config-mutating `/always-approve` from both the autocomplete list and the dispatch gate (#31)

### `test/grok-config.test.ts` — config.toml permission-mode reader (15 tests)

- `readUiPermissionMode` reads `permission_mode` from the `[ui]` table only (ignores other tables, the `[[marketplace.sources]]` array table, comments, CRLF)
- `isAlwaysApprovePermission` matches the hyphen/underscore spellings grok writes
- `configForcesAlwaysApprove` applies project-over-global precedence (#31)

### `test/terminal-manager.test.ts` — terminal handler (16 tests)

These actually spawn real `/bin/sh` children — fast enough to keep in the unit suite.

- Captures stdout from a quick command + exit code
- Captures stderr and nonzero exit
- Honors `outputByteLimit` and sets the `truncated` flag
- Returns `exitStatus: null` while still running
- Injects env from ACP-style `[{name, value}]` pairs
- Honors `cwd`
- `waitForExit` resolves on repeated calls after exit
- Throws on unknown terminalId
- `kill` / `release` on missing id is a no-op
- `disposeAll` kills outstanding terminals

### `test/cli-locator.test.ts` — CLI discovery + upgrade detection (9 tests)

- Configured path wins if it exists
- Returns `undefined` when configured path is missing
- Falls back to PATH lookup; `~/.grok/bin/grok` is also accepted when present
- Returns `undefined` when nothing is found
- **`extensionWasUpgraded`** — true on any version change (incl. a downgrade), false on a fresh install / unchanged version / empty stored version; gates the silent `grok update` the extension runs once when its own version changes

### `test/sessions.test.ts` — session listing & naming (15 tests)

- Lists sessions from grok's on-disk layout (`~/.grok/sessions/<urlencoded-cwd>/<id>/`) for the current cwd only
- Display name falls back to the first user message, then to the id, when no customName override exists
- customName overrides (stored in VS Code `globalState`) win over the disk-derived name
- Sorts by most-recently-updated; tolerates malformed/missing session files without throwing
- Delete removes the right entry and leaves others intact
- `clearSessions` keeps several live sessions at once via `exceptIds` (merged with the legacy `exceptId`)

### `test/workspaces.test.ts` — multi-workspace data layer (22 tests)

The pure layer under the Grok Workspaces panel. In-memory `FsLike` over grok's store layout; no disk.

- **`canonicalizeWorkspacePath`** — win32 folds drive-letter case, forward slashes, and trailing separators (bare drive root stays addressable); POSIX only strips trailing slashes (case significant); empty input canonicalizes to empty (invalid)
- **`discoverWorkspaces`** — decodes store dir names into workspaces newest-first with session counts; **merges two spellings of one workspace by canonical key** (the Windows `c:\proj` vs `C:\proj` split), keeping every spelling for disk access; skips undecodable names; empty store → `[]`
- **`buildWorkspaceList`** — active folders first (multi-root: all of them) matched to on-disk spellings, added registry second, deduped by canonical key; a never-used added folder stays listable
- **`add/removeWorkspacePath`** — registry policy: dedupe by key, refuse active folders and invalid paths; remove matches by key regardless of stored spelling
- **`mergeSessionIndexes`** — newest-first merge across spellings tagged with each entry's storage cwd, **deduped by session id** (two spellings of one physical dir on a case-insensitive fs must not double-list)
- Tree presentation: `dotColorId`/`dotTooltip` match the popover palette; `formatAgo` is compact and clock-skew-safe

### `test/history-panel.dom.test.ts` — panel ↔ history button (2 tests)

Drives the real `chat.js`: `historyPanelVisible` hides the chat's history button while the Workspaces panel is visible (New stays) and restores it after; an open history popover closes when the panel appears.

### `test/plan-gate.test.ts` — plan-mode policy (38 tests)

The pure heart of client-side plan enforcement. No spawn, no fs — just the classification logic the two choke points call.

- **Workspace-write containment** — a write path that resolves *inside* the workspace cwd is blocked; grok's own `~/.grok/sessions/<…>/plan.md` (outside the workspace) is allowed; relative paths, `..` traversal, and sym_link-style escapes are normalized before the containment check
- **Read-only command allowlist** — `isReadOnlyCommand` passes only when *every* `|`-separated stage is on the read-only head list (`cat`, `ls`, `grep`, `head`, PowerShell `get-childitem`/`gci`/`get-content`/`select-object`/`test-path`/…); a single mutating stage fails the whole pipeline
- **Shell-metachar rejection** — redirection (`>`), chaining (`;`, `&&`, `||`), background (`&`), command substitution (`$(…)`, backticks), process substitution (`<(…)`), and script-block braces (`{}`) are rejected outright, so a read-only head can't smuggle a side effect
- **Permission / plan-file classification** — recognizes grok's plan-file write so it can be allowed-and-snooped rather than blocked

### `test/webview-helpers.test.ts` — pure webview helpers (49 tests)

Includes the **deferred/research-only** subagent classifier `isSubagentToolCall` / `subagentLabel` (the forward-compat `spawn_subagent` + `subagent_type` shape, name/kind/rawInput fallbacks, **and the regression guard that grok's `get_command_or_subagent_output` poller is NOT carded** — its name contains "subagent" but it's a background-task output reader, not a delegation). The classifier is kept tested as forward-compat scaffolding, but grok 0.2.x doesn't emit `spawn_subagent` over ACP so the card rarely fires; see `research/subagents.md`.


Shared between the shipped webview and the tests (`media/webview-helpers.js`).

- File-ref detection: recognizes `@path` mentions and bare path-looking tokens, ignores prose
- Relative-time formatting: "just now" / "Nm" / "Nh" / "Nd" buckets, singular/plural, far-future and far-past edges

### `test/plan-card.dom.test.ts` — plan card in a real DOM (12 tests)

happy-dom test (see [Webview DOM tests](#webview-dom-tests) below). Drives the shipped `media/chat.js`, dispatches the messages `sidebar.ts` posts, clicks the rendered buttons, asserts on the `postMessage` payload that goes back to the host.

- Renders the card with plan body, feedback textarea, and three buttons: **Approve & implement** / **Reject** / **Cancel**
- All three verdicts carry the trimmed `comment` when the textarea has text, and **omit** the `comment` key when it's empty: "Reject" → `verdict:"rejected"`, "Approve & implement" → `verdict:"approved"`, "Cancel" → `verdict:"abandoned"`
- A click resolves the card, highlights the chosen button (`.chosen`), shows the verdict label, and disables both buttons + the textarea (no double-submit)
- The plan body's plan-link opens the plan snapshot **without** resolving the approval card (live and restored-plan variants)
- `planNotice` / `planBlocked` (command + write variants) render a `.plan-notice` with the right text
- Read-only plan-history card renders with the persisted verdict label

### `test/acp.test.ts` — ACP client helpers (3 tests)

- **Request timer lifecycle** — a resolved `request()` clears its timeout (no leaked timer).
- **Spawn argv** — `buildGrokAgentArgs()` returns `["agent", "stdio"]` with no effort, and `["agent", "--reasoning-effort", <value>, "stdio"]` (flag before the subcommand) for a valid effort.

### `test/acp-integration.test.ts` — ACP wire layer + plan-mode gate (13 tests)

Spawns the fake `grok agent stdio` from `test/fixtures/fake-grok-acp.cjs` (a ~190-line ACP server encoding only what the protocol requires, not grok version quirks), and drives `src/acp.ts` AcpClient against it over real JSON-RPC stdio. Cross-platform: `.cmd` wrapper on Windows, `.sh` wrapper elsewhere; subprocess startup adds ~50–100ms per test (same order as terminal-manager).

- **Lifecycle** — spawn → initialize → session/new succeeds; a basic prompt round-trips with `_meta.totalTokens`.
- **Startup effort forwarding** — with a valid `effort` configured, the fake CLI (which exits 2 on any unexpected argv) accepts `agent --reasoning-effort <value> stdio` and the session starts, proving the forwarded arg shape.
- **Plan-snoop** — grok's plan.md write (outside the workspace) is allowed AND emits `planFileContent` with the snooped text; the host's `exitPlanRequest` event fires with that content; the file actually lands on disk.
- **Workspace-write gate** — with `planActive=true`, `fs/write_text_file` for a path inside the workspace is refused with PLAN_BLOCKED, emits `mutationBlocked`, no file lands.
- **Workspace-write gate (off)** — with `planActive=false`, the same write succeeds end-to-end.
- **Terminal-create gate (mutating)** — with `planActive=true`, `terminal/create` for `rm -rf` is refused; the host's terminal handler is never called.
- **Terminal-create gate (read-only)** — with `planActive=true`, `terminal/create` for `ls -la` is allowed and reaches the terminal handler.

### `test/plan-restore.test.ts` — plan persist + restore decision (15 tests)

Pure helpers extracted into [src/plan-restore.ts](src/plan-restore.ts) specifically for unit testing: no `vscode`, no fs, no ACP client to mock.

- **`appendPlanEntry`** — chronological append; creates a new list from `undefined`; doesn't mutate input; preserves plan text verbatim (regression: `lastPlanText` was being wiped before persist, so saved entries showed `"(empty plan)"`); tolerates legacy entries with no `afterUserMessage`
- **`decideRestoreState`** — given the saved log, returns whether to raise the gate and what mode to set on the CLI. Last verdict `rejected` → restore Plan mode; `approved`/`abandoned` → Agent mode; no log / undefined → Agent mode (legacy session, safe default)
- **End-to-end scenarios** — user rejects then closes VS Code → restore in Plan mode; rejects then approves → Agent mode; rejects then cancels → Agent mode (the regression where Cancel kept restoring into Plan mode); legacy session → Agent mode with no surprise gate

### `test/plan-history-restore.dom.test.ts` — plan-history restore rendering (19 tests)

happy-dom test driving the shipped webview through a `planHistoryQueue` + `session/load` replay sequence. This is the visual side of the state machine — what actually renders, in what order, after the host sends saved plans plus a stream of replayed messages.

- Empty queue → no plan-history cards
- Positioned plan (`afterUserMessage: N`) → interleaved at the right user-message boundary, not dumped at the bottom
- Plan positioned after the last replayed user message → flushed at end of replay
- Legacy plans without `afterUserMessage` → always flushed at end (back-compat with sessions saved before per-plan persistence)
- Multiple plans at distinct positions → each lands at its boundary
- Multiple plans at the *same* position → drain together before the next user message
- Live user message after restore → still drains queued plans inline (no replay required)
- Fresh session edge case (queue arrives without `historyReplay` toggle) → drained on the first live message
- `clearMessages` → queue + counter reset
- All three verdict buttons (Approve / Reject / Cancel) → produce matching status labels + `.chosen` highlight
- `agentReset` removes the in-flight agent bubble
- Subsequent `messageChunk` after `agentReset` creates a fresh bubble (the false-approval text doesn't leak through)

### `test/webview-ui.dom.test.ts` — webview regressions in a real DOM (28 tests)

happy-dom test locking in the native-Windows regressions this build fixed (plus later busy/version/dedup behavior), so they can't silently come back:

- **History popover** — opens on the history button (and requests the session list), toggles closed on re-click, closes on an outside click but stays open on a click inside it
- **Session rows** — whole row resumes (clicking the meta area, not just the label, posts `resumeSession`); the delete and rename action buttons `stopPropagation` so they don't *also* resume
- **Mode picker** — offers Agent / Plan / Auto accept, posts `setMode` with the chosen id, closes on select, toggles closed on re-click
- **Reasoning trace** — a thought chunk renders a collapsed thinking block whose header click toggles the body open/closed (chevron ▶/▼)
- **Gear settings lock** — the model button shows the friendly name (not the raw id); model + effort controls are disabled while busy/priming and re-enable when busy clears
- **User-message dedup** — a `user_message_chunk` echoed live (grok ≥0.2.33) never doubles the optimistic bubble; only a `session/load` replay drives user bubbles
- **Welcome version lifecycle** — flips to "Connected · v<version>" only when session start finishes, not at the bare ACP handshake; later busy toggles don't overwrite it
- **Gear menu** — the Other group's About sub-view (extension + CLI versions, update check) and Config & debug sub-view render and route correctly

### `test/file-ref.test.ts` — open-file refs + inline-read guard (8 tests)

- `parseFileRef` parses `path#L<n>` / `path#L<a>-<b>` open-file refs (single line + range), tolerating a bare path
- `shouldReadFileInline` guards against inlining a too-large file, so a huge file is referenced by `@path` instead of pasted into the prompt

### `test/voice.test.ts` — voice pure helpers (44 tests)

- STT request/response/error shaping for the batch (REST) and streaming (WebSocket) endpoints
- Per-platform `ffmpeg` arg construction (DirectShow/dshow on Windows, others elsewhere) + DirectShow device-list parsing
- API-key resolution order (`grok.voiceApiKey` → `GROK_VOICE_API_KEY` → `XAI_API_KEY`)
- `parseVoiceCommand` / trailing send-phrase detection — the two-word "grok send", tolerant of the "send"→"sent" mishearing, with trailing punctuation kept-not-doubled

### `test/voice-ui.dom.test.ts` — mic button + composer in a real DOM (28 tests)

- The mic-button state machine (idle → connecting → listening → stopped), animated waves, and the brief "connecting…" spinner
- A live partial transcript accumulates into the composer; the trailing send-phrase is highlighted via the backdrop overlay
- "grok send" submits and flushes messages dictated while Grok was responding (hands-free continuous listening)

### `test/grok-primer.test.ts` — primer replay detection (6 tests)

- `isPrimerText` matches the marker at the **start** of a message for any primer version (v1, v2, …), tolerates leading whitespace, and rejects normal text / a marker pasted mid-message — used on restore to hide the lazily-sent primer and keep it out of the plan-position count

### `test/plan-review.test.ts` — plan-snapshot filenames (5 tests)

- `planReviewFileBaseName` / `sanitizePlanReviewFilePart` generate a safe Markdown filename for the "open plan as an editor tab" action (strips path-hostile chars, bounds length)

### `test/media-subagent.dom.test.ts` — generated media + subagent card in a real DOM (10 tests)

- `addGeneratedMedia` renders an image as `<img>` and a video as `<video controls>` from the host's `media` message, wires the Copy-path / Open-in-VS-Code hover actions (pinned to the media), and falls back to an open-link button for a remote URL
- the (deferred) subagent classifier renders a *Subagent: \<type\>* card when fed a delegation shape

### `test/question-card.dom.test.ts` — `x.ai/ask_user_question` card (10 tests)

- Renders each question's options (single-question single-select resolves on one click; multi → pick-then-Submit; Skip → cancel), replies `{outcome:"accepted", answers, annotations}` (or cancelled), collapses to the question + a green `✓ <choice>`, and rebuilds a read-only "You answered" card from the resume replay

---

## Webview DOM tests

`test/plan-card.dom.test.ts` and `test/webview-ui.dom.test.ts` run the **real shipped** `media/chat.js` inside a [happy-dom](https://github.com/capricorn86/happy-dom) `Window`, via the shared `test/webview-harness.ts`. The trick: happy-dom doesn't execute inline `<script>` text synchronously, but `window.eval(src)` runs in the window's realm and shares its globals — so the harness `eval`s `webview-helpers.js` then `chat.js`, stubs `acquireVsCodeApi` to capture `postMessage` payloads, and dispatches `MessageEvent`s exactly as the extension host would. This tests the webview **logic** (event wiring, payload shapes, and show/hide state) without VS Code; it does **not** replace real GUI click-through, CSS, or the live `acquireVsCodeApi` bridge — those wait for the `@vscode/test-electron` suite (roadmap item #1).

---

## What we deliberately don't unit-test

- **`AcpClient.spawn` and child process I/O.** This is exercised by the manual probes under `research/*.cjs` (hit the real `grok` binary) and is what the v0.2 `@vscode/test-electron` integration tests will cover.
- **`sidebar.ts`** end-to-end. It's mostly glue between VS Code APIs and the modules above; the modules carry the logic. A regression-prone area here is the diff editor invocation — that's better tested with `@vscode/test-electron` than with mocks.
- **Real VS Code rendering & CSS.** The happy-dom tests cover webview logic, but pixel/layout regression on the cards is better caught by manual smoke + the future integration suite.

---

## Running

```bash
npm test            # layer 1 — grok-free, what CI runs
npm run test:watch  # TDD loop
npm run test:live   # layer 2 — real grok, on-demand pre-release gate (run on request)
```

Layer 1 runs in a few seconds with no network, no `grok` binary, and no fixtures, so it's suitable for pre-commit hooks and CI. Layer 2 needs an authenticated `grok` on PATH (or `GROK_BIN=<path>`), network, and a subscription for the media tests — it's the **pre-release** checklist, run on request, never on commit.

---

## v0.2 test plan (deferred)

1. **`@vscode/test-electron` suite** — open the test workspace, activate the extension, assert the Grok view is registered, send a fake `permissionRequest` through the webview message channel, verify a permission card renders.
2. ~~**AcpClient integration test** — fixture script pretending to be `grok agent stdio`.~~ **Done** — shipped as `test/acp-integration.test.ts` (driven by `test/fixtures/fake-grok-acp.cjs`) and now runs in layer 1; see its section above.
3. **Webview snapshot test** — Playwright loads the webview HTML in isolation, sends representative messages, snapshots the DOM. Catches CSS/layout regressions.
4. **Permission round-trip** — fake permission request from a fixture, click card button, assert correct `respondPermission` JSON written to fixture's stdin.
